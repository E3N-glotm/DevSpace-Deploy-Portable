import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {randomUUID} from "node:crypto";

// The Host retains its choice of model. When the owner enables this policy,
// DevSpace requires an explicit Worker dispatch for protected MCP operations.
// A dispatched Worker must not stall the Host's independent read/plan/review
// work. Mutations are serialized while a write-capable Worker is active.
// Control/recovery tools remain usable at all times.
const GRANT_TTL_MS = 5 * 60_000;
// Active long-running MCP workflows refresh this idle lease. An absolute
// deadline still requires explicit re-delegation after a bounded workday.
const MAX_GRANT_AGE_MS = 24 * 60 * 60_000;
// Session-scoped MCP gate objects are reconstructed on transport reconnect.
// Keep grants on the shared worker runtime without adding mutable, public
// properties to it or leaking grants into a different Portable instance.
const sharedWorkerGrants = new WeakMap();
const EXEMPT = new Set([
    "model_worker_list", "model_delegate_task", "model_task_status",
    "model_task_result", "model_task_cancel",
    "agent_task_start","agent_task_list","agent_task_status","agent_task_events",
    "agent_task_pause","agent_task_resume","agent_task_cancel",
    "continuation_task", "continuation_anchor", "continuation_sender",
    "doctor", "doctor_history", "capabilities", "health", "plugin_list", "plugin_read", "permission_rules_list", "process_list", "audit_log_list", "session_list", "memory_list", "hook_list",
]);
const READ_ONLY = new Set([
    "read", "read_file", "ls", "list_directory", "grep", "grep_files", "glob", "find_files",
    "read_attachment", "show_changes", "session_changes",
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
    maxGrantAgeMs=MAX_GRANT_AGE_MS,
    agentRuntime,
}){
    const connectionIdentity=randomUUID();
    let state=sharedWorkerGrants.get(modelWorker);
    if(!state){
        state={owners:new Map(),grants:new Map()};
        sharedWorkerGrants.set(modelWorker,state);
    }
    const {owners,grants}=state;
    const who=conversationScopeId=>conversationScopeId
        ? "conversation:"+conversationScopeId:"session:"+connectionIdentity;
    const key=(scope,workspaceId)=>scope+"\0"+workspaceId;
    function renewActiveGrant(approval){
        const current=now();
        const deadline=approval.createdAt+maxGrantAgeMs;
        if(current>=deadline)return false;
        // Denied actions must never extend an old authorization.
        approval.expiresAt=Math.min(current+grantTtlMs,deadline);
        return true;
    }
    function enabledProfiles(kind){
        const profiles=kind==="agent"?(modelWorker.agentProfiles?.()??[]):modelWorker.models();
        return profiles.filter(m=>m.allowCalls!==false);
    }
    function profilesMatch(refs,active){
        return refs.length>0&&refs.every(ref=>active.some(m=>m.id===ref.id&&(m.callPolicyRevision||"")===ref.revision));
    }
    function recordGrant(taskId,workspaceId,kind,via,refs,allowWrites,conversationScopeId){
        if(typeof taskId!=="string"||typeof workspaceId!=="string")return;
        let policy,active;
        try{policy=readPolicy();active=enabledProfiles(kind);}
        catch{return;}
        if(!policy.enabled||!profilesMatch(refs,active))return;
        const owner={scope:who(conversationScopeId),workspaceId,kind,via,refs,
            createdAt:now(),policyVersion:policy.updatedAt,allowWrites};
        owners.set(taskId,owner);
        grants.set(key(owner.scope,workspaceId),{taskId,...owner,expiresAt:now()+grantTtlMs});
        if(owners.size>128){
            for(const [id,entry] of owners){
                if(now()-entry.createdAt>maxGrantAgeMs)owners.delete(id);
            }
        }
        if(grants.size>256){
            for(const [id,entry] of grants){
                if(entry.expiresAt<=now()||entry.createdAt+maxGrantAgeMs<=now())grants.delete(id);
            }
        }
    }
    function recordInspection(taskId,kind,result,conversationScopeId){
        const owner=owners.get(taskId);
        let policy,active;
        try{policy=readPolicy();active=enabledProfiles(kind);}
        catch{return {granted:false};}
        if(!owner||owner.kind!==kind||owner.scope!==who(conversationScopeId)||
            owner.workspaceId!==result.workspaceId||owner.policyVersion!==policy.updatedAt||
            !policy.enabled||!profilesMatch(owner.refs,active))return {granted:false};
        if(kind==="worker"&&owner.via!==result.modelId)return {granted:false};
        const finished=["completed","failed","cancelled"].includes(result.status);
        const awaiting=kind==="agent"&&result.status==="awaiting-review"&&typeof result.result==="string"&&
            result.result.trim()&&result.pending==null;
        if(!finished&&!awaiting)return {granted:false};
        const grant=grants.get(key(owner.scope,owner.workspaceId));
        const revision=kind==="agent"?result.updatedAt:"worker-final";
        if(!grant||grant.taskId!==taskId||!revision||grant.reviewed===revision||
            now()>=grant.createdAt+maxGrantAgeMs)return {granted:false};
        grant.reviewed=revision;
        grant.workerOutcome=result.status;
        grant.expiresAt=Math.min(now()+grantTtlMs,grant.createdAt+maxGrantAgeMs);
        if(kind==="worker")owners.delete(taskId);
        return {granted:true,workerOutcome:result.status,expiresAt:grant.expiresAt};
    }
    function blocked(code,reason){
        return {allowed:false,code,
            message:reason+" List profiles with model_worker_list. Dispatch model_delegate_task or agent_task_start for the opened workspace, including remote workspaces. Read in parallel. For write-capable work, inspect model_task_result or the finished agent_task_status before Host mutations."};
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
            const approval=workspaceId?grants.get(key(who(conversationScopeId),workspaceId)):undefined;
            let active,anyProfile;
            try{
                const workers=enabledProfiles("worker"),agents=enabledProfiles("agent");
                active=approval?.kind==="agent"?agents:workers;
                anyProfile=workers.length||agents.length;
            }
            catch{return blocked("MODEL_WORKFLOW_PROVIDER_CONFIG_INVALID",
                "The model provider configuration is unreadable.");}
            if(!anyProfile)return blocked("MODEL_WORKFLOW_NO_ENABLED_WORKER",
                "Mandatory model workflow is enabled but no callable Worker or Agent profile is allowed.");
            if(!workspaceId)return blocked("MODEL_WORKFLOW_WORKSPACE_REQUIRED",
                "Open a workspace before using a task tool while mandatory model workflow is enabled.");
            if(!approval||approval.policyVersion!==policy.updatedAt)
                return blocked("MODEL_WORKFLOW_DELEGATION_REQUIRED",
                    "This MCP session/conversation has not dispatched a recent enabled Worker or Agent task for this workspace.");
            if(!profilesMatch(approval.refs,active))
                return blocked("MODEL_WORKFLOW_WORKER_DISABLED",
                    "The Worker used for this workflow has been disabled, removed or reconfigured.");
            let snapshot;
            try{snapshot=(approval.kind==="agent"?agentRuntime:modelWorker).status(approval.taskId);}
            catch{return blocked("MODEL_WORKFLOW_TASK_MISSING",
                "The delegated Worker task is no longer available; dispatch a new one.");}
            const workerStatus=snapshot.status;
            const running=["queued","running"].includes(workerStatus);
            if(now()>=approval.createdAt+maxGrantAgeMs)return blocked(
                "MODEL_WORKFLOW_DELEGATION_EXPIRED",
                "The delegated workflow has reached its maximum age.");
            if(!running&&approval.expiresAt<=now())return blocked(
                "MODEL_WORKFLOW_DELEGATION_EXPIRED",
                "The most recent Worker delegation has expired.");
            if(READ_ONLY.has(name)){
                renewActiveGrant(approval);
                return {allowed:true,via:approval.via,
                    workerStatus,parallel:true};
            }
            const inspected=approval.reviewed&&(approval.kind==="worker"||approval.reviewed===snapshot.updatedAt);
            if(writerBusy || (approval.allowWrites&&!inspected))return blocked(
                "MODEL_WORKFLOW_WORKSPACE_WRITER_BUSY",
                "A write-capable Worker has not finished and had its outcome inspected; concurrent Host writes are unsafe.");
            renewActiveGrant(approval);
            return {allowed:true,via:approval.via,workerStatus};
        },
        onDelegate(result,conversationScopeId){
            let profile;
            try{profile=enabledProfiles("worker").find(m=>m.id===result.modelId);}
            catch{return;}
            if(!profile)return;
            recordGrant(result.taskId,result.workspaceId,"worker",result.modelId,
                [{id:result.modelId,revision:profile.callPolicyRevision||""}],result.allowWrites===true,conversationScopeId);
        },
        onResult(result,conversationScopeId){
            return recordInspection(result.taskId,"worker",result,conversationScopeId);
        },
        onAgentStart(task,conversationScopeId){
            recordGrant(task.id,task.workspaceId,"agent",task.groupId||task.agents[0]?.profileId,
                task.agents.map(a=>({id:a.profileId,revision:a.revision||""})),task.writer===true,conversationScopeId);
        },
        onAgentStatus(task,conversationScopeId){
            return recordInspection(task.id,"agent",task,conversationScopeId);
        },
    };
}
