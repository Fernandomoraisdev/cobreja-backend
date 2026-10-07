'use strict';

const money = require('./legacy-money');
const calendar = require('./legacy-calendar');

class LegacyFinancialError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'LegacyFinancialError';
    this.code = code;
    this.statusCode = 409;
    this.details = details;
  }
}
const fail = (code, details) => { throw new LegacyFinancialError(code, details); };
const sum = items => items.reduce((value, item) => value + item.remaining, 0n);
const number = money.toLegacyNumber;
const DRAFT_PAYMENT = Symbol('legacy-financial-draft');

function isStandardLoan(debt, payments = debt.payments || []) {
  return debt.kind === 'STANDARD' && (debt.debtType || 'LOAN') === 'LOAN'
    && (!debt.financialEngine || debt.financialEngine === 'LEGACY')
    && !debt.renegotiationId && !debt.deletedAt && debt.status !== 'RENEGOTIATED'
    && !(debt.installments || []).length
    && !payments.some(payment => payment.installmentId || payment.type === 'PARCELA');
}

function charge(base, mode, value) {
  if (value == null && mode != null) fail('INVALID_CHARGE_VALUE');
  if (value == null || value === 0 || value === '0') return 0n;
  if (mode === 'PERCENTAGE') return money.percentage(base, value);
  if (mode !== 'FIXED') fail('INVALID_CHARGE_MODE');
  const result = money.cents(value);
  if (result < 0n) fail('INVALID_CHARGE_VALUE');
  return result;
}

function createState(debt) {
  if (!Number.isSafeInteger(debt.id) || debt.id <= 0) fail('DEBT_ID_REQUIRED');
  const borrowed = calendar.contractCivil(debt.borrowedAt || debt.createdAt);
  const anchor = calendar.contractCivil(debt.originalDueDate || debt.dueDate);
  if (anchor < borrowed) fail('INVALID_CONTRACT_DATES');
  const principal = money.cents(debt.principalAmount);
  if (principal <= 0n) fail('INVALID_PRINCIPAL');
  const first = charge(principal, debt.monthlyInterestMode, debt.monthlyInterestValue);
  charge(principal + first, debt.dailyInterestMode, debt.dailyInterestValue);
  return {
    debt, borrowed, anchor, principal, cursor: borrowed, nextCycle: 1,
    cycles: [{ id: `CYCLE:${anchor}`, due: anchor, formedAt: borrowed, base: principal, amount: first, remaining: first }],
    dailies: [], dailyBase: principal + first, settledAt: null,
    computedPayments: [], paidInterest: 0n, paidDaily: 0n,
  };
}

function advance(state, day) {
  if (day < state.cursor) fail('NON_CHRONOLOGICAL_OPERATION');
  if (calendar.serial(day) - calendar.serial(state.borrowed) > 36525) fail('REPLAY_RANGE_EXCEEDED');
  while (state.cursor < day && !state.settledAt) {
    state.cursor = calendar.addDays(state.cursor, 1);
    // A daily is born at midnight BEFORE any payment on that civil date.
    // No daily-on-daily, nor sum of all unpaid monthly cycles in its base.
    if (state.cursor > state.anchor) {
      const amount = charge(state.dailyBase, state.debt.dailyInterestMode, state.debt.dailyInterestValue);
      if (amount > 0n) state.dailies.push({
        id: `DAILY:${state.cursor}`, date: state.cursor,
        base: state.dailyBase, amount, remaining: amount,
      });
    }
    if (state.cursor === calendar.monthAt(state.anchor, state.nextCycle)) {
      const amount = charge(state.principal, state.debt.monthlyInterestMode, state.debt.monthlyInterestValue);
      state.cycles.push({
        id: `CYCLE:${state.cursor}`, due: state.cursor, formedAt: state.cursor,
        base: state.principal, amount, remaining: amount,
      });
      if (amount > 0n || state.principal > 0n) state.dailyBase = state.principal + amount;
      state.nextCycle += 1;
    }
  }
}

function available(state, type) {
  if (type === 'PRINCIPAL') return state.principal;
  return sum(type === 'DAILY' ? state.dailies : state.cycles);
}

function applyAllocation(state, type, amount, componentId) {
  if (amount <= 0n || amount > available(state, type)) fail('INVALID_ALLOCATION');
  if (type === 'PRINCIPAL') {
    if (componentId && componentId !== `PRINCIPAL:${state.debt.id}`) fail('COMPONENT_NOT_FOUND');
    state.principal -= amount;
    return;
  }
  if (!['DAILY', 'CYCLE'].includes(type)) fail('INVALID_COMPONENT');
  const items = type === 'DAILY' ? state.dailies : state.cycles;
  const selected = componentId ? items.filter(item => item.id === componentId) : items;
  if (!selected.length || sum(selected) < amount) fail('COMPONENT_NOT_FOUND');
  let remaining = amount;
  for (const item of selected) {
    const applied = remaining < item.remaining ? remaining : item.remaining;
    item.remaining -= applied;
    remaining -= applied;
    if (remaining === 0n) break;
  }
  if (type === 'DAILY') state.paidDaily += amount;
  else state.paidInterest += amount;
}

function applyPayment(state, payment) {
  if (payment.debtId !== state.debt.id) fail('PAYMENT_DEBT_MISMATCH');
  if (payment.accountId != null && payment.accountId !== state.debt.accountId) fail('PAYMENT_TENANT_MISMATCH');
  const paidAt = new Date(payment.paidAt || payment.createdAt);
  const day = calendar.civil(paidAt);
  if (day < state.borrowed) fail('PAYMENT_BEFORE_CONTRACT');
  advance(state, day);
  const amount = money.cents(payment.amount);
  if (amount <= 0n) fail('INVALID_PAYMENT_AMOUNT');
  const maximum = state.principal + sum(state.cycles) + sum(state.dailies);
  if (amount > maximum) fail('OVERPAYMENT', { maximum: money.format(maximum) });
  if (state.settledAt) fail('DEBT_ALREADY_SETTLED');
  const type = String(payment.type).toUpperCase();
  if (!['PARCIAL', 'JUROS', 'TOTAL'].includes(type)) fail('INVALID_PAYMENT_TYPE');
  const breakdown = { PRINCIPAL: 0n, CYCLE: 0n, DAILY: 0n };
  if (type === 'TOTAL' && amount !== maximum) fail('TOTAL_PAYMENT_AMOUNT_MISMATCH', { maximum: money.format(maximum) });
  const allocations = [];
  const take = (component, value, id) => {
    applyAllocation(state, component, value, id);
    breakdown[component] += value;
    allocations.push({ component, componentId: id || null, amount: money.format(value) });
  };
  const historicAmounts = [payment.principalAmount, payment.interestAmount, payment.dailyAmount];
  const historic = !payment[DRAFT_PAYMENT] && historicAmounts.every(value => value != null)
    && historicAmounts.map(money.cents).reduce((total, value) => total + value, 0n) === amount;
  if (historicAmounts.every(value => value != null) && !historic && !payment[DRAFT_PAYMENT]) {
    fail('HISTORY_RECONCILIATION_REQUIRED');
  }
  const preserved = historic ? [
    { component: 'DAILY', amount: payment.dailyAmount },
    { component: 'CYCLE', amount: payment.interestAmount },
    { component: 'PRINCIPAL', amount: payment.principalAmount },
  ].filter(item => money.cents(item.amount) > 0n) : null;
  if (payment.allocationMode === 'MANUAL' || preserved) {
    const requested = preserved || payment.allocations;
    if (!Array.isArray(requested) || !requested.length) fail('INVALID_ALLOCATION');
    const planned = requested.map(item => ({ ...item, cents: money.cents(item.amount) }));
    if (planned.reduce((total, item) => total + item.cents, 0n) !== amount) fail('ALLOCATION_SUM_MISMATCH');
    // Validate against an independent copy to make the domain operation atomic.
    const draft = { ...state, cycles: state.cycles.map(item => ({ ...item })), dailies: state.dailies.map(item => ({ ...item })) };
    for (const item of planned) applyAllocation(draft, item.component, item.cents, item.componentId);
    for (const item of planned) take(item.component, item.cents, item.componentId);
  } else {
    if (payment.allocationMode != null && payment.allocationMode !== 'AUTO') fail('INVALID_ALLOCATION_MODE');
    let remaining = amount;
    // Preserve the published AUTO priority: daily, cycles oldest first, principal.
    for (const component of (type === 'JUROS' ? ['DAILY', 'CYCLE'] : ['DAILY', 'CYCLE', 'PRINCIPAL'])) {
      const pending = available(state, component);
      const value = remaining < pending ? remaining : pending;
      if (value > 0n) take(component, value);
      remaining -= value;
    }
    if (remaining > 0n) fail('OVERPAYMENT', { maximum: money.format(maximum - state.principal) });
  }
  const latest = state.cycles[state.cycles.length - 1];
  state.dailyBase = state.principal + latest.remaining;
  if (state.principal + sum(state.cycles) + sum(state.dailies) === 0n) state.settledAt = paidAt;
  state.computedPayments.push({
    ...payment, paidAt, amount: number(amount), principalAmount: number(breakdown.PRINCIPAL),
    interestAmount: number(breakdown.CYCLE), dailyAmount: number(breakdown.DAILY), allocations,
  });
}

function serializeComponent(item) {
  return { ...item, base: money.format(item.base), amount: money.format(item.amount), remaining: money.format(item.remaining) };
}

function replayStandard(debt, payments, now = new Date()) {
  if (!isStandardLoan(debt, payments)) fail('UNSUPPORTED_STANDARD_MODALITY');
  const state = createState(debt);
  const through = calendar.civil(now);
  const ordered = payments.filter(payment => !payment.deletedAt).slice().sort((a, b) => {
    const difference = new Date(a.paidAt || a.createdAt) - new Date(b.paidAt || b.createdAt);
    return difference || (a.id || 0) - (b.id || 0);
  });
  const ids = new Set();
  for (const payment of ordered) {
    if (payment.id != null && ids.has(payment.id)) fail('DUPLICATE_PAYMENT');
    if (payment.id != null) ids.add(payment.id);
    if (new Date(payment.paidAt || payment.createdAt).getTime() > new Date(now).getTime()) continue;
    applyPayment(state, payment);
  }
  advance(state, through);
  const interest = sum(state.cycles);
  const daily = sum(state.dailies);
  const latest = state.cycles[state.cycles.length - 1];
  const outstandingCycle = state.cycles.find(item => item.remaining > 0n);
  const due = latest.amount === 0n ? state.anchor
    : (outstandingCycle ? outstandingCycle.due : calendar.monthAt(state.anchor, state.nextCycle));
  const total = state.principal + interest + daily;
  const overdue = state.settledAt ? 0 : Math.max(0, calendar.serial(through) - calendar.serial(due));
  const snapshot = {
    principalOutstanding: number(state.principal), monthlyInterestAmount: number(latest.amount),
    currentCycleInterestPaid: number(state.paidInterest), currentCycleDailyPaid: number(state.paidDaily),
    interestOutstanding: number(interest), dailyAccruedAmount: number(daily),
    overdueDays: overdue, totalDue: number(total),
    isOverdue: overdue > 0, dueToday: !state.settledAt && through === due,
    isSettled: total === 0n,
    financialComponents: {
      principal: money.format(state.principal), cycles: state.cycles.map(serializeComponent),
      dailies: state.dailies.map(serializeComponent), dailyBase: money.format(state.dailyBase),
    },
  };
  return {
    state: {
      ...debt, principalOutstanding: snapshot.principalOutstanding,
      currentCycleInterestPaid: snapshot.currentCycleInterestPaid, currentCycleDailyPaid: snapshot.currentCycleDailyPaid,
      dueDate: new Date(`${due}T12:00:00.000Z`), status: state.settledAt ? 'SETTLED' : 'ACTIVE',
      settledAt: state.settledAt,
      lastInterestPaidAt: state.computedPayments.filter(payment => payment.interestAmount > 0).at(-1)?.paidAt || null,
    },
    computedPayments: state.computedPayments, snapshot,
  };
}

module.exports = { LegacyFinancialError, isStandardLoan, replayStandard, DRAFT_PAYMENT };
