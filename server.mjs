import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dateInZone, nextReportTime, tradingDateAt, marketSessionAt, shiftDate } from './server/dates.mjs';
import { getMarketData } from './server/market.mjs';
import { getUpcomingEvents } from './server/calendar.mjs';
import { ReportStore } from './server/report-store.mjs';
import { createLLMService } from './server/llm.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8' };

function emptySnapshot(now) {
  return {
    generatedAt: null, reportDate: dateInZone(now), sessionDate: tradingDateAt(now), nextUpdateAt: nextReportTime(now),
    status: 'loading', indices: [], movers: [], aiMovers: [], aiCoverage: { movers: 'AI 观察池正在加载' }, events: [], sources: [], warnings: [],
    summary: { title: '正在连接市场', description: '正在获取最近已收盘交易日行情与未来七天官方事件日历。' },
    coverage: { movers: '行情样本正在加载', events: '官方日历正在加载' },
    schedule: { time: '20:00', timeZone: 'Asia/Shanghai', nextRunAt: nextReportTime(now), requiresRunningServer: true },
  };
}

export async function createApp({ dataDir = path.join(ROOT, 'data', 'reports'), publicDir = path.join(ROOT, 'public'), marketProvider = getMarketData, calendarProvider = getUpcomingEvents, clock = () => new Date(), autoRefresh = true, scheduled = true, llmService = null, llmConfigFile = path.join(dataDir,'llm-config.json'), llmEnv = process.env } = {}) {
  const store = new ReportStore(dataDir);
  const llm = llmService || await createLLMService({ configFile: llmConfigFile, env: llmEnv, clock });
  let snapshot = await store.latest() || emptySnapshot(clock());
  let activeRefresh = null, timer = null;
  let lastAttempt = 0;

  function currentSnapshot() {
    const now = clock(), next = nextReportTime(now), today = dateInZone(now);
    const events = (snapshot.events || []).filter(event => event.date >= today && event.date <= shiftDate(today, 6));
    const cacheOutdated = Boolean(snapshot.generatedAt && snapshot.reportDate < today);
    const modelState=llm.getState();
    const staleAnalysis=modelState.evidenceAsOf && modelState.evidenceAsOf!==snapshot.generatedAt;
    const visibleLLM=staleAnalysis?{...modelState,status:'idle',summary:'日报证据已更新，等待重新分析。',signals:[],movers:[],sourceCatalog:[],generatedAt:null,warnings:['旧证据包的模型分析不会附到新的日报。']}:modelState;
    return { ...snapshot, llm: visibleLLM, events, marketSession: marketSessionAt(now), calendarWindowStart: today, calendarWindowEnd: shiftDate(today, 6), cacheOutdated, refreshing: Boolean(activeRefresh), nextUpdateAt: next, warnings: [...(snapshot.warnings || []), ...(cacheOutdated ? [`当前展示 ${snapshot.reportDate} 生成的缓存日报；未来事件已按今天过滤，正在等待新快照。`] : [])], schedule: { ...snapshot.schedule, time: '20:00', timeZone: 'Asia/Shanghai', nextRunAt: next, requiresRunningServer: true } };
  }

  let llmRun = null, llmRunGeneration = null;
  function analyzeSnapshot(report = snapshot, { persist = true } = {}) {
    if (llmRun) return llmRunGeneration===report.generatedAt?llmRun:llmRun.then(()=>analyzeSnapshot(report,{persist}));
    const generation = report.generatedAt;
    llmRunGeneration=generation;
    llmRun = llm.analyze(report).then(async result => {
      // Never attach an older evidence pack to a newer market snapshot.
      if (snapshot.generatedAt === generation) snapshot = { ...snapshot, llm: result };
      if (persist && generation && result.status === 'ready') {
        const archived = await store.read(report.reportDate);
        if (archived?.generatedAt === generation) await store.save({ ...archived, llm: result });
      }
      return result;
    }).finally(() => { llmRun = null; });
    return llmRun;
  }

  async function generate(reason) {
    const now = clock(), reportDate = dateInZone(now), sessionDate = tradingDateAt(now);
    const results = await Promise.allSettled([marketProvider({ now, sessionDate }), calendarProvider({ now, days: 7 })]);
    const market = results[0].status === 'fulfilled' ? results[0].value : { indices: [], movers: [], sources: [{ name: 'Yahoo Finance', url: 'https://finance.yahoo.com/', status: 'error', error: results[0].reason?.message || '行情获取失败' }], errors: ['行情服务暂不可用'], coverage: {} };
    const calendar = results[1].status === 'fulfilled' ? results[1].value : { events: [], sources: [{ name: '官方经济日历', status: 'error', error: results[1].reason?.message || '日历获取失败' }], errors: ['官方经济日历暂不可用'] };
    const sources = [...(market.sources || []), ...(calendar.sources || [])];
    const warnings = [...(market.errors || []), ...(calendar.errors || [])];
    const useStaleMarket = snapshot.indices?.length && ((market.indices?.length || 0) < snapshot.indices.length || (snapshot.aiCoverage?.eligibleSymbols > 0 && !(market.aiCoverage?.eligibleSymbols > 0)));
    if (useStaleMarket) warnings.unshift(`本次行情获取失败，保留 ${snapshot.sessionDate} 收盘数据。`);
    const indices = useStaleMarket ? snapshot.indices : market.indices || [];
    const movers = useStaleMarket ? snapshot.movers : market.movers || [];
    const aiMovers = useStaleMarket ? snapshot.aiMovers || [] : market.aiMovers || [];
    const aiCoverage = useStaleMarket ? snapshot.aiCoverage || { movers: '旧快照尚无 AI 观察池数据' } : market.aiCoverage || { movers: 'AI 观察池数据暂不可用' };
    const status = useStaleMarket ? 'stale' : !indices.length && !calendar.events?.length ? 'unavailable' : warnings.length || sources.some(source => source.status !== 'ok') || indices.length < 4 ? 'partial' : 'live';
    const effectiveSession = useStaleMarket ? snapshot.sessionDate : sessionDate;
    const best = [...aiMovers].sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))[0];
    const important = (calendar.events || []).filter(event => event.importance === 'high').length;
    const next = nextReportTime(now);
    const report = {
      generatedAt: now.toISOString(), reportDate, sessionDate: effectiveSession, targetSessionDate: sessionDate, nextUpdateAt: next,
      generationReason: reason, status, stale: Boolean(useStaleMarket), indices, movers, aiMovers, aiCoverage, events: calendar.events || [], sources, warnings,
      summary: {
        title: important ? `AI 产业观察，关注 ${important} 个高影响信号` : '跟踪 AI 产业异动，把握下一交易周',
        description: `${effectiveSession} AI 观察池收盘复盘${best ? `：${best.symbol} ${best.changePercent >= 0 ? '上涨' : '下跌'} ${Math.abs(best.changePercent).toFixed(2)}%` : aiCoverage.eligibleSymbols > 0 ? '：暂无满足筛选阈值的显著异动' : '：行情数据待补全'}。未来七天已收录 ${calendar.events?.length || 0} 项事件，宏观与财报信号供 AI 产业联动观察，新闻仅作为催化线索。`,
      },
      coverage: { ...(useStaleMarket ? snapshot.coverage : market.coverage), events: '未来 7 个北京时间自然日（含今天），收录官方经济日历、FOMC 与交易所常规休市安排；Nasdaq 预计财报覆盖市值≥100亿美元及重点股，最多20项，并非全市场完整日历。全天美东事件单独标记。' },
      schedule: { time: '20:00', timeZone: 'Asia/Shanghai', nextRunAt: next, requiresRunningServer: true },
    };
    const existing = await store.read(reportDate);
    const missingPriorCoverage = existing && (
      existing.indices?.length > report.indices.length ||
      (existing.coverage?.eligibleSymbols > 0 && !(report.coverage?.eligibleSymbols > 0)) ||
      (existing.aiCoverage?.eligibleSymbols > 0 && !(report.aiCoverage?.eligibleSymbols > 0)) ||
      (existing.events?.length && !report.events.length && (calendar.errors?.length || calendar.sources?.some(source => source.status === 'error'))) ||
      (existing.status === 'live' && report.status !== 'live')
    );
    if (missingPriorCoverage) report.warnings.push('本次更新部分数据缺失，已保留该日期原有的完整归档。');
    snapshot = report;
    if (status !== 'unavailable' && !useStaleMarket && !missingPriorCoverage) await store.save(report);
    if (llm.status().configured && llm.status().enabled && status !== 'unavailable') void analyzeSnapshot(report,{persist:!missingPriorCoverage && !useStaleMarket}).catch(error => console.error('LLM analysis:', error.message));
    return currentSnapshot();
  }

  function refresh(reason = 'manual') {
    if (activeRefresh) return activeRefresh;
    lastAttempt = clock().getTime();
    activeRefresh = generate(reason).catch(error => {
      snapshot = { ...snapshot, status: snapshot.indices?.length ? 'stale' : 'unavailable', warnings: [...(snapshot.warnings || []), `日报生成失败：${error.message}`] };
      return currentSnapshot();
    }).finally(() => { activeRefresh = null; });
    return activeRefresh;
  }

  async function schedulerTick() {
    const now = clock(), today = dateInZone(now), deadline = new Date(`${today}T20:00:00+08:00`);
    if (activeRefresh) return;
    if (snapshot.reportDate < today && now.getTime() - lastAttempt >= 5 * 60_000) { await refresh('date-rollover'); return; }
    if (now < deadline || (lastAttempt >= deadline.getTime() && now.getTime() - lastAttempt < 5 * 60_000)) return;
    const report = await store.read(today);
    if (!report?.generatedAt || new Date(report.generatedAt) < deadline) await refresh('scheduled');
  }

  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
  }

  async function readJson(request) {
    let content = '', size = 0;
    for await (const chunk of request) { size += chunk.length; if(size>16000)throw new Error('配置内容超过允许大小'); content += chunk; }
    try { return JSON.parse(content || '{}'); } catch { throw new Error('请求必须包含有效 JSON'); }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const host = request.headers.host || '';
      if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)) return json(response, 403, { error: '仅允许本机访问' });
      if (request.headers.origin && request.headers.origin !== `http://${host}`) return json(response, 403, { error: '请求来源不允许' });
      let url;
      try { url = new URL(request.url, `http://${host}`); } catch { return json(response, 400, { error: '无效地址' }); }
      if (url.pathname === '/api/health') return json(response, 200, { ok: true, status: snapshot.status, refreshing: Boolean(activeRefresh), nextRunAt: nextReportTime(clock()), schedule: '每日北京时间 20:00；服务需持续运行' });
      if (url.pathname === '/api/llm/status' && request.method === 'GET') return json(response,200,llm.status());
      if (url.pathname === '/api/llm/config' && request.method === 'POST') {
        try { return json(response,200,await llm.updateConfig(await readJson(request))); }
        catch(error) { return json(response,400,{error:error.message}); }
      }
      if (url.pathname === '/api/llm/analyze' && request.method === 'POST') {
        request.resume();
        const state=llm.status();
        if(!state.configured || !state.enabled) return json(response,400,{error:!state.configured?'请先在模型设置中配置 API Key 与模型':'请先在模型设置中启用模型分析',llm:llm.getState()});
        void analyzeSnapshot().catch(error => console.error('LLM analysis:',error.message));
        return json(response,202,{llm:llm.getState(),message:'已启动两位分析师并行分析'});
      }
      if (url.pathname === '/api/dashboard' && request.method === 'GET') return json(response, 200, currentSnapshot());
      if (url.pathname === '/api/reports' && request.method === 'GET') return json(response, 200, { reports: await store.list() });
      if (/^\/api\/reports\/\d{4}-\d{2}-\d{2}$/.test(url.pathname) && request.method === 'GET') {
        const report = await store.read(url.pathname.slice(-10));
        return json(response, report ? 200 : 404, report || { error: '未找到该日期的日报' });
      }
      if (url.pathname === '/api/refresh' && request.method === 'POST') {
        request.resume();
        const alreadyRunning = Boolean(activeRefresh);
        void refresh('manual');
        return json(response, 202, { ...currentSnapshot(), message: alreadyRunning ? '日报正在更新' : '已开始更新日报' });
      }
      if (url.pathname.startsWith('/api/')) return json(response, 404, { error: '接口不存在' });
      if (!['GET','HEAD'].includes(request.method)) return json(response, 405, { error: '请求方法不支持' });
      let decoded;
      try { decoded = decodeURIComponent(url.pathname); } catch { return json(response, 400, { error: '无效地址编码' }); }
      const file = path.resolve(publicDir, '.' + (decoded === '/' ? '/index.html' : decoded));
      if (!file.startsWith(path.resolve(publicDir) + path.sep) || decoded.includes('\0') || decoded.includes('\\')) return json(response, 403, { error: '禁止访问' });
      try {
        const info = await stat(file);
        if (!info.isFile()) return json(response, 404, { error: '文件不存在' });
        const body = await readFile(file);
        response.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        response.end(request.method === 'HEAD' ? undefined : body);
      } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return json(response, 404, { error: '文件不存在' }); throw error; }
    } catch (error) { console.error('HTTP request failed:', error.message); if (!response.headersSent) json(response, 500, { error: '服务器暂时不可用' }); else response.end(); }
  });
  server.on('close', () => { if (timer) clearInterval(timer); });
  if (autoRefresh) void refresh('startup');
  if (scheduled) { timer = setInterval(() => { void schedulerTick().catch(error => console.error('Scheduler:', error.message)); }, 15000); timer.unref(); }
  return { server, refresh, store, getSnapshot: currentSnapshot, schedulerTick, analyzeSnapshot, llm };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口');
  const app = await createApp();
  app.server.listen(port, '127.0.0.1', () => console.log(`Market Brief · http://localhost:${port}\n每日北京时间 20:00 自动更新；请保持此进程运行。`));
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => app.server.close(() => process.exit(0)));
}
