import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CACHE_ROOT = join(ROOT, ".test-cache", "remote-workspace-backend");
const DIST = new URL("../app/node_modules/@waishnav/devspace/dist/", import.meta.url);
const { WebSocket } = await import(new URL("../app/node_modules/ws/wrapper.mjs", import.meta.url));
const { RemoteAgentManager } = await import(new URL("remote-agent-manager.js", DIST));
const { createWorkspaceStore } = await import(new URL("workspace-store.js", DIST));
const { WorkspaceRegistry } = await import(new URL("workspaces.js", DIST));
const { createReviewCheckpointManager } = await import(new URL("review-checkpoints.js", DIST));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function encode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return { encoding: "base64", data: buffer.toString("base64") };
}

function decode(value) {
  if (!value) return Buffer.alloc(0);
  const data = Buffer.from(String(value.data ?? ""), "base64");
  if (value.encoding === "base64") return data;
  if (value.encoding === "gzip-base64") return gunzipSync(data);
  throw new Error(`Unexpected fake-agent encoding: ${value.encoding}`);
}

function remoteAbsolute(root, path = ".") {
  const normalizedRoot = String(root).replace(/\/+$/, "");
  const text = String(path ?? ".").replace(/\\/g, "/");
  if (text.startsWith("/")) return text;
  if (text === "." || text === "") return normalizedRoot;
  return `${normalizedRoot}/${text}`.replace(/\/{2,}/g, "/");
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return Boolean(await predicate());
}

class FakeLinuxAgent {
  constructor(url, options, files) {
    this.url = url;
    this.options = options;
    this.files = files;
    this.transfers = new Map();
    this.requestCounts = new Map();
    this.ws = undefined;
    this.ack = undefined;
  }

  async connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    const ackPromise = new Promise((resolvePromise, rejectPromise) => {
      ws.once("error", rejectPromise);
      ws.on("message", (data) => {
        const message = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
        if (message.type === "hello_ack") {
          this.ack = message;
          if (this.options.enrollmentToken && this.options.confirmEnrollment !== false) {
            ws.send(JSON.stringify({ type: "enrollment_confirm", agentId: message.agentId }));
          }
          resolvePromise(message);
          return;
        }
        if (message.type === "request") {
          void this.handleRequest(message);
        }
      });
    });
    await new Promise((resolvePromise, rejectPromise) => {
      ws.once("open", resolvePromise);
      ws.once("error", rejectPromise);
    });
    ws.send(JSON.stringify({
      type: "hello",
      protocol: 1,
      agentVersion: "1.0.0-test",
      hostname: "fake-linux-agent",
      platform: "linux-x86_64",
      capabilities: {
        filesystem: true,
        processes: true,
        pty: true,
        fileWatch: true,
        git: true,
        gpu: true,
        chunkedTransfer: true,
        deltaTransfer: true,
        compression: "gzip",
        autoUpdate: false,
        persistentProcesses: true,
      },
      metadata: { python: "3.12-test", user: "ubuntu", uid: 1000 },
      ...(this.options.enrollmentToken
        ? { enrollmentToken: this.options.enrollmentToken }
        : { agentId: this.options.agentId, agentSecret: this.options.agentSecret }),
    }));
    return ackPromise;
  }

  async handleRequest(message) {
    const method = String(message.method);
    this.requestCounts.set(method, (this.requestCounts.get(method) ?? 0) + 1);
    try {
      if (method === "test.disconnect") {
        this.ws.close(1012, "test disconnect");
        return;
      }
      const result = this.dispatch(method, message.params ?? {});
      this.ws.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
    }
    catch (error) {
      this.ws.send(JSON.stringify({
        type: "response",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  dispatch(method, params) {
    switch (method) {
      case "workspace.inspect":
        return {
          root: params.path,
          title: "project",
          git: { sha: "abc123", branch: "main", originUrl: "git@example.invalid/project.git" },
          agentsFiles: [{ path: `${params.path}/AGENTS.md`, content: "Remote project instructions.\n" }],
          availableAgentsFiles: [{ path: `${params.path}/nested/AGENTS.md` }],
        };
      case "fs.stat": {
        const path = remoteAbsolute(params.root, params.path);
        const content = this.files.get(path);
        return content
          ? { exists: true, type: "file", size: content.length, mode: 0o644, mtimeMs: 1 }
          : { exists: false, type: "missing", size: 0 };
      }
      case "fs.readChunk": {
        const path = remoteAbsolute(params.root, params.path);
        const content = this.files.get(path);
        if (!content) throw new Error(`Missing fake file: ${path}`);
        const offset = Number(params.offset ?? 0);
        const length = Number(params.length ?? content.length);
        return { content: encode(content.subarray(offset, Math.min(content.length, offset + length))) };
      }
      case "fs.capture": {
        const path = remoteAbsolute(params.root, params.path);
        const content = this.files.get(path);
        if (!content) return { descriptor: { exists: false, type: "missing", stored: true } };
        return {
          descriptor: {
            exists: true,
            type: "file",
            stored: true,
            size: content.length,
            mode: 0o644,
            mtimeMs: 1,
            sha256: sha256(content),
            text: !content.includes(0),
          },
          content: encode(content),
        };
      }
      case "fs.restore": {
        const path = remoteAbsolute(params.root, params.path);
        if (!params.descriptor?.exists) this.files.delete(path);
        else this.files.set(path, decode(params.content));
        return { restored: true, path: params.path };
      }
      case "fs.write": {
        const path = remoteAbsolute(params.root, params.path);
        const content = decode(params.content);
        assert.equal(sha256(content), params.sha256);
        this.files.set(path, content);
        return { path: params.path, bytes: content.length, sha256: params.sha256, deltaTransfer: false };
      }
      case "fs.prepareWrite": {
        const path = remoteAbsolute(params.root, params.path);
        this.transfers.set(params.transferId, {
          path,
          size: Number(params.size),
          sha256: params.sha256,
          chunks: params.chunks,
          received: new Map(),
        });
        return { transferId: params.transferId, missingChunks: params.chunks.map((item) => item.index), reusedChunks: 0 };
      }
      case "fs.writeChunk": {
        const transfer = this.transfers.get(params.transferId);
        if (!transfer) throw new Error(`Missing transfer: ${params.transferId}`);
        const content = decode(params.content);
        assert.equal(sha256(content), params.sha256);
        transfer.received.set(Number(params.index), content);
        return { transferId: params.transferId, index: Number(params.index), bytes: content.length };
      }
      case "fs.commitWrite": {
        const transfer = this.transfers.get(params.transferId);
        if (!transfer) throw new Error(`Missing transfer: ${params.transferId}`);
        const content = Buffer.concat(transfer.chunks.map((item) => transfer.received.get(Number(item.index))));
        assert.equal(content.length, transfer.size);
        assert.equal(sha256(content), transfer.sha256);
        this.files.set(transfer.path, content);
        this.transfers.delete(params.transferId);
        return { path: transfer.path, bytes: content.length, sha256: transfer.sha256, deltaTransfer: true };
      }
      case "system.status":
        return {
          hostname: "fake-linux-agent",
          platform: "linux-x86_64",
          loadAverage: [0.5, 0.4, 0.3],
          cpuCount: 32,
          memory: { MemTotal: "67108864 kB", MemAvailable: "50331648 kB" },
          gpus: [{ index: "0", name: "NVIDIA H200", memoryUsedMiB: "1234", memoryTotalMiB: "143771", utilizationPercent: "7", temperatureC: "31" }],
          agentVersion: "1.0.0-test",
        };
      default:
        throw new Error(`Unsupported fake RPC method: ${method}`);
    }
  }

  async close() {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise((resolvePromise) => {
      ws.once("close", resolvePromise);
      ws.close(1000, "test complete");
      setTimeout(resolvePromise, 1000).unref?.();
    });
  }
}

await rm(CACHE_ROOT, { recursive: true, force: true });
await mkdir(CACHE_ROOT, { recursive: true });

const stateDir = join(CACHE_ROOT, "state");
const events = [];
const config = {
  stateDir,
  host: "127.0.0.1",
  allowedHosts: ["127.0.0.1", "localhost"],
  publicBaseUrl: "http://127.0.0.1",
  allowedRoots: [ROOT],
  permissions: { allowExternalPaths: true },
  skillPaths: [],
  skillsEnabled: false,
};
const runtimeState = { appendEvent: (event) => events.push(event) };
const manager = new RemoteAgentManager(config, runtimeState);
const workspaceStore = createWorkspaceStore(stateDir);
const httpServer = createServer((_req, res) => {
  res.statusCode = 404;
  res.end("not found");
});

let agent;
let reconnectAgent;
try {
  manager.attachHttpServer(httpServer);
  await new Promise((resolvePromise, rejectPromise) => {
    httpServer.once("error", rejectPromise);
    httpServer.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = httpServer.address();
  assert.ok(address && typeof address === "object");
  config.publicBaseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/agent/v1/connect`;

  const recoveryEnrollment = manager.store.createEnrollment({
    name: "recovery-probe",
    allowedRoots: ["/home/ubuntu/workspace"],
    ttlMinutes: 15,
  });
  const firstRecovery = manager.store.consumeEnrollment(recoveryEnrollment.token, { hostname: "first-attempt" });
  const secondRecovery = manager.store.consumeEnrollment(recoveryEnrollment.token, { hostname: "retry-attempt" });
  assert.equal(secondRecovery.agentId, firstRecovery.agentId);
  assert.notEqual(secondRecovery.agentSecret, firstRecovery.agentSecret);
  assert.equal(secondRecovery.recovered, true);
  assert.equal(manager.store.authenticate(secondRecovery.agentId, secondRecovery.agentSecret)?.id, secondRecovery.agentId);
  assert.equal(manager.store.authenticate(firstRecovery.agentId, firstRecovery.agentSecret), undefined);
  assert.equal(manager.store.confirmEnrollment(secondRecovery.agentId), true);
  assert.throws(() => manager.store.consumeEnrollment(recoveryEnrollment.token, {}), /invalid/i);
  const repairEnrollment = manager.store.createEnrollment({
    agentId: secondRecovery.agentId,
    name: "recovery-probe",
    allowedRoots: ["/home/ubuntu/workspace"],
    ttlMinutes: 15,
  });
  assert.equal(repairEnrollment.repair, true);
  assert.equal(repairEnrollment.agentId, secondRecovery.agentId);
  const repairedRecovery = manager.store.consumeEnrollment(repairEnrollment.token, { hostname: "repair-attempt" });
  assert.equal(repairedRecovery.agentId, secondRecovery.agentId);
  assert.equal(repairedRecovery.repaired, true);
  assert.equal(repairedRecovery.recovered, true);
  assert.equal(manager.store.authenticate(secondRecovery.agentId, secondRecovery.agentSecret), undefined);
  assert.equal(manager.store.authenticate(repairedRecovery.agentId, repairedRecovery.agentSecret)?.id, repairedRecovery.agentId);
  assert.equal(manager.store.confirmEnrollment(repairedRecovery.agentId), true);
  manager.store.delete(repairedRecovery.agentId);

  const enrollment = manager.store.createEnrollment({
    name: "gpu-01",
    allowedRoots: ["/home/ubuntu/workspace"],
    ttlMinutes: 15,
  });
  const files = new Map([
    ["/home/ubuntu/workspace/project/tracked.txt", Buffer.from("before\n")],
    ["/home/ubuntu/workspace/project/large.bin", Buffer.alloc(1_400_000, 0x5a)],
  ]);
  agent = new FakeLinuxAgent(wsUrl, { enrollmentToken: enrollment.token }, files);
  const helloAck = await agent.connect();
  assert.match(helloAck.agentId, /^agent_/);
  assert.match(helloAck.agentSecret, /^dva_/);
  assert.deepEqual(helloAck.allowedRoots, ["/home/ubuntu/workspace"]);
  assert.equal(await waitFor(() => events.some((event) => event.kind === "remote.agent.enrollment_confirmed" && event.subject === helloAck.agentId)), true);
  assert.throws(() => manager.store.consumeEnrollment(enrollment.token, {}), /invalid/i);

  const listed = manager.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, "online");
  assert.equal(listed[0].hostname, "fake-linux-agent");

  const workspaces = new WorkspaceRegistry(config, workspaceStore, manager);
  const remoteUri = `devspace://${helloAck.agentId}/home/ubuntu/workspace/project`;
  const opened = await workspaces.openWorkspace({ path: remoteUri }, { conversationScopeId: "remote-conversation" });
  assert.equal(opened.workspace.backend, "remote-agent");
  assert.equal(opened.workspace.backendId, helloAck.agentId);
  assert.equal(opened.workspace.root, "/home/ubuntu/workspace/project");
  assert.equal(opened.agentsFiles[0].content, "Remote project instructions.\n");
  assert.throws(() => workspaces.resolvePath(opened.workspace, "../../etc/passwd"), /outside remote workspace root/i);

  const reused = await workspaces.openWorkspace({ path: remoteUri }, { conversationScopeId: "remote-conversation" });
  assert.equal(reused.workspace.id, opened.workspace.id);
  assert.equal(reused.workspaceReused, true);

  const restartedRegistry = new WorkspaceRegistry(config, workspaceStore, manager);
  const restoredWorkspace = restartedRegistry.getWorkspace(opened.workspace.id);
  assert.equal(restoredWorkspace.backend, "remote-agent");
  assert.equal(restoredWorkspace.backendId, helloAck.agentId);

  const largeRead = await manager.readWhole(opened.workspace, "large.bin");
  assert.equal(largeRead.length, 1_400_000);
  assert.equal(sha256(largeRead), sha256(files.get("/home/ubuntu/workspace/project/large.bin")));
  assert.ok((agent.requestCounts.get("fs.readChunk") ?? 0) >= 3);

  const replacement = Buffer.alloc(1_700_000, 0x31);
  await manager.writeBuffer(opened.workspace, "written.bin", replacement);
  assert.equal(sha256(files.get("/home/ubuntu/workspace/project/written.bin")), sha256(replacement));
  assert.ok((agent.requestCounts.get("fs.writeChunk") ?? 0) >= 4);

  const review = createReviewCheckpointManager({
    stateDir,
    sessionReviewEnabled: true,
    resolveIo: (workspaceId) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      return {
        kind: "remote-agent",
        root: workspace.root,
        backendId: workspace.backendId,
        resolvePath: (value) => workspaces.resolvePath(workspace, value),
        capture: (value) => manager.capture(workspace, value),
        restore: (value, descriptor, content) => manager.restore(workspace, value, descriptor, content),
      };
    },
  });
  await review.initializeWorkspace({ workspaceId: opened.workspace.id, root: opened.workspace.root });
  await review.beforeMutation({ workspaceId: opened.workspace.id, root: opened.workspace.root, paths: ["tracked.txt"] });
  await manager.writeBuffer(opened.workspace, "tracked.txt", Buffer.from("after\n"));
  await review.afterMutation({ workspaceId: opened.workspace.id, root: opened.workspace.root, paths: ["tracked.txt"], success: true });
  const sessionReview = await review.sessionReview({ workspaceId: opened.workspace.id, root: opened.workspace.root });
  assert.equal(sessionReview.summary.files, 1);
  assert.equal(sessionReview.canRollback, true);
  assert.equal(sessionReview.rollbackCoverage, "complete-for-tracked-paths");
  const rollback = await review.rollbackSession({
    workspaceId: opened.workspace.id,
    root: opened.workspace.root,
    confirmation: sessionReview.confirmationToken,
  });
  assert.equal(rollback.restored, 1);
  assert.equal(files.get("/home/ubuntu/workspace/project/tracked.txt").toString("utf8"), "before\n");
  assert.ok(rollback.safetySnapshot?.id);
  await manager.writeBuffer(opened.workspace, "tracked.txt", Buffer.from("after-rollback-edit\n"));
  const safetyRestore = await review.restoreSafetySnapshot({
    workspaceId: opened.workspace.id,
    root: opened.workspace.root,
    snapshotId: rollback.safetySnapshot.id,
    confirmation: `RESTORE ${rollback.safetySnapshot.id}`,
  });
  assert.equal(safetyRestore.restored, 1);
  assert.equal(files.get("/home/ubuntu/workspace/project/tracked.txt").toString("utf8"), "after\n");

  const systemStatus = await manager.rpc(helloAck.agentId, "system.status");
  assert.equal(systemStatus.gpus[0].name, "NVIDIA H200");
  assert.equal(systemStatus.gpus[0].utilizationPercent, "7");

  const packagedCli = await readFile(new URL("../app/node_modules/@waishnav/devspace/dist/cli.js", import.meta.url), "utf8");
  assert.match(packagedCli, /attachAgentHttpServer\(httpServer\)/, "formal devspace serve CLI must attach the remote-agent WebSocket upgrade handler");

  const firstConnection = agent.ws;
  await agent.close();
  assert.equal(await waitFor(() => !manager.connectedIds().has(helloAck.agentId)), true);
  const queuedWhileOffline = manager.rpc(helloAck.agentId, "system.status", {}, 5000, { reconnectGraceMs: 3000 });
  reconnectAgent = new FakeLinuxAgent(wsUrl, {
    agentId: helloAck.agentId,
    agentSecret: helloAck.agentSecret,
  }, files);
  setTimeout(() => { void reconnectAgent.connect(); }, 150).unref?.();
  const afterReconnect = await queuedWhileOffline;
  assert.equal(afterReconnect.hostname, "fake-linux-agent");
  assert.notEqual(reconnectAgent.ws, firstConnection);

  const ambiguousMutation = manager.rpc(helloAck.agentId, "test.disconnect", {}, 3000, { reconnectGraceMs: 3000 });
  await assert.rejects(ambiguousMutation, /disconnected|closed|reconnect/i);
  assert.equal(reconnectAgent.requestCounts.get("test.disconnect"), 1);
  assert.equal(await waitFor(() => !manager.connectedIds().has(helloAck.agentId)), true);

  manager.store.revoke(helloAck.agentId);
  assert.throws(() => manager.resolveAgent(helloAck.agentId, false), /revoked/i);
  assert.ok(events.some((event) => event.kind === "remote.agent.enrolled"));
  assert.ok(events.some((event) => event.kind === "remote.agent.enrollment_confirmed"));

console.log("DevSpace 1.1.45 Remote Workspace Backend end-to-end protocol tests passed.");
}
finally {
  await reconnectAgent?.close().catch(() => undefined);
  await agent?.close().catch(() => undefined);
  await manager.close().catch(() => undefined);
  await new Promise((resolvePromise) => httpServer.close(() => resolvePromise()));
  workspaceStore.close?.();
  await rm(CACHE_ROOT, { recursive: true, force: true });
}
