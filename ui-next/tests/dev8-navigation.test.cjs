'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '../src/App.tsx'), 'utf8');
const operations = fs.readFileSync(path.join(__dirname, '../src/Operations.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../src/styles.css'), 'utf8');
const view = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)));
const home = view("!wizard&&page==='home'", "!wizard&&page==='settings'");
const settings = view("!wizard&&page==='settings'", "!wizard&&page==='agents'");

test('dev8: each configuration operation has one normal destination', () => {
  const sections = ['basic', 'files', 'operations', 'updates'];
  for (const section of sections) {
    assert.match(app, new RegExp(`id:'${section}'`));
    assert.ok(app.includes("settingsSection==='" + section + "'"));
  }
  assert.doesNotMatch(app, /'workspaces'|settingsSection==='deployment'|settingsSection==='advanced'/);
  assert.doesNotMatch(app, /page==='workspaces'|data-page="workspaces"/);
  assert.equal((app.match(/<FileAccess mode=/g)||[]).length, 2, 'wizard and settings only');
  assert.equal((app.match(/<Permissions value=/g)||[]).length, 2, 'wizard and settings only');
  assert.equal((app.match(/<DiagnosticsPage\/>/g)||[]).length, 1);
  assert.equal((app.match(/<UpdatesPage\/>/g)||[]).length, 1);
});

test('dev8: home is a read-only overview except for an actionable unsaved configuration', () => {
  assert.match(home, /className="metric-grid"/);
  assert.match(home, /\(dirty\|\|applyPending\)&&<div className="home-pending"/);
  assert.match(home, /处理配置/);
  for (const action of ['保存配置','应用并重启','重启本地 MCP','重启公网隧道',
    '检查更新','添加工作目录','恢复每次关闭时询问','仅限所选目录','全部操作']) {
    assert.ok(!home.includes('>'+action+'<'), `duplicate action on home: ${action}`);
  }
  assert.doesNotMatch(home, /quick-grid|home-actions|home-access|hero-service-button/);
});

test('dev8: settings owns save/apply/address/close behavior; service controls belong to service page', () => {
  assert.match(settings, /onClick=\{\(\)=>save\(!dirty\)\}/);
  assert.match(settings, /copyUrl\('local'\)/);
  assert.match(settings, /copyUrl\('public'\)/);
  assert.match(settings, /onClick=\{\(\)=>saveClosePreference\(''\)\}/);
  assert.doesNotMatch(settings, /resetClosePreference|runAdvanced\(/);
  assert.match(operations, /\['restart-local','重启本地 MCP'\]/);
  assert.match(operations, /name\.startsWith\('restart-'\)\|\|name\.startsWith\('stop-'\)/);
  assert.match(app, /if\(deploy&&config\?\.configured&&\s*!window\.confirm/);
  assert.match(app, /chooseClose\('minimize-tray'\)/);
  assert.match(app, /chooseClose\('exit-ui'\)/);
  assert.match(styles, /\.close-dialog-actions\{display:grid;grid-template-columns:1fr 1fr/);
});
