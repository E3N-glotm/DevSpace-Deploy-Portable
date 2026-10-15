'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {readUpdateState}=require('../electron/update-status.cjs');

test('fixed-path updater snapshots are sanitized and ignore stale progress',()=>{
  const dir=fs.mkdtempSync(path.join(__dirname,'.tmp-update-'));
  try{
    const data=path.join(dir,'data','state');
    fs.mkdirSync(data,{recursive:true});
    const clock=Date.parse('2026-10-15T06:00:00Z');
    fs.writeFileSync(path.join(data,'update-progress.json'),'\uFEFF'+JSON.stringify({
      phase:'downloading',updatedAt:'2026-10-15T05:59:59Z',
      message:'NEVER EXPOSE credential=secret-123',
      bytesReceived:5242880,bytesTotal:10485760,
      speedBytesPerSecond:1048576,etaSeconds:5,transport:'http://secret:password@localhost',
    }));
    fs.writeFileSync(path.join(data,'update-result.json'),JSON.stringify({
      success:true,version:'1.1.65',servicesRecovered:false,
      appliedAt:'2026-10-15T05:59:55Z',services:'private key should not reach renderer',
    }));
    const state=readUpdateState(dir,clock-3000,clock);
    assert.equal(state.progress.percent,50);
    assert.equal(state.progress.speedBytesPerSecond,1048576);
    assert.equal(state.progress.etaSeconds,5);
    assert.equal(state.progress.title,'正在下载更新');
    assert.equal(state.lastInstall.servicesRecovered,false);
    assert.equal(state.lastInstall.version,'1.1.65');
    assert.doesNotMatch(JSON.stringify(state),/secret|password|private key/);
    assert.equal(readUpdateState(dir,clock,clock).progress,null,
      'a previous download cannot be shown as the current one');
    fs.writeFileSync(path.join(data,'update-progress.json'),'{partial');
    assert.equal(readUpdateState(dir,0,clock).progress,null);
    fs.writeFileSync(path.join(data,'update-progress.json'),JSON.stringify({
      phase:'external-command',updatedAt:'2026-10-15T05:59:59Z',message:'untrusted',
    }));
    assert.equal(readUpdateState(dir,0,clock).progress,null);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('Electron update progress IPC exposes only the fixed state directory',()=>{
  const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
  const preload=fs.readFileSync(path.join(__dirname,'../electron/preload.cjs'),'utf8');
  const ui=fs.readFileSync(path.join(__dirname,'../src/Operations.tsx'),'utf8');
  assert.match(main,/register\('getUpdateState', since => readUpdateState\(ROOT, since\)\)/);
  assert.match(main,/register\('startUpdateInstaller', stagingPath => operation/);
  assert.match(main,/\.update-staging/);
  assert.match(main,/spawn\(exe,\['--resume-staged',stage,'--parent-ui'/);
  assert.match(preload,/getUpdateState: since => invoke\('getUpdateState', since\)/);
  assert.match(preload,/startUpdateInstaller: staging => invoke\('startUpdateInstaller', staging\)/);
  assert.match(ui,/window\.devspace\.getUpdateState/);
  assert.match(ui,/window\.setInterval\(refresh,running==='stage'\?700:10_000\)/);
  assert.match(ui,/<progress max=\{100\}/);
  assert.match(ui,/window\.devspace\.startUpdateInstaller\(stagedPath\)/);
  assert.doesNotMatch(ui.slice(ui.indexOf('export function UpdatesPage(')),/\{result&&simple\(result\)\}/);
});
