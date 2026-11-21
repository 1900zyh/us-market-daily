'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icon = (name, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const safeUrl = (value) => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? esc(url.href) : '#'; } catch { return '#'; } };
const number = (value, digits = 2) => Number.isFinite(Number(value)) && value !== null ? Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const percent = (value) => Number.isFinite(Number(value)) && value !== null ? `${Number(value) >= 0 ? '+' : ''}${number(value)}%` : '—';
const compact = (value) => Number(value) >= 1e9 ? `${number(value / 1e9)}B` : Number(value) >= 1e6 ? `${number(value / 1e6, 1)}M` : Number(value) >= 1e3 ? `${number(value / 1e3, 1)}K` : number(value, 0);
const beijingDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(date));
const timeText = (date, options = {}) => date && !Number.isNaN(new Date(date).getTime()) ? new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit', hour12:false, ...options }).format(new Date(date)) : '时间待定';
const displayDate = (date) => date ? date.replaceAll('-', '.') : '—';
const categoryName = { macro:'经济数据', fed:'美联储', earnings:'公司财报', market:'交易日历' };
const indexConfig = [ {symbol:'^GSPC',name:'标普 500',en:'S&P 500'}, {symbol:'^IXIC',name:'纳斯达克',en:'NASDAQ'}, {symbol:'^DJI',name:'道琼斯',en:'DOW JONES'}, {symbol:'^VIX',name:'恐慌指数',en:'VIX'} ];
const aiGroups = {
  chip:'NVDA AMD AVGO TSM MU ARM MRVL ASML AMAT LRCX KLAC',
  cloud:'MSFT AMZN GOOGL GOOG META ORCL',
  infrastructure:'CRWV NBIS SMCI DELL HPE ANET VRT IREN',
  application:'PLTR APP CRM ADBE NOW SNOW DDOG CRWD NET PANW MDB'
};
const aiCategory = (symbol) => Object.entries(aiGroups).find(([,symbols]) => symbols.split(' ').includes(symbol))?.[0] || null;
let saved = [];
try { saved = JSON.parse(localStorage.getItem('market-pulse-watchlist') || '[]'); if (!Array.isArray(saved)) saved = []; } catch { saved = []; }
const state = { data:null, view:'overview', chart:'^IXIC', direction:'all', query:'', day:'all', category:'all', focus:'ai', aiCategory:'all', expandedEvents:false, expandedMovers:false, sortDescending:true, saved:new Set(saved), historical:false, fetching:false, lastError:null, reports:[] };
let pollingTimer;
let toastTimer;
let llmConfig = null;

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3500);
}

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, signal:AbortSignal.timeout(90000), headers:{ Accept:'application/json', ...options.headers } });
  if (!response.ok) {
    let detail = null;
    try { detail = await response.json(); } catch { /* The upstream may send an empty error body. */ }
    throw new Error(typeof detail?.error === 'string' ? detail.error.slice(0,280) : `服务暂不可用（${response.status}）`);
  }
  return response.json();
}

function setBusy(busy) {
  $('#refresh-button').disabled = busy;
  $('#refresh-button svg').classList.toggle('spinning', busy);
  $('#refresh-button span').textContent = busy ? '正在更新' : '更新日报';
}

async function loadDashboard({ refresh = false } = {}) {
  if (state.fetching) return;
  state.fetching = true;
  if (refresh) { state.historical = false; setBusy(true); }
  try {
    const data = await api(refresh ? '/api/refresh' : '/api/dashboard', refresh ? { method:'POST' } : {});
    if (!data || !Array.isArray(data.indices) || !Array.isArray(data.events) || !Array.isArray(data.movers)) throw new Error('日报数据格式异常');
    state.lastError = null;
    if (!state.historical) { state.data = data; render(); }
    if (refresh) toast(data.refreshing ? '正在采集行情与事件，完成后会自动显示' : '日报已更新');
    clearTimeout(pollingTimer);
    pollingTimer = setTimeout(() => loadDashboard(), data.refreshing || data.status === 'loading' || data.llm?.status === 'running' ? 5000 : 60000);
    setBusy(Boolean(data.refreshing));
  } catch (error) {
    state.lastError = error.message;
    renderNotice();
    if (!state.data) {
      renderIndices(); renderChart(); renderEvents(); renderMovers();
      $('#updated-at').textContent = '连接失败，可点击更新重试';
      $('#report-date').textContent = displayDate(beijingDate());
    }
    if (refresh) toast('更新失败，请稍后重试');
    setBusy(false);
    clearTimeout(pollingTimer);
    pollingTimer = setTimeout(() => loadDashboard(), 30000);
  } finally { state.fetching = false; }
}

function render() {
  const data = state.data;
  $('#report-date').textContent = displayDate(data.reportDate || beijingDate(data.generatedAt || new Date()));
  $('#session-label').textContent = `美股交易日 ${displayDate(data.sessionDate)}`;
  $('#updated-at').textContent = data.refreshing ? '正在更新数据…' : data.generatedAt ? `${timeText(data.generatedAt, {month:'2-digit', day:'2-digit'})} 更新 · 北京时间` : '等待首次更新';
  $('#brief-edition').textContent = `VOL. ${(data.reportDate || beijingDate()).replaceAll('-', '')}`;
  $('#nav-events').textContent = visibleEvents().length;
  updateClock(); renderNotice(); renderIndices(); renderChart(); renderBrief(); renderDays(); renderEvents(); renderMovers(); renderLlm();
}

function renderNotice() {
  const notice = $('#notice');
  const data = state.data;
  let text = '';
  if (state.historical) text = `正在查看 ${displayDate(data.reportDate)} 的历史日报。<button id="return-latest">返回最新日报 →</button>`;
  else if (state.lastError) text = `数据服务连接失败：${esc(state.lastError)}。${data ? '当前保留上次成功取得的数据，请留意数据日期。' : '请确认网站服务正在运行，然后点击「更新日报」重试。'}`;
  else if (data?.status === 'unavailable') text = '暂未取得可用行情。事件日历仍可查看；数据源恢复后会自动重试。';
  else if (data?.refreshing && !data.indices.length) text = '正在首次汇集真实行情与官方日历，通常需要 30–60 秒，完成后自动显示。';
  else if (data?.warnings?.length) text = esc(data.warnings.slice(0, 2).join(' · '));
  notice.innerHTML = text;
  notice.hidden = !text;
  $('#return-latest')?.addEventListener('click', () => { state.historical = false; state.day = 'all'; loadDashboard(); });
}

function series(index) {
  return (index?.history || []).map((p) => ({ time:p.time ?? p.date, close:Number(p.close ?? p.value) })).filter((p) => Number.isFinite(p.close));
}

function sparkline(values, negative) {
  if (values.length < 2) return '';
  const closes = values.map((p) => p.close);
  const min = Math.min(...closes), range = Math.max(...closes) - min || 1;
  const points = closes.map((n, i) => `${i * 75 / (closes.length - 1)},${25 - (n - min) / range * 20}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 75 28" aria-hidden="true"><polyline points="${points}" fill="none" stroke="${negative ? '#cb8986' : '#7ba98e'}"/></svg>`;
}

function renderIndices() {
  $('#indices-grid').innerHTML = indexConfig.map((config) => {
    const index = state.data?.indices.find((item) => item.symbol === config.symbol);
    const negative = index?.changePercent < 0;
    return `<button class="index-card ${state.chart === config.symbol ? 'active' : ''}" data-index="${config.symbol}" aria-label="查看${config.name}走势"><div class="index-name"><span>${config.name}</span><span>${config.en}</span></div><div class="index-price">${number(index?.price)}</div><div class="index-bottom"><div class="index-change ${negative ? 'negative' : 'positive'}">${index ? icon('up') + percent(index.changePercent) : '<span class="muted">暂无行情</span>'}<span class="index-absolute">${index ? `${index.change >= 0 ? '+' : ''}${number(index.change)}` : ''}</span></div>${sparkline(series(index).slice(-22), negative)}</div></button>`;
  }).join('');
  $$('[data-index]').forEach((button) => button.addEventListener('click', () => selectChart(button.dataset.index)));
}

function selectChart(symbol) { state.chart = symbol; renderIndices(); renderChart(); }

function renderChart() {
  const config = indexConfig.find((item) => item.symbol === state.chart) || indexConfig[0];
  const index = state.data?.indices.find((item) => item.symbol === state.chart);
  $('#chart-index-label').innerHTML = `${config.name} <span>${config.en}</span>`;
  $('#chart-value').innerHTML = `${number(index?.price)} <span class="${index?.changePercent < 0 ? 'negative' : 'positive'}">${index ? percent(index.changePercent) : '等待数据'}</span>`;
  $$('#chart-selector button').forEach((button) => { button.classList.toggle('selected', button.dataset.chart === state.chart); button.setAttribute('aria-pressed', String(button.dataset.chart === state.chart)); });
  const points = series(index).slice(-30);
  $('#chart-period').textContent = points.length ? `近 ${points.length} 个交易日` : '日线趋势';
  $('#chart-source').textContent = `来源：${index?.source?.name || 'Yahoo Finance'}${index?.asOf ? ` · ${displayDate(beijingDate(index.asOf))}` : ''}`;
  if (points.length < 2) { $('#main-chart').innerHTML = `<div class="chart-empty">${state.data?.refreshing ? '正在获取市场走势' : '暂无可用走势数据'}<span>取得真实行情后将在此展示</span></div>`; return; }
  const values = points.map((p) => p.close), min = Math.min(...values), max = Math.max(...values), pad = (max - min) * .18 || 1;
  const low = min - pad, high = max + pad, width = 630, height = 151;
  const xy = values.map((n, i) => [i * width / (values.length - 1), 9 + (high - n) / (high - low) * height]);
  const path = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const area = `${path} L${width} 164 L0 164 Z`;
  const grid = Array.from({length:4}, (_,i) => { const y = 12 + i * 47; return `<line class="gridline" x1="0" y1="${y}" x2="635" y2="${y}"/><text x="646" y="${y+3}" text-anchor="start">${number(high - (high-low) * (y-9)/height, state.chart === '^VIX' ? 1 : 0)}</text>`; }).join('');
  const labels = [0, Math.floor((points.length - 1) / 3), Math.floor((points.length - 1) * 2 / 3), points.length - 1].map((i) => {
    const raw = points[i].time;
    const date = new Date(typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : raw);
    const label = Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',month:'2-digit',day:'2-digit'}).format(date);
    return `<text x="${xy[i][0]}" y="184" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${label}</text>`;
  }).join('');
  const last = xy.at(-1);
  $('#main-chart').innerHTML = `<svg viewBox="0 0 700 192" preserveAspectRatio="none" role="img" aria-label="${config.name}近${points.length}个交易日收盘走势图"><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a3cdb0" stop-opacity=".26"/><stop offset="1" stop-color="#a3cdb0" stop-opacity="0"/></linearGradient></defs>${grid}<path d="${area}" fill="url(#chart-fill)"/><path d="${path}" class="chart-line"/><circle class="chart-dot" cx="${last[0]}" cy="${last[1]}" r="4"/>${labels}${xy.map(([x,y],i) => `<circle cx="${x}" cy="${y}" r="6" fill="transparent"><title>${esc(points[i].time)}：${number(points[i].close)}</title></circle>`).join('')}</svg>`;
}

function renderBrief() {
  const data = state.data;
  const events = visibleEvents();
  const high = events.filter((event) => event.importance === 'high');
  const movers = [...visibleMovers()].sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
  $('#brief-title').textContent = state.focus === 'ai' ? '沿着 AI 产业链，寻找波动的线索。' : data.summary?.title || '保持观察，让信息连成线索。';
  $('#brief-description').textContent = state.focus === 'ai' ? `芯片、云平台、数据中心与应用。未来七日关注 ${events.length} 项相关信号，上一完整交易日记录 ${movers.length} 只 AI 相关异动标的。` : data.summary?.description || `未来七日共收录 ${events.length} 个日历信号。`;
  $('#brief-highlights').innerHTML = [
    `<div class="brief-item"><span>01</span>未来七日 <strong>${high.length} 项高影响信号</strong></div>`,
    `<div class="brief-item"><span>02</span>${movers[0] ? `异动关注 <strong>${esc(movers[0].symbol)} ${percent(movers[0].changePercent)}</strong>` : '等待上一交易日异动数据'}</div>`,
    `<div class="brief-item"><span>03</span>${events[0] ? `近期关注 <strong>${esc(events[0].title.length > 20 ? events[0].title.slice(0,20)+'…' : events[0].title)}</strong>` : '官方日历持续更新'}</div>`
  ].join('');
  const next = data.nextUpdateAt || data.schedule?.nextRunAt;
  $('#next-update').textContent = next ? `${timeText(next, {month:'2-digit',day:'2-digit'})} · 北京时间` : '每日 20:00 · 北京时间';
}

function renderDays() {
  const anchor = state.historical ? state.data?.reportDate : state.data?.calendarWindowStart || beijingDate();
  const days = Array.from({length:7}, (_,i) => { const date = new Date(`${anchor}T00:00:00+08:00`); date.setUTCDate(date.getUTCDate()+i); return { date:beijingDate(date), day:timeText(date,{weekday:'short'}).split(' ')[0], dayNum:date.toLocaleDateString('en-US',{timeZone:'Asia/Shanghai',day:'2-digit'}) }; });
  $('#day-tabs').innerHTML = `<button class="day-tab ${state.day === 'all' ? 'selected' : ''}" data-date="all"><span>未来</span><strong>7 天</strong></button>` + days.map((day,i) => `<button class="day-tab ${state.day === day.date ? 'selected' : ''} ${visibleEvents().some((e) => eventDate(e) === day.date) ? 'has-events' : ''} ${i === 0 ? 'today' : ''}" data-date="${day.date}" aria-label="查看${day.date}事件"><span>${i === 0 ? '当日' : new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',weekday:'short'}).format(new Date(`${day.date}T12:00:00+08:00`))}</span><strong>${day.dayNum}</strong></button>`).join('');
  $$('[data-date]').forEach((button) => button.addEventListener('click', () => { state.day = button.dataset.date; renderDays(); renderEvents(); }));
}

function eventDate(event) { return event.date || (event.time ? beijingDate(event.time) : ''); }

function visibleEvents() {
  const events = state.data?.events || [];
  if (state.focus !== 'ai') return events;
  return events.filter((event) => event.category !== 'earnings' || event.tickers?.some((symbol) => {
    const group = aiCategory(symbol);
    return group && (state.aiCategory === 'all' || state.aiCategory === group);
  }));
}

function visibleMovers() {
  const data = state.data;
  const movers = state.focus === 'ai' ? data?.aiMovers || (data?.movers || []).filter((item) => item.ai || aiCategory(item.symbol)) : data?.movers || [];
  return state.focus === 'ai' && state.aiCategory !== 'all' ? movers.filter((item) => (item.aiCategory || aiCategory(item.symbol)) === state.aiCategory) : movers;
}

function renderEvents() {
  const all = visibleEvents();
  const events = all.filter((event) => (state.day === 'all' || eventDate(event) === state.day) && (state.category === 'all' || event.category === state.category));
  const limit = state.expandedEvents || state.view === 'signals' ? Infinity : 5;
  $('#events-count').textContent = all.length;
  $('#all-events-button').hidden = events.length <= 5 || state.view === 'signals';
  $('#all-events-button').innerHTML = `${state.expandedEvents ? '收起信号' : `查看全部 ${events.length} 项信号`}${icon('arrow')}`;
  if (!events.length) { $('#events-list').innerHTML = `<div class="empty-state">${icon('calendar')}${state.data?.refreshing ? '正在读取官方事件日历…' : '当前条件下暂无已确认的日历信号'}<small>${state.category !== 'all' || state.day !== 'all' ? '切换日期或事件类型，查看其他信号' : '将持续从官方日历获取未来七天安排'}</small></div>`; return; }
  $('#events-list').innerHTML = events.slice(0,limit).map((event) => {
    const originalIndex = all.indexOf(event);
    const importance = ['high','medium','low'].includes(event.importance) ? event.importance : 'low';
    const date = eventDate(event);
    const uncertain = event.estimated || event.status === 'tentative';
    return `<button class="event-row" data-event="${originalIndex}" aria-label="查看${esc(event.title)}详情"><div class="event-time">${esc(event.time ? timeText(event.time) : event.category === 'market' ? '全天' : uncertain ? '预计' : '时间待定')}<span>${date ? displayDate(date.slice(5)) : '日期待定'}${event.dateTimezone === 'America/New_York' ? ' · 美东' : ''}</span></div><div class="event-info"><h3>${esc(event.title)}<span class="event-type">${categoryName[event.category] || '市场事件'}</span>${uncertain ? '<span class="event-type">待确认</span>' : ''}</h3><p>${!event.time && event.timeLabel ? esc(event.timeLabel) + ' · ' : ''}${esc(event.impact || '查看事件影响路径与官方来源')}</p></div><div class="event-impact impact-${importance}"><span class="impact-bars"><i></i><i></i><i></i></span><span class="impact-text">${importance === 'high' ? '高影响' : importance === 'medium' ? '中等影响' : '常规关注'}</span></div>${icon('arrow')}</button>`;
  }).join('');
  $$('[data-event]').forEach((button) => button.addEventListener('click', () => showEvent(all[Number(button.dataset.event)])));
}

function logoStyle(symbol) {
  let hash = 0; for (const char of symbol) hash += char.charCodeAt(0);
  const colors = [['#eaf2ec','#4a7856'],['#eeedf7','#8177a1'],['#eef1f7','#597394'],['#f7efe7','#b39170'],['#f0f2f4','#64737d']];
  const [bg,color] = colors[hash % colors.length]; return `--logo-bg:${bg};--logo-color:${color}`;
}

function renderMovers() {
  let movers = [...visibleMovers()];
  if (state.view === 'watchlist') movers = movers.filter((mover) => state.saved.has(mover.symbol));
  movers = movers.filter((mover) => (state.direction === 'all' || (state.direction === 'up' ? mover.changePercent >= 0 : mover.changePercent < 0)) && (!state.query || `${mover.symbol} ${mover.name}`.toLowerCase().includes(state.query)));
  movers.sort((a,b) => (state.sortDescending ? 1 : -1) * (Math.abs(b.changePercent) - Math.abs(a.changePercent)));
  $('#movers-heading').textContent = state.view === 'watchlist' ? '我的关注 · 异动追踪' : state.focus === 'ai' ? '上一交易日 · AI 产业异动' : '上一交易日 · 异动追踪';
  $('#movers-description').textContent = state.view === 'watchlist' ? '点击星标收藏标的，在这里关注它们进入每日异动列表时的表现。' : '追踪股价的大幅变化，同时寻找价格背后的信息线索。';
  const coverage = state.focus === 'ai' ? state.data?.aiCoverage?.movers : state.data?.coverage?.movers;
  $('#movers-coverage').textContent = typeof coverage === 'string' ? coverage : '采样股票池 · 按绝对涨跌幅排序 · 点击查看资讯来源';
  $('#show-movers-button').hidden = movers.length <= 8 || ['movers','watchlist'].includes(state.view);
  $('#show-movers-button').innerHTML = `${state.expandedMovers ? '收起标的' : `查看全部 ${movers.length} 只标的`}${icon('arrow')}`;
  if (!movers.length) { $('#movers-body').innerHTML = `<tr><td colspan="7"><div class="empty-state">${icon(state.view === 'watchlist' ? 'star' : 'chart')}${state.view === 'watchlist' ? '暂时没有关注的异动标的' : state.query || state.direction !== 'all' ? '没有匹配的异动标的' : state.data?.refreshing ? '正在获取上一交易日行情…' : '暂未取得可用的异动行情'}<small>${state.view === 'watchlist' ? '在「个股异动」中点击星标；关注仅保存在当前浏览器' : '异动分析基于已完成交易日的收盘价，保留行情来源'}</small></div></td></tr>`; return; }
  const limit = state.expandedMovers || ['movers','watchlist'].includes(state.view) ? Infinity : 8;
  $('#movers-body').innerHTML = movers.slice(0,limit).map((mover) => {
    const watched = state.saved.has(mover.symbol);
    const hasNews = Boolean(mover.reason?.sources?.length);
    const reasonPreview = hasNews && mover.reason?.theme ? `相关报道涉及${mover.reason.theme}。具体催化因素需结合原文核实。` : mover.reason?.summary || '暂无已核实的消息原因';
    return `<tr><td><button class="star-button ${watched ? 'saved' : ''}" data-watch="${esc(mover.symbol)}" aria-label="${watched ? '取消关注' : '关注'} ${esc(mover.symbol)}" aria-pressed="${watched}">${icon('star')}</button></td><td><button class="stock-ident" data-mover="${esc(mover.symbol)}" aria-label="查看 ${esc(mover.symbol)} 异动详情" style="border:0;background:none;padding:0;text-align:left"><span class="stock-logo" style="${logoStyle(mover.symbol)}">${esc(mover.symbol.slice(0,2))}</span><span class="stock-name"><strong>${esc(mover.symbol)}</strong><small>${esc(mover.name || mover.symbol)}</small></span></button></td><td class="numeric stock-price">${number(mover.price)}</td><td class="numeric"><span class="change-pill ${mover.changePercent < 0 ? 'negative' : ''}">${percent(mover.changePercent)}</span></td><td class="numeric volume-cell">${compact(mover.volume)}</td><td class="reason-cell"><div class="reason-content"><b class="reason-label ${hasNews ? '' : 'unverified'}">${hasNews ? '资讯线索' : '待核实'}</b><span>${esc(reasonPreview)}</span></div></td><td><button class="row-detail" data-mover="${esc(mover.symbol)}" aria-label="展开 ${esc(mover.symbol)} 分析">${icon('arrow')}</button></td></tr>`;
  }).join('');
  $$('[data-watch]').forEach((button) => button.addEventListener('click', () => { const symbol = button.dataset.watch; state.saved.has(symbol) ? state.saved.delete(symbol) : state.saved.add(symbol); try { localStorage.setItem('market-pulse-watchlist', JSON.stringify([...state.saved])); } catch { toast('浏览器禁止本地存储，本次关注仅在当前页面有效'); } renderMovers(); }));
  $$('[data-mover]').forEach((button) => button.addEventListener('click', () => showMover([...(state.data.aiMovers || []), ...state.data.movers].find((mover) => mover.symbol === button.dataset.mover))));
}

function openDialog(eyebrow, content) {
  $('#dialog-eyebrow').textContent = eyebrow;
  $('#dialog-content').innerHTML = content;
  const dialog = $('#detail-dialog');
  const heading = $('#dialog-content h2');
  if (heading) { heading.id = 'dialog-title'; dialog.setAttribute('aria-labelledby', 'dialog-title'); }
  if (!dialog.open) dialog.showModal();
}

function sourceLink(source, label) {
  if (!source?.url) return '';
  return `<a class="source-link" href="${safeUrl(source.url)}" target="_blank" rel="noopener noreferrer">${esc(label || source.title || source.name || '查看原始来源')}${icon('external')}${source.publishedAt ? `<small>${timeText(source.publishedAt,{month:'2-digit',day:'2-digit'})} · 北京时间</small>` : ''}</a>`;
}

function showEvent(event) {
  openDialog('EVENT INTELLIGENCE', `<h2>${esc(event.title)}</h2><div class="dialog-subtitle">${esc(categoryName[event.category] || '市场事件')} · ${displayDate(eventDate(event))} ${esc(event.time ? timeText(event.time) : event.timeLabel || '全天')} · ${event.dateTimezone === 'America/New_York' ? '美东日期' : '北京时间'}${event.estimated || event.status === 'tentative' ? ' · 预计安排，尚待确认' : ''}</div><h3>为什么值得关注</h3><p>${esc(event.impact || '该事件可能改变市场预期，请留意官方公布的信息。')}</p>${event.tickers?.length ? `<h3>关注方向</h3><p>${event.tickers.map(esc).join(' · ')}</p>` : ''}<h3>原始来源</h3>${sourceLink(event.source)}<div class="dialog-note">事件等级表示潜在关注度。价格反应还取决于公布值与市场预期之间的差异；请以官方最终发布时间为准。</div>`);
}

function showMover(mover) {
  if (!mover) return;
  const sources = mover.reason?.sources || [];
  openDialog('BEHIND THE MOVE', `<h2>${esc(mover.symbol)} <span style="font-size:14px;font-weight:400;color:#99a39d">${esc(mover.name)}</span></h2><div class="dialog-subtitle">美股交易日 ${displayDate(mover.sessionDate || state.data.sessionDate)} · 常规交易时段收盘</div><div class="detail-metrics"><div><span>收盘价 / USD</span><strong>${number(mover.price)}</strong></div><div><span>当日涨跌幅</span><strong class="${mover.changePercent < 0 ? 'negative' : 'positive'}" style="color:var(--${mover.changePercent < 0 ? 'red' : 'green'})">${percent(mover.changePercent)}</strong></div><div><span>成交量</span><strong>${compact(mover.volume)}</strong></div></div><h3>${sources.length ? '异动相关资讯' : '原因状态：待核实'}</h3><p>${esc(mover.reason?.summary || '暂未取得可以核实本次股价变化原因的公开资讯。')}</p>${sources.length ? '<div class="dialog-note">以下为与该交易日相关的资讯线索。新闻关联性并不证明股价波动的直接原因。</div>' : ''}${sources.map((source) => sourceLink(source)).join('')}<h3>行情来源</h3>${sourceLink(mover.source)}<div class="dialog-note">异动标的来自已说明的采样股票池，按上一完整交易日绝对涨跌幅筛选。并非全市场涨跌幅排名。</div>`);
}

function showSources() {
  const sources = state.data?.sources || [];
  const labels = {ok:'已连接',live:'已连接',available:'已连接',partial:'部分可用',error:'暂不可用',failed:'暂不可用',unavailable:'暂不可用'};
  const details = sources.map((source) => `<div class="source-state ${['partial','error','failed','unavailable'].includes(source.status) ? 'failed' : ''}"><i></i>${esc(source.name)} · ${esc(labels[source.status] || source.status || '等待更新')}</div>${sourceLink(source, source.name)}${source.asOf ? `<p>来源时间：${timeText(source.asOf,{year:'numeric',month:'2-digit',day:'2-digit'})} 北京时间</p>` : ''}${source.method ? `<p>${esc(source.method)}</p>` : ''}${source.error ? `<p>${esc(source.error)}</p>` : ''}`).join('');
  openDialog('DATA & PROVENANCE', `<h2>数据来源与更新状态</h2><p>行情保留交易日和来源时间；宏观日历优先采用官方发布安排。</p>${details || '<div class="empty-state">等待数据服务返回来源状态</div>'}<h3>统计口径</h3><p>${esc(typeof state.data?.coverage?.movers === 'string' ? state.data.coverage.movers : '异动筛选覆盖主要美股及数据源可用的活跃候选股票。')}</p><p>${esc(typeof state.data?.coverage?.events === 'string' ? state.data.coverage.events : '未来七日公开日历，来源获取失败时会显示状态。')}</p>`);
}

async function loadLlmStatus() {
  try { llmConfig = await api('/api/llm/status'); } catch { llmConfig = null; }
  renderLlm();
}

function llmSourceChips(ids, report) {
  const catalog = Array.isArray(report.sourceCatalog) ? report.sourceCatalog : [];
  return `<div class="llm-evidence">${(ids || []).slice(0,4).map((id) => {
    const source = catalog.find((item) => item.id === id);
    if (!source?.url) return '';
    return `<a href="${safeUrl(source.url)}" target="_blank" rel="noopener noreferrer" title="${esc(source.title)}">${icon('external')}${esc((source.title || id).slice(0,28))}</a>`;
  }).join('')}</div>`;
}

function renderLlm() {
  const result = state.data?.llm || {};
  const status = result.status || (llmConfig?.configured ? llmConfig.enabled ? 'idle' : 'disabled' : 'unconfigured');
  const labels = {unconfigured:'未配置模型',disabled:'已停用',idle:'等待生成',running:'两位研究员分析中',ready:'解读已生成',error:'本次生成失败'};
  $('#llm-status').textContent = labels[status] || '等待连接';
  $('#llm-status').className = `llm-status ${status === 'ready' ? 'ready' : ''}`;
  const analyze = $('#llm-analyze');
  analyze.disabled = status === 'running' || state.historical;
  analyze.querySelector('span').textContent = status === 'running' ? '正在分析' : status === 'ready' ? '重新分析' : '生成 AI 解读';
  analyze.querySelector('svg').classList.toggle('spinning',status === 'running');
  if (status === 'ready') {
    const signals = Array.isArray(result.signals) ? result.signals : [];
    const movers = Array.isArray(result.movers) ? result.movers : [];
    const summary = typeof result.summary === 'string' ? result.summary : '已完成对当前证据的综合分析。';
    const notes = (result.warnings || []).map((item) => `<div class="llm-note">${esc(item)}</div>`).join('');
    const agents = [{role:'events',name:'事件研究员'},{role:'movers',name:'AI 个股研究员'}].map((agent) => {
      const completed = result.agents?.find((item) => item.role === agent.role)?.status !== 'error';
      return `<span class="${completed ? '' : 'failed'}"><i></i>${agent.name}${completed ? '' : ' · 未完成'}</span>`;
    }).join('');
    $('#llm-content').innerHTML = `<div class="llm-result-meta">${agents}<span>引用范围已检查</span><small>${esc(result.model || 'LLM')} · ${timeText(result.generatedAt,{month:'2-digit',day:'2-digit'})}</small></div><div class="llm-summary">${esc(summary)}</div>${notes}<div class="llm-insights">${signals.slice(0,3).map((item) => {
      const event = state.data.events.find((event) => event.id === item.eventId);
      return `<article class="llm-insight"><span class="section-eyebrow">EVENT LENS</span><h3>${esc(event?.title || '事件影响观察')}</h3><p>${esc(item.analysis)}</p>${item.scenario ? `<p class="llm-scenario"><b>观察情景</b>${esc(item.scenario)}</p>` : ''}${llmSourceChips(item.sourceIds,result)}</article>`;
    }).join('')}${movers.slice(0,3).map((item) => `<article class="llm-insight"><span class="section-eyebrow">EQUITY LENS</span><h3>${esc(item.symbol)} · 异动解读</h3><p>${esc(item.analysis)}</p>${item.risks?.length ? `<p class="llm-scenario"><b>风险与待核实</b>${item.risks.map(esc).join('；')}</p>` : ''}${llmSourceChips(item.sourceIds,result)}</article>`).join('')}</div>`;
    return;
  }
  const title = status === 'running' ? '两位研究员，正在并行阅读证据。' : status === 'error' ? '本次解读未能完成。' : status === 'disabled' ? '模型分析已停用。' : llmConfig?.configured ? '证据已经就位，开始一次研究。' : '让信息，连接成判断。';
  const description = status === 'running' ? '一位研究事件与产业传导，一位核对 AI 个股异动。完成后自动检查引用并显示结果。' : status === 'error' ? result.error || '模型响应或证据引用未通过检查，行情和规则分析仍可使用。' : llmConfig?.configured ? `已配置 ${llmConfig.model}。点击「生成 AI 解读」，或在每日更新时自动分析。` : '连接 DeepSeek、OpenAI 或兼容 API，获取有来源的事件解读、异动线索与风险情景。';
  $('#llm-content').innerHTML = `<div class="llm-empty"><span class="llm-symbol ${status === 'running' ? 'spinning' : ''}">✳</span><div><h3>${esc(title)}</h3><p>${esc(description)}</p><span class="llm-flow">数据与新闻 → 双研究员并行 → JSON 与来源检查 → 日报归档</span></div>${status === 'unconfigured' || status === 'disabled' ? '<button class="button button-white" id="llm-empty-configure">配置模型 '+icon('arrow')+'</button>' : ''}</div>`;
  $('#llm-empty-configure')?.addEventListener('click',showLlmConfig);
}

async function showLlmConfig() {
  await loadLlmStatus();
  const config = llmConfig || {};
  const presets = {deepseek:{baseUrl:'https://api.deepseek.com',model:'deepseek-flash'},openai:{baseUrl:'https://api.openai.com/v1',model:'gpt-4.1-mini'},custom:{baseUrl:'',model:''}};
  const provider = config.baseUrl?.includes('api.deepseek.com') ? 'deepseek' : config.baseUrl?.includes('api.openai.com') ? 'openai' : config.baseUrl ? 'custom' : 'deepseek';
  const baseUrl = config.baseUrl || presets[provider].baseUrl, model = config.model || presets[provider].model;
  openDialog('MODEL CONNECTION', `<h2>连接你的研究模型</h2><p>使用兼容 OpenAI Chat Completions 的 API。模型仅接收本次日报的有限行情、事件和相关新闻证据。</p><form id="llm-config-form" class="llm-config-form"><label>服务提供方<select id="llm-provider"><option value="deepseek" ${provider === 'deepseek' ? 'selected' : ''}>DeepSeek</option><option value="openai" ${provider === 'openai' ? 'selected' : ''}>OpenAI</option><option value="custom" ${provider === 'custom' ? 'selected' : ''}>自定义兼容服务</option></select></label><label>API Base URL<input id="llm-base-url" type="url" value="${esc(baseUrl)}" required spellcheck="false" placeholder="https://api.example.com/v1"></label><label>模型名称<input id="llm-model" value="${esc(model)}" required spellcheck="false" placeholder="填写服务商支持的模型 ID"></label><label>API Key<input id="llm-key" type="password" autocomplete="new-password" ${config.hasApiKey ? '' : 'required'} placeholder="${config.hasApiKey ? '已保存，留空保留原密钥' : '输入 API Key'}"></label><label class="llm-checkbox"><input id="llm-enabled" type="checkbox" ${config.configured && config.enabled === false ? '' : 'checked'}><span>启用 LLM，并在更新日报时自动分析</span></label><div id="llm-config-feedback" class="llm-config-feedback" role="status"></div><div class="dialog-note">密钥保存在本机数据目录，不写入网页或浏览器存储；配置接口不会返回密钥。请求由本地服务发送至你选择的提供方，可能产生 API 费用。</div><button class="button button-green llm-save" type="submit">保存配置</button></form>`);
  const protocolLabel=document.createElement('label');
  protocolLabel.textContent='接口类型';
  const protocolSelect=document.createElement('select');protocolSelect.id='llm-api-type';
  protocolSelect.innerHTML='<option value="chat">Chat Completions</option><option value="responses">Responses API</option>';
  protocolSelect.value=config.apiType || 'chat';protocolLabel.append(protocolSelect);
  $('#llm-config-form').insertBefore(protocolLabel,$('#llm-provider').closest('label').nextSibling);
  $('#llm-config-form').previousElementSibling.textContent='支持 OpenAI Chat Completions 与 Responses 两类接口。模型仅接收本次日报的有限行情、事件和相关新闻证据。';
  $('#llm-provider').addEventListener('change',(event) => { const preset=presets[event.target.value]; $('#llm-base-url').value=preset.baseUrl; $('#llm-model').value=preset.model; protocolSelect.value=event.target.value==='deepseek'?'chat':'responses'; });
  $('#llm-config-form').addEventListener('submit',async (event) => {
    event.preventDefault();
    const button = event.target.querySelector('[type="submit"]'); button.disabled = true;
    const secret = $('#llm-key');
    try {
      llmConfig = await api('/api/llm/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseUrl:$('#llm-base-url').value.trim(),model:$('#llm-model').value.trim(),apiType:protocolSelect.value,apiKey:secret.value.trim(),enabled:$('#llm-enabled').checked})});
      secret.value = '';
      if (state.data) state.data.llm = {status:llmConfig.enabled ? 'idle' : 'disabled'};
      $('#detail-dialog').close(); renderLlm(); toast('模型配置已保存，可开始生成解读');
    } catch (error) { $('#llm-config-feedback').textContent = `保存失败：${error.message}`; button.disabled = false; }
  });
}

async function analyzeWithLlm() {
  if (state.historical) return toast('请返回最新日报再生成解读');
  if (!llmConfig?.configured || !llmConfig.enabled) return showLlmConfig();
  const button = $('#llm-analyze'); button.disabled=true;
  try {
    const response = await api('/api/llm/analyze',{method:'POST'});
    if (state.data && response.llm) {state.data.llm=response.llm;renderLlm();}
    toast('已启动双研究员分析，完成后自动显示');
    clearTimeout(pollingTimer);pollingTimer=setTimeout(()=>loadDashboard(),3000);
  } catch(error) { toast(`解读未启动：${error.message}`);button.disabled=false; }
}

async function renderReports() {
  $('#reports-list').innerHTML = '<div class="empty-state">正在读取日报档案…</div>';
  try {
    const response = await api('/api/reports');
    state.reports = response.reports || [];
    if (!state.reports.length) { $('#reports-list').innerHTML = '<div class="empty-state">第一份日报，正在路上。<small>完成更新后，日报会自动保存到这里。</small></div>'; return; }
    $('#reports-list').innerHTML = state.reports.map((report) => `<button class="report-card" data-report="${esc(report.date)}"><span class="section-eyebrow">MARKET PULSE / DAILY REPORT</span><strong class="report-card-date">${displayDate(report.date)}</strong><p>美股交易日 ${displayDate(report.sessionDate)}</p><p>${number(report.eventCount,0)} 项事件信号 · ${number(report.moverCount,0)} 只异动标的</p><div class="report-card-bottom"><span>${esc(report.status === 'live' ? '已归档' : report.status === 'partial' ? '部分数据' : '数据状态待核实')}</span>${icon('arrow')}</div></button>`).join('');
    $$('[data-report]').forEach((button) => button.addEventListener('click', () => loadReport(button.dataset.report)));
  } catch (error) { $('#reports-list').innerHTML = `<div class="empty-state">日报档案暂时无法读取<small>${esc(error.message)}</small></div>`; }
}

async function loadReport(date) {
  try {
    const data = await api(`/api/reports/${encodeURIComponent(date)}`);
    state.historical = true; state.data = data; state.day = 'all';
    location.hash = '#overview';
    render();
    toast(`已打开 ${displayDate(date)} 日报`);
  } catch (error) { toast(`无法打开日报：${error.message}`); }
}

function setView() {
  const validViews = { overview:'市场概览', signals:'七日信号', movers:'个股异动', watchlist:'我的关注', reports:'日报档案' };
  state.view = Object.hasOwn(validViews, location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  const view = state.view;
  $$('.nav-link').forEach((link) => { link.classList.toggle('active', link.dataset.view === view); link.toggleAttribute('aria-current', link.dataset.view === view); });
  $('#breadcrumb-view').textContent = validViews[view];
  const headings = {overview:state.focus === 'ai' ? ['聚焦 AI，读懂市场','连接芯片、云平台、数据中心与应用，追踪 AI 产业的每一次波动。'] : ['读懂波动，观察市场','连接市场表现与关键事件，让每一次观察都有据可循。'],signals:['下一个变量，提前关注','滚动追踪未来七天的财报、经济数据、美联储与交易日历。'],movers:['追踪价格，寻找线索','从上一完整交易日的股价变化出发，核对资讯来源。'],watchlist:['你的关注，持续追踪','收藏进入异动列表的标的，回到这里跟踪它们。'],reports:['每日观察，积累视野','回看每一份日报，连接过去的信号与市场表现。']};
  $('#page-title').innerHTML = `${headings[view][0]}<span>。</span>`;
  $('#page-subtitle').textContent = headings[view][1];
  $('#overview-section').hidden = view !== 'overview';
  $('#llm-section').hidden = view !== 'overview';
  $('#signals-section').hidden = !['overview','signals'].includes(view);
  $('#movers-section').hidden = !['overview','movers','watchlist'].includes(view);
  $('#reports-section').hidden = view !== 'reports';
  $('#archive-button').hidden = view === 'reports';
  $('#focus-bar').hidden = view === 'reports';
  if (view === 'reports') renderReports();
  renderEvents(); renderMovers();
  $('#sidebar').classList.remove('open'); $('#sidebar-overlay').classList.remove('visible');
  window.scrollTo({top:0,behavior:'instant'});
}

function updateClock() {
  const now = new Date();
  $('#beijing-clock').textContent = `北京时间 ${timeText(now,{month:'2-digit',day:'2-digit'})}`;
  const session = state.historical ? null : state.data?.marketSession;
  const labels = { open:'美股交易中', pre:'美股盘前', post:'美股盘后', closed:'常规时段休市', holiday:'节假日休市', weekend:'周末休市' };
  $('#market-status').innerHTML = `<i></i>${labels[session?.status] || (state.historical ? '历史日报' : '收盘数据')}`;
  $('#market-status').title = session?.note || '市场状态由后端交易日历核对';
  $('#market-status').classList.toggle('open',session?.status === 'open');
}

$('#refresh-button').addEventListener('click', () => loadDashboard({refresh:true}));
$('#archive-button').addEventListener('click', () => { location.hash = '#reports'; });
$('#event-category').addEventListener('change', (event) => { state.category = event.target.value; renderEvents(); });
$('#all-events-button').addEventListener('click', () => { state.expandedEvents = !state.expandedEvents; renderEvents(); });
$('#show-movers-button').addEventListener('click', () => { state.expandedMovers = !state.expandedMovers; renderMovers(); });
$('#stock-search').addEventListener('input', (event) => { state.query = event.target.value.trim().toLowerCase(); renderMovers(); });
$('#llm-configure').addEventListener('click',showLlmConfig);
$('#llm-analyze').addEventListener('click',analyzeWithLlm);
$('#llm-method').addEventListener('click',() => openDialog('GROUNDED RESEARCH WORKFLOW','<h2>两位研究员，一份证据包。</h2><p>先由程序获取最近完整交易日的行情、未来七天事件和相关新闻，固定数据截点，再将有限证据交给两位 LLM 研究员并行分析。</p><h3>事件研究员</h3><p>解释宏观与 AI 相关财报如何传导至利率、需求、资本支出和行业预期，列出条件情景及仍待确认的信息。</p><h3>AI 个股研究员</h3><p>结合程序计算的涨跌、相对表现、量比和收盘前新闻，整理潜在催化因素、替代解释与风险。</p><h3>程序校验</h3><p>结果必须符合 JSON 结构，个股、事件和引用 ID 必须来自本次证据包。未知链接和越界标的不予展示，行情数值保持程序原值。引用存在不等于事实或因果已获证明。</p><div class="dialog-note">参考 TradingAgents 的分工研究、FinRobot 的确定性计算与模型叙述分层，以及 ai-hedge-fund 的结构化输出和失败保留未知。本站未验证或采用这些项目的盈利宣传、交易策略与预测胜率。</div>'));
$$('#focus-selector button').forEach((button) => button.addEventListener('click', () => {
  state.focus = button.dataset.focus; state.aiCategory = 'all';
  $$('#focus-selector button').forEach((item) => item.classList.toggle('selected', item === button));
  $$('#ai-categories button').forEach((item) => item.classList.toggle('selected', item.dataset.aiCategory === 'all'));
  $('#ai-categories').hidden = state.focus !== 'ai';
  setView(); if (state.data) { renderBrief(); renderDays(); $('#nav-events').textContent = visibleEvents().length; }
}));
$$('[data-ai-category]').forEach((button) => button.addEventListener('click', () => {
  state.aiCategory = button.dataset.aiCategory;
  $$('[data-ai-category]').forEach((item) => item.classList.toggle('selected', item === button));
  renderMovers(); renderEvents(); renderDays(); if (state.data) renderBrief();
  $('#nav-events').textContent = visibleEvents().length;
}));
$('#method-button').addEventListener('click', () => openDialog('METHODOLOGY / RULES, NOT ODDS', '<h2>分析依据与算法</h2><p>当前版本采用规则驱动的事件观察与描述统计，没有训练涨跌预测模型，没有经过回测的预测胜率。“高影响”表示需要关注，不代表必涨、必跌或某个概率。</p><h3>01 · 已公布事件日历</h3><p>从官方日历读取未来七天的经济数据、FOMC 和交易安排；Nasdaq 财报标为预计。事件关注级别由预设规则分类，不是机器学习预测结果。宏观事件在 AI 范围下仍保留，用于观察利率与估值背景。</p><h3>02 · 价格、相对强弱与量比</h3><p>当日涨跌幅 =（本次收盘价 ÷ 前次收盘价 − 1）× 100%。异动门槛为绝对涨跌幅 ≥3%、成交量 &gt;10 万股，各方向最多 8 只。相对强弱 = 个股涨跌幅 − 标普 500 涨跌幅；量比 = 当日成交量 ÷ 此前最多 20 个交易日均量。</p><h3>03 · 新闻关键词分类</h3><p>读取前一交易日收盘至目标交易日收盘之间的相关报道，用关键词规则归入业绩、指引、评级、并购、监管等类别。当前没有用大模型确认因果；新闻关联性需要结合原文核实。</p><h3>04 · AI 产业关联</h3><p>按公司业务关联将重点股票映射到芯片算力、云平台、数据中心、AI 应用。分类为人工维护的研究范围，并不代表这些公司的收入全部来自 AI。当前异动来自样本股票池，非全市场完整排名。</p><div class="dialog-note">后续若增加波动概率，需要历史事件样本、基准模型、滚动样本外回测及校准检验。当前界面不提供未经验证的涨跌概率或目标价。</div>'));
$('#sort-movers').addEventListener('click', () => { state.sortDescending = !state.sortDescending; $('#sort-movers span').textContent = state.sortDescending ? '↓' : '↑'; renderMovers(); });
$$('#mover-filter button').forEach((button) => button.addEventListener('click', () => { state.direction = button.dataset.direction; $$('#mover-filter button').forEach((item) => item.classList.toggle('selected', item === button)); renderMovers(); }));
$$('#chart-selector button').forEach((button) => button.addEventListener('click', () => selectChart(button.dataset.chart)));
$('#source-button').addEventListener('click', showSources);
$('#footer-sources').addEventListener('click', showSources);
$('#schedule-info').addEventListener('click', () => openDialog('DAILY SCHEDULE', '<h2>每天 20:00，更新视野。</h2><p>每日北京时间 20:00（Asia/Shanghai）自动生成日报，并保存历史档案。网站服务运行时会检查并补齐当日应生成的日报。</p><h3>日报包含什么</h3><p>上一完整美股交易日的指数表现和采样股票异动，以及未来七天内的官方事件信号。周末与美股休市日会回溯至最近交易日。</p><div class="dialog-note">后台服务需要持续运行，才能按时更新。采集依赖公开数据源；连接失败会显示来源状态与原有数据日期。</div>'));
$('#dialog-close').addEventListener('click', () => $('#detail-dialog').close());
$('#detail-dialog').addEventListener('click', (event) => { if (event.target === $('#detail-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
$('#menu-toggle').addEventListener('click', () => { $('#sidebar').classList.toggle('open'); $('#sidebar-overlay').classList.toggle('visible'); });
$('#sidebar-overlay').addEventListener('click', () => { $('#sidebar').classList.remove('open'); $('#sidebar-overlay').classList.remove('visible'); });
window.addEventListener('hashchange',setView);
setView(); updateClock(); setInterval(updateClock,30000); loadDashboard(); loadLlmStatus();
