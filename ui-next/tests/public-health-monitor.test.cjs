'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createPublicHealthMonitor}=require('../electron/public-health.cjs');

const HOST='https://mcp.example.test';
const good=async u=>({status:new URL(u).pathname==='/mcp'?401:200});

function timeoutProbe(){
  return (_url,{signal})=>new Promise((_resolve,reject)=>{
    const abort=()=>reject(Object.assign(new Error('timeout'),{name:'AbortError'}));
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  });
}

test('200 OAuth metadata and 401 unauthenticated MCP mark service healthy',async()=>{
  let ms=1_000;
  const monitor=createPublicHealthMonitor({request:good,now:()=>ms});
  const state=await monitor.check(HOST,'cloudflare',true);
  assert.equal(state.state,'healthy');
  assert.equal(state.healthy,true);
  assert.equal(state.metadataStatus,200);
  assert.equal(state.mcpStatus,401);
  ms+=1_000;
  assert.equal((await monitor.check(HOST,'cloudflare',false)).state,'healthy');
});

test('a transient timeout must not mark a recently verified service offline',async()=>{
  let ms=1_000;
  let calls=0;
  const monitor=createPublicHealthMonitor({timeoutMs:15,now:()=>ms,
    request:async(...args)=>{calls++;if(calls<=2)return good(...args);return timeoutProbe()(...args);}});
  assert.equal((await monitor.check(HOST,'cloudflare',true)).state,'healthy');
  ms+=5_000;
  const stale=await monitor.check(HOST,'cloudflare',true);
  assert.equal(stale.state,'healthy');
  assert.equal(stale.healthy,true);
  assert.match(stale.error,/超时/);
  assert.equal(stale.lastSuccessAt,1_000);
  ms+=121_000;
  const uncertain=await monitor.check(HOST,'cloudflare',false);
  assert.equal(uncertain.state,'stale');
  assert.equal(uncertain.healthy,false);
  assert.equal(uncertain.lastSuccessAt,1_000);
});

test('a minimized window with an expired success is stale, not a new failure; background refresh restores green',async()=>{
  let ms=10_000;
  let calls=0;
  const monitor=createPublicHealthMonitor({request:async url=>{calls++;return good(url);},now:()=>ms});
  assert.equal((await monitor.check(HOST,'cloudflare',true)).state,'healthy');
  ms+=119_000;
  assert.equal((await monitor.check(HOST,'cloudflare',false)).state,'healthy');
  ms+=2_000;
  const expired=await monitor.check(HOST,'cloudflare',false);
  assert.equal(expired.state,'stale');
  assert.equal(expired.consecutiveFailures,0,'ageing evidence is not a failed probe');
  assert.equal(calls,2);
  assert.equal((await monitor.check(HOST,'cloudflare',true)).state,'healthy');
  assert.equal(calls,4);
});

test('three confirmed HTTP failures override even recent successful evidence',async()=>{
  let bad=false;
  let ms=1000;
  const monitor=createPublicHealthMonitor({request:async u=>bad?{status:503}:good(u),now:()=>ms});
  assert.equal((await monitor.check(HOST,'cloudflare',true)).state,'healthy');
  bad=true;
  for(let i=0;i<2;i++) {
    ms+=1000;
    assert.equal((await monitor.check(HOST,'cloudflare',true)).state,'healthy');
  }
  ms+=1000;
  assert.equal((await monitor.check(HOST,'cloudflare',true)).state,'unhealthy');
  assert.equal(monitor.snapshot().healthy,false);
});

test('transport timeouts do not count as confirmed HTTP outages',async()=>{
  let mode='good';
  const monitor=createPublicHealthMonitor({request:(url,options)=>{
    if(mode==='timeout')return timeoutProbe()(url,options);
    return mode==='bad'?Promise.resolve({status:503}):good(url);
  },timeoutMs:8});
  await monitor.check(HOST,'cloudflare',true);
  mode='timeout';
  await monitor.check(HOST,'cloudflare',true);
  await monitor.check(HOST,'cloudflare',true);
  mode='bad';
  assert.equal((await monitor.check(HOST,'cloudflare',true)).state,'healthy');
  assert.equal(monitor.snapshot().confirmedFailures,1);
  assert.equal((await monitor.check(HOST,'cloudflare',true)).state,'healthy');
  assert.equal((await monitor.check(HOST,'cloudflare',true)).state,'unhealthy');
  mode='good';
  const recovered=await monitor.check(HOST,'cloudflare',true);
  assert.equal(recovered.state,'healthy');
  assert.equal(recovered.confirmedFailures,0);
});

test('a stale request may not overwrite state after provider URL changes A-B-A',async()=>{
  let finishOld;
  let requests=0;
  const monitor=createPublicHealthMonitor({request:u=>{
    requests++;
    if(requests<=2)return new Promise(resolve=>{(finishOld??=[]).push(()=>resolve(good(u)));});
    return Promise.resolve({status:503});
  }});
  const original=monitor.check(HOST,'cloudflare',true);
  assert.equal((await monitor.check('https://new.example.test','cloudflare',false)).state,'checking');
  assert.equal((await monitor.check(HOST,'cloudflare',false)).state,'checking');
  const latest=await monitor.check(HOST,'cloudflare',true);
  assert.equal(latest.state,'uncertain');
  finishOld.forEach(fn=>fn());
  const discarded=await original;
  assert.equal(discarded.state,'uncertain');
  assert.equal(monitor.snapshot().lastSuccessAt,0);
});

test('pure transport timeouts are uncertain, not proof of service outage',async()=>{
  const monitor=createPublicHealthMonitor({request:timeoutProbe(),timeoutMs:10});
  for(let i=0;i<4;i++){
    const x=await monitor.check(HOST,'cloudflare',true);
    assert.equal(x.state,'uncertain');
    assert.equal(x.healthy,false);
    assert.equal(x.consecutiveFailures,i+1);
  }
});

test('three confirmed HTTP contract failures become unhealthy',async()=>{
  const monitor=createPublicHealthMonitor({request:async()=>({status:503})});
  assert.equal((await monitor.check(HOST,'cloudflare',true)).state,'uncertain');
  assert.equal((await monitor.check(HOST,'cloudflare',true)).state,'uncertain');
  const result=await monitor.check(HOST,'cloudflare',true);
  assert.equal(result.state,'unhealthy');
  assert.equal(result.healthy,false);
});

test('simultaneous refresh requests are coalesced and URL switches reset evidence',async()=>{
  let count=0;
  const monitor=createPublicHealthMonitor({request:async u=>{count++;await new Promise(r=>setTimeout(r,10));return good(u);}});
  const [a,b]=await Promise.all([monitor.check(HOST,'cloudflare',true),monitor.check(HOST,'cloudflare',true)]);
  assert.equal(a.state,'healthy');
  assert.equal(b.state,'healthy');
  assert.equal(count,2);
  const changed=await monitor.check('https://different.example.test','cloudflare',false);
  assert.equal(changed.state,'checking');
  assert.equal(changed.lastSuccessAt,0);
  assert.equal((await monitor.check('','local',false)).state,'idle');
});
