"use strict";
// Desktop-only SSH administration. Preserves WinForms SSH profiles (including
// Windows DPAPI user-scope encryption) while removing the WinForms UI itself.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const {validateAgentUrl} = require("./agent-network.cjs");

// The desktop manager reads SQLite in a separate process, not the live
// RemoteAgentManager's in-memory socket set. Consequently an actually
// connected Agent is reported as "online-recent" by this CLI. Require a
// post-action connect AND heartbeat, plus stability across two polls; do not
// mistake the pre-restart grace period for a successful recovery.
function freshOnlineAgent(agent,startedAfter) {
  return Boolean(agent && ["online","online-recent"].includes(String(agent.status||"").toLowerCase())
    && Date.parse(agent.connectedAt||"")>=startedAfter
    && Date.parse(agent.lastSeenAt||"")>=startedAfter);
}

function remoteSshAdminFactory({root, readJson, writeJson, restrictAcl, remoteAdmin}) {
  const profilesPath = path.join(root, "data", "remote-agent-ssh-profiles.json");
  const powerShell = path.join(process.env.SystemRoot || "C:\\Windows", "System32",
    "WindowsPowerShell", "v1.0", "powershell.exe");
  const ssh = [path.join(root,"runtime","git","usr","bin","ssh.exe"),
    path.join(process.env.SystemRoot || "C:\\Windows","System32","OpenSSH","ssh.exe")]
    .find(file=>fs.existsSync(file));
  const askpass = path.join(root,"DevSpace-SshAskPass.exe");
  const assetRoot = path.join(root,"app","node_modules","@waishnav","devspace","dist","linux-agent");
  const pick = (p,upper,lower,defaultValue="") => p?.[upper] ?? p?.[lower] ?? defaultValue;
  const publicProfile = p=>({
    key:String(pick(p,"Key","key")),host:String(pick(p,"Host","host")),
    port:Number(pick(p,"Port","port",22)),userName:String(pick(p,"UserName","userName")),
    autoRecover:Boolean(pick(p,"AutoRecover","autoRecover",true)),
    hasPassword:Boolean(pick(p,"ProtectedPassword","protectedPassword")),
    privateKeyPath:String(pick(p,"PrivateKeyPath","privateKeyPath")),
  });
  function store() {
    const raw=readJson(profilesPath,{Profiles:[]});
    return {Profiles:Array.isArray(raw.Profiles)?raw.Profiles:Array.isArray(raw.profiles)?raw.profiles:[]};
  }
  function persist(data) {
    fs.mkdirSync(path.dirname(profilesPath),{recursive:true});
    writeJson(profilesPath,data);
    restrictAcl(profilesPath);
  }
  function endpoint(p) {
    const host=String(p.host||"").trim(),userName=String(p.userName||"").trim();
    const port=Number(p.port);
    if(!host||!/^[A-Za-z0-9._:\[\]-]+$/.test(host)||host.includes("..")
      || !/^[A-Za-z0-9._-]+$/.test(userName)
      || !Number.isInteger(port)||port<1||port>65535)throw new Error("Invalid SSH host, port or user name.");
    return {host,port,userName};
  }
  function protect(mode, value) {
    if(!value)return "";
    const command=[
      "$ErrorActionPreference='Stop'",
      "Add-Type -AssemblyName System.Security",
      "$raw=[Console]::In.ReadToEnd()",
      "$entropy=[Text.Encoding]::UTF8.GetBytes('DevSpacePortable.RemoteAgentSsh.v1')",
      mode==="encrypt"
        ? "$bytes=[Convert]::FromBase64String($raw);$out=[Security.Cryptography.ProtectedData]::Protect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))"
        : "$bytes=[Convert]::FromBase64String($raw);$out=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($out))",
    ].join(";");
    const input=mode==="encrypt"?Buffer.from(value,"utf8").toString("base64"):value;
    const run=cp.spawnSync(powerShell,["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",command],
      {input,encoding:"utf8",timeout:12000,windowsHide:true,maxBuffer:65536});
    if(run.error||run.status!==0)throw new Error("Current Windows user could not access encrypted SSH credentials.");
    const output=String(run.stdout||"").trim();
    return mode==="encrypt"?output:Buffer.from(output,"base64").toString("utf8");
  }
  function find(key) {
    if(typeof key!=="string"||!key.trim())throw new Error("SSH profile key is required.");
    const profile=store().Profiles.find(p=>String(pick(p,"Key","key")).toLowerCase()===key.trim().toLowerCase());
    if(!profile)throw new Error("Saved SSH profile not found.");
    return profile;
  }
  function execute(profile, script, timeout=30000) {
    if(!ssh)throw new Error("Bundled Git SSH and Windows OpenSSH are missing.");
    const p=publicProfile(profile),password=protect("decrypt",pick(profile,"ProtectedPassword","protectedPassword"));
    const identity=String(p.privateKeyPath||"").trim();
    if(identity&&(!path.isAbsolute(identity)||!fs.existsSync(identity)||!fs.statSync(identity).isFile()))
      throw new Error("SSH 私钥文件不存在或不是有效文件。");
    if(password&&!fs.existsSync(askpass))throw new Error("DevSpace SSH password helper is missing.");
    const host=p.host.includes(":")&&!p.host.startsWith("[")?"["+p.host+"]":p.host;
    const args=["-o","ConnectTimeout=10","-o","ConnectionAttempts=2",
      "-o","StrictHostKeyChecking=accept-new","-o","LogLevel=ERROR",
      "-o","BatchMode="+(password?"no":"yes"),
      ...(password?["-o","NumberOfPasswordPrompts=2"]:[]),
      ...(identity?["-i",identity,"-o","IdentitiesOnly=yes"]:[]),
      "-p",String(p.port),p.userName+"@"+host,"bash","-s"];
    const env={...process.env};
    if(password){env.SSH_ASKPASS=askpass;env.SSH_ASKPASS_REQUIRE="force";
      env.DISPLAY="devspace";env.DEVSPACE_SSH_PASSWORD=password;}
    const result=cp.spawnSync(ssh,args,{cwd:root,input:String(script).replace(/\r\n?/g,"\n")+"\n",
      encoding:"utf8",windowsHide:true,timeout,maxBuffer:1024*1024,env});
    if(result.error)throw new Error("SSH execution timed out or failed to start.");
    return {exitCode:result.status,output:String(result.stdout||"").slice(-6000),
      error:String(result.stderr||"").slice(-3000)};
  }
  const quote=value=>"'"+String(value).replace(/'/g,"'\\''")+"'";
  const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
  function verifyInstallRoot(profile,requested,fullAccess) {
    const script=[
      "set -eu",
      "requested="+quote(requested),
      "full_access="+(fullAccess?"1":"0"),
      'valid_dir() { [ -n "$1" ] && [ "${1#/}" != "$1" ] && [ -d "$1" ] && [ -r "$1" ] && [ -w "$1" ] && [ -x "$1" ]; }',
      'if [ "$full_access" = 1 ] && ! valid_dir "$requested"; then requested="$HOME/.local/state"; mkdir -p "$requested"; fi',
      'valid_dir "$requested" || { echo DEVSPACE_AGENT_INSTALL_ROOT_NOT_WRITABLE >&2; exit 45; }',
      'printf "DEVSPACE_AGENT_INSTALL_ROOT=%s\\n" "$requested"',
    ];
    const result=execute(profile,script.join("\n"),18000);
    const root=result.output.match(/^DEVSPACE_AGENT_INSTALL_ROOT=(.+)$/m)?.[1]?.trim();
    if(result.exitCode!==0||!root||!root.startsWith("/")||/[\r\n\0]/.test(root))
      throw new Error("Cannot verify a writable remote Agent install root: "+(result.error||result.output).slice(-300));
    return root.replace(/\/+$/,"")||"/";
  }
  function findExistingState(profile,agentId,roots,installRoot) {
    if(!agentId||!String(agentId).trim())throw new Error("Existing Agent ID is required.");
    const bases=[installRoot,...roots].filter(Boolean).map(v=>String(v).replace(/\/+$/,"")+"/.devspace-agent");
    const script=[
      "set -eu","agent_id="+quote(agentId),
      "python_bin=$(command -v python3 || command -v python || true)",
      '[ -n "$python_bin" ] || { echo DEVSPACE_AGENT_NO_PYTHON >&2; exit 43; }',
      "for base in "+bases.map(quote).join(" ")+
        ' "$HOME/.local/state/.devspace-agent" "$HOME/.local/state/devspace-agent" "/var/lib/devspace-agent"; do',
      ' for candidate in "$base" "$base"/*; do',
      '  [ -f "$candidate/config.json" ] || continue',
      '  candidate_id=$("$python_bin" - "$candidate/config.json" <<\'PY\'',
      "import json,pathlib,sys",
      "try: print(str(json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')).get('agentId','')))",
      "except Exception: print('')",
      "PY",
      "  )",
      '  [ "$candidate_id" = "$agent_id" ] || continue',
      '  printf "DEVSPACE_AGENT_STATE=%s\\n" "$candidate"',
      "  exit 0",
      " done",
      "done",
      "echo DEVSPACE_AGENT_STATE_NOT_FOUND >&2; exit 44",
    ];
    const result=execute(profile,script.join("\n"),18000);
    const state=result.output.match(/^DEVSPACE_AGENT_STATE=(.+)$/m)?.[1]?.trim();
    if(result.exitCode!==0||!state||!state.startsWith("/")||/[\r\n\0]/.test(state))
      throw new Error("Cannot verify an existing remote state matching the Agent ID; refusing to install another instance.");
    return state.replace(/\/+$/,"");
  }
  function stopVerifiedState(profile,state) {
    // The state was independently matched against agentId, not guessed from
    // an SSH hostname or PID file. Stop only processes whose full argv belongs
    // to that exact state; never indiscriminately pkill Python or other Agents.
    const script=[
      "set -eu","state="+quote(state),
      "python_bin=$(command -v python3 || true)",
      '[ -n "$python_bin" ] || { echo DEVSPACE_AGENT_NO_PYTHON >&2; exit 43; }',
      'state_pids=$("$python_bin" - "$state" "$$" "$PPID" <<\'PY\'',
      "import os,pathlib,sys",
      "state=os.path.normpath(sys.argv[1]); excluded={int(x) for x in sys.argv[2:] if x.isdigit()}",
      "agent=state+'/bin/devspace-agent.py'; config=state+'/config.json'",
      "for f in pathlib.Path('/proc').iterdir():",
      " if not f.name.isdigit() or int(f.name) in excluded: continue",
      " try:",
      "  args=[x.decode('utf-8','surrogateescape') for x in (f/'cmdline').read_bytes().split(b'\\0') if x]",
      " except Exception: continue",
      " direct=agent in args and config in args",
      " tagged=any(a=='--state-dir='+state or (a=='--state-dir' and i+1<len(args) and os.path.normpath(args[i+1])==state) for i,a in enumerate(args))",
      " if direct or tagged: print(f.name)",
      "PY",
      ")",
      'if command -v systemctl >/dev/null 2>&1; then',
      ' if systemctl --user cat devspace-agent.service 2>/dev/null | grep -F -- "$state/" >/dev/null 2>&1; then systemctl --user stop devspace-agent.service || true; fi',
      ' if sudo -n systemctl cat devspace-agent.service 2>/dev/null | grep -F -- "$state/" >/dev/null 2>&1; then sudo -n systemctl stop devspace-agent.service || true; fi',
      "fi",
      'for pid in $state_pids; do kill "$pid" 2>/dev/null || true; done',
      "i=0",
      'while [ "$i" -lt 30 ]; do alive=""; for pid in $state_pids; do if kill -0 "$pid" 2>/dev/null; then alive="$alive $pid"; fi; done',
      ' [ -z "$alive" ] && break; sleep 0.1; i=$((i+1)); done',
      'for pid in $state_pids; do if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi; done',
      'for pid in $state_pids; do',
      ' if kill -0 "$pid" 2>/dev/null; then',
      '  echo DEVSPACE_AGENT_OLD_PROCESS_STILL_RUNNING >&2; exit 46',
      ' fi',
      'done',
      'rm -f "$state/agent.pid"',
      'printf "DEVSPACE_AGENT_STATE_STOPPED=%s\\n" "$state"',
    ];
    const result=execute(profile,script.join("\n"),18000);
    if(result.exitCode!==0||!result.output.includes("DEVSPACE_AGENT_STATE_STOPPED="+state))
      throw new Error("Could not safely stop the verified old Agent state; installation cancelled.");
  }
  function restartVerifiedState(profile,state) {
    // This action never modifies enrollment/configuration or starts a second
    // instance when the recorded Agent process remains alive.
    const script=[
      "set -eu","state="+quote(state),
      '[ -f "$state/config.json" ] && [ -f "$state/bin/devspace-agent.py" ] || exit 44',
      // PID files can be stale or missing. Look for a process bound to this
      // exact state even if the installer did not write its PID file.
      'python_probe=$(command -v python3 || command -v python || true)',
      '[ -n "$python_probe" ] || { echo DEVSPACE_AGENT_NO_PYTHON >&2; exit 43; }',
      'if "$python_probe" - "$state" <<\'PY\'',
      'import pathlib,sys',
      'state=sys.argv[1]; agent=state+"/bin/devspace-agent.py"; config=state+"/config.json"',
      'for p in pathlib.Path("/proc").iterdir():',
      ' if not p.name.isdigit(): continue',
      ' try: args=[a.decode("utf-8","surrogateescape") for a in (p/"cmdline").read_bytes().split(b"\\0") if a]',
      ' except Exception: continue',
      ' if (agent in args and config in args) or any(a=="--state-dir="+state or (a=="--state-dir" and i+1<len(args) and args[i+1]==state) for i,a in enumerate(args)): sys.exit(0)',
      'sys.exit(1)',
      'PY',
      'then echo DEVSPACE_AGENT_ALREADY_RUNNING; exit 0; fi',
      'if [ -f "$state/agent.pid" ]; then pid=$(cat "$state/agent.pid" 2>/dev/null || true); else pid=""; fi',
      'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then',
      ' if [ -f "/proc/$pid/cmdline" ] && tr "\\0" " " <"/proc/$pid/cmdline" | grep -F -- "$state/bin/devspace-agent.py" >/dev/null 2>&1; then',
      '  echo DEVSPACE_AGENT_ALREADY_RUNNING; exit 0',
      ' fi',
      'fi',
      'if command -v systemctl >/dev/null 2>&1; then',
      ' if systemctl --user cat devspace-agent.service 2>/dev/null | grep -F -- "$state/" >/dev/null 2>&1; then',
      '  systemctl --user restart devspace-agent.service && echo DEVSPACE_AGENT_STARTED && exit 0',
      ' fi',
      'fi',
      'python_bin=$(command -v python3 || command -v python || true)',
      '[ -n "$python_bin" ] || { echo DEVSPACE_AGENT_NO_PYTHON >&2; exit 43; }',
      'nohup "$python_bin" "$state/bin/devspace-agent.py" --config "$state/config.json" run >>"$state/agent.log" 2>&1 </dev/null &',
      'pid=$!; printf "%s\\n" "$pid" >"$state/agent.pid"; sleep 1',
      'kill -0 "$pid" 2>/dev/null || { tail -n 8 "$state/agent.log" >&2 || true; exit 45; }',
      'echo DEVSPACE_AGENT_STARTED',
    ];
    const result=execute(profile,script.join("\n"),30000);
    if(result.exitCode!==0||!/(DEVSPACE_AGENT_STARTED|DEVSPACE_AGENT_ALREADY_RUNNING)/.test(result.output))
      throw new Error("Verified remote Agent restart failed: "+(result.error||result.output).slice(-300));
    return result.output.includes("DEVSPACE_AGENT_ALREADY_RUNNING")?"already-running":"started";
  }
  function probeAgentEndpoint(profile,state,desiredUrl="") {
    // An SSH restart is not a connectivity repair if the remote Linux machine
    // cannot reach its configured controller. Probe the *actual* Agent
    // WebSocket route before stopping an identity-verified running process.
    const script=[
      "set -eu","state="+quote(state),"override="+quote(desiredUrl),
      "python3 - \"$state\" \"$override\" <<'PY'",
      "import base64,json,os,pathlib,socket,ssl,sys,urllib.parse",
      "config=json.loads((pathlib.Path(sys.argv[1])/'config.json').read_text())",
      "base=sys.argv[2] or str((config.get('servers') or [config.get('server')])[0])",
      "u=urllib.parse.urlparse(base)",
      "if u.scheme not in ('http','https') or not u.hostname:raise SystemExit('DEVSPACE_AGENT_URL_INVALID')",
      "port=u.port or (443 if u.scheme=='https' else 80)",
      "sock=socket.create_connection((u.hostname,port),timeout=8)",
      "try:",
      " if u.scheme=='https':sock=ssl.create_default_context().wrap_socket(sock,server_hostname=u.hostname)",
      " sock.settimeout(8)",
      " key=base64.b64encode(os.urandom(16)).decode()",
      " host=u.hostname+(':'+str(port) if port not in (80,443) else '')",
      " request='GET /agent/v1/connect HTTP/1.1\\r\\nHost: '+host+'\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: '+key+'\\r\\n\\r\\n'",
      " sock.sendall(request.encode('ascii'))",
      " line=b''",
      " while b'\\r\\n' not in line and len(line)<1024:line+=sock.recv(128)",
      " status=line.split(b'\\r\\n',1)[0].decode('ascii','replace')",
      " print('DEVSPACE_AGENT_WS_STATUS='+status)",
      " if ' 101 ' not in status:raise SystemExit('DEVSPACE_AGENT_WS_NOT_UPGRADED')",
      "finally:sock.close()",
      "PY",
    ];
    const result=execute(profile,script.join("\n"),25000);
    if(result.exitCode!==0||!result.output.includes("DEVSPACE_AGENT_WS_STATUS=HTTP/1.1 101"))
      throw new Error("远程 Linux 无法连接 Agent 服务入口；不重启 Agent。检查 Windows 局域网 IP、监听端口、防火墙或公网隧道。"+
        " "+(result.output||result.error).slice(-450));
    return true;
  }
  async function waitForAgentHeartbeat(agentId,startedAfter=0,timeoutMs=24_000) {
    const deadline=Date.now()+timeoutMs;
    let consecutiveHealthy=0;
    do{
      const agents=(await remoteAdmin("list",{})).agents||[];
      const found=agents.find(x=>x.id===agentId);
      consecutiveHealthy=freshOnlineAgent(found,startedAfter)?consecutiveHealthy+1:0;
      if(consecutiveHealthy>=2)
        return found;
      await new Promise(done=>setTimeout(done,1500));
    }while(Date.now()<deadline);
    throw new Error("Agent SSH process restarted, but no new controller heartbeat was observed.");
  }
  function configureAgentUrl(profile,state,agentId,serverUrl,mode,restore=false) {
    const script=[
      "set -eu","state="+quote(state),"agent_id="+quote(agentId),
      "server="+quote(serverUrl),"mode="+quote(mode),"restore="+(restore?"1":"0"),
      "python3 - \"$state\" \"$agent_id\" \"$server\" \"$mode\" \"$restore\" <<'PY'",
      "import json,os,pathlib,sys,tempfile",
      "state=pathlib.Path(sys.argv[1]); aid,url,mode,restore=sys.argv[2:]",
      "config=state/'config.json'; backup=state/'.agent-network.previous.json'",
      "data=json.loads(config.read_text())",
      "assert data.get('agentId')==aid",
      "if restore=='1':",
      " assert backup.is_file()",
      " content=backup.read_bytes()",
      "else:",
      " backup.write_bytes(config.read_bytes());os.chmod(backup,0o600)",
      " data['server']=url;data['servers']=[url];data['connectionMode']=mode",
      " content=(json.dumps(data,ensure_ascii=False,indent=2)+'\\n').encode()",
      "fd,tmp=tempfile.mkstemp(dir=state,prefix='.agent-network-write-')",
      "try:",
      " with os.fdopen(fd,'wb') as f:f.write(content);f.flush();os.fsync(f.fileno())",
      " os.chmod(tmp,0o600);os.replace(tmp,config)",
      "finally:",
      " if os.path.exists(tmp):os.unlink(tmp)",
      "print('DEVSPACE_AGENT_CONFIG_WRITTEN')",
      "PY",
    ];
    const result=execute(profile,script.join("\n"),16000);
    if(result.exitCode!==0||!result.output.includes("DEVSPACE_AGENT_CONFIG_WRITTEN"))
      throw new Error("Failed to save Agent connection settings: "+(result.error||result.output).slice(-400));
  }
  function offlineInstall(enrollment,name,roots,sshUser,stateDirOverride="") {
    const data=enrollment.enrollment||{};
    const files=["install.sh","devspace-agent.py"].map(file=>{
      const full=path.join(assetRoot,file);
      if(!fs.existsSync(full))throw new Error("Bundled Linux Agent asset missing: "+file);
      return fs.readFileSync(full);
    });
    if(enrollment.installerSha256 && hash(files[0])!==String(enrollment.installerSha256).toLowerCase()
      || enrollment.agentSha256 && hash(files[1])!==String(enrollment.agentSha256).toLowerCase())
      throw new Error("Bundled Agent SHA-256 does not match the enrollment metadata.");
    const accessMode=data.accessMode==="full-access"?"full-access":"scoped";
    const script=[
      "set -eu",
      "python_bin=$(command -v python3 || true)",
      'test -n "$python_bin" || { echo DEVSPACE_AGENT_NO_PYTHON >&2; exit 43; }',
      'tmp_dir=$(mktemp -d)',
      'trap \'rm -rf "$tmp_dir"\' EXIT',
    ];
    for(const [i,file] of ["install.sh","devspace-agent.py"].entries()){
      script.push('"$python_bin" - "$tmp_dir/'+file+'" <<\'DEVSPACE_ASSET_'+i+'\'');
      script.push("import base64,pathlib,sys");
      script.push("pathlib.Path(sys.argv[1]).write_bytes(base64.b64decode("+JSON.stringify(files[i].toString("base64"))+"))");
      script.push("DEVSPACE_ASSET_"+i);
    }
    script.push('chmod 0700 "$tmp_dir/install.sh"');
    const args=["--server",enrollment.serverUrl,"--token",data.token,"--name",name,
      "--agent-sha256",hash(files[1]),"--access-mode",accessMode,
      "--install-root",data.installRoot||enrollment.installRoot,
      "--state-dir",stateDirOverride||enrollment.stateDir,"--agent-file",'"$tmp_dir/devspace-agent.py"'];
    args.push("--connection-mode",enrollment.connectionMode==="lan"?"lan":"internet");
    if(!args[1]||!args[3]||!args[13])throw new Error("Enrollment missing required server, token, or state directory.");
    if(sshUser==="root")args.push("--user","root","--allow-root-service");
    if(accessMode!=="full-access")for(const writableRoot of roots)args.push("--writable-root",writableRoot);
    script.push('bash "$tmp_dir/install.sh" '+args.map(v=>v==='"$tmp_dir/devspace-agent.py"'?v:quote(v)).join(" "));
    return script.join("\n");
  }
  async function handle(action,payload={}) {
    if(action==="list")return {profiles:store().Profiles.map(publicProfile)};
    if(action==="save"){
      const key=String(payload.key||"").trim();if(!key||key.length>300)throw new Error("Invalid SSH profile key.");
      const p=endpoint(payload),s=store();
      let target=s.Profiles.find(v=>String(pick(v,"Key","key")).toLowerCase()===key.toLowerCase());
      if(!target){target={Key:key};s.Profiles.push(target);}
      Object.assign(target,{Key:key,Host:p.host,Port:p.port,UserName:p.userName,AutoRecover:payload.autoRecover!==false});
      if(typeof payload.privateKeyPath==="string"){
        const identity=payload.privateKeyPath.trim();
        if(identity&&(!path.isAbsolute(identity)||!fs.existsSync(identity)||!fs.statSync(identity).isFile()))
          throw new Error("SSH 私钥路径无效，请选择 Windows 上已有的私钥文件。");
        target.PrivateKeyPath=identity;
        if(identity)target.ProtectedPassword="";
      }
      if(payload.clearPassword===true)target.ProtectedPassword="";
      else if(typeof payload.password==="string"&&payload.password.length){
        if(payload.password.length>4096)throw new Error("SSH password too long.");
        target.ProtectedPassword=protect("encrypt",payload.password);
      }
      persist(s);return {ok:true,profile:publicProfile(target)};
    }
    if(action==="delete"){
      const s=store(),key=String(payload.key||"");
      if(!key)throw new Error("SSH profile key required.");
      const count=s.Profiles.length;
      s.Profiles=s.Profiles.filter(v=>String(pick(v,"Key","key")).toLowerCase()!==key.toLowerCase());
      persist(s);return {ok:true,deleted:s.Profiles.length!==count};
    }
    const profile=find(payload.key);
    if(action==="test"){
      const result=execute(profile,"set -e\nprintf 'DEVSPACE_SSH_OK\\n'\nuname -s 2>/dev/null || true\nhostname 2>/dev/null || true",25000);
      if(result.exitCode!==0||!result.output.includes("DEVSPACE_SSH_OK"))throw new Error("SSH test failed: "+result.error);
      return {ok:true,host:publicProfile(profile).host,output:result.output.slice(0,1500)};
    }
    if(action==="inspect-agent-147"||action==="upgrade-agent-147"){
      // Explicit maintenance on an already enrolled identity. Never create
      // enrollment tokens, touch Agent configuration, or stop other workloads.
      const agentId=String(payload.agentId||"").trim();
      const installRoot=String(payload.installRoot||"").trim();
      if(!/^agent_[a-z0-9]{6,32}$/i.test(agentId)||!installRoot.startsWith("/")||installRoot==="/")
        throw new Error("Exact enrolled Agent ID and installation root are required.");
      const state=findExistingState(profile,agentId,[],installRoot);
      const inspectScript=[
        "set -eu","state="+quote(state),"agent_id="+quote(agentId),
        "python3 - \"$state\" \"$agent_id\" <<'PY'",
        "import ast,hashlib,json,pathlib,sys",
        "p=pathlib.Path(sys.argv[1]); aid=sys.argv[2]",
        "config=(p/'config.json').read_bytes()",
        "assert json.loads(config).get('agentId')==aid",
        "data=(p/'bin/devspace-agent.py').read_bytes()",
        "tree=ast.parse(data)",
        "v=next(n.value.value for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='AGENT_VERSION' for t in n.targets))",
        "processes=[]",
        "for proc in pathlib.Path('/proc').iterdir():",
        " if not proc.name.isdigit():continue",
        " try:",
        "  argv=[a.decode('utf8','replace') for a in (proc/'cmdline').read_bytes().split(b'\\0') if a]",
        "  if str(p/'bin/devspace-agent.py') in argv and str(p/'config.json') in argv:processes.append(int(proc.name))",
        " except (OSError,PermissionError): pass",
        "print('DEVSPACE_AGENT_INSPECT='+json.dumps({'agentId':aid,'state':str(p),'version':v,'binarySha256':hashlib.sha256(data).hexdigest(),'configSha256':hashlib.sha256(config).hexdigest(),'processes':processes}))",
        "PY",
      ];
      const inspect=()=>{
        const result=execute(profile,inspectScript.join("\n"),22000);
        if(result.exitCode!==0)throw new Error("Agent identity inspection failed: "+(result.error||result.output).slice(-350));
        const line=result.output.match(/^DEVSPACE_AGENT_INSPECT=(.+)$/m)?.[1];
        if(!line)throw new Error("Agent inspection returned no identity proof.");
        const found=JSON.parse(line);
        if(found.agentId!==agentId||found.state!==state)throw new Error("Inspected Agent identity does not match requested state.");
        return found;
      };
      const previous=inspect();
      if(action==="inspect-agent-147")return {ok:true,...previous};
      if(String(payload.expectedAgentVersion)!=="1.1.47")
        throw new Error("Explicit upgrade approval for Agent 1.1.47 is required.");
      const original=fs.readFileSync(path.join(assetRoot,"devspace-agent.py"));
      const source=original.toString("utf8");
      if(!/^AGENT_VERSION = "1\.1\.47"$/m.test(source)
        ||!source.includes("self._received_after_headers.extend(remainder)")
        ||!source.includes('"reason": "not-newer"'))
        throw new Error("Local Agent source lacks the tested 1.1.47 handshake/downgrade guards.");
      const expected=hash(original);
      const stageScript=[
        "set -eu","state="+quote(state),"agent_id="+quote(agentId),
        "python3 - \"$state\" \"$agent_id\" <<'PY'",
        "import ast,base64,hashlib,json,os,pathlib,sys",
        "state=pathlib.Path(sys.argv[1]); aid=sys.argv[2]",
        "assert json.loads((state/'config.json').read_text()).get('agentId')==aid",
        "payload=base64.b64decode("+JSON.stringify(original.toString("base64"))+")",
        "assert hashlib.sha256(payload).hexdigest()=="+JSON.stringify(expected),
        "ast.parse(payload.decode('utf8'))",
        "target=state/'bin/.devspace-agent.1.1.47.staged'",
        "target.write_bytes(payload); os.chmod(target,0o755)",
        "print('STAGED_SHA256='+hashlib.sha256(target.read_bytes()).hexdigest())",
        "PY",
        'python3 "$state/bin/.devspace-agent.1.1.47.staged" self-test',
      ];
      const stage=execute(profile,stageScript.join("\n"),60000);
      if(stage.exitCode!==0||!stage.output.includes("STAGED_SHA256="+expected)
        ||!stage.output.includes('"passed": true'))
        throw new Error("Agent staging/self-test failed; running Agent untouched: "+(stage.error||stage.output).slice(-400));
      const backupScript=[
        "set -eu","state="+quote(state),
        'old="$state/bin/devspace-agent.py"; backup="$state/bin/.devspace-agent.1.1.46.backup"',
        '[ -f "$backup" ] || cp -p "$old" "$backup"',
        'test -s "$backup" && echo DEVSPACE_AGENT_BACKUP_READY',
      ];
      const backup=execute(profile,backupScript.join("\n"),18000);
      if(backup.exitCode!==0||!backup.output.includes("DEVSPACE_AGENT_BACKUP_READY"))
        throw new Error("Could not back up Agent; running Agent untouched.");
      const restoreScript=[
        "set -eu","state="+quote(state),
        'cp -p "$state/bin/.devspace-agent.1.1.46.backup" "$state/bin/devspace-agent.py"',
      ];
      try{
        stopVerifiedState(profile,state);
        const replaceScript=[
          "set -eu","state="+quote(state),"expected="+quote(expected),
          "python3 - \"$state\" \"$expected\" <<'PY'",
          "import hashlib,os,pathlib,sys",
          "p=pathlib.Path(sys.argv[1]); staged=p/'bin/.devspace-agent.1.1.47.staged'",
          "assert hashlib.sha256(staged.read_bytes()).hexdigest()==sys.argv[2]",
          "os.replace(staged,p/'bin/devspace-agent.py')",
          "print('AGENT_REPLACED='+sys.argv[2])",
          "PY",
        ];
        const replaced=execute(profile,replaceScript.join("\n"),18000);
        if(replaced.exitCode!==0||!replaced.output.includes("AGENT_REPLACED="+expected))
          throw new Error("Verified Agent replacement failed.");
        const restart=restartVerifiedState(profile,state);
        const result=inspect();
        if(result.version!=="1.1.47"||result.binarySha256!==expected
          ||result.configSha256!==previous.configSha256||result.processes.length===0)
          throw new Error("New Agent failed post-restart identity/version/config verification.");
        return {ok:true,agentId,state,fromVersion:previous.version,version:result.version,
          binarySha256:result.binarySha256,configPreserved:true,processes:result.processes,restart};
      }catch(error){
        const restore=execute(profile,restoreScript.join("\n"),18000);
        if(restore.exitCode!==0)throw new Error("Agent update failed and binary rollback FAILED: "+error.message);
        const restart=restartVerifiedState(profile,state);
        throw new Error("Agent update failed; old binary restored and "+restart+": "+error.message);
      }
    }
    if(action==="probe"){
      const agentId=String(payload.agentId||"").trim();
      if(!agentId)throw new Error("Agent ID required for an identity-fenced endpoint probe.");
      const state=findExistingState(profile,agentId,[],String(payload.installRoot||""));
      const mode=payload.connectionMode==="lan"?"lan":"internet";
      const url=payload.serverUrl?validateAgentUrl(payload.serverUrl,mode):"";
      probeAgentEndpoint(profile,state,url);
      return {ok:true,agentId,endpointReachable:true,mode,checkedVia:"read-only SSH WebSocket HTTP 101 probe"};
    }
    if(action==="recover"){
      const agentId=String(payload.agentId||"").trim();
      if(!agentId)throw new Error("Agent ID required to safely recover a remote instance.");
      const roots=Array.isArray(payload.writableRoots)?payload.writableRoots.map(String):[];
      const state=findExistingState(profile,agentId,roots,String(payload.installRoot||""));
      probeAgentEndpoint(profile,state);
      const restartedAfter=Date.now();
      // A live but wedged Agent is the common failure case: the previous
      // restartVerifiedState returned "already-running" and did nothing.
      // Only the exact enrolled state is stopped, never all Python processes.
      stopVerifiedState(profile,state);
      const restart=restartVerifiedState(profile,state);
      const agent=await waitForAgentHeartbeat(agentId,restartedAfter);
      return {ok:true,restart,stateVerified:true,agentId,agent};
    }
    if(action==="switch-network"){
      const agentId=String(payload.agentId||"").trim();
      const mode=String(payload.connectionMode||"");
      const serverUrl=validateAgentUrl(payload.serverUrl,mode);
      const state=findExistingState(profile,agentId,[],String(payload.installRoot||""));
      probeAgentEndpoint(profile,state,serverUrl);
      // Back up the exact config before touching the process. Roll back on
      // any failure, including an unreachable new address / lost heartbeat.
      configureAgentUrl(profile,state,agentId,serverUrl,mode);
      try{
        const restartedAfter=Date.now();
        stopVerifiedState(profile,state);
        restartVerifiedState(profile,state);
        const agent=await waitForAgentHeartbeat(agentId,restartedAfter);
        return {ok:true,agentId,connectionMode:mode,serverUrl,agent};
      }catch(error){
        configureAgentUrl(profile,state,agentId,serverUrl,mode,true);
        stopVerifiedState(profile,state);
        restartVerifiedState(profile,state);
        throw new Error("切换连接方式失败，已恢复旧配置并重启原 Agent："+error.message);
      }
    }
    if(action==="deploy"){
      const agentId=String(payload.agentId||""),name=String(payload.name||"").trim();
      const connectionMode=payload.connectionMode==="lan"?"lan":"internet";
      const serverUrl=payload.serverUrl
        ? validateAgentUrl(payload.serverUrl,connectionMode) : "";
      if(connectionMode==="lan"&&!serverUrl)
        throw new Error("LAN Agent SSH deployment requires the Windows LAN Agent URL.");
      const accessMode=payload.accessMode==="full-access"?"full-access":"scoped";
      const roots=accessMode==="full-access"?[]:Array.isArray(payload.writableRoots)?
        [...new Set(payload.writableRoots.map(String).map(x=>x.trim()).filter(Boolean))]:[];
      if(accessMode==="scoped" && (roots.length>32 || roots.some(root=>
        !root.startsWith("/") || root.length>1024 || /[\x00-\x1f]/.test(root) ||
        root.split("/").some(segment=>segment==="."||segment==="..")))) {
        throw new Error("Scoped Agent roots must be valid absolute Linux directories.");
      }
      const requestedRoot=String(payload.installRoot||"").trim();
      if(!name||!requestedRoot||accessMode==="scoped"&&!roots.length)
        throw new Error("Agent name, install root and scoped roots are required.");
      const installRoot=verifyInstallRoot(profile,requestedRoot,accessMode==="full-access");
      // Fail closed if an older installation's state cannot be attributed to
      // the exact Agent ID; the old WinForms UI stopped old state before update.
      const existingState=agentId?findExistingState(profile,agentId,roots,installRoot):"";
      const enroll=await remoteAdmin("create-enrollment",
        {agentId,name,installRoot,accessMode,writableRoots:roots,ttlMinutes:15,
          connectionMode,...(serverUrl?{serverUrl}:{})});
      const sameRoot=existingState && (existingState===installRoot||
        existingState.startsWith(installRoot.replace(/\/+$/,"")+"/"));
      const script=offlineInstall(enroll,name,roots,publicProfile(profile).userName,
        sameRoot?existingState:"");
      if(existingState)stopVerifiedState(profile,existingState);
      // Accept only a *new* live connection, never a stale heartbeat from
      // the pre-deployment instance that still falls in the grace window.
      const startedAfter=Date.now();
      const result=execute(profile,script,150000);
      if(result.exitCode!==0)throw new Error("Agent SSH installer failed: "+(result.error||result.output).slice(-1500));
      let consecutiveHealthy=0;
      for(let attempt=0;attempt<8;attempt++){
        const agents=(await remoteAdmin("list",{})).agents||[];
        const found=agents.find(a=>agentId?a.id===agentId:a.name===name);
        consecutiveHealthy=freshOnlineAgent(found,startedAfter)?consecutiveHealthy+1:0;
        if(consecutiveHealthy>=2)
          return {ok:true,agent:found};
        await new Promise(resolve=>setTimeout(resolve,1400));
      }
      throw new Error("Agent installed over SSH, but no healthy heartbeat was observed.");
    }
    throw new Error("Unknown SSH admin action.");
  }
  return {handle,offlineInstall,publicProfile};
}
module.exports={remoteSshAdminFactory,freshOnlineAgent};
