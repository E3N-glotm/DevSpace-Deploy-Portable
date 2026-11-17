'use strict';

// Durable and cross-process-safe accounting for actual model inference HTTP
// requests. Electron (model probes) and the standalone MCP Worker (agent
// inference) each write one independent atomic event file. No shared mutable
// JSON counter and no dependency on the Electron native-module ABI.
//
// Only bounded accounting metadata is saved: never prompts, responses, tool
// arguments, API keys, Authorization headers or URLs.
const fs = require('node:fs');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');

const PROFILE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SOURCES = new Set(['worker','connection-test','function-test']);
const MAX_TOKEN_COUNT = 1_000_000_000;
const MAX_DURATION_MS = 86_400_000;
const MAX_COST_USD = 100_000;
const STORAGE_VERSION = 1;

function checkedNumber(value,maximum,integer=false){
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||n>maximum||(integer&&!Number.isSafeInteger(n))){
    throw new Error('MODEL_USAGE_INVALID_NUMBER');
  }
  return n;
}
function identity(profileId,model){
  if(!PROFILE_ID.test(String(profileId)))throw new Error('MODEL_USAGE_INVALID_PROFILE');
  if(typeof model!=='string'||!model||model.length>200||/[\r\n\0]/.test(model)){
    throw new Error('MODEL_USAGE_INVALID_MODEL');
  }
  return createHash('sha256').update(profileId+'\0'+model).digest('hex');
}
function emptyStats(profileId,model){
  return {
    profileId,model,
    firstCallAt:null,lastCallAt:null,lastCompletedAt:null,lastDurationMs:null,
    lastStatus:null,
    totalCalls:0,successfulCalls:0,failedCalls:0,
    inputTokens:0,outputTokens:0,totalTokens:0,
    totalDurationMs:0,estimatedUSD:0,usageMissingCalls:0,corruptRecords:0,
    bySource:{worker:0,'connection-test':0,'function-test':0},
  };
}

function createModelUsageStore(root,{filesystem=fs,now=()=>new Date(),uuid=randomUUID}={}){
  if(typeof root!=='string'||!path.isAbsolute(root))throw new Error('MODEL_USAGE_ROOT_REQUIRED');
  const base=path.join(root,'data','state','model-usage-v1');
  function modelDir(profileId,model){
    const digest=identity(profileId,model);
    return path.join(base,digest.slice(0,2),digest);
  }
  function record({profileId,model,source,success,startedAt,durationMs,
    inputTokens=0,outputTokens=0,estimatedUSD=0,usageReported=false}){
    const dir=modelDir(profileId,model);
    if(!SOURCES.has(source)||typeof success!=='boolean'||typeof usageReported!=='boolean'){
      throw new Error('MODEL_USAGE_INVALID_EVENT');
    }
    const started=new Date(startedAt);
    if(!Number.isFinite(started.getTime()))throw new Error('MODEL_USAGE_INVALID_TIME');
    const ended=now();
    if(!(ended instanceof Date)||!Number.isFinite(ended.getTime())){
      throw new Error('MODEL_USAGE_INVALID_TIME');
    }
    const event={
      version:STORAGE_VERSION,source,success,
      startedAt:started.toISOString(),completedAt:ended.toISOString(),
      durationMs:checkedNumber(durationMs,MAX_DURATION_MS,true),
      inputTokens:checkedNumber(inputTokens,MAX_TOKEN_COUNT,true),
      outputTokens:checkedNumber(outputTokens,MAX_TOKEN_COUNT,true),
      estimatedUSD:checkedNumber(estimatedUSD,MAX_COST_USD),
      usageReported,
    };
    const month=ended.toISOString().slice(0,7);
    const directory=path.join(dir,month);
    filesystem.mkdirSync(directory,{recursive:true});
    const eventName=ended.toISOString().replace(/[-:.]/g,'')+'-'+uuid()+'.json';
    const output=path.join(directory,eventName);
    const staging=output+'.tmp';
    try{
      filesystem.writeFileSync(staging,JSON.stringify(event),{flag:'wx',mode:0o600});
      filesystem.renameSync(staging,output);
    }finally{try{filesystem.unlinkSync(staging);}catch{}}
    return event;
  }
  function stats(profileId,model){
    const dir=modelDir(profileId,model);
    const result=emptyStats(profileId,model);
    let months;
    try{months=filesystem.readdirSync(dir,{withFileTypes:true});}
    catch(e){if(e?.code==='ENOENT')return result;throw e;}
    let resetAt=0;
    for(const entry of months){
      const match=/^reset-(\d{13})-[0-9a-f-]{36}\.marker$/i.exec(entry.name);
      if(entry.isFile()&&match)resetAt=Math.max(resetAt,Number(match[1]));
    }
    for(const month of months){
      if(!month.isDirectory()||!/^\d{4}-\d{2}$/.test(month.name))continue;
      const monthDir=path.join(dir,month.name);
      const files=filesystem.readdirSync(monthDir,{withFileTypes:true});
      for(const file of files){
        if(!file.isFile()||!/^\d{8}T\d{9}Z-[0-9a-f-]{36}\.json$/i.test(file.name))continue;
        let entry;
        try{
          entry=JSON.parse(filesystem.readFileSync(path.join(monthDir,file.name),'utf8'));
          if(entry.version!==1||!SOURCES.has(entry.source)||
            typeof entry.success!=='boolean'||typeof entry.usageReported!=='boolean'||
            !Number.isFinite(Date.parse(entry.startedAt))||
            !Number.isFinite(Date.parse(entry.completedAt)))throw Error('INVALID');
          checkedNumber(entry.durationMs,MAX_DURATION_MS,true);
          checkedNumber(entry.inputTokens,MAX_TOKEN_COUNT,true);
          checkedNumber(entry.outputTokens,MAX_TOKEN_COUNT,true);
          checkedNumber(entry.estimatedUSD,MAX_COST_USD);
        }catch{result.corruptRecords++;continue;}
        // Requests already in flight when cleared belong to the old period.
        if(resetAt&&Date.parse(entry.startedAt)<=resetAt)continue;
        result.totalCalls++;
        result.successfulCalls+=Number(entry.success);
        result.failedCalls+=Number(!entry.success);
        result.inputTokens+=entry.inputTokens;
        result.outputTokens+=entry.outputTokens;
        result.totalDurationMs+=entry.durationMs;
        result.estimatedUSD+=entry.estimatedUSD;
        result.usageMissingCalls+=Number(!entry.usageReported);
        result.bySource[entry.source]++;
        if(!result.firstCallAt||entry.startedAt<result.firstCallAt)result.firstCallAt=entry.startedAt;
        if(!result.lastCompletedAt||entry.completedAt>result.lastCompletedAt){
          result.lastCallAt=entry.startedAt;
          result.lastCompletedAt=entry.completedAt;
          result.lastDurationMs=entry.durationMs;
          result.lastStatus=entry.success?'success':'failed';
        }
      }
    }
    result.totalTokens=result.inputTokens+result.outputTokens;
    result.estimatedUSD=Number(result.estimatedUSD.toFixed(8));
    return result;
  }
  function clear(profileId,model){
    const dir=modelDir(profileId,model);
    const date=now();
    if(!(date instanceof Date)||!Number.isFinite(date.getTime()))throw Error('MODEL_USAGE_INVALID_TIME');
    filesystem.mkdirSync(dir,{recursive:true});
    const marker=path.join(dir,'reset-'+String(date.getTime()).padStart(13,'0')+'-'+uuid()+'.marker');
    filesystem.writeFileSync(marker,'',{flag:'wx',mode:0o600});
    return stats(profileId,model);
  }
  return {record,stats,clear,base};
}

module.exports={createModelUsageStore,emptyStats};
