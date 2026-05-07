const prisma = require('../prisma');

const DEFAULT_PLANS = [
  {
    code: 'FREE',
    name: 'Gratis',
    description: 'Plano inicial para validar a operacao com limite reduzido.',
    priceCents: 0,
    clientLimit: 20,
    features: [
      'Ate 20 clientes ativos',
      'Controle de dividas e parcelas',
      'Portal do cliente',
      'Pix por parcela',
    ],
  },
  {
    code: 'STARTER',
    name: 'Starter',
    description: 'Plano para carteiras em crescimento.',
    priceCents: 4900,
    clientLimit: 100,
    features: [
      'Ate 100 clientes ativos',
      'Dashboard financeiro',
      'Automacoes manuais de cobranca',
      'Suporte integrado',
    ],
  },
  {
    code: 'PRO',
    name: 'Pro',
    description: 'Plano profissional para operacao recorrente.',
    priceCents: 9900,
    clientLimit: 500,
    features: [
      'Ate 500 clientes ativos',
      'Mercado Pago Pix',
      'Auditoria',
      'Relatorios avancados',
    ],
  },
  {
    code: 'BUSINESS',
    name: 'Business',
    description: 'Plano para carteiras maiores e operacao SaaS completa.',
    priceCents: 19900,
    clientLimit: null,
    features: [
      'Clientes ilimitados',
      'Prioridade em automacoes',
      'Estrutura multi-conta',
      'Preparado para WhatsApp Business API',
    ],
  },
];

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
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
  for (const plan of DEFAULT_PLANS) {
    const saved = await prisma.plan.upsert({
      where: { code: plan.code },
      update: {
        name: plan.name,
        description: plan.description,
        priceCents: plan.priceCents,
        currency: 'BRL',
        clientLimit: plan.clientLimit,
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
        features: plan.features,
        isActive: true,
      },
    });
    plans.push(saved);
  }
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

  if (existing) return existing;

  const freePlan = await prisma.plan.findUnique({ where: { code: 'FREE' } });
  return prisma.subscription.create({
    data: {
      status: 'TRIAL',
      trialEndsAt: addDays(new Date(), 14),
      currentPeriodEnd: addDays(new Date(), 14),
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

  const limit = subscription.plan.clientLimit;
  const remainingClients = limit == null ? null : Math.max(limit - activeClients, 0);

  return {
    plans: plans.map(serializePlan).sort((left, right) => left.priceCents - right.priceCents),
    subscription: serializeSubscription(subscription),
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

async function changeAccountPlan({ accountId, planCode, status = 'ACTIVE' }) {
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
      currentPeriodEnd: addDays(new Date(), 30),
      accountId,
      planId: plan.id,
    },
    include: { plan: true },
  });
}

async function enforceClientLimit(accountId) {
  const overview = await getSaasOverview(accountId);
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
  enforceClientLimit,
  serializeSubscription,
};
