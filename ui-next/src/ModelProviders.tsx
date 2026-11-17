import {useCallback,useEffect,useRef,useState} from 'react';
import {Button,Field,Input,Radio,RadioGroup,Spinner,Switch} from '@fluentui/react-components';
import {ArrowClockwiseRegular,DeleteRegular,SaveRegular,ShieldCheckmarkRegular} from '@fluentui/react-icons';
import type {AgentRouteMode,AgentRoutingSettings,ModelProvider,ModelProviderDraft,ModelDiscovery,ModelProbe,ModelUsageStats} from './api';
import {AgentGroupsPanel,agentError,profileLabel} from './AgentRuntime';
import {routeModes} from './AgentFlow';

type ProviderType=ModelProviderDraft['type'];
type Role=ModelProviderDraft['role'];
const defaults:Record<ProviderType,{url:string;name:string;model:string}>={
  deepseek:{url:'https://api.deepseek.com/v1',name:'DeepSeek',model:'deepseek-flash'},
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
    allowCalls:true,
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

function GlobalModelRouting({profiles}:{profiles:ModelProvider[]}){
  const [routing,setRouting]=useState<AgentRoutingSettings>();
  const [error,setError]=useState('');
  const [saving,setSaving]=useState(false);
  const workers=profiles.filter(profile=>profile.api==='chat'&&profile.allowCalls&&profile.role==='worker');
  const load=useCallback(async()=>{
    setError('');
    try{setRouting(await window.devspace.agentRuntime('routing-settings') as AgentRoutingSettings);}
    catch(e){setError(agentError(e));}
  },[]);
  useEffect(()=>{void load();},[load]);
  async function save(input:AgentRoutingSettings){
    setSaving(true);
    setError('');
    try{setRouting(await window.devspace.agentRuntime('set-routing-settings',{input}) as AgentRoutingSettings);}
    catch(e){setError(agentError(e));}
    finally{setSaving(false);}
  }
  return <section className="model-routing-settings" aria-label="全局模型调度">
    <div><h3>全局模型调度</h3><p className="op-subtle">同时适用于 ChatGPT 通过 DevSpace MCP 委派的任务和 DevSpace 工作台新建的任务。</p></div>
    {routing ? <div className="models-two">
      <Field label="调度模式"><select className="op-select" value={routing.mode} disabled={saving}
        onChange={e=>void save({...routing,mode:e.target.value as AgentRouteMode})}>
        {Object.entries(routeModes).map(([mode,label])=><option value={mode} key={mode}>{label}</option>)}
      </select></Field>
      <Field label="默认单模型"><select className="op-select" value={routing.defaultWorkerId||''} disabled={saving}
        onChange={e=>void save({...routing,defaultWorkerId:e.target.value||null})}>
        <option value="">自动选择可用 Worker</option>
        {routing.defaultWorkerId&&!workers.some(profile=>profile.id===routing.defaultWorkerId)&&
          <option value={routing.defaultWorkerId}>已保存的模型不可用</option>}
        {workers.map(profile=><option value={profile.id} key={profile.id}>{profileLabel(profile)}</option>)}
      </select></Field>
    </div> : error ? <Button size="small" onClick={()=>void load()}>重新读取</Button> : <Spinner size="tiny" label="读取全局设置"/>}
    {error&&<div className="op-message op-error" role="alert">{error}</div>}
  </section>;
}

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
  const [clearingUsage,setClearingUsage]=useState(false);
  const [groupDialog,setGroupDialog]=useState(false);
  const [showReasoningAdvanced,setShowReasoningAdvanced]=useState(false);
  const selectedRef=useRef('');
  const discoveryGeneration=useRef(0);
  const saved=items.find(x=>x.id===selected);
  const usageIdentity=useRef('');
  const usageGeneration=useRef(0);
  const clearingIdentity=useRef('');
  usageIdentity.current=JSON.stringify([selected,saved?.model]);
  const update=(values:Partial<ModelProviderDraft>)=>{setForm(old=>({...old,...values}));setProbe(null);};
  const reload=useCallback(async()=>setItems(await window.devspace.modelProvidersList()),[]);
  useEffect(()=>{reload().catch(e=>setError(message(e)));},[reload]);
  const refreshUsage=useCallback(async(id:string,model:string)=>{
    const identity=JSON.stringify([id,model]);
    if(usageIdentity.current!==identity||clearingIdentity.current===identity)return;
    const generation=++usageGeneration.current;
    try{
      const next=await window.devspace.modelProvidersStats(id);
      if(next.model!==model||usageIdentity.current!==identity||usageGeneration.current!==generation)return;
      setUsage(next);setUsageError('');
    }catch(e){if(usageIdentity.current===identity&&usageGeneration.current===generation)setUsageError(message(e));}
  },[]);
  async function clearUsage(id:string,model:string){
    const identity=JSON.stringify([id,model]);
    if(clearingIdentity.current||usageIdentity.current!==identity)return;
    if(!window.confirm('确定清空当前模型的调用统计？仅重置统计起点，不影响其他模型、任务历史或正在执行的请求。'))return;
    clearingIdentity.current=identity;setClearingUsage(true);++usageGeneration.current;
    try{
      const next=await window.devspace.modelProvidersClearStats(id,model);
      if(usageIdentity.current===identity){setUsage(next);setUsageError('');}
    }catch(e){if(usageIdentity.current===identity)setUsageError(message(e));}
    finally{clearingIdentity.current='';setClearingUsage(false);}
  }
  useEffect(()=>{
    if(!selected||!saved?.model){setUsage(null);setUsageError('');return;}
    const id=selected,model=saved.model;
    const refresh=()=>refreshUsage(id,model);
    setUsage(null);void refresh();
    const timer=setInterval(()=>void refresh(),10_000);
    return ()=>{++usageGeneration.current;clearInterval(timer);};
  },[selected,saved?.model,refreshUsage]);
  async function discover(id:string){
    const generation=++discoveryGeneration.current;
    let result:ModelDiscovery;
    try{result=await window.devspace.modelProvidersDiscover(id);}
    catch(e){
      // A reply from an earlier selection (or a now-disabled model) must
      // not repaint the current editor as a failed request.
      if(selectedRef.current!==id||discoveryGeneration.current!==generation)return;
      throw e;
    }
    if(selectedRef.current!==id||discoveryGeneration.current!==generation)return;
    setDiscovery(result);
    if(!result.reachable)setError('获取模型列表失败：HTTP '+result.httpStatus);
    else setNotice('已发现 '+result.models.length+' 个模型标识；请确认所选模型的实际上下文容量。');
  }
  function choose(savedModel:ModelProvider){
    selectedRef.current=savedModel.id;
    discoveryGeneration.current++;
    setSelected(savedModel.id);setForm({...savedModel});setKey('');
    setClearKey(false);setDiscovery(null);setProbe(null);setError('');setNotice('');
    setUsage(null);setUsageError('');
    if(savedModel.allowCalls===false){
      setNotice('该模型已关闭“允许调用”。可以查看或编辑配置；启用后才能获取模型列表或发送测试请求。');
      return;
    }
    if(savedModel.hasKey&&savedModel.role==='worker'&&!savedModel.workerCredentialReady)
      setNotice('此模型的旧 API 凭据尚未建立 Worker 专用 DPAPI 加密桥接；请重新启动 DevSpace 桌面界面或重新保存模型配置。');
    discover(savedModel.id).catch(e=>{
      if(selectedRef.current===savedModel.id)setError(message(e));
    });
  }
  function newProfile(){
    const next=draft();next.id='model-'+Date.now().toString(36);
    selectedRef.current='';discoveryGeneration.current++;
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
      selectedRef.current=stored.id;discoveryGeneration.current++;
      setSelected(stored.id);setForm({...stored});setKey('');setClearKey(false);
      await reload();
      setNotice('模型配置已保存，API Key '+(stored.hasKey?'已由 Windows 安全加密存储':'未配置')+'。');
      if(stored.allowCalls!==false){
        try{await discover(stored.id);}
        catch(e){if(selectedRef.current===stored.id)
          setError('配置保存成功，但模型列表获取失败：'+message(e));}
      }
    }catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  async function check(functions:boolean,reasoning=false){
    if(!selected){setError('请先保存模型配置。');return;}
    setBusy(true);setError('');setNotice('');
    try{
      const result=await window.devspace.modelProvidersProbe(selected,functions,reasoning);
      setProbe(result);
      if(!result.connected)setError('模型调用未成功：HTTP '+result.httpStatus);
      else if(functions && result.functionCalling!=='supported')
        setError('服务能够返回响应，但没有生成预期的结构化工具调用；不能认为支持 Function Calling。');
      else setNotice(reasoning?'实际推理探测请求已返回；请查看下方响应证据。':functions?'实际工具调用测试通过（只调用无副作用的探测函数）。':'实际模型请求已成功返回。');
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
  async function toggleAllowed(id:string,enabled:boolean){
    setBusy(true);setError('');setNotice('');
    try{
      const result=await window.devspace.modelProvidersSetAllowed(id,enabled);
      setItems(items=>items.map(item=>item.id===id?result:item));
      if(selected===id)setForm(form=>({...form,allowCalls:result.allowCalls}));
      if(!result.allowCalls&&selectedRef.current===id){
        discoveryGeneration.current++;
        setDiscovery(null);setProbe(null);
      }
      setNotice(enabled?'已允许该模型接受新调用。':'已禁止该模型的新调用和后续推理；正在执行的请求会在下一检查点中止。');
    }catch(e){setError(message(e));}
    finally{setBusy(false);}
  }
  const number=(field:keyof Pick<ModelProviderDraft,'contextLength'|'maxOutputTokens'|'maxTaskUSD'|'inputPerMillionUSD'|'outputPerMillionUSD'>)=>
    (value:string)=>update({[field]:value===''?0:Number(value)});
  const savedForProbe=Boolean(saved&&['type','baseUrl','model','api','reasoningEffort','reasoningAdapter','maxOutputTokens'].every(k=>String(form[k as keyof ModelProviderDraft]??'')===String(saved[k as keyof ModelProvider]??''))&&!key&&!clearKey);
  const actualContext=discovery?.contexts?.[form.model];

  return <div className="panel models-page">
    <div className="section-heading"><div><h2>模型提供商</h2>
      <p>统一管理云端和本地模型。API 凭据仅保存在本机，现有 ChatGPT MCP 接入保持不变。</p></div>
      <Button appearance="primary" onClick={()=>setGroupDialog(true)}>创建 / 管理模型组</Button>
    </div>
    <GlobalModelRouting profiles={items}/>
    <div className="models-layout">
      <aside className="models-list">
        <div className="models-list-head"><strong>已保存配置</strong><Button size="small" onClick={newProfile}>新增模型</Button></div>
        {items.length===0&&<p className="op-subtle">尚未添加模型配置</p>}
        {items.map(item=><div className="models-item-row" key={item.id}>
          <button type="button" className={'models-item '+(selected===item.id?'selected':'')}
            onClick={()=>choose(item)}>
            <strong>{item.name} · {Math.round(item.contextLength/1024)}K</strong><small>{item.model} · {names[item.type]}</small>
            <small>{item.hasKey?(item.role==='worker'&&!item.workerCredentialReady
              ?'密钥待建立 Worker 安全桥接':'密钥已加密保存'):'不使用密钥'} · {item.role}</small>
          </button>
          <div className="models-item-toggle">
            <Switch label="允许调用" checked={item.allowCalls} disabled={busy}
              onChange={(_e,d)=>void toggleAllowed(item.id,d.checked)}/>
          </div>
        </div>)}
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
        {actualContext&&actualContext!==form.contextLength?<div className="op-message op-warning">模型服务声明的上下文为 {actualContext.toLocaleString()} Token，当前配置为 {form.contextLength.toLocaleString()}。配置值只控制 Agent 自身的上下文管理；如需修改后端实际容量，请选择对应的模型标识。</div>:null}
        <div className="models-two">
          <Field label="Agent 思考程度"><select className="op-select" value={form.reasoningEffort||'auto'} onChange={e=>update({reasoningEffort:e.target.value as ModelProviderDraft['reasoningEffort']})}>
            <option value="auto">自动 · 供应商默认</option><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="extra-high">最高</option>
          </select></Field>
          <Field label="验证实际推理"><Button disabled={busy||!savedForProbe||saved?.allowCalls===false} onClick={()=>void check(false,true)}>检测思考配置</Button></Field>
        </div>
        <p className="op-subtle">默认自动适配 DeepSeek、Qwen 和已知兼容格式。检测会发送少量真实请求（云端可能计费）；未保存修改需先保存。HTTP 成功只证明请求被接受，不能证明服务端严格执行了指定档位。</p>
        <Button size="small" onClick={()=>setShowReasoningAdvanced(x=>!x)}>{showReasoningAdvanced?'收起':'展开'}高级推理适配</Button>
        {showReasoningAdvanced&&<Field label="推理参数适配（通常不需要修改）"><select className="op-select" value={form.reasoningAdapter==='openai'?'openai':'auto'} onChange={e=>update({reasoningAdapter:e.target.value as ModelProviderDraft['reasoningAdapter']})}><option value="auto">自动识别 / 供应商原生</option><option value="openai">手动指定 OpenAI reasoning_effort</option></select></Field>}
        {probe?.reasoning&&<section className="models-probe" aria-label="推理检测证据">
          <strong>{probe.reasoning.accepted?'请求已被接受':'请求未通过'} · {probe.reasoning.applied.adapter}</strong>
          <p>正式任务映射：{probe.reasoning.planned.requested} → {probe.reasoning.planned.effective}；实际拟发送参数：{JSON.stringify(probe.reasoning.planned.parameters)}</p>
          <p>本次短探测实际发送：{JSON.stringify(probe.reasoning.applied.parameters)}{probe.reasoning.applied.effective!==probe.reasoning.planned.effective?'（探测输出上限较小，不等于正式任务容量）':''}</p>
          <p>服务端返回思考内容：{probe.reasoning.reasoningReturned?'有（'+probe.reasoning.reasoningChars+' 字符）':'未观察到'}；思考 Token：{probe.reasoning.reasoningTokens??'未报告'}。</p>
          <p>{probe.reasoning.planned.effective==='unsupported'?'无已知控制协议，当前档位无法保证生效。':probe.reasoning.reasoningReturned?'已观察到实际思考输出，具体档位仍取决于后端实现。':'尚无可验证的思考内容，不能判定档位是否生效。'}</p>
        </section>}
        <Switch label="视觉模型（允许向此模型发送 Computer Use 截图）" checked={form.vision===true} onChange={(_,d)=>update({vision:d.checked})}/>
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
            <div style={{display:'flex',flexDirection:'column',gap:6}}>
              <Button size="small" icon={<ArrowClockwiseRegular/>} disabled={clearingUsage}
                onClick={()=>void refreshUsage(saved.id,saved.model)}>刷新统计</Button>
              <Button size="small" disabled={clearingUsage} onClick={()=>void clearUsage(saved.id,saved.model)}>清空统计</Button>
            </div>
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
            从 dev3 启用或最近一次手动清零后开始累计，重启不清零；不包含 Open WebUI 或其他应用直接请求模型服务的调用。</p>
          {(usage?.usageMissingCalls??0)>0&&<p className="op-subtle">有 {count(usage?.usageMissingCalls??0)} 次请求未返回 Token 使用量，因此 Token 合计只包含服务端实际报告的数据。</p>}
          {(usage?.corruptRecords??0)>0&&<p className="op-message op-error">统计记录中有 {count(usage?.corruptRecords??0)} 条无法解析，已跳过，累计值可能偏低。</p>}
          {usageError&&<p className="op-message op-error">统计读取失败：{usageError}</p>}
        </section>}
        <div className="models-actions">
          <Button appearance="primary" icon={<SaveRegular/>} disabled={busy} onClick={save}>保存配置</Button>
          <Button icon={<ArrowClockwiseRegular/>} disabled={busy||!selected||saved?.allowCalls===false}
            onClick={async()=>{setBusy(true);setError('');try{await discover(selected);}catch(e){setError(message(e));}finally{setBusy(false);}}}>获取模型列表</Button>
          <Button disabled={busy||!selected||saved?.allowCalls===false} onClick={()=>check(false)}>测试连接</Button>
          <Button icon={<ShieldCheckmarkRegular/>} disabled={busy||!selected||saved?.allowCalls===false} onClick={()=>check(true)}>检测 Function Calling</Button>
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
    {groupDialog&&<AgentGroupsPanel profiles={items} open={groupDialog} onClose={()=>setGroupDialog(false)}/>}
  </div>;
}
