import test from 'node:test';
import assert from 'node:assert/strict';
import { tradingDateAt, nextReportTime, sessionCloseUtc, isTradingDay, isEarlyClose, dateInZone } from '../server/dates.mjs';

test('20:00 Beijing schedule stays at 12:00 UTC across US DST and year boundaries', () => {
  for (const [now, expected] of [
    ['2026-11-20T11:59:59Z', '2026-11-20T12:00:00.000Z'],
    ['2026-11-20T12:00:00Z', '2026-11-21T12:00:00.000Z'],
    ['2026-03-08T12:01:00Z', '2026-03-09T12:00:00.000Z'],
    ['2026-12-31T16:01:00Z', '2027-01-01T12:00:00.000Z'],
  ]) assert.equal(nextReportTime(new Date(now)), expected);
  assert.equal(dateInZone(new Date('2026-11-20T16:01:00Z')), '2026-11-21');
});

test('report session switches only once the New York regular session closes', () => {
  for (const [now, expected] of [
    ['2026-11-20T12:00:00Z', '2026-11-19'],
    ['2026-11-20T20:59:59Z', '2026-11-19'],
    ['2026-11-20T21:00:00Z', '2026-11-20'],
    ['2026-11-21T12:00:00Z', '2026-11-20'],
    ['2026-11-23T12:00:00Z', '2026-11-20'],
    ['2026-03-09T19:59:59Z', '2026-03-06'],
    ['2026-03-09T20:00:00Z', '2026-03-09'],
  ]) assert.equal(tradingDateAt(new Date(now)), expected, now);
  assert.equal(sessionCloseUtc('2026-03-06').toISOString(), '2026-03-06T21:00:00.000Z');
  assert.equal(sessionCloseUtc('2026-03-09').toISOString(), '2026-03-09T20:00:00.000Z');
});

test('Thanksgiving and Christmas early closes differ from full-day holidays', () => {
  assert.equal(isTradingDay('2026-11-26'), false);
  assert.equal(isEarlyClose('2026-11-27'), true);
  assert.equal(sessionCloseUtc('2026-11-27').toISOString(), '2026-11-27T18:00:00.000Z');
  assert.equal(tradingDateAt(new Date('2026-11-27T17:59:59Z')), '2026-11-25');
  assert.equal(tradingDateAt(new Date('2026-11-27T18:00:00Z')), '2026-11-27');
  assert.equal(isEarlyClose('2026-12-24'), true);
  assert.equal(sessionCloseUtc('2026-12-24').toISOString(), '2026-12-24T18:00:00.000Z');
  assert.equal(isTradingDay('2026-12-25'), false);
  assert.equal(tradingDateAt(new Date('2026-12-25T22:00:00Z')), '2026-12-24');
});

test('NYSE observed holidays include Good Friday and Juneteenth but keep Dec 31 open before a Saturday New Year', () => {
  for (const day of ['2026-01-01', '2026-04-03', '2026-06-19', '2026-07-03', '2026-12-25']) {
    assert.equal(isTradingDay(day), false, day);
  }
  assert.equal(isTradingDay('2021-12-31'), true);
  assert.equal(isTradingDay('2026-07-02'), true);
  assert.equal(isEarlyClose('2026-07-02'), false);
  assert.equal(tradingDateAt(new Date('2027-01-01T22:00:00Z')), '2026-12-31');
});
