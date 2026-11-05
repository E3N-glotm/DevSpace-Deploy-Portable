import test from "node:test";
import assert from "node:assert/strict";
import {createModelWorkflowGate} from "../dist/model-workflow-gate.js";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";

const repo=resolve(import.meta.dirname,"../../..");
function fixture({grantTtlMs=3000,maxGrantAgeMs=24*60*60_000}={}){
    let clock=1000;
    let policy={enabled:false,updatedAt:"revision-1"};
    let profiles=[{id:"w1",model:"qwen-local",allowCalls:true,callPolicyRevision:"profile-1"}];
    const jobs=new Map();
    const hostWrites=new Map();
    const worker={
        models:()=>profiles.filter(m=>m.allowCalls!==false),
        status:id=>{
            if(!jobs.has(id))throw new Error("UNKNOWN_MODEL_TASK");
            return {status:jobs.get(id).status};
        },
        hasActiveWriter:workspaceId=>[...jobs.values()].some(j=>
            j.workspaceId===workspaceId&&j.allowWrites&&
            ["queued","running"].includes(j.status)),
        beginHostMutation:workspaceId=>hostWrites.set(workspaceId,
            (hostWrites.get(workspaceId)||0)+1),
        endHostMutation:workspaceId=>hostWrites.set(workspaceId,
            (hostWrites.get(workspaceId)||0)-1),
    };
    const gate=createModelWorkflowGate({portableRoot:repo,modelWorker:worker,
        readPolicy:()=>policy,now:()=>clock,grantTtlMs,maxGrantAgeMs,
        isRemoteWorkspaceId:id=>id==="ws-remote"});
    return {gate,worker,hostWrites,
        delegate:(taskId="task1",workspaceId="ws1",scope="chat",allowWrites=false)=>{
            const result={taskId,workspaceId,modelId:"w1",
                status:"running",allowWrites};
            jobs.set(taskId,result);
            gate.onDelegate(result,scope);
            return result;
        },
        finish:(taskId="task1",status="completed")=>{
            jobs.get(taskId).status=status;
            return {...jobs.get(taskId)};
        },
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

test("MCP transport reconnect shares worker grants but isolates conversations",()=>{const f=fixture();f.enable();f.delegate("reconnect-task","ws1","chat-one");const g=createModelWorkflowGate({modelWorker:f.worker,readPolicy:()=>({enabled:true,updatedAt:"revision-2"}),now:()=>1000,grantTtlMs:3000});assert.equal(g.authorize("read",{workspaceId:"ws1"},"chat-one").allowed,true);assert.equal(g.authorize("read",{workspaceId:"ws1"},"chat-two").allowed,false);});
test("default mode permits upstream model to use tools without delegation",()=>{
    const f=fixture();
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"}).allowed,true);
    assert.equal(f.gate.authorize("exec_command",{workspaceId:"ws1"}).allowed,true);
});
test("forced mode preserves discovery, cancellation, diagnosis and the checkout bootstrap",()=>{
    const f=fixture();f.enable();
    for(const name of ["model_worker_list","model_delegate_task","model_task_status",
        "model_task_result","model_task_cancel","continuation_task",
        "continuation_anchor","continuation_sender","doctor","capabilities", "plugin_list","plugin_read","permission_rules_list","process_list","audit_log_list","session_list","memory_list","hook_list"]){
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
test("forced mode never blocks real remote-agent workspace operations for lack of a local Worker",()=>{
    const f=fixture();f.enable();f.noWorkers();
    for(const name of ["read","exec_command","apply_patch","show_changes"]){
        const decision=f.gate.authorize(name,{workspaceId:"ws-remote"},"remote-chat");
        assert.equal(decision.allowed,true,name);
        assert.equal(decision.scope,"remote-workspace",name);
        assert.equal(decision.delegationRequired,false,name);
    }
    assert.equal(f.gate.authorize("exec_command",{workspaceId:"ws1"}).code,
        "MODEL_WORKFLOW_NO_ENABLED_WORKER");
    assert.equal(f.gate.authorize("exec_command",{workspaceId:"invented-remote-id"}).code,
        "MODEL_WORKFLOW_NO_ENABLED_WORKER",
        "Untrusted workspaceId strings must not bypass the registry-backed remote check");
});
test("dispatch immediately unlocks Host inspection without waiting for Worker completion",()=>{
    const f=fixture();f.enable();
    f.delegate("task1","ws1","chat-one");
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat-one").allowed,true);
    assert.equal(f.gate.authorize("exec_command",{workspaceId:"ws1"},"chat-one").allowed,true);
    assert.equal(f.gate.onResult({...completed(),status:"running"},"chat-one").granted,false);
    assert.equal(f.gate.onResult(f.finish(),"chat-two").granted,false);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat-two").allowed,false);
    assert.equal(f.gate.onResult(completed(),"chat-one").granted,true);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat-one").allowed,true);
    assert.equal(f.gate.authorize("exec_command",{workspaceId:"ws1"},"chat-one").allowed,true);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws2"},"chat-one").allowed,false);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat-two").allowed,false);
});
test("a failed read-only Worker can be inspected and the Host can take over",()=>{
    const f=fixture();f.enable();
    f.delegate();
    assert.equal(f.gate.authorize("write",{workspaceId:"ws1"},"chat").allowed,true);
    const failure=f.finish("task1","failed");
    assert.equal(f.gate.onResult(failure,"chat").granted,true);
    assert.equal(f.gate.authorize("write",{workspaceId:"ws1"},"chat").allowed,true);
    assert.equal(f.gate.onResult(failure,"chat").granted,false);
});
test("disabling or reconfiguring a Worker immediately invalidates its grant",()=>{
    const f=fixture();f.enable();
    f.delegate();f.gate.onResult(f.finish(),"chat");
    f.disabledWorker();
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,false);
    f.reenabledWorker();
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,false);
});
test("mode changes and TTL expiry revoke previous approvals",()=>{
    const f=fixture();f.enable();
    f.delegate();f.gate.onResult(f.finish(),"chat");
    f.advance(3100);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,false);
    f.delegate("task2");f.gate.onResult(f.finish("task2"),"chat");
    f.disable();assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,true);
    f.rotate();assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,false);
});
test("active read and command calls renew the idle grant, while inactivity still expires",()=>{
    const f=fixture();f.enable();
    f.delegate();f.gate.onResult(f.finish(),"chat");
    f.advance(2500);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,true);
    f.advance(2500);
    assert.equal(f.gate.authorize("exec_command",{workspaceId:"ws1"},"chat").allowed,true,
        "A continuous monitoring workflow must not expire after its first five minutes");
    f.advance(2500);
    assert.equal(f.gate.authorize("write_stdin",{workspaceId:"ws1"},"chat").allowed,true);
    f.advance(3001);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").code,
        "MODEL_WORKFLOW_DELEGATION_EXPIRED");
});
test("denied cross-conversation operations cannot keep a grant alive",()=>{
    const f=fixture();f.enable();
    f.delegate();f.gate.onResult(f.finish(),"chat");
    f.advance(2500);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"different").allowed,false);
    f.advance(501);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").code,
        "MODEL_WORKFLOW_DELEGATION_EXPIRED");
});
test("absolute grant deadline applies even under continuous successful polling",()=>{
    const f=fixture({maxGrantAgeMs:7000});f.enable();
    f.delegate();f.gate.onResult(f.finish(),"chat");
    f.advance(2000);assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,true);
    f.advance(2000);assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,true);
    f.advance(2000);assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,true);
    f.advance(1000);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").code,
        "MODEL_WORKFLOW_DELEGATION_EXPIRED");
});
test("write-capable Worker allows parallel reads but serializes all Host mutations",()=>{
    const f=fixture();f.enable();
    f.delegate("write-task","ws1","chat",true);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"chat").allowed,true);
    assert.equal(f.gate.authorize("show_changes",{workspaceId:"ws1"},"chat").allowed,true);
    for(const name of ["apply_patch","exec_command","write"]){
        assert.equal(f.gate.authorize(name,{workspaceId:"ws1"},"chat").code,
            "MODEL_WORKFLOW_WORKSPACE_WRITER_BUSY");
    }
    // Cross-conversation mutation cannot race with the Worker even when
    // that second conversation does not have a valid delegation grant.
    assert.equal(f.gate.authorize("apply_patch",{workspaceId:"ws1"},"other").allowed,false);
    f.finish("write-task");
    assert.equal(f.gate.authorize("exec_command",{workspaceId:"ws1"},"chat").code,
        "MODEL_WORKFLOW_WORKSPACE_WRITER_BUSY");
    assert.equal(f.gate.onResult(f.finish("write-task"),"chat").granted,true);
    assert.equal(f.gate.authorize("exec_command",{workspaceId:"ws1"},"chat").allowed,true);
});
test("optional mode also protects a workspace while a write-capable Worker runs",()=>{
    const f=fixture();
    f.delegate("write-task","ws1","chat",true);
    assert.equal(f.gate.authorize("read",{workspaceId:"ws1"},"different").allowed,true);
    assert.equal(f.gate.authorize("apply_patch",{workspaceId:"ws1"},"different").code,
        "MODEL_WORKFLOW_WORKSPACE_WRITER_BUSY");
    f.finish("write-task");
    assert.equal(f.gate.authorize("apply_patch",{workspaceId:"ws1"},"different").allowed,true);
});
test("Host mutation leases span the MCP operation and are released afterwards",()=>{
    const f=fixture();f.enable();f.delegate();
    assert.equal(f.gate.enter("read",{workspaceId:"ws1"}),null);
    const release=f.gate.enter("apply_patch",{workspaceId:"ws1"});
    assert.equal(f.hostWrites.get("ws1"),1);
    release();
    assert.equal(f.hostWrites.get("ws1"),0);
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
    assert.match(s,/isRemoteWorkspaceId:workspaceId=>/);
    assert.doesNotMatch(s,/wait until completed and call model_task_result before workspace/);
});
