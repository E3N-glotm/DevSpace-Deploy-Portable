"use strict";
// Desktop-only SSH administration. Preserves WinForms SSH profiles (including
// Windows DPAPI user-scope encryption) while removing the WinForms UI itself.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");

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
    if(password&&!fs.existsSync(askpass))throw new Error("DevSpace SSH password helper is missing.");
    const host=p.host.includes(":")&&!p.host.startsWith("[")?"["+p.host+"]":p.host;
    const args=["-o","ConnectTimeout=10","-o","ConnectionAttempts=2",
      "-o","StrictHostKeyChecking=accept-new","-o","LogLevel=ERROR",
      "-o","BatchMode="+(password?"no":"yes"),
      ...(password?["-o","NumberOfPasswordPrompts=2"]:[]),
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
    if(action==="recover"){
      const agentId=String(payload.agentId||"").trim();
      if(!agentId)throw new Error("Agent ID required to safely recover a remote instance.");
      const roots=Array.isArray(payload.writableRoots)?payload.writableRoots.map(String):[];
      const state=findExistingState(profile,agentId,roots,String(payload.installRoot||""));
      const restart=restartVerifiedState(profile,state);
      return {ok:true,restart,stateVerified:true,agentId};
    }
    if(action==="deploy"){
      const agentId=String(payload.agentId||""),name=String(payload.name||"").trim();
      const accessMode=payload.accessMode==="full-access"?"full-access":"scoped";
      const roots=accessMode==="full-access"?[]:Array.isArray(payload.writableRoots)?
        payload.writableRoots.map(String).map(x=>x.trim()).filter(Boolean):[];
      const requestedRoot=String(payload.installRoot||"").trim();
      if(!name||!requestedRoot||accessMode==="scoped"&&!roots.length)
        throw new Error("Agent name, install root and scoped roots are required.");
      const installRoot=verifyInstallRoot(profile,requestedRoot,accessMode==="full-access");
      // Fail closed if an older installation's state cannot be attributed to
      // the exact Agent ID; the old WinForms UI stopped old state before update.
      const existingState=agentId?findExistingState(profile,agentId,roots,installRoot):"";
      const enroll=await remoteAdmin("create-enrollment",
        {agentId,name,installRoot,accessMode,writableRoots:roots,ttlMinutes:15});
      const sameRoot=existingState && (existingState===installRoot||
        existingState.startsWith(installRoot.replace(/\/+$/,"")+"/"));
      const script=offlineInstall(enroll,name,roots,publicProfile(profile).userName,
        sameRoot?existingState:"");
      if(existingState)stopVerifiedState(profile,existingState);
      const result=execute(profile,script,150000);
      if(result.exitCode!==0)throw new Error("Agent SSH installer failed: "+(result.error||result.output).slice(-1500));
      for(let attempt=0;attempt<8;attempt++){
        const agents=(await remoteAdmin("list",{})).agents||[];
        const found=agents.find(a=>agentId?a.id===agentId:a.name===name);
        if(found&&["online","online-recent"].includes(String(found.status||"").toLowerCase()))
          return {ok:true,agent:found};
        await new Promise(resolve=>setTimeout(resolve,1400));
      }
      throw new Error("Agent installed over SSH, but no healthy heartbeat was observed.");
    }
    throw new Error("Unknown SSH admin action.");
  }
  return {handle,offlineInstall,publicProfile};
}
module.exports={remoteSshAdminFactory};
