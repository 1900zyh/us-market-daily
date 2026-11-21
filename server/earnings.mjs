import {beijingDate,zonedISO} from './calendar.mjs';

const API='https://api.nasdaq.com/api/calendar/earnings?date=';
const WEB='https://www.nasdaq.com/market-activity/earnings';
const cache=new Map();
const WATCHED=new Set(['NVDA','AAPL','MSFT','AMZN','GOOGL','GOOG','META','TSLA','AMD','AVGO','MU','PLTR','SMCI','DELL','HPE','ADI','ADSK','WDAY','DE','MDT','CRM','CRWD','PANW','SNOW','NET','INTC','QCOM','TSM','BABA','PDD','JD','BIDU','NIO','LI','XPEV','WMT','TGT','COST','NFLX','COIN','MSTR','GME','SOFI','HOOD']);
function dateInZone(value,timeZone) {
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value)).map(v=>[v.type,v.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function addDays(date,count){return new Date(Date.parse(`${date}T12:00:00Z`)+count*86400000).toISOString().slice(0,10);}
export function parseEarningsRows(payload,sourceDate) {
  if(!payload?.data)throw new Error('Nasdaq 财报日历无有效数据');
  const rows=payload.data.rows;
  if(rows===null)return [];
  if(!Array.isArray(rows))throw new Error('Nasdaq 财报日历格式已改变');
  const [year,month,day]=sourceDate.split('-').map(Number);
  return rows.filter(row=>row&&typeof row==='object'&&typeof row.symbol==='string'&&/^[A-Z0-9.^-]{1,12}$/.test(row.symbol)).map(row=>{
    const marketCap=Number(String(row.marketCap||'').replace(/[^\d.]/g,''))||null;
    if((!marketCap||marketCap<10_000_000_000)&&!WATCHED.has(row.symbol))return null;
    const session=row.time==='time-pre-market'?'pre':row.time==='time-after-hours'?'post':'unknown';
    // Only the session is supplied. An anchor is used solely to choose the Beijing
    // calendar date; it is never exposed as an actual release timestamp.
    const anchor=zonedISO(year,month,day,session==='post'?17:session==='pre'?8:12,0);
    const date=session==='unknown'?sourceDate:beijingDate(anchor);
    const timeLabel=session==='pre'?'预计美东盘前 · 具体时间待确认':session==='post'?'预计美东盘后 · 北京时间次日早间':'预计美东日期 · 时间待确认';
    const related= /^(NVDA|AMD|AVGO|MU|ADI|INTC|QCOM|TSM)$/.test(row.symbol)?'重点关注需求、毛利率与业绩指引，对半导体同行及 QQQ 可能产生联动影响。':/^(DELL|HPE|SMCI)$/.test(row.symbol)?'重点关注服务器需求、订单积压与利润率，可能影响 AI 基础设施产业链。':'重点关注收入、每股收益相对市场预期的偏差，以及管理层对后续季度的指引。';
    return {id:`earnings-${row.symbol}-${sourceDate}`,title:`${row.symbol} 财报（预计）`,originalTitle:`${row.name||row.symbol} earnings`,date,time:null,timeLabel,category:'earnings',importance:marketCap>=100_000_000_000?'high':'medium',impact:`${row.name||row.symbol} 财报可能引发个股盘前或盘后波动。${related}Nasdaq 日历不等同公司最终确认；具体日期和时间请以公司投资者关系公告为准。`,source:{name:'Nasdaq 财报日历（预计）',url:`${WEB}?date=${sourceDate}`},tickers:[row.symbol],status:'tentative',estimated:true,sourceDate,dateTimezone:session==='unknown'?'America/New_York':'Asia/Shanghai',session,marketCap,fiscalQuarterEnding:row.fiscalQuarterEnding||null};
  }).filter(Boolean);
}
async function fetchDate(date) {
  const cached=cache.get(date);
  if(cached&&Date.now()-cached.fetchedAt<30*60*1000)return cached;
  const response=await fetch(`${API}${date}`,{headers:{'User-Agent':'Mozilla/5.0 (compatible; MarketSignal/1.0; personal daily analysis)','Accept':'application/json, text/plain, */*','Origin':'https://www.nasdaq.com','Referer':'https://www.nasdaq.com/'},signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  const data=await response.json();
  const events=parseEarningsRows(data,date);
  const result={events,asOf:new Date().toISOString(),fetchedAt:Date.now()};cache.set(date,result);return result;
}
export async function getEarningsEvents({now=new Date(),days=7}={}) {
  now=new Date(now);
  if(!Number.isFinite(+now))throw new TypeError('Invalid now');
  const start=beijingDate(now),end=addDays(start,Math.max(1,Math.min(days,14)));
  const sourceStart=dateInZone(now,'America/New_York');
  const dates=[];
  // Include the previous US date when it is still the current session in New York.
  for(let date=sourceStart;date<end;date=addDays(date,1))dates.push(date);
  const results=await Promise.allSettled(dates.map(date=>fetchDate(date)));
  const events=[],errors=[],failures=[];let latest=null;
  results.forEach((result,i)=>{
    if(result.status==='fulfilled'){
      latest=latest&&latest>result.value.asOf?latest:result.value.asOf;
      events.push(...result.value.events);
    }else failures.push(`${dates[i]} ${result.reason.message}`);
  });
  if(failures.length)errors.push(`Nasdaq 财报日历部分日期未取得：${failures.join('；')}`);
  const filtered=events.filter(event=>{
    if(event.date<start||event.date>=end)return false;
    const [year,month,day]=event.sourceDate.split('-').map(Number);
    // A session window may be known without an exact company release time.
    // Once the entire supplied window has elapsed, it is no longer upcoming.
    if(event.session==='pre' && +now>=Date.parse(zonedISO(year,month,day,9,30)))return false;
    if(event.session==='post' && +now>=Date.parse(zonedISO(year,month,day,20,0)))return false;
    return true;
  }).sort((a,b)=>a.date.localeCompare(b.date)||(b.marketCap||0)-(a.marketCap||0));
  return {events:filtered.slice(0,20),sources:[{name:'Nasdaq 财报日历（市值≥100亿美元及重点跟踪股）',url:WEB,status:failures.length===dates.length?'error':'ok',asOf:latest,...(failures.length?{error:errors[0]}:{}),method:'预计日期与盘前/盘后时段；非公司最终确认。最多展示20项，不代表全市场完整日历。'}],errors};
}
