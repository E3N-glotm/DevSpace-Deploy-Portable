import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

const require=createRequire(import.meta.url);
const {createSshHostKeyTrust}=require("./ssh-hostkey-trust.cjs");
const {sshFailureCode}=require("./ssh-error-codes.cjs");
const source=join(fileURLToPath(new URL("..",import.meta.url)),"reports");
const temp=mkdtempSync(join(source,".tmp-ssh-identity-"));

try{
  const home=join(temp,"user");
  const installation=join(temp,"portable");
  mkdirSync(join(home,".ssh"),{recursive:true});
  const origin=join(home,".ssh","known_hosts");
  const keyA=Buffer.alloc(80,11).toString("base64");
  const keyB=Buffer.alloc(80,12).toString("base64");
  const keyC=Buffer.alloc(80,13).toString("base64");
  const endpoint="[172.39.60.12]:55301";
  writeFileSync(origin,`${endpoint} ssh-ed25519 ${keyA}\nother.example ssh-ed25519 ${keyA}\n`);
  let offered=keyB,scanCount=0;
  const execute=(_binary,args)=>{
    if(args[0]==="-T"){
      scanCount++;
      return {status:0,stdout:`${endpoint} ssh-ed25519 ${offered}\n`,stderr:""};
    }
    const file=args[args.indexOf("-f")+1];
    if(args[0]==="-F"){
      const matching=readFileSync(file,"utf8").split("\n").filter(line=>line.startsWith(args[1]+" "));
      return {status:matching.length?0:1,stdout:matching.join("\n"),stderr:""};
    }
    if(args[0]==="-R"){
      const remaining=readFileSync(file,"utf8").split("\n").filter(line=>!line.startsWith(args[1]+" "));
      writeFileSync(file,remaining.filter(Boolean).join("\n")+"\n");
      return {status:0,stdout:"",stderr:""};
    }
    throw new Error("Unexpected ssh operation");
  };
  // The trust service's subprocess executables are passed as paths, not
  // injected command strings, and are never run as part of this unit test.
  mkdirSync(join(installation,"runtime","git","usr","bin"),{recursive:true});
  writeFileSync(join(installation,"runtime","git","usr","bin","ssh-keyscan.exe"),"test");
  writeFileSync(join(installation,"runtime","git","usr","bin","ssh-keygen.exe"),"test");
  let restricted=0;
  const service=createSshHostKeyTrust({root:installation,homeDir:home,execute,
    restrictAcl:()=>{restricted++;}});
  const profile={host:"172.39.60.12",port:55301};
  let state=service.inspect(profile);
  assert.equal(state.state,"changed");
  assert.equal(state.previouslyTrusted.length,1);
  assert.equal(state.fingerprints.length,1);
  assert.match(state.fingerprints[0].fingerprint,/^SHA256:/);
  assert.match(readFileSync(service.ensure(),"utf8"),/other\.example/);
  assert.throws(()=>service.approve(profile,state.scanId,false),/Explicit/);
  assert.throws(()=>service.approve(profile,"0".repeat(64),true),/changed during review/);
  offered=keyC;
  assert.throws(()=>service.approve(profile,state.scanId,true),/changed during review/);
  assert.equal(service.inspect(profile).state,"changed");
  state=service.inspect(profile);
  assert.equal(service.approve(profile,state.scanId,true).state,"trusted");
  assert.equal(service.inspect(profile).state,"trusted");
  assert.ok(restricted>=2);
  assert.match(readFileSync(origin,"utf8"),new RegExp(keyA),
    "Original user known_hosts must never be modified");
  const own=readFileSync(service.ensure(),"utf8");
  assert.ok(own.includes(keyC)&&!own.includes(endpoint+" ssh-ed25519 "+keyA),
    "New pin must replace only the reviewed endpoint");
  assert.match(own,/other\.example/, "Unrelated host trust must be preserved");
  assert.ok(scanCount>=5);
  assert.equal(sshFailureCode(new Error("WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!")),"HOST_KEY_CHANGED");
  assert.equal(sshFailureCode(new Error("Permission denied (publickey,password).")),"AUTH_FAILED");
  assert.equal(sshFailureCode(new Error("DEVSPACE_AGENT_STATE_NOT_FOUND")),"STATE_NOT_FOUND");
  assert.equal(sshFailureCode(new Error("Agent SSH process restarted, but no new controller heartbeat was observed.")),"HEARTBEAT_MISSING");
  console.log("SSH new-password host-identity consent, safe diagnostics and profile-local trust checks passed.");
}finally{
  rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
