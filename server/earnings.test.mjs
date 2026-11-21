import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEarningsRows } from './earnings.mjs';

const payload = rows => ({ data: { rows } });
const row = (symbol = 'NVDA', extra = {}) => ({ symbol, name: `${symbol} Test Company`, marketCap: '$120,000,000,000', time: 'time-after-hours', ...extra });
let moduleId = 0;
async function freshEarnings() { return import(`./earnings.mjs?acceptance=${++moduleId}`); }
async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('earnings sessions map to the correct Beijing date without inventing release timestamps', () => {
  for (const sourceDate of ['2026-11-24', '2026-07-15']) {
    const [post, pre, unknown] = parseEarningsRows(payload([
      row('NVDA'), row('AMD', {time:'time-pre-market'}), row('AAPL', {time:'time-not-supplied'}),
    ]), sourceDate);
    const nextDay = new Date(`${sourceDate}T12:00:00Z`); nextDay.setUTCDate(nextDay.getUTCDate()+1);
    assert.equal(post.date,nextDay.toISOString().slice(0,10));
    assert.equal(pre.date,sourceDate);
    assert.equal(unknown.date,sourceDate);
    assert.equal(post.dateTimezone,'Asia/Shanghai');
    assert.equal(unknown.dateTimezone,'America/New_York');
    for (const event of [post, pre, unknown]) {
      assert.equal(event.time,null,'Nasdaq supplies a session, not an exact release timestamp');
      assert.equal(event.status,'tentative');
      assert.equal(event.estimated,true);
      assert.equal(event.sourceDate,sourceDate);
      assert.match(event.impact,/公司投资者关系公告/);
      assert.ok(event.source.url.endsWith(`?date=${sourceDate}`));
    }
    assert.match(post.timeLabel,/次日早间/);
    assert.match(pre.timeLabel,/盘前/);
    assert.match(unknown.timeLabel,/时间待确认/);
  }
});

test('earnings coverage filters small companies while retaining watched symbols and threshold boundary', () => {
  const events = parseEarningsRows(payload([
    row('LARGE',{marketCap:'$10,000,000,000'}),
    row('SMALL',{marketCap:'$9,999,999,999'}),
    row('NOCAP',{marketCap:'N/A'}),
    row('NVDA',{marketCap:'N/A'}),
    row('HUGE',{marketCap:'$100,000,000,000'}),
    row('AMD',{marketCap:'$5,000,000,000'}),
  ]),'2026-11-24');
  assert.deepEqual(events.map(e=>e.tickers[0]),['LARGE','NVDA','HUGE','AMD']);
  assert.equal(events.find(e=>e.tickers[0]==='HUGE').importance,'high');
  assert.equal(events.find(e=>e.tickers[0]==='LARGE').importance,'medium');
  assert.equal(events.find(e=>e.tickers[0]==='NVDA').marketCap,null);
});

test('invalid earnings payloads and invalid symbols never become market signals', () => {
  assert.throws(()=>parseEarningsRows({},'2026-11-24'),/无有效数据/);
  assert.throws(()=>parseEarningsRows(payload({}),'2026-11-24'),/格式已改变/);
  assert.deepEqual(parseEarningsRows(payload(null),'2026-11-24'),[]);
  const events=parseEarningsRows(payload([
    null,undefined,42,'invalid',{},row(''),row('lowercase'),row('NASDAQ:NVDA'),row('<script>'),row('VALID'),
  ]),'2026-11-24');
  assert.deepEqual(events.map(e=>e.tickers[0]),['VALID']);
});

test('rolling earnings window includes the still-current US postmarket on the next Beijing date and caps sorted results at 20', async () => {
  const {getEarningsEvents}=await freshEarnings();
  const requested=[];
  const now=new Date('2026-11-21T00:00:00+08:00'); // Nov 20 11:00 New York.
  const report=await withFetch(async url=>{
    const date=new URL(url).searchParams.get('date');requested.push(date);
    let rows=[];
    if(date==='2026-11-20')rows=[row('NVDA'),row('AAPL',{time:'time-not-supplied'})];
    if(date==='2026-11-22')rows=Array.from({length:25},(_,i)=>row(`Z${String(i).padStart(2,'0')}`,{marketCap:`${100_000_000_000+i*1_000_000_000}`}));
    if(date==='2026-11-27')rows=[row('END',{time:'time-pre-market'}),row('TOOLATE')];
    return {ok:true,json:async()=>payload(rows)};
  },()=>getEarningsEvents({now,days:7}));
  assert.equal(requested[0],'2026-11-20');
  assert.equal(report.events.length,20);
  assert.equal(report.events[0].id,'earnings-NVDA-2026-11-20');
  assert.equal(report.events[0].date,'2026-11-21');
  assert.equal(report.events[1].tickers[0],'Z24');
  assert.ok(report.events.every(e=>e.date>='2026-11-21'&&e.date<'2026-11-28'));
  assert.equal(report.events.some(e=>e.tickers[0]==='AAPL'),false,'unknown Nov20 US date lies outside Nov21 Beijing window');
  assert.equal(report.events.some(e=>e.tickers[0]==='TOOLATE'),false,'Nov27 US postmarket maps outside the seven-date Beijing window');
  assert.equal(report.sources[0].status,'ok');
  assert.deepEqual(report.errors,[]);
  assert.match(report.sources[0].method,/20项/);
});

test('known earnings sessions stop being upcoming once their entire New York window has elapsed', async () => {
  for(const [now,sourceDate,expected] of [
    ['2026-11-24T14:29:59Z','2026-11-24',['PRE','POST']],
    ['2026-11-24T14:30:00Z','2026-11-24',['POST']],
    ['2026-11-25T00:59:59Z','2026-11-24',['POST']],
    ['2026-11-25T01:00:00Z','2026-11-24',[]],
    ['2027-07-15T13:29:59Z','2027-07-15',['PRE','POST']],
    ['2027-07-15T13:30:00Z','2027-07-15',['POST']],
    ['2027-07-16T00:00:00Z','2027-07-15',[]],
  ]) {
    const {getEarningsEvents}=await freshEarnings();
    const report=await withFetch(async url=>({ok:true,json:async()=>payload(new URL(url).searchParams.get('date')===sourceDate?[
      row('PRE',{time:'time-pre-market'}),row('POST'),
    ]:[])}),()=>getEarningsEvents({now:new Date(now),days:2}));
    assert.deepEqual(report.events.map(e=>e.tickers[0]),expected,now);
    assert.ok(report.events.every(e=>e.time===null),'cutoffs must not be presented as company release timestamps');
  }
});

test('earnings calendar source failures stay explicit and never create fallback companies', async () => {
  const {getEarningsEvents}=await freshEarnings();
  const report=await withFetch(async()=>{throw new Error('fixture offline');},()=>getEarningsEvents({now:new Date('2027-03-10T12:00:00Z'),days:2}));
  assert.deepEqual(report.events,[]);
  assert.equal(report.sources[0].status,'error');
  assert.equal(report.sources[0].asOf,null);
  assert.match(report.errors.join(' '),/fixture offline/);
  const partial=await freshEarnings();
  const mixed=await withFetch(async url=>{
    if(new URL(url).searchParams.get('date')==='2027-04-13')return {ok:false,status:503};
    return {ok:true,json:async()=>payload([row('NVDA',{time:'time-pre-market'})])};
  },()=>partial.getEarningsEvents({now:new Date('2027-04-12T12:00:00Z'),days:2}));
  assert.ok(mixed.events.length>0);
  assert.match(mixed.errors.join(' '),/503/);
  assert.ok(mixed.sources[0].error,'partial failure remains visible alongside returned companies');
});

test('invalid clock values reject before starting any earnings network request', async () => {
  const {getEarningsEvents}=await freshEarnings();
  let requests=0;
  await withFetch(async()=>{requests++;throw new Error('unexpected network');},async()=>{
    await assert.rejects(getEarningsEvents({now:'invalid date'}),/Invalid now/);
  });
  assert.equal(requests,0);
});
