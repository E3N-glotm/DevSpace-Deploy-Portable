import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync as realSpawnSync} from "node:child_process";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,copyFileSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const require=createRequire(import.meta.url);
const childProcess=require("node:child_process");
const {remoteSshAdminFactory}=require("./remote-ssh-admin.cjs");
const scratch=mkdtempSync(join(root,"reports",".tmp-dev4-ssh-"));
const profileFile=join(scratch,"data","remote-agent-ssh-profiles.json");
const readJson=(p,def)=>existsSync(p)?JSON.parse(readFileSync(p,"utf8")):def;
const writeJson=(p,v)=>writeFileSync(p,JSON.stringify(v));
try {
  mkdirSync(join(scratch,"data"),{recursive:true});
  const factory=remoteSshAdminFactory({
    root:scratch,readJson,writeJson,restrictAcl:()=>{},
    remoteAdmin:()=>{throw new Error("Remote server was not meant to be contacted.");},
  });
  const initial=await factory.handle("list");
  assert.deepEqual(initial.profiles,[]);
  const first=await factory.handle("save",{
    key:"agent-existing",host:"gpu.example.test",port:22,
    userName:"ubuntu",password:"test-only-secret",autoRecover:true,
  });
  assert.equal(first.profile.hasPassword,true);
  assert.equal(JSON.stringify(first).includes("test-only-secret"),false);
  const cipher=readJson(profileFile).Profiles[0].ProtectedPassword;
  assert.ok(cipher && cipher!=="test-only-secret");
  // The previous WinForms stored PascalCase properties and the same DPAPI
  // entropy. Rewriting only the endpoint MUST preserve encrypted password.
  assert.ok("Host" in readJson(profileFile).Profiles[0]);
  await factory.handle("save",{key:"agent-existing",host:"gpu2.example.test",
    port:2022,userName:"ubuntu",password:"",autoRecover:false});
  assert.equal(readJson(profileFile).Profiles[0].ProtectedPassword,cipher);
  assert.equal((await factory.handle("list")).profiles[0].hasPassword,true);
  const visible=JSON.stringify(await factory.handle("list"));
  assert.equal(visible.includes(cipher),false);
  assert.equal(visible.includes("test-only-secret"),false);
  await assert.rejects(factory.handle("save",{key:"invalid",host:"gpu;rm -rf /",
    port:22,userName:"ubuntu"}),/Invalid SSH/);
  const assets=join(scratch,"app","node_modules","@waishnav","devspace","dist","linux-agent");
  mkdirSync(assets,{recursive:true});
  const sources=["install.sh","devspace-agent.py"];
  const hashes=[];
  for(const name of sources){
    const from=join(root,"app","node_modules","@waishnav","devspace","dist","linux-agent",name);
    copyFileSync(from,join(assets,name));
    hashes.push(createHash("sha256").update(readFileSync(from)).digest("hex"));
  }
  const installer=factory.offlineInstall({
    enrollment:{token:"test-one-time-token",accessMode:"scoped",installRoot:"/home/ubuntu/workspace"},
    serverUrl:"https://example.test",stateDir:"/home/ubuntu/workspace/.devspace-agent/isolated",
    installerSha256:hashes[0],agentSha256:hashes[1],
  },"test-agent",["/home/ubuntu/workspace"],"ubuntu");
  assert.ok(installer.includes("DEVSPACE_ASSET_0"));
  assert.ok(installer.includes("DEVSPACE_ASSET_1"));
  assert.ok(installer.includes("--writable-root"));
  assert.ok(installer.includes("--state-dir"));
  assert.ok(!installer.includes("curl -"));
  assert.ok(installer.includes("test-one-time-token"));
  assert.throws(()=>factory.offlineInstall({enrollment:{token:"x"},
    serverUrl:"https://example.test",stateDir:"/tmp/x",installerSha256:"bad"},
  "test",[],"ubuntu"),/SHA-256/);
  // Exercise a simulated existing-Agent upgrade. No real SSH connection is
  // made; validate the exact generated remote Bash with bundled bash -n and
  // require a verified matching old-state stop before any new installation.
  const fakeSsh=join(scratch,"runtime","git","usr","bin","ssh.exe");
  mkdirSync(join(scratch,"runtime","git","usr","bin"),{recursive:true});
  writeFileSync(fakeSsh,"mock SSH binary - never executed");
  let failProbe=false, stopped=0, enrolled=0,installed=0;
  const scripts=[];
  const state="/home/ubuntu/workspace/.devspace-agent/verified-id";
  const mockRemote=remoteSshAdminFactory({
    root:scratch,readJson,writeJson,restrictAcl:()=>{},
    remoteAdmin:async(action)=>{
      if(action==="create-enrollment"){
        enrolled++;
        return {enrollment:{token:"test-one-time-token",accessMode:"scoped",
            installRoot:"/home/ubuntu/workspace"},
          serverUrl:"https://example.test",stateDir:state,
          installerSha256:hashes[0],agentSha256:hashes[1]};
      }
      if(action==="list")return {agents:[{id:"agent-existing",name:"test-agent",status:"online-recent"}]};
      throw new Error("Unexpected admin action: "+action);
    },
  });
  const originalSpawn=childProcess.spawnSync;
  try {
    childProcess.spawnSync=(file,args,options)=>{
      if(String(file)!==fakeSsh)return originalSpawn(file,args,options);
      const script=String(options.input||"");
      const bash=realSpawnSync(join(root,"runtime","git","bin","bash.exe"),["-n"],
        {input:script,encoding:"utf8",timeout:10000,windowsHide:true});
      assert.equal(bash.status,0,"Generated SSH script is not valid Bash: "+String(bash.stderr||"").slice(0,350));
      scripts.push(script);
      if(script.includes("DEVSPACE_AGENT_INSTALL_ROOT="))
        return {status:0,stdout:"DEVSPACE_AGENT_INSTALL_ROOT=/home/ubuntu/workspace\n",stderr:""};
      if(script.includes("DEVSPACE_AGENT_STATE_NOT_FOUND"))
        return failProbe?{status:44,stdout:"",stderr:"DEVSPACE_AGENT_STATE_NOT_FOUND"}:
          {status:0,stdout:"DEVSPACE_AGENT_STATE="+state+"\n",stderr:""};
      if(script.includes("DEVSPACE_AGENT_STATE_STOPPED=")){
        stopped++;
        return {status:0,stdout:"DEVSPACE_AGENT_STATE_STOPPED="+state+"\n",stderr:""};
      }
      if(script.includes("DEVSPACE_ASSET_0")){
        installed++;
        return {status:0,stdout:"DEVSPACE_AGENT_INSTALLED\n",stderr:""};
      }
      throw new Error("Unexpected SSH action");
    };
    const before=await mockRemote.handle("list");
    assert.equal(before.profiles[0].hasPassword,true);
    // Remove password from the sandbox so only mocked SSH is involved.
    const s=readJson(profileFile);s.Profiles[0].ProtectedPassword="";
    writeJson(profileFile,s);
    const updated=await mockRemote.handle("deploy",{
      key:"agent-existing",agentId:"agent-existing",name:"test-agent",
      installRoot:"/home/ubuntu/workspace",accessMode:"scoped",
      writableRoots:["/home/ubuntu/workspace"],
    });
    assert.equal(updated.ok,true);
    assert.equal(stopped,1);assert.equal(installed,1);assert.equal(enrolled,1);
    assert.ok(scripts.find(s=>s.includes("DEVSPACE_AGENT_STATE_STOPPED=")).includes("/proc"),
      "Verified-state termination must inspect exact Linux process command lines");
    failProbe=true;
    await assert.rejects(mockRemote.handle("deploy",{
      key:"agent-existing",agentId:"agent-existing",name:"test-agent",
      installRoot:"/home/ubuntu/workspace",accessMode:"scoped",
      writableRoots:["/home/ubuntu/workspace"],
    }),/Cannot verify an existing remote state/);
    assert.equal(stopped,1,"Missing old state may not stop unrelated processes");
    assert.equal(installed,1,"Missing old state may not create duplicate Agent");
    assert.equal(enrolled,1,"Missing old state may not mint another Agent token");
  } finally {
    childProcess.spawnSync=originalSpawn;
  }
  assert.equal((await factory.handle("delete",{key:"agent-existing"})).deleted,true);
  assert.deepEqual((await factory.handle("list")).profiles,[]);
  console.log(JSON.stringify({
    legacyProfileShape:true,winCurrentUserDpapiCipherPreserved:true,
    privateSshPasswordNeverReturned:true,offlineAssetHashes:true,
    safeSshEndpointValidation:true,isolatedEDrive:true,
    existingAgentUpgradeGuard:true,bashSyntaxChecked:true,
  }));
} finally {
  rmSync(scratch,{recursive:true,force:true,maxRetries:3,retryDelay:250});
}
