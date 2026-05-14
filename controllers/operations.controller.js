const prisma = require('../prisma');
const { writeAuditLog } = require('../services/audit.service');

function numberParam(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function backupFileName(accountId) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const scope = accountId ? `account-${accountId}` : 'global';
  return `peguei-paguei-backup-${scope}-${stamp}.json`;
}

function sanitizeUser(user) {
  if (!user) return user;
  const { password, ...safeUser } = user;
  return safeUser;
}

function maskSecret(value) {
  if (!value) return null;
  const text = String(value);
  if (text.length <= 8) return '********';
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function sanitizeMercadoPagoConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config || {};
  return {
    ...config,
    accessToken: maskSecret(config.accessToken),
    publicKey: maskSecret(config.publicKey),
    webhookSecret: maskSecret(config.webhookSecret),
    hasAccessToken: Boolean(config.accessToken),
    hasPublicKey: Boolean(config.publicKey),
    hasWebhookSecret: Boolean(config.webhookSecret),
  };
}

function redactSensitiveJson(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveJson);
  if (!value || typeof value !== 'object') return value;

  return Object.entries(value).reduce((safe, [key, item]) => {
    const normalizedKey = key.toLowerCase();
    const shouldRedact = [
      'password',
      'senha',
      'token',
      'secret',
      'apikey',
      'api_key',
      'privatekey',
      'private_key',
    ].some((sensitive) => normalizedKey.includes(sensitive));

    safe[key] = shouldRedact ? maskSecret(item) : redactSensitiveJson(item);
    return safe;
  }, {});
}

function sanitizeAccountSettings(settings) {
  if (!settings) return settings;
  return {
    ...settings,
    company: redactSensitiveJson(settings.company),
    admin: redactSensitiveJson(settings.admin),
    finance: redactSensitiveJson(settings.finance),
    mercadoPago: sanitizeMercadoPagoConfig(settings.mercadoPago),
    whatsapp: redactSensitiveJson(settings.whatsapp),
    saas: redactSensitiveJson(settings.saas),
    appearance: redactSensitiveJson(settings.appearance),
    notifications: redactSensitiveJson(settings.notifications),
    security: redactSensitiveJson(settings.security),
    automation: redactSensitiveJson(settings.automation),
  };
}

function buildScopedWhere(accountId) {
  return accountId ? { accountId } : {};
}

async function countOrNull(modelName, where = {}) {
  try {
    return await prisma[modelName].count({ where });
  } catch (err) {
    return null;
  }
}

async function getOperationsHealth(req, res) {
  const accountId = numberParam(req.query.accountId);

  try {
    await prisma.$queryRaw`SELECT 1`;

    const scopedWhere = buildScopedWhere(accountId);
    const [
      accounts,
      users,
      clients,
      debts,
      payments,
      paymentIntents,
      subscriptions,
      supportConversations,
      webhookLogs,
    ] = await Promise.all([
      countOrNull('account', accountId ? { id: accountId } : {}),
      countOrNull('user', scopedWhere),
      countOrNull('client', scopedWhere),
      countOrNull('debt', scopedWhere),
      countOrNull('payment', scopedWhere),
      countOrNull('paymentIntent', scopedWhere),
      countOrNull('subscription', scopedWhere),
      countOrNull('supportConversation', scopedWhere),
      countOrNull('webhookLog', accountId ? { accountId } : {}),
    ]);

    return res.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      scope: accountId ? 'ACCOUNT' : 'GLOBAL',
      accountId,
      database: {
        connected: true,
        provider: 'postgresql',
      },
      environment: {
        nodeEnv: process.env.NODE_ENV || null,
        railwayEnvironment: process.env.RAILWAY_ENVIRONMENT || null,
        hasDatabaseUrl: Boolean(process.env.DATABASE_URL),
        hasJwtSecret: Boolean(process.env.JWT_SECRET),
        hasBackendPublicUrl: Boolean(process.env.BACKEND_PUBLIC_URL),
        hasMercadoPagoAccessToken: Boolean(process.env.MERCADO_PAGO_ACCESS_TOKEN),
        hasMercadoPagoWebhookSecret: Boolean(process.env.MERCADO_PAGO_WEBHOOK_SECRET),
      },
      counts: {
        accounts,
        users,
        clients,
        debts,
        payments,
        paymentIntents,
        subscriptions,
        supportConversations,
        webhookLogs,
      },
    });
  } catch (err) {
    console.error('Erro no health check operacional:', err);
    return res.status(500).json({
      ok: false,
      generatedAt: new Date().toISOString(),
      message: 'Nao foi possivel validar a saude operacional do sistema.',
    });
  }
}

async function exportOperationsBackup(req, res) {
  const accountId = numberParam(req.query.accountId);
  const scopedWhere = buildScopedWhere(accountId);
  const accountWhere = accountId ? { id: accountId } : {};
  const nullableAccountWhere = accountId ? { accountId } : {};

  try {
    const [
      accounts,
      accountSettings,
      plans,
      subscriptions,
      saasPaymentIntents,
      users,
      clients,
      debts,
      renegotiations,
      installments,
      creditRequests,
      payments,
      paymentIntents,
      webhookLogs,
      supportConversations,
      supportMessages,
      auditLogs,
    ] = await Promise.all([
      prisma.account.findMany({ where: accountWhere, orderBy: { id: 'asc' } }),
      prisma.accountSettings.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
      prisma.subscription.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.saasPaymentIntent.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.user.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.client.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.debt.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.renegotiation.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.installment.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.creditRequest.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.payment.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.paymentIntent.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.webhookLog.findMany({ where: nullableAccountWhere, orderBy: { id: 'asc' } }),
      prisma.supportConversation.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.supportMessage.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
      prisma.auditLog.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
    ]);

    const payload = {
      metadata: {
        product: 'Peguei & Paguei',
        type: 'logical-backup',
        generatedAt: new Date().toISOString(),
        generatedByUserId: req.user?.id || null,
        generatedByEmail: req.user?.email || null,
        scope: accountId ? 'ACCOUNT' : 'GLOBAL',
        accountId,
        containsPasswords: false,
        containsRawMercadoPagoSecrets: false,
      },
      counts: {
        accounts: accounts.length,
        accountSettings: accountSettings.length,
        plans: plans.length,
        subscriptions: subscriptions.length,
        saasPaymentIntents: saasPaymentIntents.length,
        users: users.length,
        clients: clients.length,
        debts: debts.length,
        renegotiations: renegotiations.length,
        installments: installments.length,
        creditRequests: creditRequests.length,
        payments: payments.length,
        paymentIntents: paymentIntents.length,
        webhookLogs: webhookLogs.length,
        supportConversations: supportConversations.length,
        supportMessages: supportMessages.length,
        auditLogs: auditLogs.length,
      },
      tables: {
        accounts,
        accountSettings: accountSettings.map(sanitizeAccountSettings),
        plans,
        subscriptions,
        saasPaymentIntents,
        users: users.map(sanitizeUser),
        clients,
        debts,
        renegotiations,
        installments,
        creditRequests,
        payments,
        paymentIntents,
        webhookLogs,
        supportConversations,
        supportMessages,
        auditLogs,
      },
    };

    await writeAuditLog({
      req,
      action: 'OPERATIONS_BACKUP_EXPORTED',
      entity: 'OperationsBackup',
      severity: 'WARNING',
      metadata: {
        scope: payload.metadata.scope,
        accountId,
        counts: payload.counts,
      },
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFileName(accountId)}"`);
    return res.json(payload);
  } catch (err) {
    console.error('Erro ao gerar backup operacional:', err);
    return res.status(500).json({
      error: 'Nao foi possivel gerar o backup operacional.',
    });
  }
}

module.exports = {
  getOperationsHealth,
  exportOperationsBackup,
};
