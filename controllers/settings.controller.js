const prisma = require('../prisma');
const { writeAuditLog } = require('../services/audit.service');
const { readMercadoPagoSettings } = require('../services/mercadopago.service');

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

const DEFAULT_WHATSAPP_TEMPLATES = [
  {
    type: 'DUE_TODAY',
    title: 'Vencimento hoje',
    body: [
      'Ola, {{cliente}}.',
      'Passando para lembrar que sua parcela {{parcela}} vence hoje ({{vencimento}}).',
      'Valor da parcela: {{valor}}.',
      'Se quiser, posso te enviar o Pix para pagamento.',
    ].join('\n\n'),
  },
  {
    type: 'DUE_TOMORROW',
    title: 'Vencimento amanha',
    body: [
      'Ola, {{cliente}}.',
      'Sua parcela {{parcela}} vence amanha ({{vencimento}}).',
      'Valor previsto: {{valor}}.',
      'Se quiser adiantar, posso te enviar o Pix.',
    ].join('\n\n'),
  },
  {
    type: 'OVERDUE',
    title: 'Parcela em atraso',
    body: [
      'Ola, {{cliente}}.',
      'Identificamos que sua parcela {{parcela}} venceu em {{vencimento}} e esta com {{diasAtraso}} dia(s) de atraso.',
      'Valor atualizado da parcela: {{valor}}.',
      'Se ja realizou o pagamento, por favor desconsidere esta mensagem. Caso precise, posso te enviar o Pix para regularizar.',
    ].join('\n\n'),
  },
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
      useAccountCredentials: false,
      sandbox: true,
      accessToken: null,
      publicKey: null,
      webhookSecret: null,
      integrationStatus: process.env.MERCADO_PAGO_ACCESS_TOKEN ? 'CONFIGURED' : 'PENDING',
      webhookStatus: process.env.MERCADO_PAGO_WEBHOOK_SECRET ? 'CONFIGURED' : 'PENDING',
      availableBalance: null,
      fees: [],
      receiptsSummary: null,
    },
    whatsapp: {
      connectionStatus: 'NOT_CONNECTED',
      adminPhone: null,
      qrCode: null,
      templates: DEFAULT_WHATSAPP_TEMPLATES,
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
      support: true,
      pix: true,
      credit: true,
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

function sanitizeMercadoPagoSettings(settings = {}) {
  const credentials = readMercadoPagoSettings(settings);
  const {
    accessToken,
    publicKey,
    webhookSecret,
    ...safeCredentials
  } = credentials;

  return {
    ...settings,
    accessToken: undefined,
    publicKey: undefined,
    webhookSecret: undefined,
    ...safeCredentials,
    hasAccountAccessToken: Boolean(settings.accessToken),
    hasAccountPublicKey: Boolean(settings.publicKey),
    hasAccountWebhookSecret: Boolean(settings.webhookSecret),
    integrationStatus: credentials.accessTokenConfigured ? 'CONFIGURED' : 'PENDING',
    webhookStatus: credentials.webhookSecretConfigured ? 'CONFIGURED' : 'PENDING',
  };
}

function sanitizeSettings(settings) {
  return {
    ...settings,
    mercadoPago: sanitizeMercadoPagoSettings(settings.mercadoPago || {}),
  };
}

function mergeMercadoPagoUpdate(current = {}, incoming = {}) {
  const next = {
    ...current,
    ...incoming,
  };

  for (const key of ['accessToken', 'publicKey', 'webhookSecret']) {
    const clearKey = `clear${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    const value = incoming[key];
    if (incoming[clearKey] === true) {
      next[key] = null;
    } else if (typeof value === 'string' && value.trim()) {
      next[key] = value.trim();
    } else {
      next[key] = current[key] || null;
    }
    delete next[clearKey];
  }

  return next;
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
    data: sanitizeSettings(result.settings),
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
      data[key] = key === 'mercadoPago'
        ? mergeMercadoPagoUpdate(result.settings[key] || {}, req.body[key])
        : {
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
    data: sanitizeSettings(mergeSettings(defaultSettings(result.account), updated)),
  });
}

module.exports = {
  getSettings,
  updateSettings,
};
