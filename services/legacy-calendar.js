'use strict';

const TIME_ZONE = 'America/Sao_Paulo';
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

function civil(value) {
  if (value == null || (typeof value !== 'string' && !(value instanceof Date))) throw new TypeError('Invalid financial date');
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const stamp = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(stamp.getTime()) || stamp.toISOString().slice(0, 10) !== value) throw new TypeError('Invalid civil date');
    return value;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('Invalid financial date');
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function contractCivil(value) {
  // Legacy date-only form inputs were persisted as UTC midnight DateTime.
  // This convention applies to contract dates, not timed payment events.
  const date = new Date(value);
  if (value != null && Number.isFinite(date.getTime()) && date.toISOString().endsWith('T00:00:00.000Z')) {
    return date.toISOString().slice(0, 10);
  }
  return civil(value);
}

function serial(value) {
  return Date.parse(`${civil(value)}T00:00:00.000Z`) / 86400000;
}

function fromSerial(day) {
  if (!Number.isSafeInteger(day)) throw new TypeError('Invalid civil day');
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function addDays(value, days) {
  if (!Number.isSafeInteger(days)) throw new TypeError('Invalid day offset');
  return fromSerial(serial(value) + days);
}

function monthAt(anchor, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 12000) throw new RangeError('Invalid month offset');
  const [year, month, day] = civil(anchor).split('-').map(Number);
  const total = year * 12 + month - 1 + offset;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

module.exports = { TIME_ZONE, civil, contractCivil, serial, fromSerial, addDays, monthAt };
