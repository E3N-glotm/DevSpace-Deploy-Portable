'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const treePath=path.resolve(__dirname,'../../vendor/waishnav-devspace/dist/agent-group-tree.cjs');
const {validateGroups,MAX_MEMBERS}=require(fs.existsSync(treePath)?treePath:'../../app/node_modules/@waishnav/devspace/dist/agent-group-tree.cjs');
function createAgentGroupService(root,profiles){
  const file=path.join(root,'data','config','model-groups.json');
  function list(){
    try{const value=JSON.parse(fs.readFileSync(file,'utf8'));if(value.version!==1||!Array.isArray(value.groups))throw Error('AGENT_GROUP_CONFIG_INVALID');return value.groups;}
    catch(e){if(e.code==='ENOENT')return [];throw e;}
  }
  function persist(groups){
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const temp=file+'.'+randomUUID()+'.tmp';
    try{fs.writeFileSync(temp,JSON.stringify({version:1,groups},null,2),{flag:'wx',mode:0o600});fs.renameSync(temp,file);}
    finally{try{fs.unlinkSync(temp);}catch{}}
  }
  function save(input){
    const id=String(input.id||'group-'+randomUUID());
    const name=String(input.name||'').trim();
    const members=input.members,childGroups=input.childGroups??[];
    const allowed=new Set(profiles().filter(p=>p.api==='chat').map(p=>p.id));
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!name||name.length>100||
      !Array.isArray(members)||!Array.isArray(childGroups)||members.length>MAX_MEMBERS||childGroups.length>MAX_MEMBERS||
      new Set(members).size!==members.length||new Set(childGroups).size!==childGroups.length||
      members.some(m=>!allowed.has(m)))throw Error('模型组名称或成员无效');
    const requiredReviews=Number(input.requiredReviews??1);
    const parallelism=Number(input.parallelism??4),backendParallelism=Number(input.backendParallelism??1);
    if(!Number.isInteger(parallelism)||parallelism<1||parallelism>8||!Number.isInteger(backendParallelism)||backendParallelism<1||backendParallelism>8)throw Error('并行数应为 1 至 8');
    const entry={id,name,members,childGroups,isDefault:input.isDefault===true,requiredReviews,parallelism,backendParallelism,
      leaderId:String(input.leaderId||''),writerId:String(input.writerId||'')};
    const previous=list();
    const updated=previous.map(g=>g.id===id?entry:entry.isDefault?{...g,isDefault:false}:g);
    if(!previous.some(g=>g.id===id))updated.push(entry);
    validateGroups(updated,allowed);
    persist(updated);return entry;
  }
  function remove(id){const groups=list();if(groups.some(g=>(g.childGroups??[]).includes(id)))throw Error('此模型组仍被上级组引用，请先解除引用');persist(groups.filter(g=>g.id!==id));return {removed:true};}
  return {list,save,remove};
}
module.exports={createAgentGroupService};
