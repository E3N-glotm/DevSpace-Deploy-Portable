import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {mkdtempSync,mkdirSync,rmSync,readFileSync,unlinkSync} from "node:fs";
import {spawn} from "node:child_process";
import {join,resolve} from "node:path";

const require=createRequire(import.meta.url);
const {validateAgentUrl}=require("./agent-network.cjs");
const tunnel=require("./ssh-reverse-tunnel.cjs");
const {remoteSshAdminFactory}=require("./remote-ssh-admin.cjs");
const root=resolve(import.meta.dirname||".","..");
const scratch=join(root,".test-cache");
mkdirSync(scratch,{recursive:true});
const temp=mkdtempSync(join(scratch,"ssh-reverse-"));
const key="name:reverse-case";
const localHost="192.168.221.238";
const localPort=7677;
const remotePort=18778;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

try{
  assert.equal(validateAgentUrl("http://127.0.0.1:18778","ssh-reverse"),
    "http://127.0.0.1:18778");
  for(const bad of [
    "http://0.0.0.0:18778","http://localhost:18778",
    "http://192.168.221.238:18778","https://127.0.0.1:18778",
    "http://127.0.0.1:80","http://127.0.0.1:18778/mcp",
    "http://127.0.0.1:18778/?token=abc",
  ])assert.throws(()=>validateAgentUrl(bad,"ssh-reverse"),bad);
  assert.equal(validateAgentUrl("http://192.168.221.238:7677","lan"),
    "http://192.168.221.238:7677");
  assert.equal(validateAgentUrl("https://example.org","internet"),
    "https://example.org");
  const admin=remoteSshAdminFactory({root:temp,
    readJson:()=>({Profiles:[]}),writeJson:()=>{},restrictAcl:()=>{},remoteAdmin:()=>{}});
  const flags=admin.reverseSshArgs(["-p","32891","ht_qh_1@100.200.199.25"],
    {remotePort,localHost,localPort});
  assert.ok(flags.includes("ExitOnForwardFailure=yes"));
  assert.ok(flags.includes("ServerAliveInterval=15"));
  assert.ok(flags.includes("ServerAliveCountMax=3"));
  assert.deepEqual(flags.slice(-4),
    ["-T","-R",`127.0.0.1:${remotePort}:${localHost}:${localPort}`,"ht_qh_1@100.200.199.25"]);
  assert.ok(!flags.includes("0.0.0.0:18778"));
  assert.throws(()=>admin.reverseSshArgs(["user@host"],
    {remotePort,localHost:"8.8.8.8",localPort}));

  const spec=tunnel.writeEntry(temp,{key,localHost,localPort,remotePort,enabled:true});
  assert.equal(spec.serverUrl,`http://127.0.0.1:${remotePort}`);
  assert.deepEqual(tunnel.entries(temp).tunnels[key],spec);
  assert.equal(tunnel.status(temp,key).configured,true);
  assert.equal(tunnel.status(temp,key).active,false);
  assert.throws(()=>tunnel.validateSpec({key,localHost:"0.0.0.0",localPort,remotePort}));
  assert.throws(()=>tunnel.validateSpec({key,localHost,localPort,remotePort:80}));
  assert.throws(()=>tunnel.validateSpec({key:"",localHost,localPort,remotePort}));
  let launches=0,child=null;
  const running=tunnel.supervise(temp,key,{launch:()=>{
    launches++;
    child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],
      {stdio:"ignore",windowsHide:true});
    return child;
  }});
  const until=Date.now()+7000;
  while(Date.now()<until && !tunnel.state(temp,key).active)await sleep(50);
  assert.equal(tunnel.state(temp,key).active,true);
  assert.equal(launches,1);
  child.kill();
  const reconnectDeadline=Date.now()+7000;
  while(Date.now()<reconnectDeadline && launches<2)await sleep(100);
  assert.ok(launches>=2,"an exited SSH process must be restarted by its supervisor");
  await tunnel.stopTunnel(temp,key,{disable:true,timeoutMs:7000});
  await running;
  assert.equal(tunnel.status(temp,key).enabled,false);
  assert.equal(tunnel.status(temp,key).active,false);
  assert.equal(child.killed,true);
  assert.equal(tunnel.reconcile(temp).started,0);
  // Exercise the *production default launch path*: only the SSH factory is
  // stubbed. Passing a custom `launch` here would conceal the parameter-scope
  // ReferenceError which prevented dev11's detached supervisor from working.
  tunnel.writeEntry(temp,{key,localHost,localPort,remotePort,enabled:true});
  unlinkSync(tunnel.stopPath(temp,key));
  let defaultFactoryCalls=0,defaultLaunchCalls=0,defaultChild=null;
  const defaultSupervision=tunnel.supervise(temp,key,{adminFactory:factoryRoot=>{
    assert.equal(factoryRoot,temp);
    defaultFactoryCalls++;
    return {launchReverseSsh:(actualKey,actualSpec)=>{
      assert.equal(actualKey,key);
      assert.deepEqual(actualSpec,spec);
      defaultLaunchCalls++;
      defaultChild=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],
        {stdio:"ignore",windowsHide:true});
      return defaultChild;
    }};
  }});
  const defaultDeadline=Date.now()+6000;
  while(Date.now()<defaultDeadline&&defaultLaunchCalls<1)await sleep(50);
  assert.equal(defaultFactoryCalls,1,"the default SSH launcher must resolve its factory");
  assert.equal(defaultLaunchCalls,1,"the default SSH launcher must capture the initialized spec");
  await tunnel.stopTunnel(temp,key,{disable:true,timeoutMs:7000});
  await defaultSupervision;
  assert.equal(tunnel.status(temp,key).active,false);
  console.log(JSON.stringify({reverseMode:true,loopbackOnly:true,
    samePortWindowsGateway:true,sshFlags:true,
    persistedConfig:true,autoReconnect:true,gracefulStop:true,modeIsolated:true,
    defaultProductionLauncher:true}));
}finally{
  rmSync(temp,{recursive:true,force:true});
}
