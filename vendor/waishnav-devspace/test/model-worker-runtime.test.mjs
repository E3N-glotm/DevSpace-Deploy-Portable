import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import {createRequire} from "node:module";
// Use the production-packed core so its ESM dependencies resolve the same way
// as in the Windows Portable runtime, not a separate vendor/node_modules tree.
import { createModelWorkerRuntime, safeWorkerPath, publicModelProfiles } from "../../../app/node_modules/@waishnav/devspace/dist/model-worker-runtime.js";
import { createRemoteWorkerToolOpener } from "../../../app/node_modules/@waishnav/devspace/dist/server.js";

const repo = resolve(import.meta.dirname, "..", "..", "..");
const {createModelUsageStore}=createRequire(import.meta.url)(resolve(repo,"setup","model-usage.cjs"));
const {Agent:HttpAgent,fetch:httpFetch,getGlobalDispatcher,setGlobalDispatcher}=createRequire(resolve(repo,"app","package.json"))("undici");
const reports = resolve(repo, "reports");
mkdirSync(reports,{recursive:true});

async function eventually(get,timeoutMs=1600) {
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
        const result=get();
        if(["completed","failed","cancelled"].includes(result.status))return result;
        await new Promise(r=>setTimeout(r,20));
    }
    throw new Error("TASK_NEVER_FINISHED");
}
function prepare({ allowCalls=false, noTool=false, errorStatus=0, repeatToolRounds=0, maxOutputTokens=1024,
    protectedKey=false,deepseek=false,fetchOverride,remoteWorkspace,openRemoteWorkerTool }={}){
    const root=mkdtempSync(resolve(reports,".tmp-native-model-"));
    const project=resolve(root,"project");
    mkdirSync(project);
    writeFileSync(resolve(project,"example.txt"),"hello\nworld\n");
    mkdirSync(resolve(root,"data","config"),{recursive:true});
    const model={
        id:"qwen_worker",name:"Local Qwen",type:deepseek?"deepseek":"ollama",role:"worker",api:"chat",
        baseUrl:deepseek?"https://api.deepseek.com/v1":"http://127.0.0.1:11434/v1",
        model:deepseek?"deepseek-flash":"local-qwen:latest",maxTaskUSD:1,
        maxOutputTokens,inputPerMillionUSD:1,outputPerMillionUSD:1,
        callPolicyRevision:"revision-1",
    };
    if(protectedKey){model.encryptedKey="NATIVE_CIPHERTEXT";
        model.workerEncryptedKey="DPAPI_CIPHERTEXT";}
    writeFileSync(resolve(root,"data","config","model-providers.json"),
        JSON.stringify({version:1,models:[model]}));
    let count=0,writeStarted=0,writeFinished=0;
    const runtime=createModelWorkerRuntime({
        portableRoot:root,
        usageStore:createModelUsageStore(root),
        workspaces:{getWorkspace:id=>{
            assert.equal(id,"ws_test");return remoteWorkspace??{root:project,backend:"local"};
        }},
        openRemoteWorkerTool,
        config:{permissions:{allowShellMutation:true,allowArbitraryCommands:false}},
        credentialVault:{decryptString:value=>{
            assert.equal(value,"DPAPI_CIPHERTEXT");
            return "TEST-ONLY-WORKER-KEY";
        }},
        prepareWrite:async()=>{writeStarted++;},
        finishWrite:async(_id,_ws,_p,ok)=>{writeFinished++;assert.equal(ok,true);},
        fetchImpl:async(_url,opts)=>{
            count++;
            if(fetchOverride)return fetchOverride(_url,opts);
            if(protectedKey)assert.equal(opts.headers.Authorization,"Bearer TEST-ONLY-WORKER-KEY");
            else assert.ok(!opts.headers.Authorization);
            assert.match(_url,/\/chat\/completions$/);
            const sent=JSON.parse(opts.body);
            if(deepseek){assert.deepEqual(sent.thinking,{type:"disabled"});
                assert.equal(sent.model,"deepseek-flash");}
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

test("Agent reconstructs a complete tool call from an SSE stream above the former maximum wire size",async()=>{
    const encoder=new TextEncoder();
    const frameCount=33000;
    const text="鹈鹕".repeat(600);
    const padding="x".repeat(1024);
    const toolArguments=JSON.stringify({path:"pelican.svg",content:text});
    let streamedBytes=0;
    const f=prepare({maxOutputTokens:32768,fetchOverride:(_url,{body})=>{
        assert.equal(JSON.parse(body).max_tokens,32768);
        let i=0;
        const stream=new ReadableStream({pull(controller){
            if(i===frameCount){
                const finalFrame={choices:[{delta:{},finish_reason:"tool_calls"}],usage:{completion_tokens:900}};
                controller.enqueue(encoder.encode("data: "+JSON.stringify(finalFrame)+"\n\ndata: [DONE]\n\n"));
                controller.close();
                return;
            }
            const delta=i<toolArguments.length?{tool_calls:[{
                index:0,...(i===0?{id:"call",function:{name:"write",arguments:toolArguments[i]}}:
                    {function:{arguments:toolArguments[i]}}),
            }]}:{};
            const frame=encoder.encode("data: "+JSON.stringify({provider_metadata:padding,choices:[{delta}]})+"\r\n\r\n");
            streamedBytes+=frame.length;
            controller.enqueue(frame);
            i++;
        }});
        return new Response(stream,{headers:{"content-type":"text/event-stream"}});
    }});
    try{
        const model=f.runtime.agentProfiles()[0];
        const agent={profileId:model.id,inputTokens:0,outputTokens:0,estimatedUSD:0};
        const result=await f.runtime.agentRequest({deadline:Date.now()+30000},agent,model,[],[]);
        assert.ok(streamedBytes>32*1024*1024,streamedBytes);
        assert.deepEqual(result.tool_calls,[{type:"function",id:"call",function:{name:"write",arguments:toolArguments}}]);
        assert.equal(agent.outputTokens,900);
    }finally{f.dispose();}
});

test("legacy Worker forwards the configured output tokens and accepts a large JSON reply",async()=>{
    const answer="Completed a long response.";
    const f=prepare({maxOutputTokens:32768,fetchOverride:(_url,{body})=>{
        assert.equal(JSON.parse(body).max_tokens,32768);
        const payload=JSON.stringify({choices:[{message:{role:"assistant",content:answer,
            reasoning_content:"review ".repeat(90000)}}],usage:{completion_tokens:6000}});
        const length=Buffer.byteLength(payload);
        assert.ok(length>512*1024);
        return new Response(payload,{headers:{"content-type":"application/json","content-length":String(length)}});
    }});
    try{
        const task=f.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",instruction:"Check the output"});
        const result=await eventually(()=>f.runtime.result(task.taskId));
        assert.equal(result.status,"completed",result.error);
        assert.equal(result.answer,answer);
        assert.equal(result.outputTokens,6000);
    }finally{f.dispose();}
});

test("Worker inference and queued Agent inference survive the former deadlines",async(t)=>{
    t.mock.timers.enable({apis:["Date","setTimeout"]});
    const first=Promise.withResolvers(),second=Promise.withResolvers();
    const admissions=[first,second];
    const f=prepare({fetchOverride:(_url,{signal})=>new Promise((resolve,reject)=>{
        signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
        admissions.shift().resolve({signal,resolve});
    })});
    try{
        const model=f.runtime.agentProfiles()[0];
        const worker=f.runtime.delegate({workspaceId:"ws_test",modelId:model.id,instruction:"Wait for Worker inference",timeoutSeconds:30});
        const activeWorker=await first.promise;
        const agent={profileId:model.id,inputTokens:0,outputTokens:0,estimatedUSD:0};
        const queued=f.runtime.agentRequest({deadline:Date.now()+30000},agent,model,[],[]);
        const advanceDays=32*24*60*60*1000;
        t.mock.timers.tick(advanceDays);
        assert.equal(f.runtime.status(worker.taskId).status,"running");
        assert.equal(activeWorker.signal.aborted,false);
        assert.equal(f.counts().count,1,"The Agent remains queued behind the in-flight request");
        const success=answer=>response({choices:[{message:{role:"assistant",content:answer}}]});
        activeWorker.resolve(success("Worker delivered"));
        const activeAgent=await second.promise;
        assert.equal(f.runtime.result(worker.taskId).answer,"Worker delivered");
        t.mock.timers.tick(advanceDays);
        assert.equal(activeAgent.signal.aborted,false);
        activeAgent.resolve(success("Agent delivered"));
        assert.equal((await queued).content,"Agent delivered");
    }finally{f.dispose();}
});

test("Explicit cancellation aborts an in-flight Worker and removes queued Worker and Agent requests",async()=>{
    const first=Promise.withResolvers();
    const f=prepare({fetchOverride:(_url,{signal})=>new Promise((_,reject)=>{
        signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
        first.resolve(signal);
    })});
    try{
        const model=f.runtime.agentProfiles()[0];
        const start=instruction=>f.runtime.delegate({workspaceId:"ws_test",modelId:model.id,instruction});
        const active=start("Occupy the backend"),activeSignal=await first.promise;
        const queued=start("Wait for the backend");
        const agent={profileId:model.id,inputTokens:0,outputTokens:0,estimatedUSD:0};
        const controller=new AbortController();
        const check=assert.rejects(f.runtime.agentRequest({},agent,model,[],[],controller.signal),/AGENT_REQUEST_ABORTED/);
        controller.abort();
        await check;
        f.runtime.cancel(queued.taskId);
        assert.equal((await eventually(()=>f.runtime.status(queued.taskId))).status,"cancelled");
        assert.equal(activeSignal.aborted,false);
        f.runtime.cancel(active.taskId);
        assert.equal((await eventually(()=>f.runtime.status(active.taskId))).status,"cancelled");
        assert.equal(activeSignal.aborted,true);
        assert.equal(f.counts().count,1,"Cancelled queued jobs must never make a request");
    }finally{f.dispose();}
});

test("Model HTTP requests disable header and body timers through the existing dispatcher",async(t)=>{
    const server=createServer((_request,reply)=>{
        setTimeout(()=>{
            reply.writeHead(200,{"Content-Type":"application/json"});
            reply.flushHeaders();
            setTimeout(()=>reply.end(JSON.stringify({choices:[{message:{content:"Delivered after silence"}}]})),40);
        },40);
    });
    await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
    const origin="http://127.0.0.1:"+server.address().port;
    const prior=getGlobalDispatcher();
    const transport=new HttpAgent({headersTimeout:10,bodyTimeout:10});
    const dispatch=transport.dispatch.bind(transport);
    const dispatchSpy=t.mock.method(transport,"dispatch",(options,handler)=>{
        assert.equal(options.headersTimeout,0);
        assert.equal(options.bodyTimeout,0);
        return dispatch(options,handler);
    });
    setGlobalDispatcher(transport);
    const f=prepare({fetchOverride:(_url,options)=>httpFetch(origin,options)});
    try{
        const worker=f.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",instruction:"Read a delayed model response"});
        const result=await eventually(()=>f.runtime.result(worker.taskId));
        assert.equal(result.status,"completed",result.error);
        assert.equal(result.answer,"Delivered after silence");
        assert.equal(dispatchSpy.mock.callCount(),1);
    }finally{
        f.dispose();
        setGlobalDispatcher(prior);
        server.closeAllConnections();
        await new Promise(resolve=>server.close(resolve));
        await transport.destroy();
    }
});

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
test("encrypted DeepSeek Worker credential is used for tool calls but never exposed via MCP",async()=>{
    const f=prepare({protectedKey:true,deepseek:true});
    try{
        const publicModels=publicModelProfiles(f.root);
        assert.equal(publicModels[0].hasKey,true);
        assert.equal(publicModels[0].hasWorkerKey,true);
        assert.equal(publicModels[0].encryptedKey,undefined);
        assert.equal(publicModels[0].workerEncryptedKey,undefined);
        const job=f.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",
            instruction:"Read the project example file",maxSteps:4});
        const finished=await eventually(()=>f.runtime.result(job.taskId));
        assert.equal(finished.status,"completed",JSON.stringify(finished));
        assert.equal(finished.toolCalls,1);
        assert.equal(finished.evidence[0].tool,"read_file");
        assert.ok(!JSON.stringify(finished).includes("TEST-ONLY-WORKER-KEY"));
        assert.deepEqual(f.counts(),{count:2,writeStarted:0,writeFinished:0});
    }finally{f.dispose();}
});
test("legacy Electron-only encrypted Worker key is explicitly unavailable until native migration",async()=>{
    const f=prepare({protectedKey:true});
    try{
        const file=resolve(f.root,"data","config","model-providers.json");
        const config=JSON.parse(readFileSync(file,"utf8"));
        delete config.models[0].workerEncryptedKey;
        writeFileSync(file,JSON.stringify(config));
        assert.throws(()=>f.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",
            instruction:"Read the file",maxSteps:3}),
        /MODEL_API_KEY_NEEDS_SECURE_NATIVE_VAULT_BRIDGE/);
        assert.equal(f.counts().count,0);
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
test("Worker completes past the old step and tool-call limits even with a cached maxSteps value",async()=>{
    const rounds=1005;
    const f=prepare({repeatToolRounds:rounds});
    try{
        const started=f.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",
            instruction:"Repeated safe reads",maxSteps:1});
        const done=await eventually(()=>f.runtime.result(started.taskId),30000);
        assert.equal(done.status,"completed",JSON.stringify(done));
        assert.equal(done.steps,rounds);
        assert.equal(done.toolCalls,rounds);
        assert.ok(done.evidence.length<=25,
            "public evidence must remain bounded for long-running tasks");
        assert.equal(f.counts().count,rounds+1);
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
test("requires explicit write approval and denies unknown Worker profiles",()=>{
    const f=prepare();
    try {
        assert.throws(()=>f.runtime.delegate({workspaceId:"ws_test",
            modelId:"wrong",instruction:"hello"}),/WORKER_PROFILE_NOT_FOUND/);
        assert.throws(()=>f.runtime.delegate({workspaceId:"ws_test",
            modelId:"qwen_worker",instruction:"hello",allowWrites:"yes"}),/INVALID_WRITE_AUTHORIZATION/);
    } finally {f.dispose();}
});
test("remote Worker uses enrolled-agent RPC, scoped paths, and the normal write checkpoint",async()=>{
    const calls=[];
    let saved=Buffer.from("hello\nworld\n");
    const agent={
        async rpcWorkspace(workspace,method,args){
            assert.equal(workspace.backendId,"linux-test");
            calls.push([method,args.path]);
            if(method==="fs.stat"){
                if(args.path==="."||args.path==="src")return {type:"directory"};
                if(args.path==="alias"||args.path==="link.txt")return {type:"symlink"};
                return {type:"file",mode:0o640};
            }
            if(method==="fs.list")return {entries:[{name:"example.txt",type:"file",size:12},{name:".env",type:"file",size:6}]};
            if(method==="search.grep")return {matches:[
                {path:"example.txt",line:2,text:"world"},
                {path:".env",line:1,text:"do not expose secret"},
                {path:"link.txt",line:1,text:"do not expose alias"},
            ]};
            throw Error(method);
        },
        async read(_w,path,{limit}){assert.equal(path,"example.txt");assert.equal(limit,180);return {kind:"text",text:saved.toString()};},
        async readWhole(){return saved;},
        async writeBuffer(_w,path,bytes,opts){
            assert.equal(path,"example.txt");assert.equal(opts.mode,0o640);saved=bytes;
        },
    };
    const open=createRemoteWorkerToolOpener(agent);
    const workspace={id:"ws_test",root:"/home/ubuntu/project",backend:"remote-agent",backendId:"linux-test"};
    assert.equal(safeWorkerPath(workspace.root,"src\\main.py",true).rel,"src/main.py");
    assert.throws(()=>safeWorkerPath(workspace.root,"../outside",true),/WORKER_PATH_OUTSIDE_WORKSPACE/);
    await assert.rejects(open(workspace,"read_file",{path:"alias/hidden.txt"}),/WORKER_SYMLINK_PATH_DENIED/);
    const ls=await (await open(workspace,"list_directory",{path:"."}))();
    assert.match(ls.content[0].text,/example\.txt/);
    assert.doesNotMatch(ls.content[0].text,/\.env/);
    const grep=await (await open(workspace,"grep_files",{path:".",pattern:"world"}))();
    assert.match(grep.content[0].text,/example\.txt:2:world/);
    assert.doesNotMatch(grep.content[0].text,/secret|alias/);
    const read=prepare({remoteWorkspace:workspace,openRemoteWorkerTool:open});
    const write=prepare({allowCalls:true,remoteWorkspace:workspace,openRemoteWorkerTool:open});
    try{
        const a=read.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",instruction:"Read the remote example."});
        assert.equal((await eventually(()=>read.runtime.result(a.taskId))).evidence[0].tool,"read_file");
        const b=write.runtime.delegate({workspaceId:"ws_test",modelId:"qwen_worker",instruction:"Edit the remote example.",allowWrites:true});
        const done=await eventually(()=>write.runtime.result(b.taskId));
        assert.equal(done.status,"completed",done.error);
        assert.equal(done.evidence[0].path,"example.txt");
        assert.equal(saved.toString(),"hello\nagent\n");
        assert.deepEqual(write.counts(),{count:2,writeStarted:1,writeFinished:1});
    }finally{read.dispose();write.dispose();}
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
