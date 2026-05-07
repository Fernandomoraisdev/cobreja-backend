const prisma = require('../prisma');
const { writeAuditLog } = require('../services/audit.service');

const SETTINGS_KEYS = [
  'company',
  'admin',
  'finance',
  'mercadoPago',
  'whatsapp',
  'saas',
  'appearance',
  'notifications',
  'security',
  'automation',
];

function defaultSettings(account) {
  return {
    company: {
      name: account?.name || 'COBREJA',
      logoUrl: null,
      faviconUrl: null,
      cnpj: null,
      phone: null,
      email: null,
      address: null,
      customDomain: null,
    },
    admin: {
      activeSessions: [],
      twoFactorEnabled: false,
    },
    finance: {
      monthlyInterest: 0,
      dailyInterest: 0,
      lateFine: 0,
      lateFee: 0,
      maxInstallments: 12,
      anticipationEnabled: false,
      graceDays: 0,
      renegotiationRules: '',
    },
    mercadoPago: {
      integrationStatus: process.env.MERCADO_PAGO_ACCESS_TOKEN ? 'CONFIGURED' : 'PENDING',
      webhookStatus: process.env.MERCADO_PAGO_WEBHOOK_SECRET ? 'CONFIGURED' : 'PENDING',
      availableBalance: null,
      fees: [],
      receiptsSummary: null,
    },
    whatsapp: {
      connectionStatus: 'NOT_CONNECTED',
      qrCode: null,
      templates: [],
      billingAutomationEnabled: false,
    },
    saas: {
      currentPlan: 'TRIAL',
      trial: true,
      subscriptionEndsAt: null,
      clientLimit: null,
      upgradeUrl: null,
    },
    appearance: {
      theme: 'dark',
      accentColor: 'cobreja',
      compactLayout: false,
    },
    notifications: {
      email: true,
      whatsapp: true,
      push: false,
      billing: true,
    },
    security: {
      requireDoubleConfirmation: true,
      sensitiveRoutesProtected: true,
    },
    automation: {
      dueTomorrow: false,
      overdueBilling: false,
      paymentConfirmation: false,
      installmentReminder: false,
    },
  };
}

function mergeSettings(base, saved) {
  const merged = { ...base };
  for (const key of SETTINGS_KEYS) {
    merged[key] = {
      ...(base[key] || {}),
      ...((saved && saved[key]) || {}),
    };
  }
  return merged;
}

async function ensureAccountSettings(accountId) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: { settings: true },
  });

  if (!account) return null;
  if (account.settings) {
    return {
      account,
      settings: mergeSettings(defaultSettings(account), account.settings),
      settingsRow: account.settings,
    };
  }

  const defaults = defaultSettings(account);
  const settingsRow = await prisma.accountSettings.create({
    data: {
      accountId,
      ...defaults,
    },
  });

  return { account, settings: defaults, settingsRow };
}

async function getSettings(req, res) {
  const accountId = Number(req.user.accountId);
  const result = await ensureAccountSettings(accountId);
  if (!result) {
    return res.status(404).json({ message: 'Conta nao encontrada', data: {} });
  }

  return res.json({
    message: 'Configuracoes carregadas',
    data: result.settings,
  });
}

async function updateSettings(req, res) {
  if (req.user.role !== 'ADMIN') {
    return res.status(403).json({ message: 'Apenas ADMIN pode alterar configuracoes', data: {} });
  }

  const accountId = Number(req.user.accountId);
  const result = await ensureAccountSettings(accountId);
  if (!result) {
    return res.status(404).json({ message: 'Conta nao encontrada', data: {} });
  }

  const data = {};
  for (const key of SETTINGS_KEYS) {
    if (req.body[key] && typeof req.body[key] === 'object' && !Array.isArray(req.body[key])) {
      data[key] = {
        ...(result.settings[key] || {}),
        ...req.body[key],
      };
    }
  }

  const updated = await prisma.accountSettings.update({
    where: { accountId },
    data,
  });

  await writeAuditLog({
    req,
    action: 'SETTINGS_UPDATED',
    entity: 'AccountSettings',
    entityId: updated.id,
    metadata: { sections: Object.keys(data) },
  });

  return res.json({
    message: 'Configuracoes atualizadas',
    data: mergeSettings(defaultSettings(result.account), updated),
  });
}

module.exports = {
  getSettings,
  updateSettings,
};
