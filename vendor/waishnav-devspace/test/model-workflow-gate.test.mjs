import test from "node:test";
import assert from "node:assert/strict";
import {createModelWorkflowGate} from "../dist/model-workflow-gate.js";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const repo=resolve(import.meta.dirname,"../../..");
function fixture(){
    let clock=1000;
    let policy={enabled:false,updatedAt:"revision-1"};
    let profiles=[{id:"w1",model:"qwen-local",allowCalls:true,callPolicyRevision:"profile-1"}];
    const worker={models:()=>profiles.filter(m=>m.allowCalls!==false)};
    const gate=createModelWorkflowGate({portableRoot:repo,modelWorker:worker,
        readPolicy:()=>policy,now:()=>clock,grantTtlMs:3000});
    return {gate,worker,
        enable:()=>{policy={enabled:true,updatedAt:"revision-2"};},
        disable:()=>{policy={enabled:false,updatedAt:"revision-3"};},
        rotate:()=>{policy={enabled:true,updatedAt:"revision-4"};},
        noWorkers:()=>{profiles=[];},
        disabledWorker:()=>{profiles=[{...profiles[0],allowCalls:false}];},
        reenabledWorker:()=>{profiles=[{id:"w1",model:"qwen-local",allowCalls:true,callPolicyRevision:"profile-2"}];},
        advance:ms=>{clock+=ms;},
    };
}
function completed(taskId="task1",workspaceId="ws1"){
    return {taskId,workspaceId,modelId:"w1",status:"completed"};
}

test("default mode permits upstream model to use tools without delegation",()=>{
    const f=fixture();
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"}).allowed,true);
    assert.equal(f.gate.authorize("exec_command",{workspaceId:"ws1"}).allowed,true);
});
test("forced mode preserves discovery, cancellation, diagnosis and the checkout bootstrap",()=>{
    const f=fixture();f.enable();
    for(const name of ["model_worker_list","model_delegate_task","model_task_status",
        "model_task_result","model_task_cancel","continuation_task",
        "continuation_anchor","continuation_sender","doctor","capabilities"]){
        assert.equal(f.gate.authorize(name,{}).allowed,true,name);
    }
    assert.equal(f.gate.authorize("open_workspace",{mode:"checkout"}).allowed,true);
    assert.equal(f.gate.authorize("open_workspace",{mode:"worktree"}).allowed,false);
});
test("no enabled Worker, missing workspace and no completed delegation all fail closed",()=>{
    const f=fixture();f.enable();
    assert.equal(f.gate.authorize("read",{}).code,"MODEL_WORKFLOW_WORKSPACE_REQUIRED");
    assert.equal(f.gate.authorize("exec_command",{workspaceId:"ws1"}).code,
        "MODEL_WORKFLOW_DELEGATION_REQUIRED");
    f.noWorkers();
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"}).code,
        "MODEL_WORKFLOW_NO_ENABLED_WORKER");
});
test("only a completed Worker result in the originating conversation authorizes the workspace",()=>{
    const f=fixture();f.enable();
    f.gate.onDelegate(completed(),"chat-one");
    assert.equal(f.gate.onResult({...completed(),status:"running"},"chat-one").granted,false);
    assert.equal(f.gate.onResult(completed(),"chat-two").granted,false);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat-two").allowed,false);
    assert.equal(f.gate.onResult(completed(),"chat-one").granted,true);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat-one").allowed,true);
    assert.equal(f.gate.authorize("exec_command",{workspaceId:"ws1"},"chat-one").allowed,true);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws2"},"chat-one").allowed,false);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat-two").allowed,false);
});
test("failed Worker is never an authorization, and old result cannot be replayed",()=>{
    const f=fixture();f.enable();
    f.gate.onDelegate(completed(),"chat");
    assert.equal(f.gate.onResult({...completed(),status:"failed"},"chat").granted,false);
    assert.equal(f.gate.authorize("write",{workspaceId:"ws1"},"chat").allowed,false);
    assert.equal(f.gate.onResult(completed(),"chat").granted,true);
    assert.equal(f.gate.onResult(completed(),"chat").granted,false);
});
test("disabling or reconfiguring a Worker immediately invalidates its grant",()=>{
    const f=fixture();f.enable();
    f.gate.onDelegate(completed(),"chat");
    assert.equal(f.gate.onResult(completed(),"chat").granted,true);
    f.disabledWorker();
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,false);
    f.reenabledWorker();
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,false);
});
test("mode changes and TTL expiry revoke previous approvals",()=>{
    const f=fixture();f.enable();
    f.gate.onDelegate(completed(),"chat");
    f.gate.onResult(completed(),"chat");
    f.advance(3100);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,false);
    f.gate.onDelegate(completed("task2"),"chat");
    f.gate.onResult(completed("task2"),"chat");
    f.disable();assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,true);
    f.rotate();assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,false);
});
test("corrupt force policy fails closed, never silently disables mandatory mode",()=>{
    const f=fixture();
    const gate=createModelWorkflowGate({modelWorker:f.worker,
        readPolicy:()=>{throw new Error("CORRUPT");}});
    assert.equal(gate.authorize("edit_file",{workspaceId:"ws1"}).allowed,false);
    assert.equal(gate.authorize("model_task_cancel",{taskId:"abc"}).allowed,true);
});
test("MCP HTTP transport handles all tools/call including plugin tools",()=>{
    const s=readFileSync(resolve(repo,"vendor/waishnav-devspace/dist/server.js"),"utf8");
    assert.match(s,/req\.body\?\.method==="tools\/call"/);
    assert.match(s,/modelWorkflowGates\.get\(transport\)/);
    assert.match(s,/model_workflow_tool_blocked/);
    assert.match(s,/Batch tools\/call requests are disabled/);
    assert.match(s,/modelWorkflowGate\?\.onDelegate/);
    assert.match(s,/modelWorkflowGate\?\.onResult/);
});
