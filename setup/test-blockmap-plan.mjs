import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
const require=createRequire(import.meta.url);
const plan=require("./blockmap-plan.cjs");
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const cacheDir=path.join(root,".test-cache");fs.mkdirSync(cacheDir,{recursive:true});
const temp=fs.mkdtempSync(path.join(cacheDir,"blockmap-plan-"));
const base=path.join(temp,"base"),target=path.join(temp,"target"),payload=path.join(temp,"payload");
const cache=path.join(temp,"cache.json"),planFile=path.join(temp,"blockmap-plan.json");
const sha=x=>crypto.createHash("sha256").update(x).digest("hex");
function put(dir,name,bytes){const p=path.join(dir,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes);}
function copy(dir,name,from){put(dir,name,fs.readFileSync(path.join(from,name)));}
try{
  for(let i=0;i<500;i++){put(base,"deps/"+i+".js","unchanged "+i);copy(target,"deps/"+i+".js",base);}
  fs.utimesSync(path.join(base,"deps/0.js"),new Date("2026-11-19T00:00:00Z"),new Date("2026-11-19T00:00:00Z"));
  put(base,"VERSION-MANIFEST.json",'{"runtime":{"devspacePortable":"1.1.68"}}');
  put(target,"VERSION-MANIFEST.json",'{"runtime":{"devspacePortable":"1.1.69"}}');
  put(base,"changed.bin",Buffer.alloc(1024*1024+200,1));
  put(target,"changed.bin",Buffer.alloc(1024*1024+200,2));
  put(target,"new.txt","new content");
  put(base,"removed.txt","old owned file");
  put(base,"unowned.txt","user file");
  put(base,"data/user.txt","persistent");
  put(base,"packages/waishnav-devspace-1.0.5.tgz","retained build input");
  put(base,"SHA256SUMS.txt",[
    sha(Buffer.from("old owned file"))+"  removed.txt",
    sha(Buffer.from("persistent"))+"  data/user.txt",
    sha(Buffer.from("retained build input"))+"  packages/waishnav-devspace-1.0.5.tgz",
  ].join("\n"));
  put(target,"SHA256SUMS.txt","new checksums");
  const files=[];
  function walk(dir,relative=""){
    for(const e of fs.readdirSync(dir,{withFileTypes:true})){
      const name=(relative?relative+"/":"")+e.name;
      if(e.isDirectory())walk(path.join(dir,e.name),name);else files.push(name);
    }
  }
  walk(target);
  const targetFiles=await Promise.all(files.map(async name=>({path:name,...await plan.hashFile(path.join(target,name),1048576)})));
  const progress=()=>{};
  let reuse=await plan.analyze(base,targetFiles,1048576,cache,progress);
  assert.equal(reuse.unchanged.length,500);
  assert.equal(reuse.changed.length,4);
  assert.equal(reuse.cacheHits,0);
  assert.ok(reuse.scannedBytes>1048576);
  const warm=await plan.analyze(base,targetFiles,1048576,cache,progress);
  assert.equal(warm.scannedBytes,0);
  assert.equal(warm.cacheHits,503);
  const deleted=await plan.obsoleteFiles(base,targetFiles,1048576);
  assert.deepEqual(deleted.map(f=>f.path),["removed.txt"]);
  fs.mkdirSync(payload,{recursive:true});
  for(const e of reuse.changed)copy(payload,e.path,target);
  let result=plan.writePlan(planFile,"1.1.69","a".repeat(64),reuse,deleted);
  await plan.verify(base,payload,planFile,result.planSha256);
  put(payload,"changed.bin","tampered");
  await assert.rejects(()=>plan.verify(base,payload,planFile,result.planSha256),/SHA-256 mismatch/);
  copy(payload,"changed.bin",target);

  // Reset mtime after an edit: ctime/identity must still invalidate the cache.
  const unchanged=path.join(base,"deps/0.js"),before=fs.statSync(unchanged);
  fs.writeFileSync(unchanged,"modified___");
  fs.utimesSync(unchanged,before.atime,before.mtime);
  await assert.rejects(()=>plan.verify(base,payload,planFile,result.planSha256),/changed after staging/);
  const drift=await plan.analyze(base,targetFiles,1048576,cache,progress);
  assert.ok(drift.changed.some(f=>f.path==="deps/0.js"));
  assert.ok(drift.scannedBytes>0);
  copy(base,"deps/0.js",target);
  reuse=await plan.analyze(base,targetFiles,1048576,cache,progress);
  result=plan.writePlan(planFile,"1.1.69","a".repeat(64),reuse,deleted);
  await plan.verify(base,payload,planFile,result.planSha256);

  // Plan and snapshot are independently pinned against accidental modification.
  const snapshotFile=path.join(temp,"blockmap-base.json"),snapshot=fs.readFileSync(snapshotFile);
  fs.appendFileSync(snapshotFile," ");
  await assert.rejects(()=>plan.verify(base,payload,planFile,result.planSha256),/snapshot SHA-256/);
  fs.writeFileSync(snapshotFile,snapshot);
  const rawPlan=fs.readFileSync(planFile);fs.appendFileSync(planFile," ");
  await assert.rejects(()=>plan.verify(base,payload,planFile,result.planSha256),/plan SHA-256/);
  fs.writeFileSync(planFile,rawPlan);

  for(const e of reuse.changed)copy(base,e.path,payload);
  for(const e of deleted)fs.rmSync(path.join(base,e.path));
  await plan.verify(base,payload,planFile,result.planSha256,true,cache);
  const installed=await plan.analyze(base,targetFiles,1048576,cache,progress);
  assert.equal(installed.changed.length,0);assert.equal(installed.scannedBytes,0);
  assert.equal(fs.readFileSync(path.join(base,"unowned.txt"),"utf8"),"user file");
  assert.equal(fs.readFileSync(path.join(base,"data/user.txt"),"utf8"),"persistent");
  assert.ok(fs.existsSync(path.join(base,"packages/waishnav-devspace-1.0.5.tgz")));
  // A forged cache can influence planning, never the final content gate.
  put(base,"deps/1.js","poisoned___");
  const forged=JSON.parse(fs.readFileSync(cache,"utf8"));
  forged.files["deps/1.js"].fingerprint=plan.fingerprint(fs.lstatSync(path.join(base,"deps/1.js"),{bigint:true}));
  fs.writeFileSync(cache,JSON.stringify(forged));
  const candidate=await plan.analyze(base,targetFiles,1048576,cache,progress);
  assert.equal(candidate.changed.length,0);
  const poisoned=plan.writePlan(planFile,"1.1.69","a".repeat(64),candidate,[]);
  await assert.rejects(()=>plan.verify(base,payload,planFile,poisoned.planSha256,true,cache),/changed after staging/);
  assert.equal(fs.existsSync(cache),false,"a failed content gate must invalidate its cache");
  copy(base,"deps/1.js",target);
  fs.writeFileSync(cache,"invalid JSON");
  const recovered=await plan.analyze(base,targetFiles,1048576,cache,progress);
  assert.equal(recovered.changed.length,0);assert.ok(recovered.scannedBytes>0);
  console.log(JSON.stringify({changedOnly:true,unchangedFilesNotCopied:500,warmHashReadBytes:0,
    coldScanVerified:true,cacheCorruptionRecovery:true,restoredMtimeDriftDetected:true,
    planAndSnapshotTamperRejected:true,payloadTamperRejected:true,forgedCacheCannotPassFinalHash:true,ownedDeletionOnly:true,persistentDataPreserved:true}));
}finally{fs.rmSync(temp,{recursive:true,force:true});}
