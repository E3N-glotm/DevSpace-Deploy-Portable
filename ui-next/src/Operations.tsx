import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Field, Input, Switch, Textarea } from '@fluentui/react-components';

type Item = Record<string,any>;
type ApiAction = (action:string,payload?:Record<string,unknown>,confirm?:boolean)=>Promise<any>;
const asItems = (data:any, ...keys:string[]):Item[] => {
  for (const key of keys) if(Array.isArray(data?.[key])) return data[key];
  if(Array.isArray(data)) return data;
  return [];
};
const value = (item:Item|null,key:string) => String(item?.[key] ?? '');
const explain = (error:unknown) => error instanceof Error ? error.message : String(error);
const simple = (data:any) => <pre className="operation-output">{JSON.stringify(data,null,2)}</pre>;
const titleFor = (item:Item, ...keys:string[]) => keys.map(k=>String(item?.[k]??'')).find(Boolean)||'未命名';

function useBackend(listAction:string,payload:Record<string,unknown>={}) {
  const [data,setData]=useState<any>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [result,setResult]=useState<any>(null);
  const load=useCallback(async()=>{
    setBusy(true);setError('');
    try{setData(await window.devspace.admin(listAction,payload));}
    catch(e){setError(explain(e));}
    finally{setBusy(false);}
  },[listAction,JSON.stringify(payload)]);
  useEffect(()=>{void load();},[load]);
  const call:ApiAction=useCallback(async(action,p={},confirm=false)=>{
    setError('');setNotice('');
    if(confirm&&!window.confirm('请确认执行此操作。此操作可能修改现有数据、撤销凭据或终止正在运行的任务。'))return null;
    setBusy(true);
    try{
      const data=await window.devspace.admin(action,p,confirm);
      setResult(data);
      setNotice('操作已完成。');
      if(action!==listAction)await load();
      return data;
    }catch(e){setError(explain(e));return null;}
    finally{setBusy(false);}
  },[listAction,load]);
  return {data,busy,error,notice,result,load,call};
}
function Message({error,notice}:{error:string;notice:string}) {
  return <>{error&&<div role="alert" className="op-message op-error">{error}</div>}
    {notice&&<div role="status" className="op-message op-success">{notice}</div>}</>;
}
function Panel({title,caption,children}:{title:string;caption?:string;children:React.ReactNode}) {
  return <section className="panel operations-panel"><div className="section-heading"><div><h2>{title}</h2>{caption&&<p>{caption}</p>}</div></div>{children}</section>;
}
function Selection({items,selected,onSelect,getId,describe}:{
  items:Item[];selected:string;onSelect:(id:string)=>void;getId:(i:Item)=>string;describe:(i:Item)=>React.ReactNode;
}) {
  return <div className="op-list" role="listbox" aria-label="选择记录">
    {items.length===0&&<div className="op-empty">暂无记录</div>}
    {items.map((item,index)=>{
      const id=getId(item)||String(index);
      return <button type="button" role="option" aria-selected={selected===id}
        key={id} className={'op-item '+(selected===id?'selected':'')}
        onClick={()=>onSelect(id)}>{describe(item)}</button>;
    })}
  </div>;
}
function TextControl({label,value,onChange,placeholder,required=false}:{
  label:string;value:string;onChange:(v:string)=>void;placeholder?:string;required?:boolean;
}) {
  return <Field label={label} required={required}><Input value={value} placeholder={placeholder}
    onChange={(_e,d)=>onChange(d.value)} /></Field>;
}
function ActionRow({children}:{children:React.ReactNode}) {
  return <div className="op-actions">{children}</div>;
}

export function AgentsPage() {
  const b=useBackend('remote-agent-list');
  const agents=asItems(b.data,'agents');
  const [selected,setSelected]=useState('');
  const agent=agents.find(x=>String(x.id)===selected)||null;
  const [name,setName]=useState('');
  const [installRoot,setInstallRoot]=useState('');
  const [roots,setRoots]=useState('');
  const [full,setFull]=useState(false);
  const [command,setCommand]=useState('');
  const prepare=(id:string)=>{
    const item=agents.find(x=>String(x.id)===id);
    setSelected(id);setName(value(item||null,'name'));setInstallRoot(value(item||null,'installRoot'));
    setRoots(Array.isArray(item?.writableRoots)?item.writableRoots.join('\n'):'');
    setFull(item?.accessMode==='full-access');setCommand('');
  };
  async function enroll(){
    if(!name.trim()||!installRoot.trim()||(!full&&!roots.trim()))return;
    const response=await b.call('remote-agent-create-enrollment',{
      agentId:selected,name:name.trim(),installRoot:installRoot.trim(),
      accessMode:full?'full-access':'scoped',
      writableRoots:full?[]:roots.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),
      ttlMinutes:15,
    });
    setCommand(String(response?.installCommand||''));
  }
  return <Panel title="远程服务器" caption="登记、重新配对和管理 Linux Agent；生成的安装命令仅在明确操作后显示。">
    <ActionRow><Button appearance="primary" onClick={()=>prepare('')} disabled={b.busy}>添加服务器</Button>
      <Button onClick={b.load} disabled={b.busy}>刷新状态</Button></ActionRow>
    <Message error={b.error} notice={b.notice}/>
    <div className="op-columns">
      <Selection items={agents} selected={selected} onSelect={prepare} getId={a=>String(a.id||'')}
        describe={a=><><strong>{titleFor(a,'name','hostname','id')}</strong>
          <small>{a.status||'未知'} · {a.hostname||a.id} · {a.agentVersion||'版本未知'}</small>
          <span className="op-subtle">{a.accessMode||'scoped'} · {a.installRoot||'尚未配置安装目录'}</span></>}/>
      <div className="op-editor">
        <h3>{selected?'更新或撤销服务器':'添加服务器'}</h3>
        <div className="op-form">
          <TextControl label="服务器显示名称" value={name} onChange={setName} required/>
          <TextControl label="Linux Agent 安装目录" value={installRoot} onChange={setInstallRoot} placeholder="/home/user/devspace-agent" required/>
          <div className="op-toggle"><div><strong>完全访问</strong><small>关闭时只开放下方明确填写的 Linux 可写目录。</small></div>
            <Switch checked={full} onChange={(_e,d)=>setFull(d.checked)}/></div>
          {!full&&<Field label="允许写入的 Linux 目录（每行一个）"><Textarea rows={3} value={roots} onChange={(_e,d)=>setRoots(d.value)}/></Field>}
          <ActionRow><Button appearance="primary" disabled={b.busy||!name.trim()||!installRoot.trim()||(!full&&!roots.trim())} onClick={enroll}>{selected?'重新生成配对命令':'生成一次性安装命令'}</Button>
            {selected&&<Button disabled={b.busy} onClick={()=>b.call('remote-agent-revoke',{agentId:selected},true)}>撤销 Agent 凭据</Button>}
            {selected&&<Button disabled={b.busy} onClick={async()=>{if(await b.call('remote-agent-delete',{agentId:selected},true))prepare('');}}>删除记录</Button>}</ActionRow>
          {command&&<div className="op-command"><strong>15 分钟内有效的安装命令</strong><code>{command}</code>
            <Button onClick={()=>window.devspace.copyValue(command)}>复制安装命令</Button></div>}
        </div>
      </div>
    </div>
    <RemoteSshPanel agentId={selected} agentName={name} installRoot={installRoot}
      roots={roots.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)} full={full} onUpdate={b.load}/>
  </Panel>;
}

function RemoteSshPanel({agentId,agentName,installRoot,roots,full,onUpdate}:{
  agentId:string;agentName:string;installRoot:string;roots:string[];
  full:boolean;onUpdate:()=>Promise<void>;
}) {
  const b=useBackend('remote-ssh-list');
  const profiles=asItems(b.data,'profiles');
  const key=agentId||('name:'+agentName.trim());
  const profile=profiles.find(p=>String(p.key||'').toLowerCase()===key.toLowerCase())||
    profiles.find(p=>String(p.key||'').toLowerCase()===('name:'+agentName.trim()).toLowerCase())||null;
  const [host,setHost]=useState('');
  const [port,setPort]=useState('22');
  const [userName,setUserName]=useState('ubuntu');
  const [password,setPassword]=useState('');
  const [autoRecover,setAutoRecover]=useState(true);
  const [output,setOutput]=useState('');
  useEffect(()=>{
    setHost(value(profile,'host'));
    setPort(value(profile,'port')||'22');
    setUserName(value(profile,'userName')||'ubuntu');
    setAutoRecover(profile?.autoRecover!==false);
    setPassword('');setOutput('');
  },[key,profile?.key,profile?.host,profile?.port,profile?.userName,profile?.autoRecover]);
  const save=async()=>{
    if(!key||!host.trim()||!userName.trim()||!port.trim())return false;
    const result=await b.call('remote-ssh-save',{
      key,host:host.trim(),port:Number(port),userName:userName.trim(),autoRecover,
      ...(password?{password}:{}),
    });
    if(result){setPassword('');return true;}
    return false;
  };
  const manage=async(action:'remote-ssh-test'|'remote-ssh-deploy'|'remote-ssh-recover')=>{
    const saved=await save();
    if(!saved)return;
    const response=await b.call(action,{
      key,agentId, name:agentName.trim(),installRoot:installRoot.trim(),
      accessMode:full?'full-access':'scoped',writableRoots:full?[]:roots,
    },action!=='remote-ssh-test');
    if(response){setOutput(String(response.output||response.agent?.status||'操作完成'));
      if(action!=='remote-ssh-test')await onUpdate();}
  };
  return <div className="op-subsection">
    <Panel title="SSH 一键部署与救援" caption="与旧界面兼容的 SSH 配置保存在相同的数据文件中；现有密码使用当前 Windows 用户 DPAPI 加密，不向前端回显。">
      <Message error={b.error} notice={b.notice}/>
      <p className="op-subtle">先选择上方已有 Agent 或输入新服务器名称；SSH 凭据单独保存，不会因更改工作区配置而清除。</p>
      <div className="form-grid">
        <TextControl label="服务器 IP / 主机名" value={host} onChange={setHost} placeholder="gpu.example.com"/>
        <TextControl label="SSH 端口" value={port} onChange={setPort} placeholder="22"/>
        <TextControl label="SSH 用户名" value={userName} onChange={setUserName}/>
        <Field label={profile?.hasPassword?'SSH 密码（已配置 · ••••••••，留空保留）':'SSH 密码（可不填，使用密钥登录）'}>
          <Input type="password" autoComplete="new-password" value={password} onChange={(_e,d)=>setPassword(d.value)}
            placeholder={profile?.hasPassword?'••••••••（留空保留）':'密码或使用 SSH 密钥'}/></Field>
      </div>
      <div className="op-toggle"><div><strong>离线 Agent SSH 救援配置</strong>
        <small>保存是否允许救援；目前仅在明确点击操作后执行 SSH，不会静默重装远程 Agent。</small></div>
        <Switch checked={autoRecover} onChange={(_e,d)=>setAutoRecover(d.checked)}/></div>
      <ActionRow><Button appearance="primary" disabled={b.busy||!key||!host.trim()} onClick={save}>保存 SSH 配置</Button>
        <Button disabled={b.busy||!key||!host.trim()} onClick={()=>manage('remote-ssh-test')}>测试 SSH</Button>
        <Button disabled={b.busy||!key||!host.trim()||!agentName.trim()||!installRoot.trim()||(!full&&!roots.length)}
          onClick={()=>manage('remote-ssh-deploy')}>{agentId?'通过 SSH 更新 Agent':'通过 SSH 安装 Agent'}</Button>
        {agentId&&<Button disabled={b.busy||!profile} onClick={()=>manage('remote-ssh-recover')}>
          SSH 一键恢复离线 Agent</Button>}
        {profile&&<Button disabled={b.busy} onClick={async()=>{
          if(await b.call('remote-ssh-delete',{key:profile.key},true))setOutput('已删除 SSH 配置');
        }}>删除 SSH 凭据</Button>}</ActionRow>
      {output&&<div role="status" className="op-message op-success">{output}</div>}
    </Panel>
  </div>;
}

export function PluginsPage() {
  const b=useBackend('plugin-list');
  const plugins=asItems(b.data,'plugins');
  const slots=asItems(b.data,'slots');
  const [selected,setSelected]=useState('');
  const [version,setVersion]=useState('');
  const [slot,setSlot]=useState('1');
  const [tool,setTool]=useState('');
  const item=plugins.find(p=>String(p.id)===selected)||null;
  const versions=asItems(item,'versions');
  const tools=asItems(item,'dispatchTools');
  const act=async(action:string,payload:Record<string,unknown>,confirm=false)=>{await b.call(action,payload,confirm);};
  return <Panel title="插件与工具槽位" caption="插件安装、启停、导出、卸载以及工具槽位绑定均在新版窗口中完成。">
    <ActionRow><Button appearance="primary" disabled={b.busy} onClick={async()=>{
      const sourcePath=await window.devspace.pickPlugin();
      if(sourcePath)await act('plugin-install',{sourcePath,replace:false});
    }}>安装插件</Button><Button onClick={()=>b.call('plugin-refresh')} disabled={b.busy}>刷新插件目录</Button>
      <Button onClick={b.load} disabled={b.busy}>刷新列表</Button></ActionRow>
    <Message error={b.error} notice={b.notice}/>
    <div className="op-columns">
      <Selection items={plugins} selected={selected} getId={p=>String(p.id||'')}
        onSelect={id=>{setSelected(id);setVersion('');setTool('');}}
        describe={p=><><strong>{titleFor(p,'name','id')}</strong>
          <small>{p.enabled?'已启用':'已禁用'} · {p.selectedVersion||'无版本'} · {p.dependencyStatus?.status||''}</small>
          <span className="op-subtle">{p.id}</span></>}/>
      <div className="op-editor">
        {item?<><h3>{titleFor(item,'name','id')}</h3>
          <div className="op-form"><Field label="插件版本"><select className="op-select" value={version||item.selectedVersion||''} onChange={e=>setVersion(e.target.value)}>
            {versions.map(v=><option key={String(v.version)} value={String(v.version)}>{String(v.version)}</option>)}</select></Field>
            <ActionRow><Button disabled={b.busy} appearance="primary" onClick={()=>act('plugin-enable',{pluginId:selected,version:version||item.selectedVersion})}>启用</Button>
              <Button disabled={b.busy} onClick={()=>act('plugin-disable',{pluginId:selected})}>禁用</Button>
              <Button disabled={b.busy} onClick={async()=>{
                const destinationPath=await window.devspace.pickExport(selected+'-'+(version||item.selectedVersion)+'.zip');
                if(destinationPath)await act('plugin-export',{pluginId:selected,version:version||item.selectedVersion,destinationPath});
              }}>导出 ZIP</Button>
              <Button disabled={b.busy} onClick={()=>act('plugin-uninstall',{pluginId:selected,version:version||item.selectedVersion},true)}>卸载此版本</Button>
              <Button disabled={b.busy} onClick={()=>act('plugin-uninstall',{pluginId:selected},true)}>卸载全部版本</Button></ActionRow>
            <h3>工具槽位绑定</h3>
            <Field label="槽位"><select className="op-select" value={slot} onChange={e=>setSlot(e.target.value)}>
              {slots.map(s=><option key={String(s.slot)} value={String(s.slot)}>{s.slot} · {s.name||'未命名'}</option>)}</select></Field>
            <Field label="插件工具"><select className="op-select" value={tool} onChange={e=>setTool(e.target.value)}>
              <option value="">请选择工具</option>{tools.map(t=><option key={String(t.name)} value={String(t.name)}>{t.name}</option>)}</select></Field>
            <ActionRow><Button disabled={b.busy||!tool} onClick={()=>act('plugin-slot-bind',{slot:Number(slot),pluginId:selected,toolName:tool})}>绑定工具</Button>
              <Button disabled={b.busy} onClick={()=>act('plugin-slot-unbind',{slot:Number(slot)})}>解除绑定</Button></ActionRow>
          </div></>:<div className="op-empty">选择左侧插件以查看版本与管理操作。</div>}
      </div>
    </div>
    <div className="op-subsection"><h3>当前槽位</h3><div className="op-cards">
      {slots.map(s=><div className="op-tile" key={String(s.slot)}><strong>{s.slot} · {s.name}</strong>
        <small>{s.bound?s.pluginId+' / '+s.toolName:'未绑定'} · {s.status||''}</small></div>)}</div></div>
  </Panel>;
}

export function ContinuationsPage() {
  const [includeTerminal,setIncludeTerminal]=useState(false);
  const request=useMemo(()=>({includeTerminal,limit:300}),[includeTerminal]);
  const b=useBackend('continuation-list',request);
  const tasks=asItems(b.data,'tasks');
  const [selected,setSelected]=useState<string[]>([]);
  const [minutes,setMinutes]=useState('');
  const [locked,setLocked]=useState(false);
  const [estimating,setEstimating]=useState(false);
  const [estimate,setEstimate]=useState<any>(null);
  const toggle=(id:string,checked:boolean)=>setSelected(old=>checked?[...new Set([...old,id])]:old.filter(x=>x!==id));
  const run=async(action:string,confirm=false)=>{
    if(!selected.length)return;
    const result=await b.call(action,{taskIds:selected},confirm);
    if(result&&action==='continuation-delete')setSelected([]);
  };
  return <Panel title="自动续轮任务" caption="支持任务选择、暂停、恢复、锁定、解锁、结束与删除；这些控制直接使用现有续轮数据库和管理协议。">
    <ActionRow><Button onClick={b.load} disabled={b.busy}>刷新任务</Button>
      <Checkbox checked={includeTerminal} onChange={(_e,d)=>setIncludeTerminal(Boolean(d.checked))} label="包含已结束任务"/>
      <Button onClick={()=>setSelected(tasks.map(t=>String(t.id)))}>全选当前结果</Button>
      <span className="op-subtle">已选 {selected.length} 项</span></ActionRow>
    <Message error={b.error} notice={b.notice}/>
    <div className="op-task-actions">
      <Button disabled={b.busy||!selected.length} onClick={()=>run('continuation-pause')}>暂停</Button>
      <Button disabled={b.busy||!selected.length} onClick={()=>run('continuation-resume')}>恢复</Button>
      <Button disabled={b.busy||!selected.length} onClick={()=>run('continuation-lock')}>锁定</Button>
      <Button disabled={b.busy||!selected.length} onClick={()=>run('continuation-unlock')}>解锁</Button>
      <Button disabled={b.busy||!selected.length} onClick={()=>run('continuation-stop',true)}>手动结束</Button>
      <Button disabled={b.busy||!selected.length} onClick={()=>run('continuation-delete',true)}>删除记录</Button>
    </div>
    <div className="op-tasks">{tasks.map(t=>{
      const id=String(t.id||'');
      return <label className="op-task" key={id}><input type="checkbox" checked={selected.includes(id)}
        onChange={e=>toggle(id,e.target.checked)}/>
        <div><strong>{t.objective||t.title||id}</strong>
          <small>{t.state||'未知状态'} · {t.progressCompleted??0}/{t.progressRequired??0} 里程碑 · 续轮 {t.continuationCount??0}/{t.maxContinuations??'—'} · {t.updatedAt||''}</small></div></label>;
    })}{!tasks.length&&<div className="op-empty">没有符合条件的续轮任务。</div>}</div>
    <div className="op-subsection"><h3>Host 截断时间预估</h3>
      <p className="help">该设置仅供界面展示，不控制 ChatGPT 实际时长，也不会改动自动续轮阈值。</p>
      <ActionRow><Button disabled={estimating} onClick={async()=>{setEstimating(true);try{setEstimate(await window.devspace.admin('continuation-cutoff-estimate-get',{}));}finally{setEstimating(false);}}}>读取历史预估</Button>
        <Input type="number" value={minutes} onChange={(_e,d)=>setMinutes(d.value)} placeholder="分钟"/>
        <Checkbox checked={locked} label="锁定预估值" onChange={(_e,d)=>setLocked(Boolean(d.checked))}/>
        <Button disabled={!minutes||b.busy} onClick={()=>b.call('continuation-cutoff-estimate-set',{minutes:Number(minutes),locked})}>保存预估</Button></ActionRow>
      {estimate&&simple(estimate)}
    </div>
  </Panel>;
}

export function SessionsPage() {
  const [query,setQuery]=useState('');
  const [includeHidden,setIncludeHidden]=useState(false);
  const [includeArchived,setIncludeArchived]=useState(false);
  const b=useBackend('review-list',{limit:200,includeHidden,includeArchived});
  const sessions=asItems(b.data,'sessions','reviews');
  const filtered=sessions.filter(s=>JSON.stringify([s.title,s.sessionId,s.workspaceRoot,s.status]).toLowerCase().includes(query.toLowerCase()));
  const [selected,setSelected]=useState('');
  const [details,setDetails]=useState<any>(null);
  const [rename,setRename]=useState('');
  const [confirmation,setConfirmation]=useState('');
  const [snapshot,setSnapshot]=useState('');
  const [filePath,setFilePath]=useState('');
  const current=sessions.find(s=>String(s.sessionId||s.id)===selected)||null;
  const choose=async(id:string)=>{
    setSelected(id);setDetails(null);setConfirmation('');setSnapshot('');setFilePath('');
    const item=sessions.find(s=>String(s.sessionId||s.id)===id);
    setRename(value(item||null,'title'));
    try{
      const response=await window.devspace.admin('review-details',{sessionId:id});
      setDetails(response);
      setFilePath(String(response?.files?.[0]?.path||''));
      setSnapshot(String(response?.safetySnapshots?.[0]?.id||''));
    }
    catch(e){setDetails({error:explain(e)});}
  };
  const update=(p:Record<string,unknown>)=>b.call('review-update',{sessionId:selected,...p});
  return <Panel title="会话与改动审阅" caption="查看文件差异、重命名与归档；回退采用服务端已有的安全快照机制。">
    <ActionRow><Input value={query} onChange={(_e,d)=>setQuery(d.value)} placeholder="搜索会话或工作目录"/>
      <Checkbox checked={includeHidden} label="显示隐藏" onChange={(_e,d)=>setIncludeHidden(Boolean(d.checked))}/>
      <Checkbox checked={includeArchived} label="显示归档" onChange={(_e,d)=>setIncludeArchived(Boolean(d.checked))}/>
      <Button disabled={b.busy} onClick={b.load}>刷新</Button></ActionRow>
    <Message error={b.error} notice={b.notice}/>
    <div className="op-columns">
      <Selection items={filtered} selected={selected} onSelect={choose} getId={s=>String(s.sessionId||s.id||'')}
        describe={s=><><strong>{titleFor(s,'title','sessionId','id')}</strong>
          <small>{s.status||''} · {s.updatedAt||s.createdAt||''}</small>
          <span className="op-subtle">{s.workspaceRoot||''}</span></>}/>
      <div className="op-editor">
        {current?<><h3>会话管理</h3><TextControl label="会话标题" value={rename} onChange={setRename}/>
          <ActionRow><Button disabled={b.busy} onClick={()=>update({title:rename.trim()})}>保存标题</Button>
            <Button disabled={b.busy} onClick={()=>update({pinned:!current.pinned})}>{current.pinned?'取消置顶':'置顶'}</Button>
            <Button disabled={b.busy} onClick={()=>update({hidden:!current.hidden})}>{current.hidden?'显示':'隐藏'}</Button>
            <Button disabled={b.busy} onClick={()=>update({status:current.status==='archived'?'active':'archived'})}>{current.status==='archived'?'恢复归档':'归档'}</Button></ActionRow>
          <div className="op-subsection"><h3>本轮修改与差异</h3>
            {details?.error?<div role="alert" className="op-error">{details.error}</div>:<>
              <p className="op-subtle">文件 {details?.summary?.files??0} 个 · 新增 {details?.summary?.additions??0} 行 · 删除 {details?.summary?.removals??0} 行 · {details?.canRollback?'支持安全回退':'当前不可回退'}</p>
              <div className="op-files">{asItems(details,'files').map(f=><button key={String(f.path)}
                className={'op-file '+(filePath===String(f.path)?'active':'')} onClick={()=>setFilePath(String(f.path))}>
                <span>{f.path}</span><small>+{f.additions??0} −{f.removals??0}</small></button>)}</div>
              <FilePatch patch={String(details?.patch||'')} filePath={filePath}/>
            </>}
            <ActionRow><Button onClick={()=>choose(selected)}>刷新详情</Button></ActionRow>
          </div>
          <div className="op-danger"><h3>回退与恢复</h3>
            <p>回退会修改项目文件，执行前服务端会保留安全快照。远程 Agent 会话应通过已认证的在线 MCP 回退，本地管理界面不会绕过 Agent 身份验证。</p>
            <TextControl label="输入 ROLLBACK 确认回退" value={confirmation} onChange={setConfirmation} placeholder="ROLLBACK"/>
            <ActionRow><Button disabled={b.busy||confirmation!=='ROLLBACK'||!details?.canRollback||
              details?.session?.executionBackend==='remote-agent'} onClick={async()=>{
              const r=await b.call('review-rollback',{sessionId:selected,confirmation:details?.confirmationToken},true);
              if(r)await choose(selected);
            }}>回退此次修改</Button></ActionRow>
            <Field label="回退前安全快照"><select className="op-select" value={snapshot} onChange={e=>setSnapshot(e.target.value)}>
              <option value="">选择快照</option>{asItems(details,'safetySnapshots').map(s=>
                <option key={String(s.id)} value={String(s.id)}>{s.id} · {s.createdAt||''}</option>)}</select></Field>
            <Button disabled={b.busy||!snapshot||details?.session?.executionBackend==='remote-agent'} onClick={async()=>{
              const r=await b.call('review-restore-safety',{
              sessionId:selected,snapshotId:snapshot,confirmation:'RESTORE '+snapshot,
            },true);if(r)await choose(selected);
            }}>恢复回退前快照</Button>
          </div>
        </>:<div className="op-empty">选择会话查看文件改动和可用的回退操作。</div>}
      </div>
    </div>
  </Panel>;
}

function FilePatch({patch,filePath}:{patch:string;filePath:string}) {
  const text=useMemo(()=>{
    if(!filePath)return '';
    const normalized=filePath.replace(/\\/g,'/').replace(/^\/+/, '');
    const lines=patch.replace(/\r\n?/g,'\n').split('\n');
    const start=lines.findIndex((line,i)=>line.trim()==='--- a/'+normalized&&lines[i+1]?.trim()==='+++ b/'+normalized);
    if(start<0)return patch.includes('[Binary, large, or unsupported path changed: '+normalized+']')
      ? '二进制文件或超大文件：已检测到修改，无法展示文本差异。':'此文件没有可展示的文本差异。';
    let from=start;
    if(from>0&&lines[from-1].startsWith('diff --git '))from--;
    let to=lines.length;
    for(let i=start+2;i<lines.length;i++){
      if(lines[i].startsWith('diff --git ')){to=i;break;}
    }
    return lines.slice(from,to).join('\n');
  },[patch,filePath]);
  return <div className="op-diff" role="region" aria-label={filePath||'文件差异'}>
    {text.split('\n').map((line,i)=><div key={i} className={
      line.startsWith('+')&&!line.startsWith('+++')?'op-diff-add':
        line.startsWith('-')&&!line.startsWith('---')?'op-diff-del':
          line.startsWith('@@')?'op-diff-hunk':'op-diff-neutral'}><code>{line||' '}</code></div>)}
  </div>;
}

export function MemoriesPage({workspaceRoots}:{workspaceRoots:string[]}) {
  const b=useBackend('memory-list',{limit:200,includeGlobal:true});
  const memories=asItems(b.data,'memories');
  const [selected,setSelected]=useState('');
  const [scope,setScope]=useState<'global'|'workspace'>('workspace');
  const [root,setRoot]=useState(workspaceRoots[0]||'');
  const [title,setTitle]=useState('');
  const [content,setContent]=useState('');
  const [tags,setTags]=useState('');
  const begin=(id:string)=>{
    const m=memories.find(x=>String(x.id)===id);
    setSelected(id);setScope(m?.scope==='global'?'global':'workspace');
    setRoot(String(m?.workspaceRoot||workspaceRoots[0]||''));
    setTitle(value(m||null,'title'));setContent(value(m||null,'content'));
    setTags(Array.isArray(m?.tags)?m.tags.join(', '):'');
  };
  return <Panel title="显式 Memories" caption="只管理用户明确维护的记忆；不从终端输出、浏览历史或其他私人数据自动推断。">
    <ActionRow><Button appearance="primary" onClick={()=>begin('')}>新建 Memory</Button>
      <Button disabled={b.busy} onClick={b.load}>刷新</Button></ActionRow>
    <Message error={b.error} notice={b.notice}/>
    <div className="op-columns">
      <Selection items={memories} selected={selected} onSelect={begin} getId={m=>String(m.id||'')}
        describe={m=><><strong>{titleFor(m,'title','id')}</strong><small>{m.scope||'workspace'} · {m.workspaceRoot||'全局'} · {m.updatedAt||''}</small></>}/>
      <div className="op-editor"><h3>{selected?'编辑 Memory':'创建 Memory'}</h3>
        <div className="op-form"><TextControl label="标题" value={title} onChange={setTitle} required/>
          <Field label="作用域"><select className="op-select" value={scope} onChange={e=>setScope(e.target.value as 'global'|'workspace')}>
            <option value="workspace">工作区</option><option value="global">全局</option></select></Field>
          {scope==='workspace'&&<Field label="绑定工作目录"><select className="op-select" value={root} onChange={e=>setRoot(e.target.value)}>
            {workspaceRoots.map(p=><option key={p} value={p}>{p}</option>)}</select></Field>}
          <TextControl label="标签（用逗号分隔）" value={tags} onChange={setTags}/>
          <Field label="正文" required><Textarea rows={11} value={content} onChange={(_e,d)=>setContent(d.value)}/></Field>
          <ActionRow><Button appearance="primary" disabled={b.busy||!title.trim()||!content.trim()||(scope==='workspace'&&!root)}
            onClick={()=>b.call('memory-upsert',{id:selected||undefined,scope,workspaceRoot:scope==='workspace'?root:undefined,
              title,content,tags:tags.split(',').map(s=>s.trim()).filter(Boolean)})}>保存 Memory</Button>
            <Button disabled={b.busy||!selected} onClick={async()=>{if(await b.call('memory-delete',{id:selected},true))begin('');}}>删除此 Memory</Button></ActionRow>
        </div>
      </div>
    </div>
  </Panel>;
}

export function OAuthPage() {
  const b=useBackend('oauth-client-list');
  const clients=asItems(b.data,'clients','oauthClients');
  const [selected,setSelected]=useState('');
  const [name,setName]=useState('');
  const [redirect,setRedirect]=useState('');
  const [createdId,setCreatedId]=useState('');
  const active=clients.find(c=>String(c.clientId||c.id)===selected)||null;
  async function create(){
    const redirectUris=redirect.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    if(!redirectUris.length)return;
    const response=await b.call('oauth-client-create',{clientName:name.trim(),redirectUris});
    if(response?.client?.clientId)setCreatedId(String(response.client.clientId));
  }
  return <Panel title="OAuth 客户端" caption="管理手动注册的 MCP/OAuth 客户端；动态注册客户端由对应 AI 应用管理。">
    <ActionRow><Button onClick={b.load} disabled={b.busy}>刷新客户端</Button></ActionRow>
    <Message error={b.error} notice={b.notice}/>
    <div className="op-columns">
      <Selection items={clients} selected={selected} onSelect={setSelected} getId={c=>String(c.clientId||c.id||'')}
        describe={c=><><strong>{titleFor(c,'clientName','name','clientId')}</strong>
          <small>{c.manual?'手动注册':'动态注册'} · {c.tokenEndpointAuthMethod||''}</small>
          <span className="op-subtle">{c.clientId||c.id}</span></>}/>
      <div className="op-editor"><h3>创建手动客户端</h3>
        <div className="op-form">
          <TextControl label="客户端名称" value={name} onChange={setName} required/>
          <Field label="Redirect URI（每行一个）" required><Textarea rows={3} value={redirect} onChange={(_e,d)=>setRedirect(d.value)}
            placeholder="https://your-client.example/oauth/callback"/></Field>
          <Button appearance="primary" disabled={b.busy||!name.trim()||!redirect.trim()} onClick={create}>创建客户端</Button>
          {createdId&&<div className="op-message op-success">客户端已创建：{createdId}。新 Secret 已复制到系统剪贴板，请立即保存到密码管理器。
            <Button appearance="subtle" onClick={()=>window.devspace.copyValue(createdId)}>复制 Client ID</Button></div>}
          {active&&<div className="op-subsection"><h3>所选客户端</h3>
            <p className="op-subtle">{active.clientId||active.id}</p>
            <ActionRow><Button onClick={()=>window.devspace.copyValue(String(active.clientId||active.id))}>复制 Client ID</Button>
              <Button disabled={b.busy||!active.manual} onClick={()=>b.call('oauth-client-rotate-secret',
                {clientId:active.clientId||active.id},true)}>轮换 Secret 并撤销旧凭据</Button>
              <Button disabled={b.busy||!active.manual} onClick={async()=>{
                if(await b.call('oauth-client-delete',{clientId:active.clientId||active.id},true))setSelected('');
              }}>删除客户端及 Token</Button></ActionRow>
          </div>}
        </div>
      </div>
    </div>
  </Panel>;
}

type ServiceProps = { config:any; onConfigChange:()=>Promise<void> };
export function ServicePage({config,onConfigChange}:ServiceProps) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [output,setOutput]=useState<any>(null);
  const [lease,setLease]=useState<any>(null);
  const [auto,setAuto]=useState(Boolean(config?.autoContinuationEnabled));
  const [computer,setComputer]=useState(Boolean(config?.features?.computerUse));
  useEffect(()=>{setAuto(Boolean(config?.autoContinuationEnabled));setComputer(Boolean(config?.features?.computerUse));},[config]);
  const act=async(action:string,payload:Record<string,unknown>={},danger=false)=>{
    if(danger&&!window.confirm('将修改当前服务或任务。确定继续？'))return;
    setBusy(true);setError('');setNotice('');
    try{
      const r=await window.devspace.admin(action,payload,danger);
      setOutput(r);setNotice('操作已完成。');
      await onConfigChange();
      return r;
    }catch(e){setError(explain(e));}
    finally{setBusy(false);}
  };
  const actions:[string,string,boolean?][]=[
    ['start-local','启动本地 MCP'],['stop-local','停止本地 MCP'],
    ['restart-local','重启本地 MCP'],['start-tunnel','启动公网隧道'],
    ['stop-tunnel','停止公网隧道'],['restart-tunnel','重启公网隧道'],
    ['enable','恢复并启动服务'],['disable','停止并禁用服务',true],
    ['install-tasks','注册或修复计划任务'],['uninstall-tasks','卸载计划任务',true],
  ];
  return <Panel title="服务与运行权限" caption="本地 MCP、隧道、计划任务、自动续轮和 Computer Use 的操作均在新版控制中心完成。">
    <Message error={error} notice={notice}/>
    <div className="op-form">
      <div className="op-toggle"><div><strong>自动续轮</strong><small>只切换自动续轮开关，不改变已运行任务的身份和安全门控。</small></div>
        <Switch checked={auto} disabled={busy} onChange={async(_e,d)=>{
          const next=d.checked;const r=await act('set-auto-continuation',{enabled:next});
          if(r?.enabled===next)setAuto(next);
        }}/></div>
      <div className="op-toggle"><div><strong>Computer Use 桌面控制</strong>
        <small>启用前必须应用包含桌面控制许可的权限设置。使用现有文件队列 Broker，不启动旧 WinForms。</small></div>
        <Switch checked={computer} disabled={busy} onChange={async(_e,d)=>{
          const next=d.checked;
          const r=await act('set-computer-use',{enabled:next});
          if(r?.enabled===next){setComputer(next);setLease(null);}
        }}/></div>
      <ActionRow><Button disabled={busy} onClick={async()=>{
        setBusy(true);setError('');
        try{setLease(await window.devspace.admin('dashboard-status',{}));}
        catch(e){setError(explain(e));}finally{setBusy(false);}
      }}>刷新运行状态</Button></ActionRow>
      {lease&&simple(lease)}
    </div>
    <div className="op-subsection"><h3>服务管理</h3>
      <p className="help">停止或重新注册服务可能中断当前 ChatGPT/MCP 连接，操作前请确认正在运行的任务。</p>
      <div className="op-task-actions">{actions.map(([name,title,danger])=>
        <Button key={name} disabled={busy||(config?.localOnly&&name.includes('tunnel'))}
          onClick={()=>act(name,{},Boolean(danger))}>{title}</Button>)}</div>
      {output&&simple(output)}
    </div>
  </Panel>;
}

export function DiagnosticsPage() {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [result,setResult]=useState<any>(null);
  const [logs,setLogs]=useState<any>(null);
  const action=async(name:string,payload:Record<string,unknown>={},danger=false)=>{
    if(danger&&!window.confirm('此操作可能修改系统网络代理设置或替换当前程序。确认继续？'))return;
    setBusy(true);setError('');
    try{const data=await window.devspace.admin(name,payload,danger);
      setResult(data);return data;}
    catch(e){setError(explain(e));}
    finally{setBusy(false);}
  };
  return <Panel title="日志、诊断与网络代理" caption="仅在你明确点击按钮时检查或修复服务及系统代理。软件更新请前往设置页面。">
    {error&&<div role="alert" className="op-message op-error">{error}</div>}
    <div className="op-subsection"><h3>日志与诊断</h3>
      <ActionRow><Button disabled={busy} onClick={()=>action('dashboard-status')}>服务状态</Button>
        <Button disabled={busy} onClick={async()=>{try{setLogs(await window.devspace.admin('log-paths',{}));}catch(e){setError(explain(e));}}}>日志路径</Button>
        <Button disabled={busy} onClick={()=>action('network-proxy-state')}>系统代理状态</Button></ActionRow>
      {logs&&simple(logs)}
    </div>
    <div className="op-subsection"><h3>代理连接修复</h3>
      <p className="help">仅在诊断确认 Windows 代理残留时使用。修复与恢复均需要额外确认。</p>
      <ActionRow><Button disabled={busy} onClick={()=>action('repair-stale-proxy',{},true)}>修复过期代理</Button>
        <Button disabled={busy} onClick={()=>action('restore-proxy-repair',{},true)}>恢复代理备份</Button></ActionRow>
    </div>
    {result&&simple(result)}
  </Panel>;
}

export function UpdatesPage() {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [result,setResult]=useState<any>(null);
  const [stagedPath,setStagedPath]=useState('');
  const action=async(name:'update-check'|'update-stage'|'update-launch',
    payload:Record<string,unknown>={},danger=false)=>{
    if(danger&&!window.confirm('安装更新会退出控制中心、中断当前 MCP 与正在运行的任务。请确认已备份配置/数据库并安排维护窗口。继续吗？'))return null;
    setBusy(true);setError('');
    try {
      const data=await window.devspace.admin(name,payload,danger);
      setResult(data);return data;
    } catch(e) {setError(explain(e));return null;}
    finally {setBusy(false);}
  };
  return <Panel title="软件更新" caption="在设置中检查、下载并安装更新；不会因为打开设置页面就自动更新或停止服务。">
    {error&&<div role="alert" className="op-message op-error">{error}</div>}
    <p className="help">检查和下载阶段不会替换当前服务。安装前须额外确认，并在有维护窗口时进行。</p>
    <ActionRow><Button disabled={busy} onClick={()=>action('update-check')}>检查更新</Button>
      <Button disabled={busy} onClick={async()=>{
        setStagedPath('');
        const staged=await action('update-stage');
        if(typeof staged?.stagingPath==='string')setStagedPath(staged.stagingPath);
      }}>下载并验证更新</Button>
      <Button appearance="primary" disabled={busy||!stagedPath} onClick={async()=>{
        const ack=await action('update-launch',{stagingPath:stagedPath},true);
        if(ack?.acknowledged)setStagedPath('');
      }}>安装已校验的更新</Button></ActionRow>
    {stagedPath&&<div className="op-message op-success">更新已经校验并暂存；安装需要额外确认，届时控制中心将退出。</div>}
    <p className="op-subtle">安装会中断当前 MCP 与正在进行的任务。先确认已备份配置/数据库，并安排无其他用户操作的维护窗口。</p>
    {result&&simple(result)}
  </Panel>;
}
