'use strict';

const { createHash } = require('node:crypto');
const money = require('./legacy-money');

class PaymentIdempotencyError extends Error {
  constructor(code, statusCode = 409) {
    super(code);
    this.name = 'PaymentIdempotencyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function parseIdempotencyKey(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new PaymentIdempotencyError('INVALID_IDEMPOTENCY_KEY', 400);
  }
  return value;
}

function paymentFingerprint(input) {
  // Fixed property order, normalized cents/instants, never a processing timestamp.
  // null paidAt means the caller requested the server date on the first attempt.
  const canonical = {
    operation: 'ADMIN_PAYMENT_CREATE_V1',
    clientId: input.clientId,
    debtId: input.debtId,
    installmentId: input.installmentId || null,
    amount: money.format(money.cents(input.amount)),
    type: input.type,
    paidAt: input.paidAt == null ? null : new Date(input.paidAt).toISOString(),
    note: input.note || null,
    receiptUrl: input.receiptUrl || null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function resolveOperationDebt(tx, { accountId, clientId, debtId, installmentId }) {
  let resolved = debtId;
  if (installmentId) {
    const installment = await tx.installment.findFirst({
      where: { id: installmentId, accountId, clientId }, select: { debtId: true },
    });
    if (!installment || (debtId && installment.debtId !== debtId)) throw new Error('DIVIDA_NAO_ENCONTRADA');
    resolved = installment.debtId;
  }
  const debt = resolved && await tx.debt.findFirst({
    where: { id: resolved, accountId, clientId }, select: { id: true },
  });
  if (!debt) throw new Error('DIVIDA_NAO_ENCONTRADA');
  // No ACTIVE filter: a retry must work after its original TOTAL settled the Debt.
  await tx.$queryRaw`SELECT "id" FROM "Debt" WHERE "id" = ${debt.id} AND "accountId" = ${accountId} FOR UPDATE`;
  return debt.id;
}

async function readCompletedOperation(tx, { accountId, debtId, key, fingerprint }) {
  const operation = await tx.paymentCreationOperation.findUnique({
    where: { accountId_debtId_key: { accountId, debtId, key } },
  });
  if (!operation) return null;
  if (operation.fingerprint !== fingerprint) throw new PaymentIdempotencyError('IDEMPOTENCY_KEY_REUSED');
  return operation.response;
}

async function completeOperation(tx, { accountId, debtId, key, fingerprint, response }) {
  // The UNIQUE constraint remains the final authority even if another writer ignores the lock.
  // Any insert failure rolls back the Payment and Debt writes in the same transaction.
  return tx.paymentCreationOperation.create({ data: { accountId, debtId, key, fingerprint, response } });
}

module.exports = { PaymentIdempotencyError, parseIdempotencyKey, paymentFingerprint,
  resolveOperationDebt, readCompletedOperation, completeOperation };
