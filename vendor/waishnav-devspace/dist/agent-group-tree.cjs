'use strict';
const MAX_MEMBERS=32,MAX_DEPTH=12;
function resolveGroup(groups,id){
  const index=new Map(groups.map(g=>[g.id,g])),members=new Map();let visits=0;
  function walk(groupId,path,ancestors){
    if(++visits>4096)throw Error('AGENT_GROUP_TREE_LIMIT');
    if(ancestors.has(groupId))throw Error('AGENT_GROUP_CYCLE');
    if(path.length>=MAX_DEPTH)throw Error('AGENT_GROUP_DEPTH_LIMIT');
    const g=index.get(groupId);
    if(!g)throw Error('AGENT_GROUP_NOT_FOUND: '+groupId);
    const here=[...path,g.name],next=new Set([...ancestors,groupId]);
    if(!Array.isArray(g.members)||!Array.isArray(g.childGroups??[]))throw Error('AGENT_GROUP_CONFIG_INVALID');
    for(const profileId of g.members){
      const previous=members.get(profileId);
      if(previous){if(previous.paths.length<32)previous.paths.push(here);}
      else members.set(profileId,{profileId,paths:[here]});
      if(members.size>MAX_MEMBERS)throw Error('AGENT_GROUP_MEMBER_LIMIT');
    }
    for(const child of g.childGroups??[])walk(child,here,next);
  }
  walk(id,[],new Set());
  return [...members.values()];
}
function validateGroups(groups,allowed){
  for(const group of groups){
    const members=resolveGroup(groups,group.id);
    if(!members.length||members.some(m=>!allowed.has(m.profileId)))throw Error('AGENT_GROUP_MODEL_UNAVAILABLE');
    if(group.leaderId&&!members.some(m=>m.profileId===group.leaderId))throw Error('AGENT_GROUP_LEADER_NOT_MEMBER');
    if(group.writerId&&!members.some(m=>m.profileId===group.writerId))throw Error('AGENT_GROUP_WRITER_NOT_MEMBER');
    if(!Number.isInteger(group.requiredReviews)||group.requiredReviews<1||group.requiredReviews>Math.max(1,members.length-1))throw Error('AGENT_GROUP_REVIEW_COUNT_INVALID');
    if(group.leaderId&&group.writerId&&group.leaderId!==group.writerId&&members.length-2<group.requiredReviews)throw Error('AGENT_GROUP_INDEPENDENT_REVIEW_COUNT');
  }
}
module.exports={resolveGroup,validateGroups,MAX_MEMBERS};
