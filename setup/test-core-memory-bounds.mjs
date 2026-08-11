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
assert.match(serverSource, /new McpSessionRegistry\(\{ maxSessions: MCP_SESSION_MAX_ACTIVE \}\)/);
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
const registry = new McpSessionRegistry({ maxSessions: 32, now: (() => {
  let clock = 0;
  return () => ++clock;
})() });
for (let index = 0; index < 10_000; index += 1) {
  registry.register(`session-${index}`, { close: async () => { closed += 1; } });
}
await Promise.resolve();
assert.equal(registry.size, 32, "MCP transport registry must stay bounded during reconnect storms");
assert.equal(closed, 9_968, "overflowed MCP transports must be closed instead of retained");
assert.ok(registry.get("session-9999"), "newest MCP session must remain available");

console.log(JSON.stringify({
  boundedMcpSessions: true,
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
