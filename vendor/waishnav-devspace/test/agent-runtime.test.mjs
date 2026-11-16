import assert from "node:assert/strict";
import {test} from "node:test";
import {createRequire} from "node:module";
// Exercise the same packed core and dependency tree shipped with Portable.
import {createAgentRuntime,compactAgentMessages} from "../../../app/node_modules/@waishnav/devspace/dist/agent-runtime.js";
import {collectAgentStream} from "../../../app/node_modules/@waishnav/devspace/dist/model-worker-runtime.js";
const require=createRequire(new URL("../../../app/package.json",import.meta.url));
const Database=require("better-sqlite3");
const call=(name,args,id="c"+Math.random())=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const reply=(...tool_calls)=>({content:null,tool_calls});
const delay=()=>new Promise(r=>setTimeout(r,10));
async function until(runtime,id,states){for(let i=0;i<200;i++){const s=runtime.status(id);if(states.includes(s.status))return s;await delay();}throw Error("TIMEOUT");}
function fixture(overrides={}){
    const sqlite=overrides.sqlite||new Database(":memory:");
    const writers=new Set(),calls=[],memories=[];
    const profiles=[{id:"p1",name:"One",role:"worker",api:"chat",allowCalls:true,callPolicyRevision:"r1",contextLength:32000,maxOutputTokens:1024},
        {id:"p2",name:"Two",role:"reviewer",api:"chat",allowCalls:true,callPolicyRevision:"r2",contextLength:32000,maxOutputTokens:1024}];
    const runtime=createAgentRuntime({
        sqlite,portableRoot:"unused",workspaces:{getWorkspace:id=>{assert.equal(id,"ws");return {root:"E:/project"};}},
        worker:{beginAgentWriter(id){assert.ok(!writers.has(id));writers.add(id);},endAgentWriter(id){writers.delete(id);}},
        memoryStore:{summaries:()=>[{title:"project decision",content:"use E drive"}],upsert:m=>memories.push(m)},
        config:{features:{memories:true}},groups:()=>[{id:"g",members:["p1","p2"],isDefault:true,requiredReviews:1}],
        profiles:()=>profiles,
        getTools:async()=>["read","apply_patch","exec_command","computer_action","memory_upsert","plugin_action","permission_rules_reload"].map(name=>({name,inputSchema:{type:"object",properties:{workspaceId:{type:"string"}}}})),
        callTool:async(name,args)=>{calls.push({name,args});return {content:[{type:"text",text:"verified evidence"}]};},
        request:async(_t,a,_p,messages,tools)=>{
            assert.ok(messages[0].content.includes("use E drive"));
            assert.ok(!tools.some(x=>x.function.name==="permission_rules_reload"));
            if(a.id==="a1"&&a.steps===0)return reply(call("read",{path:"file.txt"}));
            if(a.id==="a2"&&a.steps===0)return reply(call("agent_send",{to:"a1",message:"I can review the result"}));
            if(a.id==="a1")return reply(call("agent_finish",{decision:"submit",summary:"verified"}));
            return reply(call("agent_finish",{decision:"approve",summary:"independently reviewed"}));
        },...overrides,sqlite
    });
    return {runtime,sqlite,calls,memories,writers};
}
test("default group independently reviews, records events and workspace memory",async()=>{
    const f=fixture();const t=f.runtime.start({workspaceId:"ws",instruction:"task",allowMemory:true});
    const done=await until(f.runtime,t.id,["completed","paused"]);
    assert.equal(done.status,"completed",done.error);assert.equal(done.result,"verified");
    assert.equal(f.calls[0].args.workspaceId,"ws");assert.equal(f.memories.length,1);
    assert.equal(done.agents.length,2);
    assert.ok(f.runtime.events(t.id).some(e=>e.kind==="message"));
    assert.ok(f.runtime.events(t.id).some(e=>e.kind==="review"&&e.decision==="approve"));
    await f.runtime.close();f.sqlite.close();
});
test("scope, explicit grants, sensitive memory and single agent acceptance",async()=>{
    const f=fixture({request:async(_t,a,_p,_m,tools)=>{
        assert.ok(!tools.some(x=>["exec_command","computer_action","apply_patch","plugin_action"].includes(x.function.name)));
        if(!a.steps)return reply(call("exec_command",{argv:["git","status"]}),call("read",{workspaceId:"other",path:"foo"}),call("read",{path:"../secrets"}),call("memory_upsert",{scope:"global",allowSensitive:true,title:"note",content:"data"}));
        return reply(call("agent_finish",{decision:"submit",summary:"done"}));
    }});
    const t=f.runtime.start({workspaceId:"ws",modelId:"p1",instruction:"task",allowMemory:true});
    const done=await until(f.runtime,t.id,["awaiting-review","paused"]);assert.equal(done.status,"awaiting-review",done.error);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,"memory_upsert");
    assert.equal(f.calls[0].args.scope,"workspace");assert.equal(f.calls[0].args.allowSensitive,false);
    assert.equal(f.runtime.accept(t.id).status,"completed");
    await f.runtime.close();f.sqlite.close();
});
test("restart does not replay uncertain side effects and requires acknowledgment",async()=>{
    const f=fixture({callTool:async()=>{throw Error("connection lost");},request:async()=>reply(call("apply_patch",{patch:"test"}))});
    const t=f.runtime.start({workspaceId:"ws",modelId:"p1",instruction:"task",allowWrites:true});
    const paused=await until(f.runtime,t.id,["paused"]);assert.ok(paused.pending);
    await f.runtime.close();
    const restored=fixture({sqlite:f.sqlite,request:async()=>reply(call("agent_finish",{decision:"submit",summary:"inspected existing state"}))});
    assert.throws(()=>restored.runtime.resume(t.id),/ACK_REQUIRED/);
    restored.runtime.resume(t.id,true);
    assert.equal((await until(restored.runtime,t.id,["awaiting-review","paused"])).status,"awaiting-review");
    await restored.runtime.close();f.sqlite.close();
});
test("compaction preserves goal and complete assistant/tool turns",()=>{
    const old=[{role:"system",content:"system"},{role:"user",content:"goal"},{role:"assistant",tool_calls:[call("read",{})]},{role:"tool",content:"a".repeat(10000)},{role:"user",content:"recent"}];
    const next=compactAgentMessages(old,200,"durable checkpoint");
    assert.equal(next[1].content,"goal");assert.ok(next.some(x=>x.content.includes("durable checkpoint")));
    assert.ok(!next.some(x=>x.role==="tool"));assert.ok(next.some(x=>x.content==="recent"));
});
test("streaming joins real reasoning, content and tool deltas, rejects interrupted streams",async()=>{
    const chunk=data=>"data: "+JSON.stringify(data)+"\n\n";
    const parts=[
        chunk({choices:[{delta:{reasoning_content:"real reasoning",tool_calls:[{index:0,id:"call",function:{name:"read",arguments:"{\"path\":"}}]}}]}),
        chunk({choices:[{delta:{content:"real answer",tool_calls:[{index:0,function:{arguments:"\"safe.txt\"}"}}]},finish_reason:"tool_calls"}]}),
        chunk({usage:{prompt_tokens:10,completion_tokens:12},choices:[]}),
        "data: [DONE]\n\n"
    ];
    const response=new Response(parts.join(""),{headers:{"content-type":"text/event-stream"}});
    const result=await collectAgentStream(response,10000);
    assert.equal(result.choices[0].message.reasoning_content,"real reasoning");
    assert.equal(result.choices[0].message.content,"real answer");
    assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments),{path:"safe.txt"});
    assert.equal(result.usage.completion_tokens,12);
    await assert.rejects(collectAgentStream(new Response(parts[0]),10000),/INCOMPLETE/);
});
