const { writeAuditLog } = require('../services/audit.service');
const prisma = require('../prisma');
const {
  createPixPayment,
  getMercadoPagoCredentialsForAccount,
  getPayment,
  mapPaymentStatus,
} = require('../services/mercadopago.service');
const {
  applySaasPaymentResult,
  changeAccountPlan,
  ensureDefaultPlans,
  getSaasOverview,
  serializeSubscription,
} = require('../services/saas.service');

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function splitName(name) {
  const parts = String(name || 'Admin').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: 'Admin', lastName: 'Peguei & Paguei' };
  if (parts.length === 1) return { firstName: parts[0], lastName: 'Peguei & Paguei' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function serializeSaasIntent(intent) {
  if (!intent) return null;
  return {
    id: intent.id,
    provider: intent.provider,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    externalReference: intent.externalReference,
    mercadoPagoPaymentId: intent.mercadoPagoPaymentId,
    qrCode: intent.qrCode,
    qrCodeBase64: intent.qrCodeBase64,
    ticketUrl: intent.ticketUrl,
    paidAt: intent.paidAt,
    expiresAt: intent.expiresAt,
    planId: intent.planId,
    subscriptionId: intent.subscriptionId,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    plan: intent.plan
      ? {
          id: intent.plan.id,
          code: intent.plan.code,
          name: intent.plan.name,
          priceCents: intent.plan.priceCents,
          billingPeriod: intent.plan.billingPeriod,
        }
      : null,
  };
}

async function getSaasStatus(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Apenas ADMIN pode consultar planos', data: {} });
    }

    const overview = await getSaasOverview(req.user.accountId);
    return res.json({
      message: 'Plano carregado com sucesso',
      data: overview,
    });
  } catch (err) {
    console.error('Erro ao carregar SaaS:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao carregar plano',
      data: {},
    });
  }
}

async function listSaasPlanPayments(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Apenas ADMIN pode consultar faturas do plano', data: [] });
    }

    const intents = await prisma.saasPaymentIntent.findMany({
      where: { accountId: req.user.accountId },
      include: { plan: true, subscription: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return res.json({
      message: 'Faturas do plano carregadas',
      data: intents.map((intent) => ({
        ...serializeSaasIntent(intent),
        subscription: intent.subscription
          ? {
              id: intent.subscription.id,
              status: intent.subscription.status,
              currentPeriodEnd: intent.subscription.currentPeriodEnd,
            }
          : null,
      })),
    });
  } catch (err) {
    console.error('Erro ao carregar faturas SaaS:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao carregar faturas do plano',
      data: [],
    });
  }
}

async function selectSaasPlan(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Apenas ADMIN pode alterar plano', data: {} });
    }

    const planCode = String(req.body.planCode || req.body.code || '').trim().toUpperCase();
    if (!planCode) {
      return res.status(400).json({ message: 'planCode e obrigatorio', data: {} });
    }

    const subscription = await changeAccountPlan({
      accountId: req.user.accountId,
      planCode,
      status: 'ACTIVE',
    });

    await writeAuditLog({
      req,
      action: 'SAAS_PLAN_CHANGED',
      entity: 'Subscription',
      entityId: subscription.id,
      severity: 'INFO',
      metadata: {
        planCode,
        planName: subscription.plan?.name,
        status: subscription.status,
      },
    });

    const overview = await getSaasOverview(req.user.accountId);
    return res.json({
      message: 'Plano atualizado com sucesso',
      data: {
        subscription: serializeSubscription(subscription),
        overview,
      },
    });
  } catch (err) {
    console.error('Erro ao alterar plano:', err);
    return res.status(err.statusCode || 500).json({
      message: err.message || 'Erro ao alterar plano',
      data: err.data || {},
    });
  }
}

async function createSaasPlanPix(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Apenas ADMIN pode contratar planos', data: {} });
    }

    await ensureDefaultPlans();
    const planCode = String(req.body.planCode || req.body.code || '').trim().toUpperCase();
    if (!planCode) {
      return res.status(400).json({ message: 'planCode e obrigatorio', data: {} });
    }

    const plan = await prisma.plan.findFirst({
      where: { code: planCode, isActive: true, isPublic: true },
    });

    if (!plan) {
      return res.status(404).json({ message: 'Plano nao encontrado', data: {} });
    }

    if (Number(plan.priceCents || 0) <= 0) {
      const subscription = await changeAccountPlan({
        accountId: req.user.accountId,
        planCode,
        status: 'ACTIVE',
      });
      return res.json({
        message: 'Plano gratis ativado',
        data: {
          subscription: serializeSubscription(subscription),
          overview: await getSaasOverview(req.user.accountId),
        },
      });
    }

    const existingIntent = await prisma.saasPaymentIntent.findFirst({
      where: {
        accountId: req.user.accountId,
        planId: plan.id,
        provider: 'MERCADO_PAGO',
        status: { in: ['CREATED', 'PENDING', 'IN_PROCESS'] },
      },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });

    if (existingIntent?.qrCode) {
      return res.json({
        message: 'Cobranca SaaS Pix ja existente',
        data: serializeSaasIntent(existingIntent),
      });
    }

    const account = await prisma.account.findUnique({
      where: { id: req.user.accountId },
      select: { name: true },
    });
    const { firstName, lastName } = splitName(req.user.name || account?.name);
    const externalReference = `pegueipaguei:saas:${req.user.accountId}:${plan.code}:${Date.now()}`;
    const idempotencyKey = `saas-${req.user.accountId}-${plan.code}-${Date.now()}`;
    const mercadoPagoCredentials = await getMercadoPagoCredentialsForAccount(null);

    const mpPayment = await createPixPayment({
      amount: Number(plan.priceCents || 0) / 100,
      description: `Peguei & Paguei - Plano ${plan.name}`,
      externalReference,
      idempotencyKey,
      accessToken: mercadoPagoCredentials.accessToken,
      payer: {
        email: req.user.email || `admin-${req.user.accountId}@pegueipaguei.local`,
        firstName,
        lastName,
        cpf: onlyDigits(req.user.cpf),
      },
    });

    const transactionData = mpPayment?.point_of_interaction?.transaction_data || {};
    const intent = await prisma.saasPaymentIntent.create({
      data: {
        provider: 'MERCADO_PAGO',
        status: mapPaymentStatus(mpPayment.status),
        amount: Number(plan.priceCents || 0) / 100,
        currency: 'BRL',
        externalReference,
        idempotencyKey,
        mercadoPagoPaymentId: mpPayment.id ? String(mpPayment.id) : null,
        qrCode: transactionData.qr_code || null,
        qrCodeBase64: transactionData.qr_code_base64 || null,
        ticketUrl: transactionData.ticket_url || null,
        rawResponse: {
          ...mpPayment,
          credentialSource: mercadoPagoCredentials.credentialSource,
        },
        planId: plan.id,
        accountId: req.user.accountId,
      },
      include: { plan: true },
    });

    await writeAuditLog({
      req,
      action: 'SAAS_PLAN_PIX_CREATED',
      entity: 'SaasPaymentIntent',
      entityId: intent.id,
      severity: 'INFO',
      metadata: { planCode, amount: intent.amount, mercadoPagoPaymentId: intent.mercadoPagoPaymentId },
    });

    return res.status(201).json({
      message: 'Pix do plano criado com sucesso',
      data: serializeSaasIntent(intent),
    });
  } catch (err) {
    console.error('Erro ao criar Pix SaaS:', err);
    return res.status(err.statusCode || 500).json({
      message: err.message || 'Erro ao criar Pix do plano',
      data: err.response || {},
    });
  }
}

async function getSaasPlanPaymentStatus(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Apenas ADMIN pode consultar cobranca do plano', data: {} });
    }

    const intentId = Number(req.params.id);
    if (!intentId) {
      return res.status(400).json({ message: 'ID da cobranca invalido', data: {} });
    }

    let intent = await prisma.saasPaymentIntent.findFirst({
      where: { id: intentId, accountId: req.user.accountId },
      include: { plan: true },
    });

    if (!intent) {
      return res.status(404).json({ message: 'Cobranca nao encontrada', data: {} });
    }

    if (intent.mercadoPagoPaymentId && !['APPROVED', 'CANCELLED', 'REJECTED', 'REFUNDED'].includes(intent.status)) {
      const mercadoPagoCredentials = await getMercadoPagoCredentialsForAccount(null);
      const mpPayment = await getPayment(intent.mercadoPagoPaymentId, {
        accessToken: mercadoPagoCredentials.accessToken,
      });
      const status = mapPaymentStatus(mpPayment.status);
      await applySaasPaymentResult({
        mercadoPagoPaymentId: mpPayment.id,
        externalReference: mpPayment.external_reference,
        status,
        rawResponse: mpPayment,
        paidAt: mpPayment.date_approved ? new Date(mpPayment.date_approved) : undefined,
      });
      intent = await prisma.saasPaymentIntent.findUnique({
        where: { id: intent.id },
        include: { plan: true },
      });
    }

    return res.json({
      message: 'Status da cobranca carregado',
      data: {
        intent: serializeSaasIntent(intent),
        overview: await getSaasOverview(req.user.accountId),
      },
    });
  } catch (err) {
    console.error('Erro ao consultar Pix SaaS:', err);
    return res.status(err.statusCode || 500).json({
      message: err.message || 'Erro ao consultar Pix do plano',
      data: err.response || {},
    });
  }
}

module.exports = {
  createSaasPlanPix,
  getSaasPlanPaymentStatus,
  getSaasStatus,
  listSaasPlanPayments,
  selectSaasPlan,
};
