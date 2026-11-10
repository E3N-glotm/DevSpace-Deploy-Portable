"use strict";
// Portable-owned SSH reverse tunnel supervision. This process is independent
// of the short-lived desktop admin CLI and of the Electron window. Secrets
// remain in the existing DPAPI-protected SSH profile store.
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const cp=require("node:child_process");
const {remoteSshAdminFactory}=require("./remote-ssh-admin.cjs");
const {privateIpv4,validateAgentUrl}=require("./agent-network.cjs");

function keyId(key) {
  if(typeof key!=="string"||!key||key.length>300)throw new Error("SSH reverse profile key is invalid.");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0,24);
}
function locations(root) {
  return {
    config:path.join(process.env.DEVSPACE_PORTABLE_CONFIG_DIR||
      path.join(root,"data","config"),"ssh-reverse-tunnels.json"),
    run:path.join(root,"data","run","ssh-reverse"),
  };
}
function readJson(file,fallback) {
  try{return JSON.parse(fs.readFileSync(file,"utf8"));}
  catch(error){if(error.code==="ENOENT")return fallback;throw error;}
}
function atomicJson(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const next=file+"."+process.pid+".tmp";
  fs.writeFileSync(next,JSON.stringify(value,null,2)+"\n",{mode:0o600});
  fs.renameSync(next,file);
}
function entries(root){return readJson(locations(root).config,{formatVersion:1,tunnels:{}});}
function validateSpec(spec) {
  const key=String(spec?.key||"");
  keyId(key);
  const remotePort=Number(spec.remotePort),localPort=Number(spec.localPort);
  if(!privateIpv4(spec.localHost)||!Number.isInteger(localPort)||localPort<1024||localPort>65535
    ||!Number.isInteger(remotePort)||remotePort<1024||remotePort>65535)
    throw new Error("Reverse tunnel requires a private Windows Agent gateway and non-privileged ports.");
  const serverUrl=validateAgentUrl(`http://127.0.0.1:${remotePort}`,"ssh-reverse");
  return {key,remotePort,localHost:spec.localHost,localPort,serverUrl,enabled:spec.enabled!==false};
}
function statePath(root,key){return path.join(locations(root).run,keyId(key)+".json");}
function stopPath(root,key){return path.join(locations(root).run,keyId(key)+".stop");}
function isAlive(pid) {
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch{return false;}
}
function state(root,key) {
  const p=statePath(root,key);
  const x=readJson(p,{});
  const recent=Date.now()-Date.parse(x.updatedAt||"")<15000;
  const active=recent&&isAlive(x.pid)&&["starting","running","reconnecting"].includes(x.state);
  return {active,phase:active?x.state:"stopped",pid:active?x.pid:0,
    sshPid:active?Number(x.sshPid||0):0,
    attempts:Number(x.attempts||0),updatedAt:x.updatedAt||null,
    lastConnectedAt:x.lastConnectedAt||null};
}
function status(root,key) {
  const spec=entries(root).tunnels[key];
  if(!spec)return {configured:false,active:false,phase:"not-configured"};
  return {configured:true,enabled:spec.enabled===true,
    serverUrl:spec.serverUrl,localHost:spec.localHost,
    localPort:spec.localPort,remotePort:spec.remotePort,...state(root,key)};
}
function writeEntry(root,spec) {
  const normalized=validateSpec(spec);
  const config=entries(root);
  if(!config.tunnels||typeof config.tunnels!=="object")config.tunnels={};
  config.tunnels[normalized.key]=normalized;
  atomicJson(locations(root).config,config);
  return normalized;
}
function spawnSupervisor(root,key) {
  const spec=entries(root).tunnels[key];
  if(!spec?.enabled)throw new Error("SSH reverse tunnel is disabled or not configured.");
  if(state(root,key).active)return status(root,key);
  const stop=stopPath(root,key);
  if(fs.existsSync(stop))fs.unlinkSync(stop);
  const node=path.join(root,"runtime","node","node.exe");
  const executable=fs.existsSync(node)?node:process.execPath;
  const proc=cp.spawn(executable,[path.join(root,"setup","ssh-reverse-tunnel.cjs"),"supervise",key],
    {cwd:root,detached:true,stdio:"ignore",windowsHide:true,
      env:{...process.env,DEVSPACE_PORTABLE_ROOT:root}});
  proc.unref();
  return {configured:true,enabled:true,serverUrl:spec.serverUrl,starting:true,pid:proc.pid};
}
async function stopTunnel(root,key,{disable=false,timeoutMs=7000}={}) {
  const config=entries(root);
  if(disable&&config.tunnels?.[key]){
    config.tunnels[key].enabled=false;
    atomicJson(locations(root).config,config);
  }
  fs.mkdirSync(locations(root).run,{recursive:true});
  fs.writeFileSync(stopPath(root,key),"stop\n",{mode:0o600});
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline&&state(root,key).active)
    await new Promise(resolve=>setTimeout(resolve,250));
  if(state(root,key).active)throw new Error("SSH reverse tunnel did not stop; will not kill an unverified PID.");
  return {ok:true,stopped:true};
}
async function stopAll(root) {
  const cfg=entries(root);
  const stopped=[];
  for(const key of Object.keys(cfg.tunnels||{})){
    try{await stopTunnel(root,key,{disable:false});stopped.push(key);}
    catch(error){throw new Error("Could not safely stop an owned SSH reverse supervisor: "+key);}
  }
  return {stopped:stopped.length};
}
function requestStopAll(root) {
  const run=locations(root).run;
  fs.mkdirSync(run,{recursive:true});
  for(const key of Object.keys(entries(root).tunnels||{}))
    fs.writeFileSync(stopPath(root,key),"stop\n",{mode:0o600});
}
function reconcile(root) {
  const started=[];
  for(const [key,spec] of Object.entries(entries(root).tunnels||{})){
    if(spec.enabled&& !state(root,key).active){
      try{spawnSupervisor(root,key);started.push(key);}
      catch(error){ /* no credentials or network failures go to renderer */ }
    }
  }
  return {started:started.length};
}
function makeAdmin(root) {
  const {readJson:read}= {readJson};
  return remoteSshAdminFactory({root,readJson:read,
    writeJson:atomicJson,restrictAcl:()=>{},
    remoteAdmin:()=>{throw new Error("Agent enrollment is not available to the tunnel supervisor.");}});
}
async function supervise(root,key,{launch,adminFactory=makeAdmin}={}) {
  const spec=entries(root).tunnels[key];
  if(!spec?.enabled)return;
  // Default-parameter expressions have a separate lexical scope in JS and
  // cannot reference `spec` declared in the function body. Construct the
  // production launcher only after the specification has been initialized.
  // Previously the implicit launcher threw ReferenceError before SSH spawned;
  // tests passing a custom `launch` accidentally missed the production path.
  const launchSsh=launch||(()=>adminFactory(root).launchReverseSsh(key,spec));
  const run=locations(root).run;
  fs.mkdirSync(run,{recursive:true});
  const statusFile=statePath(root,key),stopFile=stopPath(root,key);
  let child=null,stopping=false,attempts=0,lastConnectedAt=null,lastPhase="starting";
  const record=()=>atomicJson(statusFile,{pid:process.pid,sshPid:child?.pid||0,
    state:lastPhase,attempts,updatedAt:new Date().toISOString(),lastConnectedAt});
  const shutdown=()=>{stopping=true;if(child&&!child.killed)child.kill();};
  process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
  const sleep=ms=>new Promise(done=>setTimeout(done,ms));
  try{
    while(!stopping){
      const live=entries(root).tunnels[key];
      if(!live?.enabled||fs.existsSync(stopFile)||
        JSON.stringify(live)!==JSON.stringify(spec))break;
      attempts++;
      lastPhase="starting";record();
      let exited=false;
      try{
        child=launchSsh();
        child.once("error",()=>{exited=true;});
        child.once("exit",()=>{exited=true;});
      }catch{exited=true;}
      let ticks=0;
      while(!stopping&&!exited&&!fs.existsSync(stopFile)&&entries(root).tunnels[key]?.enabled){
        if(++ticks===3){lastPhase="running";lastConnectedAt=new Date().toISOString();}
        record();
        await sleep(1000);
      }
      if(child&&!exited){child.kill();await sleep(300);}
      child=null;
      if(stopping||fs.existsSync(stopFile)||!entries(root).tunnels[key]?.enabled)break;
      lastPhase="reconnecting";record();
      const retryMs=Math.min(30000,Math.max(1000,Math.pow(2,Math.min(attempts,5))*1000));
      for(let i=0;i<retryMs/1000&&!stopping&&!fs.existsSync(stopFile);i++){
        record();await sleep(1000);
      }
    }
  }finally{
    shutdown();lastPhase="stopped";record();
    process.off("SIGTERM",shutdown);process.off("SIGINT",shutdown);
  }
}
if(require.main===module){
  const command=process.argv[2],key=process.argv[3],root=process.env.DEVSPACE_PORTABLE_ROOT||path.resolve(__dirname,"..");
  if(command==="supervise")supervise(root,key).catch(()=>process.exitCode=1);
  else if(command==="reconcile"){console.log(JSON.stringify(reconcile(root)));}
  else {process.exitCode=2;}
}
module.exports={keyId,validateSpec,locations,entries,writeEntry,state,status,
  spawnSupervisor,stopTunnel,stopPath,stopAll,requestStopAll,reconcile,makeAdmin,supervise};
