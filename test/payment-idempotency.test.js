'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseIdempotencyKey, paymentFingerprint, readCompletedOperation,
  resolveOperationDebt, completeOperation } = require('../services/payment-idempotency.service');
const input = { clientId: 1, debtId: 2, installmentId: null, amount: '10.01',
  type: 'PARCIAL', paidAt: '2026-10-06T15:00:00Z', note: null, receiptUrl: null };
test('idempotency header is optional for existing callers, never randomly generated', () => {
  assert.equal(parseIdempotencyKey(undefined), null);
});
test('idempotency header accepts bounded opaque keys and retains exact case', () => {
  assert.equal(parseIdempotencyKey('Abc-123:_x.y'), 'Abc-123:_x.y');
  assert.equal(parseIdempotencyKey('a'.repeat(128)), 'a'.repeat(128));
});
test('idempotency header rejects empty, whitespace, duplicate headers, control, oversized or nonstring', () => {
  for (const value of ['', ' key', 'key ', 'a,b', 'a\nb', 'a'.repeat(129), null, ['key'], 1]) {
    assert.throws(() => parseIdempotencyKey(value), { code: 'INVALID_IDEMPOTENCY_KEY', statusCode: 400 });
  }
});
test('fingerprint ignores JSON property order and generated operational fields', () => {
  const reverse = Object.fromEntries(Object.entries(input).reverse());
  assert.equal(paymentFingerprint(input), paymentFingerprint({ ...reverse, createdAt: 'different', updatedAt: 'other', id: 900 }));
});
test('fingerprint uses canonical cents for number/string and fractional-cent HALF_UP', () => {
  assert.equal(paymentFingerprint(input), paymentFingerprint({ ...input, amount: 10.01 }));
  assert.equal(paymentFingerprint({ ...input, amount: '0.005' }), paymentFingerprint({ ...input, amount: '0.01' }));
  assert.notEqual(paymentFingerprint({ ...input, amount: '0.01' }), paymentFingerprint({ ...input, amount: '0.05' }));
});
test('fingerprint canonicalizes equivalent explicit timezone instants', () => {
  assert.equal(paymentFingerprint(input), paymentFingerprint({ ...input, paidAt: '2026-10-06T12:00:00-03:00' }));
});
test('fingerprint has stable server-date intent rather than a processing timestamp', () => {
  assert.equal(paymentFingerprint({ ...input, paidAt: null }), paymentFingerprint({ ...input, paidAt: undefined }));
  assert.notEqual(paymentFingerprint(input), paymentFingerprint({ ...input, paidAt: null }));
});
test('fingerprint distinguishes amount, type, date, target, note and receipt changes', () => {
  for (const change of [{ amount: '10.02' }, { type: 'TOTAL' }, { paidAt: '2026-10-05T15:00:00Z' },
    { clientId: 3 }, { debtId: 3 }, { installmentId: 4 }, { note: 'other' }, { receiptUrl: 'https://example.invalid/r' }]) {
    assert.notEqual(paymentFingerprint(input), paymentFingerprint({ ...input, ...change }));
  }
});
test('completed lookup is scoped to account, debt and key', async () => {
  const scope = { accountId: 7, debtId: 2, key: 'key', fingerprint: 'hash' };
  let where;
  const response = { data: { id: 1 } };
  const tx = { paymentCreationOperation: { findUnique: async args => { where = args.where; return { fingerprint: 'hash', response }; } } };
  assert.deepEqual(await readCompletedOperation(tx, scope), response);
  assert.deepEqual(where, { accountId_debtId_key: { accountId: 7, debtId: 2, key: 'key' } });
});
test('same scoped key with different fingerprint returns sanitized conflict', async () => {
  const tx = { paymentCreationOperation: { findUnique: async () => ({ fingerprint: 'other' }) } };
  await assert.rejects(readCompletedOperation(tx, { fingerprint: 'hash' }), { code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
});
test('completion uses the supplied transaction client and propagates constraint/database failure', async () => {
  const tx = { paymentCreationOperation: { create: async () => { throw new Error('artificial'); } } };
  await assert.rejects(completeOperation(tx, {}), /artificial/);
});
test('keyed debt resolution validates tenant/client before acquiring the parameterized row lock', async () => {
  const calls = [];
  const tx = { debt: { findFirst: async args => { calls.push(args); return { id: 2 }; } },
    $queryRaw: async (strings, ...values) => { assert.match(strings.join('?'), /FOR UPDATE/); calls.push(values); } };
  assert.equal(await resolveOperationDebt(tx, { accountId: 7, clientId: 1, debtId: 2 }), 2);
  assert.deepEqual(calls[0].where, { id: 2, accountId: 7, clientId: 1 });
  assert.deepEqual(calls[1], [2, 7]);
});
test('cross-tenant missing target does not acquire a lock or look up an operation', async () => {
  const tx = { debt: { findFirst: async () => null }, $queryRaw: async () => assert.fail('unexpected lock') };
  await assert.rejects(resolveOperationDebt(tx, { accountId: 8, clientId: 1, debtId: 2 }), /DIVIDA_NAO_ENCONTRADA/);
});
test('installment identity mismatch rejects before locking or performing financial writes', async () => {
  const tx = { installment: { findFirst: async () => ({ debtId: 3 }) } };
  await assert.rejects(resolveOperationDebt(tx, { accountId: 7, clientId: 1, debtId: 2, installmentId: 4 }), /DIVIDA_NAO_ENCONTRADA/);
});
