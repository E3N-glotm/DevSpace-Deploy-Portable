import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "vendor", "waishnav-devspace", "dist");
const installedCore = join(root, "app", "node_modules", "@waishnav", "devspace", "dist");
const serverSource = readFileSync(join(core, "server.js"), "utf8");
const workspaceSource = readFileSync(join(core, "workspaces.js"), "utf8");
const reviewSource = readFileSync(join(core, "review-checkpoints.js"), "utf8");
const processSource = readFileSync(join(core, "process-sessions.js"), "utf8");
const fileWatchSource = readFileSync(join(core, "file-watch.js"), "utf8");
const oauthSource = readFileSync(join(core, "oauth-provider.js"), "utf8");

assert.match(serverSource, /MCP_SESSION_IDLE_TIMEOUT_MS = 60 \* 60 \* 1_000/);
assert.match(serverSource, /MCP_SESSION_CLEANUP_INTERVAL_MS = 60 \* 1_000/);
assert.match(serverSource, /MCP_SESSION_MAX_ACTIVE = 32/);
assert.match(serverSource, /MCP_SESSION_HARD_MAX_ACTIVE = 96/);
assert.match(serverSource, /MCP_SESSION_MIN_RETENTION_MS = 2 \* 60 \* 1_000/);
assert.match(serverSource, /hardMaxSessions: MCP_SESSION_HARD_MAX_ACTIVE/);
assert.match(serverSource, /minRetentionMs: MCP_SESSION_MIN_RETENTION_MS/);
assert.match(serverSource, /transports\.acquire\(sessionId\)/);
assert.match(serverSource, /mcp_session_missing/);
assert.doesNotMatch(serverSource, /MCP_SESSION_IDLE_TIMEOUT_MS = 24 \* 60 \* 60/);

assert.match(workspaceSource, /MAX_CACHED_WORKSPACES = 64/);
assert.match(workspaceSource, /MAX_CONTEXT_SCAN_ENTRIES = 25_000/);
assert.match(workspaceSource, /MAX_CONTEXT_SCAN_DIRECTORIES = 2_048/);
assert.match(workspaceSource, /MAX_CONTEXT_SCAN_MS = 2_000/);
assert.match(workspaceSource, /while \(this\.workspaces\.size > MAX_CACHED_WORKSPACES\)/);
assert.match(workspaceSource, /Date\.now\(\) >= budget\.deadline/);

assert.match(reviewSource, /MAX_CACHED_REVIEW_STATES = 32/);
assert.match(reviewSource, /while \(states\.size > MAX_CACHED_REVIEW_STATES\)/);

assert.match(processSource, /DEFAULT_BUFFER_CHARACTERS = 512_000/);
assert.match(processSource, /MAX_LIVE_PROCESS_SESSIONS = 128/);
assert.doesNotMatch(processSource, /Array\.from\(value\)/);
assert.match(processSource, /return value\.slice\(start, end\)/);
assert.match(processSource, /output\.length >= budget\.tail/);
assert.match(fileWatchSource, /MAX_ACTIVE_WATCHES = 64/);
assert.match(fileWatchSource, /this\.watches\.size >= MAX_ACTIVE_WATCHES/);
assert.match(oauthSource, /MAX_PENDING_AUTHORIZATION_CODES = 256/);
assert.match(oauthSource, /pruneAuthorizationCodes\(\)/);

for (const file of ["mcp-sessions.js", "server.js", "workspaces.js", "review-checkpoints.js", "process-sessions.js", "file-watch.js", "oauth-provider.js"]) {
  assert.equal(
    readFileSync(join(installedCore, file), "utf8"),
    readFileSync(join(core, file), "utf8"),
    `installed Portable core is stale: ${file}`,
  );
}

const { McpSessionRegistry } = await import(pathToFileURL(join(core, "mcp-sessions.js")).href);
let closed = 0;
const registry = new McpSessionRegistry({ maxSessions: 32, hardMaxSessions: 96, minRetentionMs: 120_000, now: (() => {
  let clock = 0;
  return () => ++clock;
})() });
for (let index = 0; index < 10_000; index += 1) {
  registry.register(`session-${index}`, { close: async () => { closed += 1; } });
}
await Promise.resolve();
assert.equal(registry.size, 96, "fresh reconnect bursts may use bounded grace capacity instead of evicting recent sessions immediately");
assert.equal(closed, 9_904, "overflowed MCP transports beyond the hard reconnect-storm bound must be closed");
assert.ok(registry.get("session-9999"), "newest MCP session must remain available");

let inFlightClosed = 0;
let clock = 1_000_000;
const protectedRegistry = new McpSessionRegistry({
  maxSessions: 2,
  hardMaxSessions: 3,
  minRetentionMs: 0,
  now: () => ++clock,
});
protectedRegistry.register("protected-0", { close: async () => { inFlightClosed += 1; } });
protectedRegistry.register("protected-1", { close: async () => { inFlightClosed += 1; } });
const lease = protectedRegistry.acquire("protected-0");
assert.ok(lease, "existing MCP session must be acquirable for an in-flight request");
protectedRegistry.register("protected-2", { close: async () => { inFlightClosed += 1; } });
protectedRegistry.register("protected-3", { close: async () => { inFlightClosed += 1; } });
await Promise.resolve();
assert.ok(protectedRegistry.get("protected-0"), "capacity trim must never evict a session while its request is in flight");
lease.release();
await Promise.resolve();
assert.ok(protectedRegistry.size <= 3, "release must re-run deferred hard-cap trimming after an in-flight request completes");

console.log(JSON.stringify({
  boundedMcpSessions: true,
  reconnectGraceMcpSessions: true,
  inFlightMcpSessionProtection: true,
  idleMcpSessionReaping: true,
  boundedWorkspaceCache: true,
  boundedReviewStateCache: true,
  boundedContextDiscovery: true,
  allocationSafeProcessOutputBuffer: true,
  boundedLiveProcessSessions: true,
  boundedFileWatches: true,
  boundedPendingOAuthCodes: true,
  installedCoreMatchesMaintainedSource: true,
}));
