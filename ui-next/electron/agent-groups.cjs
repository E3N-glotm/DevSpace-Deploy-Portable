'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
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
    const members=input.members;
    const allowed=new Set(profiles().filter(p=>p.api==='chat').map(p=>p.id));
    if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id)||!name||name.length>100||
      !Array.isArray(members)||members.length<1||members.length>8||new Set(members).size!==members.length||
      members.some(m=>!allowed.has(m)))throw Error('模型组名称或成员无效');
    const requiredReviews=Number(input.requiredReviews??1);
    if(!Number.isInteger(requiredReviews)||requiredReviews<1||requiredReviews>Math.max(1,members.length-1))throw Error('审查数量超出范围');
    const entry={id,name,members,isDefault:input.isDefault===true,requiredReviews};
    const previous=list().filter(g=>g.id!==id).map(g=>entry.isDefault?{...g,isDefault:false}:g);
    persist([...previous,entry]);return entry;
  }
  function remove(id){persist(list().filter(g=>g.id!==id));return {removed:true};}
  return {list,save,remove};
}
module.exports={createAgentGroupService};
