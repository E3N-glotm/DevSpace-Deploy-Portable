import assert from "node:assert/strict";
import {createServer as createHttpServer} from "node:http";
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {createServer} from "../app/node_modules/@waishnav/devspace/dist/server.js";
import {loadConfig} from "../app/node_modules/@waishnav/devspace/dist/config.js";
import {SingleUserOAuthProvider} from "../app/node_modules/@waishnav/devspace/dist/oauth-provider.js";
import {Client} from "../app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import {StreamableHTTPClientTransport} from "../app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";

// Real HTTP + OAuth + MCP regression, in an isolated E-drive temp directory.
// No real Qwen endpoint or installed Portable configuration is touched.
const projectRoot=resolve(fileURLToPath(new URL("..",import.meta.url)));
const cache=join(projectRoot,".test-cache");
mkdirSync(cache,{recursive:true});
const root=mkdtempSync(join(cache,"mandatory-worker-wire-"));
const previousRoot=process.env.DEVSPACE_PORTABLE_ROOT;
let mcp,modelServer,modelListener,transport,client,transport2,client2,provider;
function setPolicy(enabled,revision="policy-one"){
    writeFileSync(join(root,"data","config","model-workflow.json"),
        JSON.stringify({formatVersion:1,enabled,updatedAt:revision}));
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const contentText=result=>(result?.content||[]).filter(x=>x.type==="text").map(x=>x.text).join("\n");
try{
    const configDir=join(root,"data","config");
    const stateDir=join(root,"data","state");
    const workspace=join(root,"test-project");
    mkdirSync(configDir,{recursive:true});
    mkdirSync(workspace,{recursive:true});
    writeFileSync(join(workspace,"safe.txt"),"source code content\n");
    modelServer=createHttpServer(async(req,res)=>{
        let body="";
        for await(const chunk of req)body+=chunk.toString();
        if(req.url==="/v1/chat/completions"){
            assert.equal(JSON.parse(body).model,"fake-enabled-worker");
            if(JSON.parse(body).messages.some(m=>m.role==="user" &&
                m.content==="Hold a write-capable Worker lease"))
                await sleep(400);
            res.writeHead(200,{"Content-Type":"application/json"});
            res.end(JSON.stringify({choices:[{message:{role:"assistant",content:
                "Read-only Worker has examined the task and approved review."}}],
                usage:{prompt_tokens:20,completion_tokens:12}}));
        }else{res.writeHead(404);res.end();}
    });
    await new Promise((resolve,reject)=>{
        modelServer.listen(0,"127.0.0.1",resolve);
        modelServer.once("error",reject);
    });
    const modelPort=modelServer.address().port;
    const profiles={version:1,models:[{
        id:"worker-one",name:"Fake read-only Qwen",type:"ollama",
        role:"worker",api:"chat",model:"fake-enabled-worker",
        baseUrl:`http://127.0.0.1:${modelPort}/v1`,
        contextLength:16384,maxOutputTokens:1000,maxTaskUSD:1,
        inputPerMillionUSD:0,outputPerMillionUSD:0,
        allowCalls:true,callPolicyRevision:"p-one",
    }]};
    const profilesFile=join(configDir,"model-providers.json");
    writeFileSync(profilesFile,JSON.stringify(profiles));
    setPolicy(true);
    writeFileSync(join(configDir,"config.json"),JSON.stringify({
        host:"127.0.0.1",port:17689,publicBaseUrl:"http://127.0.0.1:17689",
        allowedRoots:[workspace],stateDir,subagents:false,
        features:{continuationGuard:false},
    }));
    writeFileSync(join(configDir,"auth.json"),JSON.stringify({
        ownerToken:"isolated-model-workflow-test-owner-token",
    }));
    process.env.DEVSPACE_PORTABLE_ROOT=root;
    process.env.DEVSPACE_PLUGIN_ROOT=join(root,"plugins");
    const config=loadConfig({...process.env,
        DEVSPACE_CONFIG_DIR:configDir,DEVSPACE_STATE_DIR:stateDir,
        DEVSPACE_TOOL_MODE:process.env.DEVSPACE_TEST_WORKFLOW_TOOL_MODE==="full"
            ?"full":"codex",DEVSPACE_WIDGETS:"changes",
        DEVSPACE_SUBAGENTS:"0",DEVSPACE_LOG_REQUESTS:"0",
        DEVSPACE_LOG_TOOL_CALLS:"0",
        DEVSPACE_PERMISSION_PROFILE:"custom",
        DEVSPACE_ALLOW_ARBITRARY_COMMANDS:"1",
        DEVSPACE_ALLOW_SHELL_MUTATION:"1",
    });
    mcp=createServer(config);
    modelListener=mcp.app.listen(0,"127.0.0.1");
    await new Promise((resolve,reject)=>{
        modelListener.once("listening",resolve);
        modelListener.once("error",reject);
    });
    provider=new SingleUserOAuthProvider(config.oauth,new URL("/mcp",config.publicBaseUrl),stateDir);
    const registered=provider.oauthStore.registerClient({
        client_name:"forced-model-gate-wire-test",
        redirect_uris:["http://127.0.0.1/callback"],
    },["127.0.0.1"]);
    const token=provider.issueTokens(registered.client_id,config.oauth.scopes,
        new URL("/mcp",config.publicBaseUrl));
    transport=new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${modelListener.address().port}/mcp`),{
        requestInit:{headers:{Authorization:`Bearer ${token.access_token}`}},
    });
    client=new Client({name:"mandatory-workflow-test",version:"1"});
    await client.connect(transport);
    const {tools}=await client.listTools();
    for(const required of ["open_workspace","model_worker_list",
        "model_delegate_task","model_task_result"]){
        assert.ok(tools.some(x=>x.name===required),required);
    }
    const readTool=tools.find(x=>["read","read_file"].includes(x.name));
    assert.ok(readTool,"Missing read tool");
    const hostCommandTool=tools.find(x=>["exec_command","bash"].includes(x.name));
    assert.ok(hostCommandTool,
        "Missing command tool in the selected DevSpace tool mode");
    const opened=await client.callTool({
        name:"open_workspace",arguments:{path:workspace,mode:"checkout"},
    });
    const workspaceId=opened.structuredContent?.workspaceId
        ||opened.structuredContent?.workspace?.workspaceId;
    assert.ok(workspaceId,"open_workspace should return workspaceId");
    const argumentsRead={workspaceId,path:"safe.txt"};
    const hostCommandArguments=hostCommandTool.name==="bash"
        ?{workspaceId,command:"node --version"}
        :{workspaceId,argv:["node","--version"],yieldTimeMs:1000};
    const callHostCommand=()=>client.callTool({
        name:hostCommandTool.name,arguments:hostCommandArguments,
    });
    const blocked=await client.callTool({name:readTool.name,arguments:argumentsRead});
    assert.equal(blocked.isError,true,"MCP read bypassed mandatory Worker gate");
    assert.match(contentText(blocked),/MODEL_WORKFLOW_DELEGATION_REQUIRED/);
    const list=await client.callTool({name:"model_worker_list",arguments:{}});
    assert.equal(list.structuredContent?.data?.mandatoryModelWorkflow,true);
    const delegated=await client.callTool({name:"model_delegate_task",arguments:{
        workspaceId,modelId:"worker-one",instruction:"Review project only",
        allowWrites:false,maxSteps:1000,timeoutSeconds:7200,
    }});
    const taskId=delegated.structuredContent?.data?.taskId;
    assert.ok(taskId);
    assert.equal(delegated.structuredContent?.data?.allowWrites,false);
    const readDuringDelegation=await client.callTool({
        name:readTool.name,arguments:argumentsRead});
    assert.notEqual(readDuringDelegation.isError,true,
        "Dispatch must unlock Host reads without waiting for Worker completion");
    let result;
    for(let attempt=0;attempt<80;attempt++){
        result=await client.callTool({name:"model_task_status",arguments:{taskId}});
        if(result.structuredContent?.data?.status==="completed")break;
        await sleep(25);
    }
    assert.equal(result.structuredContent?.data?.status,"completed",contentText(result));
    const verified=await client.callTool({name:"model_task_result",arguments:{taskId}});
    assert.equal(verified.structuredContent?.data?.status,"completed");
    const passed=await client.callTool({name:readTool.name,arguments:argumentsRead});
    assert.notEqual(passed.isError,true,contentText(passed));
    const writeTask=await client.callTool({name:"model_delegate_task",arguments:{
        workspaceId,modelId:"worker-one",
        instruction:"Hold a write-capable Worker lease",
        allowWrites:true,maxSteps:2,timeoutSeconds:90,
    }});
    const writerId=writeTask.structuredContent?.data?.taskId;
    assert.ok(writerId,"Missing write-capable Worker task: "+contentText(writeTask));
    assert.equal(writeTask.structuredContent?.data?.allowWrites,true);
    assert.notEqual((await client.callTool({
        name:readTool.name,arguments:argumentsRead})).isError,true,
        "Host must be able to inspect project during a write-capable Worker");
    const concurrentWrite=await callHostCommand();
    assert.equal(concurrentWrite.isError,true,
        "A running write-capable Worker must block Host mutation-capable calls");
    assert.match(contentText(concurrentWrite),/MODEL_WORKFLOW_WORKSPACE_WRITER_BUSY/);
    let writerResult;
    for(let attempt=0;attempt<80;attempt++){
        writerResult=await client.callTool({name:"model_task_status",arguments:{taskId:writerId}});
        if(writerResult.structuredContent?.data?.status==="completed")break;
        await sleep(25);
    }
    assert.equal(writerResult.structuredContent?.data?.status,"completed");
    const needsReview=await callHostCommand();
    assert.equal(needsReview.isError,true,
        "Write-capable Worker outcome must be inspected before Host mutation");
    const reviewedWriter=await client.callTool({
        name:"model_task_result",arguments:{taskId:writerId}});
    assert.equal(reviewedWriter.structuredContent?.data?.status,"completed");
    const unblockedWrite=await callHostCommand();
    assert.notEqual(unblockedWrite.isError,true,contentText(unblockedWrite));
    profiles.models[0].allowCalls=false;
    profiles.models[0].callPolicyRevision="p-two";
    writeFileSync(profilesFile,JSON.stringify(profiles));
    const denied=await client.callTool({name:readTool.name,arguments:argumentsRead});
    assert.equal(denied.isError,true,"Disabling Worker must revoke prior authorization");
    assert.match(contentText(denied),/MODEL_WORKFLOW_NO_ENABLED_WORKER|MODEL_WORKFLOW_WORKER_DISABLED/);
    const workers=await client.callTool({name:"model_worker_list",arguments:{}});
    assert.equal(workers.structuredContent?.data?.models?.length,0);
    setPolicy(false,"policy-two");
    const optional=await client.callTool({name:readTool.name,arguments:argumentsRead});
    assert.notEqual(optional.isError,true,"optional mode must restore upstream tool selection");
    assert.equal((await client.callTool({name:"model_worker_list",arguments:{}}))
        .structuredContent?.data?.mandatoryModelWorkflow,false,
        "Same MCP session must observe disabled policy without reconnecting");
    setPolicy(true,"policy-three");
    assert.equal((await client.callTool({name:"model_worker_list",arguments:{}}))
        .structuredContent?.data?.mandatoryModelWorkflow,true,
        "Same MCP session must observe policy re-enable without reconnecting");
    const localAfterReenable=await client.callTool({
        name:readTool.name,arguments:argumentsRead});
    assert.equal(localAfterReenable.isError,true,
        "A new policy revision must invalidate the previous local-workspace delegation");
    setPolicy(false,"policy-four");
    assert.notEqual((await client.callTool({
        name:readTool.name,arguments:argumentsRead})).isError,true,
        "Final disabled policy must unblock existing MCP session again");
    // A new transport gets its own MCP session, but both calls below belong to
    // the same logical ChatGPT conversation. This previously failed because
    // the tool handler and HTTP boundary used independent scope identities.
    profiles.models[0].allowCalls=true;
    profiles.models[0].callPolicyRevision="p-three";
    writeFileSync(profilesFile,JSON.stringify(profiles));
    setPolicy(true,"policy-five");
    const scoped=(peer,name,args,scope)=>peer.callTool({
        name,arguments:args,_meta:{"openai/session":scope},
    });
    const scopedDelegated=await scoped(client,"model_delegate_task",{
        workspaceId,modelId:"worker-one",instruction:"Review project only",
        allowWrites:false,maxSteps:1000,timeoutSeconds:7200,
    },"chat-reconnected");
    assert.ok(scopedDelegated.structuredContent?.data?.taskId,
        "Scoped delegate must return a Worker task");
    const scopedRead=await scoped(client,readTool.name,argumentsRead,"chat-reconnected");
    assert.notEqual(scopedRead.isError,true,
        "HTTP scope and Worker handler scope must match in one MCP transport");
    transport2=new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${modelListener.address().port}/mcp`),{
        requestInit:{headers:{Authorization:`Bearer ${token.access_token}`}},
    });
    client2=new Client({name:"mandatory-workflow-reconnect",version:"1"});
    await client2.connect(transport2);
    const restored=await scoped(client2,readTool.name,argumentsRead,"chat-reconnected");
    assert.notEqual(restored.isError,true,
        "Same conversation must keep its grant across MCP transport reconnect");
    const isolated=await scoped(client2,readTool.name,argumentsRead,"other-chat");
    assert.equal(isolated.isError,true,
        "Different conversation cannot borrow the grant after reconnect");
    const noMeta=await client2.callTool({name:readTool.name,arguments:argumentsRead});
    assert.equal(noMeta.isError,true,
        "A new MCP session without a conversation id cannot reuse earlier grants");
    console.log("PASS real OAuth/MCP async mandatory gate: parallel Host read, writer exclusion, result review, live policy, scoped reconnect and cross-chat isolation");
}finally{
    try{await client2?.close();}catch{}
    try{await transport2?.close();}catch{}
    try{await client?.close();}catch{}
    try{await transport?.close();}catch{}
    try{modelListener?.closeAllConnections();}catch{}
    try{await new Promise(resolve=>modelListener?.close(resolve)??resolve());}catch{}
    try{await mcp?.close();}catch{}
    try{provider?.close();}catch{}
    try{modelServer?.closeAllConnections();}catch{}
    try{await new Promise(resolve=>modelServer?.close(resolve)??resolve());}catch{}
    if(previousRoot===undefined)delete process.env.DEVSPACE_PORTABLE_ROOT;
    else process.env.DEVSPACE_PORTABLE_ROOT=previousRoot;
    rmSync(root,{recursive:true,force:true,maxRetries:15,retryDelay:100});
}
