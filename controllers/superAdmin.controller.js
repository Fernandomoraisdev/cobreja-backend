const prisma = require('../prisma');
const { changeAccountPlan, serializeSubscription } = require('../services/saas.service');
const { writeAuditLog } = require('../services/audit.service');
const { signAuthToken } = require('../utils/auth');

function serializeAccount(account) {
  const settings = account.settings || {};
  const saas = settings.saas || {};
  const subscription = account.subscriptions?.[0] || null;
  const admin = account.users?.[0] || null;

  return {
    id: account.id,
    name: account.name,
    inviteCode: account.inviteCode,
    status: saas.accountStatus || 'ACTIVE',
    suspensionReason: saas.suspensionReason || null,
    suspendedAt: saas.suspendedAt || null,
    admin: admin
      ? {
          id: admin.id,
          name: admin.name,
          email: admin.email,
          phone: admin.phone,
        }
      : null,
    counts: {
      users: account._count?.users || 0,
      clients: account._count?.clients || 0,
      debts: account._count?.debts || 0,
      payments: account._count?.payments || 0,
      supportConversations: account._count?.supportConversations || 0,
    },
    subscription: serializeSubscription(subscription),
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

async function getSuperAdminOverview(req, res) {
  const [
    accounts,
    users,
    clients,
    activeSubscriptions,
    suspendedSettings,
    paymentStats,
    supportOpen,
  ] = await Promise.all([
    prisma.account.count(),
    prisma.user.count(),
    prisma.client.count({ where: { status: 'ACTIVE', deletedAt: null } }),
    prisma.subscription.count({ where: { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } } }),
    prisma.accountSettings.count({
      where: {
        saas: {
          path: ['accountStatus'],
          equals: 'SUSPENDED',
        },
      },
    }),
    prisma.payment.aggregate({
      _sum: { amount: true },
      _count: { id: true },
    }),
    prisma.supportConversation.count({ where: { status: { in: ['OPEN', 'PENDING'] } } }),
  ]);

  return res.json({
    message: 'Painel SUPER ADMIN carregado',
    data: {
      totals: {
        accounts,
        users,
        clients,
        activeSubscriptions,
        suspendedAccounts: suspendedSettings,
        supportOpen,
        paymentsCount: paymentStats._count.id,
        paymentsAmount: paymentStats._sum.amount || 0,
      },
    },
  });
}

async function listSuperAdminAccounts(req, res) {
  const accounts = await prisma.account.findMany({
    include: {
      settings: true,
      users: {
        where: { role: 'ADMIN' },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
      subscriptions: {
        include: { plan: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      _count: {
        select: {
          users: true,
          clients: true,
          debts: true,
          payments: true,
          supportConversations: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  return res.json({
    message: 'Empresas carregadas',
    data: accounts.map(serializeAccount),
  });
}

async function updateAccountStatus(req, res) {
  const accountId = Number(req.params.accountId);
  const status = String(req.body.status || '').trim().toUpperCase();
  const reason = String(req.body.reason || '').trim();

  if (!accountId || !['ACTIVE', 'SUSPENDED'].includes(status)) {
    return res.status(400).json({ message: 'Status ou conta invalida', data: {} });
  }

  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { settings: true },
  });
  if (!account) return res.status(404).json({ message: 'Empresa nao encontrada', data: {} });

  const currentSaas = account.settings?.saas || {};
  const nextSaas = {
    ...currentSaas,
    accountStatus: status,
    suspensionReason: status === 'SUSPENDED' ? reason : null,
    suspendedAt: status === 'SUSPENDED' ? new Date().toISOString() : null,
  };

  await prisma.accountSettings.upsert({
    where: { accountId },
    update: { saas: nextSaas },
    create: { accountId, saas: nextSaas },
  });

  await writeAuditLog({
    req,
    action: status === 'SUSPENDED' ? 'SUPER_ADMIN_ACCOUNT_SUSPENDED' : 'SUPER_ADMIN_ACCOUNT_RELEASED',
    entity: 'Account',
    entityId: accountId,
    severity: 'WARNING',
    metadata: { status, reason },
  });

  return res.json({
    message: status === 'SUSPENDED' ? 'Empresa suspensa' : 'Empresa liberada',
    data: { accountId, status, reason: status === 'SUSPENDED' ? reason : null },
  });
}

async function changeSuperAdminAccountPlan(req, res) {
  const accountId = Number(req.params.accountId);
  const planCode = String(req.body.planCode || '').trim().toUpperCase();
  if (!accountId || !planCode) {
    return res.status(400).json({ message: 'Conta e plano sao obrigatorios', data: {} });
  }

  const subscription = await changeAccountPlan({ accountId, planCode, status: 'ACTIVE' });

  await writeAuditLog({
    req,
    action: 'SUPER_ADMIN_PLAN_CHANGED',
    entity: 'Subscription',
    entityId: subscription.id,
    metadata: { accountId, planCode, planName: subscription.plan?.name },
  });

  return res.json({
    message: 'Plano alterado pelo SUPER ADMIN',
    data: serializeSubscription(subscription),
  });
}

async function impersonateAccountAdmin(req, res) {
  const accountId = Number(req.params.accountId);
  if (!accountId) return res.status(400).json({ message: 'Conta invalida', data: {} });

  const admin = await prisma.user.findFirst({
    where: { accountId, role: 'ADMIN' },
    orderBy: { createdAt: 'asc' },
    include: { account: true },
  });

  if (!admin) return res.status(404).json({ message: 'Admin da empresa nao encontrado', data: {} });

  const token = signAuthToken({
    ...admin,
    impersonatedBySuperAdmin: true,
    originalSuperAdminUserId: req.user.id,
  });

  await writeAuditLog({
    req,
    action: 'SUPER_ADMIN_IMPERSONATION_STARTED',
    entity: 'User',
    entityId: admin.id,
    severity: 'WARNING',
    metadata: { accountId, adminEmail: admin.email },
  });

  return res.json({
    message: 'Token de impersonacao gerado',
    data: {
      token,
      user: {
        id: admin.id,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        accountId: admin.accountId,
      },
      account: admin.account,
    },
  });
}

module.exports = {
  getSuperAdminOverview,
  listSuperAdminAccounts,
  updateAccountStatus,
  changeSuperAdminAccountPlan,
  impersonateAccountAdmin,
};
