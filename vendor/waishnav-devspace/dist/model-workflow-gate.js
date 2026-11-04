import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {randomUUID} from "node:crypto";

// The Host retains its choice of model. When the owner enables this policy,
// DevSpace itself refuses substantive MCP tool calls until an enabled Worker
// has actually finished an explicit delegation in the same MCP session and
// conversation scope. Control/recovery tools must remain usable at all times.
const GRANT_TTL_MS = 5 * 60_000;
const EXEMPT = new Set([
    "model_worker_list", "model_delegate_task", "model_task_status",
    "model_task_result", "model_task_cancel",
    "continuation_task", "continuation_anchor", "continuation_sender",
    "doctor", "doctor_history", "capabilities", "health",
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
            message:reason+" Required: call model_worker_list, then model_delegate_task for the opened local workspace, wait for status=completed, and call model_task_result before resuming. Disabling the switch in DevSpace Portable releases this precondition."};
    }
    return {
        policy:readPolicy,
        authorize(name,args={},conversationScopeId){
            if(EXEMPT.has(name))return {allowed:true};
            let policy;
            try{policy=readPolicy();}
            catch{return blocked("MODEL_WORKFLOW_POLICY_INVALID",
                "Mandatory model workflow configuration cannot be read safely.");}
            if(!policy.enabled)return {allowed:true};
            if(name==="open_workspace"){
                if(args?.mode==="worktree")return blocked("MODEL_WORKFLOW_BOOTSTRAP_WORKTREE_DENIED",
                    "Mandatory model workflow permits only checkout when opening a workspace. Do not create a new worktree before delegation.");
                return {allowed:true};
            }
            let active;
            try{active=enabledProfiles();}
            catch{return blocked("MODEL_WORKFLOW_PROVIDER_CONFIG_INVALID",
                "The model provider configuration is unreadable.");}
            if(!active.length)return blocked("MODEL_WORKFLOW_NO_ENABLED_WORKER",
                "Mandatory model workflow is enabled but no callable Worker is allowed.");
            const workspaceId=typeof args?.workspaceId==="string"?args.workspaceId:"";
            if(!workspaceId)return blocked("MODEL_WORKFLOW_WORKSPACE_REQUIRED",
                "Open a local workspace before using a task tool while mandatory model workflow is enabled.");
            const approval=grants.get(key(who(conversationScopeId),workspaceId));
            if(!approval||approval.expiresAt<=now()||
                approval.policyVersion!==policy.updatedAt)
                return blocked("MODEL_WORKFLOW_DELEGATION_REQUIRED",
                    "This MCP session/conversation has not completed a recent enabled Worker delegation for the workspace.");
            if(!active.some(m=>m.id===approval.modelId &&
                (m.callPolicyRevision||"")===approval.profileRevision))
                return blocked("MODEL_WORKFLOW_WORKER_DISABLED",
                    "The Worker used for this workflow has been disabled, removed or reconfigured.");
            return {allowed:true,via:approval.modelId};
        },
        onDelegate(result,conversationScopeId){
            if(typeof result?.taskId!=="string")return;
            let policy;
            try{policy=readPolicy();}
            catch{return;}
            if(!policy.enabled)return;
            owners.set(result.taskId,{
                scope:who(conversationScopeId),workspaceId:result.workspaceId,
                modelId:result.modelId,createdAt:now(),
                policyVersion:policy.updatedAt,
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
                result.status!=="completed")return {granted:false};
            let active;
            try{active=enabledProfiles();}
            catch{return {granted:false};}
            const profile=active.find(m=>m.id===owner.modelId);
            if(!profile)return {granted:false};
            grants.set(key(owner.scope,owner.workspaceId),{
                modelId:owner.modelId,expiresAt:now()+grantTtlMs,
                policyVersion:policy.updatedAt,
                profileRevision:profile.callPolicyRevision||"",
            });
            owners.delete(result.taskId);
            return {granted:true,expiresAt:now()+grantTtlMs};
        },
    };
}
