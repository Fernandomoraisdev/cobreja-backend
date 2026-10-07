'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const money = require('../services/legacy-money');
const calendar = require('../services/legacy-calendar');

test('decimal cents do not use binary arithmetic as authority', () => {
  assert.equal(money.cents('0.10') + money.cents('0.20'), 30n);
  assert.equal(money.cents(1e-7), 0n);
  assert.equal(money.format(12345n), '123.45');
  assert.equal(money.toLegacyNumber(12345n), 123.45);
});
test('HALF_UP is applied per event including negative decimal boundary', () => {
  assert.equal(money.cents('1.005'), 101n);
  assert.equal(money.cents('-1.005'), -101n);
  assert.equal(money.percentage(5n, '10'), 1n);
  assert.equal(money.percentage(5n, '10') * 3n, 3n);
});
test('contract percentages reproduce principal and interest examples', () => {
  assert.equal(money.percentage(500000n, '40'), 200000n);
  assert.equal(money.percentage(400000n, '40'), 160000n);
  assert.equal(money.percentage(700000n, '1'), 7000n);
  assert.equal(money.percentage(560000n, '1'), 5600n);
});
test('malformed money, rates and unsafe legacy output fail closed', () => {
  for (const value of [NaN, Infinity, '', '1,00', null, {}, '1e999']) assert.throws(() => money.cents(value));
  assert.throws(() => money.percentage(100n, '-1'));
  assert.throws(() => money.toLegacyNumber(9007199254740992n));
});
for (const anchor of ['2026-01-29', '2026-01-30', '2026-01-31']) {
  test(`monthly calendar preserves original ${anchor} anchor after February`, () => {
    assert.equal(calendar.monthAt(anchor, 1), '2026-02-28');
    assert.equal(calendar.monthAt(anchor, 2), `2026-03-${anchor.slice(-2)}`);
    assert.equal(calendar.monthAt(anchor, 3), anchor.endsWith('31') ? '2026-04-30' : `2026-04-${anchor.slice(-2)}`);
  });
}
test('leap year calendar and civil days do not depend on host timezone', () => {
  assert.equal(calendar.monthAt('2024-01-31', 1), '2024-02-29');
  assert.equal(calendar.addDays('2024-02-28', 2), '2024-03-01');
  assert.throws(() => calendar.civil('2026-02-29'));
});
test('São Paulo midnight is the financial day boundary', () => {
  assert.equal(calendar.civil('2026-08-24T02:59:59Z'), '2026-08-23');
  assert.equal(calendar.civil('2026-08-24T03:00:00Z'), '2026-08-24');
  assert.equal(calendar.serial('2026-08-24') - calendar.serial('2026-08-23'), 1);
});
test('payment day is not a calendar anchor', () => {
  assert.equal(calendar.monthAt('2026-08-23', 1), '2026-09-23');
  assert.equal(calendar.monthAt('2026-08-23', 2), '2026-10-23');
});
