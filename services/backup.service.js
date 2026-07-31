const prisma = require('../prisma');

function parsePositiveInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function backupFileName({ accountId, kind = 'manual', createdAt = new Date() } = {}) {
  const stamp = createdAt.toISOString().replace(/[:.]/g, '-');
  const scope = accountId ? `account-${accountId}` : 'global';
  return `peguei-paguei-backup-${scope}-${String(kind || 'manual').toLowerCase()}-${stamp}.json`;
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

async function buildBackupPayload({
  accountId = null,
  generatedByUserId = null,
  generatedByEmail = null,
  kind = 'MANUAL',
} = {}) {
  const scopedWhere = buildScopedWhere(accountId);
  const accountWhere = accountId ? { id: accountId } : {};
  const nullableAccountWhere = accountId ? { accountId } : {};
  const generatedAt = new Date();

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

  const counts = {
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
  };

  return {
    metadata: {
      product: 'Peguei & Paguei',
      type: 'logical-backup',
      kind,
      generatedAt: generatedAt.toISOString(),
      generatedByUserId,
      generatedByEmail,
      scope: accountId ? 'ACCOUNT' : 'GLOBAL',
      accountId,
      containsPasswords: true,
      containsRawMercadoPagoSecrets: false,
    },
    counts,
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
}

function serializeSnapshot(snapshot, { includePayload = false } = {}) {
  if (!snapshot) return null;
  return {
    id: snapshot.id,
    kind: snapshot.kind,
    status: snapshot.status,
    scope: snapshot.scope,
    fileName: snapshot.fileName,
    counts: snapshot.counts,
    metadata: snapshot.metadata,
    sizeBytes: snapshot.sizeBytes,
    errorMessage: snapshot.errorMessage,
    accountId: snapshot.accountId,
    createdByUserId: snapshot.createdByUserId,
    createdByEmail: snapshot.createdByEmail,
    restoredAt: snapshot.restoredAt,
    restoredByEmail: snapshot.restoredByEmail,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    ...(includePayload ? { payload: snapshot.payload } : {}),
  };
}

async function saveBackupSnapshot({
  payload,
  kind = 'MANUAL',
  accountId = null,
  user = null,
  status = 'COMPLETED',
  errorMessage = null,
} = {}) {
  const createdAt = new Date();
  const fileName = backupFileName({ accountId, kind, createdAt });
  const raw = JSON.stringify(payload || {});
  return prisma.backupSnapshot.create({
    data: {
      kind,
      status,
      scope: accountId ? 'ACCOUNT' : 'GLOBAL',
      fileName,
      payload: payload || {},
      counts: payload?.counts || {},
      metadata: payload?.metadata || {},
      sizeBytes: Buffer.byteLength(raw, 'utf8'),
      errorMessage,
      accountId,
      createdByUserId: user?.id || null,
      createdByEmail: user?.email || null,
      createdAt,
    },
  });
}

async function createBackupSnapshot({ accountId = null, kind = 'MANUAL', user = null } = {}) {
  const payload = await buildBackupPayload({
    accountId,
    kind,
    generatedByUserId: user?.id || null,
    generatedByEmail: user?.email || null,
  });
  return saveBackupSnapshot({ payload, kind, accountId, user });
}

async function listBackupSnapshots({ accountId = null, limit = 50 } = {}) {
  const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = await prisma.backupSnapshot.findMany({
    where: accountId ? { accountId } : {},
    orderBy: { createdAt: 'desc' },
    take,
  });
  return rows.map(serializeSnapshot);
}

async function getBackupSnapshot(snapshotId) {
  const id = parsePositiveInt(snapshotId);
  if (!id) return null;
  return prisma.backupSnapshot.findUnique({ where: { id } });
}

function validateRestorePayload(payload) {
  if (!payload || typeof payload !== 'object' || !payload.tables) {
    const err = new Error('Backup invalido. Envie o JSON gerado pelo backup operacional.');
    err.statusCode = 400;
    throw err;
  }
  if (payload.metadata?.type !== 'logical-backup') {
    const err = new Error('Backup invalido ou incompatível.');
    err.statusCode = 400;
    throw err;
  }
  if (payload.metadata?.scope && payload.metadata.scope !== 'GLOBAL') {
    const err = new Error('Restauracao automatica aceita apenas backup global.');
    err.statusCode = 400;
    throw err;
  }
  const users = tableRows(payload, 'users');
  if (users.some((user) => !user.password)) {
    const err = new Error('Este backup nao contem senhas. Gere um backup novo antes de restaurar.');
    err.statusCode = 400;
    throw err;
  }
}

async function restoreBackupPayload(payload) {
  validateRestorePayload(payload);
  return prisma.$transaction(async (tx) => {
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
    counts.users = await createManyIfAny(tx, 'user', tableRows(payload, 'users'));
    counts.accountSettings = await createManyIfAny(tx, 'accountSettings', tableRows(payload, 'accountSettings'));
    counts.clients = await createManyIfAny(tx, 'client', tableRows(payload, 'clients'));
    counts.subscriptions = await createManyIfAny(tx, 'subscription', tableRows(payload, 'subscriptions'));
    counts.renegotiations = await createManyIfAny(tx, 'renegotiation', tableRows(payload, 'renegotiations'));
    counts.debts = await createManyIfAny(tx, 'debt', tableRows(payload, 'debts'));
    counts.installments = await createManyIfAny(tx, 'installment', tableRows(payload, 'installments'));
    counts.installmentSplits = await createManyIfAny(tx, 'installmentSplit', tableRows(payload, 'installmentSplits'));
    counts.payments = await createManyIfAny(tx, 'payment', tableRows(payload, 'payments'));
    counts.paymentIntents = await createManyIfAny(tx, 'paymentIntent', tableRows(payload, 'paymentIntents'));
    counts.saasPaymentIntents = await createManyIfAny(tx, 'saasPaymentIntent', tableRows(payload, 'saasPaymentIntents'));
    counts.creditRequests = await createManyIfAny(tx, 'creditRequest', tableRows(payload, 'creditRequests'));
    counts.webhookLogs = await createManyIfAny(tx, 'webhookLog', tableRows(payload, 'webhookLogs'));
    counts.supportConversations = await createManyIfAny(tx, 'supportConversation', tableRows(payload, 'supportConversations'));
    counts.supportMessages = await createManyIfAny(tx, 'supportMessage', tableRows(payload, 'supportMessages'));
    counts.auditLogs = await createManyIfAny(tx, 'auditLog', tableRows(payload, 'auditLogs'));

    for (const tableName of [
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
      'BackupSnapshot',
    ]) {
      await resetSequence(tx, tableName);
    }

    return counts;
  }, { timeout: 60000 });
}

async function pruneOldAutomaticBackups({ keep = 30 } = {}) {
  const automaticRows = await prisma.backupSnapshot.findMany({
    where: { kind: 'AUTOMATIC_DAILY' },
    orderBy: { createdAt: 'desc' },
    skip: keep,
    select: { id: true },
  });
  if (!automaticRows.length) return 0;
  const result = await prisma.backupSnapshot.deleteMany({
    where: { id: { in: automaticRows.map((item) => item.id) } },
  });
  return result.count || 0;
}

async function createAutomaticDailyBackupIfNeeded() {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const existing = await prisma.backupSnapshot.findFirst({
    where: {
      kind: 'AUTOMATIC_DAILY',
      scope: 'GLOBAL',
      createdAt: { gte: startOfDay },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return { created: false, snapshot: existing };

  const snapshot = await createBackupSnapshot({ kind: 'AUTOMATIC_DAILY' });
  await pruneOldAutomaticBackups();
  return { created: true, snapshot };
}

function startAutomaticBackupScheduler() {
  if (process.env.AUTO_BACKUP_ENABLED === 'false') return;

  const run = async () => {
    try {
      const result = await createAutomaticDailyBackupIfNeeded();
      if (result.created) {
        console.log(`[backup] Backup automatico diario criado: ${result.snapshot.fileName}`);
      }
    } catch (err) {
      console.error('[backup] Falha no backup automatico diario:', err);
    }
  };

  setTimeout(run, 30000);
  setInterval(run, 60 * 60 * 1000);
}

module.exports = {
  backupFileName,
  buildBackupPayload,
  createBackupSnapshot,
  createAutomaticDailyBackupIfNeeded,
  getBackupSnapshot,
  listBackupSnapshots,
  restoreBackupPayload,
  saveBackupSnapshot,
  serializeSnapshot,
  startAutomaticBackupScheduler,
};
