'use strict';

// Explicit opt-in: the ordinary suite never reads credentials or reaches PostgreSQL.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const enabled = process.env.LEGACY_POSTGRES_TEST === '1';
if (!enabled) {
  test('real PostgreSQL LEGACY homologation requires explicit local opt-in', { skip: true }, () => {});
} else {
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync, spawn } = require('node:child_process');
  const { randomBytes, createHash } = require('node:crypto');
  const { PrismaClient } = require('@prisma/client');
  const express = require('express');
  const root = path.resolve(__dirname, '..');
  // All migrations, including Wave 1.2, are restricted to this disposable prefix.
  const database = `legacy_wave12_${process.pid}_${randomBytes(4).toString('hex')}`;
  const RealDate = Date;
  let clock = '2026-10-06T15:00:00.000Z';
  class ClockDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return new RealDate(clock).getTime(); }
  }
  let admin, db, server, base, account, user, token, databaseUrl, created = false;
  let historicalBefore, historicalDebt, migrationCopy, historicalClientId, historicalPortfolio, historicalChecksum;
  const checksum = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const historicalRows = () => db.debt.findMany({ where: { clientId: historicalClientId }, orderBy: { id: 'asc' },
    include: { payments: { orderBy: { id: 'asc' } } } });
  const day = value => new RealDate(`${value}T12:00:00Z`);
  async function debt(client, principal = 1000, extra = {}) {
    return db.debt.create({ data: {
      accountId: account.id, clientId: client.id, principalAmount: principal,
      principalOutstanding: principal, borrowedAt: day('2026-07-23'),
      originalDueDate: day('2026-08-23'), dueDate: day('2026-08-23'),
      monthlyInterestMode: 'FIXED', monthlyInterestValue: 0,
      dailyInterestMode: 'FIXED', dailyInterestValue: 0, ...extra,
    } });
  }
  async function client(name) { return db.client.create({ data: { name: `ARTIFICIAL ${name}`, accountId: account.id } }); }
  async function pay(d, amount, extra = {}) {
    const { idempotencyKey, token: auth = token, endpoint = base, ...body } = extra;
    const response = await fetch(`${endpoint}/api/payment`, {
      method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: JSON.stringify({ clientId: d.clientId, debtId: d.id, amount, type: 'PARCIAL', paidAt: clock, ...body }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function secondInstance() {
    const code = `
      const url = new URL(process.env.DATABASE_URL);
      if (url.hostname !== 'localhost' || url.port !== '5432' || !/^\\/legacy_wave12_[a-z0-9_]+$/.test(url.pathname)) process.exit(2);
      const RealDate = Date;
      global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : ['2026-10-06T15:00:00Z'])); } static now() { return new RealDate('2026-10-06T15:00:00Z').getTime(); } };
      const app = require('express')(); app.use(require('express').json());
      app.use('/api/payment', require('./routes/payment.routes'));
      const server = app.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
      process.on('message', () => server.close(async () => { await require('./prisma').$disconnect(); process.exit(0); }));
    `;
    const child = spawn(process.execPath, ['-e', code], { cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('isolated second instance timeout')); }, 10000);
      child.once('message', message => { clearTimeout(timer); resolve(message.port); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`isolated second instance exited ${code}`)); });
    });
    return { endpoint: `http://127.0.0.1:${port}`, close: async () => {
      await new Promise(resolve => { child.once('exit', resolve); child.send('close'); });
    } };
  }
  async function facts(d) {
    const row = await db.debt.findUnique({ where: { id: d.id }, include: { installments: true,
      payments: { where: { deletedAt: null }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }] } } });
    return { row, snapshot: require('../services/debt.service').calculateDebtSnapshot(row, new ClockDate()) };
  }
  before(async () => {
    const config = require('dotenv').parse(fs.readFileSync('E:/cobreja/backend/.env'));
    const url = new URL(config.DATABASE_URL);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.equal(url.port, '5432');
    url.pathname = '/postgres'; url.search = '?schema=public';
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    const [identity] = await admin.$queryRawUnsafe('SELECT inet_server_addr()::text AS address, inet_server_port() AS port, version() AS version');
    assert.ok(['127.0.0.1/32', '127.0.0.1', '::1', '::1/128'].includes(identity.address));
    assert.equal(identity.port, 5432); assert.match(identity.version, /^PostgreSQL 18\./);
    console.log(`LOCAL VERIFIED ${identity.address}:5432 PostgreSQL 18; disposable database ${database}`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${database}"`); created = true;
    url.pathname = `/${database}`;
    databaseUrl = url.toString();
    // Prepare the pre-additive schema, persist an old unkeyed Payment, then apply the new migration.
    const os = require('node:os');
    migrationCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-wave12-schema-'));
    fs.copyFileSync(path.join(root, 'prisma/schema.prisma'), path.join(migrationCopy, 'schema.prisma'));
    fs.mkdirSync(path.join(migrationCopy, 'migrations'));
    for (const name of fs.readdirSync(path.join(root, 'prisma/migrations'))) {
      if (name === '20261007120000_payment_creation_idempotency') continue;
      fs.cpSync(path.join(root, 'prisma/migrations', name), path.join(migrationCopy, 'migrations', name), { recursive: true });
    }
    const prior = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'),
      'migrate', 'deploy', '--schema', path.join(migrationCopy, 'schema.prisma')], {
      env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 120000,
    });
    assert.equal(prior.status, 0, 'pre-additive disposable migration preparation failed (output withheld)');
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const oldAccount = await db.account.create({ data: { name: 'ARTIFICIAL pre-migration account' } });
    const oldClient = await db.client.create({ data: { name: 'ARTIFICIAL historical client', accountId: oldAccount.id } });
    historicalDebt = await db.debt.create({ data: { accountId: oldAccount.id, clientId: oldClient.id,
      principalAmount: 50, principalOutstanding: 40, borrowedAt: day('2026-07-23'),
      originalDueDate: day('2026-08-23'), dueDate: day('2026-08-23') } });
    await db.payment.create({ data: { accountId: oldAccount.id, clientId: oldClient.id, debtId: historicalDebt.id,
      type: 'PARCIAL', amount: 10, principalAmount: 10, paidAt: day('2026-08-23') } });
    historicalBefore = await db.debt.findUnique({ where: { id: historicalDebt.id }, include: { payments: true } });
    historicalClientId = oldClient.id;
    for (const [principal, paid, status] of [[20.55, 20.55, 'SETTLED'], [33.33, 1.11, 'ACTIVE']]) {
      const row = await db.debt.create({ data: { accountId: oldAccount.id, clientId: oldClient.id,
        principalAmount: principal, principalOutstanding: Number((principal - paid).toFixed(2)), status,
        borrowedAt: day('2026-07-23'), originalDueDate: day('2026-08-23'), dueDate: day('2026-08-23') } });
      await db.payment.create({ data: { accountId: oldAccount.id, clientId: oldClient.id, debtId: row.id,
        type: status === 'SETTLED' ? 'TOTAL' : 'PARCIAL', amount: paid, principalAmount: paid, paidAt: day('2026-08-23') } });
    }
    historicalPortfolio = await historicalRows();
    historicalChecksum = checksum(historicalPortfolio);
    // Invoke Node explicitly, never npx or the repository's prisma.js.
    const migrated = spawnSync(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'),
      'migrate', 'deploy', '--schema', path.join(root, 'prisma/schema.prisma')], {
      env: { ...process.env, DATABASE_URL: url.toString() }, encoding: 'utf8', timeout: 120000,
    });
    assert.equal(migrated.status, 0, 'isolated local migration preparation failed (output withheld)');
    const [dest] = await db.$queryRawUnsafe('SELECT current_database() AS name');
    assert.equal(dest.name, database);
    // Widen the real transaction overlap so races are not hidden by fast hardware.
    await db.$executeRawUnsafe('CREATE FUNCTION wave11_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.03); RETURN NEW; END $$');
    await db.$executeRawUnsafe('CREATE TRIGGER wave11_delay BEFORE INSERT ON "Payment" FOR EACH ROW EXECUTE FUNCTION wave11_delay()');
    account = await db.account.create({ data: { name: 'ARTIFICIAL Wave 1.1 disposable tenant' } });
    user = await db.user.create({ data: { accountId: account.id, role: 'ADMIN',
      email: 'wave11@example.invalid', password: 'not-a-login-credential' } });
    process.env.JWT_SECRET = randomBytes(32).toString('hex');
    require.cache[require.resolve('../prisma')] = { id: require.resolve('../prisma'), filename: require.resolve('../prisma'), loaded: true, exports: db };
    token = require('../utils/auth').signAuthToken(user);
    global.Date = ClockDate;
    const app = express(); app.use(express.json()); app.use('/api/payment', require('../routes/payment.routes'));
    // Test-only observation endpoint, never registered by application startup.
    app.get('/__wave13/state/:id', async (req, res) => {
      if (req.get('authorization') !== `Bearer ${token}`) return res.sendStatus(401);
      const id = Number(req.params.id);
      const row = await db.debt.findFirst({ where: { id, accountId: account.id } });
      if (!row) return res.sendStatus(404);
      const state = await facts(row);
      res.json({ payments: state.row.payments.length,
        operations: await db.paymentCreationOperation.count({ where: { debtId: id } }),
        principal: state.snapshot.principalOutstanding });
    });
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    global.Date = RealDate;
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) {
      if (account) console.log(`ARTIFICIAL FIXTURES clients=${await db.client.count()} debts=${await db.debt.count()} payments=${await db.payment.count()}`);
      await db.$disconnect();
    }
    if (created) { await admin.$executeRawUnsafe(`DROP DATABASE "${database}" WITH (FORCE)`); console.log(`CLEANUP dropped ${database}`); }
    if (admin) await admin.$disconnect();
    if (migrationCopy) {
      const resolved = path.resolve(migrationCopy);
      assert.equal(path.dirname(resolved), path.resolve(require('node:os').tmpdir()));
      assert.ok(path.basename(resolved).startsWith('legacy-wave12-schema-'));
      fs.rmSync(resolved, { recursive: true });
    }
  });
  test('PostgreSQL: scenario 5000 / two cycles / 44 daily events reconciles separately to 12080', async () => {
    const d = await debt(await client('B'), 5000, { monthlyInterestMode: 'PERCENTAGE', monthlyInterestValue: 40,
      dailyInterestMode: 'PERCENTAGE', dailyInterestValue: 1 });
    const r = await fetch(`${base}/api/payment/preview`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: d.clientId, debtId: d.id, amount: 0.01, type: 'PARCIAL', paidAt: clock }) });
    assert.equal(r.status, 200);
    const { snapshot: s } = await facts(d);
    assert.equal(s.principalOutstanding, 5000); assert.equal(s.interestOutstanding, 4000);
    assert.equal(s.dailyAccruedAmount, 3080); assert.equal(s.totalDue, 12080);
    assert.deepEqual(s.financialComponents.cycles.map(c => c.amount), ['2000.00', '2000.00']);
    assert.equal(s.financialComponents.dailyBase, '7000.00');
    assert.equal(s.financialComponents.dailies.length, 44);
    assert.ok(s.financialComponents.dailies.every(c => c.amount === '70.00'));
    assert.equal(await db.payment.count({ where: { debtId: d.id } }), 0);
  });
  test('PostgreSQL: two simultaneous affordable payments keep both confirmed payments and consistent projection', async () => {
    const d = await debt(await client('C'));
    const results = await Promise.all([pay(d, 100), pay(d, 200)]);
    assert.deepEqual(results.map(r => r.status), [201, 201]);
    const { row, snapshot } = await facts(d);
    assert.equal(row.payments.length, 2); assert.equal(row.principalOutstanding, 700);
    assert.equal(snapshot.totalDue, 700);
    assert.equal(row.payments.reduce((n, p) => n + p.principalAmount, 0), 300);
  });
  test('PostgreSQL: combined concurrent overpayment admits one operation and fully rolls back the loser', async () => {
    for (let round = 0; round < 5; round++) {
      const d = await debt(await client(`combined excess ${round}`), 100);
      const results = await Promise.all([pay(d, 80), pay(d, 80)]);
      assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
      const { row, snapshot } = await facts(d);
      assert.equal(row.payments.length, 1); assert.equal(row.principalOutstanding, 20); assert.equal(snapshot.totalDue, 20);
      assert.equal(await db.auditLog.count({ where: { entity: 'Payment', metadata: { path: ['debtId'], equals: d.id } } }), 1);
    }
  });
  test('PostgreSQL: concurrent payments on two debts of the same client never cross debt identity', async () => {
    const c = await client('A'); const a = await debt(c, 1000); const b = await debt(c, 2000);
    assert.deepEqual((await Promise.all([pay(a, 100), pay(b, 250)])).map(r => r.status), [201, 201]);
    const aa = await facts(a), bb = await facts(b);
    assert.equal(aa.snapshot.totalDue, 900); assert.equal(bb.snapshot.totalDue, 1750);
    assert.ok(aa.row.payments.every(p => p.debtId === a.id)); assert.ok(bb.row.payments.every(p => p.debtId === b.id));
  });
  test('PostgreSQL: payment concurrent with repeatable-read snapshot never exposes partial transaction', async () => {
    const d = await debt(await client('read overlap'), 100);
    const reading = db.$transaction(async tx => {
      const row = await tx.debt.findUnique({ where: { id: d.id }, include: { payments: true } });
      await tx.$queryRawUnsafe('SELECT 1 AS value FROM pg_sleep(0.05)');
      const count = await tx.payment.count({ where: { debtId: d.id } });
      return { row, count };
    }, { isolationLevel: 'RepeatableRead' });
    const [read, result] = await Promise.all([reading, pay(d, 10)]);
    assert.equal(result.status, 201);
    assert.equal(read.count, read.row.payments.length);
    assert.ok(read.row.principalOutstanding === 100 || read.row.principalOutstanding === 90);
    assert.equal((await facts(d)).snapshot.totalDue, 90);
  });
  test('PostgreSQL: injected database failure after Payment insert rolls back every financial write', async () => {
    const d = await debt(await client('rollback'), 100);
    const before = await db.debt.findUnique({ where: { id: d.id } });
    await db.$executeRawUnsafe(`CREATE FUNCTION wave11_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = ${d.id} THEN RAISE EXCEPTION 'ARTIFICIAL_CONTROLLED_FAILURE'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER wave11_failure BEFORE UPDATE ON "Debt" FOR EACH ROW EXECUTE FUNCTION wave11_fail()');
    try {
      assert.equal((await pay(d, 10)).status, 500);
      assert.deepEqual(await db.debt.findUnique({ where: { id: d.id } }), before);
      assert.equal(await db.payment.count({ where: { debtId: d.id } }), 0);
      assert.equal(await db.auditLog.count({ where: { entity: 'Payment', metadata: { path: ['debtId'], equals: d.id } } }), 0);
    } finally { await db.$executeRawUnsafe('DROP TRIGGER wave11_failure ON "Debt"'); await db.$executeRawUnsafe('DROP FUNCTION wave11_fail()'); }
  });
  test('PostgreSQL: 0.01 / 0.05 / 10.01 / 80.25 preserve exact cents in persisted allocation', async () => {
    const d = await debt(await client('cents'), 100);
    const money = require('../services/legacy-money');
    for (const amount of [0.01, 0.05, 10.01, 80.25]) assert.equal((await pay(d, amount)).status, 201);
    const { row, snapshot } = await facts(d);
    assert.equal(snapshot.totalDue, 9.68); assert.equal(row.principalOutstanding, 9.68);
    assert.equal(row.payments.reduce((n, p) => n + money.cents(p.principalAmount), 0n), 9032n);
  });
  test('PostgreSQL: fractional-cent percentage rounds per event across monthly cycles', async () => {
    const d = await debt(await client('fractional cents'), 0.05, { monthlyInterestMode: 'PERCENTAGE', monthlyInterestValue: 10 });
    const { snapshot } = await facts(d);
    assert.equal(snapshot.interestOutstanding, 0.02); assert.equal(snapshot.totalDue, 0.07);
    assert.equal((await pay(d, 0.01)).status, 201);
    const { row, snapshot: after } = await facts(d);
    assert.equal(row.payments[0].interestAmount, 0.01); assert.equal(after.totalDue, 0.06);
  });
  test('PostgreSQL: payment changes only prospective daily base, including its own midnight', async () => {
    clock = '2026-08-24T18:00:00Z';
    try {
      const d = await debt(await client('prospective'), 5000, { monthlyInterestMode: 'PERCENTAGE', monthlyInterestValue: 40,
        dailyInterestMode: 'PERCENTAGE', dailyInterestValue: 1 });
      assert.equal((await pay(d, 3070)).status, 201);
      clock = '2026-08-25T15:00:00Z';
      const { snapshot } = await facts(d);
      assert.deepEqual(snapshot.financialComponents.dailies.map(c => c.amount), ['70.00', '40.00']);
      assert.equal(snapshot.financialComponents.dailyBase, '4000.00');
      clock = '2026-09-24T15:00:00Z';
      const future = (await facts(d)).snapshot;
      assert.equal(future.financialComponents.cycles[1].amount, '1600.00');
      assert.equal(future.financialComponents.dailyBase, '5600.00');
      assert.equal(future.financialComponents.dailies.at(-1).amount, '56.00');
    } finally { clock = '2026-10-06T15:00:00Z'; }
  });
  test('PostgreSQL: repeated HTTP request with Idempotency-Key preserves its original payment and response', async () => {
    const d = await debt(await client('repeat'), 100);
    const original = await pay(d, 10, { idempotencyKey: 'artificial-same-request' });
    const repeat = await pay(d, 10, { idempotencyKey: 'artificial-same-request' });
    assert.equal(original.status, 201); assert.equal(repeat.status, 201);
    assert.deepEqual(repeat.body, original.body);
    assert.equal((await facts(d)).row.payments.length, 1);
    assert.equal((await facts(d)).snapshot.totalDue, 90);
  });
  test('PostgreSQL: real HTTP preview concurrent with payment returns an internally coherent committed state', async () => {
    const d = await debt(await client('HTTP read overlap'), 100);
    const request = fetch(`${base}/api/payment/preview`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: d.clientId, debtId: d.id, amount: 1, type: 'PARCIAL', paidAt: clock }) });
    const [response, payment] = await Promise.all([request, pay(d, 10)]);
    assert.equal(payment.status, 201); assert.equal(response.status, 200);
    const preview = (await response.json()).data;
    assert.equal(preview.debt.id, d.id);
    assert.ok([100, 90].includes(preview.before.totalDue));
    assert.equal(preview.after.totalDue, preview.before.totalDue - 1);
    assert.equal((await facts(d)).snapshot.totalDue, 90);
  });
  test('PostgreSQL: concurrent creation and explicit payment update retain both effects', async () => {
    const d = await debt(await client('create update'), 100);
    const first = await pay(d, 10); const id = first.body.data.id;
    const update = fetch(`${base}/api/payment/${id}`, { method: 'PUT', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ amount: 20 }) });
    const [response, createdPayment] = await Promise.all([update, pay(d, 10)]);
    assert.equal(response.status, 200); assert.equal(createdPayment.status, 201);
    const { row, snapshot } = await facts(d);
    assert.equal(row.payments.length, 2); assert.equal(row.principalOutstanding, 70); assert.equal(snapshot.totalDue, 70);
  });
  test('PostgreSQL: concurrent creation and explicit payment deletion retain both effects', async () => {
    const d = await debt(await client('create delete'), 100);
    const first = await pay(d, 10); const id = first.body.data.id;
    const deletion = fetch(`${base}/api/payment/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    const [response, createdPayment] = await Promise.all([deletion, pay(d, 20)]);
    assert.equal(response.status, 200); assert.equal(createdPayment.status, 201);
    const { row, snapshot } = await facts(d);
    assert.equal(row.payments.length, 1); assert.equal(row.principalOutstanding, 80); assert.equal(snapshot.totalDue, 80);
    assert.ok((await db.payment.findUnique({ where: { id } })).deletedAt);
  });
  test('PostgreSQL: additive migration preserves all historical unkeyed Payment and Debt values and timestamps', async () => {
    const afterMigration = await db.debt.findUnique({ where: { id: historicalDebt.id }, include: { payments: true } });
    // Compare persisted values/ISO timestamps, not Date versus the test clock subclass prototype.
    assert.deepEqual(JSON.parse(JSON.stringify(afterMigration)), JSON.parse(JSON.stringify(historicalBefore)));
    assert.equal(await db.paymentCreationOperation.count({ where: { debtId: historicalDebt.id } }), 0);
  });

  test('PostgreSQL: additive migration preserves checksum of multi-debt cents/open/settled portfolio and creates expected constraints', async () => {
    const rows = await historicalRows();
    assert.equal(rows.length, 3);
    assert.equal(rows.reduce((count, row) => count + row.payments.length, 0), 3);
    assert.equal(rows.filter(row => row.status === 'SETTLED').length, 1);
    assert.equal(checksum(rows), historicalChecksum);
    assert.deepEqual(JSON.parse(JSON.stringify(rows)), JSON.parse(JSON.stringify(historicalPortfolio)));
    const constraints = await db.$queryRawUnsafe(`SELECT conname, contype FROM pg_constraint WHERE conrelid = '"PaymentCreationOperation"'::regclass ORDER BY conname`);
    assert.deepEqual(constraints.filter(row => ['p', 'f'].includes(row.contype)).map(row => row.conname), [
      'PaymentCreationOperation_accountId_fkey', 'PaymentCreationOperation_debtId_fkey', 'PaymentCreationOperation_pkey',
    ]);
    // PostgreSQL 18 also exposes NOT NULL constraints in pg_constraint.
    assert.equal(constraints.filter(row => row.contype === 'n').length, 7);
    const indexes = await db.$queryRawUnsafe(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'PaymentCreationOperation'`);
    assert.ok(indexes.some(row => row.indexname === 'PaymentCreationOperation_accountId_debtId_key_key' && /CREATE UNIQUE INDEX/.test(row.indexdef)));
    console.log(`MIGRATION HISTORICAL SHA256 ${historicalChecksum}; 3 Debts / 3 Payments unchanged`);
  });

  test('PostgreSQL: Flutter ApiService lost response retries exact intention; one 100 Payment then a distinct 50 Payment', { timeout: 150000 }, async () => {
    const d = await debt(await client('frontend Wave 1.3A E2E'), 1000);
    const frontend = path.resolve(root, '../production-hotfix-frontend');
    assert.equal(frontend, 'E:\\cobreja\\production-hotfix-frontend');
    const result = await new Promise((resolve, reject) => {
      const child = spawn('C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c',
        'C:\\src\\flutter\\bin\\flutter.bat test --no-pub test/manual_payment_e2e_test.dart --reporter expanded'], {
        cwd: frontend, env: { ...process.env, MANUAL_PAYMENT_E2E: '1', MANUAL_PAYMENT_E2E_BASE: base,
          MANUAL_PAYMENT_E2E_TOKEN: token, MANUAL_PAYMENT_E2E_CLIENT: String(d.clientId), MANUAL_PAYMENT_E2E_DEBT: String(d.id) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => { child.kill(); reject(new Error('local Flutter E2E timeout')); }, 140000);
      child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
      child.once('error', error => { clearTimeout(timer); reject(new Error(`local Flutter E2E launch failed: ${error.code}`)); });
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(result, 0, 'local Flutter E2E failed (output withheld; no credential logging)');
    const { row, snapshot } = await facts(d);
    assert.deepEqual(row.payments.map(payment => payment.amount).sort((a, b) => a - b), [50, 100]);
    assert.equal(await db.paymentCreationOperation.count({ where: { debtId: d.id } }), 2);
    assert.equal(snapshot.principalOutstanding, 850);
    console.log('FRONTEND E2E confirmed: lost response + same key = one Payment 100; new key = Payment 50; balance 850');
  });
  test('PostgreSQL: same key concurrent in five rounds produces one payment, operation and audit per debt', async () => {
    for (let round = 0; round < 5; round++) {
      const d = await debt(await client(`key concurrency ${round}`), 100);
      const results = await Promise.all([pay(d, 10, { idempotencyKey: 'same' }), pay(d, 10, { idempotencyKey: 'same' })]);
      assert.deepEqual(results.map(r => r.status), [201, 201]); assert.deepEqual(results[0].body, results[1].body);
      const { row, snapshot } = await facts(d);
      assert.equal(row.payments.length, 1); assert.equal(snapshot.totalDue, 90); assert.equal(row.principalOutstanding, 90);
      assert.equal(await db.paymentCreationOperation.count({ where: { debtId: d.id } }), 1);
      assert.equal(await db.auditLog.count({ where: { entity: 'Payment', metadata: { path: ['debtId'], equals: d.id } } }), 1);
    }
  });
  test('PostgreSQL: reused scoped key with different intent rejects without extra financial writes', async () => {
    const d = await debt(await client('key conflict'), 100);
    assert.equal((await pay(d, 10, { idempotencyKey: 'conflict' })).status, 201);
    for (const change of [{ amount: 20 }, { type: 'JUROS' }, { paidAt: '2026-10-05T15:00:00Z' }, { note: 'different' }]) {
      const result = await pay(d, 10, { idempotencyKey: 'conflict', ...change });
      assert.equal(result.status, 409); assert.equal(result.body.code, 'IDEMPOTENCY_KEY_REUSED');
      assert.deepEqual(Object.keys(result.body).sort(), ['code', 'data', 'message']);
    }
    assert.equal((await facts(d)).row.payments.length, 1); assert.equal((await facts(d)).snapshot.totalDue, 90);
  });
  test('PostgreSQL: different keys remain distinct simultaneous operations', async () => {
    const d = await debt(await client('different keys'), 1000);
    assert.deepEqual((await Promise.all([pay(d, 100, { idempotencyKey: 'A' }), pay(d, 200, { idempotencyKey: 'B' })])).map(r => r.status), [201, 201]);
    assert.equal((await facts(d)).row.payments.length, 2); assert.equal((await facts(d)).snapshot.totalDue, 700);
    assert.equal(await db.paymentCreationOperation.count({ where: { debtId: d.id } }), 2);
  });
  test('PostgreSQL: same key on different debts of one client cannot collide', async () => {
    const c = await client('scoped debt'); const a = await debt(c, 100), b = await debt(c, 100);
    const results = await Promise.all([pay(a, 10, { idempotencyKey: 'shared' }), pay(b, 20, { idempotencyKey: 'shared' })]);
    assert.deepEqual(results.map(r => r.status), [201, 201]);
    assert.equal(results[0].body.data.debtId, a.id); assert.equal(results[1].body.data.debtId, b.id);
    assert.equal((await facts(a)).snapshot.totalDue, 90); assert.equal((await facts(b)).snapshot.totalDue, 80);
  });
  test('PostgreSQL: multi-tenant same key isolation and foreign Debt lookup returns no cached operation', async () => {
    const a = await debt(await client('tenant A'), 100);
    const otherAccount = await db.account.create({ data: { name: 'ARTIFICIAL tenant B' } });
    const otherUser = await db.user.create({ data: { accountId: otherAccount.id, role: 'ADMIN', email: 'wave12-other@example.invalid', password: 'unused-local-test' } });
    const otherClient = await db.client.create({ data: { accountId: otherAccount.id, name: 'ARTIFICIAL tenant B client' } });
    const b = await db.debt.create({ data: { accountId: otherAccount.id, clientId: otherClient.id,
      principalAmount: 100, principalOutstanding: 100, borrowedAt: day('2026-07-23'), originalDueDate: day('2026-08-23'), dueDate: day('2026-08-23') } });
    const otherToken = require('../utils/auth').signAuthToken(otherUser);
    assert.equal((await pay(a, 10, { idempotencyKey: 'tenant-shared' })).status, 201);
    assert.equal((await pay(b, 20, { idempotencyKey: 'tenant-shared', token: otherToken })).status, 201);
    assert.equal((await pay(a, 10, { idempotencyKey: 'tenant-shared', token: otherToken, clientId: otherClient.id })).status, 404);
    assert.equal((await facts(a)).snapshot.totalDue, 90); assert.equal((await facts(b)).snapshot.totalDue, 80);
  });
  test('PostgreSQL: fresh Node process and Prisma instance reuse persisted operation after first app commits', async () => {
    const d = await debt(await client('restart'), 100);
    const original = await pay(d, 10, { idempotencyKey: 'restart-key' });
    const instance = await secondInstance();
    try {
      const repeated = await pay(d, 10, { idempotencyKey: 'restart-key', endpoint: instance.endpoint });
      assert.equal(repeated.status, 201); assert.deepEqual(repeated.body, original.body);
      assert.equal((await facts(d)).row.payments.length, 1); assert.equal((await facts(d)).snapshot.totalDue, 90);
    } finally { await instance.close(); }
  });
  test('PostgreSQL: two real Node processes concurrently resolve one scoped operation', async () => {
    const d = await debt(await client('multi-instance'), 100);
    const instance = await secondInstance();
    try {
      const results = await Promise.all([pay(d, 10, { idempotencyKey: 'multi-key' }),
        pay(d, 10, { idempotencyKey: 'multi-key', endpoint: instance.endpoint })]);
      assert.deepEqual(results.map(r => r.status), [201, 201]); assert.deepEqual(results[0].body, results[1].body);
      assert.equal((await facts(d)).row.payments.length, 1); assert.equal((await facts(d)).snapshot.totalDue, 90);
    } finally { await instance.close(); }
  });
  test('PostgreSQL: database uniqueness rejects duplicate operation insert independently of application lookup', async () => {
    const d = await debt(await client('unique constraint'), 100);
    assert.equal((await pay(d, 10, { idempotencyKey: 'unique-key' })).status, 201);
    const stored = await db.paymentCreationOperation.findFirst({ where: { debtId: d.id } });
    const { id, createdAt, ...duplicate } = stored;
    await assert.rejects(db.paymentCreationOperation.create({ data: duplicate }), error => error.code === 'P2002');
    assert.equal(await db.paymentCreationOperation.count({ where: { debtId: d.id } }), 1);
    assert.equal((await facts(d)).row.payments.length, 1);
  });
  test('PostgreSQL: failed completion insert rolls back payment, debt and key; exact retry can succeed', async () => {
    const d = await debt(await client('key rollback'), 100);
    const before = await db.debt.findUnique({ where: { id: d.id } });
    await db.$executeRawUnsafe('CREATE FUNCTION wave12_fail_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'ARTIFICIAL_KEY_FAILURE\'; END $$');
    await db.$executeRawUnsafe('CREATE TRIGGER wave12_fail_key BEFORE INSERT ON "PaymentCreationOperation" FOR EACH ROW EXECUTE FUNCTION wave12_fail_key()');
    try {
      assert.equal((await pay(d, 10, { idempotencyKey: 'rollback-key' })).status, 500);
      assert.deepEqual(await db.debt.findUnique({ where: { id: d.id } }), before);
      assert.equal(await db.payment.count({ where: { debtId: d.id } }), 0);
      assert.equal(await db.paymentCreationOperation.count({ where: { debtId: d.id } }), 0);
      assert.equal(await db.auditLog.count({ where: { entity: 'Payment', metadata: { path: ['debtId'], equals: d.id } } }), 0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER wave12_fail_key ON "PaymentCreationOperation"');
      await db.$executeRawUnsafe('DROP FUNCTION wave12_fail_key()');
    }
    assert.equal((await pay(d, 10, { idempotencyKey: 'rollback-key' })).status, 201);
    assert.equal((await facts(d)).snapshot.totalDue, 90);
  });
  test('PostgreSQL: cents and reordered properties identify one operation deterministically', async () => {
    const d = await debt(await client('canonical fingerprint'), 100);
    const original = await pay(d, 10.01, { idempotencyKey: 'canonical-key' });
    const response = await fetch(`${base}/api/payment`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'canonical-key' },
      body: JSON.stringify({ type: 'parcial', amount: '10.010', paidAt: '2026-10-06T12:00:00-03:00', debtId: d.id, clientId: d.clientId }) });
    assert.equal(response.status, 201); assert.deepEqual(await response.json(), original.body);
    assert.equal((await facts(d)).row.payments.length, 1); assert.equal((await facts(d)).snapshot.totalDue, 89.99);
  });
  test('PostgreSQL: omitted payment date stays original on retry at a later processing time', async () => {
    const d = await debt(await client('server date intent'), 100);
    const original = await pay(d, 10, { idempotencyKey: 'no-date', paidAt: null });
    clock = '2026-10-07T15:00:00Z';
    try {
      const retry = await pay(d, 10, { idempotencyKey: 'no-date', paidAt: null });
      assert.equal(retry.status, 201); assert.deepEqual(retry.body, original.body);
      assert.equal((await facts(d)).row.payments.length, 1);
    } finally { clock = '2026-10-06T15:00:00Z'; }
  });
  test('PostgreSQL: TOTAL retry works after Debt settlement and never resurrects a later deleted payment', async () => {
    const d = await debt(await client('settled retry'), 100);
    const original = await pay(d, 100, { idempotencyKey: 'total-key', type: 'TOTAL' });
    assert.equal(original.status, 201); assert.equal((await facts(d)).row.status, 'SETTLED');
    assert.deepEqual((await pay(d, 100, { idempotencyKey: 'total-key', type: 'TOTAL' })).body, original.body);
    const response = await fetch(`${base}/api/payment/${original.body.data.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const retry = await pay(d, 100, { idempotencyKey: 'total-key', type: 'TOTAL' });
    assert.equal(retry.status, 201); assert.deepEqual(retry.body, original.body);
    assert.equal((await facts(d)).row.payments.length, 0); assert.equal((await facts(d)).snapshot.totalDue, 100);
  });
  test('PostgreSQL: distinct keys with combined excess still reject and do not consume the losing key', async () => {
    const d = await debt(await client('keyed overpayment'), 100);
    const results = await Promise.all([pay(d, 80, { idempotencyKey: 'excess-a' }), pay(d, 80, { idempotencyKey: 'excess-b' })]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal((await facts(d)).row.payments.length, 1); assert.equal((await facts(d)).snapshot.totalDue, 20);
    assert.equal(await db.paymentCreationOperation.count({ where: { debtId: d.id } }), 1);
  });
  test('PostgreSQL: concurrent reuse of one key with different amounts commits only the winning intent', async () => {
    const d = await debt(await client('concurrent fingerprint conflict'), 1000);
    const results = await Promise.all([pay(d, 100, { idempotencyKey: 'one-intent' }), pay(d, 200, { idempotencyKey: 'one-intent' })]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal(results.find(r => r.status === 409).body.code, 'IDEMPOTENCY_KEY_REUSED');
    const winner = results.find(r => r.status === 201).body.data;
    const { row, snapshot } = await facts(d);
    assert.equal(row.payments.length, 1); assert.equal(snapshot.totalDue, 1000 - winner.amount);
    assert.equal(await db.paymentCreationOperation.count({ where: { debtId: d.id } }), 1);
  });
  test('PostgreSQL: failure inside Payment insertion leaves no completed key and identical retry can succeed', async () => {
    const d = await debt(await client('Payment insertion rollback'), 100);
    const before = await db.debt.findUnique({ where: { id: d.id } });
    await db.$executeRawUnsafe(`CREATE FUNCTION wave12_fail_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."debtId" = ${d.id} THEN RAISE EXCEPTION 'ARTIFICIAL_PAYMENT_FAILURE'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe('CREATE TRIGGER wave12_fail_payment BEFORE INSERT ON "Payment" FOR EACH ROW EXECUTE FUNCTION wave12_fail_payment()');
    try {
      assert.equal((await pay(d, 10, { idempotencyKey: 'payment-failure-key' })).status, 500);
      assert.deepEqual(await db.debt.findUnique({ where: { id: d.id } }), before);
      assert.equal(await db.payment.count({ where: { debtId: d.id } }), 0);
      assert.equal(await db.paymentCreationOperation.count({ where: { debtId: d.id } }), 0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER wave12_fail_payment ON "Payment"');
      await db.$executeRawUnsafe('DROP FUNCTION wave12_fail_payment()');
    }
    assert.equal((await pay(d, 10, { idempotencyKey: 'payment-failure-key' })).status, 201);
    assert.equal((await facts(d)).row.payments.length, 1);
  });
  test('PostgreSQL: malformed idempotency header rejects before any financial or operation write', async () => {
    const d = await debt(await client('malformed key'), 100);
    const result = await pay(d, 10, { idempotencyKey: 'x'.repeat(129) });
    assert.equal(result.status, 400); assert.equal(result.body.code, 'INVALID_IDEMPOTENCY_KEY');
    assert.equal((await facts(d)).row.payments.length, 0);
    assert.equal(await db.paymentCreationOperation.count({ where: { debtId: d.id } }), 0);
  });
}
