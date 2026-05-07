const bcrypt = require('bcrypt');
const prisma = require('../prisma');
const { writeAuditLog } = require('../services/audit.service');

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    cpf: user.cpf,
    phone: user.phone,
    role: user.role,
    accountId: user.accountId,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function getJwtStatus() {
  const hasCustomSecret = Boolean(process.env.JWT_SECRET);
  return {
    configured: hasCustomSecret,
    expiresIn: '7d',
    warning: hasCustomSecret
      ? null
      : 'JWT_SECRET nao configurado no ambiente. Configure uma chave forte em producao.',
  };
}

async function getSecurityOverview(req, res) {
  try {
    const accountId = req.user.accountId;
    const [user, admins, clientsWithLogin, recentAccessLogs, criticalLogs] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          name: true,
          email: true,
          cpf: true,
          phone: true,
          role: true,
          accountId: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.user.findMany({
        where: { accountId, role: 'ADMIN' },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.client.count({
        where: {
          accountId,
          userId: { not: null },
          status: 'ACTIVE',
          deletedAt: null,
        },
      }),
      prisma.auditLog.findMany({
        where: {
          accountId,
          action: { in: ['LOGIN_SUCCESS', 'PASSWORD_CHANGED'] },
        },
        include: {
          user: {
            select: { id: true, name: true, email: true, role: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      prisma.auditLog.findMany({
        where: {
          accountId,
          action: {
            in: [
              'SAAS_PLAN_CHANGED',
              'PASSWORD_CHANGED',
              'COLLECTION_GENERATED',
              'PAYMENT_DELETED',
              'CLIENT_PERMANENTLY_DELETED',
            ],
          },
        },
        include: {
          user: {
            select: { id: true, name: true, email: true, role: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    return res.json({
      message: 'Seguranca carregada com sucesso',
      data: {
        currentUser: sanitizeUser(user),
        jwt: getJwtStatus(),
        roles: {
          currentRole: req.user.role,
          isAdmin: req.user.role === 'ADMIN',
          isClient: req.user.role === 'CLIENT',
        },
        accountIsolation: {
          accountId,
          enabled: Boolean(accountId),
          rule: 'Todas as consultas administrativas usam accountId da sessao.',
        },
        admins: admins.map(sanitizeUser),
        clientsWithLogin,
        recentAccessLogs,
        criticalLogs,
      },
    });
  } catch (err) {
    console.error('Erro ao carregar seguranca:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao carregar seguranca',
      data: {},
    });
  }
}

async function changePassword(req, res) {
  try {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        message: 'Senha atual e nova senha sao obrigatorias',
        data: {},
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        message: 'A nova senha precisa ter pelo menos 8 caracteres',
        data: {},
      });
    }

    const user = await prisma.user.findFirst({
      where: {
        id: req.user.id,
        accountId: req.user.accountId,
      },
    });

    if (!user) {
      return res.status(404).json({ message: 'Usuario nao encontrado', data: {} });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      await writeAuditLog({
        req,
        action: 'PASSWORD_CHANGE_REJECTED',
        entity: 'User',
        entityId: user.id,
        severity: 'WARNING',
        metadata: { reason: 'CURRENT_PASSWORD_MISMATCH' },
      });
      return res.status(401).json({ message: 'Senha atual invalida', data: {} });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
    });

    await writeAuditLog({
      req,
      action: 'PASSWORD_CHANGED',
      entity: 'User',
      entityId: user.id,
      severity: 'WARNING',
      metadata: { role: user.role },
    });

    return res.json({
      message: 'Senha alterada com sucesso',
      data: {},
    });
  } catch (err) {
    console.error('Erro ao alterar senha:', err);
    return res.status(500).json({
      message: err.message || 'Erro ao alterar senha',
      data: {},
    });
  }
}

module.exports = {
  changePassword,
  getSecurityOverview,
};
