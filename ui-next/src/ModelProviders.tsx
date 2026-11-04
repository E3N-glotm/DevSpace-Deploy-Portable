import {useCallback,useEffect,useState} from 'react';
import {Button,Field,Input,Radio,RadioGroup,Spinner} from '@fluentui/react-components';
import {ArrowClockwiseRegular,DeleteRegular,SaveRegular,ShieldCheckmarkRegular} from '@fluentui/react-icons';
import type {ModelProvider,ModelProviderDraft,ModelDiscovery,ModelProbe,ModelUsageStats} from './api';

type ProviderType=ModelProviderDraft['type'];
type Role=ModelProviderDraft['role'];
const defaults:Record<ProviderType,{url:string;name:string;model:string}>={
  deepseek:{url:'https://api.deepseek.com/v1',name:'DeepSeek',model:'deepseek-chat'},
  custom:{url:'https://example.com/v1',name:'自定义 API',model:''},
  ollama:{url:'http://127.0.0.1:11434/v1',name:'Ollama 本地模型',model:''},
  vllm:{url:'http://127.0.0.1:8000/v1',name:'vLLM / llama.cpp',model:''},
};
function draft(type:ProviderType='deepseek'):ModelProviderDraft {
  const preset=defaults[type];
  return {
    id:'model-'+type,name:preset.name,type,baseUrl:preset.url,model:preset.model,
    api:'chat',role:'worker',contextLength:32768,maxOutputTokens:4096,
    maxTaskUSD:1,inputPerMillionUSD:0,outputPerMillionUSD:0,
  };
}
function message(e:unknown):string {
  const str=e instanceof Error?e.message:String(e);
  return str.length>220?str.slice(0,220):str;
}
const count=(value:number)=>value.toLocaleString('zh-CN');
function duration(value:number|null):string{
  if(value===null)return '暂无';
  if(value<1000)return value+' ms';
  if(value<60_000)return (value/1000).toFixed(2)+' 秒';
  if(value<3_600_000)return (value/60_000).toFixed(2)+' 分钟';
  return (value/3_600_000).toFixed(2)+' 小时';
}
function localTime(value:string|null):string{
  return value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'暂无';
}
const names:Record<ProviderType,string>={
  deepseek:'DeepSeek 官方 API',
  custom:'自定义 OpenAI 兼容 API',
  ollama:'本地 Ollama',
  vllm:'本地 vLLM / llama.cpp',
};

export function ModelProvidersPage(){
  const [items,setItems]=useState<ModelProvider[]>([]);
  const [selected,setSelected]=useState('');
  const [form,setForm]=useState<ModelProviderDraft>(draft());
  const [key,setKey]=useState('');
  const [clearKey,setClearKey]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [discovery,setDiscovery]=useState<ModelDiscovery|null>(null);
  const [probe,setProbe]=useState<ModelProbe|null>(null);
  const [usage,setUsage]=useState<ModelUsageStats|null>(null);
  const [usageError,setUsageError]=useState('');
  const saved=items.find(x=>x.id===selected);
  const update=(values:Partial<ModelProviderDraft>)=>setForm(old=>({...old,...values}));
  const reload=useCallback(async()=>setItems(await window.devspace.modelProvidersList()),[]);
  useEffect(()=>{reload().catch(e=>setError(message(e)));},[reload]);
  const refreshUsage=useCallback(async(id:string,model:string)=>{
    try{
      const next=await window.devspace.modelProvidersStats(id);
      if(next.model!==model)return;
      setUsage(next);setUsageError('');
    }catch(e){setUsageError(message(e));}
  },[]);
  useEffect(()=>{
    if(!selected||!saved?.model){setUsage(null);setUsageError('');return;}
    let active=true;
    const id=selected,model=saved.model;
    const refresh=async()=>{
      try{
        const next=await window.devspace.modelProvidersStats(id);
        if(active&&next.model===model){setUsage(next);setUsageError('');}
      }catch(e){if(active)setUsageError(message(e));}
    };
    setUsage(null);void refresh();
    const timer=setInterval(()=>void refresh(),10_000);
    return ()=>{active=false;clearInterval(timer);};
  },[selected,saved?.model]);
  async function discover(id:string){
    const result=await window.devspace.modelProvidersDiscover(id);
    setDiscovery(result);
    if(!result.reachable)setError('获取模型列表失败：HTTP '+result.httpStatus);
    else setNotice('已发现 '+result.models.length+' 个模型标识；请确认所选模型的实际上下文容量。');
  }
  function choose(savedModel:ModelProvider){
    setSelected(savedModel.id);setForm({...savedModel});setKey('');
    setClearKey(false);setDiscovery(null);setProbe(null);setError('');setNotice('');
    setUsage(null);setUsageError('');
    discover(savedModel.id).catch(e=>setError(message(e)));
  }
  function newProfile(){
    const next=draft();next.id='model-'+Date.now().toString(36);
    setSelected('');setForm(next);setKey('');setClearKey(false);
    setDiscovery(null);setProbe(null);setError('');setNotice('');
    setUsage(null);setUsageError('');
  }
  function changeType(type:ProviderType){
    const preset=defaults[type];
    update({type,name:preset.name,baseUrl:preset.url,model:preset.model});
    setDiscovery(null);setProbe(null);
  }
  async function save(){
    setBusy(true);setError('');setNotice('');setProbe(null);
    try{
      const stored=await window.devspace.modelProvidersSave({...form,apiKey:key||undefined,clearKey});
      setSelected(stored.id);setForm({...stored});setKey('');setClearKey(false);
      await reload();
      setNotice('模型配置已保存，API Key '+(stored.hasKey?'已由 Windows 安全加密存储':'未配置')+'。');
      try{await discover(stored.id);}
      catch(e){setError('配置保存成功，但模型列表获取失败：'+message(e));}
    }catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  async function check(functions:boolean){
    if(!selected){setError('请先保存模型配置。');return;}
    setBusy(true);setError('');setNotice('');
    try{
      const result=await window.devspace.modelProvidersProbe(selected,functions);
      setProbe(result);
      if(!result.connected)setError('模型调用未成功：HTTP '+result.httpStatus);
      else if(functions && result.functionCalling!=='supported')
        setError('服务能够返回响应，但没有生成预期的结构化工具调用；不能认为支持 Function Calling。');
      else setNotice(functions?'实际工具调用测试通过（只调用无副作用的探测函数）。':'实际模型请求已成功返回。');
    }catch(e){setError(message(e));}
    finally{
      setBusy(false);
      if(saved?.model)void refreshUsage(saved.id,saved.model);
    }
  }
  async function remove(){
    if(!selected||!window.confirm('删除此模型配置及其加密凭据？'))return;
    setBusy(true);setError('');
    try{
      await window.devspace.modelProvidersDelete(selected);
      newProfile();await reload();setNotice('模型配置及关联加密凭据已删除。');
    }catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  const number=(field:keyof Pick<ModelProviderDraft,'contextLength'|'maxOutputTokens'|'maxTaskUSD'|'inputPerMillionUSD'|'outputPerMillionUSD'>)=>
    (value:string)=>update({[field]:value===''?0:Number(value)});

  return <div className="panel models-page">
    <div className="section-heading"><div><h2>模型提供商</h2>
      <p>统一管理云端和本地模型。API 凭据仅保存在本机，现有 ChatGPT MCP 接入保持不变。</p></div>
      <span>DevSpace 内置功能</span>
    </div>
    <div className="models-layout">
      <aside className="models-list">
        <div className="models-list-head"><strong>已保存配置</strong><Button size="small" onClick={newProfile}>新增模型</Button></div>
        {items.length===0&&<p className="op-subtle">尚未添加模型配置</p>}
        {items.map(item=><button type="button" key={item.id}
          className={'models-item '+(selected===item.id?'selected':'')} onClick={()=>choose(item)}>
          <strong>{item.name}</strong><small>{item.model} · {names[item.type]}</small>
          <small>{item.hasKey?'密钥已加密保存':'不使用密钥'} · {item.role}</small>
        </button>)}
      </aside>
      <div className="models-editor">
        {error&&<div className="op-message op-error" role="alert">{error}</div>}
        {notice&&<div className="op-message op-success" role="status">{notice}</div>}
        <div className="models-field">
          <strong>接入类型</strong>
          <RadioGroup layout="vertical" value={form.type} onChange={(_,v)=>changeType(v.value as ProviderType)}>
            {(Object.keys(names) as ProviderType[]).map(type=><Radio key={type} value={type} label={names[type]}/>)}
          </RadioGroup>
        </div>
        <div className="models-two">
          <Field label="配置 ID"><Input value={form.id} disabled={Boolean(saved)} onChange={(_,v)=>update({id:v.value})}/></Field>
          <Field label="显示名称"><Input value={form.name} onChange={(_,v)=>update({name:v.value})}/></Field>
        </div>
        <Field label="API Base URL"><Input value={form.baseUrl} onChange={(_,v)=>update({baseUrl:v.value})}/></Field>
        <div className="models-two">
          <Field label="API 协议">
            <select className="op-select" value={form.api} onChange={e=>update({api:e.target.value as ModelProviderDraft['api']})}>
              <option value="chat">Chat Completions</option><option value="responses">Responses API</option>
            </select>
          </Field>
          <Field label="API Key（可选）">
            <Input type="password" value={key} placeholder={saved?.hasKey?'已加密保存，留空则保留':'输入 API Key'}
              autoComplete="off" onChange={(_,v)=>{setKey(v.value);setClearKey(false);}}/>
          </Field>
        </div>
        {saved?.hasKey&&<label className="models-check"><input type="checkbox" checked={clearKey}
          onChange={e=>{setClearKey(e.target.checked);if(e.target.checked)setKey('');}}/>删除已保存的 API Key</label>}
        <Field label="模型标识">
          <Input value={form.model} placeholder="输入服务端实际模型 ID" onChange={(_,v)=>update({model:v.value})}/>
        </Field>
        {discovery?.reachable&&discovery.models.length>0&&<Field label="从服务端已发现模型中选择">
          <select className="op-select" value={discovery.models.includes(form.model)?form.model:''}
            onChange={e=>e.target.value&&update({model:e.target.value})}>
            <option value="">选择模型（也可手动填写）</option>
            {discovery.models.map(id=><option key={id} value={id}>{id}</option>)}
          </select>
        </Field>}
        <div className="models-field">
          <strong>Agent 职责</strong>
          <RadioGroup layout="vertical" value={form.role} onChange={(_,v)=>update({role:v.value as Role})}>
            <Radio value="worker" label="Worker：编码与执行"/>
            <Radio value="reviewer" label="Reviewer：独立代码审查"/>
            <Radio value="planner" label="Planner：任务规划"/>
          </RadioGroup>
        </div>
        <div className="models-two">
          <Field label="上下文窗口（Token）">
            <Input type="number" min={1024} max={2000000} value={String(form.contextLength)}
              onChange={(_,v)=>number('contextLength')(v.value)}/>
          </Field>
          <Field label="最大输出（Token）">
            <Input type="number" min={16} max={131072} value={String(form.maxOutputTokens)}
              onChange={(_,v)=>number('maxOutputTokens')(v.value)}/>
          </Field>
        </div>
        <div className="models-three">
          <Field label="每任务费用上限（USD）">
            <Input type="number" min={0.01} step={0.01} value={String(form.maxTaskUSD)}
              onChange={(_,v)=>number('maxTaskUSD')(v.value)}/>
          </Field>
          <Field label="输入 / 百万 Token（USD）">
            <Input type="number" min={0} step={0.01} value={String(form.inputPerMillionUSD)}
              onChange={(_,v)=>number('inputPerMillionUSD')(v.value)}/>
          </Field>
          <Field label="输出 / 百万 Token（USD）">
            <Input type="number" min={0} step={0.01} value={String(form.outputPerMillionUSD)}
              onChange={(_,v)=>number('outputPerMillionUSD')(v.value)}/>
          </Field>
        </div>
        <p className="op-subtle">上下文长度由你配置，请以模型实际限制为准。价格为自行填写的估算单价；费用上限会保存在配置中，真正的任务调用还需由执行器进行预算扣减，不代表供应商账单硬限制。连接与 Function Calling 测试会发送少量实际请求，云端 API 可能计费。</p>
        {selected&&saved?.model&&<section className="models-usage" aria-label="当前选中模型的调用统计">
          <div className="models-usage-header">
            <strong>选中模型的调用统计</strong>
            <Button size="small" icon={<ArrowClockwiseRegular/>}
              onClick={()=>void refreshUsage(saved.id,saved.model)}>刷新统计</Button>
          </div>
          <div className="models-usage-grid">
            <div><small>最后调用时间</small><strong>{usage?localTime(usage.lastCallAt):'—'}</strong></div>
            <div><small>最近一次耗时</small><strong>{duration(usage?.lastDurationMs??null)}</strong></div>
            <div><small>累计 API 调用</small><strong>{count(usage?.totalCalls??0)} 次</strong></div>
            <div><small>成功 / 失败</small><strong>{count(usage?.successfulCalls??0)} / {count(usage?.failedCalls??0)}</strong></div>
            <div><small>输入 Token</small><strong>{count(usage?.inputTokens??0)}</strong></div>
            <div><small>输出 Token</small><strong>{count(usage?.outputTokens??0)}</strong></div>
            <div><small>总 Token</small><strong>{count(usage?.totalTokens??0)}</strong></div>
            <div><small>累计请求耗时</small><strong>{duration(usage?.totalDurationMs??0)}</strong></div>
            <div><small>估算费用</small><strong>${(usage?.estimatedUSD??0).toFixed(6)} USD</strong></div>
          </div>
          <p className="op-subtle">统计范围：MCP Worker 推理 {count(usage?.bySource.worker??0)} 次，
            连接测试 {count(usage?.bySource['connection-test']??0)} 次，
            Function Calling 测试 {count(usage?.bySource['function-test']??0)} 次。
            从 dev3 启用后开始累计，重启不清零；不包含 Open WebUI 或其他应用直接请求模型服务的调用。</p>
          {(usage?.usageMissingCalls??0)>0&&<p className="op-subtle">有 {count(usage?.usageMissingCalls??0)} 次请求未返回 Token 使用量，因此 Token 合计只包含服务端实际报告的数据。</p>}
          {(usage?.corruptRecords??0)>0&&<p className="op-message op-error">统计记录中有 {count(usage?.corruptRecords??0)} 条无法解析，已跳过，累计值可能偏低。</p>}
          {usageError&&<p className="op-message op-error">统计读取失败：{usageError}</p>}
        </section>}
        <div className="models-actions">
          <Button appearance="primary" icon={<SaveRegular/>} disabled={busy} onClick={save}>保存配置</Button>
          <Button icon={<ArrowClockwiseRegular/>} disabled={busy||!selected}
            onClick={async()=>{setBusy(true);setError('');try{await discover(selected);}catch(e){setError(message(e));}finally{setBusy(false);}}}>获取模型列表</Button>
          <Button disabled={busy||!selected} onClick={()=>check(false)}>测试连接</Button>
          <Button icon={<ShieldCheckmarkRegular/>} disabled={busy||!selected} onClick={()=>check(true)}>检测 Function Calling</Button>
          {selected&&<Button icon={<DeleteRegular/>} disabled={busy} onClick={remove}>删除</Button>}
          {busy&&<Spinner size="tiny"/>}
        </div>
        {probe&&<div className="models-probe" role="status">
          <strong>实时检测结果：</strong>{probe.connected?'模型请求成功':'请求未通过'}
          {' · '}Function Calling：{probe.functionCalling==='supported'?'已实际验证':probe.functionCalling==='unsupported'?'未通过':'未检测'}
          {probe.usage&&<span> · 输入 {probe.usage.inputTokens} / 输出 {probe.usage.outputTokens} Token，估算 {'$'+probe.usage.estimatedUSD.toFixed(6)}</span>}
        </div>}
      </div>
    </div>
  </div>;
}
