import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {randomUUID} from "node:crypto";

// The Host retains its choice of model. When the owner enables this policy,
// DevSpace requires an explicit Worker dispatch for protected MCP operations.
// A dispatched Worker must not stall the Host's independent read/plan/review
// work. Mutations are serialized while a write-capable Worker is active.
// Control/recovery tools remain usable at all times.
const GRANT_TTL_MS = 5 * 60_000;
const EXEMPT = new Set([
    "model_worker_list", "model_delegate_task", "model_task_status",
    "model_task_result", "model_task_cancel",
    "continuation_task", "continuation_anchor", "continuation_sender",
    "doctor", "doctor_history", "capabilities", "health",
]);
const READ_ONLY = new Set([
    "read", "read_attachment", "show_changes", "session_changes",
    "session_list", "audit_log_list", "event_poll", "file_watch_poll",
    "file_watch_list", "process_list", "process_attach",
    "plugin_list", "plugin_read", "plugin_query", "permission_rules_list",
    "permission_rules_test", "memory_list", "hook_list",
]);

export function modelWorkflowPolicy(root){
    const filename=resolve(root,"data","config","model-workflow.json");
    let value;
    try{value=JSON.parse(readFileSync(filename,"utf8"));}
    catch(error){
        if(error?.code==="ENOENT")return {enabled:false,updatedAt:null};
        throw new Error("MODEL_WORKFLOW_POLICY_UNREADABLE");
    }
    if(value?.formatVersion!==1||typeof value.enabled!=="boolean")
        throw new Error("MODEL_WORKFLOW_POLICY_INVALID");
    return {enabled:value.enabled,updatedAt:String(value.updatedAt||"")};
}

export function createModelWorkflowGate({
    portableRoot,modelWorker,readPolicy=()=>modelWorkflowPolicy(portableRoot),
    now=()=>Date.now(),grantTtlMs=GRANT_TTL_MS,
    isRemoteWorkspaceId=()=>false,
}){
    const connectionIdentity=randomUUID();
    const owners=new Map();
    const grants=new Map();
    const who=conversationScopeId=>conversationScopeId
        ? "conversation:"+conversationScopeId:"session:"+connectionIdentity;
    const key=(scope,workspaceId)=>scope+"\0"+workspaceId;
    function enabledProfiles(){
        return modelWorker.models().filter(m=>m.allowCalls!==false);
    }
    function blocked(code,reason){
        return {allowed:false,code,
            message:reason+" Required: call model_worker_list and dispatch model_delegate_task for the opened local workspace. The Host may continue reading while the Worker runs. If the Worker can write, inspect its terminal model_task_result before starting Host mutations. The owner can disable mandatory workflow in DevSpace Portable."};
    }
    return {
        policy:readPolicy,
        // An in-flight Host mutation holds a workspace writer lease until the
        // MCP call returns. A Worker cannot start writing in that interval.
        enter(name,args={}){
            if(EXEMPT.has(name)||READ_ONLY.has(name)||name==="open_workspace")
                return null;
            const workspaceId=typeof args?.workspaceId==="string"?args.workspaceId:"";
            if(!workspaceId)return null;
            modelWorker.beginHostMutation?.(workspaceId);
            return ()=>modelWorker.endHostMutation?.(workspaceId);
        },
        authorize(name,args={},conversationScopeId){
            if(EXEMPT.has(name))return {allowed:true};
            let policy;
            try{policy=readPolicy();}
            catch{return blocked("MODEL_WORKFLOW_POLICY_INVALID",
                "Mandatory model workflow configuration cannot be read safely.");}
            const workspaceId=typeof args?.workspaceId==="string"?args.workspaceId:"";
            // The Worker runtime is shared across MCP conversations. Do not
            // allow a different conversation to mutate while it owns a writer.
            const writerBusy=workspaceId && modelWorker.hasActiveWriter?.(workspaceId);
            if(!policy.enabled){
                if(writerBusy&&!READ_ONLY.has(name))return blocked(
                    "MODEL_WORKFLOW_WORKSPACE_WRITER_BUSY",
                    "A write-capable Worker is already editing this workspace.");
                return {allowed:true};
            }
            if(name==="open_workspace"){
                if(args?.mode==="worktree")return blocked("MODEL_WORKFLOW_BOOTSTRAP_WORKTREE_DENIED",
                    "Mandatory model workflow permits only checkout when opening a workspace. Do not create a new worktree before delegation.");
                return {allowed:true};
            }
            // The built-in Worker can only open local checkout workspaces.
            // Do not deadlock a remote-agent session behind an impossible
            // delegation. Trust the registry, never a caller-supplied backend.
            let remote=false;
            if(workspaceId){
                try{remote=isRemoteWorkspaceId(workspaceId)===true;}
                catch{remote=false;}
            }
            if(remote){
                if(writerBusy&&!READ_ONLY.has(name))return blocked(
                    "MODEL_WORKFLOW_WORKSPACE_WRITER_BUSY",
                    "A write-capable Worker is already editing this workspace.");
                return {allowed:true,scope:"remote-workspace",
                    delegationRequired:false};
            }
            let active;
            try{active=enabledProfiles();}
            catch{return blocked("MODEL_WORKFLOW_PROVIDER_CONFIG_INVALID",
                "The model provider configuration is unreadable.");}
            if(!active.length)return blocked("MODEL_WORKFLOW_NO_ENABLED_WORKER",
                "Mandatory model workflow is enabled but no callable Worker is allowed.");
            if(!workspaceId)return blocked("MODEL_WORKFLOW_WORKSPACE_REQUIRED",
                "Open a local workspace before using a task tool while mandatory model workflow is enabled.");
            const approval=grants.get(key(who(conversationScopeId),workspaceId));
            if(!approval||approval.policyVersion!==policy.updatedAt)
                return blocked("MODEL_WORKFLOW_DELEGATION_REQUIRED",
                    "This MCP session/conversation has not dispatched a recent enabled Worker for this workspace.");
            if(!active.some(m=>m.id===approval.modelId &&
                (m.callPolicyRevision||"")===approval.profileRevision))
                return blocked("MODEL_WORKFLOW_WORKER_DISABLED",
                    "The Worker used for this workflow has been disabled, removed or reconfigured.");
            let workerStatus;
            try{workerStatus=modelWorker.status(approval.taskId).status;}
            catch{return blocked("MODEL_WORKFLOW_TASK_MISSING",
                "The delegated Worker task is no longer available; dispatch a new one.");}
            const running=["queued","running"].includes(workerStatus);
            if(!running&&approval.expiresAt<=now())return blocked(
                "MODEL_WORKFLOW_DELEGATION_EXPIRED",
                "The most recent Worker delegation has expired.");
            if(READ_ONLY.has(name))return {allowed:true,via:approval.modelId,
                workerStatus,parallel:true};
            if(writerBusy || (approval.allowWrites&&!approval.reviewed))return blocked(
                "MODEL_WORKFLOW_WORKSPACE_WRITER_BUSY",
                "A write-capable Worker has not finished and had its outcome inspected; concurrent Host writes are unsafe.");
            return {allowed:true,via:approval.modelId,workerStatus};
        },
        onDelegate(result,conversationScopeId){
            if(typeof result?.taskId!=="string")return;
            let policy;
            try{policy=readPolicy();}
            catch{return;}
            if(!policy.enabled)return;
            let active;
            try{active=enabledProfiles();}
            catch{return;}
            const profile=active.find(m=>m.id===result.modelId);
            if(!profile)return;
            const owner={
                scope:who(conversationScopeId),workspaceId:result.workspaceId,
                modelId:result.modelId,createdAt:now(),
                policyVersion:policy.updatedAt,allowWrites:result.allowWrites===true,
                profileRevision:profile.callPolicyRevision||"",reviewed:false,
            };
            owners.set(result.taskId,owner);
            grants.set(key(owner.scope,owner.workspaceId),{
                taskId:result.taskId,...owner,expiresAt:now()+grantTtlMs,
            });
            if(owners.size>128){
                for(const [id,entry] of owners){
                    if(now()-entry.createdAt>GRANT_TTL_MS)owners.delete(id);
                }
            }
        },
        onResult(result,conversationScopeId){
            const owner=owners.get(result?.taskId);
            let policy;
            try{policy=readPolicy();}
            catch{return {granted:false};}
            if(!owner||owner.scope!==who(conversationScopeId)||
                owner.workspaceId!==result.workspaceId||
                owner.modelId!==result.modelId||
                owner.policyVersion!==policy.updatedAt||
                !policy.enabled||
                !["completed","failed","cancelled"].includes(result.status))return {granted:false};
            let active;
            try{active=enabledProfiles();}
            catch{return {granted:false};}
            const profile=active.find(m=>m.id===owner.modelId);
            if(!profile)return {granted:false};
            const grant=grants.get(key(owner.scope,owner.workspaceId));
            if(!grant||grant.taskId!==result.taskId||grant.reviewed||
                (profile.callPolicyRevision||"")!==owner.profileRevision)
                return {granted:false};
            grant.reviewed=true;
            grant.workerOutcome=result.status;
            grant.expiresAt=now()+grantTtlMs;
            owners.delete(result.taskId);
            return {granted:true,workerOutcome:result.status,
                expiresAt:grant.expiresAt};
        },
    };
}
