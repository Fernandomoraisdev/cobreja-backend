const prisma = require('../prisma');

async function writeAuditLog({
  req,
  action,
  entity,
  entityId,
  severity = 'INFO',
  metadata = {},
}) {
  const accountId = Number(req?.user?.accountId);
  if (!accountId || !action) return null;

  try {
    return await prisma.auditLog.create({
      data: {
        action,
        entity: entity || null,
        entityId: entityId != null ? String(entityId) : null,
        severity,
        metadata,
        ip: req.ip || null,
        userAgent: req.headers?.['user-agent'] || null,
        accountId,
        userId: req.user?.id || null,
      },
    });
  } catch (err) {
    console.error('Erro ao gravar auditoria:', err);
    return null;
  }
}

module.exports = { writeAuditLog };
