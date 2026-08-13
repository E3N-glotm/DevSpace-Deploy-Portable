import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist");
const { createReviewCheckpointManager, reviewAdmin } = await import(new URL(`file:///${join(DIST, "review-checkpoints.js").replace(/\\/g, "/")}`));
const { openDatabase } = await import(new URL(`file:///${join(DIST, "db", "client.js").replace(/\\/g, "/")}`));
const { MemoryStore } = await import(new URL(`file:///${join(DIST, "memory-store.js").replace(/\\/g, "/")}`));
const { HookManager } = await import(new URL(`file:///${join(DIST, "hook-manager.js").replace(/\\/g, "/")}`));
const { UiSessionLease } = await import(new URL(`file:///${join(DIST, "ui-session.js").replace(/\\/g, "/")}`));

const temporaryRoot = await mkdtemp(join(tmpdir(), "devspace-119-test-"));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function testNonGitRollback() {
  const root = join(temporaryRoot, "non-git");
  const stateDir = join(temporaryRoot, "non-git-state");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "example.txt"), "before\n", "utf8");
  const manager = createReviewCheckpointManager({ stateDir, sessionReviewEnabled: true });
  await manager.initializeWorkspace({ workspaceId: "non-git", root });
  await manager.beforeMutation({ workspaceId: "non-git", root, paths: ["example.txt", "created.txt"] });
  writeFileSync(join(root, "example.txt"), "before\nafter\n", "utf8");
  writeFileSync(join(root, "created.txt"), "new\n", "utf8");
  const review = await manager.sessionReview({ workspaceId: "non-git", root });
  assert.equal(review.active, true);
  assert.equal(review.gitBacked, false);
  assert.equal(review.shadowRepository, false);
  assert.equal(review.backend, "sparse-journal-v4");
  assert.equal(review.summary.files, 2);
  assert.equal(review.summary.additions, 2);
  assert.equal(review.canRollback, true);
  const rollback = await manager.rollbackSession({
    workspaceId: "non-git",
    root,
    confirmation: review.confirmationToken,
  });
  assert.equal(rollback.restored, 2);
  assert.equal(readFileSync(join(root, "example.txt"), "utf8"), "before\n");
  assert.throws(() => readFileSync(join(root, "created.txt"), "utf8"), /ENOENT/);
}

async function testNonGitShellBoundedCoverage() {
  const root = join(temporaryRoot, "non-git-shell");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "example.txt"), "before\n", "utf8");
  const manager = createReviewCheckpointManager({ stateDir: join(temporaryRoot, "non-git-shell-state"), sessionReviewEnabled: true });
  await manager.initializeWorkspace({ workspaceId: "non-git-shell", root });
  await manager.beforeMutation({ workspaceId: "non-git-shell", root, paths: ["example.txt"] });
  await manager.beforeMutation({ workspaceId: "non-git-shell", root, kind: "shell" });
  writeFileSync(join(root, "example.txt"), "changed\n", "utf8");
  writeFileSync(join(root, "shell-created.txt"), "created\n", "utf8");
  const review = await manager.sessionReview({ workspaceId: "non-git-shell", root });
  assert.equal(review.shellRollbackUnsafe, true);
  assert.equal(review.rollbackCoverage, "tracked-paths-only");
  assert.equal(review.canRollback, true);
  assert.equal(review.summary.files, 1);
  assert.deepEqual(review.files.map((file) => file.path), ["example.txt"]);
  const rollback = await manager.rollbackSession({ workspaceId: "non-git-shell", root, confirmation: review.confirmationToken });
  assert.equal(rollback.partial, false);
  assert.equal(readFileSync(join(root, "example.txt"), "utf8"), "before\n");
  assert.equal(readFileSync(join(root, "shell-created.txt"), "utf8"), "created\n");
}

async function testGitRollbackPreservesIndex() {
  const root = join(temporaryRoot, "git");
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "DevSpace Test");
  git(root, "config", "user.email", "devspace-test@example.invalid");
  writeFileSync(join(root, "base.txt"), "base\n", "utf8");
  writeFileSync(join(root, "staged.txt"), "head\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "staged.txt"), "staged baseline\n", "utf8");
  git(root, "add", "staged.txt");

  const manager = createReviewCheckpointManager({ stateDir: join(temporaryRoot, "git-state"), sessionReviewEnabled: true });
  await manager.initializeWorkspace({ workspaceId: "git", root });
  await manager.beforeMutation({ workspaceId: "git", root, paths: ["base.txt", "staged.txt", "new.txt"] });
  writeFileSync(join(root, "base.txt"), "changed\n", "utf8");
  writeFileSync(join(root, "staged.txt"), "working after baseline\n", "utf8");
  writeFileSync(join(root, "new.txt"), "new\n", "utf8");
  const review = await manager.sessionReview({ workspaceId: "git", root });
  assert.equal(review.gitBacked, false);
  assert.equal(review.canRollback, true);
  assert.ok(review.summary.files >= 3);
  await manager.rollbackSession({ workspaceId: "git", root, confirmation: review.confirmationToken });
  assert.equal(readFileSync(join(root, "base.txt"), "utf8").replace(/\r\n/g, "\n"), "base\n");
  assert.equal(readFileSync(join(root, "staged.txt"), "utf8").replace(/\r\n/g, "\n"), "staged baseline\n");
  assert.equal(git(root, "diff", "--name-only"), "");
  assert.equal(git(root, "diff", "--cached", "--name-only"), "staged.txt");
  assert.throws(() => readFileSync(join(root, "new.txt"), "utf8"), /ENOENT/);
}

async function directoryBytes(directory) {
  if (!existsSync(directory)) return 0;
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(target);
    else if (entry.isFile()) total += (await stat(target)).size;
  }
  return total;
}

async function waitUntil(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return Boolean(await predicate());
}

async function testSparseReviewStorageAndLegacyCleanup() {
  const root = join(temporaryRoot, "large-workspace");
  const stateDir = join(temporaryRoot, "large-state");
  const legacyRepository = join(stateDir, "review-repositories-v3");
  const legacySessions = join(stateDir, "review-sessions-v3");
  mkdirSync(root, { recursive: true });
  mkdirSync(legacyRepository, { recursive: true });
  mkdirSync(legacySessions, { recursive: true });
  writeFileSync(join(legacyRepository, "legacy.pack"), Buffer.alloc(2 * 1024 * 1024, 7));
  writeFileSync(join(legacySessions, "legacy.json"), "{}\n", "utf8");
  for (let index = 0; index < 300; index += 1) {
    writeFileSync(join(root, `unrelated-${index}.bin`), Buffer.alloc(64 * 1024, index % 251));
  }
  writeFileSync(join(root, "tracked.txt"), "before\n", "utf8");

  const manager = createReviewCheckpointManager({ stateDir, sessionReviewEnabled: true });
  const startedAt = performance.now();
  await manager.initializeWorkspace({ workspaceId: "large", root });
  await manager.beforeMutation({ workspaceId: "large", root, paths: ["tracked.txt"] });
  const elapsedMs = performance.now() - startedAt;
  writeFileSync(join(root, "tracked.txt"), "before\nafter\n", "utf8");
  const review = await manager.sessionReview({ workspaceId: "large", root });

  assert.ok(elapsedMs < 3000, `sparse review initialization took ${elapsedMs.toFixed(0)} ms`);
  assert.equal(review.summary.files, 1);
  assert.equal(review.storage.trackedPaths, 1);
  assert.ok(review.storage.storedBytes < 1024 * 1024);
  assert.ok(await directoryBytes(stateDir) < 8 * 1024 * 1024);
  assert.equal(await waitUntil(() => !existsSync(legacyRepository) && !existsSync(legacySessions)), true);
  assert.equal(existsSync(join(stateDir, "review-repositories-v3")), false);
}

function persistedReviewDirectory(stateDir, sessionId) {
  const key = createHash("sha256").update(String(sessionId)).digest("hex");
  return join(stateDir, "review-sessions-v4", key);
}

function writeAffectedBuildEmptyReviewSession(stateDir, sessionId, root, options = {}) {
  const directory = persistedReviewDirectory(stateDir, sessionId);
  mkdirSync(directory, { recursive: true });
  const timestamp = options.updatedAt || new Date().toISOString();
  writeFileSync(join(directory, "session.json"), `${JSON.stringify({
    formatVersion: 4,
    sessionId,
    workspaceId: sessionId,
    root,
    title: options.title || "Read-only monitor",
    status: "active",
    pinned: Boolean(options.pinned),
    hidden: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    tracked: {},
    limitations: [],
    safetySnapshots: [],
    storedBytes: 0,
    shellMutationObserved: false,
    lastReview: { files: 0, additions: 0, removals: 0 },
  }, null, 2)}\n`, "utf8");
}

async function testReadOnlySessionsCannotEvictRollbackHistory() {
  const root = join(temporaryRoot, "retention-workspace");
  const stateDir = join(temporaryRoot, "retention-state");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "valuable.txt"), "before\n", "utf8");

  const manager = createReviewCheckpointManager({ stateDir, sessionReviewEnabled: true });
  await manager.initializeWorkspace({ workspaceId: "valuable-session", root });
  await manager.beforeMutation({ workspaceId: "valuable-session", root, paths: ["valuable.txt"] });
  writeFileSync(join(root, "valuable.txt"), "before\nafter\n", "utf8");
  const valuableReview = await manager.sessionReview({ workspaceId: "valuable-session", root });
  assert.equal(valuableReview.summary.files, 1);
  assert.equal(valuableReview.canRollback, true);

  // Reproduce metadata left by affected builds: many read-only monitor opens
  // that were persisted even though no mutation baseline existed.
  for (let index = 0; index < 40; index += 1) {
    writeAffectedBuildEmptyReviewSession(
      stateDir,
      `legacy-read-only-${index}`,
      root,
      { updatedAt: new Date(Date.now() + index * 1000).toISOString() },
    );
  }
  writeAffectedBuildEmptyReviewSession(stateDir, "new-read-only-monitor", root);
  writeAffectedBuildEmptyReviewSession(stateDir, "explicitly-pinned-empty", root, { pinned: true });

  // Fresh read-only opens must stay memory-only. Meaningful rollback history
  // and an explicitly pinned empty session survive, while affected-build
  // monitor clutter is cleaned from persisted review state.
  const afterRestart = createReviewCheckpointManager({ stateDir, sessionReviewEnabled: true });
  await afterRestart.initializeWorkspace({ workspaceId: "new-read-only-monitor", root });
  for (let index = 0; index < 40; index += 1) {
    await afterRestart.initializeWorkspace({ workspaceId: `new-read-only-${index}`, root });
  }

  assert.equal(await waitUntil(async () => {
    const all = await reviewAdmin({
      stateDir,
      action: "list",
      payload: { includeEmpty: true, includeHidden: true, includeArchived: true },
    });
    return all.sessions.length <= 2;
  }), true);

  const listed = await reviewAdmin({
    stateDir,
    action: "list",
    payload: { includeEmpty: true, includeHidden: true, includeArchived: true },
  });
  const retainedIds = new Set(listed.sessions.map((session) => session.sessionId));
  assert.equal(retainedIds.has("valuable-session"), true);
  assert.equal(retainedIds.has("explicitly-pinned-empty"), true);
  assert.equal(listed.sessions.length, 2);
  assert.equal(retainedIds.has("new-read-only-39"), false);

  const details = await reviewAdmin({
    stateDir,
    action: "details",
    payload: { sessionId: "valuable-session" },
  });
  assert.equal(details.summary.files, 1);
  assert.equal(details.canRollback, true);
  assert.deepEqual(details.files.map((file) => file.path), ["valuable.txt"]);
}

async function testHistoricalReviewIsFrozenAfterMutation() {
  const root = join(temporaryRoot, "frozen-history-workspace");
  const stateDir = join(temporaryRoot, "frozen-history-state");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "history.txt"), "before\n", "utf8");

  const manager = createReviewCheckpointManager({ stateDir, sessionReviewEnabled: true });
  await manager.initializeWorkspace({ workspaceId: "history-session", root });
  await manager.beforeMutation({ workspaceId: "history-session", root, paths: ["history.txt"] });
  writeFileSync(join(root, "history.txt"), "before\nsession-change\n", "utf8");
  await manager.afterMutation({ workspaceId: "history-session", root, paths: ["history.txt"], success: true });

  // A later session/external actor changes the same live file again. Historical
  // details for history-session must continue to show its own recorded result.
  writeFileSync(join(root, "history.txt"), "before\n", "utf8");
  const details = await reviewAdmin({
    stateDir,
    action: "details",
    payload: { sessionId: "history-session" },
  });
  assert.equal(details.summary.files, 1);
  assert.equal(details.summary.additions, 1);
  assert.match(details.patch, /session-change/);

  const listed = await reviewAdmin({
    stateDir,
    action: "list",
    payload: { includeHidden: true, includeArchived: true },
  });
  const historical = listed.sessions.find((session) => session.sessionId === "history-session");
  assert.equal(historical.summary.files, 1);
  assert.ok(historical.recordedAt);
}

function testMemories() {
  const database = openDatabase(join(temporaryRoot, "memory-state"));
  try {
    const store = new MemoryStore(database.sqlite);
    const memory = store.upsert({
      scope: "workspace",
      workspaceRoot: join(temporaryRoot, "memory-workspace"),
      title: "Build preference",
      content: "Run smoke tests before packaging.",
      tags: ["build", "test", "build"],
    });
    assert.equal(memory.tags.length, 2);
    assert.equal(store.list({ workspaceRoot: join(temporaryRoot, "memory-workspace") }).length, 1);
    assert.throws(() => store.upsert({
      scope: "global",
      title: "Unsafe",
      content: "api_key=super-secret-value",
    }), /credential or secret/i);
    store.delete(memory.id);
    assert.equal(store.list({ workspaceRoot: join(temporaryRoot, "memory-workspace") }).length, 0);
  }
  finally {
    database.close();
  }
}

async function testHooks() {
  const root = join(temporaryRoot, "hook-workspace");
  mkdirSync(root, { recursive: true });
  const events = [];
  const workspaces = {
    getWorkspace: (workspaceId) => ({ id: workspaceId, root }),
    resolveWorkingDirectory: (_workspace, value) => value === "." ? root : resolve(root, value),
  };
  const manager = new HookManager({
    stateDir: join(temporaryRoot, "hook-state"),
    features: { hooks: true },
    permissions: { allowArbitraryCommands: true },
  }, {
    appendEvent: (event) => events.push(event),
  }, workspaces);
  const hook = manager.upsert({
    name: "argv smoke",
    event: "before_command",
    executable: process.execPath,
    args: ["-e", "process.stdout.write('hook-ok')"],
    blocking: true,
  });
  assert.equal(manager.hasEvent("before_command"), true);
  const results = await manager.runEvent("before_command", {
    workspaceId: "hook-workspace",
    workspaceRoot: root,
    toolName: "exec_command",
  }, { strict: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].stdout, "hook-ok");
  assert.ok(events.some((event) => event.kind === "hook.completed"));
  manager.delete(hook.id);
}

function testUiLease() {
  const leaseFile = join(temporaryRoot, "ui-session.json");
  const previous = process.env.DEVSPACE_UI_LEASE_FILE;
  process.env.DEVSPACE_UI_LEASE_FILE = leaseFile;
  try {
    const lease = new UiSessionLease({ stateDir: temporaryRoot });
    assert.equal(lease.status().active, false);
    writeFileSync(leaseFile, JSON.stringify({
      leaseId: "lease",
      openedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    assert.equal(lease.status().active, true);
    writeFileSync(leaseFile, JSON.stringify({
      leaseId: "lease",
      openedAt: new Date(Date.now() - 60_000).toISOString(),
      lastHeartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    }));
    assert.equal(lease.status().active, false);
  }
  finally {
    if (previous === undefined) delete process.env.DEVSPACE_UI_LEASE_FILE;
    else process.env.DEVSPACE_UI_LEASE_FILE = previous;
  }
}

try {
  await testNonGitRollback();
  await testNonGitShellBoundedCoverage();
  await testGitRollbackPreservesIndex();
  await testSparseReviewStorageAndLegacyCleanup();
  await testReadOnlySessionsCannotEvictRollbackHistory();
  await testHistoricalReviewIsFrozenAfterMutation();
  testMemories();
  await testHooks();
  testUiLease();
console.log("DevSpace 1.1.36 sparse historical session capability tests passed.");
}
finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
