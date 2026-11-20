import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
mkdirSync(join(root, '.test-cache'), { recursive: true });
const userData = mkdtempSync(join(root, '.test-cache', 'flow-layout-'));
try {
  const result = spawnSync(join(root, 'ui-next/runtime/electron.exe'), [
    join(root, 'setup/fixtures/agent-flow-layout-main.cjs'), '--disable-gpu',
  ], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, DEVSPACE_FLOW_LAYOUT_USER_DATA: userData },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(result.stdout.trim());
} finally {
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
