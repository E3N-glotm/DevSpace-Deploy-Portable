'use strict';

// One resolver shared by the desktop probe and live Agent requests. Never
// label an accepted request as proof that a compatible server honored it.
function resolveReasoning(model,maxTokens=model.maxOutputTokens||4096){
  const effort=model.reasoningEffort||'auto';
  const mode=model.reasoningAdapter||'auto';
  const local=['ollama','vllm'].includes(model.type);
  const flash=local&&/qwen.*flash[-_ ]?next/i.test(model.model||'');
  const qwen=local&&/qwen/i.test(model.model||'');
  const adapter=model.type==='deepseek'?'deepseek':mode==='openai'?'openai':flash?'qwen-budget':qwen?'openai':'default';
  let parameters={},effective=effort;
  if(adapter==='deepseek'){
    if(effort==='auto')effective='provider-default';
    else if(effort==='off')parameters={thinking:{type:'disabled'},reasoning_effort:'none'};
    else {effective=({low:'low',medium:'high',high:'high','extra-high':'max'})[effort];parameters={thinking:{type:'enabled'},reasoning_effort:effective};}
    if(model.api==='responses'&&effort!=='auto')parameters={reasoning:{effort:effort==='off'?'none':effective}};
  }else if(adapter==='qwen-budget'&&effort!=='auto'){
    const cap=Math.max(0,Math.floor(maxTokens/2));
    const budget=Math.min(cap,({off:0,low:512,medium:2048,high:8192,'extra-high':Infinity})[effort]??cap);
    parameters={thinking_budget_tokens:budget,reasoning_budget_tokens:budget};effective=String(budget)+' tokens';
  }else if(adapter==='openai'&&effort!=='auto'){
    effective=effort==='off'?'none':effort==='extra-high'?'xhigh':effort;
    parameters=model.api==='responses'?{reasoning:{effort:effective}}:{reasoning_effort:effective};
  }else if(effort==='auto')effective='provider-default';
  else effective='unsupported';
  return {adapter,requested:effort,effective,parameters};
}
function reasoningEvidence(reply,usage){
  const raw=reply?.reasoning_content??reply?.reasoning;
  const tokens=usage?.completion_tokens_details?.reasoning_tokens??usage?.output_tokens_details?.reasoning_tokens;
  return {reasoningReturned:typeof raw==='string'&&raw.length>0,reasoningChars:typeof raw==='string'?raw.length:0,reasoningTokens:Number.isFinite(tokens)?tokens:null};
}
module.exports={resolveReasoning,reasoningEvidence};
