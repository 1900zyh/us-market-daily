import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { normalizeChart, parseNews } from '../server/market.mjs';
import { marketSessionAt } from '../server/dates.mjs';

const INDEX = { symbol: '^GSPC', name: '标普 500', price: 100, changePercent: -2, sessionDate: '2026-11-19', asOf: '2026-11-19T21:00:00Z' };
function market() { return { indices: [INDEX, { ...INDEX, symbol: '^IXIC' }, { ...INDEX, symbol: '^DJI' }, { ...INDEX, symbol: '^VIX' }], movers: [], sources: [{ name: 'test-market', status: 'ok' }], errors: [], coverage: { eligibleSymbols: 4 } }; }
function calendar() { return { events: [], sources: [{ name: 'test-calendar', status: 'ok' }], errors: [] }; }

test('daily normalization excludes live-session prices and requires the exact completed session', () => {
  const chart = {
    meta: { symbol: 'TEST', regularMarketPrice: 999, longName: 'TEST Corp' },
    timestamp: [Date.parse('2026-11-18T14:30Z') / 1000, Date.parse('2026-11-19T14:30Z') / 1000, Date.parse('2026-11-20T14:30Z') / 1000],
    indicators: { quote: [{ close: [100, 110, 999], volume: [1000, 2000, 3000] }] },
  };
  const result = normalizeChart(chart, '2026-11-19');
  assert.equal(result.price, 110);
  assert.ok(Math.abs(result.changePercent - 10) < 1e-10);
  assert.equal(result.volumeRatio, 2);
  assert.equal(result.history.length, 2);
  assert.equal(result.asOf, '2026-11-19T21:00:00.000Z');
  assert.throws(() => normalizeChart(chart, '2026-11-23'), /缺少 2026-11-23/);
});

test('market clock distinguishes regular, early, holiday, weekend and extended sessions', () => {
  assert.equal(marketSessionAt(new Date('2026-11-20T15:00Z')).status, 'open');
  assert.equal(marketSessionAt(new Date('2026-11-20T13:00Z')).status, 'pre');
  assert.equal(marketSessionAt(new Date('2026-11-20T22:00Z')).status, 'post');
  assert.equal(marketSessionAt(new Date('2026-11-21T17:00Z')).status, 'weekend');
  assert.equal(marketSessionAt(new Date('2026-11-26T17:00Z')).status, 'holiday');
  const early = marketSessionAt(new Date('2026-11-27T17:00Z'));
  assert.equal(early.status, 'open');
  assert.equal(early.nextTransitionAt, '2026-11-27T18:00:00.000Z');
  assert.equal(marketSessionAt(new Date('2026-11-27T18:00Z')).status, 'post');
  assert.equal(marketSessionAt(new Date('2026-11-27T23:00Z')).status, 'closed');
});

test('news context only contains relevant reports published between the previous close and target close', () => {
  const article = (title, date) => `<item><title>${title}</title><link>https://example.org/article</link><description>TEST company</description><pubDate>${date}</pubDate></item>`;
  const xml = `<rss>${article('TEST earnings', 'Thu, 19 Nov 2026 20:00:00 GMT')}${article('TEST after close', 'Thu, 19 Nov 2026 22:00:00 GMT')}${article('TEST older', 'Wed, 18 Nov 2026 19:00:00 GMT')}</rss>`;
  const result = parseNews(xml, { symbol: 'TEST', name: 'Test' }, '2026-11-19');
  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'TEST earnings');
});

test('refresh is single flight, report is persisted, and a later source outage preserves dated stale quotes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'market-brief-'));
  let calls = 0, failing = false, release;
  const blocker = new Promise(resolve => { release = resolve; });
  const app = await createApp({ dataDir: directory, scheduled: false, autoRefresh: false,
    clock: () => new Date('2026-11-20T12:00:00Z'), calendarProvider: calendar,
    marketProvider: async () => { calls++; if (failing) throw new Error('offline'); await blocker; return market(); },
  });
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const first = app.refresh('manual'), second = app.refresh('manual');
  assert.equal(first, second);
  assert.equal(app.getSnapshot().refreshing, true);
  release(); await first;
  assert.equal(calls, 1);
  assert.equal(app.getSnapshot().refreshing, false);
  assert.equal((await app.store.list()).length, 1);
  assert.equal((await app.store.read('2026-11-20')).sessionDate, '2026-11-19');
  failing = true;
  await app.refresh();
  assert.equal(app.getSnapshot().status, 'stale');
  assert.equal(app.getSnapshot().indices[0].price, 100);
  assert.equal(app.getSnapshot().sessionDate, '2026-11-19');
  assert.ok(app.getSnapshot().warnings.some(warning => warning.includes('保留 2026-11-19')));
  assert.equal((await app.store.read('2026-11-20')).status, 'live');
  assert.equal(await app.store.read('../private'), null);
});

test('20:00 schedule replaces a report generated before its deadline without waiting five minutes', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'market-schedule-'));
  let now = new Date('2026-11-20T11:59:00Z'), calls = 0;
  const app = await createApp({ dataDir: directory, scheduled: false, autoRefresh: false, clock: () => now,
    marketProvider: async () => { calls++; return market(); }, calendarProvider: calendar });
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await app.refresh('startup');
  now = new Date('2026-11-20T12:00:00Z');
  await app.schedulerTick();
  assert.equal(calls, 2);
  assert.equal((await app.store.read('2026-11-20')).generationReason, 'scheduled');
  await app.schedulerTick();
  assert.equal(calls, 2);
});

test('rollover filters expired events and generates the new Beijing date; partial failures preserve full archives', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'market-rollover-'));
  let now = new Date('2026-11-20T12:00Z'), partial = false;
  const app = await createApp({ dataDir: directory, scheduled: false, autoRefresh: false, clock: () => now,
    marketProvider: async () => partial ? { ...market(), indices: [INDEX], errors: ['部分行情失败'] } : market(),
    calendarProvider: async () => ({ ...calendar(), events: [{ id: 'old', date: '2026-11-20', importance: 'high' }, { id: 'later', date: '2026-11-25', importance: 'high' }] }),
  });
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await app.refresh('startup');
  partial = true; await app.refresh();
  assert.equal(app.getSnapshot().status, 'stale');
  assert.equal(app.getSnapshot().indices.length, 4);
  assert.equal((await app.store.read('2026-11-20')).status, 'live');
  now = new Date('2026-11-20T16:01Z');
  assert.equal(app.getSnapshot().cacheOutdated, true);
  assert.deepEqual(app.getSnapshot().events.map(event => event.id), ['later']);
  partial = false; await app.schedulerTick();
  assert.equal(app.getSnapshot().reportDate, '2026-11-21');
  assert.equal(app.getSnapshot().cacheOutdated, false);
  assert.equal((await app.store.read('2026-11-21')).generationReason, 'date-rollover');
});

test('API responds during source outage and rejects cross-origin writes and hidden files', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'market-api-'));
  const app = await createApp({ dataDir: directory, scheduled: false, autoRefresh: false,
    marketProvider: async () => { throw new Error('offline'); }, calendarProvider: async () => { throw new Error('offline'); } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const refreshing = await fetch(`${url}/api/refresh`, { method: 'POST' });
  assert.equal(refreshing.status, 202);
  await app.refresh();
  const data = await (await fetch(`${url}/api/dashboard`)).json();
  assert.equal(data.status, 'unavailable');
  assert.deepEqual(data.indices, []);
  assert.deepEqual(data.movers, []);
  assert.ok(data.sources.every(source => source.status === 'error'));
  assert.equal((await fetch(`${url}/api/refresh`, { method: 'POST', headers: { Origin: 'https://example.org' } })).status, 403);
  assert.equal((await fetch(`${url}/api/reports/2020-01-01`)).status, 404);
  assert.equal((await fetch(`${url}/server.mjs`)).status, 404);
  assert.equal((await fetch(`${url}/%5c..%5cserver.mjs`)).status, 403);
});
