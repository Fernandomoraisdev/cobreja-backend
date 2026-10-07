'use strict';

// Decimal arithmetic at the LEGACY boundary. Numbers are accepted only as
// persisted/input representations; all arithmetic uses scaled integers.
function decimal(value, label = 'decimal') {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError(`Invalid ${label}`);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`Invalid ${label}`);
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
  if (!match) throw new TypeError(`Invalid ${label}`);
  const exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 30 || match[2].length + (match[3] || '').length > 60) {
    throw new RangeError(`Invalid ${label}`);
  }
  const scale = (match[3] || '').length - exponent;
  let numerator = BigInt(match[2] + (match[3] || ''));
  if (match[1] === '-') numerator = -numerator;
  return scale < 0
    ? { numerator: numerator * 10n ** BigInt(-scale), denominator: 1n }
    : { numerator, denominator: 10n ** BigInt(scale) };
}

function halfUp(numerator, denominator) {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint' || denominator <= 0n) {
    throw new TypeError('Invalid rounding operands');
  }
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator * sign;
  return sign * ((absolute + denominator / 2n) / denominator);
}

function cents(value) {
  const parsed = decimal(value, 'money');
  return halfUp(parsed.numerator * 100n, parsed.denominator);
}

function percentage(base, rate) {
  if (typeof base !== 'bigint' || base < 0n) throw new TypeError('Invalid money base');
  const parsed = decimal(rate, 'rate');
  if (parsed.numerator < 0n) throw new RangeError('Negative rate');
  return halfUp(base * parsed.numerator, parsed.denominator * 100n);
}

function format(value) {
  if (typeof value !== 'bigint') throw new TypeError('Expected cents');
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function toLegacyNumber(value) {
  // Float columns remain unchanged. Reject values outside the exact-cent range.
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('LEGACY money exceeds safe boundary');
  }
  const result = Number(format(value));
  if (cents(result) !== value) throw new RangeError('LEGACY money loses cents');
  return result;
}

module.exports = { cents, percentage, halfUp, format, toLegacyNumber };
