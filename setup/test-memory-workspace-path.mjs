import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,rmSync,symlinkSync} from "node:fs";
import {createRequire} from "node:module";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

const require=createRequire(import.meta.url);
const {validateMemoryWorkspaceRoot}=require("./memory-workspace-path.cjs");
const sourceRoot=resolve(fileURLToPath(new URL("..",import.meta.url)));
const temp=mkdtempSync(join(sourceRoot,"reports",".tmp-memory-path-"));
try{
  const allowed=join(temp,"permitted");
  const project=join(allowed,"Python","project");
  const other=join(temp,"permitted-extra");
  mkdirSync(project,{recursive:true});
  mkdirSync(other,{recursive:true});
  assert.equal(validateMemoryWorkspaceRoot(project,[allowed]),project);
  assert.equal(validateMemoryWorkspaceRoot(allowed,[allowed]),allowed);
  assert.throws(()=>validateMemoryWorkspaceRoot(other,[allowed]),/allowed root/);
  assert.throws(()=>validateMemoryWorkspaceRoot(join(temp,"missing"),[allowed]),/must exist/);
  assert.throws(()=>validateMemoryWorkspaceRoot("",[allowed]),/absolute path/);
  assert.throws(()=>validateMemoryWorkspaceRoot("relative/path",[allowed]),/absolute path/);
  assert.throws(()=>validateMemoryWorkspaceRoot(project,[]),/allowed root/);
  const link=join(allowed,"outside-junction");
  try{
    symlinkSync(other,link,process.platform==="win32"?"junction":"dir");
    assert.throws(()=>validateMemoryWorkspaceRoot(link,[allowed]),/allowed root/,
      "A symlink/junction must not bypass configured roots");
  }catch(error){
    if(!["EPERM","EACCES","ENOSYS"].includes(error?.code))throw error;
  }
  console.log("Memory subdirectory selection and realpath boundary checks passed.");
}finally{
  rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:200});
}
