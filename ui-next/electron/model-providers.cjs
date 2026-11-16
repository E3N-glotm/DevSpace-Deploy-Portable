'use strict';

// Native model configuration service. Credentials never cross the renderer
// boundary after saving and are never persisted outside OS-encrypted bytes.
const fs = require('node:fs');
const path = require('node:path');
const {isIP} = require('node:net');
const {randomUUID} = require('node:crypto');
const {createModelUsageStore,emptyStats} = require('../../setup/model-usage.cjs');
const {createModelDpapiVault} = require('../../setup/model-dpapi-vault.cjs');

const TYPES = new Set(['deepseek','custom','ollama','vllm']);
const ROLES = new Set(['worker','reviewer','planner']);
const APIS = new Set(['chat','responses']);
const ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const KEY_FIELD = 'encryptedKey';
const MAX_REPLY = 512 * 1024;
const REQUEST_TIMEOUT = 12_000;

function normalizeUrl(value,type,hasKey) {
  if(typeof value !== 'string' || value.length > 500)throw Error('API 地址不合法');
  let url;
  try { url = new URL(value.trim()); } catch { throw Error('API 地址格式不正确'); }
  if(url.username || url.password || url.search || url.hash || !['http:','https:'].includes(url.protocol))
    throw Error('API 地址不能包含账号、密码、查询参数或片段');
  if(!url.hostname || !url.port && url.hostname.length>240)throw Error('API 主机地址不合法');
  if(url.protocol==='http:'){
    if(!['ollama','vllm'].includes(type))throw Error('云端 API 必须使用 HTTPS');
    const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
    const ip=isIP(host);
    const pieces=ip===4?host.split('.').map(Number):[];
    const local=host==='localhost' || host==='::1' || host==='127.0.0.1'
      || (ip===4 && (
        pieces[0]===10 || pieces[0]===127
        || (pieces[0]===172 && pieces[1]>=16 && pieces[1]<=31)
        || (pieces[0]===192 && pieces[1]===168)
        || (pieces[0]===100 && pieces[1]>=64 && pieces[1]<=127)
      ));
    if(!local)throw Error('非 HTTPS 本地 API 只能连接本机或明确的私有网络 IP');
    if(hasKey && host!=='localhost' && host!=='127.0.0.1' && host!=='::1')
      throw Error('带 API Key 的远程服务必须使用 HTTPS');
  }
  const pathname=url.pathname.replace(/\/+$/,'');
  if(pathname && pathname!=='/v1' && pathname!=='/api/v1')
    throw Error('API Base URL 只允许主机根路径或 /v1、/api/v1');
  return url.origin + (pathname && pathname!=='/'?pathname:'/v1');
}

function validate(input,{hasKey=false}={}){
  if(!input || typeof input!=='object'||Array.isArray(input))throw Error('无效模型配置');
  const id=String(input.id||'');
  const type=String(input.type||'');
  const role=String(input.role||'worker');
  const api=String(input.api||'chat');
  const name=String(input.name||'').trim();
  const model=String(input.model||'').trim();
  if(!ID.test(id)||!TYPES.has(type)||!ROLES.has(role)||!APIS.has(api))throw Error('模型 ID、类型或职责不合法');
  if(!name || name.length>100||/[\r\n\0]/.test(name))throw Error('模型显示名称不合法');
  // A model name may be unknown until /models has been queried. Allow a
  // discovery-only profile; actual inference still requires a selected model.
  if(model.length>200||/[\r\n\0]/.test(model))throw Error('模型标识不合法');
  const n=(key,min,max,defaultValue)=> {
    const v=input[key]===undefined?defaultValue:Number(input[key]);
    if(!Number.isFinite(v)||v<min||v>max)throw Error(key+' 超出允许范围');
    return v;
  };
  const contextLength=n('contextLength',1024,2_000_000,32768);
  if(!Number.isInteger(contextLength))throw Error('上下文长度必须是整数');
  const maxOutputTokens=n('maxOutputTokens',16,131072,4096);
  if(!Number.isInteger(maxOutputTokens)||maxOutputTokens>=contextLength)
    throw Error('最大输出 Token 必须小于上下文长度');
  const maxTaskUSD=n('maxTaskUSD',0.01,1000,1);
  const inputPerMillionUSD=n('inputPerMillionUSD',0,10000,0);
  const outputPerMillionUSD=n('outputPerMillionUSD',0,10000,0);
  if(input.allowCalls!==undefined&&typeof input.allowCalls!=='boolean')
    throw Error('允许调用必须是布尔值');
  const reasoningEffort=String(input.reasoningEffort||'auto');
  const reasoningAdapter=String(input.reasoningAdapter||'native');
  if(!['auto','off','low','medium','high','extra-high'].includes(reasoningEffort)
    ||!['native','openai'].includes(reasoningAdapter))throw Error('推理配置不合法');
  return {id,type,name,baseUrl:normalizeUrl(input.baseUrl,type,hasKey),model,api,role,
    contextLength,maxOutputTokens,maxTaskUSD,inputPerMillionUSD,outputPerMillionUSD,
    allowCalls:input.allowCalls!==false,reasoningEffort,reasoningAdapter,vision:input.vision===true};
}

function estimateCost(usage,model) {
  const prompt=Math.max(0,Number(usage?.prompt_tokens||usage?.input_tokens||0));
  const completion=Math.max(0,Number(usage?.completion_tokens||usage?.output_tokens||0));
  return (prompt*model.inputPerMillionUSD+completion*model.outputPerMillionUSD)/1_000_000;
}
function makeBudget(model){
  let spent=0;
  return {
    spend(usage){
      const amount=estimateCost(usage,model);
      if(!Number.isFinite(amount)||spent+amount>model.maxTaskUSD)
        throw Error('模型调用预算已用尽');
      spent+=amount;
      return {spentUSD:spent,remainingUSD:Math.max(0,model.maxTaskUSD-spent)};
    },
    get remainingUSD(){return Math.max(0,model.maxTaskUSD-spent);},
  };
}
function apiPath(base,suffix){return base.replace(/\/$/,'')+'/'+suffix;}
function createModelProviderService({root,cryptoService,fetchImpl=globalThis.fetch,
  filesystem=fs,usageStore=createModelUsageStore(root),
  credentialVault=createModelDpapiVault()}){
  if(!cryptoService||typeof cryptoService.encryptString!=='function'||typeof cryptoService.decryptString!=='function')
    throw Error('缺少系统加密服务');
  const filename=path.join(root,'data','config','model-providers.json');
  const available=()=>Boolean(cryptoService.isEncryptionAvailable());
  function load(){
    try {
      const parsed=JSON.parse(filesystem.readFileSync(filename,'utf8'));
      if(parsed.version!==1||!Array.isArray(parsed.models))throw Error('模型配置版本不兼容');
      return parsed.models;
    }catch(error){
      if(error.code==='ENOENT')return [];
      throw error;
    }
  }
  function persist(models){
    filesystem.mkdirSync(path.dirname(filename),{recursive:true});
    const pending=filename+'.'+process.pid+'.'+randomUUID()+'.tmp';
    try{
      filesystem.writeFileSync(pending,JSON.stringify({version:1,models},null,2),{mode:0o600,flag:'wx'});
      filesystem.renameSync(pending,filename);
    }finally{try{filesystem.unlinkSync(pending);}catch{}}
  }
  function visible(entry){
    const {[KEY_FIELD]:hidden,workerEncryptedKey:workerHidden,...safe}=entry;
    return {...safe,allowCalls:entry.allowCalls!==false,
      hasKey:Boolean(hidden),keyEncrypted:Boolean(hidden),
      workerCredentialReady:Boolean(workerHidden)};
  }
  function migrateWorkerCredentials(){
    // Older profiles were encrypted only for Electron safeStorage. Rewrap
    // once, inside Electron's trusted main process, into user-scoped DPAPI so
    // the separate Node MCP Worker can authenticate without receiving the
    // plaintext key from a renderer, CLI argument or tool response.
    if(!available())return false;
    const entries=load();let changed=false;
    const updated=entries.map(entry=>{
      if(!entry.encryptedKey||entry.workerEncryptedKey)return entry;
      const secret=cryptoService.decryptString(Buffer.from(entry.encryptedKey,'base64'));
      const workerEncryptedKey=credentialVault.encryptString(secret);
      changed=true;
      return {...entry,workerEncryptedKey};
    });
    if(changed)persist(updated);
    return changed;
  }
  // The UI may be closed while the MCP server keeps running; migrate saved
  // encrypted model keys when Electron next starts, without user re-entry.
  try{migrateWorkerCredentials();}
  catch{console.warn('MODEL_WORKER_CREDENTIAL_MIGRATION_UNAVAILABLE');}
  function list(){return load().map(visible);}
  function save(payload){
    const input=payload&&typeof payload==='object'?payload:{};
    if(typeof input.apiKey==='string'&&input.apiKey.length>4096)throw Error('API Key 长度过大');
    const models=load();
    const old=models.find(m=>m.id===input.id);
    const clearKey=input.clearKey===true;
    const newKey=typeof input.apiKey==='string'&&input.apiKey.trim()?input.apiKey.trim():null;
    if(newKey && !available())throw Error('当前系统无法安全加密 API Key，未保存');
    const encryptedKey=clearKey?'':newKey?
      cryptoService.encryptString(newKey).toString('base64'):old?.encryptedKey||'';
    const workerEncryptedKey=clearKey?'':newKey?
      credentialVault.encryptString(newKey):old?.workerEncryptedKey||
        (encryptedKey?credentialVault.encryptString(
          cryptoService.decryptString(Buffer.from(encryptedKey,'base64'))):'');
    // Editing a profile cannot silently override an explicit disable from a
    // different UI snapshot. Only modelProvidersSetAllowed changes this flag.
    const model=validate({...input,allowCalls:old
      ?old.allowCalls!==false:input.allowCalls!==false},{hasKey:Boolean(encryptedKey)});
    // Every profile edit invalidates any short-lived mandatory-workflow
    // approval previously issued for this model in an MCP session.
    const stored={...model,callPolicyRevision:randomUUID(),
      ...(encryptedKey?{encryptedKey,workerEncryptedKey}:{})};
    persist([...models.filter(m=>m.id!==model.id),stored]);
    return visible(stored);
  }
  function remove(id){
    if(!ID.test(String(id)))throw Error('无效模型 ID');
    const entries=load();persist(entries.filter(m=>m.id!==id));
    return {removed:entries.length!==load().length};
  }
  function get(id){
    if(!ID.test(String(id)))throw Error('无效模型 ID');
    const model=load().find(m=>m.id===id);
    if(!model)throw Error('模型尚未保存');
    return model;
  }
  function setAllowed(id,enabled){
    if(!ID.test(String(id))||typeof enabled!=='boolean')
      throw Error('无效模型调用开关参数');
    const models=load(),index=models.findIndex(m=>m.id===id);
    if(index===-1)throw Error('模型尚未保存');
    const next=[...models];
    next[index]={...models[index],allowCalls:enabled,callPolicyRevision:randomUUID()};
    persist(next);
    return visible(next[index]);
  }
  function assertAllowed(model){
    if(model.allowCalls===false)throw Error('MODEL_CALLS_DISABLED');
  }
  function stats(id){
    const model=get(id);
    return model.model?usageStore.stats(id,model.model):emptyStats(id,'');
  }
  function auth(model){
    if(!model.encryptedKey)return {};
    if(!available())throw Error('无法解密当前 Windows 用户保存的 API Key');
    const token=cryptoService.decryptString(Buffer.from(model.encryptedKey,'base64'));
    return {Authorization:'Bearer '+token};
  }
  async function request(model,endpoint,{method='GET',body}={}){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),REQUEST_TIMEOUT);
    try{
      const response=await fetchImpl(apiPath(model.baseUrl,endpoint),{
        method,headers:{Accept:'application/json',...auth(model),
          ...(body?{'Content-Type':'application/json'}:{})},
        ...(body?{body:JSON.stringify(body)}:{}),
        redirect:'error',signal:controller.signal,
      });
      if(!response.ok) return {ok:false,status:response.status};
      const len=Number(response.headers?.get?.('content-length')||0);
      if(len>MAX_REPLY)throw Error('模型返回内容过大');
      let raw;
      if(response.body?.getReader){
        const reader=response.body.getReader();
        const chunks=[];
        let total=0;
        try{
          while(true){
            const {value,done}=await reader.read();
            if(done)break;
            total+=value.byteLength;
            if(total>MAX_REPLY)throw Error('模型返回内容过大');
            chunks.push(Buffer.from(value));
          }
          raw=Buffer.concat(chunks).toString('utf8');
        }finally{await reader.cancel().catch(()=>{});}
      }else{
        raw=await response.text();
        if(Buffer.byteLength(raw,'utf8')>MAX_REPLY)throw Error('模型返回内容过大');
      }
      try{return {ok:true,status:response.status,data:JSON.parse(raw)};}
      catch{throw Error('服务端未返回有效 JSON');}
    }catch(e){
      // Never forward transport internals, URL, tokens or server error bodies.
      if(e.message==='模型返回内容过大'||e.message==='服务端未返回有效 JSON')throw e;
      throw Error(controller.signal.aborted?'模型请求超时':'模型服务连接失败，请检查 API 地址与网络');
    }finally{clearTimeout(timer);}
  }
  async function discover(id){
    const model=get(id);
    assertAllowed(model);
    const result=await request(model,'models');
    if(!result.ok)return {reachable:false,httpStatus:result.status,models:[],reason:'HTTP_'+result.status};
    const models=Array.isArray(result.data?.data)?result.data.data:
      Array.isArray(result.data?.models)?result.data.models:[];
    return {reachable:true,httpStatus:result.status,
      models:models.slice(0,300).map(x=>typeof x==='string'?x:String(x.id||x.name||''))
        .filter(x=>x&&x.length<=200)};
  }
  async function probe(id,{tools=false}={}){
    const model=get(id);
    assertAllowed(model);
    if(!model.model)throw Error('请先从模型列表选择或输入模型标识');
    const startedAt=new Date().toISOString();
    const startedNs=process.hrtime.bigint();
    let succeeded=false;
    let actualUsage=null;
    // An intentionally harmless local echo function; it does not run commands.
    const tool={type:'function',function:{name:'devspace_probe_echo',
      description:'Test whether structured tool calls are supported; no side effects',
      parameters:{type:'object',properties:{ok:{type:'boolean'}},required:['ok']}}};
    const isResponses=model.api==='responses';
    const body=isResponses?{
      model:model.model,input:'Call devspace_probe_echo with ok=true.',
      max_output_tokens:80,
      ...(tools&&model.type==='deepseek'?{reasoning:{effort:'none'}}:{}),
      ...(tools?{tools:[{type:'function',name:tool.function.name,
        description:tool.function.description,parameters:tool.function.parameters}]}:{}),
    }:{
      model:model.model,messages:[{role:'user',
        content:tools?'Call devspace_probe_echo with ok=true.':'Reply with the word OK.'}],
      max_tokens:80,
      ...(tools&&model.type==='deepseek'?{thinking:{type:'disabled'}}:{}),
      ...(tools?{tools:[tool],tool_choice:'required'}:{}),
    };
    try{
      const result=await request(model,isResponses?'responses':'chat/completions',
        {method:'POST',body});
      if(!result.ok)return {connected:false,httpStatus:result.status,
        functionCalling:tools?'unsupported':'not-tested'};
      const output=result.data;
      const calls=isResponses?
        (Array.isArray(output.output)?output.output:[]).filter(o=>o.type==='function_call'):
        (output.choices||[]).flatMap(c=>c.message?.tool_calls||[]);
      const supported=calls.some(c=>String(c.name||c.function?.name)==='devspace_probe_echo');
      actualUsage=output.usage||null;
      succeeded=true;
      return {connected:true,httpStatus:result.status,
        functionCalling:tools?(supported?'supported':'unsupported'):'not-tested',
        returnedToolCall:tools?supported:false,
        usage:output.usage?{
          inputTokens:Number(output.usage.prompt_tokens||output.usage.input_tokens||0),
          outputTokens:Number(output.usage.completion_tokens||output.usage.output_tokens||0),
          estimatedUSD:estimateCost(output.usage,model),
        }:null};
    }finally{
      try{
        usageStore.record({
          profileId:id,model:model.model,
          source:tools?'function-test':'connection-test',
          success:succeeded,startedAt,
          durationMs:Math.round(Number(process.hrtime.bigint()-startedNs)/1e6),
          inputTokens:Number(actualUsage?.prompt_tokens||actualUsage?.input_tokens||0),
          outputTokens:Number(actualUsage?.completion_tokens||actualUsage?.output_tokens||0),
          estimatedUSD:actualUsage?estimateCost(actualUsage,model):0,
          usageReported:Boolean(actualUsage),
        });
      }catch{
        // Never let an accounting storage failure conceal the API result or
        // expose remote request details. The statistics endpoint remains readable.
        console.warn('MODEL_USAGE_WRITE_FAILED');
      }
    }
  }
  return {list,save,remove,setAllowed,discover,probe,stats,makeBudget,filename};
}
module.exports={createModelProviderService,validate,normalizeUrl,makeBudget,estimateCost};
