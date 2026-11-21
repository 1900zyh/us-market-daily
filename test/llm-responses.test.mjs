import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createLLMService, normalizeBaseUrl } from '../server/llm.mjs';

// Every credential and provider response in this file is an explicit test fixture.
// Native HTTP requests are restricted to an ephemeral loopback server below.
const secret='TEST_ONLY_RESPONSES_SECRET';
const report={reportDate:'2026-11-21',sessionDate:'2026-11-19',generatedAt:'2026-11-20T16:10:00Z',events:[{id:'pce',title:'PCE 通胀',date:'2026-11-25',category:'macro',importance:'high',source:{url:'https://www.bea.gov/news/schedule/'},tickers:[]}],aiMovers:[{symbol:'NVDA',name:'NVIDIA',price:100,changePercent:-5,sessionDate:'2026-11-19',aiCategory:'chip',source:{url:'https://finance.yahoo.com/quote/NVDA/history/'},reason:{type:'unverified',sources:[]}}]};
const events={summary:'宏观数据可能影响成长股估值，需结合预期差观察。',signals:[{eventId:'pce',analysis:'利率预期可能通过估值折现传导到成长企业。',scenario:'若预期发生变化，市场可能调整风险敞口。',sourceIds:['event:pce']}],warnings:[]};
const movers={movers:[{symbol:'NVDA',analysis:'尚无足以确认因果的公司新闻证据，原因待核实。',catalysts:['需要进一步核对公司公告。'],risks:['宏观因素也可能影响股价。'],sourceIds:['quote:NVDA']}],warnings:[]};
const env={LLM_API_KEY:secret,LLM_MODEL:'fixture-responses-model',LLM_API_TYPE:'responses'};
const responseJson=value=>({status:'completed',output_text:JSON.stringify(value)});
const reply=value=>({ok:true,text:async()=>JSON.stringify(value)});

test('Responses API type persists and is exposed as metadata without revealing credentials',async t=>{
  const directory=await mkdtemp(path.join(tmpdir(),'market-responses-config-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let calls=0;
  const configFile=path.join(directory,'fixture-config.json');
  const service=await createLLMService({configFile,env:{},fetchImpl:async()=>{calls++;throw new Error('unexpected model call');}});
  const status=await service.updateConfig({apiKey:secret,apiType:'responses',baseUrl:'https://fixture.example/v1/responses',model:'fixture-model',enabled:false});
  assert.equal(status.apiType,'responses');
  assert.equal(status.hasApiKey,true);
  assert.equal(Object.hasOwn(status,'apiKey'),false);
  assert.equal(JSON.stringify(status).includes(secret),false);
  assert.equal(normalizeBaseUrl('https://fixture.example/v1/responses/'),'https://fixture.example/v1');
  assert.equal((await service.analyze(report)).status,'disabled');
  assert.equal(service.getState().apiType,'responses');
  assert.equal(calls,0);
  const restored=await createLLMService({configFile,env:{}});
  assert.equal(restored.status().apiType,'responses');
  assert.equal(restored.status().enabled,false);
  assert.equal(JSON.stringify(restored.status()).includes(secret),false);
  await assert.rejects(service.updateConfig({apiType:'unsupported'}),/API 类型/);
});

test('two analysts issue real parallel loopback Responses requests and parse direct and nested output text',async t=>{
  const requests=[];
  const provider=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const payload=JSON.parse(body),input=JSON.parse(payload.input);
    requests.push({req,res,payload,input});
    if(requests.length===2)for(const request of requests){
      const isEvents=request.input.role.startsWith('事件');
      const text=JSON.stringify(isEvents?events:movers),middle=Math.floor(text.length/2);
      const result=isEvents?{status:'completed',output_text:text}:{status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',role:'assistant',content:[{type:'output_text',text:text.slice(0,middle)},{type:'output_text',text:text.slice(middle)}]}]};
      request.res.writeHead(200,{'Content-Type':'application/json'});request.res.end(JSON.stringify(result));
    }
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const service=await createLLMService({env:{...env,LLM_BASE_URL:`http://127.0.0.1:${provider.address().port}/v1/responses`}});
  const result=await service.analyze(report);
  assert.equal(requests.length,2);
  assert.equal(result.status,'ready');
  assert.equal(result.apiType,'responses');
  assert.equal(result.signals[0].eventId,'pce');
  assert.equal(result.movers[0].symbol,'NVDA');
  assert.ok(result.agents.every(agent=>agent.status==='ready'));
  assert.equal(result.evidenceAsOf,report.generatedAt);
  assert.equal(JSON.stringify(result).includes(secret),false);
  for(const request of requests){
    assert.equal(request.req.url,'/v1/responses');
    assert.equal(request.req.method,'POST');
    assert.equal(request.req.headers.authorization,`Bearer ${secret}`);
    assert.equal(request.payload.model,'fixture-responses-model');
    assert.match(request.payload.instructions,/不可信数据/);
    assert.equal(request.payload.text.format.type,'json_object');
    assert.equal(request.payload.max_output_tokens,4000);
    assert.equal(request.payload.stream,false);
    assert.equal(Object.hasOwn(request.payload,'messages'),false);
    assert.equal(Object.hasOwn(request.payload,'response_format'),false);
    assert.equal(Object.hasOwn(request.payload,'max_tokens'),false);
    assert.equal(JSON.stringify(request.payload).includes(secret),false);
    assert.ok(request.input.evidence.sourceCatalog.length>0);
  }
  assert.equal((await service.analyze(report)).cached,true);
  assert.equal(requests.length,2,'unchanged evidence does not issue duplicate calls');
});

test('Responses refusals, incomplete outputs, upstream errors and invalid JSON never publish completed fallback analysis',async()=>{
  for(const payload of [
    {status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'fixture refusal'}]}]},
    {status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output_text:JSON.stringify({...events,...movers})},
    {status:'failed',output_text:JSON.stringify({...events,...movers})},
    {status:'completed',error:{code:'fixture_error'},output_text:JSON.stringify({...events,...movers})},
    {status:'completed',output_text:'not valid JSON'},
    {status:'completed',output:[]},
  ]) {
    const service=await createLLMService({env,fetchImpl:async()=>reply(payload)});
    const result=await service.analyze(report);
    assert.equal(result.status,'error',JSON.stringify(payload));
    assert.deepEqual(result.signals,[]);
    assert.deepEqual(result.movers,[]);
    assert.equal(result.summary,'');
    assert.ok(result.agents.every(agent=>agent.status==='error'));
    assert.equal(JSON.stringify(result).includes(secret),false);
  }
});

test('Responses output is still subjected to evidence validation and credential-echo rejection',async()=>{
  const invalidOutputs=[
    {...events,...movers,signals:[{...events.signals[0],sourceIds:['event:invented']}],movers:[{...movers.movers[0],sourceIds:['quote:INVENTED']}]},
    {...events,...movers,summary:secret,movers:[{...movers.movers[0],analysis:secret}]},
  ];
  for(const output of invalidOutputs){
    const service=await createLLMService({env,fetchImpl:async()=>reply(responseJson(output))});
    const result=await service.analyze(report);
    assert.equal(result.status,'error');
    assert.deepEqual(result.signals,[]);assert.deepEqual(result.movers,[]);
    assert.equal(JSON.stringify(result).includes(secret),false);
  }
});

test('a partial Responses failure preserves only the validated analyst result and marks the other incomplete',async()=>{
  const service=await createLLMService({env,fetchImpl:async(_url,options)=>{
    const input=JSON.parse(JSON.parse(options.body).input);
    return reply(input.role.startsWith('事件')?responseJson(events):{status:'incomplete',output_text:JSON.stringify(movers)});
  }});
  const result=await service.analyze(report);
  assert.equal(result.status,'ready');
  assert.equal(result.signals.length,1);
  assert.deepEqual(result.movers,[]);
  assert.equal(result.agents.find(agent=>agent.role==='events').status,'ready');
  assert.equal(result.agents.find(agent=>agent.role==='movers').status,'error');
  assert.ok(result.warnings.some(warning=>warning.includes('未完整')));
});

test('provider access restrictions retain their diagnostic code without echoing fixture credentials',async()=>{
  const service=await createLLMService({env,fetchImpl:async()=>({ok:false,status:403,text:async()=>JSON.stringify({error:{code:'client_not_allowed',message:`Direct SDK requests are not allowed. Fixture credential ${secret}`}})})});
  const result=await service.analyze(report);
  assert.equal(result.status,'error');
  assert.match(result.error,/403/);
  assert.match(result.error,/client_not_allowed/);
  assert.equal(JSON.stringify(result).includes(secret),false);
  assert.deepEqual(result.signals,[]);
  assert.deepEqual(result.movers,[]);
});

test('credential redaction happens before provider and transport diagnostic truncation',async()=>{
  const boundaryKey='TEST_ONLY_BOUNDARY_CREDENTIAL_'+ 'z'.repeat(190);
  const boundaryEnv={...env,LLM_API_KEY:boundaryKey};
  for(const fetchImpl of [
    async()=>({ok:false,status:403,text:async()=>JSON.stringify({error:{code:'fixture_restricted',message:'x'.repeat(180)+boundaryKey+' tail'}})}),
    async()=>{throw new Error('x'.repeat(240)+boundaryKey+' tail');},
  ]) {
    const service=await createLLMService({env:boundaryEnv,fetchImpl});
    const result=await service.analyze(report);
    assert.equal(result.status,'error');
    const encoded=JSON.stringify(result);
    assert.equal(encoded.includes(boundaryKey),false);
    assert.equal(encoded.includes('TEST_ONLY_BOUNDARY'),false,'truncation must not leave a recognizable credential prefix');
    assert.deepEqual(result.signals,[]);assert.deepEqual(result.movers,[]);
  }
});
