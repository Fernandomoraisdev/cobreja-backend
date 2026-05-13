const prisma = require('../prisma');

const DEFAULT_SAAS_GRACE_DAYS = Number(process.env.SAAS_GRACE_DAYS || 3);

const DEFAULT_PLANS = [
  {
    code: 'FREE',
    name: 'Grátis',
    description: 'Plano gratuito para começar a operar com limite reduzido.',
    priceCents: 0,
    clientLimit: 10,
    billingPeriod: 'FREE',
    periodMonths: 0,
    sortOrder: 0,
    features: [
      'Até 10 clientes ativos',
      'Controle de dívidas e parcelas',
      'Portal do cliente',
      'Pix por parcela em sandbox',
    ],
  },
  {
    code: 'MENSAL',
    name: 'Mensal',
    description: 'Plano mensal para carteiras em crescimento.',
    priceCents: 5990,
    clientLimit: 100,
    billingPeriod: 'MONTHLY',
    periodMonths: 1,
    sortOrder: 10,
    features: [
      'Até 100 clientes ativos',
      'Dashboard financeiro',
      'Automações manuais de cobrança',
      'Suporte integrado',
    ],
  },
  {
    code: 'TRIMESTRAL',
    name: 'Trimestral',
    description: 'Plano trimestral com mais limite e melhor custo-benefício.',
    priceCents: 15990,
    clientLimit: 250,
    billingPeriod: 'QUARTERLY',
    periodMonths: 3,
    sortOrder: 20,
    features: [
      'Até 250 clientes ativos',
      'Mercado Pago Pix',
      'Auditoria',
      'Relatórios avançados',
    ],
  },
  {
    code: 'SEMESTRAL',
    name: 'Semestral',
    description: 'Plano semestral para operação profissional recorrente.',
    priceCents: 29990,
    clientLimit: 500,
    billingPeriod: 'SEMIANNUAL',
    periodMonths: 6,
    sortOrder: 30,
    features: [
      'Até 500 clientes ativos',
      'Pix Mercado Pago',
      'Suporte integrado',
      'Auditoria e relatórios',
    ],
  },
  {
    code: 'ANUAL',
    name: 'Anual',
    description: 'Plano anual para carteiras maiores e operação SaaS completa.',
    priceCents: 49990,
    clientLimit: null,
    billingPeriod: 'YEARLY',
    periodMonths: 12,
    sortOrder: 40,
    features: [
      'Clientes ilimitados',
      'Prioridade em automações',
      'Dashboard premium',
      'Preparado para WhatsApp Business API',
    ],
  },
  {
    code: 'VITALICIO',
    name: 'Vitalício',
    description: 'Plano de pagamento único para uso contínuo da plataforma.',
    priceCents: 149990,
    clientLimit: null,
    billingPeriod: 'LIFETIME',
    periodMonths: 0,
    sortOrder: 50,
    features: [
      'Clientes ilimitados',
      'Acesso vitalício aos recursos SaaS',
      'Pix Mercado Pago',
      'Auditoria, suporte e automações',
    ],
  },
];

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function getPeriodEnd(plan) {
  const months = Number(plan?.periodMonths || 0);
  if (!months) return null;
  return addMonths(new Date(), months);
}

function isFreePlan(plan) {
  return Number(plan?.priceCents || 0) <= 0 || String(plan?.billingPeriod || '') === 'FREE';
}

function isLifetimePlan(plan) {
  return String(plan?.billingPeriod || '').toUpperCase() === 'LIFETIME';
}

function startOfDay(date = new Date()) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function diffDays(from, to = new Date()) {
  return Math.floor((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86400000);
}

function buildBillingStatus(subscription, now = new Date()) {
  const plan = subscription?.plan;
  const end = subscription?.currentPeriodEnd ? new Date(subscription.currentPeriodEnd) : null;
  const freeOrLifetime = !plan || isFreePlan(plan) || isLifetimePlan(plan);
  const isExpired = Boolean(end && end.getTime() < now.getTime());
  const daysPastDue = isExpired ? Math.max(diffDays(end, now), 0) : 0;
  const isPastDue = subscription?.status === 'PAST_DUE' || (isExpired && !freeOrLifetime);
  const accessBlocked = isPastDue && daysPastDue > DEFAULT_SAAS_GRACE_DAYS;

  return {
    status: subscription?.status || 'ACTIVE',
    isPaidPlan: Boolean(plan && !freeOrLifetime),
    isPastDue,
    isExpired,
    daysPastDue,
    graceDays: DEFAULT_SAAS_GRACE_DAYS,
    accessBlocked,
    renewRequired: isPastDue,
    currentPeriodEnd: subscription?.currentPeriodEnd || null,
  };
}

async function refreshSubscriptionStatus(subscription) {
  if (!subscription) return subscription;
  const billing = buildBillingStatus(subscription);
  if (
    billing.isPastDue &&
    subscription.status === 'ACTIVE' &&
    subscription.currentPeriodEnd &&
    !isFreePlan(subscription.plan) &&
    !isLifetimePlan(subscription.plan)
  ) {
    return prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'PAST_DUE' },
      include: { plan: true },
    });
  }
  return subscription;
}

function serializePlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    priceCents: plan.priceCents,
    currency: plan.currency,
    clientLimit: plan.clientLimit,
    billingPeriod: plan.billingPeriod,
    periodMonths: plan.periodMonths,
    sortOrder: plan.sortOrder,
    isPublic: plan.isPublic,
    features: Array.isArray(plan.features) ? plan.features : [],
    isActive: plan.isActive,
  };
}

function serializeSubscription(subscription) {
  if (!subscription) return null;
  return {
    id: subscription.id,
    status: subscription.status,
    trialEndsAt: subscription.trialEndsAt,
    currentPeriodEnd: subscription.currentPeriodEnd,
    externalProvider: subscription.externalProvider,
    externalId: subscription.externalId,
    plan: serializePlan(subscription.plan),
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

async function ensureDefaultPlans() {
  const plans = [];
  const activeCodes = DEFAULT_PLANS.map((plan) => plan.code);
  for (const plan of DEFAULT_PLANS) {
    const saved = await prisma.plan.upsert({
      where: { code: plan.code },
      update: {
        name: plan.name,
        description: plan.description,
        priceCents: plan.priceCents,
        currency: 'BRL',
        clientLimit: plan.clientLimit,
        billingPeriod: plan.billingPeriod,
        periodMonths: plan.periodMonths,
        sortOrder: plan.sortOrder,
        isPublic: true,
        features: plan.features,
        isActive: true,
      },
      create: {
        code: plan.code,
        name: plan.name,
        description: plan.description,
        priceCents: plan.priceCents,
        currency: 'BRL',
        clientLimit: plan.clientLimit,
        billingPeriod: plan.billingPeriod,
        periodMonths: plan.periodMonths,
        sortOrder: plan.sortOrder,
        isPublic: true,
        features: plan.features,
        isActive: true,
      },
    });
    plans.push(saved);
  }

  await prisma.plan.updateMany({
    where: {
      AND: [
        { code: { notIn: activeCodes } },
        { code: { in: ['STARTER', 'PRO', 'BUSINESS', 'LIFETIME'] } },
      ],
    },
    data: { isActive: false, isPublic: false },
  });

  return plans;
}

async function getActiveClientCount(accountId) {
  return prisma.client.count({
    where: {
      accountId,
      status: 'ACTIVE',
      deletedAt: null,
    },
  });
}

async function ensureAccountSubscription(accountId) {
  await ensureDefaultPlans();

  const existing = await prisma.subscription.findFirst({
    where: {
      accountId,
      status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
    },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });

  if (existing) return refreshSubscriptionStatus(existing);

  const freePlan = await prisma.plan.findUnique({ where: { code: 'FREE' } });
  return prisma.subscription.create({
    data: {
      status: 'ACTIVE',
      trialEndsAt: null,
      currentPeriodEnd: null,
      accountId,
      planId: freePlan.id,
    },
    include: { plan: true },
  });
}

async function getSaasOverview(accountId) {
  const [plans, subscription, activeClients] = await Promise.all([
    ensureDefaultPlans(),
    ensureAccountSubscription(accountId),
    getActiveClientCount(accountId),
  ]);

  const refreshedSubscription = await refreshSubscriptionStatus(subscription);
  const billing = buildBillingStatus(refreshedSubscription);
  const limit = refreshedSubscription.plan.clientLimit;
  const remainingClients = limit == null ? null : Math.max(limit - activeClients, 0);

  return {
    plans: plans
      .map(serializePlan)
      .filter((plan) => plan.isActive && plan.isPublic)
      .sort((left, right) => left.sortOrder - right.sortOrder),
    subscription: serializeSubscription(refreshedSubscription),
    billing,
    usage: {
      activeClients,
      clientLimit: limit,
      remainingClients,
      unlimitedClients: limit == null,
      limitReached: limit != null && activeClients >= limit,
      usagePercent: limit == null ? 0 : Math.min(Math.round((activeClients / limit) * 100), 100),
    },
  };
}

async function changeAccountPlan({
  accountId,
  planCode,
  status = 'ACTIVE',
  externalProvider = null,
  externalId = null,
}) {
  await ensureDefaultPlans();
  const plan = await prisma.plan.findFirst({
    where: {
      code: String(planCode || '').trim().toUpperCase(),
      isActive: true,
    },
  });

  if (!plan) {
    const err = new Error('Plano nao encontrado');
    err.statusCode = 404;
    throw err;
  }

  const activeClients = await getActiveClientCount(accountId);
  if (plan.clientLimit != null && activeClients > plan.clientLimit) {
    const err = new Error(
      `Este plano permite ${plan.clientLimit} cliente(s) ativo(s), mas esta conta possui ${activeClients}. Escolha um plano maior ou arquive clientes antes de reduzir o plano.`,
    );
    err.statusCode = 409;
    err.code = 'PLAN_LIMIT_TOO_LOW';
    err.data = {
      activeClients,
      clientLimit: plan.clientLimit,
      plan: serializePlan(plan),
    };
    throw err;
  }

  await prisma.subscription.updateMany({
    where: {
      accountId,
      status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
    },
    data: { status: 'CANCELLED' },
  });

  return prisma.subscription.create({
    data: {
      status,
      trialEndsAt: null,
      currentPeriodEnd: getPeriodEnd(plan),
      externalProvider,
      externalId,
      accountId,
      planId: plan.id,
    },
    include: { plan: true },
  });
}

async function activatePaidPlan({ accountId, planId, externalProvider, externalId }) {
  await ensureDefaultPlans();
  const plan = await prisma.plan.findFirst({
    where: { id: Number(planId), isActive: true },
  });

  if (!plan) {
    const err = new Error('Plano nao encontrado');
    err.statusCode = 404;
    throw err;
  }

  return changeAccountPlan({
    accountId,
    planCode: plan.code,
    status: isFreePlan(plan) ? 'ACTIVE' : 'ACTIVE',
    externalProvider,
    externalId,
  });
}

async function applySaasPaymentResult({
  mercadoPagoPaymentId,
  externalReference,
  status,
  rawResponse,
  rawWebhook,
  paidAt,
}) {
  const intent = await prisma.saasPaymentIntent.findFirst({
    where: {
      OR: [
        ...(mercadoPagoPaymentId ? [{ mercadoPagoPaymentId: String(mercadoPagoPaymentId) }] : []),
        ...(externalReference ? [{ externalReference: String(externalReference) }] : []),
      ],
    },
    include: { plan: true },
  });

  if (!intent) {
    return { applied: false, reason: 'SAAS_PAYMENT_INTENT_NOT_FOUND' };
  }

  if (status !== 'APPROVED') {
    await prisma.saasPaymentIntent.update({
      where: { id: intent.id },
      data: {
        status,
        mercadoPagoPaymentId: mercadoPagoPaymentId ? String(mercadoPagoPaymentId) : intent.mercadoPagoPaymentId,
        rawResponse,
        rawWebhook: rawWebhook || intent.rawWebhook,
        lastCheckedAt: new Date(),
      },
    });
    return { applied: false, reason: `STATUS_${status}`, saasIntentId: intent.id };
  }

  if (intent.subscriptionId && intent.status === 'APPROVED') {
    return {
      applied: false,
      reason: 'ALREADY_APPLIED',
      saasIntentId: intent.id,
      subscriptionId: intent.subscriptionId,
    };
  }

  const approvedAt = paidAt || new Date();
  const subscription = await activatePaidPlan({
    accountId: intent.accountId,
    planId: intent.planId,
    externalProvider: 'MERCADO_PAGO',
    externalId: mercadoPagoPaymentId ? String(mercadoPagoPaymentId) : intent.mercadoPagoPaymentId,
  });

  await prisma.saasPaymentIntent.update({
    where: { id: intent.id },
    data: {
      status: 'APPROVED',
      mercadoPagoPaymentId: mercadoPagoPaymentId ? String(mercadoPagoPaymentId) : intent.mercadoPagoPaymentId,
      rawResponse,
      rawWebhook: rawWebhook || intent.rawWebhook,
      paidAt: approvedAt,
      subscriptionId: subscription.id,
      lastCheckedAt: new Date(),
    },
  });

  return {
    applied: true,
    saasIntentId: intent.id,
    subscriptionId: subscription.id,
    accountId: intent.accountId,
  };
}

async function enforceClientLimit(accountId) {
  const overview = await getSaasOverview(accountId);
  if (overview.billing?.accessBlocked) {
    const err = new Error(
      'Assinatura vencida. Renove o plano para cadastrar novos clientes.',
    );
    err.statusCode = 402;
    err.code = 'SAAS_SUBSCRIPTION_BLOCKED';
    err.data = overview;
    throw err;
  }

  if (!overview.usage.limitReached) return overview;

  const planName = overview.subscription?.plan?.name || 'atual';
  const limit = overview.usage.clientLimit;
  const err = new Error(
    `Limite do plano ${planName} atingido. Este plano permite ${limit} cliente(s) ativo(s).`,
  );
  err.statusCode = 402;
  err.code = 'CLIENT_LIMIT_REACHED';
  err.data = overview;
  throw err;
}

module.exports = {
  DEFAULT_PLANS,
  ensureDefaultPlans,
  ensureAccountSubscription,
  getSaasOverview,
  changeAccountPlan,
  activatePaidPlan,
  applySaasPaymentResult,
  enforceClientLimit,
  serializeSubscription,
};
