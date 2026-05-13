const prisma = require('../prisma');
const { buildBillingStatus } = require('../services/saas.service');

function startOfDay(date = new Date()) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function endOfDay(date = new Date()) {
  const result = new Date(date);
  result.setHours(23, 59, 59, 999);
  return result;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function daysUntil(date, from = new Date()) {
  if (!date) return null;
  const diff = startOfDay(date).getTime() - startOfDay(from).getTime();
  return Math.ceil(diff / 86400000);
}

function notification({ type, severity = 'INFO', title, message, count = 1, action = null }) {
  return {
    type,
    severity,
    title,
    message,
    count,
    action,
  };
}

async function getNotificationSummary(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Apenas ADMIN pode consultar notificacoes', data: {} });
    }

    const accountId = Number(req.user.accountId);
    const today = new Date();
    const todayStart = startOfDay(today);
    const todayEnd = endOfDay(today);
    const tomorrowEnd = endOfDay(addDays(today, 1));

    const [
      settings,
      supportConversations,
      creditPending,
      overdueInstallments,
      dueTodayInstallments,
      dueTomorrowInstallments,
      pixPending,
      pixApprovedToday,
      invalidWebhookLogs,
      subscription,
      saasPixPending,
      saasPixApprovedToday,
      activeClients,
    ] = await Promise.all([
      prisma.accountSettings.findUnique({
        where: { accountId },
        select: { notifications: true },
      }),
      prisma.supportConversation.findMany({
        where: {
          accountId,
          status: { in: ['OPEN', 'PENDING'] },
        },
        select: {
          id: true,
          messages: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: {
              direction: true,
              readAt: true,
            },
          },
        },
      }),
      prisma.creditRequest.count({
        where: { accountId, status: 'PENDING' },
      }),
      prisma.installment.count({
        where: { accountId, status: { not: 'PAID' }, dueDate: { lt: todayStart } },
      }),
      prisma.installment.count({
        where: { accountId, status: { not: 'PAID' }, dueDate: { gte: todayStart, lte: todayEnd } },
      }),
      prisma.installment.count({
        where: { accountId, status: { not: 'PAID' }, dueDate: { gt: todayEnd, lte: tomorrowEnd } },
      }),
      prisma.paymentIntent.count({
        where: {
          accountId,
          provider: 'MERCADO_PAGO',
          status: { in: ['CREATED', 'PENDING', 'IN_PROCESS'] },
        },
      }),
      prisma.paymentIntent.count({
        where: {
          accountId,
          provider: 'MERCADO_PAGO',
          status: 'APPROVED',
          paidAt: { gte: todayStart, lte: todayEnd },
        },
      }),
      prisma.webhookLog.count({
        where: {
          provider: 'MERCADO_PAGO',
          OR: [{ accountId }, { accountId: null }],
          signatureValid: false,
          createdAt: { gte: addDays(today, -7) },
        },
      }),
      prisma.subscription.findFirst({
        where: { accountId },
        include: { plan: true },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.saasPaymentIntent.count({
        where: {
          accountId,
          provider: 'MERCADO_PAGO',
          status: { in: ['CREATED', 'PENDING', 'IN_PROCESS'] },
        },
      }),
      prisma.saasPaymentIntent.count({
        where: {
          accountId,
          provider: 'MERCADO_PAGO',
          status: 'APPROVED',
          paidAt: { gte: todayStart, lte: todayEnd },
        },
      }),
      prisma.client.count({
        where: { accountId, status: 'ACTIVE' },
      }),
    ]);

    const supportPending = supportConversations.filter((conversation) => {
      const latest = conversation.messages?.[0];
      return latest?.direction === 'INBOUND' && !latest.readAt;
    }).length;
    const notificationSettings = settings?.notifications || {};
    const enabled = {
      billing: notificationSettings.billing !== false,
      support: notificationSettings.support !== false,
      pix: notificationSettings.pix !== false,
      credit: notificationSettings.credit !== false,
      saas: notificationSettings.saas !== false,
    };

    const items = [];
    if (enabled.saas && subscription) {
      const clientLimit = subscription.plan?.clientLimit;
      if (clientLimit && clientLimit > 0) {
        const usagePercent = activeClients / clientLimit;
        if (activeClients >= clientLimit) {
          items.push(notification({
            type: 'SAAS_CLIENT_LIMIT_REACHED',
            severity: 'ERROR',
            title: 'Limite de clientes atingido',
            message: `${activeClients}/${clientLimit} clientes ativos no plano ${subscription.plan?.name || '-'}.`,
            count: 1,
            action: 'SAAS',
          }));
        } else if (usagePercent >= 0.9) {
          items.push(notification({
            type: 'SAAS_CLIENT_LIMIT_NEAR',
            severity: 'WARNING',
            title: 'Limite de clientes quase atingido',
            message: `${activeClients}/${clientLimit} clientes ativos no plano ${subscription.plan?.name || '-'}.`,
            count: 1,
            action: 'SAAS',
          }));
        }
      }

      const billingStatus = buildBillingStatus(subscription, today);
      const status = String(subscription.status || '').toUpperCase();
      const endDate = subscription.currentPeriodEnd;
      const remainingDays = daysUntil(endDate, today);
      if (billingStatus.accessBlocked) {
        items.push(notification({
          type: 'SAAS_BLOCKED',
          severity: 'ERROR',
          title: 'Plano bloqueado',
          message: `Plano ${subscription.plan?.name || '-'} venceu ha ${billingStatus.daysPastDue} dia(s). Renove para liberar novos cadastros.`,
          count: 1,
          action: 'SAAS',
        }));
      } else if (billingStatus.isPastDue) {
        items.push(notification({
          type: 'SAAS_EXPIRED',
          severity: 'ERROR',
          title: 'Assinatura vencida',
          message: `Plano ${subscription.plan?.name || '-'} venceu ha ${billingStatus.daysPastDue} dia(s). Carencia: ${billingStatus.graceDays} dia(s).`,
          count: 1,
          action: 'SAAS',
        }));
      } else if (remainingDays !== null && remainingDays <= 7) {
        items.push(notification({
          type: 'SAAS_EXPIRING',
          severity: 'WARNING',
          title: status === 'TRIAL' ? 'Trial perto do fim' : 'Assinatura perto do fim',
          message: `Plano ${subscription.plan?.name || '-'} vence em ${remainingDays} dia(s).`,
          count: 1,
          action: 'SAAS',
        }));
      }

      if (saasPixPending > 0) {
        items.push(notification({
          type: 'SAAS_PIX_PENDING',
          severity: 'INFO',
          title: 'Pix do plano pendente',
          message: `${saasPixPending} cobranca(s) do plano ainda aguardando pagamento.`,
          count: saasPixPending,
          action: 'SAAS',
        }));
      }

      if (saasPixApprovedToday > 0) {
        items.push(notification({
          type: 'SAAS_PIX_APPROVED_TODAY',
          severity: 'SUCCESS',
          title: 'Plano pago hoje',
          message: `${saasPixApprovedToday} pagamento(s) de plano confirmado(s) hoje.`,
          count: saasPixApprovedToday,
          action: 'SAAS',
        }));
      }
    }

    if (enabled.support && supportPending > 0) {
      items.push(notification({
        type: 'SUPPORT_PENDING',
        severity: 'WARNING',
        title: 'Suporte aguardando resposta',
        message: `${supportPending} conversa(s) com mensagem de cliente pendente.`,
        count: supportPending,
        action: 'SUPPORT',
      }));
    }
    if (enabled.credit && creditPending > 0) {
      items.push(notification({
        type: 'CREDIT_PENDING',
        severity: 'WARNING',
        title: 'Solicitacoes de credito',
        message: `${creditPending} solicitacao(oes) aguardando analise.`,
        count: creditPending,
        action: 'CREDIT_REQUESTS',
      }));
    }
    if (enabled.billing && overdueInstallments > 0) {
      items.push(notification({
        type: 'INSTALLMENTS_OVERDUE',
        severity: 'ERROR',
        title: 'Parcelas atrasadas',
        message: `${overdueInstallments} parcela(s) em atraso precisam de cobranca.`,
        count: overdueInstallments,
        action: 'COLLECTIONS',
      }));
    }
    if (enabled.billing && dueTodayInstallments > 0) {
      items.push(notification({
        type: 'INSTALLMENTS_DUE_TODAY',
        severity: 'INFO',
        title: 'Vencem hoje',
        message: `${dueTodayInstallments} parcela(s) vencem hoje.`,
        count: dueTodayInstallments,
        action: 'COLLECTIONS',
      }));
    }
    if (enabled.billing && dueTomorrowInstallments > 0) {
      items.push(notification({
        type: 'INSTALLMENTS_DUE_TOMORROW',
        severity: 'INFO',
        title: 'Vencem amanha',
        message: `${dueTomorrowInstallments} parcela(s) vencem amanha.`,
        count: dueTomorrowInstallments,
        action: 'COLLECTIONS',
      }));
    }
    if (enabled.pix && pixPending > 0) {
      items.push(notification({
        type: 'PIX_PENDING',
        severity: 'INFO',
        title: 'Pix pendente',
        message: `${pixPending} cobranca(s) Pix ainda aguardando pagamento.`,
        count: pixPending,
        action: 'MERCADO_PAGO',
      }));
    }
    if (enabled.pix && pixApprovedToday > 0) {
      items.push(notification({
        type: 'PIX_APPROVED_TODAY',
        severity: 'SUCCESS',
        title: 'Pix confirmado hoje',
        message: `${pixApprovedToday} pagamento(s) Pix confirmado(s) hoje.`,
        count: pixApprovedToday,
        action: 'MERCADO_PAGO',
      }));
    }
    if (enabled.pix && invalidWebhookLogs > 0) {
      items.push(notification({
        type: 'WEBHOOK_INVALID',
        severity: 'ERROR',
        title: 'Webhook com assinatura invalida',
        message: `${invalidWebhookLogs} evento(s) Mercado Pago com assinatura invalida nos ultimos 7 dias.`,
        count: invalidWebhookLogs,
        action: 'MERCADO_PAGO',
      }));
    }

    return res.json({
      message: 'Notificacoes carregadas',
      data: {
        generatedAt: today,
        enabled,
        unreadCount: items.reduce((sum, item) => sum + Number(item.count || 0), 0),
        items,
      },
    });
  } catch (err) {
    console.error('Erro ao carregar notificacoes:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao carregar notificacoes',
      data: {},
    });
  }
}

module.exports = {
  getNotificationSummary,
};
