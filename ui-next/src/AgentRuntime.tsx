import {useCallback,useEffect,useRef,useState} from 'react';
import {Button,Dialog,DialogSurface,DialogBody,DialogTitle,DialogContent,Field,Input,Switch,Textarea} from '@fluentui/react-components';
import type {AgentEvent,AgentGroup,AgentTask,ModelProvider} from './api';

const empty=():AgentGroup=>({id:'',name:'',members:[],childGroups:[],isDefault:false,requiredReviews:1,parallelism:4,backendParallelism:1,leaderId:'',writerId:''});
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
const profileLabel=(p:ModelProvider)=>p.name+' · '+p.model+' · '+Math.round(p.contextLength/1024)+'K · '+p.id;
function memberIds(group:AgentGroup,groups:AgentGroup[],seen=new Set<string>()):string[]{
  if(seen.has(group.id)&&group.id)return [];
  const next=new Set([...seen,group.id]);
  return [...new Set([...group.members,...(group.childGroups||[]).flatMap(id=>{const child=groups.find(g=>g.id===id);return child?memberIds(child,groups,next):[];})])];
}
function containsGroup(group:AgentGroup,id:string,groups:AgentGroup[],seen=new Set<string>()):boolean{
  if(!id||seen.has(group.id))return false;
  const next=new Set([...seen,group.id]);
  return group.id===id||(group.childGroups||[]).some(c=>{const child=groups.find(g=>g.id===c);return child?containsGroup(child,id,groups,next):false;});
}
export function AgentGroupsPanel({profiles,open,onClose}:{profiles:ModelProvider[];open:boolean;onClose:()=>void}){
  const [groups,setGroups]=useState<AgentGroup[]>([]);
  const [form,setForm]=useState<AgentGroup>(empty);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const reload=useCallback(async()=>setGroups(await window.devspace.agentGroupsList()),[]);
  useEffect(()=>{if(open){setForm(empty());setError('');setNotice('');void reload().catch(e=>setError(errorText(e)));}},[open,reload]);
  async function save(){try{const next=await window.devspace.agentGroupsSave(form);setForm(next);await reload();setError('');setNotice('模型组已保存');}catch(e){setError(errorText(e));}}
  const effective=memberIds(form,groups);
  function changeMembers(next:AgentGroup){
    const ids=memberIds(next,groups);
    setForm({...next,leaderId:ids.includes(next.leaderId||'')?next.leaderId:'',writerId:ids.includes(next.writerId||'')?next.writerId:'',requiredReviews:Math.min(next.requiredReviews,Math.max(1,ids.length-1))});
  }
  const referenced=new Set(groups.flatMap(g=>g.childGroups||[]));
  const roots=groups.filter(g=>!referenced.has(g.id));
  const renderTree=(g:AgentGroup,ancestors:string[]=[]):React.ReactNode=>{
    if(ancestors.includes(g.id))return <small key={g.id}>循环引用</small>;
    const children=(g.childGroups||[]).map(id=>groups.find(c=>c.id===id)).filter((x):x is AgentGroup=>Boolean(x));
    return <div className="agent-tree-node" key={g.id}>
      <button className={'models-item '+(g.id===form.id?'selected':'')} onClick={()=>{setForm({...empty(),...g});setNotice('');}}><strong>{g.name}{g.isDefault?' · 默认':''}</strong><small>{memberIds(g,groups).length} 个模型 · {children.length} 个子组</small></button>
      {(children.length>0||g.members.length>0)&&<details open><summary>成员与子组</summary><div className="agent-tree-children">
        {g.members.map(id=><small className="agent-tree-leaf" key={id}>{profiles.find(p=>p.id===id)?.name||id}</small>)}
        {children.map(child=>renderTree(child,[...ancestors,g.id]))}
      </div></details>}
    </div>;
  };
  return <Dialog open={open} onOpenChange={(_,d)=>{if(!d.open)onClose();}}>
    <DialogSurface className="agent-dialog"><DialogBody>
      <DialogTitle>模型组管理</DialogTitle>
      <DialogContent>
        <p className="op-subtle">模型组可包含模型与其他模型组，重复引用同一模型只运行一个成员。默认组用于上游委派，协调者分配任务、唯一执行者修改、独立成员审查。</p>
        <div className="models-actions"><Button onClick={()=>{setForm(empty());setNotice('');}}>创建模型组</Button><Button onClick={onClose}>返回</Button></div>
        {error&&<div className="op-message op-error">{error}</div>}
        {notice&&<div className="op-message op-success">{notice}</div>}
        <div className="agent-group-layout">
          <aside className="models-list agent-tree"><strong>模型组树</strong>{(roots.length?roots:groups).map(g=>renderTree(g))}</aside>
          <div className="models-editor">
            <Field label="模型组名称"><Input value={form.name} onChange={(_,d)=>setForm(x=>({...x,name:d.value}))}/></Field>
            <Switch label="设为默认模型组" checked={form.isDefault} onChange={(_,d)=>setForm(x=>({...x,isDefault:d.checked}))}/>
            <strong>直接成员（已保存模型）</strong>
            {profiles.filter(p=>p.api==='chat').map(p=><label key={p.id} className="models-check"><input type="checkbox" disabled={!p.allowCalls&&!form.members.includes(p.id)} checked={form.members.includes(p.id)} onChange={e=>changeMembers({...form,members:e.target.checked?[...form.members,p.id]:form.members.filter(id=>id!==p.id)})}/>{profileLabel(p)}{p.allowCalls?'':'（已禁用）'}</label>)}
            <strong>子模型组</strong>
            {groups.filter(g=>g.id!==form.id).map(g=><label key={g.id} className="models-check"><input type="checkbox" disabled={containsGroup(g,form.id,groups)} checked={(form.childGroups||[]).includes(g.id)} onChange={e=>changeMembers({...form,childGroups:e.target.checked?[...(form.childGroups||[]),g.id]:(form.childGroups||[]).filter(id=>id!==g.id)})}/>{g.name} · {memberIds(g,groups).length} 个有效成员</label>)}
            <div className="models-usage"><strong>展开后有效成员：{effective.length}</strong><p>{effective.map(id=>{const p=profiles.find(p=>p.id===id);return p?p.name+' · '+Math.round(p.contextLength/1024)+'K':id;}).join(' / ')||'尚未选择成员'}</p></div>
            <Field label="团队协调者"><select className="op-select" value={form.leaderId||''} onChange={e=>setForm(x=>({...x,leaderId:e.target.value}))}><option value="">自动（优先规划角色）</option>{effective.map(id=><option key={id} value={id}>{profiles.find(p=>p.id===id)?.name||id} · {id}</option>)}</select></Field>
            <Field label="唯一执行者（文件、Shell、桌面）"><select className="op-select" value={form.writerId||''} onChange={e=>setForm(x=>({...x,writerId:e.target.value}))}><option value="">自动（优先执行角色）</option>{effective.map(id=><option key={id} value={id}>{profiles.find(p=>p.id===id)?.name||id} · {id}</option>)}</select></Field>
            <div className="models-two">
              <Field label="团队最多同时推理"><Input type="number" min={1} max={8} value={String(form.parallelism??4)} onChange={(_,d)=>setForm(x=>({...x,parallelism:Number(d.value)}))}/></Field>
              <Field label="同一后端最大并发槽位"><Input type="number" min={1} max={8} value={String(form.backendParallelism??1)} onChange={(_,d)=>setForm(x=>({...x,backendParallelism:Number(d.value)}))}/></Field>
            </div>
            <p className="op-subtle">同一后端默认 1。确认后端真实并发槽位和显存容量后再调大；不同后端可以同时推理。子组继承当前运行的上级组调度策略。</p>
            <Field label="所需独立审查数量"><Input type="number" min={1} max={Math.max(1,effective.length-1)} value={String(form.requiredReviews)} onChange={(_,d)=>setForm(x=>({...x,requiredReviews:Number(d.value)}))}/></Field>
            <div className="models-actions"><Button appearance="primary" disabled={!form.name.trim()||!effective.length} onClick={()=>void save()}>保存模型组</Button>{form.id&&<Button onClick={async()=>{if(!window.confirm('删除此模型组？模型配置不会删除。'))return;try{await window.devspace.agentGroupsDelete(form.id);setForm(empty());await reload();}catch(e){setError(errorText(e));}}}>删除模型组</Button>}</div>
          </div>
        </div>
      </DialogContent>
    </DialogBody></DialogSurface>
  </Dialog>;
}

const statusNames:Record<string,string>={running:'运行中',paused:'已暂停','awaiting-review':'等待验收',completed:'已完成',failed:'失败',cancelled:'已取消',ready:'就绪',waiting:'等待',submitted:'已提交',approved:'已审查',planning:'制定计划',working:'分工执行',reviewing:'独立审查',queued:'等待依赖',active:'执行中',reported:'已交付'};
const eventNames:Record<string,string>={created:'任务开始',state:'状态变更',recovered:'任务恢复','inference-start':'开始推理','inference-stream':'正在生成',output:'模型输出',message:'协作消息',review:'审查','tool-start':'调用工具','tool-result':'工具结果',compaction:'上下文压缩',plan:'任务分配','plan-fallback':'自动备用计划',assignment:'子任务开始',report:'子任务交付','parallel-dispatch':'并行推理调度'};
type TimelineEvent=AgentEvent&{taskId:string};
const active=(t:AgentTask)=>['running','paused','awaiting-review'].includes(t.status);
function mergeEvents(old:TimelineEvent[],incoming:TimelineEvent[]){
  const result=[...old];
  for(const event of incoming){
    const previous=result[result.length-1];
    if(previous?.kind==='inference-stream'&&previous.taskId===event.taskId&&previous.agent===event.agent&&['inference-stream','output'].includes(event.kind)&&(previous.step===undefined||event.step===undefined||previous.step===event.step))result.pop();
    result.push(event);
  }
  return result.slice(-500);
}
export function AgentRuntimePage(){
  const [groups,setGroups]=useState<AgentGroup[]>([]);
  const [profiles,setProfiles]=useState<ModelProvider[]>([]);
  const [tasks,setTasks]=useState<AgentTask[]>([]);
  const [filter,setFilter]=useState('');
  const [events,setEvents]=useState<Record<string,TimelineEvent[]>>({});
  const cursors=useRef<Record<string,number>>({});
  const [createOpen,setCreateOpen]=useState(false);
  const [path,setPath]=useState('');
  const [instruction,setInstruction]=useState('');
  const [target,setTarget]=useState('');
  const [advanced,setAdvanced]=useState(false);
  const [permissions,setPermissions]=useState({allowWrites:false,allowShell:false,allowComputer:false,allowMemory:true,allowPlugins:false});
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const [ack,setAck]=useState<Record<string,boolean>>({});
  useEffect(()=>{void Promise.all([window.devspace.agentGroupsList(),window.devspace.modelProvidersList()]).then(([g,p])=>{setGroups(g);setProfiles(p);}).catch(e=>setError(errorText(e)));},[]);
  const refresh=useCallback(async()=>{const next=await window.devspace.agentRuntime('list') as AgentTask[];setTasks(next);return next;},[]);
  useEffect(()=>{let alive=true;let inflight=false;const tick=async()=>{if(inflight)return;inflight=true;try{
    const next=await refresh();if(!alive)return;
    const watched=filter?next.filter(t=>t.id===filter):[...next.filter(active),...next.filter(t=>!active(t)).slice(0,5)];
    const updates=await Promise.all(watched.map(async t=>{const batch=await window.devspace.agentRuntime('events',{taskId:t.id,after:cursors.current[t.id]||0}) as AgentEvent[];return {id:t.id,batch};}));
    if(!alive)return;
    for(const {id,batch} of updates)if(batch.length){cursors.current[id]=batch[batch.length-1].seq;setEvents(old=>({...old,[id]:mergeEvents(old[id]||[],batch.map(e=>({...e,taskId:id})))}));}
  }catch(e){if(alive)setError(errorText(e));}finally{inflight=false;}};void tick();const timer=setInterval(()=>void tick(),1500);return()=>{alive=false;clearInterval(timer);};},[refresh,filter]);
  async function start(){setBusy(true);try{
    const chosen=target.startsWith('model:')?{modelId:target.slice(6)}:target?{groupId:target}:{};
    await window.devspace.agentRuntime('start',{input:{path,instruction,...chosen,...permissions}});
    await refresh();setFilter('');setCreateOpen(false);setInstruction('');setError('');
  }catch(e){setError(errorText(e));}finally{setBusy(false);}}
  async function control(action:string,t:AgentTask){setBusy(true);try{await window.devspace.agentRuntime(action,{taskId:t.id,acknowledge:ack[t.id]===true});await refresh();setError('');}catch(e){setError(errorText(e));}finally{setBusy(false);}}
  const shown=filter?tasks.filter(t=>t.id===filter):[...tasks.filter(active),...tasks.filter(t=>!active(t)).slice(0,5)];
  const timeline=shown.flatMap(t=>events[t.id]||[]).sort((a,b)=>a.seq-b.seq).slice(-250);
  const groupName=(t:AgentTask|undefined)=>groups.find(g=>g.id===t?.groupId)?.name||'单 Agent';
  const agentLabel=(t:AgentTask|undefined,id:string|null)=>{const a=t?.agents.find(a=>a.id===id);const p=profiles.find(p=>p.id===a?.profileId);return id?(p?p.name+' · '+Math.round(p.contextLength/1024)+'K · '+id:id):'Runtime';};
  return <div className="panel models-page agent-workbench">
    <div className="section-heading"><div><h2>Agent 协作动态</h2><p>上游委派和本地启动的 Agent 均在这里显示，无需手动选择任务。关闭页面不会停止运行。</p></div><Button appearance="primary" onClick={()=>setCreateOpen(true)}>新建任务</Button></div>
    {error&&<div className="op-message op-error" role="alert">{error}</div>}
    <div className="agent-summary"><strong>{tasks.filter(t=>t.status==='running').length} 个运行中</strong><span>{tasks.filter(active).length} 个未结束</span><span>{tasks.filter(t=>t.status==='completed').length} 个已完成</span><select aria-label="协作动态范围" className="op-select" value={filter} onChange={e=>setFilter(e.target.value)}><option value="">全部协作动态（默认）</option>{tasks.map(t=><option key={t.id} value={t.id}>{groupName(t)} · {statusNames[t.status]||t.status} · {t.instruction.slice(0,45)}</option>)}</select></div>
    {shown.filter(t=>active(t)||filter).map(t=><section className="models-usage" key={t.id}>
      <div className="models-usage-header"><strong>{groupName(t)} · {statusNames[t.status]||t.status} · {t.steps} 步</strong><small>{t.id.slice(-8)}</small></div>
      <div>{t.instruction}</div>{t.error&&<div className="op-message op-error">{t.error}</div>}
      {t.team&&<div className="agent-summary"><strong>{statusNames[t.team.phase]||t.team.phase}</strong><span>协调者 {t.team.leader} · 唯一执行者 {t.team.writer}</span><span>审查 {t.team.reviewers.join(', ')} · 最大并行 {t.parallelism} / 同后端 {t.backendParallelism}</span></div>}
      <div className="agent-roster">{t.agents.map(a=><div key={a.id}><strong>{agentLabel(t,a.id)}</strong>
        {t.team&&<small>{[a.id===t.team.leader?'协调者':'',a.id===t.team.writer?'唯一执行者':'',t.team.reviewers.includes(a.id)?'审查者':''].filter(Boolean).join(' · ')||'协作成员'}</small>}
        {a.groupPaths?.length?<small>{a.groupPaths.map(p=>p.join(' / ')).join('；')}</small>:null}
        <small>{statusNames[a.state]||a.state} · {a.steps} 步 · 上下文约 {a.contextEstimate.toLocaleString()}</small><small>{a.inputTokens||a.outputTokens?'输入 '+a.inputTokens.toLocaleString()+' / 输出 '+a.outputTokens.toLocaleString():'暂无服务端用量'}</small>
        {t.team?.assignments[a.id]&&<><small>{statusNames[t.team.assignments[a.id].status]} · {t.team.assignments[a.id].dependsOn.length?'依赖 '+t.team.assignments[a.id].dependsOn.join(', '):'无依赖'}</small><p>{t.team.assignments[a.id].goal}</p>{t.team.assignments[a.id].summary&&<details><summary>交付证据</summary><pre>{t.team.assignments[a.id].summary}</pre></details>}</>}
      </div>)}</div>
      {t.pending!=null&&<Switch label="我已核对中断工具是否执行，允许恢复（不自动重放）" checked={ack[t.id]===true} onChange={(_,d)=>setAck(x=>({...x,[t.id]:d.checked}))}/>}
      <div className="models-actions"><Button disabled={busy||t.status!=='running'} onClick={()=>void control('pause',t)}>暂停</Button><Button disabled={busy||!['paused','awaiting-review'].includes(t.status)||(t.pending!=null&&!ack[t.id])} onClick={()=>void control('resume',t)}>恢复</Button><Button disabled={busy||t.status!=='awaiting-review'} onClick={()=>void control('accept',t)}>人工验收</Button><Button disabled={busy||!active(t)} onClick={()=>void control('cancel',t)}>取消任务</Button></div>
      {t.result&&<details><summary>提交结果</summary><pre>{t.result}</pre></details>}
    </section>)}
    <div className="agent-feed"><h3>实时协作流</h3>{!timeline.length&&<div className="agent-empty">尚无协作记录。上游调用默认模型组后，记录会自动出现；也可通过上方按钮手动发起任务。</div>}
      {timeline.map(e=>{const t=tasks.find(t=>t.id===e.taskId);return <article className={'agent-event '+(e.kind==='message'||e.kind==='review'?'agent-event-emphasis':'')} key={e.taskId+':'+e.seq}>
        <div className="agent-event-head"><strong>{agentLabel(t,e.agent)}</strong><span>{eventNames[e.kind]||e.kind}</span><small>{groupName(t)} · {e.taskId.slice(-8)} · {new Date(e.at).toLocaleTimeString()}</small></div>
        {typeof e.message==='string'&&<p>{e.to?'发送给 '+agentLabel(t,String(e.to))+'：':''}{e.message}</p>}
        {typeof e.content==='string'&&e.content&&<pre>{e.content}</pre>}
        {typeof e.reasoning==='string'&&e.reasoning&&<details open={e.kind==='inference-stream'}><summary>模型返回的思考内容</summary><pre>{e.reasoning}</pre></details>}
        {Object.entries(e).filter(([k,v])=>!['seq','at','agent','kind','taskId','step','content','reasoning','message','to'].includes(k)&&v!==null&&v!==undefined&&v!=='').map(([k,v])=><details key={k} open={['name','decision','summary','status','reasoningConfig','reasoningEvidence'].includes(k)}><summary>{({name:'工具',decision:'审查决定',summary:'摘要',reasoningConfig:'实际发送的思考参数',reasoningEvidence:'响应证据'} as Record<string,string>)[k]||k}</summary><pre>{typeof v==='string'?v:JSON.stringify(v,null,2)}</pre></details>)}
      </article>;})}
    </div>
    {createOpen&&<Dialog open={createOpen} onOpenChange={(_,d)=>setCreateOpen(d.open)}><DialogSurface className="agent-dialog"><DialogBody><DialogTitle>新建 Agent 任务（可选）</DialogTitle><DialogContent>
      <div className="models-editor">
        <Field label="工作区路径"><Input value={path} onChange={(_,d)=>setPath(d.value)} contentAfter={<Button size="small" onClick={async()=>{const p=await window.devspace.chooseFolder();if(p)setPath(p);}}>浏览</Button>}/></Field>
        <Field label="模型或模型组"><select className="op-select" value={target} onChange={e=>setTarget(e.target.value)}><option value="">默认模型组</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}{profiles.filter(p=>p.api==='chat'&&p.allowCalls).map(p=><option key={p.id} value={'model:'+p.id}>{profileLabel(p)}</option>)}</select></Field>
        <Field label="任务目标与验收条件"><Textarea value={instruction} rows={4} onChange={(_,d)=>setInstruction(d.value)}/></Field>
        <Button onClick={()=>setAdvanced(x=>!x)}>{advanced?'收起':'展开'}权限设置</Button>
        {advanced&&([['allowWrites','允许编辑文件'],['allowShell','允许 Shell（继承现有权限）'],['allowComputer','允许 Computer Use（需要桌面开关）'],['allowMemory','允许工作区记忆写入'],['allowPlugins','允许已授权插件调用']] as const).map(([id,label])=><Switch key={id} label={label} checked={permissions[id]} onChange={(_,d)=>setPermissions(x=>({...x,[id]:d.checked}))}/>)}
        <div className="models-actions"><Button appearance="primary" disabled={busy||!path.trim()||!instruction.trim()} onClick={()=>void start()}>启动任务</Button><Button onClick={()=>setCreateOpen(false)}>取消</Button></div>
      </div>
    </DialogContent></DialogBody></DialogSurface></Dialog>}
  </div>;
}
