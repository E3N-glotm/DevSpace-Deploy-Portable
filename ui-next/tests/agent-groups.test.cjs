'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createAgentGroupService}=require('../electron/agent-groups.cjs');
const {resolveGroup}=require('../../vendor/waishnav-devspace/dist/agent-group-tree.cjs');
test('nested group management, deduplication, cycles, references and edit order',()=>{
  const dir=path.resolve(__dirname,'../../reports');fs.mkdirSync(dir,{recursive:true});
  const root=fs.mkdtempSync(path.join(dir,'.tmp-agent-group-'));
  try{
    const profiles=()=>['a','b','c'].map(id=>({id,api:'chat'}));
    const svc=createAgentGroupService(root,profiles);
    svc.save({id:'child',name:'Child',members:['a','b']});
    svc.save({id:'qa',name:'QA',members:['b','c']});
    svc.save({id:'parent',name:'Parent',members:[],childGroups:['child','qa'],isDefault:true});
    assert.deepEqual(resolveGroup(svc.list(),'parent').map(x=>x.profileId),['a','b','c']);
    assert.equal(resolveGroup(svc.list(),'parent')[1].paths.length,2);
    assert.throws(()=>svc.save({id:'child',name:'Cycle',members:['a'],childGroups:['parent']}),/CYCLE/);
    assert.throws(()=>svc.remove('child'));
    svc.save({id:'child',name:'Edited',members:['a','b']});
    assert.deepEqual(svc.list().map(g=>g.id),['child','qa','parent']);
    assert.throws(()=>svc.save({id:'parent',name:'Invalid',members:[],childGroups:['child','qa'],leaderId:'a',writerId:'b',requiredReviews:2}),/INDEPENDENT_REVIEW_COUNT/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
