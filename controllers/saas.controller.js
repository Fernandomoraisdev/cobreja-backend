const { writeAuditLog } = require('../services/audit.service');
const prisma = require('../prisma');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { signAuthToken } = require('../utils/auth');
const {
  createCheckoutPreference,
  createPixPayment,
  getMercadoPagoCredentialsForAccount,
  getPayment,
  mapPaymentStatus,
} = require('../services/mercadopago.service');
const {
  applySaasPaymentResult,
  cancelScheduledPlanChange,
  changeAccountPlan,
  ensureDefaultPlans,
  getSaasOverview,
  scheduleAccountPlanChange,
  serializeSubscription,
} = require('../services/saas.service');

function onlyDigits(value) {
  return String(value || '').replace(/\D+/g, '');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeCompany(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    cpf: user.cpf,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    role: user.role,
    accountId: user.accountId,
  };
}

function buildInviteCode(companyName) {
  const prefix = String(companyName || 'PEGUEI')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6) || 'PEGUEI';
  return `${prefix}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function createUniqueInviteCode(companyName, tx = prisma) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = buildInviteCode(companyName);
    const existing = await tx.account.findUnique({ where: { inviteCode: code } });
    if (!existing) return code;
  }
  throw new Error('Nao foi possivel gerar convite da empresa');
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
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

async function listPublicSaasPlans(req, res) {
  try {
    const plans = await ensureDefaultPlans();
    return res.json({
      message: 'Planos publicos carregados',
      data: plans
        .filter((plan) => plan.isActive && plan.isPublic)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((plan) => ({
          id: plan.id,
          code: plan.code,
          name: plan.name,
          description: plan.description,
          priceCents: plan.priceCents,
          currency: plan.currency,
          clientLimit: plan.clientLimit,
          billingPeriod: plan.billingPeriod,
          periodMonths: plan.periodMonths,
          features: Array.isArray(plan.features) ? plan.features : [],
        })),
    });
  } catch (err) {
    console.error('Erro ao carregar planos publicos:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao carregar planos',
      data: [],
    });
  }
}

async function createPublicSaasSignup(req, res) {
  try {
    await ensureDefaultPlans();

    const name = String(req.body.name || '').trim();
    const companyName = normalizeCompany(req.body.company || req.body.companyName || req.body.empresa);
    const email = normalizeEmail(req.body.email);
    const phone = String(req.body.phone || '').trim() || null;
    const password = String(req.body.password || '');
    const planCode = String(req.body.planCode || req.body.code || 'FREE').trim().toUpperCase();
    const paymentMethod = String(req.body.paymentMethod || 'PIX').trim().toUpperCase();

    if (!name || !companyName || !email || !phone || !password) {
      return res.status(400).json({
        message: 'Nome, empresa, email, telefone e senha sao obrigatorios',
        data: {},
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        message: 'A senha precisa ter pelo menos 8 caracteres',
        data: {},
      });
    }

    const plan = await prisma.plan.findFirst({
      where: { code: planCode, isActive: true, isPublic: true },
    });

    if (!plan) {
      return res.status(404).json({ message: 'Plano nao encontrado', data: {} });
    }

    const [duplicatedUser, duplicatedAccount] = await Promise.all([
      prisma.user.findFirst({
        where: { email: { equals: email, mode: 'insensitive' } },
        select: { id: true },
      }),
      prisma.account.findFirst({
        where: { name: { equals: companyName, mode: 'insensitive' } },
        select: { id: true },
      }),
    ]);

    if (duplicatedUser) {
      return res.status(409).json({
        message: 'Ja existe um usuario com este email',
        data: {},
      });
    }

    if (duplicatedAccount) {
      return res.status(409).json({
        message: 'Ja existe uma empresa com este nome',
        data: {},
      });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date();
    const isFreeSignup = Number(plan.priceCents || 0) <= 0 || plan.code === 'FREE';

    const result = await prisma.$transaction(async (tx) => {
      const inviteCode = await createUniqueInviteCode(companyName, tx);
      const account = await tx.account.create({
        data: {
          name: companyName,
          inviteCode,
          settings: {
            create: {
              company: {
                name: companyName,
                email,
                phone,
                createdFrom: 'PUBLIC_SAAS_SIGNUP',
              },
              admin: {
                name,
                email,
                phone,
              },
              saas: {
                accountStatus: isFreeSignup ? 'ACTIVE' : 'PENDING_PAYMENT',
                signupSource: 'PUBLIC_LANDING',
                onboardingStatus: {
                  companyConfigured: false,
                  mercadoPagoConnected: false,
                  firstClientCreated: false,
                  firstChargeCreated: false,
                },
              },
              appearance: {
                theme: 'dark',
                accent: 'peguei_paguei',
              },
            },
          },
        },
      });

      const user = await tx.user.create({
        data: {
          name,
          email,
          phone,
          password: passwordHash,
          role: 'ADMIN',
          accountId: account.id,
        },
      });

      const subscription = await tx.subscription.create({
        data: {
          status: isFreeSignup ? 'TRIAL' : 'PENDING_PAYMENT',
          trialEndsAt: isFreeSignup ? addDays(now, 30) : null,
          currentPeriodEnd: isFreeSignup ? addDays(now, 30) : null,
          externalProvider: isFreeSignup ? 'TRIAL' : null,
          accountId: account.id,
          planId: plan.id,
        },
        include: { plan: true, pendingPlan: true },
      });

      await tx.auditLog.create({
        data: {
          action: isFreeSignup ? 'PUBLIC_SAAS_TRIAL_CREATED' : 'PUBLIC_SAAS_SIGNUP_PENDING_PAYMENT',
          entity: 'Subscription',
          entityId: String(subscription.id),
          severity: 'INFO',
          metadata: {
            planCode: plan.code,
            companyName,
            paymentMethod: isFreeSignup ? 'TRIAL' : paymentMethod,
          },
          ip: req.ip || null,
          userAgent: req.headers?.['user-agent'] || null,
          accountId: account.id,
          userId: user.id,
        },
      });

      return { account, user, subscription };
    });

    if (isFreeSignup) {
      const token = signAuthToken(result.user);
      return res.status(201).json({
        message: 'Trial criado com sucesso',
        data: {
          status: 'ACTIVE_TRIAL',
          token,
          user: sanitizeUser(result.user),
          account: result.account,
          subscription: serializeSubscription(result.subscription),
          onboarding: {
            nextStep: 'CONFIGURE_COMPANY',
            checklist: ['CONFIGURE_COMPANY', 'CONNECT_MERCADO_PAGO', 'CREATE_FIRST_CLIENT', 'CREATE_FIRST_CHARGE'],
          },
        },
        token,
        user: sanitizeUser(result.user),
      });
    }

    const { firstName, lastName } = splitName(name);
    const externalReference = `pegueipaguei:public-saas:${result.account.id}:${plan.code}:${Date.now()}`;
    const idempotencyKey = `public-saas-${result.account.id}-${plan.code}-${Date.now()}`;
    const mercadoPagoCredentials = await getMercadoPagoCredentialsForAccount(null);
    let paymentPayload;
    let rawPayment;

    if (paymentMethod === 'CARD') {
      rawPayment = await createCheckoutPreference({
        amount: Number(plan.priceCents || 0) / 100,
        description: `Peguei & Paguei - Plano ${plan.name}`,
        externalReference,
        accessToken: mercadoPagoCredentials.accessToken,
        payer: { email, firstName, lastName, cpf: null },
      });
      paymentPayload = {
        method: 'CARD',
        checkoutUrl: rawPayment.init_point || rawPayment.sandbox_init_point || null,
        sandboxCheckoutUrl: rawPayment.sandbox_init_point || null,
      };
    } else {
      rawPayment = await createPixPayment({
        amount: Number(plan.priceCents || 0) / 100,
        description: `Peguei & Paguei - Plano ${plan.name}`,
        externalReference,
        idempotencyKey,
        accessToken: mercadoPagoCredentials.accessToken,
        payer: { email, firstName, lastName, cpf: null },
      });
      const transactionData = rawPayment?.point_of_interaction?.transaction_data || {};
      paymentPayload = {
        method: 'PIX',
        qrCode: transactionData.qr_code || null,
        qrCodeBase64: transactionData.qr_code_base64 || null,
        ticketUrl: transactionData.ticket_url || null,
      };
    }

    const intent = await prisma.saasPaymentIntent.create({
      data: {
        provider: 'MERCADO_PAGO',
        status: paymentMethod === 'CARD' ? 'CREATED' : mapPaymentStatus(rawPayment.status),
        amount: Number(plan.priceCents || 0) / 100,
        currency: 'BRL',
        externalReference,
        idempotencyKey,
        mercadoPagoPaymentId: rawPayment.id ? String(rawPayment.id) : null,
        qrCode: paymentPayload.qrCode || null,
        qrCodeBase64: paymentPayload.qrCodeBase64 || null,
        ticketUrl: paymentPayload.ticketUrl || paymentPayload.checkoutUrl || null,
        rawResponse: {
          ...rawPayment,
          credentialSource: mercadoPagoCredentials.credentialSource,
          signupFlow: 'PUBLIC',
          paymentMethod,
        },
        planId: plan.id,
        subscriptionId: result.subscription.id,
        accountId: result.account.id,
      },
      include: { plan: true },
    });

    await prisma.auditLog.create({
      data: {
        action: paymentMethod === 'CARD' ? 'PUBLIC_SAAS_CHECKOUT_CREATED' : 'PUBLIC_SAAS_PIX_CREATED',
        entity: 'SaasPaymentIntent',
        entityId: String(intent.id),
        severity: 'INFO',
        metadata: {
          planCode: plan.code,
          amount: intent.amount,
          mercadoPagoPaymentId: intent.mercadoPagoPaymentId,
          externalReference,
        },
        ip: req.ip || null,
        userAgent: req.headers?.['user-agent'] || null,
        accountId: result.account.id,
        userId: result.user.id,
      },
    });

    return res.status(201).json({
      message: paymentMethod === 'CARD'
        ? 'Checkout criado com sucesso'
        : 'Pix criado com sucesso',
      data: {
        status: 'PENDING_PAYMENT',
        accountId: result.account.id,
        subscription: serializeSubscription(result.subscription),
        intent: serializeSaasIntent(intent),
        payment: paymentPayload,
        onboarding: {
          nextStep: 'WAIT_PAYMENT',
          message: 'A conta sera liberada automaticamente quando o Mercado Pago confirmar o pagamento.',
        },
      },
    });
  } catch (err) {
    console.error('Erro no cadastro SaaS publico:', err);
    return res.status(err.statusCode || 500).json({
      message: err.message || 'Erro ao criar cadastro SaaS',
      data: err.response || {},
    });
  }
}

async function getPublicSaasSignupStatus(req, res) {
  try {
    const intentId = Number(req.params.id);
    const externalReference = String(req.query.externalReference || '').trim();

    if (!intentId || !externalReference) {
      return res.status(400).json({
        message: 'Dados da cobranca invalidos',
        data: {},
      });
    }

    let intent = await prisma.saasPaymentIntent.findFirst({
      where: {
        id: intentId,
        externalReference,
      },
      include: { plan: true, subscription: true },
    });

    if (!intent) {
      return res.status(404).json({
        message: 'Cadastro SaaS nao encontrado',
        data: {},
      });
    }

    if (intent.mercadoPagoPaymentId && !['APPROVED', 'CANCELLED', 'REJECTED', 'REFUNDED'].includes(intent.status)) {
      const mercadoPagoCredentials = await getMercadoPagoCredentialsForAccount(null);
      const mpPayment = await getPayment(intent.mercadoPagoPaymentId, {
        accessToken: mercadoPagoCredentials.accessToken,
      });
      await applySaasPaymentResult({
        mercadoPagoPaymentId: mpPayment.id,
        externalReference: mpPayment.external_reference,
        status: mapPaymentStatus(mpPayment.status),
        rawResponse: mpPayment,
        paidAt: mpPayment.date_approved ? new Date(mpPayment.date_approved) : undefined,
      });
      intent = await prisma.saasPaymentIntent.findFirst({
        where: { id: intentId, externalReference },
        include: { plan: true, subscription: true },
      });
    }

    const isApproved = intent.status === 'APPROVED';
    let token = null;
    let user = null;

    if (isApproved) {
      user = await prisma.user.findFirst({
        where: {
          accountId: intent.accountId,
          role: 'ADMIN',
        },
        orderBy: { createdAt: 'asc' },
      });
      if (user) token = signAuthToken(user);
    }

    return res.json({
      message: isApproved ? 'Cadastro liberado' : 'Cadastro aguardando pagamento',
      data: {
        status: isApproved ? 'ACTIVE' : intent.status,
        token,
        user: sanitizeUser(user),
        intent: serializeSaasIntent(intent),
        accountId: intent.accountId,
      },
      token,
      user: sanitizeUser(user),
    });
  } catch (err) {
    console.error('Erro ao consultar cadastro SaaS publico:', err);
    return res.status(err.statusCode || 500).json({
      message: err.message || 'Erro ao consultar cadastro SaaS',
      data: err.response || {},
    });
  }
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

async function scheduleSaasPlanChange(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Apenas ADMIN pode agendar troca de plano', data: {} });
    }

    const planCode = String(req.body.planCode || req.body.code || '').trim().toUpperCase();
    if (!planCode) {
      return res.status(400).json({ message: 'planCode e obrigatorio', data: {} });
    }

    const subscription = await scheduleAccountPlanChange({
      accountId: req.user.accountId,
      planCode,
    });

    await writeAuditLog({
      req,
      action: 'SAAS_PLAN_CHANGE_SCHEDULED',
      entity: 'Subscription',
      entityId: subscription.id,
      severity: 'INFO',
      metadata: {
        planCode,
        planName: subscription.pendingPlan?.name,
        pendingChangeAt: subscription.pendingChangeAt,
      },
    });

    const overview = await getSaasOverview(req.user.accountId);
    return res.json({
      message: 'Mudanca de plano agendada para o fim do ciclo',
      data: {
        subscription: serializeSubscription(subscription),
        overview,
      },
    });
  } catch (err) {
    console.error('Erro ao agendar troca de plano:', err);
    return res.status(err.statusCode || 500).json({
      message: err.message || 'Erro ao agendar troca de plano',
      data: err.data || {},
    });
  }
}

async function cancelScheduledSaasPlanChange(req, res) {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Apenas ADMIN pode cancelar troca de plano', data: {} });
    }

    const subscription = await cancelScheduledPlanChange({
      accountId: req.user.accountId,
    });

    await writeAuditLog({
      req,
      action: 'SAAS_PLAN_CHANGE_SCHEDULE_CANCELLED',
      entity: 'Subscription',
      entityId: subscription.id,
      severity: 'INFO',
      metadata: {
        planCode: subscription.plan?.code,
      },
    });

    const overview = await getSaasOverview(req.user.accountId);
    return res.json({
      message: 'Agendamento de plano cancelado',
      data: {
        subscription: serializeSubscription(subscription),
        overview,
      },
    });
  } catch (err) {
    console.error('Erro ao cancelar troca de plano:', err);
    return res.status(err.statusCode || 500).json({
      message: err.message || 'Erro ao cancelar troca de plano',
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
  cancelScheduledSaasPlanChange,
  getPublicSaasSignupStatus,
  createPublicSaasSignup,
  createSaasPlanPix,
  getSaasPlanPaymentStatus,
  getSaasStatus,
  listPublicSaasPlans,
  listSaasPlanPayments,
  scheduleSaasPlanChange,
  selectSaasPlan,
};
