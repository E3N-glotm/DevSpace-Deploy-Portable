import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRegistryStore } from "../app/node_modules/@waishnav/devspace/dist/process-registry.js";

const root = mkdtempSync(join(tmpdir(), "devspace-process-registry-"));
const store = new ProcessRegistryStore(root);

try {
  const insert = store.database.sqlite.prepare(`
    insert into process_registry (
      handle, workspace_id, workspace_root, legacy_session_id,
      command_json, shell_command, cwd, env_json, tty, persistent,
      pid, status, exit_code, signal, owner_instance_id,
      started_at, updated_at, completed_at
    ) values (
      @handle, 'ws_test', 'C:/test', null,
      null, null, 'C:/test', null, 0, 0,
      @pid, @status, null, null, 'test',
      @startedAt, @updatedAt, @completedAt
    )
  `);
  const now = Date.now();
  const iso = (daysAgo, secondsOffset = 0) => new Date(now - daysAgo * 86_400_000 - secondsOffset * 1000).toISOString();
  const add = (handle, pid, status, daysAgo, secondsOffset = 0) => {
    const timestamp = iso(daysAgo, secondsOffset);
    insert.run({
      handle,
      pid,
      status,
      startedAt: timestamp,
      updatedAt: timestamp,
      completedAt: ["running", "detached-running", "stopping"].includes(status) ? null : timestamp,
    });
  };

  add("running_keep", 101, "running", 100);
  add("detached_keep", 102, "detached-running", 100);
  add("stopping_keep", 103, "stopping", 100);
  add("very_old_terminal", 104, "exited", 60);
  add("recent_0", 200, "exited", 1, 0);
  add("recent_1", 201, "exited", 1, 1);
  add("recent_2", 202, "exited", 1, 2);
  add("recent_3", 203, "exited", 1, 3);
  add("recent_4", 204, "lost", 1, 4);

  const result = store.compactCompleted({ maxCompleted: 3, maxAgeDays: 30 });
  assert.equal(result.removedCount, 3, "old terminal row plus terminal rows beyond the count cap must be removed");

  const active = store.database.sqlite.prepare(`
    select handle from process_registry
    where status in ('running', 'detached-running', 'stopping')
    order by handle
  `).all().map((row) => row.handle);
  assert.deepEqual(active, ["detached_keep", "running_keep", "stopping_keep"], "all active/in-transition rows must survive compaction regardless of age");

  const terminal = store.database.sqlite.prepare(`
    select handle from process_registry
    where status not in ('running', 'detached-running', 'stopping')
    order by coalesce(completed_at, updated_at) desc, handle desc
  `).all().map((row) => row.handle);
  assert.deepEqual(terminal, ["recent_0", "recent_1", "recent_2"], "only the newest bounded terminal history should remain");

  console.log("PASS: process registry retention preserves active rows and bounds exited/lost history");
}
finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
