import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Button,Dialog,DialogActions,DialogSurface,DialogBody,DialogTitle,DialogContent,Field,Input,Switch,Textarea} from '@fluentui/react-components';
import {DeleteRegular} from '@fluentui/react-icons';
import type {AgentEvent,AgentGroup,AgentTask,ModelProvider} from './api';
import {AgentFlow,appendFlowCards,agentStatuses,type FlowCard,type FlowLane} from './AgentFlow';

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

const isHistory = (task: AgentTask) => ['completed', 'failed', 'cancelled'].includes(task.status);
const historyDate = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : historyDate.format(date);
};
type TaskFilter = 'active' | 'history';
type HistoryAction = { task?: AgentTask };
type EventView = { taskId: string; cards: FlowCard[]; loading: boolean };
type ControlAction = 'pause' | 'resume' | 'accept' | 'cancel';
const runtimeError = (error: unknown) => errorText(error).replace(/^Error invoking remote method 'ds:agentRuntime': (?:Error: )?/, '');
const agentError = (error: unknown) => runtimeError(error) === 'AGENT_HISTORY_NOT_TERMINAL'
  ? '该任务仍在结束中，请稍后再删除。' : runtimeError(error).replace(/^AGENT_RUNTIME_UNAVAILABLE: /, '');

function rolesFor(task: AgentTask, id: string) {
  const roles = [];
  if (task.team?.leader === id) roles.push('协调者');
  if (task.team?.writer === id) roles.push('执行者');
  if (task.team?.reviewers.includes(id)) roles.push('审查者');
  return roles.join(' · ') || '协作成员';
}

function taskLanes(task: AgentTask, profiles: ModelProvider[]): FlowLane[] {
  return [{ id: '', name: 'Runtime', role: '运行时', tone: 'runtime' }, ...task.agents.map((agent): FlowLane => {
    const profile = profiles.find(item => item.id === agent.profileId);
    const name = profile ? profile.name + ' · ' + Math.round(profile.contextLength / 1024) + 'K · ' + agent.id : agent.id;
    const tone = task.team?.leader === agent.id ? 'lead' : task.team?.writer === agent.id
      ? 'execution' : task.team?.reviewers.includes(agent.id) ? 'review' : 'member';
    return { id: agent.id, name, role: rolesFor(task, agent.id), tone };
  })];
}

function TaskCard({ task, group, selected, busy, onSelect, onDelete }: {
  task: AgentTask; group: string; selected: boolean; busy: boolean; onSelect: () => void; onDelete: () => void;
}) {
  return <article className={'agent-task-card' + (selected ? ' is-selected' : '')} data-task-status={task.status}>
    <button type="button" className="agent-task-open" aria-pressed={selected} onClick={onSelect}>
      <span className="agent-task-label">
        <span className={'agent-task-badge is-' + task.status}>{agentStatuses[task.status] || task.status}</span>
        <span className="agent-task-group">{group}</span>
      </span>
      <strong className="agent-task-title" title={task.instruction}>{task.instruction}</strong>
      <span className="agent-task-meta"><time>{dateLabel(task.updatedAt || task.createdAt)}</time><span>{task.steps} 步</span></span>
    </button>
    {isHistory(task) && <Button size="small" appearance="subtle" className="agent-task-remove" disabled={busy}
      icon={<DeleteRegular />} aria-label={'删除历史任务 ' + task.instruction} title="删除历史任务" onClick={onDelete} />}
  </article>;
}

export function AgentRuntimePage() {
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [profiles, setProfiles] = useState<ModelProvider[]>([]);
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [tabPreference, setTabPreference] = useState<TaskFilter>();
  const [selectedId, setSelectedId] = useState<string>();
  const [eventView, setEventView] = useState<EventView>();
  const [historyAction, setHistoryAction] = useState<HistoryAction>();
  const [createOpen, setCreateOpen] = useState(false);
  const [path, setPath] = useState('');
  const [instruction, setInstruction] = useState('');
  const [target, setTarget] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [permissions, setPermissions] = useState({ allowWrites: false, allowShell: false, allowComputer: false, allowMemory: true, allowPlugins: false });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [serviceIssue, setServiceIssue] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState<Record<string, boolean>>({});
  const listRevision = useRef(0);

  const live = tasks.filter(task => !isHistory(task));
  const history = tasks.filter(isHistory);
  const pinned = tasks.find(task => task.id === selectedId);
  const tab = pinned ? (isHistory(pinned) ? 'history' : 'active') : tabPreference ?? (live.length ? 'active' : 'history');
  const items = tab === 'history' ? history : live;
  const task = pinned ?? (tab === 'active' ? items.find(item => item.status === 'running') : undefined) ?? items[0];
  const currentId = task?.id;
  const flow = eventView?.taskId === currentId ? eventView : undefined;
  const lanes = useMemo(() => task ? taskLanes(task, profiles) : [], [task, profiles]);

  useEffect(() => {
    let alive = true;
    void Promise.all([window.devspace.agentGroupsList(), window.devspace.modelProvidersList()])
      .then(([savedGroups, savedProfiles]) => {
        if (alive) { setGroups(savedGroups); setProfiles(savedProfiles); }
      }).catch(error => { if (alive) setError(agentError(error)); });
    return () => { alive = false; };
  }, []);

  const refresh = useCallback(async () => {
    const revision = ++listRevision.current;
    const next = await window.devspace.agentRuntime('list') as AgentTask[];
    if (revision === listRevision.current) {
      setTasks(next);
      setConnected(true);
      setServiceIssue('');
    }
  }, []);
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try { await refresh(); }
      catch (error) {
        if (alive) {
          setConnected(false);
          setServiceIssue(agentError(error));
        }
      }
      finally { inFlight = false; }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1500);
    return () => { alive = false; ++listRevision.current; window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    if (!currentId) return;
    let alive = true;
    let inFlight = false;
    let after = 0;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        let batch: AgentEvent[];
        do {
          batch = await window.devspace.agentRuntime('events', { taskId: currentId, after }) as AgentEvent[];
          if (!alive) return;
          if (batch.length) after = batch[batch.length - 1].seq;
          const events = batch;
          setEventView(previous => {
            if (!events.length && previous?.taskId === currentId && !previous.loading) return previous;
            return {
              taskId: currentId,
              cards: appendFlowCards(previous?.taskId === currentId ? previous.cards : [], events),
              loading: events.length === 200,
            };
          });
        } while (batch.length === 200);
      } catch (error) {
        const message = runtimeError(error);
        if (alive && message !== 'UNKNOWN_AGENT_TASK' && !message.startsWith('AGENT_RUNTIME_UNAVAILABLE:')) setError(agentError(error));
      } finally { inFlight = false; }
    };
    setEventView({ taskId: currentId, cards: [], loading: true });
    void tick();
    const timer = window.setInterval(() => void tick(), 1500);
    return () => { alive = false; window.clearInterval(timer); };
  }, [currentId]);

  async function start() {
    setBusy(true);
    try {
      const chosen = target.startsWith('model:') ? { modelId: target.slice(6) } : target ? { groupId: target } : {};
      const created = await window.devspace.agentRuntime('start', { input: { path, instruction, ...chosen, ...permissions } }) as AgentTask;
      setSelectedId(created.id);
      setTabPreference('active');
      setCreateOpen(false);
      setInstruction('');
      setNotice('');
      setError('');
      await refresh();
    } catch (error) { setError(agentError(error)); }
    finally { setBusy(false); }
  }

  async function control(action: ControlAction, targetTask: AgentTask) {
    setBusy(true);
    try {
      const updated = await window.devspace.agentRuntime(action, { taskId: targetTask.id, acknowledge: ack[targetTask.id] === true }) as AgentTask;
      setSelectedId(updated.id);
      setTasks(items => items.map(item => item.id === updated.id ? updated : item));
      setError('');
      await refresh();
    } catch (error) { setError(agentError(error)); }
    finally { setBusy(false); }
  }

  async function removeHistory(selection: HistoryAction) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { deletedIds } = await window.devspace.agentRuntime(
        selection.task ? 'delete-history' : 'clear-history', selection.task ? { taskId: selection.task.id } : {}
      ) as { deletedIds: string[] };
      ++listRevision.current;
      const removed = new Set(deletedIds);
      setTasks(items => items.filter(item => !removed.has(item.id)));
      setSelectedId(id => id && removed.has(id) ? undefined : id);
      setEventView(state => state && removed.has(state.taskId) ? undefined : state);
      setTabPreference('history');
      setHistoryAction(undefined);
      if (deletedIds.length) setNotice('已删除 ' + deletedIds.length + ' 条历史流程');
      await refresh();
    } catch (error) {
      setHistoryAction(undefined);
      setError(agentError(error));
    } finally { setBusy(false); }
  }

  const groupName = (item: AgentTask) => groups.find(group => group.id === item.groupId)?.name
    || (item.groupId ? '模型组' : '单 Agent');
  function selectTab(next: TaskFilter) {
    setSelectedId(undefined);
    setTabPreference(next);
    setNotice('');
  }

  return <div className="panel models-page agent-workbench">
    <div className="section-heading"><div><h2>Agent 协作</h2></div>
      <Button appearance="primary" disabled={!connected} onClick={() => setCreateOpen(true)}>新建任务</Button>
    </div>
    {error && <div className="op-message op-error" role="alert">{error}</div>}
    {notice && <div className="op-message op-success" role="status">{notice}</div>}
    {serviceIssue && <div className="op-message op-error" role="status">{serviceIssue}</div>}
    {!connected && !serviceIssue && <div className="agent-empty">正在连接 Agent Runtime</div>}
    {connected && <section className="agent-task-library" aria-label="任务列表">
      <div className="agent-library-bar">
        <div className="agent-task-tabs" aria-label="任务范围">
          <button type="button" aria-pressed={tab === 'active'} onClick={() => selectTab('active')}>进行中 <span>{live.length}</span></button>
          <button type="button" aria-pressed={tab === 'history'} onClick={() => selectTab('history')}>历史任务 <span>{history.length}</span></button>
        </div>
        {tab === 'history' && history.length > 0 && <Button appearance="subtle" size="small" icon={<DeleteRegular />}
          disabled={busy} onClick={() => setHistoryAction({})}>清空历史</Button>}
      </div>
      {items.length ? <div className="agent-task-grid">
        {items.map(item => <TaskCard key={item.id} task={item} group={groupName(item)} selected={item.id === currentId}
          busy={busy} onSelect={() => setSelectedId(item.id)} onDelete={() => setHistoryAction({ task: item })} />)}
      </div> : <div className="agent-empty">{tab === 'history' ? '暂无历史任务' : '暂无进行中的任务'}</div>}
    </section>}
    {connected && task && <>
      <section className="agent-task-detail" aria-label="所选任务">
        <div className="agent-work-title">
          <div><h3>{task.instruction}</h3>
            <div className="agent-work-meta">{groupName(task)} · {agentStatuses[task.status] || task.status}
              {task.team && ' · ' + (agentStatuses[task.team.phase] || task.team.phase)}
              {' · ' + task.steps + ' 步'}</div>
          </div>
          {!isHistory(task) && <div className="agent-work-actions">
            {task.status === 'running' && <Button size="small" disabled={busy} onClick={() => void control('pause', task)}>暂停</Button>}
            {['paused', 'awaiting-review'].includes(task.status) && <Button size="small" disabled={busy || (task.pending != null && !ack[task.id])}
              onClick={() => void control('resume', task)}>恢复</Button>}
            {task.status === 'awaiting-review' && <Button size="small" disabled={busy} onClick={() => void control('accept', task)}>人工验收</Button>}
            <Button size="small" disabled={busy} onClick={() => void control('cancel', task)}>取消任务</Button>
          </div>}
        </div>
        {task.error && <div className="op-message op-error">{task.error}</div>}
        {task.pending != null && !isHistory(task) && <Switch label="已核对中断工具是否执行，允许恢复"
          checked={ack[task.id] === true} onChange={(_, data) => setAck(state => ({ ...state, [task.id]: data.checked }))} />}
        <details className="agent-task-extra">
          <summary>成员用量与分工</summary>
          <div className="agent-roster">{task.agents.map(agent => {
            const lane = lanes.find(item => item.id === agent.id);
            const work = task.team?.assignments[agent.id];
            return <div key={agent.id}>
              <strong>{lane?.name || agent.id}</strong><small>{lane?.role} · {agentStatuses[agent.state] || agent.state}</small>
              {agent.groupPaths?.length ? <small>{agent.groupPaths.map(parts => parts.join(' / ')).join('；')}</small> : null}
              <small>{agent.steps} 步 · 上下文约 {agent.contextEstimate.toLocaleString()}</small>
              <small>{agent.inputTokens || agent.outputTokens ? '输入 ' + agent.inputTokens.toLocaleString() +
                ' / 输出 ' + agent.outputTokens.toLocaleString() : '暂无服务端用量'}</small>
              {work && <><small>{agentStatuses[work.status] || work.status}{work.dependsOn.length ? ' · 依赖 ' + work.dependsOn.join(', ') : ''}</small>
                <p>{work.goal}</p>{work.summary && <details><summary>交付证据</summary><pre>{work.summary}</pre></details>}</>}
            </div>;
          })}</div>
        </details>
        {task.result && <details className="agent-task-extra"><summary>任务结果</summary><pre>{task.result}</pre></details>}
      </section>
      <section className="agent-feed" aria-label="协作流程">
        <div className="agent-feed-heading"><h3>协作流程</h3><span>{flow?.loading ? '正在加载记录' : (flow?.cards.length ?? 0) + ' 个节点'}</span></div>
        {flow?.cards.length ? <AgentFlow key={task.id} lanes={lanes} cards={flow.cards} />
          : <div className="agent-empty">{!flow || flow.loading ? '正在读取流程' : '暂无流程记录'}</div>}
      </section>
    </>}
    {historyAction && <Dialog open onOpenChange={(_, data) => { if (!data.open && !busy) setHistoryAction(undefined); }}>
      <DialogSurface className="agent-history-dialog"><DialogBody>
        <DialogTitle>{historyAction.task ? '删除这条历史流程？' : '清空历史流程？'}</DialogTitle>
        <DialogContent>
          {historyAction.task && <p className="agent-history-task">{historyAction.task.instruction}</p>}
          <p>将永久删除{historyAction.task ? '这条任务的' : '已结束任务的'}记录和流程详情。</p>
          {!historyAction.task && <p>进行中、已暂停与等待验收的任务会保留。</p>}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setHistoryAction(undefined)}>返回</Button>
          <Button appearance="primary" className="agent-confirm-remove" disabled={busy} onClick={() => void removeHistory(historyAction)}>
            {historyAction.task ? '删除历史' : '清空历史'}
          </Button>
        </DialogActions>
      </DialogBody></DialogSurface>
    </Dialog>}
    {createOpen && <Dialog open={createOpen} onOpenChange={(_, data) => setCreateOpen(data.open)}>
      <DialogSurface className="agent-dialog"><DialogBody><DialogTitle>新建 Agent 任务</DialogTitle><DialogContent>
        <div className="models-editor">
          <Field label="工作区路径"><Input value={path} onChange={(_, data) => setPath(data.value)}
            contentAfter={<Button size="small" onClick={async () => { const chosen = await window.devspace.chooseFolder(); if (chosen) setPath(chosen); }}>浏览</Button>} /></Field>
          <Field label="模型或模型组"><select className="op-select" value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">默认模型组</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            {profiles.filter(profile => profile.api === 'chat' && profile.allowCalls).map(profile =>
              <option key={profile.id} value={'model:' + profile.id}>{profileLabel(profile)}</option>)}</select></Field>
          <Field label="任务目标与验收条件"><Textarea value={instruction} rows={4} onChange={(_, data) => setInstruction(data.value)} /></Field>
          <Button onClick={() => setAdvanced(value => !value)}>{advanced ? '收起' : '展开'}权限设置</Button>
          {advanced && ([['allowWrites', '允许编辑文件'], ['allowShell', '允许 Shell（继承现有权限）'],
            ['allowComputer', '允许 Computer Use（需要桌面开关）'], ['allowMemory', '允许工作区记忆写入'],
            ['allowPlugins', '允许已授权插件调用']] as const).map(([id, label]) => <Switch key={id} label={label} checked={permissions[id]}
              onChange={(_, data) => setPermissions(state => ({ ...state, [id]: data.checked }))} />)}
          <div className="models-actions"><Button appearance="primary" disabled={busy || !path.trim() || !instruction.trim()}
            onClick={() => void start()}>启动任务</Button><Button onClick={() => setCreateOpen(false)}>取消</Button></div>
        </div>
      </DialogContent></DialogBody></DialogSurface>
    </Dialog>}
  </div>;
}
