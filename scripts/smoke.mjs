// Browser acceptance uses explicit test fixtures; no fixtures are shipped by the application.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : 'playwright');
const output = path.join(root, 'test-results');
await fs.mkdir(output, { recursive: true });
const now = new Date();
const reportDate = new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit' }).format(now);
const [year, month, day] = reportDate.split('-').map(Number);
const dayAt = n => new Date(Date.UTC(year,month-1,day+n,12)).toISOString().slice(0,10);
const source = {name:'TEST FIXTURE · Yahoo Finance',url:'https://finance.yahoo.com/'};
const bars = Array.from({length:20},(_,i)=>({time:new Date(Date.UTC(year,month-1,day-21+i,20)).toISOString(),close:100+i+(i%3)}));
const fixture = {
  generatedAt:now.toISOString(),reportDate,sessionDate:dayAt(-1),nextUpdateAt:`${dayAt(1)}T12:00:00.000Z`,status:'live',refreshing:false,
  indices:[['^GSPC','标普 500',1.2],['^IXIC','纳斯达克综合',-0.8],['^DJI','道琼斯工业',0.5],['^VIX','VIX 恐慌指数',-3.2]].map(([symbol,name,pct])=>({symbol,name,price:123.45,change:pct,changePercent:pct,asOf:now.toISOString(),history:bars,source})),
  movers:[['NVDA','NVIDIA',5.4],['TSLA','Tesla',-4.2],['AMD','Advanced Micro Devices',3.1]].map(([symbol,name,pct])=>({symbol,name,price:123.45,change:pct,changePercent:pct,volume:12345678,volumeRatio:1.2,marketCap:1e12,sessionDate:dayAt(-1),asOf:now.toISOString(),direction:pct>=0?'up':'down',sector:'测试行业',history:bars,source,reason:{summary:'TEST FIXTURE：存在相关业绩新闻线索，因果关系未经独立证实。',type:'news-context',label:'新闻线索',sources:[{title:`${name} TEST earnings release`,url:'https://www.sec.gov/',publishedAt:now.toISOString()}]}})),
  events:[{id:'test-macro',title:'TEST 宏观发布',category:'macro',importance:'high',date:dayAt(1),time:`${dayAt(1)}T13:30:00.000Z`,timeLabel:'21:30',impact:'TEST：通胀预期可能影响估值。',tickers:['SPY','QQQ'],source:{name:'TEST BLS',url:'https://www.bls.gov/'}},{id:'test-fed',title:'TEST 美联储会议',category:'fed',importance:'high',date:dayAt(2),time:`${dayAt(2)}T18:00:00.000Z`,timeLabel:'02:00',impact:'TEST：政策预期可能影响利率。',tickers:['SPY'],source:{name:'TEST Fed',url:'https://www.federalreserve.gov/'}},{id:'test-market',title:'TEST 休市安排',category:'market',importance:'medium',date:dayAt(3),time:null,timeLabel:'全天休市（美东交易日）',dateTimezone:'America/New_York',impact:'TEST：流动性变化。',tickers:['SPY'],source:{name:'TEST NYSE',url:'https://www.nyse.com/'}}],
  sources:[{...source,status:'ok',asOf:now.toISOString()}],summary:{title:'TEST 市场日报',description:'TEST：仅供浏览器验收的明确测试数据。'},coverage:{movers:'TEST：3 个测试标的，非真实行情。',events:'TEST：官方日历解析测试。'},schedule:{time:'20:00',timeZone:'Asia/Shanghai',nextRunAt:`${dayAt(1)}T12:00:00.000Z`},warnings:[],
};
for(const mover of fixture.movers) {mover.ai=['NVDA','AMD'].includes(mover.symbol);mover.aiCategory=mover.ai?'chip':null;}
fixture.aiMovers=fixture.movers.filter(mover=>mover.aiCategory);
fixture.aiMovers.push({...fixture.movers[0],symbol:'MSFT',name:'Microsoft',ai:true,aiCategory:'cloud',changePercent:3.5,change:3.5});
fixture.aiCoverage={scannedSymbols:3,eligibleSymbols:3,qualifiedSymbols:3,absoluteChangeThreshold:3,minVolume:100000,movers:'TEST：独立扫描 AI 股票池，按规则筛选，非收益预测。'};
fixture.llm={status:'unconfigured',generatedAt:null,summary:'',signals:[],movers:[],sourceCatalog:[],warnings:[]};
let llmStatus={configured:false,enabled:false,hasApiKey:false,model:'fixture-model',baseUrl:'https://fixture.example/v1',status:'unconfigured'};
let analysisCount=0;
let configCount=0;
let savedTestKey='';
let refreshCount=0;
let failRefresh=false;
const reportIndex={reports:[{date:reportDate,generatedAt:now.toISOString(),sessionDate:dayAt(-1),status:'live',moverCount:3,eventCount:3},{date:dayAt(-1),generatedAt:now.toISOString(),sessionDate:dayAt(-2),status:'partial',moverCount:3,eventCount:3}]};
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    res.setHeader('Content-Type','application/json; charset=utf-8');
    if(url.pathname==='/api/llm/status')return res.end(JSON.stringify(llmStatus));
    if(url.pathname==='/api/llm/config'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const config=JSON.parse(Buffer.concat(chunks).toString());configCount++;
      if(config.apiKey)savedTestKey=config.apiKey;
      llmStatus={configured:Boolean(savedTestKey),enabled:config.enabled,hasApiKey:Boolean(savedTestKey),model:config.model,baseUrl:config.baseUrl,status:savedTestKey?'ready':'unconfigured'};
      fixture.llm={...fixture.llm,status:config.enabled?'idle':'disabled'};
      return res.end(JSON.stringify(llmStatus));
    }
    if(url.pathname==='/api/llm/analyze'){
      analysisCount++;
      if(!llmStatus.configured||!llmStatus.enabled){res.writeHead(400);return res.end(JSON.stringify({error:'TEST：请先配置模型',llm:fixture.llm}));}
      fixture.llm={status:'ready',model:llmStatus.model,generatedAt:now.toISOString(),summary:'TEST FIXTURE：来自测试响应的模型解读，不是实际外部推理。',signals:[{eventId:'test-macro',analysis:'TEST：通胀预期可通过利率影响估值。',scenario:'TEST：仍需观察实际数据与市场预期差。',sourceIds:['event:test-macro']}],movers:[{symbol:'NVDA',analysis:'TEST：新闻相关性尚不能证实因果。',catalysts:['TEST：经营指引值得跟踪。'],risks:['TEST：缺少完整原文，需要核实。'],sourceIds:['quote:NVDA','news:NVDA:0']}],warnings:['TEST FIXTURE：浏览器验收输出。'],agents:[{role:'events',name:'事件研究员',status:'ready'},{role:'movers',name:'个股研究员',status:'ready'}],sourceCatalog:[{id:'event:test-macro',title:'TEST BLS 事件证据',url:'https://www.bls.gov/'},{id:'quote:NVDA',title:'TEST NVDA 收盘行情',url:'https://finance.yahoo.com/quote/NVDA/'},{id:'news:NVDA:0',title:'TEST NVDA 公司资讯',url:'https://www.sec.gov/'}]};
      res.writeHead(202);return res.end(JSON.stringify({llm:fixture.llm,message:'TEST：模型响应就绪'}));
    }
    if(url.pathname==='/api/refresh'){refreshCount++;if(failRefresh){res.writeHead(503);return res.end(JSON.stringify({error:'TEST: 网络不可用'}));}return res.end(JSON.stringify(fixture));}
    if(url.pathname==='/api/reports')return res.end(JSON.stringify(reportIndex));
    if(url.pathname.startsWith('/api/reports/'))return res.end(JSON.stringify({...fixture,reportDate:decodeURIComponent(url.pathname.split('/').pop()),sessionDate:dayAt(-2)}));
    return res.end(JSON.stringify(fixture));
  }
  const filename=path.resolve(root,'public',url.pathname==='/'?'index.html':`.${url.pathname}`);
  if(!filename.startsWith(path.join(root,'public')+path.sep)){res.writeHead(403);return res.end();}
  try {const body=await fs.readFile(filename);res.setHeader('Content-Type',mime[path.extname(filename)]||'application/octet-stream');res.end(body);}catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
const errors=[];
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
async function noOverflow(label){const size=await page.evaluate(()=>({viewport:innerWidth,content:document.documentElement.scrollWidth}));assert.ok(size.content<=size.viewport,`${label} overflow: ${JSON.stringify(size)}`);}
try {
  await page.goto(base);
  await page.waitForFunction(()=>document.querySelector('#indices-grid')?.textContent.includes('123.45'));
  await page.waitForFunction(()=>document.querySelector('#movers-body')?.textContent.includes('NVDA'));
  assert.equal(await page.locator('#indices-grid .index-card').count(),4);
  assert.equal(await page.locator('#focus-selector [data-focus="ai"]').evaluate(e=>e.classList.contains('selected')),true,'AI focus is the default');
  assert.ok((await page.locator('#movers-body').innerText()).includes('AMD'));
  assert.ok((await page.locator('#movers-body').innerText()).includes('MSFT'),'AI-only result survives absence from capped all-market movers');
  assert.equal((await page.locator('#movers-body').innerText()).includes('TSLA'),false,'non-AI fixture excluded by default focus');
  await page.locator('[data-ai-category="chip"]').click();
  assert.ok((await page.locator('#movers-body').innerText()).includes('NVDA'));
  assert.ok((await page.locator('#movers-body').innerText()).includes('AMD'));
  assert.equal((await page.locator('#movers-body').innerText()).includes('MSFT'),false);
  await page.locator('[data-ai-category="cloud"]').click();
  assert.ok((await page.locator('#movers-body').innerText()).includes('MSFT'));
  assert.equal((await page.locator('#movers-body').innerText()).includes('NVDA'),false,'AI category filters the independent AI result set');
  await page.locator('[data-ai-category="all"]').click();
  await page.locator('#method-button').click();
  await page.locator('#detail-dialog').waitFor({state:'visible'});
  const methodology=await page.locator('#dialog-content').innerText();
  assert.match(methodology,/规则/,'methodology describes the actual screening approach');
  assert.match(methodology,/没有|未使用|不是|非预测|不预测/,'methodology bounds the algorithm rather than claiming trained AI');
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>document.querySelector('#llm-status')?.textContent.includes('未配置'));
  assert.equal(await page.locator('#llm-content .llm-summary').count(),0,'unconfigured model must not show generated analysis');
  await page.locator('#llm-analyze').click();
  await page.locator('#llm-config-form').waitFor({state:'visible'});
  assert.equal(analysisCount,0,'missing model credentials open settings without issuing inference');
  assert.equal(await page.locator('#llm-key').getAttribute('type'),'password');
  assert.equal(await page.locator('#llm-key').inputValue(),'');
  await page.locator('#llm-provider').selectOption('custom');
  await page.locator('#llm-base-url').fill('https://fixture.example/v1');
  await page.locator('#llm-model').fill('fixture-model');
  const testSecret='TEST_ONLY_BROWSER_SECRET_123';
  await page.locator('#llm-key').fill(testSecret);
  await page.locator('#llm-enabled').check();
  await page.locator('#llm-config-form [type="submit"]').click();
  await page.waitForFunction(()=>!document.querySelector('#detail-dialog').open);
  assert.equal(configCount,1);
  assert.equal(await page.locator('#llm-key').inputValue(),'','secret input is cleared after saving');
  const publicStatus=await page.evaluate(()=>fetch('/api/llm/status').then(r=>r.json()));
  assert.equal(publicStatus.hasApiKey,true);
  assert.equal(JSON.stringify(publicStatus).includes(testSecret),false,'configuration status never returns the secret');
  assert.equal(await page.evaluate(secret=>JSON.stringify({...localStorage}).includes(secret),testSecret),false,'API key must not be stored in browser localStorage');
  assert.equal(await page.locator('#llm-content .llm-summary').count(),0,'saving credentials alone must not invent generated results');
  await page.locator('#llm-configure').click();
  await page.locator('#llm-config-form').waitFor({state:'visible'});
  assert.equal(await page.locator('#llm-key').inputValue(),'','reopening settings does not refill saved credentials');
  await page.keyboard.press('Escape');
  await page.locator('#llm-analyze').click();
  await page.waitForFunction(()=>document.querySelector('#llm-status')?.textContent.includes('已生成'));
  assert.equal(analysisCount,1);
  assert.ok((await page.locator('#llm-content').innerText()).includes('TEST FIXTURE'));
  assert.equal(await page.locator('#llm-content a[href="https://www.bls.gov/"]').count(),1);
  assert.equal(await page.locator('#llm-content a[href="https://www.sec.gov/"]').count(),1);
  assert.equal((await page.locator('body').innerText()).includes(testSecret),false);
  await noOverflow('desktop');
  await page.screenshot({path:path.join(output,'fixture-desktop.png'),fullPage:true});
  await page.locator('#focus-selector [data-focus="all"]').click();
  assert.ok((await page.locator('#movers-body').innerText()).includes('TSLA'));
  await page.locator('#mover-filter [data-direction="up"]').click();
  assert.equal(await page.locator('#movers-body').innerText().then(t=>t.includes('TSLA')),false);
  await page.locator('#mover-filter [data-direction="all"]').click();
  await page.locator('#stock-search').fill('TSLA');
  assert.ok((await page.locator('#movers-body').innerText()).includes('TSLA'));
  assert.equal((await page.locator('#movers-body').innerText()).includes('NVDA'),false);
  await page.locator('#stock-search').fill('no-such-symbol');
  assert.equal((await page.locator('#movers-body').innerText()).includes('TSLA'),false);
  await page.locator('#stock-search').fill('');
  await page.locator('#event-category').selectOption('macro');
  assert.equal((await page.locator('#events-list').innerText()).includes('TEST 美联储会议'),false);
  await page.locator('#event-category').selectOption('all');
  await page.locator(`#day-tabs [data-date="${dayAt(1)}"]`).click();
  assert.ok((await page.locator('#events-list').innerText()).includes('TEST 宏观发布'));
  assert.equal((await page.locator('#events-list').innerText()).includes('TEST 美联储会议'),false);
  await page.locator('#day-tabs [data-date="all"]').click();
  await page.locator('[data-mover="NVDA"]').first().click();
  await page.locator('#detail-dialog').waitFor({state:'visible'});
  assert.ok((await page.locator('#dialog-content').innerText()).includes('NVIDIA'));
  assert.ok((await page.locator('#dialog-content').innerText()).includes('TEST earnings release'));
  await page.keyboard.press('Escape');
  await page.locator('[data-watch="NVDA"]').click();
  assert.equal(await page.locator('[data-watch="NVDA"]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-view="watchlist"]').click();
  assert.ok((await page.locator('#movers-body').innerText()).includes('NVDA'));
  assert.equal((await page.locator('#movers-body').innerText()).includes('TSLA'),false);
  await page.locator('[data-view="overview"]').click();
  await page.locator('[data-chart="^IXIC"]').click();
  assert.ok((await page.locator('#chart-index-label').innerText()).includes('纳'));
  await page.locator('#refresh-button').click();
  await page.waitForFunction(()=>!document.querySelector('#refresh-button').disabled);
  assert.equal(refreshCount,1);
  await page.locator('#source-button').click();
  await page.locator('#detail-dialog').waitFor({state:'visible'});
  assert.ok((await page.locator('#dialog-content').innerText()).includes('Yahoo'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#detail-dialog').evaluate(d=>d.open),false);
  await page.locator('#archive-button').click();
  await page.locator('#reports-section').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.querySelector('#reports-list')?.textContent.includes('3'));
  await page.locator(`[data-report="${dayAt(-1)}"]`).click();
  await page.waitForFunction(date=>document.querySelector('#report-date')?.textContent.replaceAll('/','-').includes(date)||document.querySelector('#notice')?.textContent.includes('历史'),dayAt(-1));
  assert.ok((await page.locator('#notice').innerText()).includes('历史'));
  await page.locator('#refresh-button').click();
  await page.waitForFunction(()=>!document.querySelector('#refresh-button').disabled);
  await page.locator('[data-view="overview"]').click();
  await page.locator('#overview-section').waitFor({state:'visible'});
  failRefresh=true;
  await page.locator('#refresh-button').click();
  await page.waitForFunction(()=>!document.querySelector('#refresh-button').disabled);
  assert.ok((await page.locator('#indices-grid').innerText()).includes('123.45'),'failed refresh retains last snapshot');
  for(const width of [768,390,320]){
    await page.setViewportSize({width,height:900});
    await page.waitForTimeout(260); // Let responsive drawer transition settle before visual capture.
    await noOverflow(`${width}px`);
    if(width===390)await page.screenshot({path:path.join(output,'fixture-mobile.png'),fullPage:true});
  }
  await page.locator('#menu-toggle').click();
  await page.locator('#sidebar [data-view="signals"]').click();
  await page.locator('#signals-section').waitFor({state:'visible'});
  await noOverflow('mobile signals');
  assert.deepEqual(errors,[],'no browser runtime errors');
  console.log('Browser smoke passed: AI focus/category, methodology, missing-key/settings/privacy, grounded LLM result/source rendering, desktop/mobile layouts, market render, filters/search/date, watchlist, chart switching, news/source dialogs, archive load, refresh success/failure, navigation. Explicit test fixtures only; no external model calls.');
  console.log(`Screenshots: ${output}`);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
