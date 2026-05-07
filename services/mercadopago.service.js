const crypto = require('crypto');

const MERCADO_PAGO_API_BASE = 'https://api.mercadopago.com';

function requiredAccessToken() {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;
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

function validateWebhookSignature({ headers, query, payload }) {
  const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  if (!secret) {
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
    .createHmac('sha256', secret)
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

async function mercadoPagoRequest(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = {
    Authorization: `Bearer ${requiredAccessToken()}`,
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
  });
}

async function getPayment(paymentId) {
  return mercadoPagoRequest(`/v1/payments/${encodeURIComponent(paymentId)}`);
}

async function searchPayments(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      params.set(key, String(value));
    }
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return mercadoPagoRequest(`/v1/payments/search${suffix}`);
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
  createPixPayment,
  getPayment,
  searchPayments,
  mapPaymentStatus,
  validateWebhookSignature,
};
