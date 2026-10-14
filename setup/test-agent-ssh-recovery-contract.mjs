import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {createRequire} from "node:module";

const require=createRequire(import.meta.url);
const {freshOnlineAgent}=require("./remote-ssh-admin.cjs");
const now=Date.now();
const after=new Date(now+1000).toISOString();
const before=new Date(now-1000).toISOString();
const fresh={status:"online-recent",connected:false,connectedAt:after,lastSeenAt:after};
assert.equal(freshOnlineAgent(fresh,now),true,"SQLite-only CLI must accept a genuinely reconnected Agent");
assert.equal(freshOnlineAgent({...fresh,connectedAt:before},now),false,"old connection must not pass");
assert.equal(freshOnlineAgent({...fresh,lastSeenAt:before},now),false,"old heartbeat must not pass");
assert.equal(freshOnlineAgent({...fresh,status:"offline"},now),false,"disconnected Agent must not pass");

const admin=readFileSync(resolve("setup/remote-ssh-admin.cjs"),"utf8");
const ui=readFileSync(resolve("ui-next/src/Operations.tsx"),"utf8");
const manager=readFileSync(resolve("setup/portable-manager.cjs"),"utf8");

const recover=admin.slice(admin.indexOf('if(action==="recover"){'),admin.indexOf('if(action==="switch-network"){'));
assert.match(recover,/probeAgentEndpoint\(profile,state\)/);
assert.match(recover,/stopVerifiedState\(profile,state\)/);
assert.match(recover,/restartVerifiedState\(profile,state\)/);
assert.match(recover,/waitForAgentHeartbeat\(agentId,restartedAfter\)/);
assert.equal((admin.match(/freshOnlineAgent\(found,startedAfter\)/g)||[]).length,2,"SSH recovery and deploy must share the reconnect+heartbeat gate");
assert.equal((admin.match(/consecutiveHealthy>=2/g)||[]).length,2,"both SSH operations must observe two consecutive healthy polls");
assert.match(admin,/const startedAfter=Date\.now\(\);\s*const result=execute\(profile,script,150000\)/);
assert.doesNotMatch(recover,/return \{ok:true,restart,stateVerified:true,agentId\};/);
const switchCode=admin.slice(admin.indexOf('if(action==="switch-network"){'),admin.indexOf('if(action==="deploy"){'));
assert.match(switchCode,/probeAgentEndpoint\(profile,state,serverUrl\)/);
assert.match(switchCode,/configureAgentUrl\(profile,state,agentId,serverUrl,mode\)/);
assert.match(switchCode,/waitForAgentHeartbeat\(agentId,restartedAfter\)/);
assert.match(switchCode,/configureAgentUrl\(profile,state,agentId,serverUrl,mode,true\)/);
assert.match(ui,/const key=String\(profile\?\.key\|\|requestedKey\)/);
assert.match(ui,/remote-ssh-switch-network/);
assert.match(manager,/agent-network-set/);
assert.match(manager,/readAgentNetwork\(ROOT\)/);
assert.match(ui,/\['remote-ssh-deploy','remote-ssh-probe'\]\.includes\(action\)\?\{connectionMode,serverUrl:serverUrl\.trim\(\)\}/);
assert.match(admin,/connectionMode,\.\.\.\(serverUrl\?\{serverUrl\}:\{\}\)/);
console.log(JSON.stringify({offlineLiveProcessRestarts:true,endpointPreflight:true,
  newHeartbeatRequired:true,networkSwitchRollback:true,legacySshProfilePreserved:true,
  sshLanEnrollment:true}));
