'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const operations=fs.readFileSync(path.join(__dirname,'../src/Operations.tsx'),'utf8');
const styles=fs.readFileSync(path.join(__dirname,'../src/styles.css'),'utf8');

test('remote agents restore visible heartbeat health indicators',()=>{
  assert.match(operations,/raw==='online'\|\|raw==='online-recent'/);
  assert.match(operations,/tone:'healthy',label:'服务正常'/);
  assert.match(operations,/raw==='offline'\?'服务离线':'服务异常'/);
  assert.match(operations,/className=\{'agent-status-dot '\+state\.tone\}/);
  assert.match(styles,/\.agent-status-dot\.healthy\{background:#16864b/);
  assert.match(styles,/\.agent-status-dot\.error\{background:#d13438/);
});

test('remote agent heartbeat status refreshes automatically without button flicker',()=>{
  assert.match(operations,/window\.setInterval\(refresh,5_000\)/);
  assert.match(operations,/document\.visibilityState==='visible'/);
  assert.match(operations,/const refresh=useCallback\(\(\)=>fetchData\(true\)/);
  assert.match(operations,/if\(!silent\)\{setBusy\(true\);setError\(''\);\}/);
  assert.match(operations,/存活状态每 5 秒自动刷新/);
});
