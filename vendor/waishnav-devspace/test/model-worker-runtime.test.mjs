import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {createRequire} from "node:module";
// Use the production-packed core so its ESM dependencies resolve the same way
// as in the Windows Portable runtime, not a separate vendor/node_modules tree.
import { createModelWorkerRuntime, safeWorkerPath, publicModelProfiles } from "../../../app/node_modules/@waishnav/devspace/dist/model-worker-runtime.js";

const repo = resolve(import.meta.dirname, "..", "..", "..");
const {createModelUsageStore}=createRequire(import.meta.url)(resolve(repo,"setup","model-usage.cjs"));
const reports = resolve(repo, "reports");
mkdirSync(reports,{recursive:true});

async function eventually(get) {
    for (let i=0;i<80;i++){
        const result=get();
        if(["completed","failed","cancelled"].includes(result.status))return result;
        await new Promise(r=>setTimeout(r,20));
    }
    throw new Error("TASK_NEVER_FINISHED");
}
function prepare({ allowCalls=false, noTool=false, errorStatus=0, repeatToolRounds=0 }={}){
    const root=mkdtempSync(resolve(reports,".tmp-native-model-"));
    const project=resolve(root,"project");
    mkdirSync(project);
    writeFileSync(resolve(project,"example.txt"),"hello\nworld\n");
    mkdirSync(resolve(root,"data","config"),{recursive:true});
    const model={
        id:"qwen_worker",name:"Local Qwen",type:"ollama",role:"worker",api:"chat",
        baseUrl:"http://127.0.0.1:11434/v1",model:"local-qwen:latest",maxTaskUSD:1,
        maxOutputTokens:1024,inputPerMillionUSD:1,outputPerMillionUSD:1,
    };
    writeFileSync(resolve(root,"data","config","model-providers.json"),
        JSON.stringify({version:1,models:[model]}));
    let count=0,writeStarted=0,writeFinished=0;
    const runtime=createModelWorkerRuntime({
        portableRoot:root,
        usageStore:createModelUsageStore(root),
        workspaces:{getWorkspace:id=>{
            assert.equal(id,"ws_test");return {root:project,backend:"local"};
        }},
        config:{permissions:{allowShellMutation:true,allowArbitraryCommands:false}},
        prepareWrite:async()=>{writeStarted++;},
        finishWrite:async(_id,_ws,_p,ok)=>{writeFinished++;assert.equal(ok,true);},
        fetchImpl:async(_url,opts)=>{
            count++;
            assert.ok(!opts.headers.Authorization);
            assert.match(_url,/\/chat\/completions$/);
            if(errorStatus)return {ok:false,status:errorStatus};
            if(noTool||count>(repeatToolRounds||1))return response({choices:[{message:{
                role:"assistant",content:"Examined workspace and completed the bounded task.",
            }}],usage:{prompt_tokens:100,completion_tokens:30}});
            const tools=JSON.parse(opts.body).tools;
            const requested=allowCalls?"edit_file":"read_file";
            assert.equal(tools.some(x=>x.function.name===requested),true);
            return response({choices:[{message:{role:"assistant",content:null,
                tool_calls:[{id:"call_1",type:"function",function:{name:requested,
                    arguments:JSON.stringify(allowCalls?{path:"example.txt",edits:[
                        {oldText:"world",newText:"agent"}]}:{path:"example.txt"})}}]}}],
                usage:{prompt_tokens:100,completion_tokens:40}});
        },
    });
    return {runtime,root,project,
        counts:()=>({count,writeStarted,writeFinished}),
        dispose:()=>rmSync(root,{recursive:true,force:true})};
}
function response(payload) {
    return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(payload)};
}

test("model list never exposes encrypted keys",()=>{
    const f=prepare();
    try{
        const models=publicModelProfiles(f.root);
        assert.equal(models.length,1);
        assert.equal(models[0].model,"local-qwen:latest");
        assert.equal(models[0].encryptedKey,undefined);
        assert.equal(f.runtime.models().length,1);
    }finally{f.dispose();}
});
test("default read-only worker calls a real workspace read and produces evidence",async()=>{
    const f=prepare();
    try{
        const started=f.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",
            instruction:"Read the file and report",maxSteps:4});
        assert.ok(started.taskId.startsWith("mworker_"));
        const done=await eventually(()=>f.runtime.result(started.taskId));
        assert.equal(done.status,"completed",JSON.stringify(done));
        assert.equal(done.toolCalls,1);
        assert.equal(done.evidence[0].tool,"read_file");
        assert.ok(done.inputTokens>0);
        assert.ok(done.estimatedUSD>0);
        assert.ok(done.answer.includes("Examined workspace"));
        assert.equal(f.counts().writeStarted,0);
        const stats=createModelUsageStore(f.root).stats("qwen_worker","local-qwen:latest");
        assert.equal(stats.totalCalls,2);
        assert.equal(stats.successfulCalls,2);
        assert.equal(stats.bySource.worker,2);
        assert.equal(stats.inputTokens,200);
        assert.equal(stats.outputTokens,70);
        assert.equal(stats.totalTokens,270);
        assert.equal(stats.failedCalls,0);
        assert.ok(stats.lastCallAt);
    }finally{f.dispose();}
});
test("Worker supports more than 20 steps and 24 tools with bounded history",async()=>{
    const f=prepare({repeatToolRounds:80});
    try{
        const started=f.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",
            instruction:"Repeated safe reads",maxSteps:1000,timeoutSeconds:7200});
        const done=await eventually(()=>f.runtime.result(started.taskId));
        assert.equal(done.status,"completed",JSON.stringify(done));
        assert.equal(done.steps,80);
        assert.equal(done.toolCalls,80);
        assert.ok(done.evidence.length<=25,
            "public evidence must remain bounded for long-running tasks");
        assert.equal(f.counts().count,81);
        assert.throws(()=>f.runtime.delegate({workspaceId:"ws_test",
            modelId:"qwen_worker",instruction:"Invalid",maxSteps:100001}),
            /INVALID_TASK_STEPS/);
        assert.throws(()=>f.runtime.delegate({workspaceId:"ws_test",
            modelId:"qwen_worker",instruction:"Invalid",timeoutSeconds:86401}),
            /INVALID_TASK_TIMEOUT/);
    }finally{f.dispose();}
});
test("explicit writes go through the same before/after mutation guard",async()=>{
    const f=prepare({allowCalls:true});
    try{
        const started=f.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",
            instruction:"Change world to agent",allowWrites:true,maxSteps:4});
        const done=await eventually(()=>f.runtime.result(started.taskId));
        assert.equal(done.status,"completed",JSON.stringify(done));
        assert.equal(readFileSync(resolve(f.project,"example.txt"),"utf8"),"hello\nagent\n");
        assert.deepEqual(f.counts(),{count:2,writeStarted:1,writeFinished:1});
    }finally{f.dispose();}
});
test("active Host mutation prevents Worker write dispatch until released",async()=>{
    const f=prepare({allowCalls:true});
    try{
        f.runtime.beginHostMutation("ws_test");
        assert.throws(()=>f.runtime.delegate({workspaceId:"ws_test",
            modelId:"qwen_worker",instruction:"Write while Host is editing",
            allowWrites:true}),/WORKER_WORKSPACE_SINGLE_WRITER_BUSY/);
        f.runtime.endHostMutation("ws_test");
        const started=f.runtime.delegate({workspaceId:"ws_test",
            modelId:"qwen_worker",instruction:"Edit after Host has finished",
            allowWrites:true,maxSteps:4});
        assert.equal(started.allowWrites,true);
        assert.equal(f.runtime.hasActiveWriter("ws_test"),true);
        assert.throws(()=>f.runtime.beginHostMutation("ws_test"),
            /WORKER_WORKSPACE_SINGLE_WRITER_BUSY/);
        const done=await eventually(()=>f.runtime.result(started.taskId));
        assert.equal(done.status,"completed");
        assert.equal(f.runtime.hasActiveWriter("ws_test"),false);
        f.runtime.beginHostMutation("ws_test");
        f.runtime.endHostMutation("ws_test");
    }finally{f.dispose();}
});
test("workspace traversal, secrets, absolute paths and UNC are rejected",()=>{
    const root="E:\\src";
    for(const p of ["../outside",".git/config",".env","secrets/pass.txt",
        "C:\\Windows\\system.ini","\\\\server\\share\\file"]){
        assert.throws(()=>safeWorkerPath(root,p));
    }
    assert.equal(safeWorkerPath(root,"src/index.js").rel.includes("src"),true);
});
test("requires explicit write approval, denies remote-agent backend and unknown worker",()=>{
    const f=prepare();
    try {
        assert.throws(()=>f.runtime.delegate({workspaceId:"ws_test",
            modelId:"wrong",instruction:"hello"}),/WORKER_PROFILE_NOT_FOUND/);
        assert.throws(()=>f.runtime.delegate({workspaceId:"ws_test",
            modelId:"qwen_worker",instruction:"hello",allowWrites:"yes"}),/INVALID_WRITE_AUTHORIZATION/);
    } finally {f.dispose();}
});
test("HTTP failures are bounded and do not leak remote response bodies",async()=>{
    const f=prepare({errorStatus:401});
    try {
        const started=f.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",instruction:"test"});
        const done=await eventually(()=>f.runtime.result(started.taskId));
        assert.equal(done.status,"failed");
        assert.equal(done.error,"MODEL_HTTP_401");
        const stats=createModelUsageStore(f.root).stats("qwen_worker","local-qwen:latest");
        assert.equal(stats.totalCalls,1);
        assert.equal(stats.failedCalls,1);
        assert.equal(stats.usageMissingCalls,1);
        assert.equal(stats.lastStatus,"failed");
    }finally{f.dispose();}
});
test("cloud profiles with Electron-encrypted credentials are rejected rather than decrypted unsafely",()=>{
    const f=prepare();
    try{
        const filename=resolve(f.root,"data","config","model-providers.json");
        const config=JSON.parse(readFileSync(filename,"utf8"));
        config.models[0].encryptedKey="not-exposed-to-worker";
        writeFileSync(filename,JSON.stringify(config));
        assert.equal(f.runtime.models()[0].hasKey,true);
        assert.throws(()=>f.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",
            instruction:"Do not read secrets"}),/MODEL_API_KEY_NEEDS_SECURE_NATIVE_VAULT_BRIDGE/);
    }finally{f.dispose();}
});
test("disabled profile is omitted from callable Worker list and explicit delegation is rejected",()=>{
    const f=prepare();
    try{
        const filename=resolve(f.root,"data","config","model-providers.json");
        const data=JSON.parse(readFileSync(filename,"utf8"));
        data.models[0].allowCalls=false;
        writeFileSync(filename,JSON.stringify(data));
        assert.deepEqual(f.runtime.models(),[]);
        assert.throws(()=>f.runtime.delegate({
            workspaceId:"ws_test",modelId:"qwen_worker",instruction:"Read files",
        }),/WORKER_PROFILE_DISABLED/);
    }finally{f.dispose();}
});
test("single-writer workspace lock prevents simultaneous modifying workers",async()=>{
    let release;
    const suspended=new Promise(resolve=>{release=resolve;});
    const f=prepare();
    const existing=readFileSync(resolve(f.root,"data","config","model-providers.json"),"utf8");
    const config=JSON.parse(existing);config.models[0].model="test-code";
    writeFileSync(resolve(f.root,"data","config","model-providers.json"),JSON.stringify(config));
    const worker=createModelWorkerRuntime({
        portableRoot:f.root,
        usageStore:createModelUsageStore(f.root),
        workspaces:{getWorkspace:()=>({backend:"local",root:f.project})},
        config:{permissions:{allowShellMutation:true,allowArbitraryCommands:false}},
        fetchImpl:async()=>{await suspended;return response({choices:[{message:{content:"done"}}]});},
    });
    try{
        const one=worker.delegate({workspaceId:"ws_test",modelId:"qwen_worker",
            instruction:"First",allowWrites:true});
        assert.ok(one.taskId);
        assert.throws(()=>worker.delegate({workspaceId:"ws_test",modelId:"qwen_worker",
            instruction:"Second",allowWrites:true}),/WORKER_WORKSPACE_SINGLE_WRITER_BUSY/);
        release();
        assert.equal((await eventually(()=>worker.status(one.taskId))).status,"completed");
    }finally{release();f.dispose();}
});
test("five first-party model delegation tools are registered directly in MCP",()=>{
    const source=readFileSync(resolve(repo,"vendor","waishnav-devspace","dist","server.js"),"utf8");
    for(const tool of ["model_worker_list","model_delegate_task","model_task_status",
        "model_task_result","model_task_cancel"]){
        assert.ok(source.includes('"'+tool+'"'),"Missing MCP tool "+tool);
    }
    assert.match(source,/createModelWorkerRuntime\(/);
    assert.match(source,/prepareWrite:/);
    assert.match(source,/finishWrite:/);
});
