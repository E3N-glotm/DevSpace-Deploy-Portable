'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createClosePolicy}=require('../electron/close-policy.cjs');

test('dev7 close policy preserves legacy preferences and supports all three explicit settings choices',()=>{
  const root=path.resolve(__dirname,'../../reports');
  fs.mkdirSync(root,{recursive:true});
  const isolated=fs.mkdtempSync(path.join(root,'.tmp-dev6-close-policy-'));
  try{
    const p=createClosePolicy(isolated);
    assert.equal(p.get(),'');
    fs.writeFileSync(p.file,JSON.stringify({formatVersion:1,closeChoice:'minimize-tray',
      anotherUiPreference:'preserve-me'}),'utf8');
    assert.equal(p.get(),'minimize-tray');
    assert.equal(p.save('exit-ui'),'exit-ui');
    assert.equal(p.get(),'exit-ui');
    assert.equal(JSON.parse(fs.readFileSync(p.file,'utf8')).anotherUiPreference,'preserve-me');
    assert.equal(p.save(''),'');
    assert.equal(p.get(),'');
    assert.throws(()=>p.save('stop-service'),/Invalid close preference/);
    assert.equal(p.get(),'');
  }finally{fs.rmSync(isolated,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});

test('dev7 direct settings preference IPC is allow-listed and never changes service state',()=>{
  const main=fs.readFileSync(path.resolve(__dirname,'../electron/main.cjs'),'utf8');
  const start=main.indexOf("register('setClosePreference'");
  const end=main.indexOf("register('resetClosePreference'",start);
  assert.ok(start>0 && end>start);
  const body=main.slice(start,end);
  assert.match(body,/\['','minimize-tray','exit-ui'\]/);
  assert.match(body,/closePolicy\.save\(value\)/);
  assert.doesNotMatch(body,/stop-local|stop-tunnel|uninstall-tasks|disable|runManager/);
  const preload=fs.readFileSync(path.resolve(__dirname,'../electron/preload.cjs'),'utf8');
  assert.match(preload,/setClosePreference: choice => invoke\('setClosePreference', choice\)/);
});

test('close choices do not modify service, tunnel or permissions',()=>{
  const main=fs.readFileSync(path.resolve(__dirname,'../electron/main.cjs'),'utf8');
  const body=main.slice(main.indexOf("register('chooseClose'"),main.indexOf("register('save'"));
  assert.match(body,/choice === 'minimize-tray'/);
  assert.match(body,/requestUiExit\(\)/);
  assert.match(body,/choice === 'cancel'/);
  assert.doesNotMatch(body,/stop-local|stop-tunnel|uninstall-tasks|disable/);
  assert.match(main,/trayIcon\.on\('double-click', restoreFromTray\)/);
  assert.match(main,/\{label:'下次关闭时询问'/);
  assert.match(main,/\{label:'退出控制中心',click:requestUiExit\}/);
});
