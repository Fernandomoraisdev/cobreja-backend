'use strict';

// Characterization, not desired behavior. No database, network or child process
// can be reached by the production modules loaded in this test sandbox.
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const date = (day) => new Date(`${day}T12:00:00.000Z`);
const plain = (value) => JSON.parse(JSON.stringify(value));
const debt = (extra = {}) => ({
  id: 1, clientId: 1, accountId: 7, kind: 'STANDARD', debtType: 'LOAN',
  financialEngine: 'LEGACY',
  status: 'ACTIVE', principalAmount: 1000, principalOutstanding: 1000,
  monthlyInterestMode: 'PERCENTAGE', monthlyInterestValue: 10,
  dailyInterestMode: 'FIXED', dailyInterestValue: 10,
  currentCycleInterestPaid: 0, currentCycleDailyPaid: 0,
  borrowedAt: date('2026-01-01'), originalDueDate: date('2026-01-15'),
  dueDate: date('2026-01-15'), lastInterestPaidAt: null, settledAt: null,
  deletedAt: null, renegotiationId: null, ...extra,
});
const payment = (extra = {}) => ({
  id: 1, debtId: 1, clientId: 1, accountId: 7, type: 'PARCIAL', amount: 200,
  principalAmount: 0, interestAmount: 0, dailyAmount: 0,
  paidAt: date('2026-01-15'), deletedAt: null, ...extra,
});

function matches(row, where = {}) {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return value.some((part) => matches(row, part));
    const actual = row[key];
    if (value === null) return actual == null;
    if (value && typeof value === 'object') {
      return Object.entries(value).every(([op, target]) => {
        if (op === 'in') return target.includes(actual);
        if (op === 'not') return actual !== target;
        throw new Error(`Unsupported mock predicate ${key}.${op}`);
      });
    }
    return actual === value;
  });
}

// Deliberately small Prisma double: supported predicates are explicit and every
// operation is recorded. Transactions clone/rollback fixture data; this is not
// a simulation of PostgreSQL locking or isolation.
function memory(seed = {}) {
  const names = ['debt', 'payment', 'client', 'user', 'renegotiation', 'installment',
    'installmentSplit', 'paymentIntent', 'webhookLog', 'saasPaymentIntent'];
  const tables = Object.fromEntries(names.map((name) => [name, structuredClone(seed[name] || [])]));
  const calls = [];
  let depth = 0;
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const relations = {
    debt: { payments: ['payment', 'debtId'], installments: ['installment', 'debtId'] },
    renegotiation: { debts: ['debt', 'renegotiationId'], installments: ['installment', 'renegotiationId'] },
    installment: { payments: ['payment', 'installmentId'], splits: ['installmentSplit', 'installmentId'] },
  };
  function project(name, row, args = {}) {
    if (!row) return null;
    const out = structuredClone(row);
    for (const [rel, options] of Object.entries(args.include || {})) {
      const many = relations[name]?.[rel];
      if (many) out[rel] = select(many[0], { ...(options === true ? {} : options),
        where: { ...(options.where || {}), [many[1]]: row.id } });
      else if (['debt', 'client', 'installment', 'user'].includes(rel)) {
        out[rel] = project(rel, tables[rel].find((r) => r.id === row[`${rel}Id`]), options === true ? {} : options);
      } else throw new Error(`Unsupported mock relation ${name}.${rel}`);
    }
    if (args.select) return Object.fromEntries(Object.keys(args.select).map((k) => [k, out[k]]));
    return out;
  }
  function select(name, args = {}) {
    const rows = tables[name].filter((r) => matches(r, args.where));
    const order = args.orderBy ? [].concat(args.orderBy) : [];
    rows.sort((a, b) => {
      for (const entry of order) for (const [key, direction] of Object.entries(entry)) {
        if (a[key] < b[key]) return direction === 'asc' ? -1 : 1;
        if (a[key] > b[key]) return direction === 'asc' ? 1 : -1;
      }
      return 0;
    });
    return rows.map((r) => project(name, r, args));
  }
  const db = {};
  // Recording only: real locking semantics are verified by the opt-in PostgreSQL suite.
  db.$queryRaw = async (strings, ...values) => {
    assert.ok(depth > 0);
    assert.match(strings.join('?'), /FOR UPDATE/);
    calls.push({ name: 'debtLock', method: 'queryRaw', args: values, transactional: true });
    return [];
  };
  for (const name of names) {
    db[name] = {};
    for (const method of ['findFirst', 'findUnique', 'findMany', 'count', 'create', 'update', 'updateMany']) {
      db[name][method] = async (args = {}) => {
        calls.push({ name, method, args: structuredClone(args), transactional: depth > 0 });
        if (method.startsWith('find')) {
          const rows = select(name, args);
          return method === 'findMany' ? rows : rows[0] || null;
        }
        if (method === 'count') return select(name, args).length;
        if (method === 'create') {
          const row = { id: Math.max(0, ...tables[name].map((r) => r.id)) + 1,
            deletedAt: null, paidAmount: 0,
            ...(name === 'debt' ? { financialEngine: 'LEGACY' } : {}),
            ...structuredClone(args.data) };
          tables[name].push(row);
          return project(name, row, args);
        }
        const rows = tables[name].filter((r) => matches(r, args.where));
        if (method === 'update') assert.equal(rows.length, 1, `${name}.update target`);
        for (const row of rows) Object.assign(row, structuredClone(args.data));
        return method === 'updateMany' ? { count: rows.length } : project(name, rows[0], args);
      };
    }
  }
  db.$transaction = async (callback) => {
    const before = structuredClone(tables);
    depth += 1;
    try { return await callback(db); }
    catch (error) { Object.assign(tables, before); throw error; }
    finally { depth -= 1; }
  };
  db.$disconnect = async () => done();
  return { db, tables, calls, finished };
}

function sandbox(seed = {}, options = {}) {
  const mem = memory({ client: [{ id: 1, accountId: 7, userId: 10 }], ...seed });
  const now = date(options.now || '2026-01-20').getTime();
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
    static [Symbol.hasInstance](value) { return value instanceof Date; }
  }
  const logs = [];
  const context = vm.createContext({ Date: FixedDate, URLSearchParams,
    console: { log: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    process: { env: {}, platform: 'win32', exitCode: 0 },
  });
  const cache = new Map();
  const audit = [];
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    function dependency(id) {
      if (id === 'node:crypto') return require('node:crypto');
      if (id === '../prisma') return mem.db;
      if (id.endsWith('/audit.service')) return { writeAuditLog: async (event) => audit.push(event) };
      if (id.endsWith('/mercadopago.service')) return options.mp || new Proxy({}, {
        get() { throw new Error('External provider not mocked'); },
      });
      if (id.endsWith('/saas.service')) return { applySaasPaymentResult: async () => { throw new Error('Unexpected SaaS call'); } };
      if (id === 'child_process' && options.spawn) return { spawn: options.spawn };
      if (id.endsWith('/debt.service')) return load('services/debt.service.js');
      if (id.endsWith('/payment-idempotency.service')) return load('services/payment-idempotency.service.js');
      if (['./legacy-standard-engine', './legacy-money', './legacy-calendar'].includes(id)) {
        return load(`services/${id.slice(2)}.js`);
      }
      if (id.endsWith('/financial-engine-policy.service')) {
        return load('services/financial-engine-policy.service.js');
      }
      throw new Error(`Blocked dependency: ${id}`);
    }
    // Execute the unchanged CommonJS module; no source rewriting or private exports.
    const wrapper = vm.runInContext(`(function(require,module,exports){\n${fs.readFileSync(filename, 'utf8')}\n})`, context, { filename });
    wrapper(dependency, module, module.exports);
    return module.exports;
  }
  return { ...mem, load, logs, audit, context };
}

async function invoke(fn, body = {}, params = {}, user = { id: 70, role: 'ADMIN', accountId: 7 }) {
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = plain(value); return this; } };
  await fn({ body, params, user, query: {}, headers: {} }, res);
  return res;
}
const breakdown = (p) => [p.amount, p.principalAmount, p.interestAmount, p.dailyAmount];

test('payment identity is mandatory for preview and creation', async () => {
  for (const operation of ['previewPayment', 'createPayment']) {
    const h = sandbox({ debt: [debt()] });
    const response = await invoke(h.load('controllers/payment.controller.js')[operation], {
      clientId: 1, amount: 200, type: 'PARCIAL', paidAt: date('2026-01-15'),
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body.message, /debtId ou installmentId/);
    assert.equal(h.tables.payment.length, 0);
  }
});

test('partial payment changes only the explicitly selected debt of the same client', async () => {
  const h = sandbox({ debt: [
    debt({ id: 1, monthlyInterestValue: 0, dailyInterestValue: 0 }),
    debt({ id: 2, monthlyInterestValue: 0, dailyInterestValue: 0 }),
  ] });
  const response = await invoke(h.load('controllers/payment.controller.js').createPayment, {
    clientId: 1, debtId: 1, amount: 200, type: 'PARCIAL', paidAt: date('2026-01-15'),
  });
  assert.equal(response.statusCode, 201);
  assert.equal(h.tables.payment[0].debtId, 1);
  assert.deepEqual(h.tables.debt.map((item) => item.principalOutstanding), [800, 1000]);
});

test('duplicated and edited debt remains isolated when original debt is paid', async () => {
  const h = sandbox({ debt: [
    debt({ id: 1, title: 'Original', monthlyInterestValue: 0, dailyInterestValue: 0 }),
    debt({ id: 2, title: 'Duplicada editada', principalAmount: 1375,
      principalOutstanding: 1375, monthlyInterestValue: 0, dailyInterestValue: 0 }),
  ] });
  const response = await invoke(h.load('controllers/payment.controller.js').createPayment, {
    clientId: 1, debtId: 1, amount: 200, type: 'PARCIAL', paidAt: date('2026-01-15'),
  });
  assert.equal(response.statusCode, 201);
  assert.equal(h.tables.debt[0].principalOutstanding, 800);
  assert.equal(h.tables.debt[1].principalOutstanding, 1375);
  assert.equal(h.tables.debt[1].title, 'Duplicada editada');
});

test('payment on duplicated debt leaves original debt intact', async () => {
  const h = sandbox({ debt: [
    debt({ id: 1, monthlyInterestValue: 0, dailyInterestValue: 0 }),
    debt({ id: 2, principalAmount: 1375, principalOutstanding: 1375,
      monthlyInterestValue: 0, dailyInterestValue: 0 }),
  ] });
  const response = await invoke(h.load('controllers/payment.controller.js').createPayment, {
    clientId: 1, debtId: 2, amount: 200, type: 'PARCIAL', paidAt: date('2026-01-15'),
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(h.tables.debt.map((item) => item.principalOutstanding), [1000, 1175]);
});

test('multiple partial payments are replayed once and preserve cents', async () => {
  const h = sandbox({ debt: [debt({ principalAmount: 1000.01,
    principalOutstanding: 1000.01, monthlyInterestValue: 0, dailyInterestValue: 0 })] });
  const controller = h.load('controllers/payment.controller.js');
  for (const amount of [100, 150, 200, 123.47, 49.99]) {
    const response = await invoke(controller.createPayment, {
      clientId: 1, debtId: 1, amount, type: 'PARCIAL', paidAt: date('2026-01-15'),
    });
    assert.equal(response.statusCode, 201);
  }
  assert.equal(h.tables.payment.length, 5);
  assert.equal(h.tables.debt[0].principalOutstanding, 376.55);
  assert.equal(h.tables.payment.reduce((sum, item) => sum + item.principalAmount, 0), 623.46);
});

test('total payment settles only its debt and stops future daily charges', async () => {
  const h = sandbox({ debt: [debt({ id: 1 }), debt({ id: 2 })] });
  const response = await invoke(h.load('controllers/payment.controller.js').createPayment, {
    clientId: 1, debtId: 1, amount: 1150, type: 'TOTAL', paidAt: date('2026-01-20'),
  });
  assert.equal(response.statusCode, 201);
  assert.equal(h.tables.debt[0].status, 'SETTLED');
  assert.equal(h.tables.debt[0].principalOutstanding, 0);
  assert.equal(h.tables.debt[1].status, 'ACTIVE');
  assert.equal(h.tables.debt[1].principalOutstanding, 1000);
  assert.equal(h.load('services/debt.service.js')
    .calculateDebtSnapshot(h.tables.debt[0], date('2026-02-20')).totalDue, 0);
});

test('update and delete replay only the payment debt', async () => {
  const h = sandbox({ debt: [
    debt({ id: 1, monthlyInterestValue: 0, dailyInterestValue: 0,
      principalOutstanding: 800 }),
    debt({ id: 2, monthlyInterestValue: 0, dailyInterestValue: 0 }),
  ], payment: [payment({ id: 1, amount: 200, principalAmount: 200 })] });
  const controller = h.load('controllers/payment.controller.js');
  let response = await invoke(controller.updatePayment, { amount: 300 }, { id: '1' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(h.tables.debt.map((item) => item.principalOutstanding), [700, 1000]);
  response = await invoke(controller.deletePayment, {}, { id: '1' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(h.tables.debt.map((item) => item.principalOutstanding), [1000, 1000]);
});

test('partial payment applies daily then monthly interest then principal', () => {
  const service = sandbox().load('services/debt.service.js');
  const result = service.simulatePaymentsForDebt(debt(), [payment({
    amount: 250, paidAt: date('2026-01-20'),
  })], date('2026-01-20'), [1]);
  assert.deepEqual(breakdown(result.computedPayments[0]), [250, 100, 100, 50]);
  assert.equal(result.state.principalOutstanding, 900);
});

test('retroactive preview reports the draft instead of a later existing payment', async () => {
  const h = sandbox({ debt: [debt({ monthlyInterestValue: 0, dailyInterestValue: 0 })], payment: [
    payment({ id: 9, type: 'PARCIAL', amount: 100, principalAmount: 100, paidAt: date('2026-01-20') }),
  ] });
  const before = plain(h.tables);
  const response = await invoke(h.load('controllers/payment.controller.js').previewPayment, {
    clientId: 1, debtId: 1, amount: 300, type: 'PARCIAL', paidAt: date('2026-01-15'),
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.payments[0].id, 2147483000);
  assert.deepEqual(breakdown(response.body.data.applied), [300, 300, 0, 0]);
  assert.deepEqual(plain(h.tables), before);
});

test('installment and explicit debt identifiers must refer to the same debt', async () => {
  const h = sandbox({
    debt: [debt({ id: 1 }), debt({ id: 2 })],
    installment: [{ id: 50, debtId: 2, clientId: 1, accountId: 7,
      amount: 100, paidAmount: 0, status: 'PENDING', dueDate: date('2026-02-15') }],
  });
  const response = await invoke(h.load('controllers/payment.controller.js').createPayment, {
    clientId: 1, debtId: 1, installmentId: 50, amount: 100,
    type: 'PARCELA', paidAt: date('2026-01-15'),
  });
  assert.equal(response.statusCode, 404);
  assert.equal(h.tables.payment.length, 0);
  assert.deepEqual(h.tables.debt.map((item) => item.principalOutstanding), [1000, 1000]);
});

test('economic editing cannot reprice formed obligations or old payment allocations', async () => {
  const h = sandbox({
    debt: [
      debt({ id: 1, monthlyInterestValue: 0, dailyInterestValue: 0,
        principalOutstanding: 800 }),
      debt({ id: 2, principalAmount: 1375, principalOutstanding: 1375,
        monthlyInterestValue: 0, dailyInterestValue: 0 }),
    ],
    payment: [payment({ id: 1, principalAmount: 0, interestAmount: 200 })],
  });
  const response = await invoke(h.load('controllers/debt.controller.js').updateDebt, {
    principalAmount: 1200,
  }, { id: '1' });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'PROSPECTIVE_RULE_VERSION_REQUIRED');
  assert.equal(h.tables.debt[0].principalAmount, 1000);
  assert.equal(h.tables.debt[0].principalOutstanding, 800);
  assert.equal(h.tables.payment[0].principalAmount, 0);
  assert.equal(h.tables.payment[0].interestAmount, 200);
  assert.equal(h.tables.debt[1].principalOutstanding, 1375);
  assert.ok(h.calls.filter((call) => call.method === 'update')
    .every((call) => call.transactional));
});

test('dashboard counts each persisted payment once across multiple debts', () => {
  const service = sandbox().load('services/dashboard.service.js');
  const clients = [{ id: 1, status: 'ACTIVE', debts: [
    debt({ id: 1, monthlyInterestValue: 0, dailyInterestValue: 0 }),
    debt({ id: 2, monthlyInterestValue: 0, dailyInterestValue: 0 }),
  ] }];
  const summary = service.buildDashboardSummary(clients, [
    payment({ id: 1, debtId: 1, amount: 200, principalAmount: 200 }),
  ], date('2026-01-15'));
  assert.equal(summary.totalReceived, 200);
  assert.equal(summary.totalProfit, 0);
  assert.equal(summary.totalToReceive, 2000);
});

for (const operation of ['previewPayment', 'createPayment']) {
  test(`${operation} rejects overpayment without truncating or changing either debt`, async () => {
    const h = sandbox({ debt: [debt({ principalAmount: 700, principalOutstanding: 700, monthlyInterestValue: 0, dailyInterestValue: 0 }), debt({ id: 2 })] });
    const before = plain(h.tables);
    const response = await invoke(h.load('controllers/payment.controller.js')[operation], {
      clientId: 1, debtId: 1, amount: 800, type: 'PARCIAL', paidAt: date('2026-01-15'),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'OVERPAYMENT');
    assert.equal(response.body.data.maximum, '700.00');
    assert.deepEqual(plain(h.tables), before);
  });
}
test('new payment never rewrites valid historical decomposition', async () => {
  const h = sandbox({ debt: [debt({ principalOutstanding: 800 })], payment: [
    payment({ amount: 200, principalAmount: 200, interestAmount: 0, dailyAmount: 0 }),
  ] });
  const original = plain(h.tables.payment[0]);
  const response = await invoke(h.load('controllers/payment.controller.js').createPayment, {
    clientId: 1, debtId: 1, amount: 50, type: 'PARCIAL', paidAt: date('2026-01-16'),
  });
  assert.equal(response.statusCode, 201);
  assert.deepEqual(plain(h.tables.payment[0]), original);
  assert.equal(h.calls.filter(call => call.name === 'payment' && call.method === 'update' && call.args?.where?.id === 1).length, 0);
});
test('ambiguous historical decomposition blocks a new payment and rolls it back', async () => {
  const h = sandbox({ debt: [debt({ monthlyInterestValue: 0, dailyInterestValue: 0, principalOutstanding: 800 })],
    payment: [payment({ amount: 200, principalAmount: 0, interestAmount: 0, dailyAmount: 0 })] });
  const before = plain(h.tables);
  const response = await invoke(h.load('controllers/payment.controller.js').createPayment, {
    clientId: 1, debtId: 1, amount: 50, type: 'PARCIAL', paidAt: date('2026-01-16'),
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'HISTORY_RECONCILIATION_REQUIRED');
  assert.deepEqual(plain(h.tables), before);
});
test('title-only edit keeps historical payment and other debts unchanged', async () => {
  const h = sandbox({ debt: [debt({ principalOutstanding: 800, monthlyInterestValue: 0, dailyInterestValue: 0 }), debt({ id: 2 })],
    payment: [payment({ amount: 200, principalAmount: 200 })] });
  const original = plain(h.tables.payment[0]);
  const other = plain(h.tables.debt[1]);
  const originalDebt = plain(h.tables.debt[0]);
  const response = await invoke(h.load('controllers/debt.controller.js').updateDebt, { title: 'Fixture local' }, { id: '1' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(plain(h.tables.payment[0]), original);
  assert.deepEqual(plain(h.tables.debt[1]), other);
  assert.deepEqual(plain(h.tables.debt[0]), { ...originalDebt, title: 'Fixture local' });
  assert.equal(response.body.data.snapshot.principalOutstanding, 800);
});
test('retroactive draft conflicting with a later full payment rejects without rewriting history', async () => {
  const h = sandbox({ debt: [debt()], payment: [payment({ type: 'TOTAL', amount: 1150,
    principalAmount: 1000, interestAmount: 100, dailyAmount: 50, paidAt: date('2026-01-20') })] });
  const before = plain(h.tables);
  const response = await invoke(h.load('controllers/payment.controller.js').previewPayment, {
    clientId: 1, debtId: 1, amount: 300, type: 'PARCIAL', paidAt: date('2026-01-15'),
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'OVERPAYMENT');
  assert.deepEqual(plain(h.tables), before);
});
test('missing payment history never falls back to aggregate balance for STANDARD', () => {
  const service = sandbox().load('services/debt.service.js');
  assert.throws(() => service.calculateDebtSnapshot(debt({ principalOutstanding: 800 })), /LEGACY_HISTORY_REQUIRED/);
});
test('Mercado Pago stays explicitly on its prior compatibility calculation', () => {
  const service = sandbox().load('services/debt.service.js');
  assert.equal(service.compatibility.calculateDebtSnapshot(debt(), date('2026-03-15')).interestOutstanding, 100);
  assert.equal(service.calculateDebtSnapshot(debt(), date('2026-03-15')).interestOutstanding, 300);
});

test('current persisted settled loans are never reopened by a snapshot read', () => {
  const service = sandbox().load('services/debt.service.js');
  const snapshot = service.calculateDebtSnapshot(debt({ status: 'SETTLED', settledAt: date('2026-01-15'), principalOutstanding: 0,
    payments: [payment({ amount: 1000, principalAmount: 1000 })] }), date('2026-03-15'));
  assert.equal(snapshot.totalDue, 0);
  assert.equal(snapshot.isSettled, true);
});
test('invalid administrative contract creation rolls back its new debt', async () => {
  const h = sandbox();
  const before = plain(h.tables);
  const response = await invoke(h.load('controllers/debt.controller.js').createDebt, {
    clientId: 1, principalAmount: 5000, borrowedAt: date('2026-01-15'), dueDate: date('2026-01-14'),
    monthlyInterestMode: 'PERCENTAGE', monthlyInterestValue: 40,
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'INVALID_CONTRACT_DATES');
  assert.deepEqual(plain(h.tables), before);
});
test('administrative loan creation uses corrected backend snapshot before transaction commits', async () => {
  const h = sandbox();
  const response = await invoke(h.load('controllers/debt.controller.js').createDebt, {
    clientId: 1, principalAmount: 5000, borrowedAt: date('2026-01-15'), dueDate: date('2026-02-15'),
    monthlyInterestMode: 'PERCENTAGE', monthlyInterestValue: 40,
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.body.data.snapshot.totalDue, 7000);
  assert.equal(h.tables.debt.length, 1);
  assert.ok(h.calls.find(call => call.name === 'debt' && call.method === 'create').transactional);
});

test('future-dated payment cannot commit without recognized allocation', async () => {
  const h = sandbox({ debt: [debt()] });
  const before = plain(h.tables);
  const response = await invoke(h.load('controllers/payment.controller.js').createPayment, {
    clientId: 1, debtId: 1, amount: 100, type: 'PARCIAL', paidAt: date('2026-01-21'),
  });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'FUTURE_PAYMENT_NOT_ALLOWED');
  assert.deepEqual(plain(h.tables), before);
});

test('changing a payment type cannot retain an incompatible old allocation', async () => {
  const h = sandbox({ debt: [debt({ principalOutstanding: 800 })], payment: [payment({ amount: 200, principalAmount: 200 })] });
  const before = plain(h.tables);
  const response = await invoke(h.load('controllers/payment.controller.js').updatePayment, { type: 'JUROS' }, { id: '1' });
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, 'OVERPAYMENT');
  assert.deepEqual(plain(h.tables), before);
});
