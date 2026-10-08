'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.resolve(__dirname,'../electron/main.cjs'),'utf8');
const preload=fs.readFileSync(path.resolve(__dirname,'../electron/preload.cjs'),'utf8');
function hooks({ownedTaskXml}={}){
  const never=new Promise(()=>{});
  const electron={
    app:{whenReady:()=>never,on(){},quit(){}},
    BrowserWindow:function(){},
    ipcMain:{handle(){}},clipboard:{writeText(){}},
    dialog:{showErrorBox(){}},shell:{},session:{},
  };
  const context={
    require:n=>n==='electron'?electron:n==='./close-policy.cjs'
      ? require('../electron/close-policy.cjs')
      :n==='./public-health.cjs'
        ? require('../electron/public-health.cjs')
      :n==='node:child_process'&&ownedTaskXml!==undefined
        ? {...require(n),spawnSync:()=>({status:0,stdout:ownedTaskXml})}:require(n),
    __dirname:path.resolve(__dirname,'../electron'),process:{env:{...process.env,DEVSPACE_PORTABLE_ROOT:path.resolve(__dirname,'../..')},pid:125,argv:[]},
    setTimeout,clearTimeout,setInterval,clearInterval,console,URL,fetch,
  };
  vm.runInNewContext(source+'\nglobalThis.testHooks={validateSettings,assertCaller,assertNoForeignServiceOwnership,getActions:()=>[...ACTIONS],getSecrets:()=>Object.keys(SECRETS)};',context);
  return context.testHooks;
}
test('context isolation and narrow renderer IPC',()=>{
  for(const value of ['contextIsolation: true','sandbox: true','nodeIntegration: false','webSecurity: true',"setWindowOpenHandler(() => ({action: 'deny'})",'will-navigate'])
    assert.ok(source.includes(value),value);
  assert.match(preload,/contextBridge\.exposeInMainWorld\('devspace'/);
  for(const value of ['exec(','spawn(','readFile(','writeFile(','getSecret('])
    assert.equal(preload.includes(value),false,value);
  assert.match(source,/event\.sender !== windowRef\.webContents/);
});
test('settings validation, secrets never substituted with asterisks',()=>{
  const h=hooks();
  const base={provider:'local',port:7676,allowedRoots:[process.cwd()],permissions:{profile:'workspace'},toolMode:'full'};
  const normalized=h.validateSettings(base);
  assert.equal(normalized.localOnly,true);
  assert.equal(normalized.publicBaseUrl,'');
  assert.equal(normalized.tunnelProvider,'ngrok');
  assert.equal(Object.hasOwn(normalized,'ownerToken'),false);
  assert.equal(Object.hasOwn(h.validateSettings({...base,ownerToken:'',cloudflareToken:''}),'cloudflareToken'),false);
  assert.throws(()=>h.validateSettings({...base,provider:'shell'}),/Unknown/);
  assert.throws(()=>h.validateSettings({...base,port:80}),/端口/);
  assert.throws(()=>h.validateSettings({...base,allowedRoots:['relative']}),/工作目录/);
  assert.throws(()=>h.validateSettings({...base,provider:'cloudflare',publicBaseUrl:'http://example.com'}));
  assert.throws(()=>h.validateSettings({...base,provider:'cloudflare',publicBaseUrl:'https://example.com/mcp'}));
});
test('dev5 file scope and operations remain independent in the privileged IPC validator',()=>{
  const h=hooks();
  const base={
    provider:'local',port:7676,allowedRoots:[process.cwd()],
    permissions:{profile:'full-access',allowExternalPaths:true,
      allowArbitraryCommands:true,allowShellMutation:true,allowNetworkAccess:true,
      allowCredentialAccess:true,allowComputerUse:true,
      allowInteractiveProcesses:true,allowPersistentProcesses:true},
    toolMode:'full',
  };
  const selected=h.validateSettings({...base,fileScopeMode:'selected',operationMode:'full'});
  assert.equal(selected.fileScopeMode,'selected');
  assert.equal(selected.allowAllFixedDrives,false);
  assert.equal(selected.permissions.profile,'custom');
  assert.equal(selected.permissions.allowExternalPaths,false);
  assert.equal(selected.permissions.allowArbitraryCommands,true);
  const allStandard=h.validateSettings({...base,fileScopeMode:'all',operationMode:'standard',
    allowedRoots:[]});
  assert.equal(allStandard.fileScopeMode,'all');
  assert.equal(allStandard.allowAllFixedDrives,true);
  assert.equal(allStandard.permissions.allowExternalPaths,true);
  assert.equal(allStandard.permissions.allowArbitraryCommands,false);
  assert.equal(allStandard.permissions.allowCredentialAccess,false);
  assert.equal(allStandard.permissions.allowNetworkAccess,true);
  assert.throws(()=>h.validateSettings({...base,fileScopeMode:'selected',allowedRoots:[]}),/工作目录/);
  assert.throws(()=>h.validateSettings({...base,fileScopeMode:'bad'}),/文件访问范围/);
});
test('only allow-listed management operations and secret kinds',()=>{
  const h=hooks();
  assert.equal(h.getActions().includes('configure'),false);
  assert.equal(h.getActions().includes('stop'),false);
  assert.equal(h.getActions().includes('uninstall-tasks'),false);
  assert.deepEqual(Array.from(h.getSecrets()),['owner','ngrok','cloudflare']);
});
test('side-by-side preview refuses to replace a foreign Portable task',()=>{
  const foreign=hooks({ownedTaskXml:'<Command>D:\\DevSpacePortable\\scripts\\hidden-launch.vbs</Command>'});
  assert.throws(()=>foreign.assertNoForeignServiceOwnership(),/另一目录/);
  const own=hooks({ownedTaskXml:'<Command>'+path.resolve(__dirname,'../..')+'\\scripts\\hidden-launch.vbs</Command>'});
  assert.doesNotThrow(()=>own.assertNoForeignServiceOwnership());
});
test('status updates are cheap native reads, not repeated manager child processes',()=>{
  const body=source.slice(source.indexOf('async function lightweightStatus'),source.indexOf('async function publishStatus'));
  assert.doesNotMatch(body,/runManager|spawn\(/);
  assert.match(source,/20_000/);
  assert.match(source,/fs\.watch/);
});
test('HTML has restrictive CSP and no remote scripts',()=>{
  const html=fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8');
  assert.match(html,/Content-Security-Policy/);
  assert.match(html,/connect-src 'none'/);
  assert.doesNotMatch(html,/https?:\/\/[^'"\s]+\.js/);
});
