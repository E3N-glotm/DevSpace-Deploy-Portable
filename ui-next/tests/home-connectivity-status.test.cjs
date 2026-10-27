'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const app=fs.readFileSync(path.join(__dirname,'../src/App.tsx'),'utf8');
const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
const probe=fs.readFileSync(path.join(__dirname,'../electron/public-health.cjs'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../src/styles.css'),'utf8');

test('home cards expose explicit local and public health lights',()=>{
  assert.match(app,/metric-status-dot/);
  assert.match(app,/status\?\.localHealthy\?'healthy':'error'/);
  assert.match(app,/status\?\.publicState==='healthy'\?'healthy'/);
  assert.match(app,/status\?\.publicState==='unhealthy'\?'error'/);
  assert.match(app,/公网状态暂无法核验（不代表插件断联）/);
  assert.doesNotMatch(app,/公网模式（连通性未核验）/);
  assert.match(css,/\.metric-status-dot\.healthy\{background:#16864b/);
  assert.match(css,/\.metric-status-dot\.error\{background:#d13438/);
});

test('home visibility drives a five-second public MCP verification',()=>{
  assert.match(app,/page!=='home'/);
  assert.match(app,/document\.visibilityState!=='visible'/);
  assert.match(app,/window\.setInterval\(refresh,5_000\)/);
  assert.match(main,/register\('getStatus', \(\) => publishStatus\(true\)\)/);
  assert.match(main,/createPublicHealthMonitor\(\{/);
  assert.match(main,/request: \(url, options\) => net\.fetch\(url, options\)/,
    'public health checks must use Electron network stack and Windows proxy');
  assert.doesNotMatch(main,/const publicMonitor = createPublicHealthMonitor\(\);/,
    'Node global fetch bypasses system/PAC proxy and gives false disconnect indications');
  assert.match(probe,/oauth-protected-resource\/mcp/);
  assert.match(probe,/metadataStatus === 200 && mcpStatus === 401/);
  assert.match(probe,/recentSuccessMs = 120_000/);
  assert.match(probe,/timeoutMs = 8000/);
  assert.match(main,/20-second status pushes stay local/);
  assert.match(main,/publicRefreshHandle = setInterval/);
  assert.match(main,/publishStatus\(true\)\.catch\(\(\) => \{\}\)/);
  assert.match(main, /60_000\)/, 'background public health verification runs at bounded intervals');
  assert.match(main, /Object\.assign\(next, publicStatusFields\(live\)\)/,
    'late local-only callbacks must not override more recent public evidence');
  assert.match(main, /if \(publicRefreshHandle\) clearInterval\(publicRefreshHandle\)/);
  assert.match(app, /status\?\.publicState==='stale'\?'idle'/,
    'expired success is a neutral stale state, not an amber transient disconnect');
});
