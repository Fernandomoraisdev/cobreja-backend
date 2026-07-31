const assert = require('node:assert/strict');
const test = require('node:test');

const {
  calculateDebtSnapshot,
  simulatePaymentsForDebt,
} = require('../services/debt.service');

function date(value) {
  return new Date(`${value}T12:00:00.000Z`);
}

function standardDebt(overrides = {}) {
  return {
    id: 1,
    kind: 'STANDARD',
    status: 'ACTIVE',
    principalAmount: 400,
    principalOutstanding: 400,
    monthlyInterestMode: 'PERCENTAGE',
    monthlyInterestValue: 0,
    dailyInterestMode: 'FIXED',
    dailyInterestValue: 10,
    currentCycleInterestPaid: 0,
    borrowedAt: date('2026-06-01'),
    originalDueDate: date('2026-06-15'),
    dueDate: date('2026-06-15'),
    lastInterestPaidAt: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  };
}

test('sale debt with 0 monthly interest only accrues daily fee after due date', () => {
  const snapshot = calculateDebtSnapshot(standardDebt(), date('2026-06-25'));

  assert.equal(snapshot.principalOutstanding, 400);
  assert.equal(snapshot.monthlyInterestAmount, 0);
  assert.equal(snapshot.interestOutstanding, 0);
  assert.equal(snapshot.overdueDays, 10);
  assert.equal(snapshot.dailyAccruedAmount, 100);
  assert.equal(snapshot.totalDue, 500);
});

test('partial payments pay daily fee before remaining principal and stop accrual when settled', () => {
  const debt = standardDebt();
  const result = simulatePaymentsForDebt(debt, [
    {
      id: 1,
      type: 'PARCELA',
      amount: 300,
      paidAt: date('2026-06-15'),
    },
    {
      id: 2,
      type: 'PARCIAL',
      amount: 200,
      paidAt: date('2026-06-25'),
    },
  ]);

  assert.equal(result.state.status, 'SETTLED');
  assert.equal(result.state.principalOutstanding, 0);
  assert.equal(result.computedPayments[1].dailyAmount, 100);
  assert.equal(result.computedPayments[1].principalAmount, 100);

  const later = calculateDebtSnapshot(result.state, date('2026-07-11'));
  assert.equal(later.overdueDays, 0);
  assert.equal(later.dailyAccruedAmount, 0);
  assert.equal(later.totalDue, 0);
});

test('interest payment advances cycle when monthly interest and daily fee are fully covered', () => {
  const debt = standardDebt({
    principalAmount: 1000,
    principalOutstanding: 1000,
    monthlyInterestMode: 'PERCENTAGE',
    monthlyInterestValue: 10,
    dailyInterestMode: 'FIXED',
    dailyInterestValue: 20,
  });

  const result = simulatePaymentsForDebt(debt, [
    {
      id: 1,
      type: 'JUROS',
      amount: 300,
      paidAt: date('2026-06-25'),
    },
  ]);

  assert.equal(result.computedPayments[0].dailyAmount, 200);
  assert.equal(result.computedPayments[0].interestAmount, 100);
  assert.equal(result.state.principalOutstanding, 1000);
  assert.equal(result.state.dueDate.toISOString(), date('2026-07-15').toISOString());
  assert.equal(result.state.currentCycleInterestPaid, 0);
});
