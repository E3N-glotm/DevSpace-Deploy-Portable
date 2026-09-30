'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const app=fs.readFileSync(path.join(__dirname,'../src/App.tsx'),'utf8');
const main=fs.readFileSync(path.join(__dirname,'../electron/main.cjs'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'../src/styles.css'),'utf8');

test('home cards expose explicit local and public health lights',()=>{
  assert.match(app,/metric-status-dot/);
  assert.match(app,/status\?\.localHealthy\?'healthy':'error'/);
  assert.match(app,/status\?\.publicHealthy\?'healthy':'error'/);
  assert.doesNotMatch(app,/公网模式（连通性未核验）/);
  assert.match(css,/\.metric-status-dot\.healthy\{background:#16864b/);
  assert.match(css,/\.metric-status-dot\.error\{background:#d13438/);
});

test('home visibility drives a five-second public MCP verification',()=>{
  assert.match(app,/page!=='home'/);
  assert.match(app,/document\.visibilityState!=='visible'/);
  assert.match(app,/window\.setInterval\(refresh,5_000\)/);
  assert.match(main,/register\('getStatus', \(\) => publishStatus\(true\)\)/);
  assert.match(main,/oauth-protected-resource\/mcp/);
  assert.match(main,/metadataStatus === 200 && mcpStatus === 401/);
  assert.match(main,/Background status pushes stay local/);
});
