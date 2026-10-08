import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Field, Input, Spinner, Switch, Textarea } from '@fluentui/react-components';
import {
  AppsRegular, ArrowClockwiseRegular, ArrowLeftRegular, ArrowRightRegular,
  CheckmarkCircleRegular, ClipboardRegular, CloudRegular, CodeRegular,
  DesktopRegular, FolderOpenRegular, HomeRegular, KeyRegular, LockClosedRegular,
  PlugConnectedRegular, SearchRegular, ServerRegular, SettingsRegular, ShieldRegular,
} from '@fluentui/react-icons';
import type { Config, Permission, Progress, Provider, Settings } from './api';
import {operationNames, standardOperations, fullOperations, detectOperationMode,
  initialFileScope, selectedDirectoryList, compileAccessSettings} from './access-policy';
import { AgentsPage, PluginsPage, ContinuationsPage, SessionsPage,
  MemoriesPage, OAuthPage, ServicePage, DiagnosticsPage, UpdatesPage } from './Operations';

type Page = 'home' | 'agents' | 'extensions' | 'tasks' |
  'sessions' | 'memories' | 'oauth' | 'services' | 'diagnose' | 'settings';
type SettingsSection = 'basic' | 'files' | 'operations' | 'updates';
const settingsSections: {id:SettingsSection;label:string;description:string}[] = [
  {id:'basic',label:'连接与凭据',description:'连接方式、端口、地址与关闭行为'},
  {id:'files',label:'文件访问',description:'工作目录与文件访问范围'},
  {id:'operations',label:'操作权限',description:'命令、网络、凭据与桌面控制'},
  {id:'updates',label:'更新',description:'检查、下载与安装更新'},
];
type SecretKind = 'owner' | 'ngrok' | 'cloudflare';
const workspace: Permission = {
  profile:'custom', allowExternalPaths:false, ...standardOperations,
};
function fromConfig(c: Config): Settings {
  return {
    provider: c.localOnly ? 'local' : c.tunnelProvider === 'cloudflare' ? 'cloudflare' : 'ngrok',
    publicBaseUrl: c.publicBaseUrl || '', port: c.port || 7676,
    allowedRoots: selectedDirectoryList(c),
    fileScopeMode: initialFileScope(c),
    operationMode: detectOperationMode(c),
    allowAllFixedDrives: initialFileScope(c) === 'all',
    permissions: c.permissions || workspace, toolMode: c.toolMode || 'codex',
    ngrokProxyUrl: c.ngrokProxyUrl || '',
  };
}
const steps = ['欢迎','使用方式','网络连接','文件范围','操作权限','检查配置','部署完成'];

function SecretField({ kind, configured, value, onChange, onCopy }: {
  kind: SecretKind; configured: boolean; value: string; onChange: (value:string)=>void;
  onCopy:(kind:SecretKind)=>void;
}) {
  const [editing,setEditing] = useState(!configured);
  return <div className="secret-row">
    <div className="secret-value">
      {configured && !editing
        ? <div className="secret-saved"><KeyRegular/><span>••••••••••••••••</span><span className="tag good">已配置</span></div>
        : <Input type="password" value={value} placeholder={kind === 'owner' ? '留空则自动生成安全密码' : '粘贴 Token'} onChange={(_e,d)=>onChange(d.value)} aria-label={kind+' Token'} />}
    </div>
    {configured && !editing && <Button appearance="subtle" icon={<ClipboardRegular/>} onClick={()=>onCopy(kind)}>复制</Button>}
    {configured && <Button appearance="subtle" onClick={()=>{setEditing(!editing);onChange('');}}>{editing ? '取消更换' : '更换'}</Button>}
  </div>;
}
function Choice({selected, icon, title, caption, onClick}: {selected:boolean;icon:React.ReactNode;title:string;caption:string;onClick:()=>void}) {
  return <button type="button" className={'choice '+(selected?'chosen':'')} onClick={onClick}>
    <span className="choice-icon">{icon}</span><strong>{title}</strong><small>{caption}</small>
    <span className="choice-check">{selected ? '✓' : ''}</span>
  </button>;
}
function Roots({values,onChange,onChoose}:{
  values:string[];onChange:(value:string[])=>void;onChoose:()=>Promise<void>;
}) {
  return <div className="roots">
    {values.map(root=><div className="root" key={root}><FolderOpenRegular/><span title={root}>{root}</span><Button appearance="subtle" size="small" onClick={()=>onChange(values.filter(v=>v!==root))}>移除</Button></div>)}
    <Button icon={<FolderOpenRegular/>} appearance="outline" onClick={onChoose}>添加工作目录</Button>
    <p className="help">这里保存的是明确选择的项目目录；切换至「全部可访问目录」不会清除这些记录。</p>
  </div>;
}
function FileAccess({mode,onModeChange,roots,onRootsChange,onChoose}:{
  mode:Settings['fileScopeMode'];onModeChange:(v:Settings['fileScopeMode'])=>void;
  roots:string[];onRootsChange:(v:string[])=>void;onChoose:()=>Promise<void>;
}) {
  return <section className="access-section">
    <div className="access-heading"><span className="access-number">01</span><div><h3>文件访问范围</h3>
      <p>只决定可以访问哪里；操作权限在独立页面设置。</p></div></div>
    <div className="choices access-choices">
      <Choice selected={mode==='selected'} icon={<FolderOpenRegular/>} title="仅限所选目录"
        caption="只允许访问明确选择的工作目录及其子目录。" onClick={()=>onModeChange('selected')}/>
      <Choice selected={mode==='all'} icon={<DesktopRegular/>} title="全部可访问目录"
        caption="不受工作目录限制；访问当前 Windows 用户有权访问的路径。" onClick={()=>onModeChange('all')}/>
    </div>
    {mode==='selected'?<><div className="access-summary">
      <strong>当前有效范围：{roots.length?roots.length+' 个指定目录':'尚未选择目录'}</strong>
              <span>内置文件工具限于以下目录。任意命令、外部程序及桌面控制等高级操作可能绕过目录过滤，请结合下方操作权限管理。</span>
    </div><Roots values={roots} onChange={onRootsChange} onChoose={onChoose}/></>:
      <><div className="warning" role="status"><ShieldRegular/>
        全部目录模式不受下方已选目录限制，包括当前用户有权限访问的其他本地盘和网络路径；仍受 Windows 账户权限约束。</div>
        <div className="access-summary"><strong>已保存 {roots.length} 个工作目录（当前不作为访问限制）</strong>
          <span>切回「仅限所选目录」后，以下原有目录将重新成为访问边界。</span></div>
        {roots.length>0&&<div className="roots roots-retained">{roots.map(root=>
          <div className="root" key={root}><FolderOpenRegular/><span title={root}>{root}</span></div>)}</div>}</>}
  </section>;
}
function Permissions({value,mode,onChange}:{
  value:Permission;mode:Settings['operationMode'];onChange:(mode:Settings['operationMode'],value:Permission)=>void;
}) {
  const choose=(next:Settings['operationMode'])=>onChange(next,
    next==='standard'?{...value,...standardOperations}:next==='full'?{...value,...fullOperations}:value);
  return <section className="access-section">
    <div className="access-heading"><span className="access-number">02</span><div><h3>操作权限</h3>
      <p>决定可以执行哪些操作；「全部操作」不会自动开启全部目录访问。</p></div></div>
    <div className="choices permission-choices">
      <Choice selected={mode==='standard'} icon={<ShieldRegular/>} title="标准操作"
        caption="网络和持续进程开启，任意命令、Shell 修改和敏感操作关闭。" onClick={()=>choose('standard')}/>
      <Choice selected={mode==='full'} icon={<DesktopRegular/>} title="全部操作"
        caption="启用以下所有操作能力，文件访问范围保持不变。" onClick={()=>choose('full')}/>
      <Choice selected={mode==='custom'} icon={<SettingsRegular/>} title="自定义操作"
        caption="逐项控制命令、网络、凭据及桌面操作。" onClick={()=>choose('custom')}/>
    </div>
    {mode==='full'&&<div className="warning"><ShieldRegular/>任意命令及桌面控制可能通过外部程序或界面操作影响工作目录外的文件；目录过滤不能约束所有外部操作，请仅在可信环境启用。</div>}
    {mode==='custom'&&<div className="permission-grid">{operationNames.map(item=><div className="permission" key={item.key}>
      <div><strong>{item.label}</strong><p>{item.desc}</p></div>
      <Switch checked={Boolean(value[item.key])} onChange={(_e,d)=>onChange('custom',{...value,[item.key]:d.checked})}/>
    </div>)}</div>}
  </section>;
}
function DeployProgress({progress,busy}: {progress:Progress|null;busy:boolean}) {
  return <div className="deploy-progress">
    {['保存设置','注册服务','启动本地 MCP 和隧道','验证服务'].map((label,index)=><div key={label} className={'deploy-step '+(progress && progress.step>index?'passed':'')}>
      <span className="round-icon">{progress && progress.step>index ? '✓':index+1}</span><span>{label}</span>
      {busy && progress?.step===index+1 && <Spinner size="tiny"/>}
    </div>)}
    {progress && <p className="help">{progress.message}</p>}
  </div>;
}
function getError(e:unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return message.length > 300 ? message.slice(0,300) : message;
}

export function App() {
  const [config,setConfig] = useState<Config|null>(null);
  const [secretRevision,setSecretRevision] = useState(0);
  const [draft,setDraft] = useState<Settings|null>(null);
  const [status,setStatus] = useState<any>(null);
  const [root,setRoot] = useState('');
  const [page,setPage] = useState<Page>('home');
  const [settingsSection,setSettingsSection] = useState<SettingsSection>('basic');
  const [wizard,setWizard] = useState(false);
  const [step,setStep] = useState(0);
  const [busy,setBusy] = useState(false);
  const [progress,setProgress] = useState<Progress|null>(null);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [dirty,setDirty] = useState(false);
  const [applyPending,setApplyPending] = useState(false);
  const [closeOpen,setCloseOpen] = useState(false);
  const [rememberClose,setRememberClose] = useState(false);
  const [closeBusy,setCloseBusy] = useState(false);
  const [closePreference,setClosePreference] = useState<''|'minimize-tray'|'exit-ui'>('');
  useEffect(()=>{
    let active=true;
    const unStatus=window.devspace.onStatus(value=>{if(active)setStatus(value);});
    const unProgress=window.devspace.onProgress(value=>{if(active)setProgress(value);});
    const unClose=window.devspace.onCloseRequest(()=>{
      if(active){setCloseOpen(true);setRememberClose(false);setCloseBusy(false);}
    });
    window.devspace.getClosePreference().then(choice=>{if(active)setClosePreference(choice);}).catch(()=>{});
    window.devspace.initialize().then(data=>{
      if(!active)return;
      setConfig(data.config);setStatus(data.status);setRoot(data.root);setApplyPending(data.applyPending);
      setDraft(fromConfig(data.config));
      if(!data.config.configured){setWizard(true);setStep(0);}
    }).catch(e=>{if(active)setError(getError(e));});
    return ()=>{active=false;unStatus();unProgress();unClose();};
  },[]);
  useEffect(()=>{
    if(wizard||page!=='home')return;
    let active=true;
    let inFlight=false;
    const refresh=async()=>{
      if(!active||inFlight||document.visibilityState!=='visible')return;
      inFlight=true;
      try {
        const next=await window.devspace.getStatus();
        if(active)setStatus(next);
      } catch {}
      finally {inFlight=false;}
    };
    void refresh();
    const timer=window.setInterval(refresh,5_000);
    document.addEventListener('visibilitychange',refresh);
    return ()=>{active=false;window.clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
  },[wizard,page]);
  const chooseClose=useCallback(async(choice:'cancel'|'minimize-tray'|'exit-ui')=>{
    if(closeBusy)return;
    setCloseBusy(true);
    try {
      await window.devspace.chooseClose(choice,choice!=='cancel'&&rememberClose);
      if(choice!=='cancel'&&rememberClose)setClosePreference(choice);
      setCloseOpen(false);
    } catch(e) {setError(getError(e));}
    finally {setCloseBusy(false);}
  },[closeBusy,rememberClose]);
  const saveClosePreference=useCallback(async(choice:''|'minimize-tray'|'exit-ui')=>{
    try {
      const result=await window.devspace.setClosePreference(choice);
      setClosePreference(result.choice);
      setNotice(choice?'关闭窗口行为已保存，下次点击 × 时直接执行。':'已恢复每次关闭时询问。');
      setError('');
    } catch(e) {setError(getError(e));}
  },[]);
  const update = useCallback((change:Partial<Settings>)=>{
    setDraft(prev=>prev?{...prev,...change}:prev);
    setDirty(true);setError('');setNotice('');
  },[]);
  const addFolder=useCallback(async()=>{
    try {
      const folder=await window.devspace.chooseFolder();
      if(folder&&draft&&!draft.allowedRoots.some(v=>v.toLowerCase()===folder.toLowerCase()))
        update({allowedRoots:[...draft.allowedRoots,folder],fileScopeMode:'selected',allowAllFixedDrives:false});
    }catch(e){setError(getError(e));}
  },[draft,update]);
  const copy=useCallback(async(kind:SecretKind)=>{
    try{await window.devspace.copySecret(kind);setNotice('已复制到系统剪贴板，Token 不会显示在页面中。');}
    catch(e){setError(getError(e));}
  },[]);
  const copyUrl=useCallback(async(kind:'local'|'public')=>{
    try{await window.devspace.copyUrl(kind);setNotice('MCP 地址已复制到系统剪贴板。');}
    catch(e){setError(getError(e));}
  },[]);
  const select=useCallback((name:Page, section?:SettingsSection)=>{
    setPage(name);if(section)setSettingsSection(section);
    setWizard(false);setError('');setNotice('');
  },[]);
  const save=useCallback(async (deploy=false)=>{
    if(!draft)return;
    if(deploy&&config?.configured&&
      !window.confirm('应用配置会重启 DevSpace，可能短暂中断当前 MCP 连接及正在进行的任务。确定继续？'))return;
    setBusy(true);setError('');setNotice('');setProgress(null);
    try {
      const previous=await window.devspace.getConfig();
      const result=await window.devspace.save(compileAccessSettings(draft));
      setApplyPending(true);
      const next=await window.devspace.getConfig();
      setConfig(next);setDraft(fromConfig(next));setDirty(false);setSecretRevision(v=>v+1);
      if(deploy) {
        await window.devspace.deploy(draft.provider);
        setApplyPending(false);
        setStatus(await window.devspace.getStatus());
        setStep(6);setNotice('部署已完成。请保存 MCP 地址和 Owner Password。');
      } else {
        setNotice(previous.configured ? '设置已保存。网络或权限变更需点击「应用并重启」才会在服务中生效。'
          : '首次设置已保存，可以部署 DevSpace。');
      }
      if(result.generatedOwnerToken)setNotice('已生成安全 Owner Password，请使用复制按钮保存到密码管理器。');
    }catch(e){setError(getError(e));}
    finally{setBusy(false);}
  },[draft]);
  const isPublic=draft?.provider!=='local';
  const selectedSecret=draft?.provider==='ngrok'?'ngrok':'cloudflare';
  const validStep=useMemo(()=>{
    if(!draft)return false;
    if(step===2&&isPublic) {
      if(!/^https:\/\/[^/\s]+\/?$/.test(draft.publicBaseUrl))return false;
      const present=selectedSecret==='ngrok'?config?.hasNgrokToken:config?.hasCloudflareToken;
      if(!present && !(selectedSecret==='ngrok'?draft.ngrokToken:draft.cloudflareToken))return false;
    }
    if(step===3&&draft.fileScopeMode==='selected'&&!draft.allowedRoots.length)return false;
    return true;
  },[step,draft,isPublic,config,selectedSecret]);
  if(!draft||!config)return <div className="startup"><Spinner size="large"/><h2>正在连接 DevSpace…</h2><p>{error||'读取本地配置，不会修改现有部署。'}</p></div>;
  return <div className="desktop">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><CodeRegular/></span><span>DevSpace<small>PORTABLE</small></span></div>
      <div className="side-group">
        {([['home',<HomeRegular/>,'主页'],['agents',<ServerRegular/>,'远程服务器'],
          ['extensions',<PlugConnectedRegular/>,'插件与工具'],
          ['tasks',<AppsRegular/>,'续轮任务'],['sessions',<SearchRegular/>,'会话与回退'],
          ['memories',<KeyRegular/>,'Memories'],['oauth',<LockClosedRegular/>,'OAuth 客户端'],
          ['services',<DesktopRegular/>,'服务与桌面控制'],
          ['diagnose',<SearchRegular/>,'日志与诊断']] as const).map(([id,icon,title])=>
          <button type="button" key={id} data-page={id} className={'nav '+(!wizard&&page===id?'active':'')} onClick={()=>select(id)}>{icon}<span>{title}</span></button>)}
      </div>
      <div className="sidebar-bottom"><button data-page="settings" className={'nav '+(!wizard&&page==='settings'?'active':'')} onClick={()=>select('settings')}><SettingsRegular/>设置</button>
        <div className="sidebar-status"><span>v1.1.63</span></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar"><div><span className="eyebrow">DEVSPACE / {wizard?'首次设置':page.toUpperCase()}</span><h1>{wizard?'设置 DevSpace':{
        home:'控制台',agents:'远程服务器',extensions:'插件与工具',tasks:'续轮任务',
        sessions:'会话与回退',memories:'Memories',oauth:'OAuth 客户端',services:'服务与桌面控制',
        diagnose:'诊断中心',settings:'设置',
      }[page]}</h1></div><div className="top-actions"><span className={'status-pill '+(status?.localHealthy?'ok':'')}>{status?.localHealthy?'● 服务正常':'○ 服务未连接'}</span>
        <Button appearance="subtle" icon={<ArrowClockwiseRegular/>} onClick={()=>window.devspace.getStatus().then(setStatus)}>刷新</Button></div></header>
      <div className="page-body">
        {error&&<div className="alert error" role="alert"><strong>操作未完成</strong><span>{error}</span><Button appearance="subtle" onClick={()=>setError('')}>关闭</Button></div>}
        {notice&&<div className="alert success" role="status"><CheckmarkCircleRegular/><span>{notice}</span><Button appearance="subtle" onClick={()=>setNotice('')}>关闭</Button></div>}
        {wizard&&<div className="wizard">
          <div className="wizard-steps">{steps.map((label,i)=><div key={label} className={'wizard-step '+(i===step?'current':i<step?'past':'')}><span>{i<step?'✓':i+1}</span><small>{label}</small></div>)}</div>
          <section className="panel wizard-panel">
            {step===0&&<><div className="large-icon"><CodeRegular/></div><h2>欢迎使用 DevSpace</h2><p className="muted">通过几个清晰的步骤完成本地部署。已经保存的 Token 和 OAuth 数据不会因进入向导而重置。</p>
              <div className="tip"><ShieldRegular/>此界面直接使用现有服务和配置；所有管理功能均可从左侧导航进入。</div></>}
            {step===1&&<><h2>你准备怎样使用 DevSpace？</h2><p className="muted">只显示与你选择的连接方式相关的设置。</p>
              <div className="choices"><Choice selected={draft.provider==='local'} icon={<DesktopRegular/>} title="仅本机" caption="无需公网 Token，不启动隧道。" onClick={()=>update({provider:'local'})}/>
                <Choice selected={draft.provider==='cloudflare'} icon={<CloudRegular/>} title="Cloudflare Tunnel" caption="从 ChatGPT 公网连接你的电脑。" onClick={()=>update({provider:'cloudflare',publicBaseUrl:config.providerUrls?.cloudflare||''})}/>
                <Choice selected={draft.provider==='ngrok'} icon={<PlugConnectedRegular/>} title="ngrok" caption="通过 ngrok Authtoken 建立公网连接。" onClick={()=>update({provider:'ngrok',publicBaseUrl:config.providerUrls?.ngrok||''})}/></div></>}
            {step===2&&<><h2>{isPublic?'设置公网连接':'本地连接设置'}</h2>
              <div className="form-grid"><Field label="本地服务端口" hint="默认 7676，仅允许 1024—65535。"><Input type="number" value={String(draft.port)} onChange={(_e,d)=>update({port:Number(d.value)})}/></Field>
              {isPublic?<><Field label="公网 HTTPS 地址" hint="填写域名根地址，不要包含 /mcp。"><Input value={draft.publicBaseUrl} placeholder="https://mcp.example.com" onChange={(_e,d)=>update({publicBaseUrl:d.value})}/></Field>
                <Field label={selectedSecret==='cloudflare'?'Cloudflare Tunnel Token':'ngrok Authtoken'} hint="已配置的凭据不会因为保存其他设置而被清除。">
                  <SecretField key={selectedSecret+secretRevision} kind={selectedSecret} configured={selectedSecret==='cloudflare'?config.hasCloudflareToken:config.hasNgrokToken}
                    value={selectedSecret==='cloudflare'?draft.cloudflareToken||'':draft.ngrokToken||''} onChange={v=>update(selectedSecret==='cloudflare'?{cloudflareToken:v}:{ngrokToken:v})} onCopy={copy}/></Field>
              </>:<div className="tip"><LockClosedRegular/>此模式不会要求公网域名或隧道 Token，只会启动本地 MCP。</div>}</div></>}
            {step===3&&<><h2>选择文件访问范围</h2><p className="muted">可以只授权指定目录，或者明确允许访问当前账户有权访问的所有目录。</p>
              <FileAccess mode={draft.fileScopeMode} roots={draft.allowedRoots}
                onModeChange={v=>update({fileScopeMode:v,allowAllFixedDrives:v==='all'})}
                onRootsChange={v=>update({allowedRoots:v})} onChoose={addFolder}/></>}
            {step===4&&<><h2>选择操作权限</h2><p className="muted">文件范围已单独选择；此处只决定命令、网络和桌面等操作能力。</p>
              <Permissions value={draft.permissions} mode={draft.operationMode}
                onChange={(mode,value)=>update({operationMode:mode,permissions:value})}/></>}
            {step===5&&<><h2>检查并部署</h2><p className="muted">确认以下配置。部署将注册计划任务并启动服务，不会删除旧数据。</p>
              <div className="review"><div>连接方式<strong>{draft.provider==='local'?'仅本机':draft.provider}</strong></div>
                <div>本地端口<strong>{draft.port}</strong></div>
                <div>有效文件范围<strong>{draft.fileScopeMode==='all'?'全部可访问目录':draft.allowedRoots.join('；')||'未选择'}</strong></div>
                <div>操作权限<strong>{draft.operationMode==='standard'?'标准操作':draft.operationMode==='full'?'全部操作':'自定义操作'}</strong></div></div>
              <DeployProgress progress={progress} busy={busy}/></>}
            {step===6&&<><div className="large-icon green"><CheckmarkCircleRegular/></div><h2>DevSpace 已就绪</h2>
              <p className="muted">服务部署完成。下面的地址与密码可以通过按钮复制。</p>
              <div className="review"><div>本地 MCP<strong>{status?.localUrl||'http://127.0.0.1:7676/mcp'}</strong></div>
                {draft.provider!=='local'&&<div>公网 MCP<strong>{status?.publicUrl?status.publicUrl+'/mcp':'请检查公网地址'}</strong></div>}</div>
              <div className="button-row"><Button icon={<ClipboardRegular/>} onClick={()=>copyUrl('local')}>复制本地 MCP 地址</Button>
                {draft.provider!=='local'&&<Button icon={<ClipboardRegular/>} onClick={()=>copyUrl('public')}>复制公网 MCP 地址</Button>}</div>
              <Field label="Owner Password" hint="首次生成后不在 React 状态中回显，复制由 Electron 主进程完成。">
                <SecretField key={'owner'+secretRevision} kind="owner" configured={config.hasOwnerToken} value={draft.ownerToken||''} onChange={v=>update({ownerToken:v})} onCopy={copy}/></Field></>}
          </section>
          <div className="wizard-footer">
            {step>0&&step<6&&<Button appearance="subtle" icon={<ArrowLeftRegular/>} disabled={busy} onClick={()=>setStep(v=>v-1)}>上一步</Button>}
            <span className="spacer"/>
            {step<5&&<Button appearance="primary" icon={<ArrowRightRegular/>} iconPosition="after" disabled={!validStep||busy} onClick={()=>setStep(v=>v+1)}>继续</Button>}
            {step===5&&<Button appearance="primary" disabled={busy||!validStep} onClick={()=>save(true)}>{busy?'部署中…':'保存并部署'}</Button>}
            {step===6&&<Button appearance="primary" onClick={()=>{setWizard(false);setPage('home');}}>进入控制台</Button>}
          </div>
        </div>}
        {!wizard&&page==='home'&&<><div className="hero"><span className="eyebrow">SYSTEM OVERVIEW</span><h2>{status?.localHealthy?'DevSpace 正在运行':'DevSpace 尚未就绪'}</h2>
          <p>这里仅显示运行概览。配置、服务控制及诊断分别在左侧对应页面操作。</p></div>
          {(dirty||applyPending)&&<div className="home-pending" role="status"><div><strong>{dirty?'有尚未保存的配置':'配置已保存，尚未应用'}</strong>
            <p>{dirty?'请在设置中确认更改并保存。':'请在设置中应用更改，服务重启后生效。'}</p></div>
            <Button appearance="primary" onClick={()=>select('settings','basic')}>处理配置</Button></div>}
          <div className="metric-grid"><div className="metric"><span className="metric-icon"><DesktopRegular/></span>
              <span className="metric-status-title"><span className={'metric-status-dot '+(status?.localHealthy?'healthy':'error')} aria-label={status?.localHealthy?'本地 MCP 正常':'本地 MCP 异常'}/><small>本地 MCP</small></span>
              <strong>{status?.localHealthy?'已连接':'未连接'}</strong><p>{status?.localUrl}</p></div>
            <div className="metric"><span className="metric-icon"><CloudRegular/></span>
              <span className="metric-status-title"><span className={'metric-status-dot '+(status?.provider==='local'?'idle':status?.publicState==='healthy'?'healthy':status?.publicState==='unhealthy'?'error':'checking')}
                aria-label={status?.provider==='local'?'仅本机':status?.publicState==='healthy'?'公网 MCP 最近连通':status?.publicState==='unhealthy'?'公网 MCP 已确认异常':'公网连通性暂无法确认'}/><small>公网模式</small></span>
              <strong>{status?.provider==='local'?'仅本机':status?.provider}</strong>
              <p>{status?.provider==='local'?'未启用公网入口':!status?.publicChecked?'正在核验连通性…':status?.publicState==='healthy'?(status?.publicError?'最近核验成功，本次探测延迟':'公网 MCP 已连通'):status?.publicState==='unhealthy'?'公网端点持续异常':'公网状态暂无法核验（不代表插件断联）'}</p>
              {status?.provider!=='local'&&<p className="metric-url">{status?.publicUrl||'未配置公网入口'}</p>}</div>
            <div className="metric"><span className="metric-icon"><FolderOpenRegular/></span><small>有效文件访问范围</small>
              <strong>{initialFileScope(config)==='all'?'全部可访问目录':selectedDirectoryList(config).length+' 个工作目录'}</strong>
              <p>{initialFileScope(config)==='all'?'已选目录不构成访问限制':'仅允许访问所选目录'}</p></div></div></>}
        {!wizard&&page==='settings'&&<>
          <p className="settings-intro">配置在此编辑和应用。服务启停在「服务与桌面控制」，日志与代理修复在「日志与诊断」。</p>
          <nav className="settings-nav" aria-label="设置分类">
            {settingsSections.map(item=><button type="button" key={item.id} data-settings-section={item.id}
              className={'settings-nav-item '+(settingsSection===item.id?'active':'')}
              aria-current={settingsSection===item.id?'page':undefined}
              onClick={()=>setSettingsSection(item.id)}><strong>{item.label}</strong><small>{item.description}</small></button>)}
          </nav>
          {settingsSection==='basic'&&<section className="panel"><div className="section-heading"><div><h2>连接与凭据</h2><p>端口、隧道与凭据。已保存的 Token 以掩码显示，不会发送到渲染器。</p></div></div>
          <div className="choices"><Choice selected={draft.provider==='local'} icon={<DesktopRegular/>} title="仅本机" caption="不使用公网隧道。" onClick={()=>update({provider:'local'})}/>
            <Choice selected={draft.provider==='cloudflare'} icon={<CloudRegular/>} title="Cloudflare" caption="通过已配置的域名连接。" onClick={()=>update({provider:'cloudflare',publicBaseUrl:config.providerUrls?.cloudflare||draft.publicBaseUrl})}/>
            <Choice selected={draft.provider==='ngrok'} icon={<PlugConnectedRegular/>} title="ngrok" caption="使用 ngrok 公网隧道。" onClick={()=>update({provider:'ngrok',publicBaseUrl:config.providerUrls?.ngrok||draft.publicBaseUrl})}/></div>
          <div className="form-grid"><Field label="本地端口"><Input type="number" value={String(draft.port)} onChange={(_e,d)=>update({port:Number(d.value)})}/></Field>
            {isPublic&&<Field label="公网 HTTPS 地址"><Input value={draft.publicBaseUrl} onChange={(_e,d)=>update({publicBaseUrl:d.value})}/></Field>}
            {isPublic&&<Field label={selectedSecret==='ngrok'?'ngrok Authtoken':'Cloudflare Tunnel Token'}>
              <SecretField key={selectedSecret+secretRevision} kind={selectedSecret} configured={selectedSecret==='ngrok'?config.hasNgrokToken:config.hasCloudflareToken}
                value={selectedSecret==='ngrok'?draft.ngrokToken||'':draft.cloudflareToken||''} onChange={v=>update(selectedSecret==='ngrok'?{ngrokToken:v}:{cloudflareToken:v})} onCopy={copy}/></Field>}
            <Field label="Owner Password"><SecretField key={'owner'+secretRevision} kind="owner" configured={config.hasOwnerToken} value={draft.ownerToken||''} onChange={v=>update({ownerToken:v})} onCopy={copy}/></Field></div>
            <div className="address-actions"><span>当前 MCP 地址</span><Button icon={<ClipboardRegular/>} onClick={()=>copyUrl('local')}>复制本地地址</Button>
              {status?.provider!=='local'&&<Button icon={<ClipboardRegular/>} onClick={()=>copyUrl('public')}>复制公网地址</Button>}</div></section>}
          {settingsSection==='files'&&<section className="panel">
            <FileAccess mode={draft.fileScopeMode} roots={draft.allowedRoots}
              onModeChange={v=>update({fileScopeMode:v,allowAllFixedDrives:v==='all'})}
              onRootsChange={v=>update({allowedRoots:v})} onChoose={addFolder}/></section>}
          {settingsSection==='operations'&&<section className="panel">
            <Permissions value={draft.permissions} mode={draft.operationMode}
              onChange={(mode,value)=>update({operationMode:mode,permissions:value})}/></section>}
          {settingsSection==='basic'&&<section className="panel"><div className="section-heading"><div><h3>关闭窗口行为</h3>
            <p>关闭控制中心不会停止 DevSpace 或公网隧道；最小化到托盘时保留本地 UI 与 Computer Use 租约。</p></div></div>
            <div className="close-preferences" role="group" aria-label="关闭窗口行为">
              <Choice selected={closePreference===''} icon={<SettingsRegular/>} title="每次关闭时询问"
                caption="点击 × 后在应用内选择最小化或退出。" onClick={()=>saveClosePreference('')}/>
              <Choice selected={closePreference==='minimize-tray'} icon={<DesktopRegular/>} title="最小化到系统托盘"
                caption="关闭窗口时隐藏界面，保留托盘入口和 Computer Use 租约。" onClick={()=>saveClosePreference('minimize-tray')}/>
              <Choice selected={closePreference==='exit-ui'} icon={<ArrowRightRegular/>} title="退出控制中心"
                caption="只关闭桌面控制中心，MCP 和公网隧道继续运行。" onClick={()=>saveClosePreference('exit-ui')}/>
            </div>
            <p className="help">选择即保存；需要恢复每次询问时，直接选择第一项。</p>
          </section>}
          {(dirty||applyPending||settingsSection==='basic'||settingsSection==='files'||settingsSection==='operations')&&<div className="save-bar"><span>{dirty?'● 有未保存的更改':applyPending?'● 已保存，待应用':'✓ 配置已应用'}</span>
            {dirty&&<Button onClick={()=>{setDraft(fromConfig(config));setDirty(false);}}>放弃更改</Button>}
            <Button appearance={dirty||applyPending?'primary':'outline'} disabled={busy||(!dirty&&!applyPending)||(dirty&&draft.fileScopeMode==='selected'&&!draft.allowedRoots.length)} onClick={()=>save(!dirty)}>{busy?'请稍候…':dirty?'保存更改':applyPending?'应用并重启':'配置已应用'}</Button>
            </div>}
          {settingsSection==='updates'&&<UpdatesPage/>}</>}
        {!wizard&&page==='agents'&&<AgentsPage/>}
        {!wizard&&page==='extensions'&&<PluginsPage/>}
        {!wizard&&page==='tasks'&&<ContinuationsPage/>}
        {!wizard&&page==='sessions'&&<SessionsPage/>}
        {!wizard&&page==='memories'&&<MemoriesPage workspaceRoots={draft.fileScopeMode==='all'?config.allowedRoots:draft.allowedRoots}/>}
        {!wizard&&page==='oauth'&&<OAuthPage/>}
        {!wizard&&page==='services'&&<ServicePage config={config} onConfigChange={async()=>setConfig(await window.devspace.getConfig())}/>}
        {!wizard&&page==='diagnose'&&<DiagnosticsPage/>}
      </div>
    </main>
    {closeOpen&&<div className="close-overlay" role="presentation">
      <section className="close-dialog" role="dialog" aria-modal="true" aria-labelledby="devspace-close-title"
        aria-describedby="devspace-close-description">
        <div className="close-dialog-body">
          <div className="close-dialog-heading"><span className="close-dialog-icon"><DesktopRegular/></span>
            <div><span className="eyebrow">控制中心 · 窗口行为</span><h2 id="devspace-close-title">关闭控制中心</h2></div>
            <button type="button" className="close-dialog-dismiss" disabled={closeBusy} aria-label="取消关闭"
              onClick={()=>chooseClose('cancel')}>×</button></div>
          <p id="devspace-close-description">请选择关闭窗口后的行为。以下选项均不会停止本地 MCP 服务或公网隧道。</p>
          <div className="close-dialog-actions">
            <button type="button" className="close-to-tray" disabled={closeBusy}
              onClick={()=>chooseClose('minimize-tray')}><span className="close-option-title">最小化到系统托盘</span>
              <small>保留控制中心进程与 Computer Use 租约，可从托盘恢复。</small></button>
            <button type="button" className="close-exit" disabled={closeBusy}
              onClick={()=>chooseClose('exit-ui')}><span className="close-option-title">退出控制中心</span>
              <small>仅退出桌面界面，不关闭 MCP 服务或已启动的隧道。</small></button>
          </div>
          <Checkbox checked={rememberClose} onChange={(_e,data)=>setRememberClose(Boolean(data.checked))}
            disabled={closeBusy} label="记住我的选择（可从系统托盘或设置中恢复每次询问）"/>
          <div className="close-dialog-footer"><Button appearance="subtle" disabled={closeBusy}
            onClick={()=>chooseClose('cancel')}>取消</Button></div>
        </div>
      </section>
    </div>}
  </div>;
}
