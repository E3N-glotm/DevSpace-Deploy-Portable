"use strict";
// Blockmap changed-file staging and verified local reuse.
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const HASH=/^[0-9a-f]{64}$/;
const digest=data=>crypto.createHash("sha256").update(data).digest("hex");
const fingerprint=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.birthtimeNs].map(String).join(":");
const filePath=(root,name)=>path.join(root,...name.split("/"));
function relative(name) {
  const s=String(name).replaceAll("\\","/");
  if(!s||s.startsWith("/")||/^[A-Za-z]:/.test(s)||s.split("/").some(p=>!p||p==="."||p==="..")) throw Error("Unsafe blockmap plan path");
  if(["data","logs","reports"].includes(s.split("/")[0].toLowerCase())&&!s.toLowerCase().startsWith("data/plugins/installed/codex-runtime-bridge/")) throw Error("Persistent path excluded from blockmap plan");
  return s;
}
async function mapLimit(items,count,action) {
  let next=0,failure=null;
  await Promise.all(Array.from({length:Math.min(count,items.length)},async()=>{
    for(;;){if(failure)return;const i=next++;if(i>=items.length)return;try{await action(items[i],i);}catch(e){failure??=e;return;}}
  }));
  if(failure)throw failure;
}
async function statFile(file) {
  try{const s=await fs.promises.lstat(file,{bigint:true});return s.isFile()&&!s.isSymbolicLink()?s:null;}
  catch(e){if(e.code==="ENOENT"||e.code==="ENOTDIR")return null;throw e;}
}
async function hashFile(file,blockSize,knownStat=null) {
  const h=crypto.createHash("sha256"),blocks=[],handle=await fs.promises.open(file,"r");
  try{
    const before=knownStat||await handle.stat({bigint:true});
    const buffer=Buffer.allocUnsafe(Math.max(1,Math.min(blockSize,Number(before.size))));
    let offset=0;
    while(offset<Number(before.size)){
      let size=0;
      const wanted=Math.min(buffer.length,Number(before.size)-offset);
      while(size<wanted){const r=await handle.read(buffer,size,wanted-size,offset+size);if(!r.bytesRead)throw Error("Installed file truncated during blockmap analysis");size+=r.bytesRead;}
      const raw=buffer.subarray(0,size);h.update(raw);
      blocks.push({hash:digest(raw),size,offset});offset+=size;
    }
    const after=await handle.stat({bigint:true});
    if(fingerprint(before)!==fingerprint(after))throw Error("Installed file changed during blockmap analysis");
    return {size:offset,sha256:h.digest("hex"),fingerprint:fingerprint(after),blocks};
  }finally{await handle.close();}
}
function validRecord(r,stat,blockSize) {
  try {
    return r&&r.fingerprint===fingerprint(stat)&&r.size===Number(stat.size)&&HASH.test(r.sha256)&&r.blockSize===blockSize
      &&Array.isArray(r.blocks)&&r.blocks.every((b,i)=>HASH.test(b.hash)&&b.offset===i*blockSize&&b.size>0&&b.size<=blockSize)
      &&r.blocks.reduce((n,b)=>n+b.size,0)===r.size;
  } catch { return false; }
}
function readCache(file,root) {
  try{
    if(fs.statSync(file).size>128*1024*1024)return {};
    const v=JSON.parse(fs.readFileSync(file,"utf8"));
    return v.schemaVersion===1&&v.root===path.resolve(root).toLowerCase()&&v.files&&!Array.isArray(v.files)?v.files:{};
  }catch{return {};}
}
function writeCache(file,root,files) {
  if(!file)return;
  const temp=file+".tmp-"+process.pid;
  try{
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(temp,JSON.stringify({schemaVersion:1,root:path.resolve(root).toLowerCase(),files}));
    try{fs.renameSync(temp,file);}catch{fs.copyFileSync(temp,file);fs.rmSync(temp,{force:true});}
  }catch{try{fs.rmSync(temp,{force:true});}catch{}}
}
async function analyze(root,files,blockSize,cacheFile,progress) {
  const cached=readCache(cacheFile,root),records=Object.create(null),reusable=new Map(),changed=[],unchanged=[];
  let scannedBytes=0,cacheHits=0,processedBytes=0,processed=0,last=0;
  const total=files.reduce((n,f)=>n+f.size,0);
  await mapLimit(files,8,async(file)=>{
    const installed=filePath(root,relative(file.path)),stat=await statFile(installed);
    let record=null;
    if(stat){
      const previous=cached[file.path];
      if(validRecord(previous,stat,blockSize)){record=previous;cacheHits++;}
      else{record={...await hashFile(installed,blockSize,stat),blockSize};scannedBytes+=record.size;}
      records[file.path]=record;
      for(const b of record.blocks)if(!reusable.has(b.hash))reusable.set(b.hash,{path:installed,offset:b.offset,size:b.size});
    }
    if(record&&record.size===file.size&&record.sha256===file.sha256)unchanged.push({...file,fingerprint:record.fingerprint});
    else changed.push(file);
    processed++;processedBytes+=file.size;
    if(Date.now()-last>400||processed===files.length){
      last=Date.now();progress("analyzing","检查本地文件 "+processed+"/"+files.length,{bytesReceived:processedBytes,bytesTotal:total,transport:"local-sha256-cache"});
    }
  });
  // Cached content was hashed with a stable file identity. Any identity or
  // timestamp change requires hashing again; reused blocks are also rehashed.
  writeCache(cacheFile,root,records);
  return {reusable,changed:changed.sort((a,b)=>a.path.localeCompare(b.path)),unchanged,scannedBytes,cacheHits,records};
}
async function obsoleteFiles(root,files,blockSize) {
  const owned=new Map();
  try{
    for(const line of fs.readFileSync(path.join(root,"SHA256SUMS.txt"),"utf8").split(/\r?\n/)){
      const m=/^([0-9a-f]{64})  (.+)$/.exec(line);if(!m)continue;
      try{owned.set(relative(m[2]),m[1]);}catch{}
    }
  }catch{}
  const names=new Set(files.map(f=>f.path.toLowerCase())),deleted=[];
  await mapLimit([...owned],8,async([name,expected])=>{
    if(names.has(name.toLowerCase())||/^packages\/waishnav-devspace-.*\.tgz$/i.test(name))return;
    const installed=filePath(root,name),stat=await statFile(installed);if(!stat)return;
    const actual=await hashFile(installed,blockSize,stat);
    // Only remove obsolete release-owned files whose installed checksum agrees.
    // Unknown files, local edits, persistent data and old core inputs survive.
    if(actual.sha256===expected)deleted.push({path:name,baseSha256:expected,fingerprint:actual.fingerprint});
  });
  return deleted;
}

function writePlan(file,targetVersion,headerSha256,reuse,deletedFiles,blockSize=1024*1024) {
  const snapshotFile=path.join(path.dirname(file),"blockmap-base.json");
  const snapshot=JSON.stringify({schemaVersion:1,files:reuse.unchanged});
  fs.writeFileSync(snapshotFile,snapshot);
  const plan={schemaVersion:1,format:"blockmap-changes-v1",targetVersion,headerSha256,blockSize,
    snapshotFile:path.basename(snapshotFile),snapshotSha256:digest(snapshot),
    changedFiles:reuse.changed,deletedFiles};
  const raw=JSON.stringify(plan);fs.writeFileSync(file,raw);
  return {planSha256:digest(raw),changedFileCount:reuse.changed.length,unchangedFileCount:reuse.unchanged.length,deletedFileCount:deletedFiles.length};
}
function loadPlan(file,expected) {
  const raw=fs.readFileSync(file);
  if(digest(raw)!==expected)throw Error("Blockmap plan SHA-256 mismatch");
  const plan=JSON.parse(raw);
  if(!Number.isSafeInteger(plan.blockSize)||plan.blockSize<=0||plan.blockSize>8*1024*1024)throw Error("Invalid block size in plan");
  if(plan.schemaVersion!==1||plan.format!=="blockmap-changes-v1"||!HASH.test(plan.headerSha256)||!/^\d+\.\d+\.\d+$/.test(plan.targetVersion))throw Error("Invalid blockmap plan");
  if(plan.snapshotFile!=="blockmap-base.json"||!Array.isArray(plan.changedFiles)||!Array.isArray(plan.deletedFiles))throw Error("Invalid blockmap plan paths");
  const rawSnapshot=fs.readFileSync(path.join(path.dirname(file),plan.snapshotFile));
  if(digest(rawSnapshot)!==plan.snapshotSha256)throw Error("Blockmap base snapshot SHA-256 mismatch");
  const snapshot=JSON.parse(rawSnapshot);
  if(snapshot.schemaVersion!==1||!Array.isArray(snapshot.files))throw Error("Invalid base snapshot");
  const seen=new Set();
  for(const entry of [...plan.changedFiles,...snapshot.files,...plan.deletedFiles]){
    const name=relative(entry.path).toLowerCase();
    if(seen.has(name))throw Error("Duplicate blockmap plan path");seen.add(name);
  }
  return {plan,snapshot};
}
async function verifyInternal(root,payload,file,expected,installed=false,cacheFile="",progress=()=>{},verifyAll=false) {
  const {plan,snapshot}=loadPlan(file,expected),records=Object.create(null);
  let checked=0,last=0;
  const total=[...snapshot.files,...plan.changedFiles].reduce((n,e)=>n+e.size,0);
  function report(size){checked+=size;if(Date.now()-last>400||checked===total){last=Date.now();progress("verifying",installed?"正在执行安装后全量 SHA-256 校验":"正在核验安装计划",{bytesReceived:checked,bytesTotal:total,transport:"local-sha256"});}}
  await mapLimit(snapshot.files,8,async(e)=>{
    const stat=await statFile(filePath(root,e.path));
    if(!stat)throw Error("Unchanged installed file changed after staging: "+e.path);
    // Fingerprint/cache hits accelerate planning only. Successful publication
    // always requires every target file's actual content hash, including files
    // left in place. This also catches forged or stale local cache records.
    if(installed||verifyAll||fingerprint(stat)!==e.fingerprint){
      const actual=await hashFile(filePath(root,e.path),plan.blockSize,stat);
      if(actual.sha256!==e.sha256||actual.size!==e.size)throw Error("Unchanged installed file changed after staging: "+e.path);
      records[e.path]={...actual,blockSize:plan.blockSize};
    }else records[e.path]={size:e.size,sha256:e.sha256,fingerprint:e.fingerprint,blocks:e.blocks,blockSize:plan.blockSize};
    report(e.size);
  });
  await mapLimit(plan.changedFiles,8,async(e)=>{
    if(!HASH.test(e.sha256))throw Error("Invalid changed-file hash");
    const source=filePath(installed?root:payload,e.path),stat=await statFile(source);
    if(!stat)throw Error("Blockmap changed file missing: "+e.path);
    const actual=await hashFile(source,plan.blockSize,stat);
    if(actual.size!==e.size||actual.sha256!==e.sha256)throw Error("Blockmap changed file SHA-256 mismatch: "+e.path);
    records[e.path]={...actual,blockSize:plan.blockSize};
    report(e.size);
  });
  await mapLimit(plan.deletedFiles,8,async(e)=>{
    const stat=await statFile(filePath(root,e.path));
    if(installed){if(stat)throw Error("Obsolete program file still exists: "+e.path);}
    else if(stat&&fingerprint(stat)!==e.fingerprint)throw Error("Obsolete program file changed after staging: "+e.path);
  });
  if(installed&&cacheFile)writeCache(cacheFile,root,records);
  return {success:true,allContentVerified:installed||verifyAll,changedFileCount:plan.changedFiles.length,unchangedFileCount:snapshot.files.length,deletedFileCount:plan.deletedFiles.length};
}
async function verify(...args){
  try{return await verifyInternal(...args);}
  catch(error){if(args[5])try{fs.rmSync(args[5],{force:true});}catch{}throw error;}
}
module.exports={analyze,obsoleteFiles,writePlan,loadPlan,verify,fingerprint,hashFile,mapLimit};
