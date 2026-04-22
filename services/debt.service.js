const MONEY_EPSILON = 0.009;

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addMonthsKeepingDay(value, months = 1) {
  const base = new Date(value);
  const targetMonth = base.getMonth() + months;
  const targetYear = base.getFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  const targetDay = Math.min(base.getDate(), lastDay);

  return new Date(
    targetYear,
    normalizedMonth,
    targetDay,
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    base.getMilliseconds(),
  );
}

function calculateMonthlyInterestAmount(debt) {
  const value = Number(debt.monthlyInterestValue || 0);
  if (!value) return 0;

  const principalOutstanding = Number(
    debt.principalOutstanding ?? debt.principalAmount ?? 0,
  );

  if (debt.monthlyInterestMode === 'PERCENTAGE') {
    return roundMoney(principalOutstanding * value / 100);
  }

  return roundMoney(value);
}

function calculateOverdueDays(debt, now = new Date()) {
  if (debt.status !== 'ACTIVE') return 0;

  const dueDate = startOfDay(debt.dueDate);
  const referenceDate = startOfDay(now);

  if (referenceDate <= dueDate) return 0;

  return Math.floor((referenceDate - dueDate) / (1000 * 60 * 60 * 24));
}

function calculateInterestOutstanding(debt) {
  return roundMoney(
    Math.max(
      calculateMonthlyInterestAmount(debt) - Number(debt.currentCycleInterestPaid || 0),
      0,
    ),
  );
}

function calculateDailyAccruedAmount(debt, now = new Date()) {
  const overdueDays = calculateOverdueDays(debt, now);
  const value = Number(debt.dailyInterestValue || 0);

  if (!overdueDays || !value || debt.status !== 'ACTIVE') {
    return 0;
  }

  const interestOutstanding = calculateInterestOutstanding(debt);
  const baseAmount =
    interestOutstanding > MONEY_EPSILON
      ? interestOutstanding
      : Number(debt.principalOutstanding ?? debt.principalAmount ?? 0);

  const perDay = debt.dailyInterestMode === 'PERCENTAGE'
    ? roundMoney(baseAmount * value / 100)
    : roundMoney(value);

  return roundMoney(perDay * overdueDays);
}

function calculateDebtSnapshot(debt, now = new Date()) {
  const principalOutstanding = roundMoney(
    Number(debt.principalOutstanding ?? debt.principalAmount ?? 0),
  );
  const monthlyInterestAmount = calculateMonthlyInterestAmount({
    ...debt,
    principalOutstanding,
  });
  const currentCycleInterestPaid = roundMoney(Number(debt.currentCycleInterestPaid || 0));
  const interestOutstanding = roundMoney(
    Math.max(monthlyInterestAmount - currentCycleInterestPaid, 0),
  );
  const overdueDays = calculateOverdueDays({ ...debt, principalOutstanding }, now);
  const dailyAccruedAmount = calculateDailyAccruedAmount(
    { ...debt, principalOutstanding, currentCycleInterestPaid },
    now,
  );
  const totalDue = roundMoney(
    principalOutstanding + interestOutstanding + dailyAccruedAmount,
  );

  return {
    principalOutstanding,
    monthlyInterestAmount,
    currentCycleInterestPaid,
    interestOutstanding,
    dailyAccruedAmount,
    overdueDays,
    totalDue,
    isOverdue: overdueDays > 0,
    dueToday: overdueDays === 0 && startOfDay(now).getTime() === startOfDay(debt.dueDate).getTime(),
    isSettled: principalOutstanding <= MONEY_EPSILON,
  };
}

function toReplayState(debt) {
  return {
    id: debt.id,
    kind: debt.kind,
    title: debt.title || null,
    status: debt.deletedAt ? 'EXCLUDED' : 'ACTIVE',
    principalAmount: roundMoney(Number(debt.principalAmount || 0)),
    principalOutstanding: roundMoney(Number(debt.principalAmount || 0)),
    monthlyInterestMode: debt.monthlyInterestMode || null,
    monthlyInterestValue: Number(debt.monthlyInterestValue || 0),
    dailyInterestMode: debt.dailyInterestMode || null,
    dailyInterestValue: Number(debt.dailyInterestValue || 0),
    currentCycleInterestPaid: 0,
    borrowedAt: new Date(debt.borrowedAt || debt.createdAt || new Date()),
    originalDueDate: new Date(debt.originalDueDate || debt.dueDate),
    dueDate: new Date(debt.originalDueDate || debt.dueDate),
    lastInterestPaidAt: null,
    settledAt: null,
    deletedAt: debt.deletedAt ? new Date(debt.deletedAt) : null,
  };
}

function markStateSettled(state, paidAt) {
  state.principalOutstanding = 0;
  state.currentCycleInterestPaid = 0;
  state.status = 'SETTLED';
  state.settledAt = new Date(paidAt);
}

function maybeAdvanceCycle(state, snapshot, paidInterest, paidAt) {
  if (snapshot.interestOutstanding - paidInterest <= MONEY_EPSILON && snapshot.monthlyInterestAmount > 0) {
    state.lastInterestPaidAt = new Date(paidAt);
    state.dueDate = addMonthsKeepingDay(state.dueDate, 1);
    state.currentCycleInterestPaid = 0;
  }
}

function applyInterestPaymentToState(state, amount, paidAt) {
  const snapshot = calculateDebtSnapshot(state, paidAt);
  const appliedInterest = roundMoney(
    Math.min(Number(amount || 0), snapshot.interestOutstanding),
  );

  state.currentCycleInterestPaid = roundMoney(
    Number(state.currentCycleInterestPaid || 0) + appliedInterest,
  );
  maybeAdvanceCycle(state, snapshot, appliedInterest, paidAt);

  return {
    amount: appliedInterest,
    principalAmount: 0,
    interestAmount: appliedInterest,
    dailyAmount: 0,
  };
}

function applyPartialPaymentToState(state, amount, paidAt) {
  let remaining = roundMoney(amount);
  const snapshot = calculateDebtSnapshot(state, paidAt);

  const paidDaily = roundMoney(Math.min(remaining, snapshot.dailyAccruedAmount));
  remaining = roundMoney(remaining - paidDaily);

  const paidInterest = roundMoney(Math.min(remaining, snapshot.interestOutstanding));
  state.currentCycleInterestPaid = roundMoney(
    Number(state.currentCycleInterestPaid || 0) + paidInterest,
  );
  remaining = roundMoney(remaining - paidInterest);
  maybeAdvanceCycle(state, snapshot, paidInterest, paidAt);

  const paidPrincipal = roundMoney(
    Math.min(remaining, Number(state.principalOutstanding || 0)),
  );
  state.principalOutstanding = roundMoney(
    Number(state.principalOutstanding || 0) - paidPrincipal,
  );

  if (state.principalOutstanding <= MONEY_EPSILON) {
    markStateSettled(state, paidAt);
  }

  return {
    amount: roundMoney(paidDaily + paidInterest + paidPrincipal),
    principalAmount: paidPrincipal,
    interestAmount: paidInterest,
    dailyAmount: paidDaily,
  };
}

function applyTotalPaymentToState(state, paidAt) {
  const snapshot = calculateDebtSnapshot(state, paidAt);
  const breakdown = {
    amount: snapshot.totalDue,
    principalAmount: snapshot.principalOutstanding,
    interestAmount: snapshot.interestOutstanding,
    dailyAmount: snapshot.dailyAccruedAmount,
  };

  markStateSettled(state, paidAt);
  return breakdown;
}

function applyInstallmentPaymentToState(state, amount, paidAt) {
  const paidPrincipal = roundMoney(
    Math.min(Number(amount || 0), Number(state.principalOutstanding || 0)),
  );

  state.principalOutstanding = roundMoney(
    Number(state.principalOutstanding || 0) - paidPrincipal,
  );

  if (state.principalOutstanding <= MONEY_EPSILON) {
    markStateSettled(state, paidAt);
  }

  return {
    amount: paidPrincipal,
    principalAmount: paidPrincipal,
    interestAmount: 0,
    dailyAmount: 0,
  };
}

function applyPaymentToState(state, payment) {
  const paidAt = new Date(payment.paidAt || payment.createdAt || new Date());
  const type = String(payment.type || '').toUpperCase();
  const amount = Number(payment.amount || 0);

  if (type === 'JUROS') {
    return applyInterestPaymentToState(state, amount, paidAt);
  }

  if (type === 'PARCIAL') {
    return applyPartialPaymentToState(state, amount, paidAt);
  }

  if (type === 'TOTAL') {
    return applyTotalPaymentToState(state, paidAt);
  }

  if (type === 'PARCELA') {
    return applyInstallmentPaymentToState(state, amount, paidAt);
  }

  throw new Error('Tipo de pagamento invalido para simulacao');
}

function simulatePaymentsForDebt(debt, payments) {
  const state = toReplayState(debt);
  const ordered = [...payments].sort(
    (left, right) =>
      new Date(left.paidAt || left.createdAt || new Date()).getTime() -
      new Date(right.paidAt || right.createdAt || new Date()).getTime(),
  );

  const computedPayments = ordered.map((payment) => {
    const breakdown = applyPaymentToState(state, payment);
    return {
      id: payment.id,
      amount: breakdown.amount,
      principalAmount: breakdown.principalAmount,
      interestAmount: breakdown.interestAmount,
      dailyAmount: breakdown.dailyAmount,
      paidAt: new Date(payment.paidAt || payment.createdAt || new Date()),
      type: String(payment.type || '').toUpperCase(),
      installmentId: payment.installmentId || null,
      note: payment.note || null,
      receiptUrl: payment.receiptUrl || null,
    };
  });

  return {
    state,
    computedPayments,
    snapshot: calculateDebtSnapshot(state),
  };
}

function buildDebtUpdateFromState(state) {
  return {
    principalOutstanding: roundMoney(state.principalOutstanding),
    currentCycleInterestPaid: roundMoney(state.currentCycleInterestPaid),
    dueDate: new Date(state.dueDate),
    lastInterestPaidAt: state.lastInterestPaidAt ? new Date(state.lastInterestPaidAt) : null,
    status: state.status,
    settledAt: state.settledAt ? new Date(state.settledAt) : null,
  };
}

function enrichDebt(debt, now = new Date()) {
  return {
    ...debt,
    snapshot: calculateDebtSnapshot(debt, now),
  };
}

module.exports = {
  MONEY_EPSILON,
  roundMoney,
  addMonthsKeepingDay,
  calculateMonthlyInterestAmount,
  calculateOverdueDays,
  calculateDailyAccruedAmount,
  calculateDebtSnapshot,
  simulatePaymentsForDebt,
  buildDebtUpdateFromState,
  enrichDebt,
};
