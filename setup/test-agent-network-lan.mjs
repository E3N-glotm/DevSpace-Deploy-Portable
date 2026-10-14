import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {createServer} from "node:net";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createRequire} from "node:module";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const require=createRequire(import.meta.url);
const {validateAgentUrl,validateLanSettings,lanControllerAddress,resolveLanControllerAddress}=require("../setup/agent-network.cjs");
const core=join(root,"app","node_modules","@waishnav","devspace","dist");
const {startAgentLanGateway}=await import(pathToFileURL(join(core,"agent-lan-gateway.js")));
const {RemoteAgentManager}=await import(pathToFileURL(join(core,"remote-agent-manager.js")));
const {remoteAgentAdmin}=await import(pathToFileURL(join(core,"remote-agent-store.js")));
const WebSocket=require(join(root,"app","node_modules","ws"));

assert.equal(validateAgentUrl("http://192.168.1.8:7677","lan"),"http://192.168.1.8:7677");
assert.equal(validateAgentUrl("https://agent.example.com","internet"),"https://agent.example.com");
for(const bad of ["http://8.8.8.8:7677","http://127.0.0.1:7677","https://192.168.1.8:7677",
  "http://192.168.1.8:7677/mcp","http://192.168.1.8:7677?token=x"])
  assert.throws(()=>validateAgentUrl(bad,"lan"));
assert.throws(()=>validateAgentUrl("http://public.example.com","internet"));
assert.throws(()=>validateLanSettings({enabled:true,port:22}));
const multiNic={
  lan:[{family:"IPv4",internal:false,address:"192.168.10.5",netmask:"255.255.255.0"}],
  vpn:[{family:"IPv4",internal:false,address:"10.12.0.2",netmask:"255.255.0.0"}],
};
assert.equal(lanControllerAddress("10.12.33.10",multiNic),"10.12.0.2");
assert.equal(lanControllerAddress("192.168.10.50",multiNic),"192.168.10.5");
assert.equal(lanControllerAddress("172.20.1.9",multiNic,"192.168.10.5"),"192.168.10.5");
assert.throws(()=>lanControllerAddress("172.20.1.9",multiNic),/无法自动确定/);
assert.equal(lanControllerAddress("172.20.1.9",{lan:multiNic.lan}),"192.168.10.5");
assert.equal(await resolveLanControllerAddress("172.39.60.12",55301,multiNic,"",async()=>"10.12.0.2"),"10.12.0.2");
assert.equal(await resolveLanControllerAddress("192.168.10.50",22,multiNic,"",async()=>{throw Error("offline");}),"192.168.10.5");
await assert.rejects(resolveLanControllerAddress("172.39.60.12",55301,multiNic,"",async()=>"8.8.8.8"),/无法自动确定/);

mkdirSync(join(root,"reports"),{recursive:true});
const temp=mkdtempSync(join(root,"reports",".tmp-lan-gateway-"));
let gateway,agent;
const oldConfigDir=process.env.DEVSPACE_CONFIG_DIR;
const oldPortableConfigDir=process.env.DEVSPACE_PORTABLE_CONFIG_DIR;
delete process.env.DEVSPACE_CONFIG_DIR;
delete process.env.DEVSPACE_PORTABLE_CONFIG_DIR;
try{
  mkdirSync(join(temp,"data","config"),{recursive:true});
  const socket=createServer();
  await new Promise(resolve=>socket.listen(0,"127.0.0.1",resolve));
  const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  writeFileSync(join(temp,"data","config","agent-network.json"),
    JSON.stringify({enabled:true,port,bindHost:"0.0.0.0"}));
  const config={stateDir:join(temp,"data","state"),host:"127.0.0.1",allowedHosts:["localhost","127.0.0.1"],
    publicBaseUrl:"https://agent.example.com"};
  agent=new RemoteAgentManager(config,{appendEvent(){}});
  gateway=await startAgentLanGateway(config,agent);
  const endpoint="http://127.0.0.1:"+port;
  const script=await fetch(endpoint+"/agent/v1/devspace-agent.py");
  assert.equal(script.status,200);
  const bytes=Buffer.from(await script.arrayBuffer());
  assert.equal(script.headers.get("x-content-sha256"),createHash("sha256").update(bytes).digest("hex"));
  assert.match(bytes.toString("utf8"),/AGENT_VERSION = "1\.1\.48"/);
  assert.equal((await fetch(endpoint+"/mcp")).status,404);
  assert.equal((await fetch(endpoint+"/oauth/authorize")).status,404);
  assert.equal((await fetch(endpoint+"/agent/v1/install.sh")).status,200);
  const registered=remoteAgentAdmin({stateDir:config.stateDir,action:"create-enrollment",
    payload:{name:"lan-new",installRoot:"/home/ubuntu",accessMode:"full-access",
      connectionMode:"lan",serverUrl:"http://192.168.1.30:"+port},publicBaseUrl:"https://agent.example.com"});
  assert.equal(registered.connectionMode,"lan");
  assert.match(registered.installCommand,/--connection-mode 'lan'/);
  assert.match(registered.installCommand,/curl -fsSL 'http:\/\/192\.168\.1\.30:/);
  const enrollment=agent.store.createEnrollment({name:"lan-test-agent",accessMode:"full-access",
    writableRoots:[],installRoot:"/home/ubuntu"});
  const ws=new WebSocket("ws://127.0.0.1:"+port+"/agent/v1/connect",{headers:{Host:"192.168.1.30:"+port}});
  const ack=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("LAN hello timeout")),5000);
    ws.on("open",()=>ws.send(JSON.stringify({type:"hello",protocol:1,enrollmentToken:enrollment.token,
      hostname:"mock-host",platform:"linux-x64",agentVersion:"1.1.48",capabilities:{}})));
    ws.on("message",data=>{clearTimeout(timer);resolve(JSON.parse(data.toString("utf8")));});
    ws.on("error",reject);
  });
  assert.equal(ack.type,"hello_ack");
  assert.equal(ack.agentScriptUrl,endpoint.replace("127.0.0.1","192.168.1.30")+"/agent/v1/devspace-agent.py");
  ws.close();
  await new Promise(resolve=>ws.once("close",resolve));
  console.log(JSON.stringify({lanGateway:true,publicMcpNotExposed:true,agentHandshake:true,
    agentScriptUsesLanOrigin:true,privateUrlValidated:true}));
}finally{
  if(agent)await agent.close();
  if(gateway)await new Promise(resolve=>gateway.close(resolve));
  rmSync(temp,{recursive:true,force:true});
  if(oldConfigDir===undefined)delete process.env.DEVSPACE_CONFIG_DIR;
  else process.env.DEVSPACE_CONFIG_DIR=oldConfigDir;
  if(oldPortableConfigDir===undefined)delete process.env.DEVSPACE_PORTABLE_CONFIG_DIR;
  else process.env.DEVSPACE_PORTABLE_CONFIG_DIR=oldPortableConfigDir;
}
