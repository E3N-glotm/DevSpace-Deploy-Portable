import assert from "node:assert/strict";
import {test} from "node:test";
import {createRequire} from "node:module";
// Exercise the same packed core and dependency tree shipped with Portable.
import {createAgentRuntime,compactAgentMessages} from "../../../app/node_modules/@waishnav/devspace/dist/agent-runtime.js";
import {collectAgentStream} from "../../../app/node_modules/@waishnav/devspace/dist/model-worker-runtime.js";
import reasoningAdapter from "../../../app/node_modules/@waishnav/devspace/dist/reasoning-adapter.cjs";
const require=createRequire(new URL("../../../app/package.json",import.meta.url));
const Database=require("better-sqlite3");
const call=(name,args,id="c"+Math.random())=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
const reply=(...tool_calls)=>({content:null,tool_calls});
const delay=()=>new Promise(r=>setTimeout(r,10));
test("Qwen Flash automatic adapter sends bounded thinking budget and never invents reasoning usage",()=>{
    const model={type:"ollama",model:"qwen3.8-flash-next-iq3xxs-128k",reasoningAdapter:"native",maxOutputTokens:32768};
    const expected={off:0,low:512,medium:2048,high:8192,"extra-high":16384};
    for(const [reasoningEffort,budget] of Object.entries(expected)){
        const plan=reasoningAdapter.resolveReasoning({...model,reasoningEffort});
        assert.deepEqual(plan.parameters,{thinking_budget_tokens:budget,reasoning_budget_tokens:budget});
    }
    assert.deepEqual(reasoningAdapter.resolveReasoning({...model,reasoningEffort:"auto"}).parameters,{});
    assert.deepEqual(reasoningAdapter.reasoningEvidence({reasoning_content:"abc"},{}),{reasoningReturned:true,reasoningChars:3,reasoningTokens:null});
});
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
            if(a.id==="a1"&&a.steps===0)return reply(call("agent_plan",{assignments:[{to:"a2",goal:"Check evidence"}]}));
            if(a.id==="a2"&&a.steps===0)return reply(call("read",{path:"file.txt"}),call("agent_send",{to:"a1",message:"I can review the result"}),call("agent_report",{summary:"Evidence verified"}));
            if(a.id==="a1")return reply(call("agent_finish",{decision:"submit",summary:"verified"}));
            return reply(call("agent_finish",{decision:"approve",summary:"independently reviewed"}));
        },...overrides,sqlite
    });
    return {runtime,sqlite,calls,memories,writers};
}
test("default group independently reviews, records events and workspace memory",async()=>{
    const f=fixture();const t=f.runtime.start({workspaceId:"ws",instruction:"task",allowMemory:true,independentReview:true},{delegated:true});
    const done=await until(f.runtime,t.id,["completed","paused"]);
    assert.equal(done.status,"completed",done.error);assert.equal(done.result,"verified");
    assert.equal(f.calls[0].args.workspaceId,"ws");assert.equal(f.memories.length,1);
    assert.equal(done.agents.length,2);
    assert.equal(done.routing.reason,"independent-review");
    assert.ok(f.runtime.events(t.id).some(e=>e.kind==="message"));
    assert.ok(f.runtime.events(t.id).some(e=>e.kind==="review"&&e.decision==="approve"));
    assert.ok(!f.runtime.events(t.id).some(e=>e.kind==="auto-accepted"));
    await f.runtime.close();f.sqlite.close();
});
test("delegated single-model delivery settles once after the writer exits",async()=>{
    const instruction="Verify delivery";
    const f=fixture({request:async t=>t.permissions.write
        ?reply(call("agent_finish",{decision:"submit",summary:"Verified"}))
        :{content:"Verified"}});
    for(const allowWrites of [false,true]){
        const task=f.runtime.start({workspaceId:"ws",instruction,allowWrites,allowMemory:true},{delegated:true});
        const done=await until(f.runtime,task.id,["completed","paused","awaiting-review"]);
        assert.equal(done.status,"completed",done.error);
        assert.equal(done.result,"Verified");
        assert.equal(f.writers.size,0);
        assert.equal(f.memories.length,0);
        assert.equal(f.runtime.events(task.id).filter(e=>e.kind==="auto-accepted").length,1);
    }
    const desktop=f.runtime.start({workspaceId:"ws",instruction});
    await until(f.runtime,desktop.id,["awaiting-review"]);
    await f.runtime.close();
    const record=f.sqlite.prepare("select data from devspace_agent_tasks where id=?");
    const staged={...JSON.parse(record.get(desktop.id).data),id:"agent_staged_delivery",autoCompleteDelivery:true};
    f.sqlite.prepare("insert into devspace_agent_tasks(id,data) values(?,?)").run(staged.id,JSON.stringify(staged));
    for(let i=0;i<2;i++){
        const restored=fixture({sqlite:f.sqlite});
        assert.equal(restored.runtime.status(desktop.id).status,"awaiting-review");
        assert.equal(restored.runtime.status(staged.id).status,"completed");
        assert.equal(restored.runtime.events(staged.id).filter(e=>e.kind==="auto-accepted").length,1);
        await restored.runtime.close();
    }
    f.sqlite.close();
});
test("delegated empty results and inference errors cannot be automatically accepted",async()=>{
    const f=fixture({request:async t=>{
        if(t.instruction==="failed request")throw Error("MODEL_STREAM_INCOMPLETE");
        return {content:" \n "};
    }});
    for(const [instruction,error] of [["empty result","EMPTY_AGENT_RESULT"],["failed request","MODEL_STREAM_INCOMPLETE"]]){
        const task=f.runtime.start({workspaceId:"ws",instruction},{delegated:true});
        const done=await until(f.runtime,task.id,["paused","completed","awaiting-review"]);
        assert.equal(done.status,"paused");
        assert.equal(done.error,error);
        assert.ok(!f.runtime.events(task.id).some(e=>e.kind==="auto-accepted"));
    }
    await f.runtime.close();f.sqlite.close();
});
test("review threshold cannot complete a group before all configured members participate",async()=>{
    const profiles=[1,2,3].map(i=>({id:"p"+i,name:"Agent "+i,role:"worker",api:"chat",allowCalls:true,callPolicyRevision:"r"+i,contextLength:32000,maxOutputTokens:1024}));
    const f=fixture({profiles:()=>profiles,groups:()=>[{id:"g",members:profiles.map(p=>p.id),isDefault:true,requiredReviews:1}],request:async(_t,a)=>{
        if(a.id==="a1"&&!a.steps)return reply(call("agent_plan",{assignments:[{to:"a2",goal:"Implement"},{to:"a3",goal:"Analyze"}]}));
        if(a.id==="a1")return reply(call("agent_finish",{decision:"submit",summary:"verified"}));
        if(_t.team.phase==="reviewing")return reply(call("agent_finish",{decision:"approve",summary:"reviewed"}));
        return reply(call("agent_report",{summary:"Independently participated"}));
    }});
    const t=f.runtime.start({workspaceId:"ws",instruction:"task",parallelWorkstreams:2});
    const done=await until(f.runtime,t.id,["completed","paused"]);
    assert.equal(done.status,"completed",done.error);
    assert.deepEqual(done.agents.map(a=>a.steps),[2,1,2]);
    assert.equal(done.routing.reason,"parallel-work");
    await f.runtime.close();f.sqlite.close();
});
test("nested groups resolve once, parallel inference, dependency ordering and exclusive mutation",async()=>{
    const profiles=[1,2,3,4].map(i=>({id:"p"+i,name:"Agent "+i,role:i===1?"planner":i===4?"reviewer":"worker",api:"chat",allowCalls:true,callPolicyRevision:"r"+i,contextLength:32000,maxOutputTokens:1024}));
    let active=0,peak=0,writerDone=false;
    const f=fixture({profiles:()=>profiles,groups:()=>[
        {id:"root",name:"Root",members:["p1"],childGroups:["child","qa"],isDefault:true,requiredReviews:1,parallelism:3,leaderId:"p1",writerId:"p2"},
        {id:"child",name:"Execution",members:["p2","p3"],requiredReviews:1},
        {id:"qa",name:"Review",members:["p3","p4"],requiredReviews:1}
    ],request:async(t,a,p,m,tools)=>{
        if(t.team.phase==="planning"){
            assert.equal(a.id,"a1");assert.ok(!tools.some(x=>x.function.name==="apply_patch"));
            return reply(call("agent_plan",{assignments:[
                {to:"a2",goal:"Implement"}, {to:"a3",goal:"Analyze"}, {to:"a4",goal:"Verify implementation",dependsOn:["a2"]}
            ]}));
        }
        if(t.team.phase==="reviewing"){
            assert.ok(!tools.some(x=>x.function.name==="apply_patch"));
            return reply(call("agent_finish",{decision:"approve",summary:"Independent review"}));
        }
        if(a.id==="a1"){assert.ok(writerDone);return reply(call("agent_finish",{decision:"submit",summary:"Integrated result"}));}
        active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,35));active--;
        if(a.id==="a2"){
            assert.ok(tools.some(x=>x.function.name==="apply_patch"));
            return reply(call("apply_patch",{patch:"approved mutation"}),call("agent_report",{summary:"Implemented"}));
        }
        if(a.id==="a4")assert.ok(writerDone);
        assert.ok(!tools.some(x=>x.function.name==="apply_patch"));
        return reply(call("apply_patch",{patch:"unauthorized mutation"}),call("agent_report",{summary:"Read-only evidence"}));
    },callTool:async(name,args)=>{assert.equal(name,"apply_patch");assert.equal(args.patch,"approved mutation");writerDone=true;return {content:[{type:"text",text:"verified"}]};}});
    const task=f.runtime.start({workspaceId:"ws",instruction:"team task",allowWrites:true,maxSteps:1,routeMode:"group"});
    const done=await until(f.runtime,task.id,["completed","paused"]);
    assert.equal(done.status,"completed",done.error);assert.equal(done.agents.length,4);assert.equal(peak,2);
    assert.equal(done.agents[2].groupPaths.length,2);assert.ok(f.runtime.events(task.id).some(e=>e.kind==="parallel-dispatch"));
    assert.ok(f.runtime.events(task.id).some(e=>e.kind==="tool-error"&&e.error==="AGENT_TOOL_NOT_AUTHORIZED"));
    await f.runtime.close();f.sqlite.close();
});
test("global routing persists, honors explicit targets, and uses single-model mode for focused automatic work",async()=>{
    const f=fixture({request:async()=>({content:"Completed focused check"})});
    const start=options=>f.runtime.start({workspaceId:"ws",instruction:"Check a known file",...options});
    assert.deepEqual(f.runtime.routingSettings(),{mode:"auto",defaultWorkerId:null});
    const simple=start({});
    assert.equal(simple.routing.reason,"focused-task");
    assert.equal(simple.agents.length,1);
    await until(f.runtime,simple.id,["awaiting-review"]);
    assert.throws(()=>f.runtime.setRoutingSettings({mode:"group",defaultWorkerId:"p2"}),/AGENT_DEFAULT_WORKER_UNAVAILABLE/);
    f.runtime.setRoutingSettings({mode:"single",defaultWorkerId:"p1"});
    const forcedSingle=start({independentReview:true,parallelWorkstreams:3});
    assert.equal(forcedSingle.routing.reason,"global-single");
    await until(f.runtime,forcedSingle.id,["awaiting-review"]);
    const override=start({groupId:"g"});
    assert.equal(override.routing.reason,"selected-group");
    assert.equal(override.agents.length,2);
    f.runtime.setRoutingSettings({mode:"group",defaultWorkerId:"p1"});
    await f.runtime.close();
    const restored=fixture({sqlite:f.sqlite});
    assert.deepEqual(restored.runtime.routingSettings(),{mode:"group",defaultWorkerId:"p1"});
    const group=restored.runtime.start({workspaceId:"ws",instruction:"Globally grouped"});
    assert.equal(group.routing.reason,"global-group");
    await until(restored.runtime,group.id,["completed"]);
    const chosen=restored.runtime.start({workspaceId:"ws",instruction:"Explicit model",modelId:"p2"});
    assert.equal(chosen.routing.reason,"selected-single");
    assert.equal(chosen.agents[0].profileId,"p2");
    await restored.runtime.close();f.sqlite.close();
});
test("automatic routing retains a single model for optional parallel work without a default team",async()=>{
    const f=fixture({groups:()=>[],request:async()=>({content:"Finished"})});
    const start=options=>f.runtime.start({workspaceId:"ws",instruction:"Check a known file",...options});
    const single=start({parallelWorkstreams:2});
    assert.equal(single.routing.reason,"no-default-group");
    await until(f.runtime,single.id,["awaiting-review"]);
    assert.throws(()=>start({independentReview:true}),/AGENT_DEFAULT_GROUP_REQUIRED/);
    f.runtime.setRoutingSettings({mode:"group"});
    assert.throws(()=>start({}),/AGENT_DEFAULT_GROUP_REQUIRED/);
    await f.runtime.close();f.sqlite.close();
});
test("A paused Agent persisted by an older release resumes after its obsolete timeout",async()=>{
    const f=fixture({request:async()=>({content:"Ready for review"})});
    const first=f.runtime.start({workspaceId:"ws",instruction:"Check the project",timeoutSeconds:1});
    assert.equal(first.deadline,undefined);
    await until(f.runtime,first.id,["awaiting-review"]);
    await f.runtime.close();
    const row=f.sqlite.prepare("select data from devspace_agent_tasks where id=?").get(first.id);
    const data={...JSON.parse(row.data),status:"paused",deadline:Date.now()-86400000,error:"AGENT_TIME_BUDGET_EXHAUSTED"};
    f.sqlite.prepare("update devspace_agent_tasks set data=? where id=?").run(JSON.stringify(data),first.id);
    const restored=fixture({sqlite:f.sqlite,request:async()=>({content:"Finished after resuming"})});
    try{
        assert.equal(restored.runtime.status(first.id).deadline,undefined);
        restored.runtime.resume(first.id);
        const finished=await until(restored.runtime,first.id,["awaiting-review","paused"]);
        assert.equal(finished.status,"awaiting-review",finished.error);
        assert.equal(finished.result,"Finished after resuming");
    }finally{await restored.runtime.close();f.sqlite.close();}
});
test("an automatic single model promotes in place, keeping evidence and exclusive writes",async()=>{
    let originalId;
    const f=fixture({request:async(t,a,_p,messages,tools)=>{
        originalId??=t.id;
        assert.equal(t.id,originalId);
        if(!t.team){
            assert.ok(tools.some(x=>x.function.name==="agent_escalate"));
            if(!a.steps)return reply(call("read",{path:"first.txt"}));
            return reply(call("agent_escalate",{reason:"Independent check required",handoff:"Read first.txt. Check the one remaining change."}),
                call("read",{path:"must-not-run.txt"}));
        }
        assert.deepEqual([...f.writers],["ws"]);
        assert.ok(messages.some(m=>typeof m.content==="string"&&m.content.includes("Read first.txt.")));
        assert.ok(!tools.some(x=>x.function.name==="agent_escalate"));
        const reviewer=t.team.reviewers[0];
        if(t.team.phase==="planning")return reply(call("agent_plan",{assignments:[{to:reviewer,goal:"Check evidence"}]}));
        if(t.team.phase==="reviewing")return reply(call("agent_finish",{decision:"approve",summary:"Independent verification"}));
        if(a.id===reviewer)return reply(call("agent_report",{summary:"Confirmed original evidence"}));
        return reply(call("apply_patch",{patch:"remaining change"}),call("agent_finish",{decision:"submit",summary:"Finished remaining work"}));
    }});
    const t=f.runtime.start({workspaceId:"ws",instruction:"Check and finish the task",allowWrites:true});
    const done=await until(f.runtime,t.id,["completed","paused"]);
    assert.equal(done.status,"completed",done.error);
    assert.equal(done.id,originalId);
    assert.equal(done.routing.reason,"escalated");
    assert.equal(done.routing.detail,"Independent check required");
    assert.deepEqual(done.agents.map(a=>a.id),["a1","a2","a3"]);
    assert.equal(done.agents[0].state,"handed-off");
    assert.equal(done.agents[0].steps,2);
    assert.deepEqual(f.calls.map(x=>x.name),["read","apply_patch"]);
    assert.deepEqual(f.runtime.events(t.id).filter(e=>e.kind==="routing").map(e=>e.mode),["single","group"]);
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
    const saved=JSON.parse(f.sqlite.prepare("select data from devspace_agent_tasks where id=?").get(t.id).data);
    saved.maxSteps=1;
    f.sqlite.prepare("update devspace_agent_tasks set data=? where id=?").run(JSON.stringify(saved),t.id);
    assert.equal(saved.steps,saved.maxSteps);
    const restored=fixture({sqlite:f.sqlite,request:async()=>reply(call("agent_finish",{decision:"submit",summary:"inspected existing state"}))});
    assert.throws(()=>restored.runtime.resume(t.id),/ACK_REQUIRED/);
    restored.runtime.resume(t.id,true);
    assert.equal((await until(restored.runtime,t.id,["awaiting-review","paused"])).status,"awaiting-review");
    await restored.runtime.close();f.sqlite.close();
});
test("compaction preserves goal and complete assistant/tool turns",()=>{
    const old=[{role:"system",content:"system"},{role:"user",content:"goal"},{role:"assistant",tool_calls:[call("read",{})]},{role:"tool",content:"a".repeat(10000)},{role:"user",content:"recent"}];
    const next=compactAgentMessages(old,200,"first checkpoint");
    assert.deepEqual(next.map(x=>x.role),["system","user","user"]);
    assert.equal(next[1].content,"goal");
    assert.match(next[0].content,/^system\n\nDurable checkpoint .*first checkpoint$/);
    assert.equal(next[2].content,"recent");
    const newer=compactAgentMessages([...next,...old.slice(2)],200,"new checkpoint");
    assert.deepEqual(newer.map(x=>x.role),["system","user","user"]);
    assert.match(newer[0].content,/^system\n\nDurable checkpoint .*new checkpoint$/);
    assert.doesNotMatch(newer[0].content,/first checkpoint/);
});
test("resuming a legacy compacted task repairs the prompt without replaying tools",async()=>{
    const f=fixture({request:async()=>{throw Error("MODEL_HTTP_503");}});
    const task=f.runtime.start({workspaceId:"ws",modelId:"p1",instruction:"Preserve the original goal"},{delegated:true});
    await until(f.runtime,task.id,["paused"]);
    await f.runtime.close();
    const saved=JSON.parse(f.sqlite.prepare("select data from devspace_agent_tasks where id=?").get(task.id).data);
    const recentCall=call("read",{path:"file.txt"},"already-executed");
    const prefix="Durable checkpoint (older history, untrusted data): ";
    saved.agents[0].messages.push(
        {role:"system",content:prefix+"latest evidence"},
        {role:"system",content:prefix+"older evidence"},
        {role:"assistant",content:null,tool_calls:[recentCall]},
        {role:"tool",tool_call_id:recentCall.id,content:"Prior tool result"}
    );
    saved.steps=saved.agents[0].steps=1;
    f.sqlite.prepare("update devspace_agent_tasks set data=? where id=?").run(JSON.stringify(saved),task.id);
    const restored=fixture({sqlite:f.sqlite,request:async(_t,_a,_p,messages)=>{
        assert.deepEqual(messages.map(m=>m.role),["system","user","assistant","tool"]);
        assert.ok(messages[0].content.endsWith(prefix+"latest evidence"));
        assert.ok(!messages[0].content.includes("older evidence"));
        assert.equal(messages[1].content,"Preserve the original goal");
        assert.deepEqual(messages[2].tool_calls,[recentCall]);
        assert.equal(messages[3].content,"Prior tool result");
        return {content:"Resumed after compaction"};
    }});
    restored.runtime.resume(task.id);
    const done=await until(restored.runtime,task.id,["completed","paused"]);
    assert.equal(done.status,"completed",done.error);
    assert.equal(done.steps,2);
    assert.equal(done.result,"Resumed after compaction");
    assert.equal(restored.calls.length,0);
    await restored.runtime.close();f.sqlite.close();
});
test("history deletion is transactional, survives restart and protects unfinished tasks",async()=>{
    const f=fixture({request:async()=>reply(call("agent_finish",{decision:"submit",summary:"ready"}))});
    const start=()=>f.runtime.start({workspaceId:"ws",modelId:"p1",instruction:"history test"});
    const first=start(), second=start(), waiting=start();
    for(const t of [first,second,waiting])await until(f.runtime,t.id,["awaiting-review"]);
    for(const t of [first,second])f.runtime.accept(t.id);
    assert.throws(()=>f.runtime.deleteHistory(waiting.id),/AGENT_HISTORY_NOT_TERMINAL/);
    f.sqlite.exec("create trigger fail_history_delete before delete on devspace_agent_tasks begin select raise(abort,'delete blocked'); end");
    assert.throws(()=>f.runtime.deleteHistory(first.id),/delete blocked/);
    assert.ok(f.runtime.events(first.id).length);
    assert.equal(f.runtime.status(first.id).status,"completed");
    f.sqlite.exec("drop trigger fail_history_delete");
    assert.deepEqual(f.runtime.deleteHistory(first.id),{deletedIds:[first.id]});
    assert.deepEqual(f.runtime.deleteHistory(first.id),{deletedIds:[]});
    assert.deepEqual(f.runtime.deleteHistory(),{deletedIds:[second.id]});
    const count=f.sqlite.prepare("select count(*) as n from devspace_agent_events where task_id=?");
    assert.equal(count.get(first.id).n,0);
    assert.equal(count.get(second.id).n,0);
    assert.ok(count.get(waiting.id).n>0);
    await f.runtime.close();
    const restarted=fixture({sqlite:f.sqlite});
    assert.deepEqual(restarted.runtime.list().map(task=>task.id),[waiting.id]);
    await restarted.runtime.close();
    f.sqlite.close();
});
test("cancelled task remains protected until in-flight work unwinds",async()=>{
    let release, started;
    const pending=new Promise(resolve=>{release=resolve;});
    const admitted=new Promise(resolve=>{started=resolve;});
    const f=fixture({request:async()=>{started();await pending;return reply();}});
    const t=f.runtime.start({workspaceId:"ws",modelId:"p1",instruction:"cancellation race"});
    await admitted;
    f.runtime.cancel(t.id);
    assert.throws(()=>f.runtime.deleteHistory(t.id),/AGENT_HISTORY_NOT_TERMINAL/);
    assert.deepEqual(f.runtime.deleteHistory(),{deletedIds:[]});
    release();
    await delay();
    assert.deepEqual(f.runtime.deleteHistory(t.id),{deletedIds:[t.id]});
    await f.runtime.close();
    f.sqlite.close();
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
    const result=await collectAgentStream(response);
    assert.equal(result.choices[0].message.reasoning_content,"real reasoning");
    assert.equal(result.choices[0].message.content,"real answer");
    assert.deepEqual(JSON.parse(result.choices[0].message.tool_calls[0].function.arguments),{path:"safe.txt"});
    assert.equal(result.usage.completion_tokens,12);
    await assert.rejects(collectAgentStream(new Response(parts[0])),/INCOMPLETE/);
});
