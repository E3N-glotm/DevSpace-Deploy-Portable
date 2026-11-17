'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createModelProviderService,normalizeUrl,makeBudget}=require('../electron/model-providers.cjs');
const testRoot=path.resolve(__dirname,'../../reports');
fs.mkdirSync(testRoot,{recursive:true});

function fixture(fetchImpl=async()=>{throw Error('Unmocked network')}) {
  const root=fs.mkdtempSync(path.join(testRoot,'.tmp-model-test-'));
  const cryptoService={
    isEncryptionAvailable:()=>true,
    encryptString:x=>Buffer.from('encrypted:'+Buffer.from(x).toString('base64')),
    decryptString:x=>Buffer.from(String(x).replace(/^encrypted:/,''),'base64').toString('utf8'),
  };
  const credentialVault={
    encryptString:s=>'worker-dpapi:'+Buffer.from(s).toString('base64'),
    decryptString:s=>Buffer.from(s.replace(/^worker-dpapi:/,''),'base64').toString('utf8'),
  };
  const service=createModelProviderService({root,cryptoService,fetchImpl,credentialVault});
  const cleanup=()=>fs.rmSync(root,{recursive:true,force:true});
  return {root,service,cleanup,credentialVault,cryptoService};
}
function input(overrides={}){return {
  id:'local_1',type:'ollama',name:'本地 Ollama',baseUrl:'http://127.0.0.1:11434/v1',
  model:'code-model',role:'worker',api:'chat',
  contextLength:32768,maxOutputTokens:4096,maxTaskUSD:0.5,
  inputPerMillionUSD:2,outputPerMillionUSD:5,...overrides,
};}
function json(data,status=200) {return {
  ok:status>=200&&status<300,status,headers:{get:()=>null},
  text:async()=>JSON.stringify(data),
};}

test('saved models retain creation order across edits, toggles and reload',()=>{
  const f=fixture();
  try{
    const ids=['first','second','third'];
    for(const id of ids)f.service.save(input({id,name:id}));
    f.service.save(input({id:'first',name:'edited first'}));
    f.service.setAllowed('second',false);
    assert.deepEqual(f.service.list().map(p=>p.id),ids);
    const reloaded=createModelProviderService({root:f.root,cryptoService:f.cryptoService,credentialVault:f.credentialVault});
    assert.deepEqual(reloaded.list().map(p=>p.id),ids);
  }finally{f.cleanup();}
});

test('Qwen Flash native reasoning settings are mapped and probe evidence distinguishes acceptance from actual reasoning',async()=>{
  const sent=[];
  const f=fixture(async(_url,opts)=>{
    sent.push(JSON.parse(opts.body));
    return json({choices:[{message:{content:'703',reasoning_content:'verified multiplication'}}],usage:{prompt_tokens:12,completion_tokens:8,completion_tokens_details:{reasoning_tokens:4}}});
  });
  try{
    f.service.save(input({model:'qwen3.8-flash-next-iq3xxs-128k',reasoningEffort:'extra-high',reasoningAdapter:'native'}));
    const result=await f.service.probe('local_1',{reasoning:true});
    assert.equal(sent[0].thinking_budget_tokens,1024);
    assert.equal(sent[0].reasoning_budget_tokens,1024);
    assert.equal(result.reasoning.planned.effective,'2048 tokens');
    assert.equal(result.reasoning.applied.effective,'1024 tokens');
    assert.equal(result.reasoning.accepted,true);
    assert.equal(result.reasoning.reasoningReturned,true);
    assert.equal(result.reasoning.reasoningTokens,4);
  }finally{f.cleanup();}
});

test('unknown reasoning protocol is not reported as an effective setting',async()=>{
  const f=fixture(async(_url,opts)=>{
    const body=JSON.parse(opts.body);
    assert.equal(body.reasoning_effort,undefined);
    return json({choices:[{message:{content:'703'}}]});
  });
  try{
    f.service.save(input({reasoningEffort:'extra-high'}));
    const result=await f.service.probe('local_1',{reasoning:true});
    assert.equal(result.reasoning.accepted,true);
    assert.equal(result.reasoning.planned.effective,'unsupported');
    assert.equal(result.reasoning.reasoningReturned,false);
    assert.equal(result.reasoning.reasoningTokens,null);
  }finally{f.cleanup();}
});

test('credentials are encrypted at rest, omitted from listings, and survive ordinary edits',()=>{
  const {root,service,cleanup}=fixture();
  try{
    const saved=service.save({...input(),apiKey:'TEST-SUPER-SECRET'});
    assert.equal(saved.hasKey,true);
    assert.equal(saved.apiKey,undefined);
    const raw=fs.readFileSync(path.join(root,'data','config','model-providers.json'),'utf8');
    assert.ok(!raw.includes('TEST-SUPER-SECRET'));
    assert.ok(raw.includes('encryptedKey'));
    assert.ok(raw.includes('workerEncryptedKey'));
    assert.ok(!raw.includes('"apiKey":"TEST-SUPER-SECRET"'));
    assert.equal(saved.workerEncryptedKey,undefined);
    assert.equal(saved.workerCredentialReady,true);
    const changed=service.save({...input({name:'改名'})});
    assert.equal(changed.hasKey,true);
    assert.equal(service.list()[0].name,'改名');
    assert.equal(service.save({...input(),clearKey:true}).hasKey,false);
    assert.equal(service.remove('local_1').removed,true);
    assert.deepEqual(service.list(),[]);
  }finally{cleanup();}
});
test('legacy Electron-only credential is transparently rewrapped for the MCP Worker',()=>{
  const {root,service,cleanup,credentialVault,cryptoService}=fixture();
  try{
    service.save({...input(),apiKey:'OLD-LEGACY-KEY'});
    const file=path.join(root,'data','config','model-providers.json');
    const old=JSON.parse(fs.readFileSync(file,'utf8'));
    delete old.models[0].workerEncryptedKey;
    fs.writeFileSync(file,JSON.stringify(old));
    const restored=createModelProviderService({root,cryptoService,credentialVault});
    assert.equal(restored.list()[0].workerCredentialReady,true);
    const config=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(credentialVault.decryptString(config.models[0].workerEncryptedKey),'OLD-LEGACY-KEY');
    assert.equal(restored.list()[0].workerEncryptedKey,undefined);
  }finally{cleanup();}
});
test('DeepSeek tool probe explicitly disables thinking before requiring a tool call',async()=>{
  let requestBody;
  const {service,cleanup}=fixture(async(url,options)=>{
    if(url.endsWith('/chat/completions')){
      requestBody=JSON.parse(options.body);
      return json({choices:[{message:{tool_calls:[{type:'function',
        function:{name:'devspace_probe_echo',arguments:'{"ok":true}'}}]}}]});
    }
    throw Error('Unexpected API endpoint');
  });
  try{
    service.save({...input({type:'deepseek',name:'DeepSeek',model:'deepseek-flash',
      baseUrl:'https://api.deepseek.com/v1'}),apiKey:'PROBE-KEY'});
    const result=await service.probe('local_1',{tools:true});
    assert.equal(result.connected,true);
    assert.equal(result.functionCalling,'supported');
    assert.deepEqual(requestBody.thinking,{type:'disabled'});
    assert.equal(requestBody.tool_choice,'required');
    assert.equal(requestBody.model,'deepseek-flash');
  }finally{cleanup();}
});
test('cannot persist API secrets if OS encryption is unavailable',()=>{
  const root=fs.mkdtempSync(path.join(testRoot,'.tmp-model-test-'));
  try{
    const s=createModelProviderService({root,cryptoService:{
      isEncryptionAvailable:()=>false,encryptString(){throw Error('unsafe');},decryptString(){throw Error('unsafe');},
    }});
    assert.throws(()=>s.save({...input(),apiKey:'private'}),/无法安全加密/);
    assert.equal(s.save(input()).hasKey,false);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('cloud models require HTTPS; private local endpoints permit unauthenticated HTTP',()=>{
  assert.throws(()=>normalizeUrl('http://api.example.com/v1','custom',false),/HTTPS/);
  assert.throws(()=>normalizeUrl('http://169.254.169.254/latest','ollama',false));
  assert.throws(()=>normalizeUrl('http://127.0.0.1:11434/v1?key=abc','ollama',false));
  assert.throws(()=>normalizeUrl('http://192.168.1.20:8000/v1','ollama',true),/API Key/);
  assert.equal(normalizeUrl('http://192.168.1.20:8000/v1','vllm',false),'http://192.168.1.20:8000/v1');
  assert.equal(normalizeUrl('https://api.deepseek.com/','deepseek',true),'https://api.deepseek.com/v1');
});
test('discovers model IDs, authenticates, and verifies an actual harmless tool call',async()=>{
  let observedToken=false;
  let observedTool=false;
  const {service,cleanup}=fixture(async(url,opts)=>{
    observedToken=opts.headers.Authorization==='Bearer TEST-SUPER-SECRET';
    if(url.endsWith('/models'))return json({data:[{id:'code-model'},{id:'other-model'}]});
    if(url.endsWith('/chat/completions')){
      observedTool=opts.body.includes('devspace_probe_echo');
      return json({choices:[{message:{tool_calls:[{type:'function',function:{name:'devspace_probe_echo',arguments:'{"ok":true}'}}]}}],
        usage:{prompt_tokens:20,completion_tokens:10}});
    }
    throw Error('bad endpoint');
  });
  try{
    service.save({...input(),apiKey:'TEST-SUPER-SECRET'});
    const discovered=await service.discover('local_1');
    assert.deepEqual(discovered.models,['code-model','other-model']);
    const probe=await service.probe('local_1',{tools:true});
    assert.equal(probe.functionCalling,'supported');
    assert.equal(probe.connected,true);
    assert.equal(observedToken,true);
    assert.equal(observedTool,true);
    assert.ok(probe.usage.estimatedUSD>0);
  }finally{cleanup();}
});
test('a successful text response without a function call does not count as function calling',async()=>{
  const {service,cleanup}=fixture(async()=>json({choices:[{message:{content:'OK'}}]}));
  try{
    service.save(input());
    const testResult=await service.probe('local_1',{tools:true});
    assert.equal(testResult.connected,true);
    assert.equal(testResult.functionCalling,'unsupported');
  }finally{cleanup();}
});
test('a local model server can discover model IDs before a model is selected',async()=>{
  const {service,cleanup}=fixture(async()=>json({data:[{id:'model-from-server'}]}));
  try{
    service.save(input({model:''}));
    assert.deepEqual((await service.discover('local_1')).models,['model-from-server']);
    await assert.rejects(service.probe('local_1'),/模型标识/);
  }finally{cleanup();}
});
test('HTTP errors, malformed responses and transport diagnostics never reveal remote response bodies',async()=>{
  const {service,cleanup}=fixture(async()=>json({error:{message:'SECRET BODY SHOULD NOT LEAK'}},401));
  try{
    service.save(input());
    assert.deepEqual(await service.discover('local_1'),{
      reachable:false,httpStatus:401,models:[],reason:'HTTP_401'});
    assert.equal((await service.probe('local_1')).httpStatus,401);
  }finally{cleanup();}
});
test('per-task budget accounting disallows spending beyond configured limit',()=>{
  const budget=makeBudget(input({maxTaskUSD:0.01,inputPerMillionUSD:100,
    outputPerMillionUSD:100}));
  assert.ok(budget.spend({prompt_tokens:20,completion_tokens:10}).remainingUSD>0);
  assert.throws(()=>budget.spend({prompt_tokens:100,completion_tokens:10}),/预算已用尽/);
});
test('native Electron bridge exposes dedicated model calls, not a plugin execution entrypoint',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  const preload=fs.readFileSync(path.join(__dirname,'../electron/preload.cjs'),'utf8');
  const app=fs.readFileSync(path.join(__dirname,'../src/App.tsx'),'utf8');
  for(const action of ['modelProvidersList','modelProvidersSave','modelProvidersDelete','modelProvidersDiscover','modelProvidersProbe','modelProvidersStats','modelProvidersClearStats','modelProvidersSetAllowed']){
    assert.ok(main.includes("register('"+action+"'"),action);
    assert.ok(preload.includes(action+':'),action);
  }
  assert.match(main,/cryptoService:safeStorage/);
  assert.match(app,/models:'模型提供商'/);
  assert.match(app,/<ModelProvidersPage\/>/);
});
test('legacy model defaults to callable; disabling persists and cannot run API tests',async()=>{
  const {root,service,cleanup}=fixture(async()=>json({data:[]}));
  try{
    const initial=service.save(input());
    assert.equal(initial.allowCalls,true);
    const disabled=service.setAllowed('local_1',false);
    assert.equal(disabled.allowCalls,false);
    assert.equal(service.list()[0].allowCalls,false);
    await assert.rejects(service.probe('local_1'),/MODEL_CALLS_DISABLED/);
    await assert.rejects(service.discover('local_1'),/MODEL_CALLS_DISABLED/);
    assert.equal(service.save({...input({name:'Renamed'})}).allowCalls,false);
    assert.equal(service.save({...input({allowCalls:true,name:'Stale edit'})}).allowCalls,false,
      'an older model editor snapshot must never silently re-enable a disabled Worker');
    assert.equal(service.setAllowed('local_1',true).allowCalls,true);
    assert.notEqual(service.list()[0].callPolicyRevision,initial.callPolicyRevision);
  }finally{cleanup();}
});
test('disabled model can be edited without automatic API discovery or false red failures',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/ModelProviders.tsx'),'utf8');
  assert.match(source,/if\(savedModel\.allowCalls===false\)/);
  assert.match(source,/if\(stored\.allowCalls!==false\)/);
  assert.match(source,/discoveryGeneration\.current\+\+/);
  assert.match(source,/selectedRef\.current!==id\|\|discoveryGeneration\.current!==generation/);
  assert.match(source,/disabled=\{busy\|\|!selected\|\|saved\?\.allowCalls===false\}/);
});
test('disabled profile retains encrypted key without exposing it',()=>{
  const {root,service,cleanup}=fixture();
  try{
    service.save({...input(),apiKey:'KEEP-ENCRYPTED'});
    service.setAllowed('local_1',false);
    const stored=fs.readFileSync(path.join(root,'data','config','model-providers.json'),'utf8');
    assert.ok(!stored.includes('KEEP-ENCRYPTED'));
    assert.equal(service.list()[0].hasKey,true);
  }finally{cleanup();}
});
test('provider connection probe is reflected in durable selected-model statistics',async()=>{
  const {root,service,cleanup}=fixture(async()=>json({
    choices:[{message:{content:'OK'}}],usage:{prompt_tokens:20,completion_tokens:7},
  }));
  try{
    service.save(input());
    await service.probe('local_1');
    const before=service.stats('local_1');
    assert.equal(before.totalCalls,1);
    assert.equal(before.successfulCalls,1);
    assert.equal(before.inputTokens,20);
    assert.equal(before.outputTokens,7);
    assert.equal(before.bySource['connection-test'],1);
    const restored=createModelProviderService({root,cryptoService:{
      isEncryptionAvailable:()=>true,encryptString:x=>Buffer.from(x),
      decryptString:x=>x.toString(),
    }});
    assert.deepEqual(restored.stats('local_1'),before);
  }finally{cleanup();}
});
