// Official calendars are fetched at runtime. Missing feeds remain explicitly missing.
import {getEarningsEvents} from './earnings.mjs';
const URLS = {
  bea: 'https://www.bea.gov/news/schedule/',
  bls: 'https://www.bls.gov/schedule/news_release/bls.ics',
  census: 'https://www.census.gov/economic-indicators/',
  fed: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
  nyse: 'https://www.nyse.com/markets/hours-calendars',
};
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const cache = new Map();

export function zonedISO(year, month, day, hour = 0, minute = 0, timeZone = 'America/New_York') {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let instant = desired;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant)).map(p => [p.type,p.value]));
    const displayed = Date.UTC(+parts.year,+parts.month-1,+parts.day,+parts.hour,+parts.minute,+parts.second);
    instant += desired - displayed;
  }
  return new Date(instant).toISOString();
}
export function beijingDate(value) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value)).map(v=>[v.type,v.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function clean(value = '') {
  return value.replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&#39;|&apos;/g,"'").replace(/&quot;/g,'"').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/\s+/g,' ').trim();
}
function slug(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,100); }
function clock(value) {
  const m = value.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  return [(+m[1] % 12)+(m[3].toUpperCase()==='PM'?12:0),+m[2]];
}
function interpretation(title) {
  const patterns = [
    [/Personal Income and Outlays/i,'个人收入与支出 / PCE 通胀','high','PCE 与核心 PCE 的意外变化可能影响降息或加息预期，经美债收益率传导至成长股与大盘估值。',['SPY','QQQ']],
    [/\bGDP\b/i,'美国 GDP 与企业利润','high','增长及企业利润修正可能改变盈利预期；超预期增长也可能推升利率预期，方向需结合通胀数据判断。',['SPY','QQQ','IWM']],
    [/Consumer Price Index/i,'美国消费者价格指数 CPI','high','通胀相对市场预期的偏差可能改变政策利率预期，影响美债收益率、科技股估值及大盘风险偏好。',['SPY','QQQ']],
    [/Employment Situation/i,'美国非农就业报告','high','新增就业、失业率及薪资增速可能同时改变增长与通胀预期，对利率敏感板块影响较大。',['SPY','QQQ','IWM']],
    [/Producer Price Index/i,'美国生产者价格指数 PPI','high','生产端价格可能影响通胀预测与企业成本预期；需结合数据分项和市场预期解读。',['SPY','QQQ']],
    [/Advance Monthly Sales for Retail/i,'美国零售销售','high','消费强弱可能影响经济增长及零售企业营收预期，并通过利率预期影响大盘。',['SPY','XLY','XRT']],
    [/Durable Goods/i,'美国耐用品订单','medium','订单及核心资本品分项可反映制造业和企业投资需求，可能影响工业股与经济增长预期。',['SPY','XLI']],
    [/New Residential Construction/i,'美国新屋开工与建筑许可','medium','住宅投资和许可变化反映高利率环境下的需求，可能影响房屋建筑商及地产板块。',['ITB','XHB','IYR']],
    [/New Residential Sales/i,'美国新屋销售','medium','住房需求及价格变化可能影响住宅建筑商、建材和利率敏感板块。',['ITB','XHB']],
    [/Job Openings|Labor Turnover/i,'美国 JOLTS 职位空缺','medium','劳动力需求变化可能影响薪资压力及政策利率预期，重点关注相对市场预期的偏差。',['SPY','QQQ']],
    [/International Trade/i,'美国国际贸易数据','medium','进出口及贸易差额变化可能修正 GDP 跟踪预测，影响出口、航运和工业企业预期。',['SPY','XLI']],
    [/Construction Spending/i,'美国建筑支出','medium','建筑投资变化可能影响经济增长跟踪预测及工业、建材板块。',['XLI','XLB']],
    [/Full Report.*Manufacturers/i,'美国工厂订单','medium','制造业订单及库存可反映需求变化，可能影响工业及资本设备板块。',['XLI']],
    [/Import and Export Price/i,'美国进出口价格指数','medium','进出口价格反映外部价格压力，可能影响通胀与企业利润率预期。',['SPY']],
    [/Productivity and Costs/i,'美国生产率与单位劳动力成本','medium','单位劳动力成本可能影响通胀和利润率判断；生产率变化影响中期增长预期。',['SPY']],
    [/State Employment and Unemployment/i,'美国各州就业与失业率','low','各州就业数据为地区需求与劳动力市场提供补充信号，通常对全国股指的直接影响较小。',['IWM']],
    [/Steel Products/i,'美国钢铁产品进口初值','low','钢铁进口数量和金额可能影响钢铁供需及贸易政策判断，对相关工业企业的影响通常高于大盘。',['XME','SLX']],
    [/Total Factor Productivity/i,'美国行业全要素生产率','low','行业生产率数据提供长期增长和利润率背景，通常不是当日市场的主要驱动因素。',['SPY']],
  ];
  for (const [pattern,label,importance,impact,tickers] of patterns) if(pattern.test(title)) return {title:label,importance,impact,tickers};
  return {title,importance:'low',impact:'该官方经济统计可能影响相关行业及增长预期。单项数据并不直接决定股价方向，需结合预期差与其他信息判断。',tickers:['SPY']};
}
function macroEvent(title,time,sourceName,sourceUrl,extra={}) {
  const details = interpretation(title);
  return {id:`${slug(sourceName)}-${slug(title)}-${time.slice(0,10)}`, ...details,originalTitle:title,date:beijingDate(time),time,timeLabel:new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(time)),category:'macro',source:{name:sourceName,url:sourceUrl},status:'scheduled',...extra};
}
export function parseBea(html,sourceUrl=URLS.bea) {
  const events=[];
  for(const table of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const year=+(clean(table[0]).match(/Year\s+(20\d{2})/i)?.[1]);
    if(!year) continue;
    for(const row of table[0].matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
      const date=clean(row[0].match(/<div\b[^>]*class="[^"]*release-date[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1]);
      const title=clean(row[0].match(/<td\b[^>]*class="[^"]*release-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i)?.[1]);
      const d=date.match(/([A-Za-z]+)\s+(\d{1,2})/), t=clock(clean(row[0].match(/<small\b[^>]*>([\s\S]*?)<\/small>/i)?.[1]));
      if(!d || !t || !title) continue;
      const month=MONTHS.findIndex(m=>m===d[1])+1;
      if(month) events.push(macroEvent(title,zonedISO(year,month,+d[2],...t),'BEA 美国经济分析局',sourceUrl));
    }
  }
  return events;
}
export function parseCensus(html,sourceUrl) {
  const events=[];
  for(const row of html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const cells=[...row[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    if(cells.length<3) continue;
    const title=clean(cells[0][1]);
    const d=clean(cells[1][1]).match(/([A-Za-z]+)\s+(\d{1,2}),\s*(20\d{2})/), t=clock(clean(cells[2][1]));
    if(!d || !t || !title) continue;
    const month=MONTHS.indexOf(d[1])+1;
    if(!month) continue;
    const time=zonedISO(+d[3],month,+d[2],...t);
    const period=cells[3]?clean(cells[3][1]):'';
    events.push(macroEvent(title,time,'美国人口普查局 Census',sourceUrl,{period}));
  }
  return events;
}
export function parseBlsICS(ics) {
  const events=[];
  const unfolded=ics.replace(/\r?\n[ \t]/g,'');
  for(const m of unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)) {
    const fields=m[1].split(/\r?\n/);
    const dt=fields.find(l=>l.startsWith('DTSTART'));
    const summary=fields.find(l=>l.startsWith('SUMMARY:'))?.slice(8).replace(/\\n/g,' ').replace(/\\([,;\\])/g,'$1');
    if(!dt || !summary || /Holiday|Day$/.test(summary)) continue;
    const parts=dt.match(/:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
    if(!parts) continue;
    let zone=dt.match(/TZID=([^:;]+)/)?.[1] || 'America/New_York';
    if(/^(?:US[-/]Eastern|Eastern Standard Time)$/i.test(zone))zone='America/New_York';
    const time=parts[7]?new Date(Date.UTC(+parts[1],+parts[2]-1,+parts[3],+parts[4],+parts[5],+(parts[6]||0))).toISOString():zonedISO(+parts[1],+parts[2],+parts[3],+parts[4],+parts[5],zone);
    events.push(macroEvent(summary,time,'BLS 美国劳工统计局',URLS.bls));
  }
  return events;
}
export function parseFed(html) {
  const events=[];
  const sections=[...html.matchAll(/(20\d{2}) FOMC Meetings([\s\S]*?)(?=<div class="panel-heading">|$)/g)];
  for(const section of sections) {
    const year=+section[1];
    for(const m of section[2].matchAll(/fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)<\/div>/g)) {
      const monthName=m[1].trim(), ds=m[2].trim();
      const month=MONTHS.indexOf(monthName)+1;
      const day=+(ds.match(/(\d+)(?:\*)?$/)?.[1]);
      if(!month||!day) continue; // Unusual cross-month meetings need manual confirmation.
      const date=`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
      events.push({id:`fed-fomc-${date}`,title:'FOMC 议息会议（结束日）',originalTitle:`FOMC ${monthName} ${ds}, ${year}`,date,time:null,timeLabel:'美东日期 · 公布时间待确认',category:'fed',importance:'high',impact:'议息决定、政策措辞与经济预测可能改变利率路径预期，影响美债收益率、美元及美股估值。此条为官方会议结束日期，具体发布时间以当次公告为准。',source:{name:'Federal Reserve 美联储',url:URLS.fed},tickers:['SPY','QQQ','IWM'],status:'scheduled',dateTimezone:'America/New_York'});
    }
  }
  return events;
}
function nthWeekday(year,month,weekday,n) {
  const first=new Date(Date.UTC(year,month-1,1));
  return 1+(weekday-first.getUTCDay()+7)%7+(n-1)*7;
}
function lastWeekday(year,month,weekday) {
  const last=new Date(Date.UTC(year,month,0));
  return last.getUTCDate()-(last.getUTCDay()-weekday+7)%7;
}
function observed(year,month,day,newYear=false) {
  const d=new Date(Date.UTC(year,month-1,day)), weekday=d.getUTCDay();
  if(weekday===0) d.setUTCDate(day+1);
  if(weekday===6&&!newYear) d.setUTCDate(day-1);
  return d.toISOString().slice(0,10);
}
function easter(year) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),day=(h+l-7*m+114)%31+1;
  const date=new Date(Date.UTC(year,month-1,day));date.setUTCDate(date.getUTCDate()-2);return date.toISOString().slice(0,10);
}
export function regularNyseHolidays(year) {
  const date=(m,d)=>`${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return [
    [observed(year,1,1,true),'元旦'],[date(1,nthWeekday(year,1,1,3)),'马丁·路德·金纪念日'],[date(2,nthWeekday(year,2,1,3)),'华盛顿诞辰纪念日'],[easter(year),'耶稣受难日'],[date(5,lastWeekday(year,5,1)),'阵亡将士纪念日'],...(year>=2022?[[observed(year,6,19),'六月节']]:[]),[observed(year,7,4),'美国独立日'],[date(9,nthWeekday(year,9,1,1)),'劳动节'],[date(11,nthWeekday(year,11,4,4)),'感恩节'],[observed(year,12,25),'圣诞节'],
  ].filter(([d])=>{const weekday=new Date(`${d}T12:00:00Z`).getUTCDay();return weekday!==0&&weekday!==6;});
}
export function exchangeEvents(year) {
  const date=(m,d)=>`${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const source={name:'NYSE 纽约证券交易所',url:URLS.nyse};
  const events=regularNyseHolidays(year).map(([d,title])=>({id:`nyse-closed-${d}`,title:`美股休市 · ${title}`,date:d,time:null,timeLabel:'全天休市（美东交易日）',category:'market',importance:'medium',impact:'美股常规交易暂停，前后交易日可能因流动性变化出现更大买卖价差。休市期间的消息可能在复市时集中反映；临时休市以交易所公告为准。',source,tickers:['SPY','QQQ','IWM'],status:'scheduled',dateTimezone:'America/New_York'}));
  const early=[[11,nthWeekday(year,11,4,4)+1,'感恩节次日']];
  if(new Date(Date.UTC(year,11,24)).getUTCDay()>=1&&new Date(Date.UTC(year,11,24)).getUTCDay()<=4) early.push([12,24,'圣诞节前夕']);
  if(new Date(Date.UTC(year,6,3)).getUTCDay()>=1&&new Date(Date.UTC(year,6,3)).getUTCDay()<=4) early.push([7,3,'独立日前夕']);
  for(const [month,day,title] of early) {
    const d=date(month,day);
    if(regularNyseHolidays(year).some(([h])=>h===d)) continue;
    const time=zonedISO(year,month,day,13,0);
    events.push({id:`nyse-early-${d}`,title:`美股提前收盘 · ${title}`,date:beijingDate(time),time,timeLabel:new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(time)),category:'market',importance:'medium',impact:'NYSE 股票市场于美东 13:00 提前收盘。交易时段缩短可能降低流动性并放大短时波动；部分期权的收市时间不同。',source,tickers:['SPY','QQQ','IWM'],status:'scheduled'});
  }
  return events;
}
async function fetchCalendar(url) {
  const cached=cache.get(url);
  if(cached&&Date.now()-cached.fetchedAt<30*60*1000) return cached;
  const response=await fetch(url,{headers:{'User-Agent':'MarketSignal/1.0 (personal economic calendar; daily fetch)','Accept':'text/html,text/calendar;q=0.9,*/*;q=0.5'},signal:AbortSignal.timeout(10000)});
  if(!response.ok) throw new Error(`HTTP ${response.status}`);
  const result={text:await response.text(),asOf:new Date().toISOString(),fetchedAt:Date.now()};
  cache.set(url,result);return result;
}
export async function getUpcomingEvents({now=new Date(),days=7}={}) {
  now=new Date(now);
  if(!Number.isFinite(+now)) throw new TypeError('Invalid now');
  const start=beijingDate(now),startMs=Date.parse(`${start}T00:00:00+08:00`),endMs=startMs+Math.max(1,Math.min(31,days))*86400000;
  const years=[+start.slice(0,4)];
  const endYear=+(beijingDate(endMs-1).slice(0,4));if(endYear!==years[0])years.push(endYear);
  const jobs=[
    {name:'BEA 美国经济分析局',url:URLS.bea,parse:parseBea},
    {name:'BLS 美国劳工统计局',url:URLS.bls,parse:parseBlsICS},
    {name:'Federal Reserve 美联储',url:URLS.fed,parse:parseFed},
    ...years.map(year=>({name:`Census 美国人口普查局 ${year}`,url:`${URLS.census}calendar-listview-${year}.html`,parse:parseCensus})),
    ...(endYear!==years[0]?[{name:`BEA 下一年度`,url:`${URLS.bea}next-year`,parse:parseBea}]:[]),
  ];
  const sources=[],errors=[],events=[];
  const pending=jobs.map(async job=>{const loaded=await fetchCalendar(job.url);const parsed=job.parse(loaded.text,job.url);if(!parsed.length)throw new Error('官方日历格式已改变或未列出可解析的发布日期');return {parsed,asOf:loaded.asOf};});
  pending.push(getEarningsEvents({now,days}));
  const settled=await Promise.allSettled(pending);
  const results=settled.slice(0,jobs.length);
  results.forEach((result,i)=>{
    const job=jobs[i];
    if(result.status==='fulfilled'){events.push(...result.value.parsed);sources.push({name:job.name,url:job.url,status:'ok',asOf:result.value.asOf});}
    else {const error=`${job.name}：${result.reason.message}`;errors.push(error);sources.push({name:job.name,url:job.url,status:'error',asOf:null,error});}
  });
  const earnings=settled[jobs.length];
  if(earnings.status==='fulfilled') {events.push(...earnings.value.events);sources.push(...earnings.value.sources);errors.push(...earnings.value.errors);}
  else {const error=`Nasdaq 财报日历：${earnings.reason.message}`;errors.push(error);sources.push({name:'Nasdaq 财报日历',url:'https://www.nasdaq.com/market-activity/earnings',status:'error',asOf:null,error});}
  for(const year of years)events.push(...exchangeEvents(year));
  sources.push({name:'NYSE 常规交易日历规则',url:URLS.nyse,status:'ok',asOf:null,method:'依据 NYSE 常规休市与提前收盘规则计算；不含临时休市'});
  const filtered=events.filter(event=>{
    if(event.time) return Date.parse(event.time)>=+now&&Date.parse(event.time)<endMs;
    return event.date>=start&&event.date<beijingDate(endMs);
  });
  const unique=[...new Map(filtered.map(event=>[`${event.time||event.date}-${slug(event.originalTitle||event.title)}`,event])).values()];
  unique.sort((a,b)=>(a.time||`${a.date}T00:00:00+08:00`).localeCompare(b.time||`${b.date}T00:00:00+08:00`));
  return {events:unique,sources,errors};
}
