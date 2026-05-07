const prisma = require('../prisma');

async function listAuditLogs(req, res) {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Apenas ADMIN pode consultar auditoria', data: [] });
  }

  const take = Math.min(Number(req.query.limit || 80), 200);
  const logs = await prisma.auditLog.findMany({
    where: { accountId: req.user.accountId },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
    take,
  });

  return res.json({
    message: 'Logs carregados',
    data: logs,
  });
}

module.exports = { listAuditLogs };
