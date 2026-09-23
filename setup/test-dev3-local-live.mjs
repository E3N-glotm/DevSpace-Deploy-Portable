import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const scratchParent = join(root, "reports");
mkdirSync(scratchParent, {recursive:true});
const sandbox = mkdtempSync(join(scratchParent, ".tmp-dev3-local-live-"));
const configDir = join(sandbox, "config");
const stateDir = join(sandbox, "state");
const runDir = join(sandbox, "run");
for(const d of [configDir,stateDir,runDir])mkdirSync(d);
const port = 17679;
const env = {
  ...process.env,
  DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
  DEVSPACE_PORTABLE_STATE_DIR: stateDir,
  DEVSPACE_PORTABLE_RUN_DIR: runDir,
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_PID_FILE: join(runDir, "devspace.pid"),
  DEVSPACE_PORTABLE_ROOT: root,
  DEVSPACE_TOOL_MODE: "minimal",
  DEVSPACE_WIDGETS: "changes",
  DEVSPACE_ARTIFACTS: "0",
  DEVSPACE_SUBAGENTS: "0",
};
let child;
try {
  const configured=spawnSync(process.execPath,
    [join(root,"setup","portable-manager.cjs"),"configure","--ascii-json"],
    {cwd:root,env,encoding:"utf8",input:JSON.stringify({
      localOnly:true,tunnelProvider:"ngrok",publicBaseUrl:"",
      port,allowedRoots:[join(root,"setup")],permissions:{profile:"workspace"},
    }),timeout:45_000},
  );
  assert.equal(configured.status,0,"isolated local manager configuration failed");
  // Spawn the CLI directly. No Windows scheduled task or public tunnel is
  // installed or modified; only this child PID and isolated E-drive state
  // are within the test's disposal scope.
  child=spawn(process.execPath,
    [join(root,"app","node_modules","@waishnav","devspace","dist","cli.js"),"serve"],
    {cwd:join(root,"app"),env,windowsHide:true,stdio:["ignore","pipe","pipe"]},
  );
  let err="";
  child.stderr.on("data",b=>{if(err.length<8192)err+=b.toString("utf8");});
  let metadata;
  const until=Date.now()+30_000;
  while(Date.now()<until){
    if(child.exitCode!==null)break;
    try{
      const response=await fetch("http://127.0.0.1:"+port+"/.well-known/oauth-authorization-server",
        {signal:AbortSignal.timeout(1700)});
      if(response.status===200){metadata=await response.json();break;}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  assert.ok(metadata,"isolated local MCP did not expose OAuth metadata; "+err.slice(-1200));
  assert.equal(metadata.issuer.replace(/\/$/,""),"http://127.0.0.1:"+port);
  const unauthorized=await fetch("http://127.0.0.1:"+port+"/mcp",{signal:AbortSignal.timeout(2800)});
  assert.equal(unauthorized.status,401);
  console.log(JSON.stringify({localOnlyLiveOAuth:true,issuerIsLoopback:true,anonymousMcpDenied:true}));
} finally {
  if(child && child.exitCode===null){
    child.kill();
    await Promise.race([
      new Promise(resolve=>child.once("exit",resolve)),
      new Promise(resolve=>setTimeout(resolve,3500)),
    ]);
  }
  rmSync(sandbox,{recursive:true,force:true,maxRetries:4,retryDelay:250});
}
