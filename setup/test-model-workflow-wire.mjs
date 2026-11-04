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
let mcp,modelServer,modelListener,transport,client,provider;
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
        DEVSPACE_TOOL_MODE:"codex",DEVSPACE_WIDGETS:"changes",
        DEVSPACE_SUBAGENTS:"0",DEVSPACE_LOG_REQUESTS:"0",
        DEVSPACE_LOG_TOOL_CALLS:"0",
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
    const opened=await client.callTool({
        name:"open_workspace",arguments:{path:workspace,mode:"checkout"},
    });
    const workspaceId=opened.structuredContent?.workspaceId
        ||opened.structuredContent?.workspace?.workspaceId;
    assert.ok(workspaceId,"open_workspace should return workspaceId");
    const argumentsRead={workspaceId,path:"safe.txt"};
    const blocked=await client.callTool({name:readTool.name,arguments:argumentsRead});
    assert.equal(blocked.isError,true,"MCP read bypassed mandatory Worker gate");
    assert.match(contentText(blocked),/MODEL_WORKFLOW_DELEGATION_REQUIRED/);
    const list=await client.callTool({name:"model_worker_list",arguments:{}});
    assert.equal(list.structuredContent?.data?.mandatoryModelWorkflow,true);
    const delegated=await client.callTool({name:"model_delegate_task",arguments:{
        workspaceId,modelId:"worker-one",instruction:"Review project only",
        allowWrites:false,maxSteps:2,timeoutSeconds:90,
    }});
    const taskId=delegated.structuredContent?.data?.taskId;
    assert.ok(taskId);
    let result;
    for(let attempt=0;attempt<80;attempt++){
        result=await client.callTool({name:"model_task_status",arguments:{taskId}});
        if(result.structuredContent?.data?.status==="completed")break;
        await sleep(25);
    }
    assert.equal(result.structuredContent?.data?.status,"completed",contentText(result));
    const stillBlocked=await client.callTool({name:readTool.name,arguments:argumentsRead});
    assert.equal(stillBlocked.isError,true,"status alone should not authorize a task");
    const verified=await client.callTool({name:"model_task_result",arguments:{taskId}});
    assert.equal(verified.structuredContent?.data?.status,"completed");
    const passed=await client.callTool({name:readTool.name,arguments:argumentsRead});
    assert.notEqual(passed.isError,true,contentText(passed));
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
    console.log("PASS real OAuth/MCP forced model gate: deny -> delegate -> complete -> result -> allow -> disable -> deny -> optional allow");
}finally{
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
