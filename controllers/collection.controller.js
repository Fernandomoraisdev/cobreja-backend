const prisma = require('../prisma');
const { writeAuditLog } = require('../services/audit.service');

const DEFAULT_WHATSAPP_TEMPLATES = [
  {
    type: 'DUE_TODAY',
    title: 'Vencimento hoje',
    body: [
      'Ola, {{cliente}}.',
      'Passando para lembrar que sua parcela {{parcela}} vence hoje ({{vencimento}}).',
      'Valor da parcela: {{valor}}.',
      'Se quiser, posso te enviar o Pix para pagamento.',
    ].join('\n\n'),
  },
  {
    type: 'DUE_TOMORROW',
    title: 'Vencimento amanha',
    body: [
      'Ola, {{cliente}}.',
      'Sua parcela {{parcela}} vence amanha ({{vencimento}}).',
      'Valor previsto: {{valor}}.',
      'Se quiser adiantar, posso te enviar o Pix.',
    ].join('\n\n'),
  },
  {
    type: 'OVERDUE',
    title: 'Parcela em atraso',
    body: [
      'Ola, {{cliente}}.',
      'Identificamos que sua parcela {{parcela}} venceu em {{vencimento}} e esta com {{diasAtraso}} dia(s) de atraso.',
      'Valor atualizado da parcela: {{valor}}.',
      'Se ja realizou o pagamento, por favor desconsidere esta mensagem. Caso precise, posso te enviar o Pix para regularizar.',
    ].join('\n\n'),
  },
];

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

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function formatMoney(value) {
  return roundMoney(value).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function formatDate(value) {
  return new Date(value).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function buildWhatsAppLink(phone, message) {
  const digits = onlyDigits(phone);
  if (!digits) return null;
  const normalized = digits.startsWith('55') ? digits : `55${digits}`;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
}

function daysBetween(start, end) {
  const startTime = startOfDay(start).getTime();
  const endTime = startOfDay(end).getTime();
  return Math.max(Math.floor((endTime - startTime) / 86400000), 0);
}

function templateForType(settings, type) {
  const templates = Array.isArray(settings?.whatsapp?.templates)
    ? settings.whatsapp.templates
    : [];
  const custom = templates.find((template) => String(template?.type || '').toUpperCase() === type);
  const fallback = DEFAULT_WHATSAPP_TEMPLATES.find((template) => template.type === type);
  return String(custom?.body || fallback?.body || '').trim();
}

function renderTemplate(template, values) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const normalizedKey = String(key || '').trim();
    return values[normalizedKey] ?? values[normalizedKey.toLowerCase()] ?? '';
  });
}

function buildCollectionMessage({ client, installment, remaining, daysLate, settings, type }) {
  const name = String(client?.name || 'cliente').trim();
  const dueDate = formatDate(installment.dueDate);
  const amount = formatMoney(remaining);
  const companyName = String(settings?.company?.name || 'COBREJA').trim();
  const template = templateForType(settings, type);

  if (template) {
    return renderTemplate(template, {
      cliente: name,
      parcela: installment.installmentNumber,
      vencimento: dueDate,
      valor: amount,
      diasAtraso: daysLate,
      empresa: companyName,
    });
  }

  if (daysLate > 0) {
    return [
      `Ola, ${name}.`,
      `Identificamos que sua parcela ${installment.installmentNumber} venceu em ${dueDate} e esta com ${daysLate} dia(s) de atraso.`,
      `Valor atualizado da parcela: ${amount}.`,
      'Se ja realizou o pagamento, por favor desconsidere esta mensagem. Caso precise, posso te enviar o Pix para regularizar.',
    ].join('\n\n');
  }

  return [
    `Ola, ${name}.`,
    `Passando para lembrar que sua parcela ${installment.installmentNumber} vence hoje (${dueDate}).`,
    `Valor da parcela: ${amount}.`,
    'Se quiser, posso te enviar o Pix para pagamento.',
  ].join('\n\n');
}

function serializeCollectionItem(installment, today = new Date(), settings = {}, typeOverride = null) {
  const remaining = roundMoney(
    Math.max(Number(installment.amount || 0) - Number(installment.paidAmount || 0), 0),
  );
  const daysLate = new Date(installment.dueDate) < startOfDay(today)
    ? daysBetween(installment.dueDate, today)
    : 0;
  const type = typeOverride || (daysLate > 0 ? 'OVERDUE' : 'DUE_TODAY');
  const message = buildCollectionMessage({
    client: installment.client,
    installment,
    remaining,
    daysLate,
    settings,
    type,
  });

  return {
    installmentId: installment.id,
    installmentNumber: installment.installmentNumber,
    installmentStatus: installment.status,
    debtId: installment.debtId,
    dueDate: installment.dueDate,
    amount: installment.amount,
    paidAmount: installment.paidAmount,
    remaining,
    daysLate,
    type,
    message,
    whatsappLink: buildWhatsAppLink(installment.client?.phone, message),
    client: installment.client
      ? {
          id: installment.client.id,
          name: installment.client.name,
          cpf: installment.client.cpf,
          phone: installment.client.phone,
          email: installment.client.email,
        }
      : null,
    debt: installment.debt
      ? {
          id: installment.debt.id,
          title: installment.debt.title,
          status: installment.debt.status,
          principalOutstanding: installment.debt.principalOutstanding,
        }
      : null,
  };
}

async function listCollectionAutomation(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        message: 'Apenas ADMIN pode consultar automacoes de cobranca',
        data: {},
      });
    }

    const today = new Date();
    const todayStart = startOfDay(today);
    const todayEnd = endOfDay(today);
    const tomorrowEnd = endOfDay(addDays(today, 1));
    const accountId = req.user.accountId;

    const [dueToday, dueTomorrow, overdue] = await Promise.all([
      prisma.installment.findMany({
        where: {
          accountId,
          status: { not: 'PAID' },
          dueDate: { gte: todayStart, lte: todayEnd },
        },
        include: { client: true, debt: true },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: 80,
      }),
      prisma.installment.findMany({
        where: {
          accountId,
          status: { not: 'PAID' },
          dueDate: { gt: todayEnd, lte: tomorrowEnd },
        },
        include: { client: true, debt: true },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: 80,
      }),
      prisma.installment.findMany({
        where: {
          accountId,
          status: { not: 'PAID' },
          dueDate: { lt: todayStart },
        },
        include: { client: true, debt: true },
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        take: 120,
      }),
    ]);
    const settings = await prisma.accountSettings.findUnique({
      where: { accountId },
      select: { company: true, whatsapp: true },
    });

    const dueTodayItems = dueToday.map((item) =>
      serializeCollectionItem(item, today, settings, 'DUE_TODAY'));
    const dueTomorrowItems = dueTomorrow.map((item) =>
      serializeCollectionItem(item, today, settings, 'DUE_TOMORROW'));
    const overdueItems = overdue.map((item) =>
      serializeCollectionItem(item, today, settings, 'OVERDUE'));
    const allItems = [...dueTodayItems, ...dueTomorrowItems, ...overdueItems];

    return res.json({
      message: 'Automacoes de cobranca carregadas',
      data: {
        generatedAt: today,
        totals: {
          dueToday: dueTodayItems.length,
          dueTomorrow: dueTomorrowItems.length,
          overdue: overdueItems.length,
          totalAmount: roundMoney(allItems.reduce((sum, item) => sum + item.remaining, 0)),
          overdueAmount: roundMoney(
            overdueItems.reduce((sum, item) => sum + item.remaining, 0),
          ),
        },
        dueToday: dueTodayItems,
        dueTomorrow: dueTomorrowItems,
        overdue: overdueItems,
        templates: {
          defaults: DEFAULT_WHATSAPP_TEMPLATES,
          active: Array.isArray(settings?.whatsapp?.templates)
            ? settings.whatsapp.templates
            : DEFAULT_WHATSAPP_TEMPLATES,
        },
      },
    });
  } catch (err) {
    console.error('Erro ao carregar automacoes de cobranca:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao carregar automacoes de cobranca',
      data: {},
    });
  }
}

async function registerCollectionGenerated(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        message: 'Apenas ADMIN pode registrar cobranca gerada',
        data: {},
      });
    }

    const installmentId = Number(req.params.installmentId || req.body.installmentId);
    if (!installmentId) {
      return res.status(400).json({ message: 'installmentId e obrigatorio', data: {} });
    }

    const installment = await prisma.installment.findFirst({
      where: {
        id: installmentId,
        accountId: req.user.accountId,
        status: { not: 'PAID' },
      },
      include: { client: true, debt: true },
    });

    if (!installment) {
      return res.status(404).json({ message: 'Parcela nao encontrada', data: {} });
    }

    const settings = await prisma.accountSettings.findUnique({
      where: { accountId: req.user.accountId },
      select: { company: true, whatsapp: true },
    });
    const item = serializeCollectionItem(installment, new Date(), settings);
    const channel = String(req.body.channel || 'WHATSAPP_MANUAL').trim().toUpperCase();

    await writeAuditLog({
      req,
      action: 'COLLECTION_GENERATED',
      entity: 'Installment',
      entityId: installment.id,
      severity: item.daysLate > 0 ? 'WARNING' : 'INFO',
      metadata: {
        channel,
        clientId: installment.clientId,
        debtId: installment.debtId,
        amount: item.remaining,
        dueDate: installment.dueDate,
        daysLate: item.daysLate,
        message: item.message,
      },
    });

    return res.json({
      message: 'Cobranca registrada no historico',
      data: item,
    });
  } catch (err) {
    console.error('Erro ao registrar cobranca gerada:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao registrar cobranca gerada',
      data: {},
    });
  }
}

module.exports = {
  listCollectionAutomation,
  registerCollectionGenerated,
};
