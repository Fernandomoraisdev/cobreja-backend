const prisma = require('../prisma');
const { writeAuditLog } = require('../services/audit.service');
const {
  buildBackupPayload,
  createBackupSnapshot,
  getBackupSnapshot,
  listBackupSnapshots,
  restoreBackupPayload,
  saveBackupSnapshot,
  serializeSnapshot,
} = require('../services/backup.service');

function numberParam(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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

    const scopedWhere = accountId ? { accountId } : {};
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
      backupSnapshots,
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
      countOrNull('backupSnapshot', accountId ? { accountId } : {}),
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
        autoBackupEnabled: process.env.AUTO_BACKUP_ENABLED !== 'false',
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
        backupSnapshots,
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

  try {
    const snapshot = await createBackupSnapshot({
      accountId,
      kind: 'MANUAL',
      user: req.user,
    });
    const payload = snapshot.payload;

    await writeAuditLog({
      req,
      action: 'OPERATIONS_BACKUP_EXPORTED',
      entity: 'BackupSnapshot',
      entityId: snapshot.id,
      severity: 'WARNING',
      metadata: {
        scope: payload.metadata.scope,
        accountId,
        counts: payload.counts,
        fileName: snapshot.fileName,
      },
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${snapshot.fileName}"`);
    return res.json(payload);
  } catch (err) {
    console.error('Erro ao gerar backup operacional:', err);
    return res.status(500).json({
      error: 'Nao foi possivel gerar o backup operacional.',
    });
  }
}

async function listOperationsBackups(req, res) {
  const accountId = numberParam(req.query.accountId);
  const limit = numberParam(req.query.limit) || 50;

  try {
    const backups = await listBackupSnapshots({ accountId, limit });
    return res.json({ data: backups });
  } catch (err) {
    console.error('Erro ao listar historico de backups:', err);
    return res.status(500).json({ error: 'Nao foi possivel listar os backups.' });
  }
}

async function downloadOperationsBackupSnapshot(req, res) {
  try {
    const snapshot = await getBackupSnapshot(req.params.id);
    if (!snapshot) {
      return res.status(404).json({ error: 'Backup nao encontrado.' });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${snapshot.fileName}"`);
    return res.json(snapshot.payload);
  } catch (err) {
    console.error('Erro ao baixar backup:', err);
    return res.status(500).json({ error: 'Nao foi possivel baixar o backup.' });
  }
}

async function restoreOperationsBackup(req, res) {
  const payload = req.body?.backup && typeof req.body.backup === 'object'
    ? req.body.backup
    : req.body;

  try {
    const safetyPayload = await buildBackupPayload({
      kind: 'PRE_RESTORE',
      generatedByUserId: req.user?.id || null,
      generatedByEmail: req.user?.email || null,
    });
    const safetySnapshot = await saveBackupSnapshot({
      payload: safetyPayload,
      kind: 'PRE_RESTORE',
      user: req.user,
    });

    const restored = await restoreBackupPayload(payload);

    await writeAuditLog({
      req,
      action: 'OPERATIONS_BACKUP_RESTORED',
      entity: 'BackupSnapshot',
      severity: 'WARNING',
      metadata: {
        generatedAt: payload?.metadata?.generatedAt || null,
        safetySnapshotId: safetySnapshot.id,
        restored,
      },
    });

    return res.json({
      ok: true,
      message: 'Backup restaurado com sucesso.',
      safetySnapshot: serializeSnapshot(safetySnapshot),
      counts: restored,
    });
  } catch (err) {
    console.error('Erro ao restaurar backup operacional:', err);
    return res.status(err.statusCode || 500).json({
      error: err.message || 'Nao foi possivel restaurar o backup operacional.',
    });
  }
}

async function restoreOperationsBackupSnapshot(req, res) {
  try {
    const snapshot = await getBackupSnapshot(req.params.id);
    if (!snapshot) {
      return res.status(404).json({ error: 'Backup nao encontrado.' });
    }

    const safetyPayload = await buildBackupPayload({
      kind: 'PRE_RESTORE',
      generatedByUserId: req.user?.id || null,
      generatedByEmail: req.user?.email || null,
    });
    const safetySnapshot = await saveBackupSnapshot({
      payload: safetyPayload,
      kind: 'PRE_RESTORE',
      user: req.user,
    });

    const restored = await restoreBackupPayload(snapshot.payload);

    await prisma.backupSnapshot.update({
      where: { id: snapshot.id },
      data: {
        restoredAt: new Date(),
        restoredByEmail: req.user?.email || null,
      },
    });

    await writeAuditLog({
      req,
      action: 'OPERATIONS_SNAPSHOT_RESTORED',
      entity: 'BackupSnapshot',
      entityId: snapshot.id,
      severity: 'WARNING',
      metadata: {
        fileName: snapshot.fileName,
        safetySnapshotId: safetySnapshot.id,
        restored,
      },
    });

    return res.json({
      ok: true,
      message: 'Backup restaurado com sucesso.',
      restoredSnapshotId: snapshot.id,
      safetySnapshot: serializeSnapshot(safetySnapshot),
      counts: restored,
    });
  } catch (err) {
    console.error('Erro ao restaurar snapshot:', err);
    return res.status(err.statusCode || 500).json({
      error: err.message || 'Nao foi possivel restaurar o backup.',
    });
  }
}

module.exports = {
  getOperationsHealth,
  exportOperationsBackup,
  listOperationsBackups,
  downloadOperationsBackupSnapshot,
  restoreOperationsBackup,
  restoreOperationsBackupSnapshot,
};
