const {contextBridge}=require('electron');
const stamp=new Date().toISOString();
const profiles=[1,2,3,4].map((n)=>({id:'p'+n,name:'Qwen flash next',contextLength:n===4?65536:131072,role:n===4?'reviewer':'worker',api:'chat',allowCalls:true}));
const agents=[1,2,3,4].map(n=>({id:'a'+n,profileId:'p'+n,state:n===1?'handed-off':'ready',steps:1,contextEstimate:100,inputTokens:10,outputTokens:10}));
const task={id:'layout-fixture',instruction:'Flow layout regression',workspaceId:'ws',groupId:'team',status:'running',steps:3,createdAt:stamp,
  agents,team:{leader:'a2',writer:'a3',reviewers:['a4'],phase:'working',assignments:{}},permissions:{}};
const long='https://example.invalid/'+'unbroken_path_'.repeat(50);
const events=[
 {seq:1,at:stamp,kind:'message',agent:'a4',to:'a3',message:'新只读清点任务（INV-19）。G: 目录只读；'+long},
 {seq:2,at:stamp,kind:'tool-start',agent:'a3',name:'very_long_tool_name_'.repeat(35),args:{path:'G:/readonly/fixture'}},
 {seq:3,at:stamp,kind:'tool-result',agent:'a3',name:'very_long_tool_name_'.repeat(35),text:long,ok:true},
 {seq:4,at:stamp,kind:'output',agent:'a2',content:'中文预览'.repeat(100)}
];
contextBridge.exposeInMainWorld('devspace',{
 onStatus:()=>()=>{},onProgress:()=>()=>{},onCloseRequest:()=>()=>{},getClosePreference:async()=>'',
 initialize:async()=>({config:{configured:true,localOnly:true,allowedRoots:[],portableDisplayVersion:'1.1.68'},status:{provider:'local',localHealthy:true},root:'E:',applyPending:false}),
 getStatus:async()=>({provider:'local',localHealthy:true}),modelProvidersList:async()=>profiles,agentGroupsList:async()=>[{id:'team',name:'QA'}],
 agentRuntime:async(action,payload={})=>{
   if(action==='list')return [task];
   if(action==='events')return events.filter(e=>e.seq>(payload.after||0));
   if(action==='routing-settings')return {mode:'auto',defaultWorkerId:null};
   throw Error('Unexpected fixture action '+action);
 }
});
