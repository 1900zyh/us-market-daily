import {nyTimeToUtc,shiftDate} from './dates.mjs';

const HEADERS={'User-Agent':'Mozilla/5.0','Accept':'application/json, text/plain, */*','Origin':'https://www.nasdaq.com','Referer':'https://www.nasdaq.com/'};
const memory=new Map();
function numeric(value) {
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value!=='string'||!/[0-9]/.test(value)||/^N\/?A$/i.test(value))return null;
  const number=Number(value.replace(/[$,\s]/g,''));return Number.isFinite(number)?number:null;
}
export function normalizeNasdaqHistory(payload,symbol,sessionDate) {
  if(payload?.status?.rCode!==200||!payload?.data?.tradesTable?.rows)throw new Error('Nasdaq 未提供有效历史行情');
  if(payload.data.symbol?.toUpperCase()!==symbol.toUpperCase())throw new Error('Nasdaq 返回的代码与请求不符');
  const rows=payload.data.tradesTable.rows.map(row=>{
    const parts=String(row.date).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if(!parts)return null;
    const date=`${parts[3]}-${parts[1]}-${parts[2]}`,close=numeric(row.close),volume=numeric(row.volume);
    if(date>sessionDate||!(close>0))return null;
    return {date,close,volume,open:numeric(row.open),high:numeric(row.high),low:numeric(row.low)};
  }).filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date));
  if(rows.at(-1)?.date!==sessionDate)throw new Error(`Nasdaq 缺少 ${sessionDate} 收盘数据`);
  if(rows.length<2)throw new Error('Nasdaq 缺少前一交易日收盘数据');
  const bars=[...new Map(rows.map(row=>[row.date,row])).values()];
  return {
    meta:{symbol:symbol.toUpperCase(),currency:'USD',exchangeTimezoneName:'America/New_York'},
    timestamp:bars.map(row=>Math.floor(+nyTimeToUtc(row.date,9,30)/1000)),
    indicators:{quote:[Object.fromEntries(['close','volume','open','high','low'].map(key=>[key,bars.map(row=>row[key])]))]},
    source:{name:'Nasdaq 历史行情（备用）',url:`https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}/historical`},
    priceBasis:'Nasdaq Close/Last, unadjusted; do not mix with adjusted series',
  };
}

/** Returns the Yahoo chart.result[0] shape plus its real source metadata.
 * Only US equity symbols are supported. Never substitutes an ETF for an index.
 * Caller MUST preserve result.source after its usual normalizeChart step.
 */
export async function fetchChartCompatible(symbol,sessionDate,{signal,timeout=7000}={}) {
  if(!/^[A-Z][A-Z0-9.\-]{0,9}$/i.test(symbol))throw new Error('Nasdaq 备用源仅支持股票代码，不替代指数');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)||!Number.isFinite(Date.parse(sessionDate)))throw new Error('无效交易日期');
  const key=`${symbol.toUpperCase()}:${sessionDate}`,cached=memory.get(key);
  if(cached&&Date.now()-cached.fetchedAt<30*60*1000)return cached.result;
  const url=`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=stocks&limit=100&fromdate=${shiftDate(sessionDate,-95)}&todate=${sessionDate}`;
  const local=AbortSignal.timeout(timeout);
  const response=await fetch(url,{headers:HEADERS,signal:signal?AbortSignal.any([signal,local]):local});
  if(!response.ok)throw new Error(`Nasdaq HTTP ${response.status}`);
  const text=await response.text();if(text.length>2_000_000)throw new Error('Nasdaq 响应过大');
  const result=normalizeNasdaqHistory(JSON.parse(text),symbol,sessionDate);
  result.fetchedAt=new Date().toISOString();
  memory.set(key,{result,fetchedAt:Date.now()});return result;
}
