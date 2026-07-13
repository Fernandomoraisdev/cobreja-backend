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

function tableRows(payload, name) {
  const rows = payload?.tables?.[name];
  return Array.isArray(rows) ? rows : [];
}

async function createManyIfAny(tx, modelName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const result = await tx[modelName].createMany({ data: rows });
  return result.count || 0;
}

async function resetSequence(tx, tableName, columnName = 'id') {
  await tx.$executeRawUnsafe(`
    SELECT setval(
      pg_get_serial_sequence('"${tableName}"', '${columnName}'),
      COALESCE((SELECT MAX("${columnName}") FROM "${tableName}"), 1),
      (SELECT COUNT(*) > 0 FROM "${tableName}")
    )
  `);
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
      installmentSplits,
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
      prisma.installmentSplit.findMany({ where: scopedWhere, orderBy: { id: 'asc' } }),
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
        containsPasswords: true,
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
        installmentSplits: installmentSplits.length,
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
        users,
        clients,
        debts,
        renegotiations,
        installments,
        installmentSplits,
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

async function restoreOperationsBackup(req, res) {
  const payload = req.body?.backup && typeof req.body.backup === 'object'
    ? req.body.backup
    : req.body;

  if (!payload || typeof payload !== 'object' || !payload.tables) {
    return res.status(400).json({
      error: 'Backup invalido. Envie o JSON gerado pelo backup operacional.',
    });
  }

  if (payload.metadata?.type !== 'logical-backup') {
    return res.status(400).json({
      error: 'Backup invalido ou incompatível.',
    });
  }

  if (payload.metadata?.scope && payload.metadata.scope !== 'GLOBAL') {
    return res.status(400).json({
      error: 'Restauracao automatica aceita apenas backup global.',
    });
  }

  const users = tableRows(payload, 'users');
  if (users.some((user) => !user.password)) {
    return res.status(400).json({
      error: 'Este backup nao contem senhas. Gere um backup novo antes de restaurar.',
    });
  }

  try {
    const restored = await prisma.$transaction(async (tx) => {
      await tx.paymentIntent.deleteMany({});
      await tx.payment.deleteMany({});
      await tx.installmentSplit.deleteMany({});
      await tx.installment.deleteMany({});
      await tx.debt.deleteMany({});
      await tx.renegotiation.deleteMany({});
      await tx.creditRequest.deleteMany({});
      await tx.supportMessage.deleteMany({});
      await tx.supportConversation.deleteMany({});
      await tx.auditLog.deleteMany({});
      await tx.webhookLog.deleteMany({});
      await tx.saasPaymentIntent.deleteMany({});
      await tx.subscription.deleteMany({});
      await tx.accountSettings.deleteMany({});
      await tx.client.deleteMany({});
      await tx.user.deleteMany({});
      await tx.account.deleteMany({});
      await tx.plan.deleteMany({});

      const counts = {};
      counts.plans = await createManyIfAny(tx, 'plan', tableRows(payload, 'plans'));
      counts.accounts = await createManyIfAny(tx, 'account', tableRows(payload, 'accounts'));
      counts.users = await createManyIfAny(tx, 'user', users);
      counts.accountSettings = await createManyIfAny(
        tx,
        'accountSettings',
        tableRows(payload, 'accountSettings'),
      );
      counts.clients = await createManyIfAny(tx, 'client', tableRows(payload, 'clients'));
      counts.subscriptions = await createManyIfAny(
        tx,
        'subscription',
        tableRows(payload, 'subscriptions'),
      );
      counts.renegotiations = await createManyIfAny(
        tx,
        'renegotiation',
        tableRows(payload, 'renegotiations'),
      );
      counts.debts = await createManyIfAny(tx, 'debt', tableRows(payload, 'debts'));
      counts.installments = await createManyIfAny(
        tx,
        'installment',
        tableRows(payload, 'installments'),
      );
      counts.installmentSplits = await createManyIfAny(
        tx,
        'installmentSplit',
        tableRows(payload, 'installmentSplits'),
      );
      counts.payments = await createManyIfAny(tx, 'payment', tableRows(payload, 'payments'));
      counts.paymentIntents = await createManyIfAny(
        tx,
        'paymentIntent',
        tableRows(payload, 'paymentIntents'),
      );
      counts.saasPaymentIntents = await createManyIfAny(
        tx,
        'saasPaymentIntent',
        tableRows(payload, 'saasPaymentIntents'),
      );
      counts.creditRequests = await createManyIfAny(
        tx,
        'creditRequest',
        tableRows(payload, 'creditRequests'),
      );
      counts.webhookLogs = await createManyIfAny(
        tx,
        'webhookLog',
        tableRows(payload, 'webhookLogs'),
      );
      counts.supportConversations = await createManyIfAny(
        tx,
        'supportConversation',
        tableRows(payload, 'supportConversations'),
      );
      counts.supportMessages = await createManyIfAny(
        tx,
        'supportMessage',
        tableRows(payload, 'supportMessages'),
      );
      counts.auditLogs = await createManyIfAny(tx, 'auditLog', tableRows(payload, 'auditLogs'));

      const tableNames = [
        'Plan',
        'Account',
        'User',
        'AccountSettings',
        'Subscription',
        'SaasPaymentIntent',
        'AuditLog',
        'SupportConversation',
        'SupportMessage',
        'Client',
        'Debt',
        'Renegotiation',
        'Installment',
        'InstallmentSplit',
        'CreditRequest',
        'Payment',
        'PaymentIntent',
        'WebhookLog',
      ];
      for (const tableName of tableNames) {
        await resetSequence(tx, tableName);
      }

      return counts;
    }, { timeout: 60000 });

    await writeAuditLog({
      req,
      action: 'OPERATIONS_BACKUP_RESTORED',
      entity: 'OperationsBackup',
      severity: 'WARNING',
      metadata: {
        generatedAt: payload.metadata?.generatedAt || null,
        restored,
      },
    });

    return res.json({
      ok: true,
      message: 'Backup restaurado com sucesso.',
      counts: restored,
    });
  } catch (err) {
    console.error('Erro ao restaurar backup operacional:', err);
    return res.status(500).json({
      error: 'Nao foi possivel restaurar o backup operacional.',
    });
  }
}

module.exports = {
  getOperationsHealth,
  exportOperationsBackup,
  restoreOperationsBackup,
};
