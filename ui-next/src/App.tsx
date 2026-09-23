import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Field, Input, Spinner, Switch, Textarea } from '@fluentui/react-components';
import {
  AppsRegular, ArrowClockwiseRegular, ArrowLeftRegular, ArrowRightRegular,
  CheckmarkCircleRegular, ClipboardRegular, CloudRegular, CodeRegular,
  DesktopRegular, FolderOpenRegular, HomeRegular, KeyRegular, LockClosedRegular,
  PlugConnectedRegular, SearchRegular, ServerRegular, SettingsRegular, ShieldRegular,
} from '@fluentui/react-icons';
import type { Config, Permission, Progress, Provider, Settings } from './api';
import { AgentsPage, PluginsPage, ContinuationsPage, SessionsPage,
  MemoriesPage, OAuthPage, ServicePage, DiagnosticsPage } from './Operations';

type Page = 'home' | 'workspaces' | 'agents' | 'extensions' | 'tasks' |
  'sessions' | 'memories' | 'oauth' | 'services' | 'diagnose' | 'settings';
type SecretKind = 'owner' | 'ngrok' | 'cloudflare';
const permissionNames: {key: keyof Omit<Permission,'profile'>; label: string; desc: string}[] = [
  {key:'allowExternalPaths',label:'访问工作区以外的路径',desc:'允许读取或修改所选工作目录之外的文件。'},
  {key:'allowArbitraryCommands',label:'执行任意命令',desc:'允许运行未预先列入安全白名单的命令。'},
  {key:'allowShellMutation',label:'通过 Shell 修改文件',desc:'允许运行可写入、删除或移动文件的 Shell 命令。'},
  {key:'allowNetworkAccess',label:'网络访问与 SSH',desc:'允许访问网络和连接外部服务器。'},
  {key:'allowCredentialAccess',label:'凭据接口',desc:'允许读取受保护的登录凭据，建议默认关闭。'},
  {key:'allowComputerUse',label:'桌面控制',desc:'允许 AI 操作鼠标、键盘和屏幕，适合受信任的个人环境。'},
  {key:'allowInteractiveProcesses',label:'交互进程',desc:'允许启动需要持续输入输出的终端进程。'},
  {key:'allowPersistentProcesses',label:'持续进程',desc:'允许训练、服务和监控任务在当前操作结束后继续运行。'},
];
const workspace: Permission = {
  profile:'workspace', allowExternalPaths:false, allowArbitraryCommands:false,
  allowShellMutation:false, allowNetworkAccess:true, allowCredentialAccess:false,
  allowComputerUse:false, allowInteractiveProcesses:true, allowPersistentProcesses:true,
};
const fullAccess: Permission = Object.fromEntries([
  ['profile','full-access'],...permissionNames.map(item => [item.key,true]),
]) as unknown as Permission;
function fromConfig(c: Config): Settings {
  return {
    provider: c.localOnly ? 'local' : c.tunnelProvider === 'cloudflare' ? 'cloudflare' : 'ngrok',
    publicBaseUrl: c.publicBaseUrl || '', port: c.port || 7676,
    allowedRoots: Array.isArray(c.allowedRoots) ? c.allowedRoots : [],
    allowAllFixedDrives: c.permissionMode === 'all-drive-roots',
    permissions: c.permissions || workspace, toolMode: c.toolMode || 'full',
    ngrokProxyUrl: c.ngrokProxyUrl || '',
  };
}
const steps = ['欢迎','使用方式','网络连接','工作目录','访问权限','检查配置','部署完成'];

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
    <p className="help">只能访问你选择的真实目录。首次使用需要添加至少一个现有文件夹。</p>
  </div>;
}
function Permissions({value,onChange}: {value: Permission; onChange:(value:Permission)=>void}) {
  const choose = (profile:Permission['profile']) =>
    onChange(profile==='workspace'?{...workspace}:profile==='full-access'?{...fullAccess}:{...value,profile:'custom'});
  return <div className="section">
    <div className="choices permission-choices">
      <Choice selected={value.profile==='workspace'} icon={<ShieldRegular/>} title="工作区访问" caption="只访问指定目录，适合新用户。" onClick={()=>choose('workspace')}/>
      <Choice selected={value.profile==='full-access'} icon={<DesktopRegular/>} title="完全访问" caption="当前 Windows 用户拥有的全部权限。" onClick={()=>choose('full-access')}/>
      <Choice selected={value.profile==='custom'} icon={<SettingsRegular/>} title="自定义" caption="逐项决定文件、命令及桌面权限。" onClick={()=>choose('custom')}/>
    </div>
    {value.profile==='full-access' && <div className="warning"><ShieldRegular/>此预设将允许所有高级操作。请仅在可信的个人电脑上使用。</div>}
    {value.profile==='custom' && <div className="permission-grid">{permissionNames.map(item=><div className="permission" key={item.key}>
      <div><strong>{item.label}</strong><p>{item.desc}</p></div>
      <Switch checked={Boolean(value[item.key])} onChange={(_e,d)=>onChange({...value,[item.key]:d.checked})}/>
    </div>)}</div>}
  </div>;
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
  const [wizard,setWizard] = useState(false);
  const [step,setStep] = useState(0);
  const [busy,setBusy] = useState(false);
  const [progress,setProgress] = useState<Progress|null>(null);
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [dirty,setDirty] = useState(false);
  const [applyPending,setApplyPending] = useState(false);
  const [diagnostic,setDiagnostic] = useState('');
  const [advancedBusy,setAdvancedBusy] = useState(false);
  useEffect(()=>{
    let active=true;
    const unStatus=window.devspace.onStatus(value=>{if(active)setStatus(value);});
    const unProgress=window.devspace.onProgress(value=>{if(active)setProgress(value);});
    window.devspace.initialize().then(data=>{
      if(!active)return;
      setConfig(data.config);setStatus(data.status);setRoot(data.root);setApplyPending(data.applyPending);
      setDraft(fromConfig(data.config));
      if(!data.config.configured){setWizard(true);setStep(0);}
    }).catch(e=>{if(active)setError(getError(e));});
    return ()=>{active=false;unStatus();unProgress();};
  },[]);
  const update = useCallback((change:Partial<Settings>)=>{
    setDraft(prev=>prev?{...prev,...change}:prev);
    setDirty(true);setError('');setNotice('');
  },[]);
  const addFolder=useCallback(async()=>{
    try {
      const folder=await window.devspace.chooseFolder();
      if(folder&&draft&&!draft.allowedRoots.some(v=>v.toLowerCase()===folder.toLowerCase()))
        update({allowedRoots:[...draft.allowedRoots,folder],allowAllFixedDrives:false});
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
  const select=useCallback((name:Page)=>{setPage(name);setWizard(false);setError('');setNotice('');},[]);
  const save=useCallback(async (deploy=false)=>{
    if(!draft)return;
    setBusy(true);setError('');setNotice('');setProgress(null);
    try {
      const previous=await window.devspace.getConfig();
      const result=await window.devspace.save(draft);
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
  const runAdvanced=useCallback(async(action:Parameters<typeof window.devspace.runAction>[0])=>{
    setAdvancedBusy(true);setError('');setNotice('');
    try{
      const result=await window.devspace.runAction(action);
      setDiagnostic(typeof result==='string'?result:JSON.stringify(result,null,2));
      if(action==='restart-local'||action==='restart-tunnel')setNotice('操作已提交，请等待服务状态更新。');
    }catch(e){setError(getError(e));}finally{setAdvancedBusy(false);}
  },[]);
  const isPublic=draft?.provider!=='local';
  const selectedSecret=draft?.provider==='ngrok'?'ngrok':'cloudflare';
  const validStep=useMemo(()=>{
    if(!draft)return false;
    if(step===2&&isPublic) {
      if(!/^https:\/\/[^/\s]+\/?$/.test(draft.publicBaseUrl))return false;
      const present=selectedSecret==='ngrok'?config?.hasNgrokToken:config?.hasCloudflareToken;
      if(!present && !(selectedSecret==='ngrok'?draft.ngrokToken:draft.cloudflareToken))return false;
    }
    if(step===3&&!draft.allowedRoots.length)return false;
    return true;
  },[step,draft,isPublic,config,selectedSecret]);
  if(!draft||!config)return <div className="startup"><Spinner size="large"/><h2>正在连接 DevSpace…</h2><p>{error||'读取本地配置，不会修改现有部署。'}</p></div>;
  return <div className="desktop">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><CodeRegular/></span><span>DevSpace<small>PORTABLE · DEV4</small></span></div>
      <div className="side-group">
        {([['home',<HomeRegular/>,'主页'],['workspaces',<FolderOpenRegular/>,'工作区'],
          ['agents',<ServerRegular/>,'远程服务器'],['extensions',<PlugConnectedRegular/>,'插件与工具'],
          ['tasks',<AppsRegular/>,'续轮任务'],['sessions',<SearchRegular/>,'会话与回退'],
          ['memories',<KeyRegular/>,'Memories'],['oauth',<LockClosedRegular/>,'OAuth 客户端'],
          ['services',<DesktopRegular/>,'服务与桌面控制'],
          ['diagnose',<SearchRegular/>,'日志与诊断']] as const).map(([id,icon,title])=>
          <button type="button" key={id} data-page={id} className={'nav '+(!wizard&&page===id?'active':'')} onClick={()=>select(id)}>{icon}<span>{title}</span></button>)}
      </div>
      <div className="sidebar-bottom"><button data-page="settings" className={'nav '+(!wizard&&page==='settings'?'active':'')} onClick={()=>select('settings')}><SettingsRegular/>设置</button>
        <div className="sidebar-status"><span className={'dot '+(status?.localHealthy?'online':'')}/>{status?.localHealthy?'本地 MCP 已连接':'本地 MCP 未连接'}<small>v1.1.62 dev4</small></div>
      </div>
    </aside>
    <main className="main">
      <header className="topbar"><div><span className="eyebrow">DEVSPACE / {wizard?'首次设置':page.toUpperCase()}</span><h1>{wizard?'设置 DevSpace':{
        home:'控制台',workspaces:'工作区',agents:'远程服务器',extensions:'插件与工具',tasks:'续轮任务',
        sessions:'会话与回退',memories:'Memories',oauth:'OAuth 客户端',services:'服务与桌面控制',
        diagnose:'诊断中心',settings:'设置与权限',
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
            {step===3&&<><h2>选择允许访问的工作目录</h2><p className="muted">无需手写路径；请只添加你希望让 DevSpace 访问的目录。</p>
              <Roots values={draft.allowedRoots} onChange={v=>update({allowedRoots:v,allowAllFixedDrives:false})} onChoose={addFolder}/></>}
            {step===4&&<><h2>选择访问权限</h2><p className="muted">默认使用工作区访问。完全访问意味着允许更广泛的操作。</p>
              <Permissions value={draft.permissions} onChange={v=>update({permissions:v})}/></>}
            {step===5&&<><h2>检查并部署</h2><p className="muted">确认以下配置。部署将注册计划任务并启动服务，不会删除旧数据。</p>
              <div className="review"><div>连接方式<strong>{draft.provider==='local'?'仅本机':draft.provider}</strong></div>
                <div>本地端口<strong>{draft.port}</strong></div><div>工作目录<strong>{draft.allowedRoots.length} 个</strong></div>
                <div>权限预设<strong>{draft.permissions.profile}</strong></div></div>
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
          <p>服务状态与工作区一目了然。插件、任务、会话与系统管理均可直接在新版窗口中操作。</p>
          <div className="hero-actions"><Button appearance="primary" onClick={()=>select('settings')}>配置服务</Button>
            <Button appearance="outline" onClick={()=>select('services')}>服务管理</Button></div></div>
          <div className="metric-grid"><div className="metric"><span className="metric-icon"><DesktopRegular/></span><small>本地 MCP</small><strong>{status?.localHealthy?'已连接':'未连接'}</strong><p>{status?.localUrl}</p></div>
            <div className="metric"><span className="metric-icon"><CloudRegular/></span><small>公网模式（连通性未核验）</small><strong>{status?.provider==='local'?'仅本机':status?.provider}</strong><p>{status?.publicUrl||'未配置公网入口'}</p></div>
            <div className="metric"><span className="metric-icon"><FolderOpenRegular/></span><small>允许的工作目录</small><strong>{config.allowedRoots.length} 个</strong><p>可在工作区页面查看与添加</p></div></div>
          <section className="panel"><div className="section-heading"><h3>快速开始</h3><span>常用操作</span></div><div className="quick-grid">
            <button onClick={()=>select('workspaces')}><FolderOpenRegular/><strong>工作目录</strong><small>查看已授权目录</small></button>
            <button onClick={()=>select('agents')}><ServerRegular/><strong>远程服务</strong><small>登记、配对与维护 Agent</small></button>
            <button onClick={()=>select('diagnose')}><SearchRegular/><strong>检查连接</strong><small>诊断服务运行状态</small></button>
          </div></section></>}
        {!wizard&&page==='settings'&&<><section className="panel"><div className="section-heading"><div><h2>连接与凭据</h2><p>已保存的 Token 以掩码显示，不会发送到渲染器。</p></div></div>
          <div className="choices"><Choice selected={draft.provider==='local'} icon={<DesktopRegular/>} title="仅本机" caption="不使用公网隧道。" onClick={()=>update({provider:'local'})}/>
            <Choice selected={draft.provider==='cloudflare'} icon={<CloudRegular/>} title="Cloudflare" caption="通过已配置的域名连接。" onClick={()=>update({provider:'cloudflare',publicBaseUrl:config.providerUrls?.cloudflare||draft.publicBaseUrl})}/>
            <Choice selected={draft.provider==='ngrok'} icon={<PlugConnectedRegular/>} title="ngrok" caption="使用 ngrok 公网隧道。" onClick={()=>update({provider:'ngrok',publicBaseUrl:config.providerUrls?.ngrok||draft.publicBaseUrl})}/></div>
          <div className="form-grid"><Field label="本地端口"><Input type="number" value={String(draft.port)} onChange={(_e,d)=>update({port:Number(d.value)})}/></Field>
            {isPublic&&<Field label="公网 HTTPS 地址"><Input value={draft.publicBaseUrl} onChange={(_e,d)=>update({publicBaseUrl:d.value})}/></Field>}
            {isPublic&&<Field label={selectedSecret==='ngrok'?'ngrok Authtoken':'Cloudflare Tunnel Token'}>
              <SecretField key={selectedSecret+secretRevision} kind={selectedSecret} configured={selectedSecret==='ngrok'?config.hasNgrokToken:config.hasCloudflareToken}
                value={selectedSecret==='ngrok'?draft.ngrokToken||'':draft.cloudflareToken||''} onChange={v=>update(selectedSecret==='ngrok'?{ngrokToken:v}:{cloudflareToken:v})} onCopy={copy}/></Field>}
            <Field label="Owner Password"><SecretField key={'owner'+secretRevision} kind="owner" configured={config.hasOwnerToken} value={draft.ownerToken||''} onChange={v=>update({ownerToken:v})} onCopy={copy}/></Field></div></section>
          <section className="panel"><div className="section-heading"><h2>工作目录与访问权限</h2></div>
            <Roots values={draft.allowedRoots} onChange={v=>update({allowedRoots:v,allowAllFixedDrives:false})} onChoose={addFolder}/>
            <Permissions value={draft.permissions} onChange={v=>update({permissions:v})}/></section>
          <div className="save-bar"><span>{dirty?'● 有未保存的更改':applyPending?'● 已保存，待应用':'✓ 配置已应用'}</span>
            {dirty&&<Button onClick={()=>{setDraft(fromConfig(config));setDirty(false);}}>放弃更改</Button>}
            <Button appearance={dirty||applyPending?'primary':'outline'} disabled={busy||(!dirty&&!applyPending)} onClick={()=>save(!dirty)}>{busy?'请稍候…':dirty?'保存更改':applyPending?'应用并重启':'配置已应用'}</Button>
            <Button appearance="subtle" onClick={()=>{setWizard(true);setStep(0);}}>首次设置向导</Button></div>
          <section className="panel advanced"><div className="section-heading"><h3>高级服务管理</h3><span>仅在需要时使用</span></div>
            <div className="button-row"><Button disabled={advancedBusy} onClick={()=>runAdvanced('restart-local')}>重启本地 MCP</Button><Button disabled={advancedBusy} onClick={()=>runAdvanced('restart-tunnel')}>重启公网隧道</Button></div></section></>}
        {!wizard&&page==='workspaces'&&<section className="panel"><div className="section-heading"><h2>允许的工作目录</h2><span>{draft.allowedRoots.length} 个</span></div>
          <Roots values={draft.allowedRoots} onChange={v=>update({allowedRoots:v,allowAllFixedDrives:false})} onChoose={addFolder}/>
          <div className="button-row"><Button appearance="primary" disabled={busy||!dirty} onClick={()=>save(false)}>保存目录更改</Button></div></section>}
        {!wizard&&page==='agents'&&<AgentsPage/>}
        {!wizard&&page==='extensions'&&<PluginsPage/>}
        {!wizard&&page==='tasks'&&<ContinuationsPage/>}
        {!wizard&&page==='sessions'&&<SessionsPage/>}
        {!wizard&&page==='memories'&&<MemoriesPage workspaceRoots={draft.allowedRoots}/>}
        {!wizard&&page==='oauth'&&<OAuthPage/>}
        {!wizard&&page==='services'&&<ServicePage config={config} onConfigChange={async()=>setConfig(await window.devspace.getConfig())}/>}
        {!wizard&&page==='diagnose'&&<><section className="panel"><div className="diagnostic-line"><span>本地 MCP</span>
          <strong>{status?.localHealthy?'正常':'未连接'}</strong><code>{status?.localUrl}</code></div>
          <div className="diagnostic-line"><span>公网模式</span><strong>{status?.provider}</strong><code>{status?.publicUrl||'仅本地'}</code></div></section>
          <DiagnosticsPage/></>}
      </div>
    </main>
  </div>;
}
