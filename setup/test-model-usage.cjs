'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createModelUsageStore}=require('./model-usage.cjs');

// All test artifacts remain inside the original E-drive project checkout.
const reports=path.resolve(__dirname,'../reports');
fs.mkdirSync(reports,{recursive:true});
function fixture(){
  const root=fs.mkdtempSync(path.join(reports,'.tmp-model-usage-'));
  let completed=0;
  const store=createModelUsageStore(root,{
    now:()=>new Date(Date.UTC(2026,10,4,6,0,0)+completed++*1000),
  });
  return {root,store,
    cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
function record(store,changes={}){
  return store.record({
    profileId:'model_local',model:'qwen-27b-128k',
    source:'worker',success:true,
    startedAt:'2026-11-04T04:30:00.000Z',
    durationMs:1843,inputTokens:900,outputTokens:200,
    estimatedUSD:0.0011,usageReported:true,
    ...changes,
  });
}

test('model counters, last call time, duration, tokens and estimated cost survive restart',()=>{
  const f=fixture();
  try{
    record(f.store);
    record(f.store,{source:'function-test',success:false,
      startedAt:'2026-11-04T04:31:00.000Z',durationMs:2750,
      inputTokens:0,outputTokens:0,estimatedUSD:0,usageReported:false});
    const restored=createModelUsageStore(f.root).stats('model_local','qwen-27b-128k');
    assert.equal(restored.totalCalls,2);
    assert.equal(restored.successfulCalls,1);
    assert.equal(restored.failedCalls,1);
    assert.equal(restored.inputTokens,900);
    assert.equal(restored.outputTokens,200);
    assert.equal(restored.totalTokens,1100);
    assert.equal(restored.totalDurationMs,4593);
    assert.equal(restored.estimatedUSD,0.0011);
    assert.equal(restored.bySource.worker,1);
    assert.equal(restored.bySource['function-test'],1);
    assert.equal(restored.usageMissingCalls,1);
    assert.equal(restored.lastStatus,'failed');
    assert.ok(restored.lastDurationMs!==null);
    assert.ok(restored.firstCallAt);
    assert.ok(restored.lastCallAt);
  }finally{f.cleanup();}
});

test('a different underlying model or provider profile never inherits another model count',()=>{
  const f=fixture();
  try{
    record(f.store);
    record(f.store,{model:'qwen-27b-256k'});
    assert.equal(f.store.stats('model_local','qwen-27b-128k').totalCalls,1);
    assert.equal(f.store.stats('model_local','qwen-27b-256k').totalCalls,1);
    assert.equal(f.store.stats('model_other','qwen-27b-128k').totalCalls,0);
  }finally{f.cleanup();}
});

test('event files cannot contain prompt, response, URL, request headers or credentials',()=>{
  const f=fixture();
  try{
    record(f.store);
    const files=[];
    const descend=dir=>{
      for(const p of fs.readdirSync(dir,{withFileTypes:true})){
        if(p.isDirectory())descend(path.join(dir,p.name));
        else if(p.name.endsWith('.json'))files.push(path.join(dir,p.name));
      }
    };
    descend(f.store.base);
    assert.equal(files.length,1);
    const data=fs.readFileSync(files[0],'utf8');
    for(const word of ['Authorization','apiKey','secret','prompt','response','baseUrl',
      'https://','qwen-27b-128k','model_local']){
      assert.ok(!data.includes(word),word);
    }
    assert.ok(JSON.parse(data).startedAt);
  }finally{f.cleanup();}
});

test('invalid counters and model identities are rejected, not persisted',()=>{
  const f=fixture();
  try{
    assert.throws(()=>record(f.store,{inputTokens:-1}),/MODEL_USAGE_INVALID_NUMBER/);
    assert.throws(()=>record(f.store,{outputTokens:NaN}),/MODEL_USAGE_INVALID_NUMBER/);
    assert.throws(()=>record(f.store,{durationMs:1e14}),/MODEL_USAGE_INVALID_NUMBER/);
    assert.throws(()=>record(f.store,{model:'unsafe\nname'}),/MODEL_USAGE_INVALID_MODEL/);
    assert.throws(()=>record(f.store,{profileId:'../unsafe'}),/MODEL_USAGE_INVALID_PROFILE/);
    assert.equal(f.store.stats('model_local','qwen-27b-128k').totalCalls,0);
  }finally{f.cleanup();}
});

test('two physically separate processes can record concurrent calls without overwriting',async()=>{
  const f=fixture();
  try{
    const program=[
      'const {createModelUsageStore}=require(process.argv[1]);',
      'const s=createModelUsageStore(process.argv[2]);',
      'for(let i=0;i<25;i++)s.record({profileId:"model_local",model:"qwen-27b-128k",',
      'source:"worker",success:true,startedAt:new Date().toISOString(),',
      'durationMs:10,inputTokens:3,outputTokens:2,usageReported:true,estimatedUSD:0});',
    ].join('');
    const filename=path.join(__dirname,'model-usage.cjs');
    const children=Array.from({length:4},()=>new Promise((resolve,reject)=>{
      const proc=spawn(process.execPath,['-e',program,filename,f.root],{
        cwd:reports,stdio:['ignore','pipe','pipe'],windowsHide:true,
      });
      let errorOutput='';
      proc.stderr.on('data',chunk=>{errorOutput+=String(chunk).slice(0,250);});
      proc.once('error',reject);
      proc.once('exit',code=>code===0?resolve():reject(Error('CHILD_EXIT_'+code+' '+errorOutput)));
    }));
    await Promise.all(children);
    const stats=createModelUsageStore(f.root).stats('model_local','qwen-27b-128k');
    assert.equal(stats.totalCalls,100);
    assert.equal(stats.inputTokens,300);
    assert.equal(stats.outputTokens,200);
    assert.equal(stats.totalDurationMs,1000);
  }finally{f.cleanup();}
});
