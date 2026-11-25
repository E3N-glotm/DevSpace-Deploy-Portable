import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {createServer} from "node:net";
import {networkInterfaces} from "node:os";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createRequire} from "node:module";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const require=createRequire(import.meta.url);
const {validateAgentUrl,validateLanSettings,prepareLanBindings,lanAgentEndpointEnabled,
  lanControllerAddress,resolveLanControllerAddress}=require("../setup/agent-network.cjs");
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
const oldLan=validateLanSettings({enabled:true,port:7677,bindHost:"192.168.219.14"});
assert.deepEqual(oldLan.bindHosts,["192.168.219.14"],"legacy single binding must remain valid");
const extended=prepareLanBindings(oldLan,"192.168.221.238");
assert.deepEqual(extended.settings.bindHosts,["192.168.219.14","192.168.221.238"]);
assert.equal(lanAgentEndpointEnabled(extended.settings,"http://192.168.219.14:7677"),true);
assert.equal(lanAgentEndpointEnabled(extended.settings,"http://192.168.221.238:7677"),true);
assert.equal(lanAgentEndpointEnabled(extended.settings,"http://192.168.221.239:7677"),false);
assert.equal(lanAgentEndpointEnabled(extended.settings,"http://192.168.221.238:7678"),false);
assert.equal(extended.settings.bindHost,"192.168.219.14");
assert.equal(extended.restartRequired,true);
assert.equal(prepareLanBindings(extended.settings,"192.168.219.14").restartRequired,false);
assert.equal(prepareLanBindings(extended.settings,"192.168.221.238").restartRequired,false);
assert.deepEqual(prepareLanBindings({enabled:false,port:7677},"192.168.221.238").settings.bindHosts,
  ["192.168.221.238"]);
const wildcard=prepareLanBindings({enabled:true,port:7677,bindHost:"0.0.0.0"},"192.168.221.238");
assert.equal(wildcard.restartRequired,false);
assert.deepEqual(wildcard.settings.bindHosts,["0.0.0.0"]);
for(const bad of [
  ["0.0.0.0","192.168.221.238"], ["192.168.219.14","192.168.219.14"],
  ["192.168.219.14","8.8.8.8"], ["192.168.219.14","192.168.1.999"],
  [], Array.from({length:9},(_,i)=>`192.168.1.${i+2}`),
]) assert.throws(()=>validateLanSettings({enabled:true,port:7677,bindHosts:bad}));
assert.throws(()=>prepareLanBindings(extended.settings,"8.8.8.8"));
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
let gateway, multiGateway, agent;
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
  assert.match(bytes.toString("utf8"),/AGENT_VERSION = "1\.1\.49"/);
  assert.equal((await fetch(endpoint+"/mcp")).status,404);
  assert.equal((await fetch(endpoint+"/oauth/authorize")).status,404);
  assert.equal((await fetch(endpoint+"/agent/v1/install.sh")).status,200);
  const registered=remoteAgentAdmin({stateDir:config.stateDir,action:"create-enrollment",
    payload:{name:"lan-new",installRoot:"/home/ubuntu",accessMode:"full-access",
      connectionMode:"lan",serverUrl:"http://192.168.1.30:"+port},publicBaseUrl:"https://agent.example.com"});
  assert.equal(registered.connectionMode,"lan");
  assert.match(registered.installCommand,/--connection-mode 'lan'/);
  assert.match(registered.installCommand,/curl -fsSL 'http:\/\/192\.168\.1\.30:/);
  const reverseRegistered=remoteAgentAdmin({stateDir:config.stateDir,action:"create-enrollment",
    payload:{name:"ssh-reverse-new",installRoot:"/home/ubuntu",accessMode:"full-access",
      connectionMode:"ssh-reverse",serverUrl:"http://127.0.0.1:18767"},
    publicBaseUrl:"https://agent.example.com"});
  assert.equal(reverseRegistered.connectionMode,"ssh-reverse");
  assert.equal(reverseRegistered.serverUrl,"http://127.0.0.1:18767");
  assert.match(reverseRegistered.installCommand,/--connection-mode 'ssh-reverse'/);
  assert.match(reverseRegistered.installCommand,/curl -fsSL 'http:\/\/127\.0\.0\.1:18767/);
  const enrollment=agent.store.createEnrollment({name:"lan-test-agent",accessMode:"full-access",
    writableRoots:[],installRoot:"/home/ubuntu"});
  const ws=new WebSocket("ws://127.0.0.1:"+port+"/agent/v1/connect",{headers:{Host:"192.168.1.30:"+port}});
  const ack=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("LAN hello timeout")),5000);
    ws.on("open",()=>ws.send(JSON.stringify({type:"hello",protocol:1,enrollmentToken:enrollment.token,
      hostname:"mock-host",platform:"linux-x64",agentVersion:"1.1.49",capabilities:{}})));
    ws.on("message",data=>{clearTimeout(timer);resolve(JSON.parse(data.toString("utf8")));});
    ws.on("error",reject);
  });
  assert.equal(ack.type,"hello_ack");
  assert.equal(ack.agentScriptUrl,endpoint.replace("127.0.0.1","192.168.1.30")+"/agent/v1/devspace-agent.py");
  ws.close();
  await new Promise(resolve=>ws.once("close",resolve));
  // Real, separate sockets on two explicitly selected host interfaces. The
  // test never binds 0.0.0.0 for this multi-NIC case, nor touches 7677/live.
  const local=Object.values(networkInterfaces()).flat().filter(i=>i?.family==="IPv4"
    &&!i.internal && /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(i.address));
  // Exercise physical 192.168.x adapters first when available, not only
  // Hyper-V/vEthernet adapters reported earlier by os.networkInterfaces().
  const localHosts=[...new Set(local.map(i=>i.address))].sort((a,b)=>
    Number(b.startsWith("192.168."))-Number(a.startsWith("192.168.")));
  let multiListenerVerified=false;
  let unavailableSecondarySkipped=false;
  if(localHosts.length){
    const ephemeral=createServer();
    await new Promise(resolve=>ephemeral.listen(0,"127.0.0.1",resolve));
    const secondPort=ephemeral.address().port;
    await new Promise(resolve=>ephemeral.close(resolve));
    const hosts=localHosts.slice(0,2);
    // If there is only one private NIC, still test preserving it when another
    // configured NIC disappears before the next service startup.
    const absent="192.168.254.253";
    if(hosts.length===1&&!hosts.includes(absent))hosts.push(absent);
    writeFileSync(join(temp,"data","config","agent-network.json"),
      JSON.stringify({enabled:true,port:secondPort,bindHosts:hosts}));
    multiGateway=await startAgentLanGateway(config,agent);
    for(const host of hosts.filter(x=>localHosts.includes(x))){
      const url=`http://${host}:${secondPort}`;
      assert.equal((await fetch(url+"/agent/v1/install.sh")).status,200);
      assert.equal((await fetch(url+"/mcp")).status,404);
      assert.equal((await fetch(url+"/oauth/authorize")).status,404);
    }
    multiListenerVerified=hosts.length>1&&localHosts.length>1;
    unavailableSecondarySkipped=hosts.length>1&&localHosts.length===1;
    // Simulate unplugging WLAN between configuration and the next launch.
    // The surviving wired listener must remain usable on the new process.
    await new Promise(resolve=>multiGateway.close(resolve));
    multiGateway=null;
    const unavailable=Array.from({length:254},(_,i)=>`192.168.254.${i+1}`)
      .find(host=>!localHosts.includes(host));
    const thirdSocket=createServer();
    await new Promise(resolve=>thirdSocket.listen(0,"127.0.0.1",resolve));
    const thirdPort=thirdSocket.address().port;
    await new Promise(resolve=>thirdSocket.close(resolve));
    writeFileSync(join(temp,"data","config","agent-network.json"),
      JSON.stringify({enabled:true,port:thirdPort,bindHosts:[localHosts[0],unavailable]}));
    multiGateway=await startAgentLanGateway(config,agent);
    assert.equal((await fetch(`http://${localHosts[0]}:${thirdPort}/agent/v1/install.sh`)).status,200);
    assert.equal((await fetch(`http://${localHosts[0]}:${thirdPort}/mcp`)).status,404);
    unavailableSecondarySkipped=true;
    // Closing the listener while an authenticated Agent WebSocket is alive
    // must not be awaited before RemoteAgentManager.close(): Node's HTTP
    // server.close callback waits for the upgraded connection to terminate.
    const shutdownEnrollment=agent.store.createEnrollment({name:"shutdown-test",accessMode:"full-access",
      writableRoots:[],installRoot:"/home/ubuntu"});
    const shutdownSocket=new WebSocket(`ws://${localHosts[0]}:${thirdPort}/agent/v1/connect`);
    const shutdownAck=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("LAN shutdown hello timeout")),5000);
      shutdownSocket.on("open",()=>shutdownSocket.send(JSON.stringify({type:"hello",protocol:1,
        enrollmentToken:shutdownEnrollment.token,hostname:"shutdown-mock",platform:"linux-x64",
        agentVersion:"1.1.49",capabilities:{}})));
      shutdownSocket.on("message",data=>{clearTimeout(timer);resolve(JSON.parse(data.toString("utf8")));});
      shutdownSocket.on("error",error=>{clearTimeout(timer);reject(error);});
    });
    assert.equal(shutdownAck.type,"hello_ack");
    let gatewayClosed=false;
    const closing=new Promise((resolve,reject)=>multiGateway.close(error=>
      error?reject(error):(gatewayClosed=true,resolve())));
    await new Promise(resolve=>setTimeout(resolve,75));
    assert.equal(gatewayClosed,false,"upgraded WebSocket keeps the HTTP close pending");
    await agent.close();
    agent=null;
    await Promise.race([closing,new Promise((_,reject)=>setTimeout(()=>
      reject(new Error("Multi-LAN shutdown timeout")),6000))]);
    multiGateway=null;
  }
  console.log(JSON.stringify({lanGateway:true,publicMcpNotExposed:true,agentHandshake:true,
    agentScriptUsesLanOrigin:true,privateUrlValidated:true,
    legacyMigrated:true,multiListenerVerified,unavailableSecondarySkipped}));
}finally{
  if(agent)await agent.close();
  if(multiGateway)await new Promise(resolve=>multiGateway.close(resolve));
  if(gateway)await new Promise(resolve=>gateway.close(resolve));
  rmSync(temp,{recursive:true,force:true});
  if(oldConfigDir===undefined)delete process.env.DEVSPACE_CONFIG_DIR;
  else process.env.DEVSPACE_CONFIG_DIR=oldConfigDir;
  if(oldPortableConfigDir===undefined)delete process.env.DEVSPACE_PORTABLE_CONFIG_DIR;
  else process.env.DEVSPACE_PORTABLE_CONFIG_DIR=oldPortableConfigDir;
}
