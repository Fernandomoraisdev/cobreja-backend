'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { replayStandard, isStandardLoan } = require('../services/legacy-standard-engine');
const date = day => new Date(`${day}T15:00:00-03:00`);
const debt = extra => ({ id: 42, accountId: 7, kind: 'STANDARD', debtType: 'LOAN', status: 'ACTIVE',
  principalAmount: '5000.00', borrowedAt: date('2026-07-23'), originalDueDate: date('2026-08-23'),
  dueDate: date('2026-08-23'), monthlyInterestMode: 'PERCENTAGE', monthlyInterestValue: '40',
  dailyInterestMode: 'PERCENTAGE', dailyInterestValue: '1', ...extra });
const payment = extra => ({ id: 1, debtId: 42, accountId: 7, type: 'PARCIAL', amount: '3000.00',
  paidAt: date('2026-08-23'), ...extra });
const replay = (payments = [], through = '2026-08-23', extra = {}) => replayStandard(debt(extra), payments, date(through));

test('first contracted cycle is integral even before maturity', () => {
  const result = replay([], '2026-07-24');
  assert.equal(result.snapshot.totalDue, 7000);
  assert.equal(result.snapshot.interestOutstanding, 2000);
});
test('early full settlement includes the entire first cycle and never resurrects', () => {
  const result = replay([payment({ type: 'TOTAL', amount: '7000', paidAt: date('2026-07-24') })], '2026-11-24');
  assert.equal(result.snapshot.totalDue, 0);
  assert.equal(result.state.status, 'SETTLED');
  assert.equal(result.snapshot.financialComponents.cycles.length, 1);
  assert.equal(result.snapshot.financialComponents.dailies.length, 0);
});
test('second and third competencies retain their independent original amounts', () => {
  const result = replay([], '2026-10-23');
  assert.deepEqual(result.snapshot.financialComponents.cycles.map(c => [c.due, c.amount]),
    [['2026-08-23', '2000.00'], ['2026-09-23', '2000.00'], ['2026-10-23', '2000.00']]);
  assert.equal(result.snapshot.financialComponents.dailyBase, '7000.00');
});
test('regression with two unpaid competencies and 44 historical daily charges', () => {
  const result = replay([], '2026-10-06');
  const { snapshot } = result;
  assert.equal(snapshot.principalOutstanding, 5000);
  assert.equal(snapshot.interestOutstanding, 4000);
  assert.equal(snapshot.dailyAccruedAmount, 3080);
  assert.equal(snapshot.totalDue, 12080);
  const days = snapshot.financialComponents.dailies;
  assert.equal(days.length, 44);
  assert.equal(days[0].date, '2026-08-24');
  assert.equal(days.at(-1).date, '2026-10-06');
  assert.ok(days.every(item => item.base === '7000.00' && item.amount === '70.00'));
});
test('interest-only payment does not amortize principal or move contractual anchor', () => {
  const result = replay([payment({ type: 'JUROS', amount: '2000' })], '2026-09-23');
  assert.equal(result.snapshot.principalOutstanding, 5000);
  assert.equal(result.snapshot.financialComponents.cycles[1].amount, '2000.00');
  assert.equal(result.state.dueDate.toISOString().slice(0, 10), '2026-09-23');
});
test('AUTO amortizes only remainder after the entire current cycle', () => {
  const result = replay([payment()], '2026-08-23');
  assert.equal(result.computedPayments[0].interestAmount, 2000);
  assert.equal(result.computedPayments[0].principalAmount, 1000);
  assert.equal(result.snapshot.principalOutstanding, 4000);
});
test('future daily uses 4000 base then next cycle forms 1600 and base 5600', () => {
  const result = replay([payment()], '2026-09-24');
  const days = result.snapshot.financialComponents.dailies;
  assert.equal(days.find(day => day.date === '2026-08-24').amount, '40.00');
  assert.equal(days.find(day => day.date === '2026-09-23').amount, '40.00');
  assert.equal(days.find(day => day.date === '2026-09-24').amount, '56.00');
  assert.equal(result.snapshot.financialComponents.cycles[0].amount, '2000.00');
  assert.equal(result.snapshot.financialComponents.cycles[1].amount, '1600.00');
});
test('midnight 23 to 24 creates one entire daily before an afternoon payment', () => {
  assert.equal(replayStandard(debt(), [], new Date('2026-08-24T02:59:59Z')).snapshot.dailyAccruedAmount, 0);
  assert.equal(replayStandard(debt(), [], new Date('2026-08-24T03:00:00Z')).snapshot.dailyAccruedAmount, 70);
  const result = replay([payment({ amount: '3070', paidAt: date('2026-08-24') })], '2026-08-25');
  assert.equal(result.computedPayments[0].dailyAmount, 70);
  assert.equal(result.computedPayments[0].interestAmount, 2000);
  assert.equal(result.computedPayments[0].principalAmount, 1000);
  assert.deepEqual(result.snapshot.financialComponents.dailies.map(day => day.amount), ['70.00', '40.00']);
});
test('payment on first overdue day before clearing charges cannot reach principal', () => {
  const result = replay([payment({ amount: '50', paidAt: date('2026-08-24') })], '2026-08-24');
  assert.equal(result.computedPayments[0].dailyAmount, 50);
  assert.equal(result.computedPayments[0].principalAmount, 0);
  assert.equal(result.snapshot.dailyAccruedAmount, 20);
});
for (const amount of ['5', '10', '20', '40', '50']) {
  test(`FIXED ${amount} remains contractual regardless of principal amortization`, () => {
    const result = replay([payment()], '2026-08-25', { dailyInterestMode: 'FIXED', dailyInterestValue: amount });
    assert.ok(result.snapshot.financialComponents.dailies.every(day => day.amount === `${amount}.00`));
  });
}
test('manual principal allocation is explicit and cannot change AUTO policy', () => {
  const result = replay([payment({ amount: '1000', allocationMode: 'MANUAL',
    allocations: [{ component: 'PRINCIPAL', amount: '1000', componentId: 'PRINCIPAL:42' }] }),
  payment({ id: 2, amount: '500' })]);
  assert.equal(result.computedPayments[0].principalAmount, 1000);
  assert.equal(result.computedPayments[1].interestAmount, 500);
  assert.equal(result.computedPayments[1].principalAmount, 0);
  assert.equal(result.snapshot.totalDue, 5500);
});
test('manual can select an exact cycle, leaving older cycle identifiable', () => {
  const result = replay([payment({ amount: '1000', paidAt: date('2026-09-23'), allocationMode: 'MANUAL',
    allocations: [{ component: 'CYCLE', componentId: 'CYCLE:2026-09-23', amount: '1000' }] })], '2026-09-23');
  assert.equal(result.snapshot.financialComponents.cycles[0].remaining, '2000.00');
  assert.equal(result.snapshot.financialComponents.cycles[1].remaining, '1000.00');
});
test('manual allocation validation rejects nonexistent, excess, zero and sum mismatch', () => {
  for (const allocations of [
    [{ component: 'CYCLE', componentId: 'CYCLE:2030-01-01', amount: '1000' }],
    [{ component: 'PRINCIPAL', amount: '0' }],
    [{ component: 'PRINCIPAL', amount: '100' }],
    [{ component: 'DAILY', amount: '1000' }],
    [{ component: 'SECRET', amount: '1000' }],
  ]) assert.throws(() => replay([payment({ amount: '1000', allocationMode: 'MANUAL', allocations })]));
});
test('overpayment rejects rather than truncating and supplies maximum', () => {
  assert.throws(() => replay([payment({ amount: '800' })], '2026-08-23', {
    principalAmount: '700', monthlyInterestValue: '0', dailyInterestValue: '0',
  }), error => error.code === 'OVERPAYMENT' && error.details.maximum === '700.00');
});
test('interest overpayment cannot silently reduce principal', () => {
  assert.throws(() => replay([payment({ type: 'JUROS', amount: '3000' })]), /OVERPAYMENT/);
});
test('zero principal alone does not settle while a monthly obligation is unpaid', () => {
  const result = replay([payment({ amount: '5000', allocationMode: 'MANUAL',
    allocations: [{ component: 'PRINCIPAL', amount: '5000' }] })]);
  assert.equal(result.snapshot.principalOutstanding, 0);
  assert.equal(result.snapshot.totalDue, 2000);
  assert.equal(result.snapshot.isSettled, false);
});
test('multiple payments are chronological and original input remains immutable', () => {
  const payments = [payment({ id: 2, amount: '2000' }), payment({ id: 1, amount: '1000' })];
  const copy = structuredClone(payments);
  const result = replay(payments);
  assert.deepEqual(result.computedPayments.map(p => p.id), [1, 2]);
  assert.equal(result.snapshot.principalOutstanding, 4000);
  assert.deepEqual(payments, copy);
});
test('Debt identity and tenant cannot be substituted by the same Client', () => {
  assert.throws(() => replay([payment({ debtId: 43, clientId: 1 })]), /PAYMENT_DEBT_MISMATCH/);
  assert.throws(() => replay([payment({ accountId: 8 })]), /PAYMENT_TENANT_MISMATCH/);
  assert.throws(() => replay([payment({ debtId: undefined })]), /PAYMENT_DEBT_MISMATCH/);
  assert.equal(replayStandard(debt({ id: 43 }), [], date('2026-08-23')).snapshot.principalOutstanding, 5000);
});
test('duplicate facts cannot be replayed twice', () => assert.throws(() => replay([payment(), payment()]), /DUPLICATE_PAYMENT/));
test('settlement at maturity stops both future cycles and daily charges', () => {
  const result = replay([payment({ type: 'TOTAL', amount: '7000' })], '2027-01-23');
  assert.equal(result.snapshot.totalDue, 0);
  assert.equal(result.snapshot.financialComponents.cycles.length, 1);
});
test('each cycle and each daily round HALF_UP independently', () => {
  const result = replay([], '2026-08-25', { principalAmount: '0.05', monthlyInterestValue: '10', dailyInterestValue: '10' });
  assert.equal(result.snapshot.interestOutstanding, 0.01);
  assert.equal(result.snapshot.dailyAccruedAmount, 0.02);
});
test('STANDARD engine explicitly excludes renegotiated and installment modalities', () => {
  for (const extra of [{ kind: 'RENEGOTIATED' }, { status: 'RENEGOTIATED' },
    { debtType: 'INSTALLMENT_SALE' }, { renegotiationId: 9 }, { installments: [{ id: 1 }] }]) {
    assert.equal(isStandardLoan(debt(extra)), false);
    assert.throws(() => replay([], '2026-08-23', extra), /UNSUPPORTED_STANDARD_MODALITY/);
  }
});

test('UTC-midnight contract DateTime retains date-only form day', () => {
  const result = replayStandard(debt({ borrowedAt: new Date('2026-07-23'), originalDueDate: new Date('2026-08-23') }), [], date('2026-08-24'));
  assert.equal(result.snapshot.financialComponents.cycles[0].due, '2026-08-23');
  assert.equal(result.snapshot.dailyAccruedAmount, 70);
});
test('day 31 returns after short month in actual competency replay', () => {
  const result = replayStandard(debt({ borrowedAt: date('2026-01-01'), originalDueDate: date('2026-01-31'), dailyInterestValue: '0' }), [], date('2026-04-30'));
  assert.deepEqual(result.snapshot.financialComponents.cycles.map(c => c.due),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.equal(result.snapshot.interestOutstanding, 8000);
});
test('leap February in competency replay preserves original anchor', () => {
  const result = replayStandard(debt({ borrowedAt: date('2024-01-01'), originalDueDate: date('2024-01-31'), dailyInterestValue: '0' }), [], date('2024-03-31'));
  assert.deepEqual(result.snapshot.financialComponents.cycles.map(c => c.due), ['2024-01-31', '2024-02-29', '2024-03-31']);
});
for (const hour of ['08', '15', '23']) {
  test(`payment at ${hour}:00 on first overdue day still pays the full daily`, () => {
    const result = replayStandard(debt(), [payment({ amount: '3070', paidAt: new Date(`2026-08-24T${hour}:00:00-03:00`) })], date('2026-08-25'));
    assert.equal(result.computedPayments[0].dailyAmount, 70);
    assert.equal(result.snapshot.financialComponents.dailies[0].amount, '70.00');
    assert.equal(result.snapshot.financialComponents.dailies[1].amount, '40.00');
  });
}
test('stored valid decomposition remains a fact rather than being redistributed by AUTO', () => {
  const result = replay([payment({ amount: '1000', principalAmount: 1000, interestAmount: 0, dailyAmount: 0 })]);
  assert.equal(result.computedPayments[0].principalAmount, 1000);
  assert.equal(result.computedPayments[0].interestAmount, 0);
  assert.equal(result.snapshot.interestOutstanding, 2000);
});
test('manual can allocate an existing historical daily without changing its original value', () => {
  const result = replay([payment({ amount: '30', paidAt: date('2026-08-24'), allocationMode: 'MANUAL',
    allocations: [{ component: 'DAILY', componentId: 'DAILY:2026-08-24', amount: '30' }] })], '2026-08-24');
  assert.equal(result.snapshot.financialComponents.dailies[0].amount, '70.00');
  assert.equal(result.snapshot.financialComponents.dailies[0].remaining, '40.00');
});
test('TOTAL must cover all components even when manual allocations are specified', () => {
  assert.throws(() => replay([payment({ type: 'TOTAL', amount: '1000', allocationMode: 'MANUAL',
    allocations: [{ component: 'PRINCIPAL', amount: '1000' }] })]), /TOTAL_PAYMENT_AMOUNT_MISMATCH/);
});
test('deleted payment facts do not contribute to reconstruction', () => {
  assert.equal(replay([payment({ deletedAt: date('2026-08-24') })]).snapshot.totalDue, 7000);
});
test('unsupported V2 inputs cannot enter the LEGACY STANDARD kernel', () => {
  assert.throws(() => replay([], '2026-08-23', { financialEngine: 'V2' }), /UNSUPPORTED_STANDARD_MODALITY/);
});

test('manual component excess is rejected even below the total debt balance', () => {
  assert.throws(() => replay([payment({ amount: '6000', allocationMode: 'MANUAL',
    allocations: [{ component: 'PRINCIPAL', amount: '6000' }] })]), /INVALID_ALLOCATION/);
});
test('invalid contract modes, rates and dates are rejected rather than invented', () => {
  assert.throws(() => replay([], '2026-08-23', { monthlyInterestValue: null }), /INVALID_CHARGE_VALUE/);
  assert.throws(() => replay([], '2026-08-23', { dailyInterestMode: 'UNKNOWN' }), /INVALID_CHARGE_MODE/);
  assert.throws(() => replay([], '2026-08-23', { borrowedAt: date('2026-09-01') }), /INVALID_CONTRACT_DATES/);
});

test('persisted amount without consistent decomposition is not treated as a draft', () => {
  assert.throws(() => replay([payment({ amount: '1000', principalAmount: 0, interestAmount: 0, dailyAmount: 0 })]), /HISTORY_RECONCILIATION_REQUIRED/);
});

test('intraday snapshot does not use a payment that will happen later that day', () => {
  const scheduled = payment({ amount: '3070', paidAt: new Date('2026-08-24T15:00:00-03:00') });
  const before = replayStandard(debt(), [scheduled], new Date('2026-08-24T08:00:00-03:00'));
  const after = replayStandard(debt(), [scheduled], new Date('2026-08-24T15:00:00-03:00'));
  assert.equal(before.snapshot.totalDue, 7070);
  assert.equal(after.snapshot.totalDue, 4000);
  assert.equal(before.snapshot.financialComponents.dailies[0].amount, '70.00');
  assert.equal(after.snapshot.financialComponents.dailies[0].amount, '70.00');
});
