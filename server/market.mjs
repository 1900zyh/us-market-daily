import { dateInZone, sessionCloseUtc, shiftDate, tradingDateAt } from './dates.mjs';
import { AI_UNIVERSE, aiCategoryFor } from './ai-universe.mjs';
import { fetchChartCompatible } from './market-fallback.mjs';

const YAHOO = 'https://query1.finance.yahoo.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json, text/plain, */*' };
export const INDEX_CONFIG = [
  ['^GSPC', '标普 500'], ['^IXIC', '纳斯达克综合'], ['^DJI', '道琼斯工业'], ['^VIX', 'VIX 恐慌指数'],
];
const STOCKS = [
  ['NVDA','NVIDIA','半导体'], ['AAPL','Apple','科技'], ['MSFT','Microsoft','科技'], ['AMZN','Amazon','消费'], ['GOOGL','Alphabet','科技'],
  ['META','Meta Platforms','科技'], ['TSLA','Tesla','汽车'], ['AVGO','Broadcom','半导体'], ['AMD','Advanced Micro Devices','半导体'],
  ['PLTR','Palantir','软件'], ['NFLX','Netflix','媒体'], ['ORCL','Oracle','软件'], ['CRM','Salesforce','软件'], ['ADBE','Adobe','软件'],
  ['INTC','Intel','半导体'], ['MU','Micron','半导体'], ['QCOM','Qualcomm','半导体'], ['ARM','Arm','半导体'], ['TSM','Taiwan Semiconductor','半导体'],
  ['JPM','JPMorgan','金融'], ['BAC','Bank of America','金融'], ['GS','Goldman Sachs','金融'], ['MS','Morgan Stanley','金融'], ['V','Visa','支付'],
  ['MA','Mastercard','支付'], ['PYPL','PayPal','支付'], ['COIN','Coinbase','加密资产'], ['HOOD','Robinhood','金融'], ['MSTR','Strategy','加密资产'],
  ['XOM','Exxon Mobil','能源'], ['CVX','Chevron','能源'], ['OXY','Occidental','能源'], ['WMT','Walmart','零售'], ['TGT','Target','零售'],
  ['COST','Costco','零售'], ['HD','Home Depot','零售'], ['LOW','Lowe','零售'], ['NKE','Nike','消费'], ['DIS','Walt Disney','媒体'],
  ['SBUX','Starbucks','消费'], ['MCD','McDonald','消费'], ['KO','Coca-Cola','消费'], ['PEP','PepsiCo','消费'], ['BABA','Alibaba','中概股'],
  ['PDD','PDD Holdings','中概股'], ['JD','JD.com','中概股'], ['BIDU','Baidu','中概股'], ['NIO','NIO','汽车'], ['LI','Li Auto','汽车'],
  ['UNH','UnitedHealth','医疗'], ['LLY','Eli Lilly','医疗'], ['JNJ','Johnson & Johnson','医疗'], ['PFE','Pfizer','医疗'], ['MRNA','Moderna','生物科技'],
  ['ABBV','AbbVie','医疗'], ['MRK','Merck','医疗'], ['NVO','Novo Nordisk','医疗'], ['BA','Boeing','航空'], ['CAT','Caterpillar','工业'],
  ['GE','GE Aerospace','工业'], ['LMT','Lockheed Martin','国防'], ['RTX','RTX','国防'], ['UBER','Uber','出行'], ['ABNB','Airbnb','旅游'],
  ['RBLX','Roblox','游戏'], ['SHOP','Shopify','电商'], ['SNOW','Snowflake','软件'], ['CRWD','CrowdStrike','网络安全'], ['PANW','Palo Alto Networks','网络安全'],
  ['NET','Cloudflare','软件'], ['DDOG','Datadog','软件'], ['SOFI','SoFi','金融'], ['RIVN','Rivian','汽车'], ['LCID','Lucid','汽车'],
  ['SMCI','Super Micro Computer','硬件'], ['DELL','Dell','硬件'], ['HPE','Hewlett Packard Enterprise','硬件'], ['F','Ford','汽车'], ['GM','General Motors','汽车'],
  ['WBD','Warner Bros','媒体'], ['SPOT','Spotify','媒体'], ['DASH','DoorDash','消费'], ['APP','AppLovin','软件'], ['IREN','IREN','基础设施'],
];

async function fetchText(url, timeout = 12000, signal) {
  const response = await fetch(url, { headers: HEADERS, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 8_000_000) throw new Error('上游响应过大');
  return body;
}

async function parallelMap(values, limit, fn) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      try { results[index] = { value: await fn(values[index], index) }; }
      catch (error) { results[index] = { error: error.message }; }
    }
  }));
  return results;
}

export function normalizeChart(result, sessionDate, config = {}) {
  const closes = result?.indicators?.quote?.[0]?.close;
  const volumes = result?.indicators?.quote?.[0]?.volume;
  if (!result?.timestamp || !closes) throw new Error('行情结构不完整');
  const bars = result.timestamp.map((timestamp, index) => ({
    time: new Date(timestamp * 1000).toISOString(),
    date: dateInZone(new Date(timestamp * 1000), 'America/New_York'),
    close: closes[index], volume: volumes?.[index],
  })).filter(bar => Number.isFinite(bar.close) && bar.close > 0 && bar.date <= sessionDate);
  const latest = bars.at(-1), previous = bars.at(-2);
  if (latest?.date !== sessionDate) throw new Error(`缺少 ${sessionDate} 收盘数据`);
  if (!previous) throw new Error('缺少前一交易日收盘价');
  const priorVolumes = bars.slice(-21, -1).map(bar => bar.volume).filter(volume => Number.isFinite(volume) && volume > 0);
  const averageVolume = priorVolumes.length ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length : null;
  return {
    symbol: result.meta.symbol, name: config.name || result.meta.longName || result.meta.shortName || result.meta.symbol,
    price: latest.close, previousClose: previous.close, change: latest.close - previous.close,
    changePercent: (latest.close / previous.close - 1) * 100,
    volume: latest.volume || 0, volumeRatio: averageVolume ? latest.volume / averageVolume : null,
    marketCap: config.marketCap ?? null, sector: config.sector || '其他', sessionDate,
    ai: Boolean(aiCategoryFor(result.meta.symbol)), aiCategory: aiCategoryFor(result.meta.symbol),
    asOf: sessionCloseUtc(sessionDate).toISOString(), currency: result.meta.currency || 'USD',
    history: bars.map(bar => ({ time: bar.time, close: bar.close })),
    source: { name: 'Yahoo Finance', url: `https://finance.yahoo.com/quote/${encodeURIComponent(result.meta.symbol)}/history/` },
  };
}

function decodeXml(text = '') {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&#(\d+);/g, (_, value) => String.fromCharCode(Number(value))).trim();
}

function xmlValue(item, tag) { return decodeXml(item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1]); }

export function parseNews(xml, stock, sessionDate) {
  const end = sessionCloseUtc(sessionDate).getTime();
  const previousSession = tradingDateAt(new Date(end - 1));
  const begin = sessionCloseUtc(previousSession).getTime();
  const symbol = stock.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const names = stock.name.replace(/,.*$/, '').replace(/\b(Inc\.?|Corporation|Corp\.?|Limited|Holdings|Company|Technologies|Platforms)\b/gi, '').trim();
  return [...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(match => {
    const title = xmlValue(match[1], 'title'), description = xmlValue(match[1], 'description');
    const url = xmlValue(match[1], 'link'), publishedAt = xmlValue(match[1], 'pubDate');
    const timestamp = new Date(publishedAt).getTime();
    const relevant = new RegExp(`\\b${symbol}\\b`, 'i').test(`${title} ${description}`) || (names.length > 2 && `${title} ${description}`.toLowerCase().includes(names.toLowerCase()));
    return { title, url, publishedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null, description, timestamp, relevant };
  }).filter(item => item.relevant && item.timestamp >= begin && item.timestamp <= end && /^https:\/\//.test(item.url)).sort((a,b) => b.timestamp - a.timestamp).slice(0, 3);
}

export function selectMovers(equities, { aiOnly = false, limitPerDirection = 8 } = {}) {
  const qualified = equities.filter(stock => (!aiOnly || Boolean(aiCategoryFor(stock.symbol))) && Math.abs(stock.changePercent) >= 3 && stock.volume > 100_000);
  return [...qualified.filter(stock => stock.changePercent >= 0).sort((a,b) => b.changePercent - a.changePercent).slice(0, limitPerDirection), ...qualified.filter(stock => stock.changePercent < 0).sort((a,b) => a.changePercent - b.changePercent).slice(0, limitPerDirection)].sort((a,b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
}

function explain(stock, articles, benchmark) {
  const move = `当日${stock.changePercent >= 0 ? '上涨' : '下跌'} ${Math.abs(stock.changePercent).toFixed(2)}%`;
  const relative = Number.isFinite(benchmark) ? `，相对标普 500 ${stock.changePercent - benchmark >= 0 ? '跑赢' : '跑输'} ${Math.abs(stock.changePercent - benchmark).toFixed(2)} 个百分点` : '';
  const volume = Number.isFinite(stock.volumeRatio) ? `；成交量为前 ${Math.min(20, stock.history.length - 1)} 个交易日均量的 ${stock.volumeRatio.toFixed(2)} 倍` : '';
  const context = `${move}${relative}${volume}。`;
  if (!articles.length) return { summary: `${context}暂未获取到收盘前足以解释本次异动的公司相关新闻，具体催化因素待核实。`, type: 'unverified', label: '原因待核实', sources: [] };
  const text = articles.map(article => `${article.title} ${article.description}`).join(' ');
  let theme = '公司动态及市场预期变化';
  if (/earnings|quarter|revenue|profit|guidance|outlook|results|EPS/i.test(text)) theme = '财报、经营业绩或业绩指引';
  else if (/upgrade|downgrade|price target|analyst|rating/i.test(text)) theme = '分析师评级与估值预期';
  else if (/acquisition|merger|acquire|takeover|buyout/i.test(text)) theme = '并购及交易动态';
  else if (/FDA|trial|drug|clinical|approval/i.test(text)) theme = '药品研发或监管进展';
  else if (/\bAI\b|artificial intelligence|\bchips?\b|semiconductor/i.test(text)) theme = '人工智能及半导体行业动态';
  else if (/bitcoin|crypto|token/i.test(text)) theme = '加密资产价格与行业情绪';
  else if (/lawsuit|litigation|regulator|antitrust/i.test(text)) theme = '诉讼及监管动态';
  return {
    summary: `${context}收盘前的相关报道涉及${theme}，可作为本次异动的追踪线索；新闻与涨跌的因果关系尚未独立证实。`,
    type: 'news-context', label: '新闻线索', theme,
    sources: articles.map(({ title, url, publishedAt }) => ({ title, url, publishedAt })),
  };
}

export async function getMarketData({ sessionDate, now = new Date() }) {
  const startedAt = now.toISOString();
  const budget = AbortSignal.timeout(40000);
  const sources = [], errors = [];
  const universe = new Map(STOCKS.map(([symbol, name, sector]) => [symbol, { symbol, name, sector }]));
  for (const [symbol, entry] of Object.entries(AI_UNIVERSE)) {
    const existing = universe.get(symbol);
    universe.set(symbol, { symbol, name: existing?.name || entry.name, sector: entry.sector });
  }
  const screens = await parallelMap(['day_gainers', 'day_losers', 'most_actives'], 3, async name => {
    const data = JSON.parse(await fetchText(`${YAHOO}/v1/finance/screener/predefined/saved?scrIds=${name}&count=30`, 10000, budget));
    const quotes = data.finance?.result?.[0]?.quotes;
    if (!quotes) throw new Error('筛选器返回空结果');
    return quotes;
  });
  let screenCount = 0;
  for (const result of screens) {
    if (result.error) { errors.push(`候选标的筛选：${result.error}`); continue; }
    screenCount++;
    for (const quote of result.value) {
      if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(quote.symbol) || (quote.marketCap && quote.marketCap < 1_000_000_000)) continue;
      const current = universe.get(quote.symbol);
      universe.set(quote.symbol, { symbol: quote.symbol, name: current?.name || quote.shortName || quote.longName || quote.symbol, sector: current?.sector || quote.sector || '其他', marketCap: quote.marketCap });
    }
  }
  sources.push({ name: 'Yahoo Finance 标的筛选', url: 'https://finance.yahoo.com/markets/stocks/gainers/', status: screenCount === 3 ? 'ok' : screenCount ? 'partial' : 'error', asOf: startedAt, ...(screenCount !== 3 ? { error: '部分筛选器不可用；仍覆盖固定高流动性标的样本' } : {}) });
  // Preserve the 40-second budget for the primary AI workflow before broad-market extras.
  const configs = [...INDEX_CONFIG.map(([symbol, name]) => ({ symbol, name, isIndex: true })), ...[...universe.values()].filter(stock=>aiCategoryFor(stock.symbol)), ...[...universe.values()].filter(stock=>!aiCategoryFor(stock.symbol))];
  const results = await parallelMap(configs, 8, async config => {
    budget.throwIfAborted();
    try {
      const data = JSON.parse(await fetchText(`${YAHOO}/v8/finance/chart/${encodeURIComponent(config.symbol)}?interval=1d&range=3mo`, 6000, budget));
      if (data.chart?.error) throw new Error(data.chart.error.description || '上游行情错误');
      return { ...normalizeChart(data.chart.result[0], sessionDate, config), isIndex: Boolean(config.isIndex) };
    } catch (primaryError) {
      // Nasdaq equity history is a separate provider. Never relabel it as Yahoo
      // or substitute an ETF when the requested instrument is an index.
      if(config.isIndex || budget.aborted)throw primaryError;
      try {
        const fallback=await fetchChartCompatible(config.symbol,sessionDate,{signal:budget,timeout:5000});
        return {...normalizeChart(fallback,sessionDate,config),source:fallback.source,fetchedAt:fallback.fetchedAt,priceBasis:fallback.priceBasis,isIndex:false};
      } catch(fallbackError) {
        throw new Error(`Yahoo: ${primaryError.message}；Nasdaq: ${fallbackError.message}`);
      }
    }
  });
  const successful = results.filter(result => result.value).map(result => result.value);
  const failed = results.flatMap((result, index) => result.error ? [`${configs[index].symbol}: ${result.error}`] : []);
  const indices = successful.filter(stock => stock.isIndex).map(({ isIndex, ...stock }) => stock);
  const equities = successful.filter(stock => !stock.isIndex);
  const benchmark = indices.find(index => index.symbol === '^GSPC')?.changePercent;
  const qualifying = equities.filter(stock => Math.abs(stock.changePercent) >= 3 && stock.volume > 100_000);
  const top = selectMovers(equities), aiTop = selectMovers(equities, { aiOnly: true });
  const newsUniverse = [...new Map([...top, ...aiTop].map(stock => [stock.symbol, stock])).values()];
  let newsSuccess = 0;
  const news = await parallelMap(newsUniverse, 6, async stock => {
    let articles = [];
    try {
      const xml = await fetchText(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(stock.symbol)}&region=US&lang=en-US`, 8000, budget);
      articles = parseNews(xml, stock, sessionDate);
    } catch (error) { if (budget.aborted) throw error; }
    if (!articles.length) {
      budget.throwIfAborted();
      const previousSession = tradingDateAt(new Date(sessionCloseUtc(sessionDate).getTime() - 1));
      const query = encodeURIComponent(`${stock.symbol} ${stock.name.split(' ')[0]} stock after:${previousSession} before:${shiftDate(sessionDate, 1)}`);
      const xml = await fetchText(`https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`, 7000, budget);
      articles = parseNews(xml, stock, sessionDate);
    }
    return articles;
  });
  const enriched = new Map(newsUniverse.map((stock, index) => {
    if (!news[index].error) newsSuccess++;
    const { isIndex, ...rest } = stock;
    return [stock.symbol, { ...rest, direction: stock.changePercent >= 0 ? 'up' : 'down', reason: explain(stock, news[index].value || [], benchmark) }];
  }));
  const movers = top.map(stock => enriched.get(stock.symbol)), aiMovers = aiTop.map(stock => enriched.get(stock.symbol));
  const nasdaqCount=successful.filter(stock=>stock.source?.name?.startsWith('Nasdaq')).length;
  const yahooCount=successful.length-nasdaqCount;
  sources.push({ name: 'Yahoo Finance 历史收盘行情', url: 'https://finance.yahoo.com/', status: yahooCount===configs.length?'ok':yahooCount?'partial':'error', asOf: sessionCloseUtc(sessionDate).toISOString(), fetchedAt: new Date().toISOString(), ...(yahooCount!==configs.length ? { error: `${yahooCount}/${configs.length} 个标的由 Yahoo 取得；${nasdaqCount} 个使用 Nasdaq 备用源；${failed.length} 个仍不可用${failed.length?`，${failed.slice(0,3).join('；')}`:''}` } : {}) });
  if(nasdaqCount)sources.push({name:'Nasdaq 历史收盘行情（备用）',url:'https://www.nasdaq.com/market-activity/stocks',status:'ok',asOf:sessionCloseUtc(sessionDate).toISOString(),fetchedAt:new Date().toISOString(),method:`${nasdaqCount} 个股票从备用源取得目标交易日 Close/Last；按各股票标注真实来源，不含指数替代。`});
  sources.push({ name: 'Yahoo Finance / Google News 公司新闻', url: 'https://finance.yahoo.com/news/', status: !newsUniverse.length || newsSuccess === newsUniverse.length ? 'ok' : newsSuccess ? 'partial' : 'error', asOf: startedAt, ...(newsSuccess < newsUniverse.length ? { error: '部分公司新闻源不可用，相应原因标记为待核实' } : {}) });
  if (failed.length) errors.push(`${failed.length} 个行情请求失败或缺少目标交易日数据`);
  const aiEligible = equities.filter(stock => stock.ai), aiQualified = qualifying.filter(stock => stock.ai);
  return { indices, movers, aiMovers, sources, errors,
    aiCoverage: { scannedSymbols: Object.keys(AI_UNIVERSE).length, eligibleSymbols: aiEligible.length, qualifiedSymbols: aiQualified.length, absoluteChangeThreshold: 3, minVolume: 100000, movers: `AI 观察池 ${Object.keys(AI_UNIVERSE).length} 只，${aiEligible.length} 只取得 ${sessionDate} 收盘数据；覆盖芯片、云平台、算力基础设施和应用软件。独立筛选涨跌幅 ≥3%、成交量 >10 万股，涨跌各最多 8 只。分类仅表示 AI 业务关联，不代表纯 AI 收入或完整行业覆盖。` },
    coverage: { scannedSymbols: universe.size, eligibleSymbols: equities.length, qualifiedSymbols: qualifying.length, absoluteChangeThreshold: 3, minVolume: 100000, movers: `覆盖 ${equities.length} 个已取得收盘数据的标的；固定高流动性样本及 Yahoo 当日活跃/涨跌候选，按 ${sessionDate} 涨跌幅筛选 ≥3%、成交量 >10 万股，展示涨跌各最多 8 只。非全市场排名。` } };
}
