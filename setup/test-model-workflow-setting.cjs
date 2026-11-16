'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const reports=path.resolve(__dirname,'../reports');
fs.mkdirSync(reports,{recursive:true});

test('manager force-mode toggle only activates for a callable Worker or Agent',()=>{
  const dir=fs.mkdtempSync(path.join(reports,'.tmp-mandatory-model-'));
  const manager=path.resolve(__dirname,'portable-manager.cjs');
  const env={...process.env,DEVSPACE_PORTABLE_CONFIG_DIR:dir};
  const run=(enabled)=>spawnSync(process.execPath,[manager,'set-model-workflow'],{
    input:JSON.stringify({enabled}),cwd:reports,env,encoding:'utf8',windowsHide:true,
    timeout:20000,
  });
  try{
    const absent=run(true);
    assert.notEqual(absent.status,0);
    const profiles={version:1,models:[{
      id:'local1',type:'ollama',role:'worker',api:'chat',
      model:'qwen',baseUrl:'http://127.0.0.1:11434/v1',allowCalls:false,
    }]};
    fs.writeFileSync(path.join(dir,'model-providers.json'),JSON.stringify(profiles));
    assert.notEqual(run(true).status,0);
    profiles.models[0].allowCalls=true;
    fs.writeFileSync(path.join(dir,'model-providers.json'),JSON.stringify(profiles));
    const enabled=run(true);
    assert.equal(enabled.status,0,enabled.stderr);
    assert.equal(JSON.parse(enabled.stdout).enabled,true);
    const saved=JSON.parse(fs.readFileSync(path.join(dir,'model-workflow.json'),'utf8'));
    assert.equal(saved.enabled,true);
    profiles.models[0].role='planner';
    profiles.models[0].encryptedKey='fixture';
    fs.writeFileSync(path.join(dir,'model-providers.json'),JSON.stringify(profiles));
    assert.notEqual(run(true).status,0);
    profiles.models[0].workerEncryptedKey='fixture-vault-bridge';
    fs.writeFileSync(path.join(dir,'model-providers.json'),JSON.stringify(profiles));
    assert.equal(run(true).status,0);
    const disabled=run(false);
    assert.equal(disabled.status,0,disabled.stderr);
    assert.equal(JSON.parse(disabled.stdout).enabled,false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
