const crypto = require('crypto');
const prisma = require('../prisma');

const MERCADO_PAGO_API_BASE = 'https://api.mercadopago.com';

function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (text.length <= 10) return `${text.slice(0, 2)}...${text.slice(-2)}`;
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function requiredAccessToken(accessToken) {
  const token = accessToken || process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!token) {
    throw new Error('MERCADO_PAGO_ACCESS_TOKEN nao configurado');
  }
  return token;
}

function buildNotificationUrl() {
  const baseUrl = String(process.env.BACKEND_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!baseUrl) return undefined;
  return `${baseUrl}/api/payments/mercadopago/webhook`;
}

function normalizeHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value);
  }
  return result;
}

function parseSignatureHeader(value) {
  const parsed = {};
  String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      const [key, ...rest] = item.split('=');
      parsed[key] = rest.join('=');
    });
  return parsed;
}

function readMercadoPagoSettings(settings = {}) {
  const accountAccessToken =
    settings.useAccountCredentials === true ? String(settings.accessToken || '').trim() : '';
  const accountPublicKey =
    settings.useAccountCredentials === true ? String(settings.publicKey || '').trim() : '';
  const accountWebhookSecret =
    settings.useAccountCredentials === true ? String(settings.webhookSecret || '').trim() : '';
  const accessToken = accountAccessToken || String(process.env.MERCADO_PAGO_ACCESS_TOKEN || '').trim();
  const publicKey = accountPublicKey || String(process.env.MERCADO_PAGO_PUBLIC_KEY || '').trim();
  const webhookSecret =
    accountWebhookSecret || String(process.env.MERCADO_PAGO_WEBHOOK_SECRET || '').trim();

  return {
    accessToken,
    publicKey,
    webhookSecret,
    useAccountCredentials: settings.useAccountCredentials === true,
    sandbox: settings.sandbox !== false,
    credentialSource: accountAccessToken ? 'ACCOUNT' : accessToken ? 'ENV' : 'NONE',
    webhookSecretSource: accountWebhookSecret ? 'ACCOUNT' : webhookSecret ? 'ENV' : 'NONE',
    accessTokenConfigured: Boolean(accessToken),
    publicKeyConfigured: Boolean(publicKey),
    webhookSecretConfigured: Boolean(webhookSecret),
    backendPublicUrlConfigured: Boolean(process.env.BACKEND_PUBLIC_URL),
    maskedAccessToken: maskSecret(accessToken),
    maskedPublicKey: maskSecret(publicKey),
    maskedWebhookSecret: maskSecret(webhookSecret),
  };
}

async function getMercadoPagoCredentialsForAccount(accountId) {
  if (!accountId) return readMercadoPagoSettings();
  const row = await prisma.accountSettings.findUnique({
    where: { accountId: Number(accountId) },
    select: { mercadoPago: true },
  });
  return readMercadoPagoSettings(row?.mercadoPago || {});
}

function validateWebhookSignature({ headers, query, payload, secret }) {
  const webhookSecret = secret || process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return { valid: false, reason: 'MERCADO_PAGO_WEBHOOK_SECRET nao configurado' };
  }

  const normalizedHeaders = normalizeHeaders(headers);
  const signature = parseSignatureHeader(normalizedHeaders['x-signature']);
  const requestId = normalizedHeaders['x-request-id'];
  const ts = signature.ts;
  const v1 = signature.v1;
  const dataId =
    query?.['data.id'] ||
    query?.id ||
    payload?.data?.id ||
    payload?.id ||
    payload?.resource;

  if (!requestId || !ts || !v1 || !dataId) {
    return { valid: false, reason: 'Assinatura incompleta', dataId };
  }

  const signedTemplate = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(signedTemplate)
    .digest('hex');

  const valid =
    expected.length === v1.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));

  return {
    valid,
    reason: valid ? null : 'Assinatura invalida',
    dataId: String(dataId),
    requestId,
    ts,
  };
}

async function mercadoPagoRequest(path, { method = 'GET', body, idempotencyKey, accessToken } = {}) {
  const headers = {
    Authorization: `Bearer ${requiredAccessToken(accessToken)}`,
    'Content-Type': 'application/json',
  };

  if (idempotencyKey) {
    headers['X-Idempotency-Key'] = idempotencyKey;
  }

  const response = await fetch(`${MERCADO_PAGO_API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.message || data?.error || 'Erro na API Mercado Pago';
    const error = new Error(message);
    error.statusCode = response.status;
    error.response = data;
    throw error;
  }

  return data;
}

async function createPixPayment({
  amount,
  description,
  payer,
  externalReference,
  idempotencyKey,
  accessToken,
}) {
  const body = {
    transaction_amount: amount,
    description,
    payment_method_id: 'pix',
    external_reference: externalReference,
    payer: {
      email: payer.email,
      first_name: payer.firstName,
      last_name: payer.lastName,
      ...(payer.cpf
        ? {
            identification: {
              type: 'CPF',
              number: payer.cpf,
            },
          }
        : {}),
    },
  };

  const notificationUrl = buildNotificationUrl();
  if (notificationUrl) {
    body.notification_url = notificationUrl;
  }

  return mercadoPagoRequest('/v1/payments', {
    method: 'POST',
    body,
    idempotencyKey,
    accessToken,
  });
}

async function createCheckoutPreference({
  amount,
  description,
  payer,
  externalReference,
  accessToken,
}) {
  const body = {
    items: [
      {
        title: description,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: amount,
      },
    ],
    payer: {
      email: payer.email,
      name: [payer.firstName, payer.lastName].filter(Boolean).join(' ').trim(),
      ...(payer.cpf
        ? {
            identification: {
              type: 'CPF',
              number: payer.cpf,
            },
          }
        : {}),
    },
    external_reference: externalReference,
    statement_descriptor: 'PEGUEI PAGUEI',
  };

  const notificationUrl = buildNotificationUrl();
  if (notificationUrl) {
    body.notification_url = notificationUrl;
  }

  return mercadoPagoRequest('/checkout/preferences', {
    method: 'POST',
    body,
    accessToken,
  });
}

async function getPayment(paymentId, { accessToken } = {}) {
  return mercadoPagoRequest(`/v1/payments/${encodeURIComponent(paymentId)}`, { accessToken });
}

async function searchPayments(query = {}, { accessToken } = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return mercadoPagoRequest(`/v1/payments/search${suffix}`, { accessToken });
}

function mapPaymentStatus(status) {
  switch (String(status || '').toLowerCase()) {
    case 'approved':
      return 'APPROVED';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    case 'rejected':
      return 'REJECTED';
    case 'refunded':
      return 'REFUNDED';
    case 'pending':
    case 'in_process':
      return 'PENDING';
    default:
      return String(status || 'UNKNOWN').toUpperCase();
  }
}

module.exports = {
  createCheckoutPreference,
  createPixPayment,
  getMercadoPagoCredentialsForAccount,
  getPayment,
  searchPayments,
  mapPaymentStatus,
  maskSecret,
  readMercadoPagoSettings,
  validateWebhookSignature,
};
