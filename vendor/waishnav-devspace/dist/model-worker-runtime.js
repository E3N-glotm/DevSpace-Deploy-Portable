import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, relative, isAbsolute, sep, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import reasoningAdapter from "./reasoning-adapter.cjs";
import {
    readFileTool, grepFilesTool, listDirectoryTool, writeFileTool, editFileTool,
} from "./pi-tools.js";

// The configured provider is not automatically the assistant for all MCP
// requests. A ChatGPT supervisor must explicitly call model_delegate_task.
// Credentials are never returned by any of the model_worker_* MCP tools.
const MAX_TASKS = 32;
const MAX_TASK_TEXT = 8000;
const MAX_MODEL_RESPONSE = 512 * 1024;
const MAX_TOOL_REPLY = 14000;
// OpenAI-compatible providers may stream real deltas, or reply with a
// conventional JSON body. Both paths preserve the actual returned content.
export async function collectAgentStream(response,limit,onDelta){
    const decoder=new TextDecoder();let buffer="",bytes=0,usage=null,lastEmit=0,finished=false,finishReason=null;
    const message={role:"assistant",content:"",reasoning_content:"",tool_calls:[]};
    const consume=line=>{
        if(!line.startsWith("data:"))return;
        const value=line.slice(5).trim();if(!value)return;if(value==="[DONE]"){finished=true;return;}
        const packet=JSON.parse(value);
        if(packet.error)throw Error("MODEL_STREAM_ERROR");
        if(packet.usage)usage=packet.usage;
        const delta=packet.choices?.[0]?.delta||{};
        if(packet.choices?.[0]?.finish_reason){finishReason=packet.choices[0].finish_reason;finished=true;}
        if(typeof delta.content==="string")message.content+=delta.content;
        if(typeof delta.reasoning_content==="string")message.reasoning_content+=delta.reasoning_content;
        else if(typeof delta.reasoning==="string")message.reasoning_content+=delta.reasoning;
        for(const c of delta.tool_calls||[]){
            const index=Number(c.index??0);
            if(!Number.isInteger(index)||index<0||index>128)throw Error("INVALID_STREAM_TOOL_INDEX");
            const entry=message.tool_calls[index]??={type:"function",id:"",function:{name:"",arguments:""}};
            if(c.id)entry.id+=c.id;
            if(c.function?.name)entry.function.name+=c.function.name;
            if(c.function?.arguments)entry.function.arguments+=c.function.arguments;
        }
        if(Date.now()-lastEmit>=1000&&(message.content||message.reasoning_content)){
            lastEmit=Date.now();onDelta?.(message);
        }
    };
    for await(const chunk of response.body){
        bytes+=chunk.length;if(bytes>limit)throw Error("MODEL_REPLY_TOO_LARGE");
        buffer+=decoder.decode(chunk,{stream:true});
        const lines=buffer.split(/\r?\n/);buffer=lines.pop()||"";
        for(const line of lines)consume(line);
    }
    buffer+=decoder.decode();if(buffer)consume(buffer);
    if(!finished||finishReason==="length"&&message.tool_calls.length)throw Error("MODEL_STREAM_INCOMPLETE");
    if(!message.content&&!message.reasoning_content&&!message.tool_calls.length)throw Error("MODEL_NO_MESSAGE");
    message.tool_calls=message.tool_calls.filter(Boolean);
    if(!message.tool_calls.length)delete message.tool_calls;
    if(!message.reasoning_content)delete message.reasoning_content;
    onDelta?.(message);
    return {choices:[{message}],usage};
}
// Long-running Workers are bounded by their explicit step/time/cost budgets,
// not by a hidden 24-tool-call quota. Memory usage is bounded separately.
const WORKER_HISTORY_MESSAGES = 120;
const TOOL_DEFINITIONS = [
    { type: "function", function: {
        name: "read_file", description: "Read a UTF-8 project file from the authorized workspace. Do not read secrets.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    } },
    { type: "function", function: {
        name: "list_directory", description: "List names inside a project directory.",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    } },
    { type: "function", function: {
        name: "grep_files", description: "Search project text by pattern. Returns bounded matches.",
        parameters: { type: "object", properties: {
            pattern: { type: "string" }, path: { type: "string" },
        }, required: ["pattern"] },
    } },
    { type: "function", function: {
        name: "edit_file", description: "Replace exact existing text blocks in one project file. Requires explicit write authorization.",
        parameters: { type: "object", properties: {
            path: { type: "string" }, edits: { type: "array", maxItems: 12,
                items: { type: "object", properties: { oldText: { type: "string" },
                    newText: { type: "string" } }, required: ["oldText","newText"] } },
        }, required: ["path","edits"] },
    } },
];

export function safeWorkerPath(root, raw, remote=false) {
    if (typeof raw !== "string" || !raw || raw.length > 500 || raw.includes("\0"))
        throw new Error("INVALID_WORKER_PATH");
    if (remote) raw=raw.replace(/\\/g,"/");
    const paths=remote?posix:{resolve,relative,isAbsolute,sep};
    if (paths.isAbsolute(raw) || /^[a-z]:/i.test(raw) || /^\\\\/.test(raw))
        throw new Error("WORKER_ABSOLUTE_PATH_DENIED");
    const full = paths.resolve(root, raw);
    const rel = paths.relative(root, full);
    if (rel === ".." || rel.startsWith(".." + paths.sep) || paths.isAbsolute(rel))
        throw new Error("WORKER_PATH_OUTSIDE_WORKSPACE");
    const parts = rel.split(/[\\/]+/);
    if (parts.some(p => /^(?:\.git|\.ssh|\.env|node_modules|data|secrets|credentials)$/i.test(p))
        || /(?:^|[\\/])\.env(?:\.|$)/i.test(rel))
        throw new Error("WORKER_SENSITIVE_PATH_DENIED");
    return { full, rel: rel || "." };
}

export function publicModelProfiles(root) {
    const filename = resolve(root, "data", "config", "model-providers.json");
    let config;
    try { config = JSON.parse(readFileSync(filename, "utf8")); }
    catch (e) { if (e?.code === "ENOENT") return []; throw new Error("MODEL_CONFIG_UNREADABLE"); }
    if (config.version !== 1 || !Array.isArray(config.models))
        throw new Error("MODEL_CONFIG_UNSUPPORTED");
    return config.models.map(({ encryptedKey,workerEncryptedKey, ...entry }) => ({
        ...entry, allowCalls:entry.allowCalls!==false,
        hasKey: Boolean(encryptedKey),hasWorkerKey:Boolean(workerEncryptedKey),
    }));
}

export function createModelWorkerRuntime({
    portableRoot, config, workspaces, reviewCheckpoints, hookManager,
    fetchImpl = globalThis.fetch, readProfiles = publicModelProfiles,
    prepareWrite = async () => {}, finishWrite = async () => {},
    usageStore,credentialVault,openRemoteWorkerTool,
}) {
    // The MCP server and Electron UI are distinct processes. Both write
    // independent, atomic model-request events into the same Portable data
    // directory; no live process memory or OAuth token is shared.
    const coreDirectory=dirname(fileURLToPath(import.meta.url));
    const modelUsageModule=[
        // Packaged Portable first. The statistics file must be tied to the
        // same user-data root as the profile, not to the module's location.
        resolve(portableRoot,"setup","model-usage.cjs"),
        // Source checkout running a freshly packed core beside an older
        // live install (the regression test harness uses this arrangement).
        resolve(coreDirectory,"../../../../../setup/model-usage.cjs"),
        resolve(coreDirectory,"../../../setup/model-usage.cjs"),
    ].find(file=>existsSync(file));
    if(!usageStore && !modelUsageModule)throw new Error("MODEL_USAGE_MODULE_MISSING");
    const accounting=usageStore ?? createRequire(import.meta.url)(
        modelUsageModule
    ).createModelUsageStore(portableRoot);
    const vaultModule=[
        resolve(portableRoot,"setup","model-dpapi-vault.cjs"),
        resolve(coreDirectory,"../../../../../setup/model-dpapi-vault.cjs"),
        resolve(coreDirectory,"../../../setup/model-dpapi-vault.cjs"),
    ].find(file=>existsSync(file));
    const vault=credentialVault ?? (vaultModule
        ?createRequire(import.meta.url)(vaultModule).createModelDpapiVault():null);
    const jobs = new Map();
    const activeHostMutations = new Map();
    const agentWriters = new Map();
    const backendQueues = new Map();
    async function withBackend(model,signal,fn,requestedLimit=1){
        // One FIFO admission controller per actual endpoint. A group can
        // explicitly opt into the known number of backend slots; unrelated
        // and legacy callers keep their conservative single-slot contract.
        const key=new URL(model.baseUrl).origin;
        const limit=Math.max(1,Math.min(8,Number(requestedLimit)||1));
        const state=backendQueues.get(key)||{active:new Map(),waiting:[]};
        backendQueues.set(key,state);
        const ticket={limit};
        function pump(){
            while(state.waiting.length){
                const next=state.waiting[0];
                const capacity=Math.min(next.limit,...state.active.values());
                if(state.active.size>=capacity)break;
                state.waiting.shift();state.active.set(next,next.limit);next.grant();
            }
            if(!state.waiting.length&&!state.active.size&&backendQueues.get(key)===state)backendQueues.delete(key);
        }
        let onAbort;
        try{
            await new Promise((grant,reject)=>{
                ticket.grant=grant;
                onAbort=()=>{const i=state.waiting.indexOf(ticket);if(i>=0){state.waiting.splice(i,1);reject(Error("AGENT_REQUEST_ABORTED"));pump();}};
                if(signal?.aborted){reject(Error("AGENT_REQUEST_ABORTED"));pump();return;}
                state.waiting.push(ticket);signal?.addEventListener("abort",onAbort,{once:true});pump();
            });
            if(signal?.aborted)throw Error("AGENT_REQUEST_ABORTED");
            return await fn();
        }finally{signal?.removeEventListener("abort",onAbort);state.active.delete(ticket);pump();}
    }
    const restricted = (text, n = MAX_TOOL_REPLY) => String(text || "").slice(0, n);
    function snapshot(job, includeAnswer = false) {
        return {
            taskId: job.taskId, workspaceId: job.workspaceId,
            modelId: job.modelId, status: job.status,
            allowWrites: job.allowWrites,
            startedAt: job.startedAt, finishedAt: job.finishedAt || null,
            steps: job.steps, toolCalls: job.toolCalls,
            inputTokens: job.inputTokens, outputTokens: job.outputTokens,
            estimatedUSD: Number(job.estimatedUSD.toFixed(7)),
            maxTaskUSD: job.maxTaskUSD,
            ...(includeAnswer ? { answer: job.answer || "",
                error: job.error || null, evidence: job.evidence.slice(-25) } : {}),
        };
    }
    function find(taskId) {
        const job = jobs.get(taskId);
        if (!job) throw new Error("UNKNOWN_MODEL_TASK");
        return job;
    }
    function getProfile(id, agent=false) {
        const models = readProfiles(portableRoot);
        const model = models.find(p => p.id === id);
        if (!model || (!agent && model.role !== "worker")) throw new Error("WORKER_PROFILE_NOT_FOUND");
        if (model.allowCalls === false) throw new Error("WORKER_PROFILE_DISABLED");
        if (model.hasKey && !model.hasWorkerKey)
            throw new Error("MODEL_API_KEY_NEEDS_SECURE_NATIVE_VAULT_BRIDGE");
        if (!model.model || model.api !== "chat")
            throw new Error("WORKER_REQUIRES_CHAT_COMPLETIONS_MODEL");
        const url = new URL(model.baseUrl);
        if (!["http:", "https:"].includes(url.protocol)
            || url.username || url.password || url.search || url.hash)
            throw new Error("UNSAFE_MODEL_URL");
        if (url.protocol === "http:" && !["localhost","127.0.0.1","[::1]"].includes(url.hostname.toLowerCase())
            && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname))
            throw new Error("UNSAFE_HTTP_MODEL_URL");
        return model;
    }
    function workerAuthorization(model,agent=false){
        if(!model.hasKey)return {};
        if(!vault)throw new Error("MODEL_WORKER_VAULT_UNAVAILABLE");
        // Public model listings intentionally omit both encrypted key fields.
        // Read the user-scoped ciphertext directly from the local private
        // configuration, ensuring the same saved profile/revision is active.
        let saved;
        try{
            const file=resolve(portableRoot,"data","config","model-providers.json");
            const models=JSON.parse(readFileSync(file,"utf8"));
            saved=models.models?.find(p=>p.id===model.id);
        }catch{throw new Error("MODEL_WORKER_VAULT_UNAVAILABLE");}
        if(!saved?.workerEncryptedKey||!saved?.encryptedKey||
            saved.callPolicyRevision!==model.callPolicyRevision||
            saved.allowCalls===false||(!agent&&saved.role!=="worker"))
            throw new Error("MODEL_WORKER_VAULT_PROFILE_CHANGED");
        let secret;
        try{secret=vault.decryptString(saved.workerEncryptedKey);}
        catch{throw new Error("MODEL_WORKER_VAULT_DECRYPT_FAILED");}
        if(typeof secret!=="string"||!secret||secret.length>8192||/[\r\n]/.test(secret))
            throw new Error("MODEL_WORKER_VAULT_INVALID_SECRET");
        return {Authorization:"Bearer "+secret};
    }
    async function tool(job, call, workspace) {
        getProfile(job.modelId);
        const name = String(call?.function?.name || "");
        const allowed = ["read_file","list_directory","grep_files","edit_file"];
        if (!allowed.includes(name)) throw new Error("WORKER_TOOL_NOT_ALLOWED");
        if (name === "edit_file" && !job.allowWrites) throw new Error("WRITE_REQUIRES_EXPLICIT_APPROVAL");
        let args;
        try { args = JSON.parse(call.function.arguments || "{}"); }
        catch { throw new Error("INVALID_TOOL_ARGUMENTS"); }
        const pathname = typeof args.path === "string" ? args.path : ".";
        const remote=workspace.backend==="remote-agent";
        const location = safeWorkerPath(workspace.root, pathname, remote);
        if (name === "grep_files" && (typeof args.pattern !== "string" || args.pattern.length > 160))
            throw new Error("INVALID_GREP_PATTERN");
        if (name === "edit_file") {
            if (!config.permissions.allowShellMutation && !config.permissions.allowArbitraryCommands)
                throw new Error("WRITE_PERMISSION_DENIED");
            if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > 12
                || args.edits.some(e=>typeof e?.oldText !== "string" || !e.oldText
                    || typeof e.newText !== "string" || e.newText.length>10000))
                throw new Error("INVALID_EDIT_ARGUMENTS");
        }
        const run=remote
            ? await openRemoteWorkerTool(workspace,name,{...args,path:location.rel})
            : await openLocalWorkerTool(workspace,name,location,args);
        let result;
        if (name === "edit_file") {
            await prepareWrite(job.workspaceId,workspace,location.rel);
            try{result=await run();}
            catch(error){
                await finishWrite(job.workspaceId,workspace,location.rel,false);
                throw error;
            }
            await finishWrite(job.workspaceId,workspace,location.rel,!result?.isError);
        }else result=await run();
        job.evidence.push({tool:name,path:location.rel,ok:!result?.isError});
        return restricted((result?.content||[]).map(c=>c.text||"").join("\n"));
    }
    async function openLocalWorkerTool(workspace,name,location,args){
        // Resolve existing parents, to stop a symlink from escaping the
        // workspace even if the relative path passes a lexical check.
        const fs = await import("node:fs/promises");
        let candidate = location.full;
        while (true) {
            try {
                const actual = await fs.realpath(candidate);
                const rel = relative(workspace.root, actual);
                if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
                    throw new Error("WORKER_SYMLINK_ESCAPE_DENIED");
                safeWorkerPath(workspace.root, rel || ".");
                break;
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
                const parent = resolve(candidate, "..");
                if (parent === candidate) throw error;
                candidate = parent;
            }
        }
        const context = { cwd: workspace.root, root: workspace.root, allowExternalPaths: false };
        if (name === "read_file") return ()=>readFileTool({
            path: location.rel,limit:180,
        }, context);
        if (name === "list_directory") return ()=>listDirectoryTool({path:location.rel},context);
        if (name === "grep_files") return ()=>grepFilesTool({path:location.rel,pattern:args.pattern},context);
        return ()=>editFileTool({path:location.rel,edits:args.edits},context);
    }
    async function infer(job, model, messages, tools, agent=false, signal, onDelta) {
        const current=getProfile(job.modelId,agent);
        if(agent&&current.callPolicyRevision!==model.callPolicyRevision)throw Error("AGENT_PROFILE_CHANGED_OR_DISABLED");
        const remaining = job.maxTaskUSD - job.estimatedUSD;
        // Refuse a new paid request if remaining budget cannot cover even
        // the configured maximum output tokens. True billing varies by provider.
        const outputReserve=(model.maxOutputTokens||4096)*(model.outputPerMillionUSD||0)/1e6+
            (agent?Math.ceil(JSON.stringify([messages,tools]).length/2)*(model.inputPerMillionUSD||0)/1e6:0);
        if (remaining < outputReserve) throw new Error("MODEL_TASK_BUDGET_EXHAUSTED");
        const maxTokens=agent?Math.max(16,model.maxOutputTokens||4096):Math.min(2048,Math.max(16,model.maxOutputTokens||2048));
        const controller=new AbortController();job.controller=controller;
        const abort=()=>controller.abort();
        signal?.addEventListener("abort",abort,{once:true});
        if(signal?.aborted)abort();
        // Disabling a profile is a hard stop even for a request which is
        // already waiting on the model HTTP endpoint.
        const disabledCheck=setInterval(()=>{
            try{const current=getProfile(job.modelId,agent);if(agent&&current.callPolicyRevision!==model.callPolicyRevision)controller.abort();}
            catch{controller.abort();}
        },500);
        disabledCheck.unref?.();
        const startedAt=new Date().toISOString();
        const startedNs=process.hrtime.bigint();
        let succeeded=false;
        let actualUsage=null;
        const timeout=setTimeout(()=>controller.abort(),Math.max(1,Math.min(agent?1800000:180000,job.deadline-Date.now())));
        try {
            const url=model.baseUrl.replace(/\/$/,"")+"/chat/completions";
            const authorization=workerAuthorization(model,agent);
            const reasoning=reasoningAdapter.resolveReasoning(model,maxTokens);
            const thinking=agent?reasoning.parameters:model.type==="deepseek"?{thinking:{type:"disabled"}}:{temperature:0};
            const response=await fetchImpl(url,{
                method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json",
                    ...authorization},
                redirect:"error",signal:controller.signal,
                body:JSON.stringify({model:model.model,messages,tools,tool_choice:"auto",stream:agent,
                    ...(agent?{stream_options:{include_usage:true}}:{}),
                    max_tokens:maxTokens,
                    ...thinking}),
            });
            if(!response.ok)throw new Error("MODEL_HTTP_"+response.status);
            const length=Number(response.headers?.get?.("content-length")||0);
            const replyLimit=agent?Math.max(MAX_MODEL_RESPONSE,Math.min(32*1024*1024,maxTokens*24)):MAX_MODEL_RESPONSE;
            if (length>replyLimit)throw new Error("MODEL_REPLY_TOO_LARGE");
            let json;
            if(agent&&String(response.headers?.get?.("content-type")||"").includes("text/event-stream"))
                json=await collectAgentStream(response,replyLimit,onDelta);
            else{
                const raw=await response.text();
                if (Buffer.byteLength(raw,"utf8")>replyLimit)throw new Error("MODEL_REPLY_TOO_LARGE");
                try {json=JSON.parse(raw);}catch {throw new Error("MODEL_INVALID_JSON");}
            }
            const usage=json.usage||{};
            actualUsage=json.usage||null;
            const reply=json.choices?.[0]?.message;
            if(!reply)throw new Error("MODEL_NO_MESSAGE");
            succeeded=true;
            job.inputTokens+=Number(usage.prompt_tokens||0);
            job.outputTokens+=Number(usage.completion_tokens||0);
            job.estimatedUSD+=
                ((Number(usage.prompt_tokens||0)*(model.inputPerMillionUSD||0))+
                 (Number(usage.completion_tokens||0)*(model.outputPerMillionUSD||0)))/1e6;
            if(job.estimatedUSD>job.maxTaskUSD)throw new Error("MODEL_TASK_BUDGET_EXHAUSTED");
            if(agent)job.reasoning={...reasoning,...reasoningAdapter.reasoningEvidence(reply,usage),usageReported:Boolean(actualUsage)};
            return reply;
        } finally {
            clearInterval(disabledCheck);
            clearTimeout(timeout);job.controller=null;signal?.removeEventListener("abort",abort);
            try{
                accounting.record({
                    profileId:job.modelId,model:model.model,source:"worker",
                    success:succeeded,startedAt,
                    durationMs:Math.round(Number(process.hrtime.bigint()-startedNs)/1e6),
                    inputTokens:Number(actualUsage?.prompt_tokens||actualUsage?.input_tokens||0),
                    outputTokens:Number(actualUsage?.completion_tokens||actualUsage?.output_tokens||0),
                    estimatedUSD:actualUsage?(
                        Number(actualUsage.prompt_tokens||actualUsage.input_tokens||0)
                          *Number(model.inputPerMillionUSD||0)
                        +Number(actualUsage.completion_tokens||actualUsage.output_tokens||0)
                          *Number(model.outputPerMillionUSD||0)
                    )/1e6:0,
                    usageReported:Boolean(actualUsage),
                });
            }catch{console.warn("MODEL_USAGE_WRITE_FAILED");}
        }
    }
    async function run(job,workspace,model) {
        job.status="running";
        try{
            const messages=[
                {role:"system",content:
                    "You are a DevSpace Worker working under the ChatGPT supervisor. "+
                    "Only use the available workspace tools; never invent test outcomes. "+
                    "No shell, network, privilege changes or secret access. "+
                    "Read the relevant files first and return a concise verifiable report. "+
                    (job.allowWrites?"You may edit workspace files only when necessary.":
                        "You MUST NOT edit any files.")},
                {role:"user",content:job.instruction},
            ];
            const allowedTools=TOOL_DEFINITIONS.filter(t=>job.allowWrites||
                t.function.name!=="edit_file");
            while(true){
                getProfile(job.modelId);
                if(job.cancelled)throw new Error("MODEL_TASK_CANCELLED");
                if(Date.now()>job.deadline)throw new Error("MODEL_TASK_TIMEOUT");
                const result=await withBackend(model,null,()=>infer(job,model,messages,allowedTools));
                getProfile(job.modelId);
                if(job.cancelled)throw new Error("MODEL_TASK_CANCELLED");
                if(!result)throw new Error("MODEL_NO_MESSAGE");
                const calls=Array.isArray(result.tool_calls)?result.tool_calls:[];
                if(!calls.length){
                    job.answer=restricted(result.content,12000);
                    job.status="completed";return;
                }
                messages.push({role:"assistant",content:result.content||null,tool_calls:calls});
                for(const call of calls){
                    if(job.cancelled)throw new Error("MODEL_TASK_CANCELLED");
                    job.toolCalls++;
                    let output;
                    try{output=await tool(job,call,workspace);}
                    catch(e){output="TOOL_DENIED: "+String(e.message).slice(0,200);
                        job.evidence.push({tool:String(call.function?.name||"unknown"),ok:false,error:output});}
                    messages.push({role:"tool",tool_call_id:call.id,content:output});
                }
                job.steps++;
                if(job.evidence.length>100)
                    job.evidence.splice(0,job.evidence.length-100);
                // Repeated tools should not grow every subsequent model prompt
                // without bound. Keep the instructions and recent complete
                // assistant/tool turns. Older turns can be re-read as needed.
                if(messages.length>WORKER_HISTORY_MESSAGES){
                    let remove=messages.length-WORKER_HISTORY_MESSAGES;
                    // Never truncate between an assistant tool_calls message
                    // and its tool results: preserve a valid Chat Completions
                    // message sequence.
                    let cut=2;
                    while(remove>0 && cut<messages.length-2){
                        if(messages[cut].role==="assistant"&&
                            Array.isArray(messages[cut].tool_calls)){
                            const groupSize=1+messages[cut].tool_calls.length;
                            cut+=groupSize;remove-=groupSize;
                        }else{cut++;remove--;}
                    }
                    if(cut>2){
                        messages.splice(2,cut-2);
                        messages.splice(2,0,{role:"system",content:
                            "Earlier tool history has been compacted to fit the model context. "+
                            "The original user task remains in the first user message. "+
                            "Inspect workspace files again when specific prior details are needed."});
                    }
                }
            }
        }catch(error){
            job.status=job.cancelled?"cancelled":"failed";
            job.error=String(error?.message||"MODEL_RUNTIME_FAILURE").slice(0,300);
        }finally{job.finishedAt=new Date().toISOString();job.controller=null;
            job.instruction=""; /* never retain task prompt after completion */}
    }
    return {
        models:()=>readProfiles(portableRoot).filter(m=>m.role==="worker"&&m.allowCalls!==false),
        agentProfiles:()=>readProfiles(portableRoot).filter(m=>m.allowCalls!==false&&m.api==="chat"),
        async agentRequest(task,agent,model,messages,tools,signal,onDelta){
            const job={modelId:agent.profileId,deadline:task.deadline,maxTaskUSD:model.maxTaskUSD||1,
                inputTokens:agent.inputTokens,outputTokens:agent.outputTokens,estimatedUSD:agent.estimatedUSD};
            const deadlineController=new AbortController();
            const requestSignal=signal?AbortSignal.any([signal,deadlineController.signal]):deadlineController.signal;
            let timer;
            function armDeadline(){
                const remaining=task.deadline-Date.now();
                if(remaining<=0)deadlineController.abort();
                else timer=setTimeout(armDeadline,Math.min(remaining,2_147_483_647));
            }
            armDeadline();
            try{
                return await withBackend(model,requestSignal,()=>infer(job,model,messages,tools,true,requestSignal,onDelta),task.backendParallelism);
            }catch(error){
                if(!signal?.aborted&&(deadlineController.signal.aborted||Date.now()>=task.deadline))throw Error("AGENT_TIME_BUDGET_EXHAUSTED");
                throw error;
            }
            finally{clearTimeout(timer);agent.inputTokens=job.inputTokens;agent.outputTokens=job.outputTokens;agent.estimatedUSD=job.estimatedUSD;if(job.reasoning)agent.reasoning=job.reasoning;}
        },
        beginAgentWriter(workspaceId,id){
            if(this.hasActiveWriter(workspaceId)||(activeHostMutations.get(workspaceId)||0)>0)
                throw Error("WORKER_WORKSPACE_SINGLE_WRITER_BUSY");
            agentWriters.set(workspaceId,id);
        },
        endAgentWriter(workspaceId,id){if(agentWriters.get(workspaceId)===id)agentWriters.delete(workspaceId);},
        // Exposed to the MCP admission gate to prevent concurrent Host/Worker
        // mutations of the same workspace, including across conversations.
        hasActiveWriter:workspaceId=>agentWriters.has(workspaceId)||[...jobs.values()].some(j=>
            j.workspaceId===workspaceId && j.allowWrites &&
            ["queued","running"].includes(j.status)),
        beginHostMutation(workspaceId){
            if(this.hasActiveWriter(workspaceId))
                throw new Error("WORKER_WORKSPACE_SINGLE_WRITER_BUSY");
            activeHostMutations.set(workspaceId,
                (activeHostMutations.get(workspaceId)||0)+1);
        },
        endHostMutation(workspaceId){
            const count=activeHostMutations.get(workspaceId)||0;
            if(count<=1)activeHostMutations.delete(workspaceId);
            else activeHostMutations.set(workspaceId,count-1);
        },
        delegate({workspaceId,modelId,instruction,allowWrites=false,timeoutSeconds=3600}){
            const workspace=workspaces.getWorkspace(workspaceId);
            if(workspace.backend!=="local"&&(workspace.backend!=="remote-agent"||!openRemoteWorkerTool))
                throw new Error("MODEL_WORKER_WORKSPACE_BACKEND_UNAVAILABLE");
            if(allowWrites && (activeHostMutations.get(workspaceId)||0)>0)
                throw new Error("WORKER_WORKSPACE_SINGLE_WRITER_BUSY");
            if(allowWrites && agentWriters.has(workspaceId))throw Error("WORKER_WORKSPACE_SINGLE_WRITER_BUSY");
            if(allowWrites && [...jobs.values()].some(j=>j.workspaceId===workspaceId &&
                j.allowWrites && ["queued","running"].includes(j.status)))
                throw new Error("WORKER_WORKSPACE_SINGLE_WRITER_BUSY");
            if(typeof instruction!=="string" || !instruction.trim() ||
                instruction.length>MAX_TASK_TEXT)throw new Error("INVALID_MODEL_TASK");
            if(allowWrites!==true && allowWrites!==false)throw new Error("INVALID_WRITE_AUTHORIZATION");
            if(allowWrites && !config.permissions.allowShellMutation
                && !config.permissions.allowArbitraryCommands)throw new Error("WRITE_PERMISSION_DENIED");
            if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<30||timeoutSeconds>86400)
                throw new Error("INVALID_TASK_TIMEOUT");
            const model=getProfile(modelId);
            const taskId="mworker_"+randomUUID();
            const job={taskId,workspaceId,modelId,status:"queued",instruction,
                allowWrites,steps:0,toolCalls:0,inputTokens:0,outputTokens:0,
                estimatedUSD:0,maxTaskUSD:model.maxTaskUSD||1,evidence:[],answer:"",
                error:null,controller:null,cancelled:false,
                startedAt:new Date().toISOString(),deadline:Date.now()+timeoutSeconds*1000};
            if(jobs.size>=MAX_TASKS){
                const done=[...jobs.values()].find(j=>["completed","failed","cancelled"].includes(j.status));
                if(done)jobs.delete(done.taskId);else throw new Error("TOO_MANY_ACTIVE_MODEL_TASKS");
            }
            jobs.set(taskId,job);
            void run(job,workspace,model);
            return snapshot(job);
        },
        status:taskId=>snapshot(find(taskId)),
        result:taskId=>snapshot(find(taskId),true),
        cancel(taskId){
            const job=find(taskId);job.cancelled=true;job.controller?.abort();
            return snapshot(job);
        },
    };
}
