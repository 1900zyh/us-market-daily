import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AI_UNIVERSE, aiCategoryFor } from '../server/ai-universe.mjs';
import { selectMovers, normalizeChart } from '../server/market.mjs';
import { createApp } from '../server.mjs';

test('AI watchlist classifies all four value-chain groups without including unrelated screen candidates', () => {
  assert.equal(Object.keys(AI_UNIVERSE).length, 35);
  assert.equal(aiCategoryFor('nvda'), 'chip');
  assert.equal(aiCategoryFor('MSFT'), 'cloud');
  assert.equal(aiCategoryFor('VRT'), 'infrastructure');
  assert.equal(aiCategoryFor('MDB'), 'application');
  assert.equal(aiCategoryFor('PDD'), null);
  assert.equal(aiCategoryFor(''), null);
});

test('dedicated AI selection happens before the global per-direction cap and preserves thresholds', () => {
  const allMarketWinners = Array.from({ length: 10 }, (_, index) => ({ symbol: `OTHER${index}`, changePercent: 30-index, volume: 1_000_000 }));
  const stocks = [...allMarketWinners,
    { symbol: 'NVDA', changePercent: 5, volume: 1_000_000 },
    { symbol: 'AMD', changePercent: -7, volume: 1_000_000 },
    { symbol: 'MSFT', changePercent: 3, volume: 100_001 },
    { symbol: 'MDB', changePercent: 2.99, volume: 1_000_000 },
    { symbol: 'VRT', changePercent: 8, volume: 100_000 },
  ];
  assert.ok(!selectMovers(stocks).some(stock => stock.symbol === 'NVDA'));
  assert.deepEqual(selectMovers(stocks, { aiOnly: true }).map(stock => stock.symbol), ['AMD', 'NVDA', 'MSFT']);
});

test('chart normalization attaches AI business association independently of upstream sector labels', () => {
  const base = { meta: { symbol: 'NVDA' }, timestamp: [Date.parse('2026-11-18T14:30Z')/1000,Date.parse('2026-11-19T14:30Z')/1000], indicators: { quote: [{ close: [100,105], volume: [1000,2000] }] } };
  assert.equal(normalizeChart(base, '2026-11-19').ai, true);
  assert.equal(normalizeChart(base, '2026-11-19').aiCategory, 'chip');
  assert.equal(normalizeChart({ ...base, meta: { symbol: 'PDD' } }, '2026-11-19').ai, false);
});

test('AI movers and coverage persist with reports and survive a failed AI refresh', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'market-ai-'));
  let failAI = false;
  const ai = { symbol: 'NVDA', name: 'NVIDIA', changePercent: 5, volume: 1_000_000, ai: true, aiCategory: 'chip' };
  const app = await createApp({ dataDir: directory, autoRefresh: false, scheduled: false,
    clock: () => new Date('2026-11-20T12:00Z'),
    marketProvider: async () => ({ indices: [{ symbol: '^GSPC' }], movers: [], aiMovers: failAI ? [] : [ai], aiCoverage: { eligibleSymbols: failAI ? 0 : 35 }, sources: [], errors: [] }),
    calendarProvider: async () => ({ events: [], sources: [], errors: [] }),
  });
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  await app.refresh();
  assert.equal((await app.store.read('2026-11-20')).aiMovers[0].symbol, 'NVDA');
  assert.match(app.getSnapshot().summary.description, /AI 观察池.*NVDA/);
  failAI = true;
  await app.refresh();
  assert.equal(app.getSnapshot().status, 'stale');
  assert.equal(app.getSnapshot().aiMovers[0].symbol, 'NVDA');
  assert.equal(app.getSnapshot().aiCoverage.eligibleSymbols, 35);
});
