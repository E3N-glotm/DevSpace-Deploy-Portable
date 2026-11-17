import { createHash } from "node:crypto";
import { redactText } from "./redaction.js";

// Scope is supplied only by the authenticated server dispatch boundary, never
// by tool arguments. Keep the opaque identifier out of public task views/logs.
export function taskControlOwner(actor) {
    const source=actor?.source??"internal";
    const scope=source==="mcp"&&typeof actor.scope==="string"&&actor.scope
        ?createHash("sha256").update(actor.scope).digest("hex"):null;
    return {source,scope};
}

export function taskControlDecision(owner,actor,action,reason) {
    const caller=taskControlOwner(actor);
    const local=caller.source==="local-ui"||caller.source==="internal";
    const allowed=local||Boolean(caller.source==="mcp"&&caller.scope&&owner?.source==="mcp"&&owner.scope===caller.scope);
    const error=allowed?null:!owner||(owner.source==="mcp"&&!owner.scope)?"AGENT_TASK_OWNER_UNKNOWN":"AGENT_TASK_NOT_OWNED";
    const detail=typeof reason==="string"?redactText(reason.trim().slice(0,500)):"";
    return {action,source:caller.source,caller:caller.scope?.slice(0,16)??null,
        ownerSource:owner?.source??"legacy",owner:owner?.scope?.slice(0,16)??null,
        reason:detail||(caller.source==="local-ui"?"Local workbench user action":"Reason not supplied (legacy client)"),
        allowed,error,tool:actor?.tool??"agent_task_"+action};
}
