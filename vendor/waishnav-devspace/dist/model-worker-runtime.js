import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
const MAX_TOOL_CALLS = 24;
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

export function safeWorkerPath(root, raw) {
    if (typeof raw !== "string" || !raw || raw.length > 500 || raw.includes("\0"))
        throw new Error("INVALID_WORKER_PATH");
    if (isAbsolute(raw) || /^[a-z]:/i.test(raw) || /^\\\\/.test(raw))
        throw new Error("WORKER_ABSOLUTE_PATH_DENIED");
    const full = resolve(root, raw);
    const rel = relative(root, full);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
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
    return config.models.map(({ encryptedKey, ...entry }) => ({
        ...entry, allowCalls:entry.allowCalls!==false,
        hasKey: Boolean(encryptedKey),
    }));
}

export function createModelWorkerRuntime({
    portableRoot, config, workspaces, reviewCheckpoints, hookManager,
    fetchImpl = globalThis.fetch, readProfiles = publicModelProfiles,
    prepareWrite = async () => {}, finishWrite = async () => {},
    usageStore,
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
    const jobs = new Map();
    const restricted = (text, n = MAX_TOOL_REPLY) => String(text || "").slice(0, n);
    function snapshot(job, includeAnswer = false) {
        return {
            taskId: job.taskId, workspaceId: job.workspaceId,
            modelId: job.modelId, status: job.status,
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
    function getProfile(id) {
        const models = readProfiles(portableRoot);
        const model = models.find(p => p.id === id);
        if (!model || model.role !== "worker") throw new Error("WORKER_PROFILE_NOT_FOUND");
        if (model.allowCalls === false) throw new Error("WORKER_PROFILE_DISABLED");
        if (model.hasKey) throw new Error("MODEL_API_KEY_NEEDS_SECURE_NATIVE_VAULT_BRIDGE");
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
        const location = safeWorkerPath(workspace.root, pathname);
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
        let result;
        if (name === "read_file") result = await readFileTool({
            path: location.rel,limit:180,
        }, context);
        if (name === "list_directory") result = await listDirectoryTool({path:location.rel},context);
        if (name === "grep_files") {
            if (typeof args.pattern !== "string" || args.pattern.length > 160)
                throw new Error("INVALID_GREP_PATTERN");
            result = await grepFilesTool({path:location.rel,pattern:args.pattern},context);
        }
        if (name === "edit_file") {
            if (!config.permissions.allowShellMutation && !config.permissions.allowArbitraryCommands)
                throw new Error("WRITE_PERMISSION_DENIED");
            if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > 12
                || args.edits.some(e=>typeof e.oldText !== "string" || !e.oldText
                    || typeof e.newText !== "string" || e.newText.length>10000))
                throw new Error("INVALID_EDIT_ARGUMENTS");
            await prepareWrite(job.workspaceId,workspace,location.rel);
            try{
                result = await editFileTool({path:location.rel,edits:args.edits},context);
            }catch(error){
                await finishWrite(job.workspaceId,workspace,location.rel,false);
                throw error;
            }
            await finishWrite(job.workspaceId,workspace,location.rel,!result?.isError);
        }
        job.evidence.push({tool:name,path:location.rel,ok:!result?.isError});
        return restricted((result?.content||[]).map(c=>c.text||"").join("\n"));
    }
    async function infer(job, model, messages, tools) {
        getProfile(job.modelId);
        const remaining = job.maxTaskUSD - job.estimatedUSD;
        // Refuse a new paid request if remaining budget cannot cover even
        // the configured maximum output tokens. True billing varies by provider.
        const outputReserve=(model.maxOutputTokens||4096)*(model.outputPerMillionUSD||0)/1e6;
        if (remaining < outputReserve) throw new Error("MODEL_TASK_BUDGET_EXHAUSTED");
        const maxTokens=Math.min(2048,Math.max(16,model.maxOutputTokens||2048));
        const controller=new AbortController();job.controller=controller;
        // Disabling a profile is a hard stop even for a request which is
        // already waiting on the model HTTP endpoint.
        const disabledCheck=setInterval(()=>{
            try{getProfile(job.modelId);}
            catch{controller.abort();}
        },500);
        disabledCheck.unref?.();
        const startedAt=new Date().toISOString();
        const startedNs=process.hrtime.bigint();
        let succeeded=false;
        let actualUsage=null;
        const timeout=setTimeout(()=>controller.abort(),Math.max(1,Math.min(180000,job.deadline-Date.now())));
        try {
            const url=model.baseUrl.replace(/\/$/,"")+"/chat/completions";
            const response=await fetchImpl(url,{
                method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},
                redirect:"error",signal:controller.signal,
                body:JSON.stringify({model:model.model,messages,tools,tool_choice:"auto",stream:false,
                    max_tokens:maxTokens,temperature:0}),
            });
            if(!response.ok)throw new Error("MODEL_HTTP_"+response.status);
            const length=Number(response.headers?.get?.("content-length")||0);
            if (length>MAX_MODEL_RESPONSE)throw new Error("MODEL_REPLY_TOO_LARGE");
            const raw=await response.text();
            if (Buffer.byteLength(raw,"utf8")>MAX_MODEL_RESPONSE)throw new Error("MODEL_REPLY_TOO_LARGE");
            let json;
            try {json=JSON.parse(raw);}catch {throw new Error("MODEL_INVALID_JSON");}
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
            return reply;
        } finally {
            clearInterval(disabledCheck);
            clearTimeout(timeout);job.controller=null;
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
                    "You are a bounded DevSpace Worker, not the ChatGPT supervisor. "+
                    "Only use the available workspace tools; never invent test outcomes. "+
                    "No shell, network, privilege changes or secret access. "+
                    "Read the relevant files first and return a concise verifiable report. "+
                    (job.allowWrites?"You may edit workspace files only when necessary.":
                        "You MUST NOT edit any files.")},
                {role:"user",content:job.instruction},
            ];
            const allowedTools=TOOL_DEFINITIONS.filter(t=>job.allowWrites||
                t.function.name!=="edit_file");
            for(let index=0;index<job.maxSteps;index++){
                getProfile(job.modelId);
                if(job.cancelled)throw new Error("MODEL_TASK_CANCELLED");
                if(Date.now()>job.deadline)throw new Error("MODEL_TASK_TIMEOUT");
                const result=await infer(job,model,messages,allowedTools);
                getProfile(job.modelId);
                if(!result)throw new Error("MODEL_NO_MESSAGE");
                const calls=Array.isArray(result.tool_calls)?result.tool_calls:[];
                if(!calls.length){
                    job.answer=restricted(result.content,12000);
                    job.status="completed";return;
                }
                if(job.toolCalls+calls.length>MAX_TOOL_CALLS)
                    throw new Error("MODEL_TOOL_CALL_LIMIT_REACHED");
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
            }
            throw new Error("MODEL_TASK_STEP_LIMIT_REACHED");
        }catch(error){
            job.status=job.cancelled?"cancelled":"failed";
            job.error=String(error?.message||"MODEL_RUNTIME_FAILURE").slice(0,300);
        }finally{job.finishedAt=new Date().toISOString();job.controller=null;
            job.instruction=""; /* never retain task prompt after completion */}
    }
    return {
        models:()=>readProfiles(portableRoot).filter(m=>m.role==="worker"&&m.allowCalls!==false),
        delegate({workspaceId,modelId,instruction,allowWrites=false,maxSteps=8,timeoutSeconds=600}){
            const workspace=workspaces.getWorkspace(workspaceId);
            if(workspace.backend!=="local")throw new Error("MODEL_WORKER_LOCAL_WORKSPACE_ONLY");
            if(allowWrites && [...jobs.values()].some(j=>j.workspaceId===workspaceId &&
                j.allowWrites && ["queued","running"].includes(j.status)))
                throw new Error("WORKER_WORKSPACE_SINGLE_WRITER_BUSY");
            if(typeof instruction!=="string" || !instruction.trim() ||
                instruction.length>MAX_TASK_TEXT)throw new Error("INVALID_MODEL_TASK");
            if(allowWrites!==true && allowWrites!==false)throw new Error("INVALID_WRITE_AUTHORIZATION");
            if(allowWrites && !config.permissions.allowShellMutation
                && !config.permissions.allowArbitraryCommands)throw new Error("WRITE_PERMISSION_DENIED");
            if(!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>20)throw new Error("INVALID_TASK_STEPS");
            if(!Number.isInteger(timeoutSeconds)||timeoutSeconds<30||timeoutSeconds>3600)
                throw new Error("INVALID_TASK_TIMEOUT");
            const model=getProfile(modelId);
            const taskId="mworker_"+randomUUID();
            const job={taskId,workspaceId,modelId,status:"queued",instruction,
                allowWrites,steps:0,maxSteps,toolCalls:0,inputTokens:0,outputTokens:0,
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
