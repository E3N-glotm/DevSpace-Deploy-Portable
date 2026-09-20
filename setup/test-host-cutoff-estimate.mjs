import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// This is test data beneath the existing E-source tree, never a C-drive worktree.
const scratch = mkdtempSync(join(root, 'reports', '.tmp-host-cutoff-estimate-'));
const config = join(scratch, 'config');
const state = join(scratch, 'state');
const env = { ...process.env, DEVSPACE_PORTABLE_CONFIG_DIR: config,
  DEVSPACE_PORTABLE_STATE_DIR: state, DEVSPACE_PORTABLE_RUN_DIR: join(scratch, 'run') };
const manager = join(root, 'setup', 'portable-manager.cjs');
const run = (command, input, expectedExit = 0) => {
  const out = spawnSync(process.execPath, [manager, command, '--ascii-json'], {
    cwd: root, env, input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(out.status, expectedExit, `${command} exit=${out.status}: ${out.stderr || out.stdout}`);
  return expectedExit === 0 ? JSON.parse(out.stdout) : undefined;
};
const policyPath = join(config, 'host-cutoff-estimate.json');
let db;
try {
  const { openDatabase } = await import(pathToFileURL(join(root, 'app', 'node_modules',
    '@waishnav', 'devspace', 'dist', 'db', 'client.js')).href);
  db = openDatabase(state);
  const sqlite = db.sqlite;
  const empty = run('continuation-cutoff-estimate-get').cutoffEstimate;
  assert.equal(empty.hasEstimate, false, 'no historic observation is not a fabricated 25-minute Host limit');
  assert.equal(empty.locked, false);
  assert.equal(existsSync(policyPath), false);
  assert.equal(run('continuation-list', { includeTerminal: true }).cutoffEstimate.hasEstimate, false);

  // A different test Host must not contaminate the ChatGPT Host estimate.
  const insert = sqlite.prepare(`insert into continuation_host_profiles (
    id, observed_turn_budget_ms, timeout_samples, last_timeout_at,
    confirmed_turn_limit_ms, confirmed_turn_limit_at, cutoff_samples_json, created_at, updated_at
  ) values (?,?,?,?,?,?,?,?,?)`);
  insert.run('live-smoke@1.1.49', 600_000, 2, '2026-09-20T00:00:00Z', 600_000,
    '2026-09-20T00:00:00Z', '[600000,601000]', '2026-09-20T00:00:00Z', '2026-09-20T00:00:00Z');
  assert.equal(run('continuation-cutoff-estimate-get').cutoffEstimate.hasEstimate, false);
  insert.run('chatgpt@0.0.1', 1_555_000, 0, null, 1_555_000,
    '2026-09-13T04:26:13Z', '[1552000,1555000]', '2026-09-13T04:26:13Z', '2026-09-13T04:26:13Z');
  let estimate = run('continuation-cutoff-estimate-get').cutoffEstimate;
  assert.equal(estimate.minutes, 25.9);
  assert.match(estimate.source, /任务历史样本/);
  assert.equal(estimate.sampleCount, 2);
  assert.equal(estimate.informationalOnly, true);
  assert.equal(run('continuation-list', {}).cutoffEstimate.minutes, 25.9,
    'the same source must feed both the initial UI load and the 15s runtime poll');

  estimate = run('continuation-cutoff-estimate-set', { minutes: 31.5, locked: false }).cutoffEstimate;
  assert.equal(estimate.minutes, 31.5, 'an unlocked manual edit remains until a new observation');
  assert.equal(estimate.locked, false);
  assert.equal(run('continuation-cutoff-estimate-get').cutoffEstimate.minutes, 31.5,
    'manual input survives a new manager process');
  const update = sqlite.prepare(`update continuation_host_profiles set timeout_samples=?,
    last_timeout_at=?,confirmed_turn_limit_at=?,confirmed_turn_limit_ms=?,
    cutoff_samples_json=?,updated_at=? where id='chatgpt@0.0.1'`);
  update.run(2, '2026-09-21T00:00:00Z', '2026-09-21T00:00:00Z', 2_410_000,
    '[2390000,2410000]', '2026-09-21T00:00:00Z');
  estimate = run('continuation-cutoff-estimate-get').cutoffEstimate;
  assert.equal(estimate.minutes, 40.0, 'unlocked estimate must follow fresh Host observations');
  assert.match(estimate.source, /Host 超时观测/);

  estimate = run('continuation-cutoff-estimate-set', { minutes: 42.5, locked: true }).cutoffEstimate;
  assert.equal(estimate.minutes, 42.5);
  assert.equal(estimate.locked, true);
  update.run(3, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z', 3_010_000,
    '[2990000,3010000]', '2026-09-22T00:00:00Z');
  estimate = run('continuation-cutoff-estimate-get').cutoffEstimate;
  assert.equal(estimate.minutes, 42.5, 'locked manual estimate cannot be overwritten by new observations');
  assert.equal(estimate.observedMinutes, 50.0, 'lock preserves visibility of fresh observation');
  estimate = run('continuation-cutoff-estimate-set', { minutes: 42.5, locked: false }).cutoffEstimate;
  assert.equal(estimate.minutes, 42.5, 'unlock preserves the owner edit until the next new observation');
  update.run(4, '2026-09-23T00:00:00Z', '2026-09-23T00:00:00Z', 3_610_000,
    '[3590000,3610000]', '2026-09-23T00:00:00Z');
  assert.equal(run('continuation-cutoff-estimate-get').cutoffEstimate.minutes, 60.0);

  for (const bad of [{ minutes: 0, locked: true }, { minutes: 241, locked: true },
    { minutes: 25.05, locked: false }, { minutes: 25, locked: 'false' }]) {
    run('continuation-cutoff-estimate-set', bad, 1);
  }
  assert.equal(run('continuation-cutoff-estimate-get').cutoffEstimate.minutes, 60.0);
  assert.equal(JSON.parse(readFileSync(policyPath, 'utf8')).locked, false);

  const native = readFileSync(join(root, 'setup', 'native', 'DevSpacePortableApp.cs'), 'utf8');
  assert.match(native, /Host 截断预估（分钟）/);
  assert.match(native, /_hostCutoffMinutes\.DecimalPlaces = 1/);
  assert.match(native, /_hostCutoffEstimateLocked\.Text = "锁定预估值"/);
  assert.match(native, /estimatePanel\.Controls\.Add\(_hostCutoffEstimateStatus, 0, 1\)/,
    'the observation source and informational-only warning must stay visible on a separate UI row');
  const estimateLayout = native.split('private TabPage BuildContinuationsTab()')[1]
    ?.split('private TabPage BuildSessionsTab()')[0];
  assert.ok(estimateLayout, 'continuation page must retain a dedicated estimate editor');
  assert.match(estimateLayout, /layout\.RowStyles\.Add\(new RowStyle\(SizeType\.AutoSize\)\);\s*\/\/ The estimate editor/,
    'editor outer row must derive height from its contents, not clip at fixed 94px');
  assert.match(estimateLayout, /estimatePanel\.RowStyles\.Add\(new RowStyle\(SizeType\.AutoSize\)\);\s*estimatePanel\.RowStyles\.Add\(new RowStyle\(SizeType\.AutoSize\)\)/,
    'both editor and observation rows must size to their content');
  assert.match(estimateLayout, /estimateBar\.WrapContents = true;\s*estimateBar\.AutoScroll = false;/,
    'narrow layouts must wrap without an inner scrollbar clipping the save button');
  assert.match(estimateLayout, /estimateBar\.MinimumSize = new Size\(0, 56\)/,
    'minimum editor row must include button height, vertical margins and padding');
  assert.match(estimateLayout, /_hostCutoffEstimateStatus\.AutoSize = true;/,
    'two-line source and warning must remain visible without a fixed label height');
  assert.match(native, /RunJsonAsync\("continuation-cutoff-estimate-set"/);
  assert.match(native, /ApplyHostCutoffEstimate\(GetDictionary\(value, "cutoffEstimate"\)\)/);
  assert.match(native, /锁定不改变 ChatGPT Host 时长或自动续轮触发条件/);
  assert.ok(!existsSync(join(scratch, 'data', 'config', 'auth.json')),
    'estimate preferences must not create or mutate authentication files');
  console.log(JSON.stringify({ noFabricatedEstimate: true, historicalHostEstimate: 25.9,
    unlockedManualPersistsUntilNewObservation: true, dynamicUpdate: [40, 50, 60],
    lockPersistsAcrossUpdates: true, unrelatedHostIgnored: true,
    invalidValuesRejected: true, informationalOnly: true, nativeUiWired: true,
    contentSizedEstimateRows: true, responsiveEditorWrap: true, noInnerScrollbar: true }));
} finally {
  db?.close();
  rmSync(scratch, { recursive: true, force: true });
}
