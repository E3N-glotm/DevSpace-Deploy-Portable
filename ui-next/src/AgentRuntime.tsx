import {useCallback,useEffect,useState} from 'react';
import {Button,Field,Input,Switch,Textarea} from '@fluentui/react-components';
import type {AgentEvent,AgentGroup,AgentTask,ModelProvider} from './api';

const empty=():AgentGroup=>({id:'',name:'',members:[],isDefault:false,requiredReviews:1});
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
export function AgentGroupsPanel({profiles}:{profiles:ModelProvider[]}){
  const [groups,setGroups]=useState<AgentGroup[]>([]);
  const [form,setForm]=useState<AgentGroup>(empty);
  const [error,setError]=useState('');
  const reload=useCallback(async()=>setGroups(await window.devspace.agentGroupsList()),[]);
  useEffect(()=>{void reload().catch(e=>setError(errorText(e)));},[reload]);
  async function save(){try{const next=await window.devspace.agentGroupsSave(form);setForm(next);await reload();setError('');}catch(e){setError(errorText(e));}}
  return <section className="panel" style={{marginTop:20}}>
    <div className="section-heading"><div><h2>模型组</h2><p>配置模型组后，Agent Runtime 默认使用指定的组。未配置时，现有 Worker 接口保持原样。</p></div><Button onClick={()=>setForm(empty())}>新增模型组</Button></div>
    {error&&<div className="op-message op-error">{error}</div>}
    <div className="models-layout"><aside className="models-list">
      {groups.map(g=><button key={g.id} className={'models-item '+(g.id===form.id?'selected':'')} onClick={()=>setForm({...g})}><strong>{g.name}{g.isDefault?' · 默认':''}</strong><small>{g.members.length} 个成员 · {g.requiredReviews} 个独立审查</small></button>)}
    </aside><div className="models-editor">
      <Field label="模型组名称"><Input value={form.name} onChange={(_,d)=>setForm(x=>({...x,name:d.value}))}/></Field>
      <Switch label="设为默认模型组" checked={form.isDefault} onChange={(_,d)=>setForm(x=>({...x,isDefault:d.checked}))}/>
      <strong>成员（引用已保存的模型配置）</strong>
      {profiles.filter(p=>p.api==='chat').map(p=><label key={p.id} className="models-check"><input type="checkbox" checked={form.members.includes(p.id)} onChange={e=>setForm(x=>({...x,members:e.target.checked?[...x.members,p.id]:x.members.filter(id=>id!==p.id),requiredReviews:1}))}/>{p.name} · {p.model} · {p.contextLength.toLocaleString()} Token · {p.role}{p.allowCalls?'':'（已禁用）'}</label>)}
      <Field label="所需独立审查数量"><Input type="number" min={1} max={Math.max(1,form.members.length-1)} value={String(form.requiredReviews)} onChange={(_,d)=>setForm(x=>({...x,requiredReviews:Number(d.value)}))}/></Field>
      <div className="models-actions"><Button appearance="primary" onClick={()=>void save()}>保存模型组</Button>{form.id&&<Button onClick={async()=>{try{await window.devspace.agentGroupsDelete(form.id);setForm(empty());await reload();}catch(e){setError(errorText(e));}}}>删除模型组</Button>}</div>
    </div></div>
  </section>;
}

export function AgentRuntimePage(){
  const [groups,setGroups]=useState<AgentGroup[]>([]);
  const [profiles,setProfiles]=useState<ModelProvider[]>([]);
  const [tasks,setTasks]=useState<AgentTask[]>([]);
  const [selected,setSelected]=useState('');
  const [events,setEvents]=useState<AgentEvent[]>([]);
  const [path,setPath]=useState('');
  const [instruction,setInstruction]=useState('');
  const [target,setTarget]=useState('');
  const [permissions,setPermissions]=useState({allowWrites:false,allowShell:false,allowComputer:false,allowMemory:true,allowPlugins:false});
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [ack,setAck]=useState(false);
  const selectedTask=tasks.find(t=>t.id===selected);
  useEffect(()=>{void Promise.all([window.devspace.agentGroupsList(),window.devspace.modelProvidersList()]).then(([g,p])=>{setGroups(g);setProfiles(p);}).catch(e=>setError(errorText(e)));},[]);
  const refresh=useCallback(async()=>{const next=await window.devspace.agentRuntime('list') as AgentTask[];setTasks(next);},[]);
  useEffect(()=>{let active=true;let inflight=false;const tick=async()=>{if(inflight)return;inflight=true;try{if(active)await refresh();}catch(e){if(active)setError(errorText(e));}finally{inflight=false;}};void tick();const timer=setInterval(()=>void tick(),1500);return()=>{active=false;clearInterval(timer);};},[refresh]);
  useEffect(()=>{
    setEvents([]);setAck(false);if(!selected)return;let active=true;let after=0;let inflight=false;
    const tick=async()=>{if(inflight)return;inflight=true;try{const next=await window.devspace.agentRuntime('events',{taskId:selected,after}) as AgentEvent[];if(!active)return;if(next.length){after=next[next.length-1].seq;setEvents(old=>[...old,...next].slice(-500));}}catch(e){if(active)setError(errorText(e));}finally{inflight=false;}};
    void tick();const timer=setInterval(()=>void tick(),1200);return()=>{active=false;clearInterval(timer);};
  },[selected]);
  async function start(){setBusy(true);try{
    const chosen=target.startsWith('model:')?{modelId:target.slice(6)}:target?{groupId:target}:{};
    const task=await window.devspace.agentRuntime('start',{input:{path,instruction,...chosen,...permissions}});
    await refresh();setSelected(task.id);setError('');
  }catch(e){setError(errorText(e));}finally{setBusy(false);}}
  async function control(action:string){if(!selected)return;setBusy(true);try{await window.devspace.agentRuntime(action,{taskId:selected,acknowledge:ack});await refresh();setError('');}catch(e){setError(errorText(e));}finally{setBusy(false);}}
  return <div className="panel models-page">
    <div className="section-heading"><div><h2>Agent 工作台</h2><p>独立任务、模型组协作、工具记录、上下文检查点与审查。关闭此页面不会停止 MCP 服务中的任务。</p></div></div>
    {error&&<div className="op-message op-error" role="alert">{error}</div>}
    <section className="models-editor">
      <Field label="工作区路径（本机路径或 devspace:// 远端路径）"><Input value={path} onChange={(_,d)=>setPath(d.value)}/></Field>
      <Field label="模型或模型组"><select className="op-select" value={target} onChange={e=>setTarget(e.target.value)}><option value="">默认模型组</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}{profiles.filter(p=>p.api==='chat'&&p.allowCalls).map(p=><option key={p.id} value={'model:'+p.id}>{p.name}（单 Agent）</option>)}</select></Field>
      <Field label="任务目标与验收条件"><Textarea value={instruction} rows={4} onChange={(_,d)=>setInstruction(d.value)}/></Field>
      {([['allowWrites','允许编辑文件'],['allowShell','允许 Shell（继承现有权限）'],['allowComputer','允许 Computer Use（需要桌面开关）'],['allowMemory','允许工作区记忆写入'],['allowPlugins','允许已授权插件调用']] as const).map(([id,label])=><Switch key={id} label={label} checked={permissions[id]} onChange={(_,d)=>setPermissions(x=>({...x,[id]:d.checked}))}/>)}
      <Button appearance="primary" disabled={busy||!path.trim()||!instruction.trim()} onClick={()=>void start()}>启动任务</Button>
    </section>
    <div className="models-layout" style={{marginTop:20}}>
      <aside className="models-list">{tasks.map(t=><button key={t.id} className={'models-item '+(selected===t.id?'selected':'')} onClick={()=>setSelected(t.id)}><strong>{t.status} · {t.steps} 步</strong><small>{t.instruction.slice(0,100)}</small></button>)}</aside>
      <section className="models-editor">
        {selectedTask&&<>
          <strong>{selectedTask.status} · {selectedTask.id}</strong>
          <p>{selectedTask.instruction}</p>
          {selectedTask.error&&<p className="op-message op-error">{selectedTask.error}</p>}
          {selectedTask.pending!=null&&<Switch label="我已核对中断工具是否执行，允许恢复（不自动重放）" checked={ack} onChange={(_,d)=>setAck(d.checked)}/>}
          <div className="models-actions">
            <Button disabled={busy||selectedTask.status!=='running'} onClick={()=>void control('pause')}>暂停</Button>
            <Button disabled={busy||!['paused','awaiting-review'].includes(selectedTask.status)||(selectedTask.pending!=null&&!ack)} onClick={()=>void control('resume')}>恢复</Button>
            <Button disabled={busy||selectedTask.status!=='awaiting-review'} onClick={()=>void control('accept')}>人工验收</Button>
            <Button disabled={busy||['completed','cancelled','failed'].includes(selectedTask.status)} onClick={()=>void control('cancel')}>取消任务</Button>
          </div>
          {selectedTask.agents.map(a=><div className="models-usage" key={a.id}><strong>{a.id} · {profiles.find(p=>p.id===a.profileId)?.name||a.profileId} · {a.state}</strong><p>{a.steps} 步 · 输入 {a.inputTokens.toLocaleString()} / 输出 {a.outputTokens.toLocaleString()} Token · 上下文估计 {a.contextEstimate.toLocaleString()} · ${a.estimatedUSD.toFixed(6)}</p></div>)}
          {selectedTask.result&&<div className="models-usage"><strong>提交结果</strong><pre style={{whiteSpace:'pre-wrap'}}>{selectedTask.result}</pre></div>}
          <strong>实时事件（最新 500 条，原始记录保留于任务库）</strong>
          <div style={{maxHeight:650,overflow:'auto'}}>{events.map(e=><article key={e.seq} className="models-usage"><small>{new Date(e.at).toLocaleTimeString()} · {e.agent||'Runtime'} · {e.kind}</small>
            {Object.entries(e).filter(([k])=>!['seq','at','agent','kind'].includes(k)).map(([k,v])=>v!==null&&v!==''&&<div key={k}><strong>{k==='reasoning'?'模型实际返回的推理内容':k}</strong><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto'}}>{typeof v==='string'?v:JSON.stringify(v,null,2)}</pre></div>)}</article>)}</div>
        </>}
        {!selectedTask&&<p>选择或启动一个 Agent 任务。</p>}
      </section>
    </div>
  </div>;
}
