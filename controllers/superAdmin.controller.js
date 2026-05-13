const prisma = require('../prisma');
const {
  buildBillingStatus,
  changeAccountPlan,
  renewAccountSubscription,
  serializeSubscription,
} = require('../services/saas.service');
const { writeAuditLog } = require('../services/audit.service');
const { signAuthToken } = require('../utils/auth');

function serializeAccount(account) {
  const settings = account.settings || {};
  const saas = settings.saas || {};
  const subscription = account.subscriptions?.[0] || null;
  const admin = account.users?.[0] || null;

  return {
    id: account.id,
    name: account.name,
    inviteCode: account.inviteCode,
    status: saas.accountStatus || 'ACTIVE',
    suspensionReason: saas.suspensionReason || null,
    suspendedAt: saas.suspendedAt || null,
    admin: admin
      ? {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          phone: admin.phone,
        }
      : null,
    counts: {
      users: account._count?.users || 0,
      clients: account._count?.clients || 0,
      debts: account._count?.debts || 0,
      payments: account._count?.payments || 0,
      supportConversations: account._count?.supportConversations || 0,
    },
    subscription: serializeSubscription(subscription),
    billing: buildBillingStatus(subscription),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function centsToCurrency(value) {
  return Number(value || 0) / 100;
}

function calculateRecurringRevenue(subscriptions) {
  const monthly = subscriptions.reduce((sum, subscription) => {
    const plan = subscription.plan || {};
    const price = centsToCurrency(plan.priceCents || 0);
    const periodMonths = Number(plan.periodMonths || 1);
    const billingPeriod = String(plan.billingPeriod || '').toUpperCase();
    if (price <= 0 || billingPeriod === 'FREE' || billingPeriod === 'LIFETIME') return sum;
    return sum + (price / Math.max(periodMonths, 1));
  }, 0);
  return {
    mrr: monthly,
    arr: monthly * 12,
  };
}

function serializePayment(payment) {
  return {
    id: payment.id,
    type: payment.type,
    amount: payment.amount,
    principalAmount: payment.principalAmount,
    interestAmount: payment.interestAmount,
    dailyAmount: payment.dailyAmount,
    paidAt: payment.paidAt,
    account: payment.account
      ? { id: payment.account.id, name: payment.account.name }
      : null,
    client: payment.client
      ? { id: payment.client.id, name: payment.client.name, phone: payment.client.phone }
      : null,
    debtId: payment.debtId,
    installmentId: payment.installmentId,
  };
}

function serializeSupportConversation(conversation) {
  return {
    id: conversation.id,
    subject: conversation.subject,
    status: conversation.status,
    priority: conversation.priority,
    lastMessageAt: conversation.lastMessageAt,
    createdAt: conversation.createdAt,
    account: conversation.account
      ? { id: conversation.account.id, name: conversation.account.name }
      : null,
    client: conversation.client
      ? { id: conversation.client.id, name: conversation.client.name, phone: conversation.client.phone }
      : null,
    messagesCount: conversation._count?.messages || 0,
  };
}

function serializeAuditLog(log) {
  return {
    id: log.id,
    action: log.action,
    entity: log.entity,
    entityId: log.entityId,
    severity: log.severity,
    metadata: log.metadata,
    ip: log.ip,
    userAgent: log.userAgent,
    createdAt: log.createdAt,
    account: log.account ? { id: log.account.id, name: log.account.name } : null,
    user: log.user ? { id: log.user.id, name: log.user.name, email: log.user.email } : null,
  };
}

function serializeWebhookLog(log) {
  return {
    id: log.id,
    provider: log.provider,
    eventType: log.eventType,
    eventId: log.eventId,
    resourceId: log.resourceId,
    signatureValid: log.signatureValid,
    processed: log.processed,
    processingError: log.processingError,
    createdAt: log.createdAt,
    account: log.account ? { id: log.account.id, name: log.account.name } : null,
  };
}

function serializeSaasPaymentIntent(intent) {
  return {
    id: intent.id,
    provider: intent.provider,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    externalReference: intent.externalReference,
    mercadoPagoPaymentId: intent.mercadoPagoPaymentId,
    paidAt: intent.paidAt,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    plan: intent.plan
      ? {
          id: intent.plan.id,
          code: intent.plan.code,
          name: intent.plan.name,
          billingPeriod: intent.plan.billingPeriod,
        }
      : null,
    subscription: intent.subscription
      ? {
          id: intent.subscription.id,
          status: intent.subscription.status,
          currentPeriodEnd: intent.subscription.currentPeriodEnd,
        }
      : null,
    account: intent.account
      ? { id: intent.account.id, name: intent.account.name }
      : null,
  };
}

async function getSuperAdminOverview(req, res) {
  const today = startOfToday();
  const [
    accounts,
    users,
    clients,
    activeSubscriptions,
    activeSubscriptionRows,
    pastDueSubscriptions,
    suspendedSettings,
    paymentStats,
    paymentTodayStats,
    saasPaymentStats,
    saasPaymentTodayStats,
    saasPaymentPending,
    pixProcessed,
    activeDebts,
    overdueDebts,
    activeClientsWithDebt,
    overdueClients,
    supportOpen,
  ] = await Promise.all([
    prisma.account.count(),
    prisma.user.count(),
    prisma.client.count({ where: { status: 'ACTIVE', deletedAt: null } }),
    prisma.subscription.count({ where: { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } } }),
    prisma.subscription.findMany({
      where: { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } },
      include: { plan: true },
    }),
    prisma.subscription.count({ where: { status: 'PAST_DUE' } }),
    prisma.accountSettings.count({
      where: {
        saas: {
          path: ['accountStatus'],
          equals: 'SUSPENDED',
        },
      },
    }),
    prisma.payment.aggregate({
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.payment.aggregate({
      where: { paidAt: { gte: today } },
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.saasPaymentIntent.aggregate({
      where: { status: 'APPROVED' },
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.saasPaymentIntent.aggregate({
      where: { status: 'APPROVED', paidAt: { gte: today } },
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.saasPaymentIntent.count({
      where: { status: { in: ['CREATED', 'PENDING', 'IN_PROCESS'] } },
    }),
    prisma.paymentIntent.count({
      where: { status: { in: ['APPROVED', 'PAID', 'CONFIRMED'] } },
    }),
    prisma.debt.count({
      where: { status: 'ACTIVE', deletedAt: null, principalOutstanding: { gt: 0 } },
    }),
    prisma.debt.count({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        principalOutstanding: { gt: 0 },
        dueDate: { lt: today },
      },
    }),
    prisma.client.count({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        debts: { some: { status: 'ACTIVE', deletedAt: null, principalOutstanding: { gt: 0 } } },
      },
    }),
    prisma.client.count({
      where: {
        status: 'ACTIVE',
        deletedAt: null,
        debts: {
          some: {
            status: 'ACTIVE',
            deletedAt: null,
            principalOutstanding: { gt: 0 },
            dueDate: { lt: today },
          },
        },
      },
    }),
    prisma.supportConversation.count({ where: { status: { in: ['OPEN', 'PENDING'] } } }),
  ]);
  const recurring = calculateRecurringRevenue(activeSubscriptionRows);
  const delinquencyRate = activeDebts > 0 ? Math.round((overdueDebts / activeDebts) * 100) : 0;
  const clientDelinquencyRate =
    activeClientsWithDebt > 0 ? Math.round((overdueClients / activeClientsWithDebt) * 100) : 0;

  return res.json({
    message: 'Painel SUPER ADMIN carregado',
    data: {
      totals: {
        accounts,
        users,
        clients,
        activeSubscriptions,
        pastDueSubscriptions,
        suspendedAccounts: suspendedSettings,
        supportOpen,
        paymentsCount: paymentStats._count.id,
        paymentsAmount: paymentStats._sum.amount || 0,
        paymentsToday: paymentTodayStats._count.id,
        paymentsTodayAmount: paymentTodayStats._sum.amount || 0,
        saasPaymentsCount: saasPaymentStats._count.id,
        saasPaymentsAmount: saasPaymentStats._sum.amount || 0,
        saasPaymentsToday: saasPaymentTodayStats._count.id,
        saasPaymentsTodayAmount: saasPaymentTodayStats._sum.amount || 0,
        saasPaymentsPending,
        pixProcessed,
        activeDebts,
        overdueDebts,
        activeClientsWithDebt,
        overdueClients,
        delinquencyRate,
        clientDelinquencyRate,
        mrr: recurring.mrr,
        arr: recurring.arr,
      },
    },
  });
}

async function listSuperAdminAccounts(req, res) {
  const accounts = await prisma.account.findMany({
    include: {
      settings: true,
      users: {
        where: { role: 'ADMIN' },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
      subscriptions: {
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      _count: {
        select: {
          users: true,
          clients: true,
          debts: true,
          payments: true,
          supportConversations: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({
    message: 'Empresas carregadas',
    data: accounts.map(serializeAccount),
  });
}

async function listSuperAdminSubscriptions(req, res) {
  const subscriptions = await prisma.subscription.findMany({
    include: {
      plan: true,
      account: {
        include: {
          users: {
            where: { role: 'ADMIN' },
            orderBy: { createdAt: 'asc' },
            take: 1,
          },
          settings: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return res.json({
    message: 'Assinaturas carregadas',
    data: subscriptions.map((subscription) => ({
      ...serializeSubscription(subscription),
      billing: buildBillingStatus(subscription),
      account: subscription.account
        ? {
            id: subscription.account.id,
            name: subscription.account.name,
            status: subscription.account.settings?.saas?.accountStatus || 'ACTIVE',
            admin: subscription.account.users?.[0]
              ? {
                  id: subscription.account.users[0].id,
                  name: subscription.account.users[0].name,
                  email: subscription.account.users[0].email,
                }
              : null,
          }
        : null,
    })),
  });
}

async function renewSuperAdminSubscription(req, res) {
  const accountId = Number(req.params.accountId);
  const subscriptionId = req.body.subscriptionId ? Number(req.body.subscriptionId) : null;
  if (!accountId) {
    return res.status(400).json({ message: 'Conta obrigatoria', data: {} });
  }

  const subscription = await renewAccountSubscription({ accountId, subscriptionId });

  await writeAuditLog({
    req,
    action: 'SUPER_ADMIN_SUBSCRIPTION_RENEWED',
    entity: 'Subscription',
    entityId: subscription.id,
    severity: 'INFO',
    metadata: {
      accountId,
      planCode: subscription.plan?.code,
      currentPeriodEnd: subscription.currentPeriodEnd,
    },
  });

  return res.json({
    message: 'Assinatura renovada',
    data: serializeSubscription(subscription),
  });
}

async function listSuperAdminPayments(req, res) {
  const payments = await prisma.payment.findMany({
    include: {
      account: true,
      client: true,
    },
    orderBy: { paidAt: 'desc' },
    take: 100,
  });

  return res.json({
    message: 'Pagamentos globais carregados',
    data: payments.map(serializePayment),
  });
}

async function listSuperAdminSaasPayments(req, res) {
  const intents = await prisma.saasPaymentIntent.findMany({
    include: {
      account: true,
      plan: true,
      subscription: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return res.json({
    message: 'Cobrancas SaaS carregadas',
    data: intents.map(serializeSaasPaymentIntent),
  });
}

async function listSuperAdminSupport(req, res) {
  const conversations = await prisma.supportConversation.findMany({
    include: {
      account: true,
      client: true,
      _count: { select: { messages: true } },
    },
    orderBy: { lastMessageAt: 'desc' },
    take: 100,
  });

  return res.json({
    message: 'Tickets globais carregados',
    data: conversations.map(serializeSupportConversation),
  });
}

async function listSuperAdminAuditLogs(req, res) {
  const logs = await prisma.auditLog.findMany({
    include: {
      account: true,
      user: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return res.json({
    message: 'Logs globais carregados',
    data: logs.map(serializeAuditLog),
  });
}

async function listSuperAdminWebhooks(req, res) {
  const logs = await prisma.webhookLog.findMany({
    include: { account: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return res.json({
    message: 'Webhooks globais carregados',
    data: logs.map(serializeWebhookLog),
  });
}

async function updateAccountStatus(req, res) {
  const accountId = Number(req.params.accountId);
  const status = String(req.body.status || '').trim().toUpperCase();
  const reason = String(req.body.reason || '').trim();

  if (!accountId || !['ACTIVE', 'SUSPENDED'].includes(status)) {
    return res.status(400).json({ message: 'Status ou conta invalida', data: {} });
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { settings: true },
  });
  if (!account) return res.status(404).json({ message: 'Empresa nao encontrada', data: {} });

  const currentSaas = account.settings?.saas || {};
  const nextSaas = {
    ...currentSaas,
    accountStatus: status,
    suspensionReason: status === 'SUSPENDED' ? reason : null,
    suspendedAt: status === 'SUSPENDED' ? new Date().toISOString() : null,
  };

  await prisma.accountSettings.upsert({
    where: { accountId },
    update: { saas: nextSaas },
    create: { accountId, saas: nextSaas },
  });

  await writeAuditLog({
    req,
    action: status === 'SUSPENDED' ? 'SUPER_ADMIN_ACCOUNT_SUSPENDED' : 'SUPER_ADMIN_ACCOUNT_RELEASED',
    entity: 'Account',
    entityId: accountId,
    severity: 'WARNING',
    metadata: { status, reason },
  });

  return res.json({
    message: status === 'SUSPENDED' ? 'Empresa suspensa' : 'Empresa liberada',
    data: { accountId, status, reason: status === 'SUSPENDED' ? reason : null },
  });
}

async function changeSuperAdminAccountPlan(req, res) {
  const accountId = Number(req.params.accountId);
  const planCode = String(req.body.planCode || '').trim().toUpperCase();
  if (!accountId || !planCode) {
    return res.status(400).json({ message: 'Conta e plano sao obrigatorios', data: {} });
  }

  const subscription = await changeAccountPlan({ accountId, planCode, status: 'ACTIVE' });

  await writeAuditLog({
    req,
    action: 'SUPER_ADMIN_PLAN_CHANGED',
    entity: 'Subscription',
    entityId: subscription.id,
    metadata: { accountId, planCode, planName: subscription.plan?.name },
  });

  return res.json({
    message: 'Plano alterado pelo SUPER ADMIN',
    data: serializeSubscription(subscription),
  });
}

async function impersonateAccountAdmin(req, res) {
  const accountId = Number(req.params.accountId);
  if (!accountId) return res.status(400).json({ message: 'Conta invalida', data: {} });

  const admin = await prisma.user.findFirst({
    where: { accountId, role: 'ADMIN' },
    orderBy: { createdAt: 'asc' },
    include: { account: true },
  });

  if (!admin) return res.status(404).json({ message: 'Admin da empresa nao encontrado', data: {} });

  const token = signAuthToken({
    ...admin,
    impersonatedBySuperAdmin: true,
    originalSuperAdminUserId: req.user.id,
  });

  await writeAuditLog({
    req,
    action: 'SUPER_ADMIN_IMPERSONATION_STARTED',
    entity: 'User',
    entityId: admin.id,
    severity: 'WARNING',
    metadata: { accountId, adminEmail: admin.email },
  });

  return res.json({
    message: 'Token de impersonacao gerado',
    data: {
      token,
      user: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        accountId: admin.accountId,
      },
      account: admin.account,
    },
  });
}

module.exports = {
  getSuperAdminOverview,
  listSuperAdminAccounts,
  listSuperAdminSubscriptions,
  listSuperAdminPayments,
  listSuperAdminSaasPayments,
  listSuperAdminSupport,
  listSuperAdminAuditLogs,
  listSuperAdminWebhooks,
  updateAccountStatus,
  changeSuperAdminAccountPlan,
  renewSuperAdminSubscription,
  impersonateAccountAdmin,
};
