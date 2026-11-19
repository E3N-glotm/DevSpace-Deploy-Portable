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
            const request=JSON.parse(body);
            assert.equal(request.model,"fake-enabled-worker");
            if(request.messages.some(m=>m.role==="user"&&m.content.includes("Read the remote workspace fixture"))){
                const evidence=request.messages.find(m=>m.role==="tool");
                if(evidence)assert.match(evidence.content,/remote file from enrolled Agent/);
                const message=evidence?{content:"Verified remote file"}:{content:null,tool_calls:[{
                    id:"remote-read",type:"function",function:{name:request.tools.find(t=>["read","read_file"].includes(t.function.name)).function.name,arguments:JSON.stringify({path:"remote.txt"})}
                }]};
                res.writeHead(200,{"Content-Type":"application/json"});
                res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:20,completion_tokens:10}}));
                return;
            }
            if(request.messages.some(m=>m.role==="user"&&m.content==="Agent Runtime integration test")){
                if(!request.messages.some(m=>m.role==="tool"))await sleep(350);
                const read=request.tools.find(tool=>tool.function.name==="read");
                assert.ok(read?.function.description,"Agent Runtime must receive the normal read tool description");
                assert.doesNotMatch(read.function.description,/CONVERSATION-CARD PRECONDITION|continuation_task/);
                const calls=request.messages.filter(m=>m.role==="tool");
                const next=calls.length===0?{name:"read",arguments:JSON.stringify({path:"safe.txt"})}:
                    calls.length===1?{name:"exec_command",arguments:JSON.stringify({argv:["node","--version"],yieldTimeMs:1000})}:
                    {name:"agent_finish",arguments:JSON.stringify({decision:"submit",summary:"Verified source and command"})};
                res.writeHead(200,{"Content-Type":"application/json"});
                res.end(JSON.stringify({choices:[{message:{content:null,tool_calls:[{id:"agent-test-"+calls.length,type:"function",function:next}]}}],usage:{prompt_tokens:20,completion_tokens:12}}));
                return;
            }
            if(request.messages.some(m=>m.role==="user" &&
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
        DEVSPACE_CONTINUATION_GUARD:"1",
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
    for(const tool of tools.filter(x=>["model_delegate_task","agent_task_start"].includes(x.name))){
        assert.equal(Object.hasOwn(tool.inputSchema.properties,"maxSteps"),false,tool.name);
        assert.equal(Object.hasOwn(tool.inputSchema.properties,"timeoutSeconds"),false,tool.name);
    }
    const readTool=tools.find(x=>["read","read_file"].includes(x.name));
    assert.ok(readTool,"Missing read tool");
    assert.match(readTool.description,/CONVERSATION-CARD PRECONDITION/);
    const hostCommandTool=tools.find(x=>["exec_command","bash"].includes(x.name));
    assert.ok(hostCommandTool,
        "Missing command tool in the selected DevSpace tool mode");
    const opened=await client.callTool({
        name:"open_workspace",arguments:{path:workspace,mode:"checkout"},
    });
    const workspaceId=opened.structuredContent?.workspaceId
        ||opened.structuredContent?.workspace?.workspaceId;
    assert.ok(workspaceId,"open_workspace should return workspaceId");
    const remote={id:"wire-agent",name:"Wire Agent",status:"online",connected:true,
        accessMode:"scoped",allowedRoots:["/project"],writableRoots:["/project"]};
    mcp.remoteAgents.inspectWorkspace=async(reference,root)=>{
        assert.equal(reference,remote.id);assert.equal(root,"/project");
        return {root,agent:remote,agentsFiles:[],availableAgentsFiles:[]};
    };
    mcp.remoteAgents.resolveAgent=id=>{
        assert.equal(id,remote.id);
        return remote;
    };
    mcp.remoteAgents.rpcWorkspace=async(workspace,method,args)=>{
        assert.equal(workspace.backendId,remote.id);
        if(method==="system.status")return {};
        assert.equal(method,"fs.stat");assert.equal(args.path,"remote.txt");
        return {exists:true,type:"file",size:31};
    };
    mcp.remoteAgents.read=async(workspace,path)=>{
        assert.equal(workspace.backendId,remote.id);assert.equal(path,"remote.txt");
        return {kind:"text",text:"remote file from enrolled Agent"};
    };
    const remoteOpened=await client.callTool({name:"open_workspace",arguments:{path:"devspace://wire-agent/project"}});
    assert.ok(!remoteOpened.isError,contentText(remoteOpened));
    const remoteId=remoteOpened.structuredContent.workspaceId;
    assert.equal(remoteOpened.structuredContent.backend,"remote-agent");
    const remoteArgs={workspaceId:remoteId,path:"remote.txt"};
    assert.match(contentText(await client.callTool({name:readTool.name,arguments:remoteArgs})),/MODEL_WORKFLOW_DELEGATION_REQUIRED/);
    const remoteStarted=await client.callTool({name:"model_delegate_task",arguments:{
        workspaceId:remoteId,modelId:"worker-one",useSpecifiedModel:true,instruction:"Read the remote workspace fixture",maxSteps:1}});
    assert.ok(!remoteStarted.isError,contentText(remoteStarted));
    const remoteTask=remoteStarted.structuredContent.data.taskId;
    const approvedRemote=await client.callTool({name:readTool.name,arguments:remoteArgs});
    assert.match(contentText(approvedRemote),/remote file from enrolled Agent/);
    let remoteResult;
    for(let i=0;i<80;i++){
        remoteResult=(await client.callTool({name:"model_task_result",arguments:{taskId:remoteTask}})).structuredContent.data;
        if(remoteResult.status!=="running")break;
        await sleep(25);
    }
    assert.equal(remoteResult.status,"completed",JSON.stringify(remoteResult));
    assert.equal(remoteResult.evidence[0].path,"remote.txt");
    assert.equal(remoteResult.evidence[0].ok,true);
    const localUrl="http://127.0.0.1:"+modelListener.address().port+"/agent-runtime/local";
    const uiToken=readFileSync(join(stateDir,"agent-runtime-ui.token"),"utf8");
    const requestOptions={method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"list"})};
    const localAction=(action,input,token=uiToken)=>fetch(localUrl,{...requestOptions,
        headers:{...requestOptions.headers,"x-devspace-agent-token":token},body:JSON.stringify({action,input})});
    const localTask=(action,taskId,token=uiToken)=>fetch(localUrl,{...requestOptions,
        headers:{...requestOptions.headers,"x-devspace-agent-token":token},body:JSON.stringify({action,taskId})});
    if(process.env.DEVSPACE_TEST_WORKFLOW_TOOL_MODE!=="full"){
        assert.deepEqual(await (await localAction("routing-settings")).json(),{mode:"auto",defaultWorkerId:null});
        assert.equal((await localAction("set-routing-settings",{mode:"group"},"invalid")).status,403);
        assert.equal((await localAction("set-routing-settings",{mode:"group"})).status,200);
        const unavailableGroup=await client.callTool({name:"agent_task_start",arguments:{workspaceId,instruction:"Needs default group"}});
        assert.match(contentText(unavailableGroup),/AGENT_DEFAULT_GROUP_REQUIRED/);
        assert.equal((await localAction("set-routing-settings",{mode:"single",defaultWorkerId:"worker-one"})).status,200);
        const routingList=await client.callTool({name:"model_worker_list",arguments:{}});
        assert.deepEqual(routingList.structuredContent.data.modelRouting,{mode:"single",defaultWorkerId:"worker-one"});
        const starter=await client.callTool({name:"agent_task_start",arguments:{workspaceId,instruction:"Agent Runtime integration test",allowShell:true,maxSteps:1,timeoutSeconds:1}});
        assert.ok(!starter.isError,contentText(starter));
        const id=starter.structuredContent?.data?.id;assert.ok(id);
        assert.equal(starter.structuredContent.data.routing.reason,"global-single");
        const hostRead=await client.callTool({name:readTool.name,arguments:{workspaceId,path:"safe.txt"}});
        assert.notEqual(hostRead.isError,true,contentText(hostRead));
        const uninspected=await client.callTool({name:hostCommandTool.name,arguments:{workspaceId,argv:["node","--version"],yieldTimeMs:1000}});
        assert.match(contentText(uninspected),/MODEL_WORKFLOW_WORKSPACE_WRITER_BUSY/);
        let state;
        for(let i=0;i<100;i++){
            state=await (await localTask("status",id)).json();
            if(state.status!=="running")break;await sleep(30);
        }
        assert.equal(state.status,"completed",JSON.stringify(state));
        assert.equal(state.steps,3);
        const unreviewed=await client.callTool({name:hostCommandTool.name,arguments:{workspaceId,argv:["node","--version"],yieldTimeMs:1000}});
        assert.match(contentText(unreviewed),/MODEL_WORKFLOW_WORKSPACE_WRITER_BUSY/);
        const result=await client.callTool({name:"agent_task_status",arguments:{taskId:id}});
        assert.equal(result.structuredContent?.data?.result,"Verified source and command",contentText(result));
        const inspected=await client.callTool({name:hostCommandTool.name,arguments:{workspaceId,argv:["node","--version"],yieldTimeMs:1000}});
        assert.notEqual(inspected.isError,true,contentText(inspected));
        const events=(await client.callTool({name:"agent_task_events",arguments:{taskId:id}})).structuredContent.data;
        assert.ok(events.some(e=>e.kind==="tool-result"&&e.name==="read"&&e.ok&&e.text.includes("source code content")));
        assert.ok(events.some(e=>e.kind==="tool-result"&&e.name==="exec_command"&&e.ok&&/v\d+\./.test(e.text)));
        assert.equal(events.filter(e=>e.kind==="auto-accepted").length,1);
        assert.equal((await fetch(localUrl,requestOptions)).status,403);
        const authorized=await fetch(localUrl,{...requestOptions,headers:{...requestOptions.headers,"x-devspace-agent-token":uiToken}});
        assert.equal(authorized.status,200);assert.ok((await authorized.json()).some(t=>t.id===id));
        assert.equal((await localTask("clear-history",id,"invalid")).status,403);
        assert.deepEqual(await (await localTask("delete-history",id)).json(),{deletedIds:[id]});
        assert.equal((await localTask("events",id)).status,400);
        setPolicy(true,"worker-policy");
    }
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
        workspaceId,modelId:"worker-one",useSpecifiedModel:true,instruction:"Review project only",
        allowWrites:false,maxSteps:1000,timeoutSeconds:1,
    }});
    const taskId=delegated.structuredContent?.data?.taskId;
    assert.ok(taskId);
    assert.match(taskId,/^agent_/,"Even the explicit compatibility Worker must create a persisted Agent task");
    assert.ok((await (await localAction("list")).json()).some(t=>t.id===taskId),"Compatibility task missing from workbench");
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
        workspaceId,modelId:"worker-one",useSpecifiedModel:true,
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
        workspaceId,modelId:"worker-one",useSpecifiedModel:true,instruction:"Review project only",
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
    const legacyDelegate=(input={})=>client.callTool({name:"model_delegate_task",arguments:{
        workspaceId,modelId:"worker-two",instruction:"Check global routing from a cached MCP client",...input,
    }});
    const selectRouting=async mode=>assert.equal((await localAction("set-routing-settings",{mode,defaultWorkerId:"worker-one"})).status,200);
    const legacyTask=(name,taskId)=>client.callTool({name:"model_task_"+name,arguments:{taskId}});
    await selectRouting("group");
    assert.match(contentText(await legacyDelegate()),/AGENT_DEFAULT_GROUP_REQUIRED/);
    profiles.models.push({...profiles.models[0],id:"worker-two",name:"Fake second Worker",callPolicyRevision:"p-review"});
    writeFileSync(profilesFile,JSON.stringify(profiles));
    const groupsFile=join(configDir,"model-groups.json");
    writeFileSync(groupsFile,JSON.stringify({version:1,groups:[{
        id:"default-group",name:"Default",members:["worker-one","worker-two"],isDefault:true,requiredReviews:1,
    }]}));
    for(const [mode,hints,reason] of [["group",{},"global-group"],["auto",{independentReview:true},"independent-review"]]){
        await selectRouting(mode);
        const delegated=await legacyDelegate(hints);
        assert.ok(!delegated.isError,contentText(delegated));
        const {taskId,routing,agents}=delegated.structuredContent.data;
        assert.equal(routing.reason,reason);
        assert.equal(agents.length,2);
        assert.equal((await legacyTask("status",taskId)).structuredContent?.data?.taskId,taskId);
        assert.equal((await legacyTask("cancel",taskId)).structuredContent?.data?.status,"cancelled");
        assert.equal((await legacyTask("result",taskId)).structuredContent?.data?.status,"cancelled");
    }
    for(const [mode,hints,reason] of [["auto",{},"focused-task"],["single",{independentReview:true},"global-single"]]){
        await selectRouting(mode);
        const delegated=await legacyDelegate(hints);
        assert.ok(!delegated.isError,contentText(delegated));
        const {taskId,routing,agents}=delegated.structuredContent.data;
        assert.equal(routing.reason,reason);
        assert.deepEqual(agents.map(a=>a.profileId),["worker-one"]);
        let finished;
        for(let attempt=0;attempt<80;attempt++){
            finished=(await legacyTask("result",taskId)).structuredContent.data;
            if(finished.status!=="running")break;
            await sleep(25);
        }
        assert.equal(finished.status,hints.independentReview?"awaiting-review":"completed",JSON.stringify(finished));
        assert.match(finished.answer,/examined the task/);
        if(hints.independentReview){
            const accepted=await client.callTool({name:"agent_task_accept",arguments:{taskId}});
            assert.equal(accepted.structuredContent?.data?.status,"completed",contentText(accepted));
        }
    }
    await selectRouting("group");
    const desktop=await localAction("start",{path:workspace,instruction:"Desktop follows the same global mode"});
    assert.equal(desktop.status,200);
    const desktopGroup=await desktop.json();
    assert.equal(desktopGroup.routing.reason,"global-group");
    const desktopCancelFromMcp=await legacyTask("cancel",desktopGroup.id);
    assert.equal(desktopCancelFromMcp.isError,true,contentText(desktopCancelFromMcp));
    assert.match(contentText(desktopCancelFromMcp),/AGENT_TASK_NOT_OWNED/);
    const desktopCancelled=await localTask("cancel",desktopGroup.id);
    assert.equal(desktopCancelled.status,200);
    assert.equal((await desktopCancelled.json()).status,"cancelled");
    const singleDesktop=await localAction("start",{path:workspace,modelId:"worker-one",instruction:"Override this one Desktop task"});
    assert.equal(singleDesktop.status,200);
    const desktopOverride=await singleDesktop.json();
    assert.equal(desktopOverride.routing.reason,"selected-single");
    let desktopResult;
    for(let attempt=0;attempt<80;attempt++){
        desktopResult=await (await localTask("status",desktopOverride.id)).json();
        if(desktopResult.status!=="running")break;
        await sleep(25);
    }
    assert.equal(desktopResult.status,"awaiting-review",JSON.stringify(desktopResult));
    assert.equal((await (await localTask("accept",desktopOverride.id)).json()).status,"completed");
    assert.equal((await (await localAction("routing-settings")).json()).mode,"group");
    const override=await legacyDelegate({useSpecifiedModel:true});
    assert.ok(!override.isError,contentText(override));
    assert.match(override.structuredContent.data.taskId,/^agent_/);
    assert.equal(override.structuredContent.data.routing.reason,"global-group");
    assert.equal(override.structuredContent.data.agents.length,2);
    assert.ok((await (await localAction("list")).json()).some(t=>t.id===override.structuredContent.data.taskId));
    await legacyTask("cancel",override.structuredContent.data.taskId);
    for(const hint of [{routeMode:"single"},{modelId:"worker-one"},{routeMode:"auto",modelId:"stale-cached-model"}]){
        const native=await client.callTool({name:"agent_task_start",arguments:{workspaceId,instruction:"MCP cannot override fixed global group",...hint,
            allowWrites:false,allowShell:false,allowComputer:false,allowMemory:false,allowPlugins:false}});
        assert.ok(!native.isError,contentText(native));
        const task=native.structuredContent.data;
        assert.equal(task.routing.reason,"global-group");
        assert.equal(task.agents.length,2);
        assert.ok((await (await localAction("list")).json()).some(t=>t.id===task.id));
        await legacyTask("cancel",task.id);
    }
    await selectRouting("auto");
    const specifiedAuto=await legacyDelegate({useSpecifiedModel:true});
    assert.ok(!specifiedAuto.isError,contentText(specifiedAuto));
    assert.match(specifiedAuto.structuredContent.data.taskId,/^agent_/);
    assert.equal(specifiedAuto.structuredContent.data.modelId,"worker-two");
    await legacyTask("cancel",specifiedAuto.structuredContent.data.taskId);
    await selectRouting("single");
    const specifiedSingle=await legacyDelegate({useSpecifiedModel:true});
    assert.ok(!specifiedSingle.isError,contentText(specifiedSingle));
    assert.equal(specifiedSingle.structuredContent.data.routing.reason,"global-single");
    assert.equal(specifiedSingle.structuredContent.data.modelId,"worker-one");
    await legacyTask("cancel",specifiedSingle.structuredContent.data.taskId);
    rmSync(groupsFile);
    profiles.models.pop();
    writeFileSync(profilesFile,JSON.stringify(profiles));
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
