import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const setupDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(setupDir, "..");
const sourceManager = join(setupDir, "portable-manager.cjs");
const temporary = await mkdtemp(join(tmpdir(), "devspace-strict-stop-"));
// Run the destructive stop test from a disposable Portable root. Running the
// real worktree manager would make ROOT point at the active source checkout and
// can terminate unrelated DevSpace test/tool processes that happen to belong to
// that checkout. The sandbox keeps process ownership strictly local to this test.
const root = join(temporary, "portable");
const sandboxSetupDir = join(root, "setup");
const sandboxNodeDir = join(root, "runtime", "node");
const manager = join(sandboxSetupDir, "portable-manager.cjs");
const sandboxNode = join(sandboxNodeDir, "node.exe");
const configDir = join(root, "data", "config");
const stateDir = join(root, "data", "state");
const runDir = join(root, "data", "run");
const pidFile = join(temporary, "orphan.pid");
const externalPidFile = join(temporary, "external.pid");
const localServicePidFile = join(temporary, "local-service.pid");
const localExternalPidFile = join(temporary, "local-external.pid");
const localReadyFile = join(temporary, "local-ready.txt");
const pingExe = join(process.env.SystemRoot || "C:\\Windows", "System32", "PING.EXE");
const childCode = [
  "const cp=require('child_process'),fs=require('fs');",
  `const external=cp.spawn(${JSON.stringify(pingExe)},['-t','127.0.0.1'],{detached:true,windowsHide:true,stdio:'ignore'});`,
  `fs.writeFileSync(${JSON.stringify(externalPidFile)},String(external.pid));`,
  "external.unref();",
  "setInterval(()=>{},1000);",
].join("");
const launcherCode = [
  "const cp=require('child_process'),fs=require('fs');",
  `const child=cp.spawn(process.execPath,['-e',${JSON.stringify(childCode)},${JSON.stringify(root)}],{cwd:${JSON.stringify(root)},detached:true,windowsHide:true,stdio:'ignore'});`,
  `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));`,
  "child.unref();",
].join("");

function processExists(pid) {
  const result = spawnSync("tasklist.exe", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return String(result.stdout || "").includes(`\"${pid}\"`);
}

function listenerExists(port) {
  const result = spawnSync("netstat.exe", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const pattern = new RegExp(`\\b127\\.0\\.0\\.1:${port}\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+\\d+\\b`, "i");
  return pattern.test(String(result.stdout || ""));
}

try {
  await mkdir(sandboxSetupDir, { recursive: true });
  await mkdir(sandboxNodeDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(runDir, { recursive: true });
  await copyFile(sourceManager, manager);
  await copyFile(process.execPath, sandboxNode);
  await writeFile(join(configDir, "deployment.json"), JSON.stringify({ port: 17689, tunnelProvider: "ngrok" }), "utf8");
  const launched = spawnSync(sandboxNode, ["-e", launcherCode], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(launched.status, 0, launched.stderr);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  for (let attempt = 0; attempt < 30 && !existsSync(externalPidFile); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(existsSync(externalPidFile), true, "owned test process did not start its external descendant");
  const externalPid = Number((await readFile(externalPidFile, "utf8")).trim());
  assert.ok(Number.isInteger(externalPid) && externalPid > 0);
  assert.equal(processExists(pid), true, `orphan test process ${pid} did not start`);
  assert.equal(processExists(externalPid), true, `external descendant ${externalPid} did not start`);

  const stopped = spawnSync(sandboxNode, [manager, "stop"], {
    cwd: root,
    env: {
      ...process.env,
      DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
      DEVSPACE_PORTABLE_STATE_DIR: stateDir,
      DEVSPACE_PORTABLE_RUN_DIR: runDir,
      DEVSPACE_STOP_EXCLUDE_PID: String(process.pid),
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  assert.match(stopped.stdout, /No background service PID remains/);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  assert.equal(processExists(pid), false, `Portable-owned orphan process ${pid} survived stop`);
  assert.equal(
    processExists(externalPid),
    true,
    `Unrelated external descendant ${externalPid} was recursively terminated by Portable stop`,
  );

  // Reproduce the real Task Scheduler orphan case: the actual cli.js serve
  // listener survives but its recorded PID file is missing/stale. stop-local
  // must discover the Portable MCP service by command-line signature and the
  // real listener, without recursively killing unrelated user descendants.
  const localCliPath = join(root, "app", "node_modules", "@waishnav", "devspace", "dist", "cli.js");
  const localServiceCode = [
    "const cp=require('child_process'),fs=require('fs'),net=require('net');",
    `const external=cp.spawn(${JSON.stringify(pingExe)},['-t','127.0.0.1'],{detached:true,windowsHide:true,stdio:'ignore'});`,
    `fs.writeFileSync(${JSON.stringify(localExternalPidFile)},String(external.pid));`,
    "external.unref();",
    `fs.writeFileSync(${JSON.stringify(localServicePidFile)},String(process.pid));`,
    "const server=net.createServer(()=>{});",
    `server.listen(17689,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(localReadyFile)},'ready'));`,
    "setInterval(()=>{},1000);",
  ].join("");
  const localLauncherCode = [
    "const cp=require('child_process');",
    `const child=cp.spawn(process.execPath,['-e',${JSON.stringify(localServiceCode)},${JSON.stringify(localCliPath)},'serve'],{cwd:${JSON.stringify(root)},detached:true,windowsHide:true,stdio:'ignore'});`,
    "child.unref();",
  ].join("");
  const localLaunched = spawnSync(sandboxNode, ["-e", localLauncherCode], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(localLaunched.status, 0, localLaunched.stderr);
  for (let attempt = 0; attempt < 50 && !existsSync(localReadyFile); attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(existsSync(localReadyFile), true, "orphan local MCP listener did not become ready");
  const localServicePid = Number((await readFile(localServicePidFile, "utf8")).trim());
  const localExternalPid = Number((await readFile(localExternalPidFile, "utf8")).trim());
  assert.equal(processExists(localServicePid), true, `orphan local MCP process ${localServicePid} did not start`);
  assert.equal(processExists(localExternalPid), true, `local unrelated descendant ${localExternalPid} did not start`);
  assert.equal(listenerExists(17689), true, "orphan local MCP process did not own the expected test listener");
  assert.equal(existsSync(join(runDir, "devspace.pid")), false,
    "stop-local orphan regression requires the recorded MCP PID file to be absent");

  const localStopped = spawnSync(sandboxNode, [manager, "stop-local"], {
    cwd: root,
    env: {
      ...process.env,
      DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
      DEVSPACE_PORTABLE_STATE_DIR: stateDir,
      DEVSPACE_PORTABLE_RUN_DIR: runDir,
      DEVSPACE_STOP_EXCLUDE_PID: String(process.pid),
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  assert.equal(localStopped.status, 0, `${localStopped.stdout}\n${localStopped.stderr}`);
  assert.match(localStopped.stdout, /Local MCP service stopped/);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  assert.equal(processExists(localServicePid), false,
    `stop-local left orphan MCP service PID ${localServicePid} alive without a PID file`);
  assert.equal(listenerExists(17689), false,
    "stop-local reported success while the orphan MCP listener still occupied the configured port");
  assert.equal(processExists(localExternalPid), true,
    `stop-local recursively killed unrelated descendant ${localExternalPid}`);

  console.log(JSON.stringify({
    strictStop: true,
    orphanPid: pid,
    unrelatedDescendantPreserved: true,
    externalPid,
    stopLocalOrphanRecovery: true,
    localServicePid,
    localExternalDescendantPreserved: true,
    localExternalPid,
    output: stopped.stdout.trim(),
  }));
}
finally {
  if (existsSync(pidFile)) {
    const pid = Number((await readFile(pidFile, "utf8").catch(() => "0")).trim());
    if (Number.isInteger(pid) && pid > 0 && processExists(pid)) {
      spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    }
  }
  if (existsSync(externalPidFile)) {
    const externalPid = Number((await readFile(externalPidFile, "utf8").catch(() => "0")).trim());
    if (Number.isInteger(externalPid) && externalPid > 0 && processExists(externalPid)) {
      spawnSync("taskkill.exe", ["/pid", String(externalPid), "/f"], { windowsHide: true });
    }
  }
  if (existsSync(localServicePidFile)) {
    const localServicePid = Number((await readFile(localServicePidFile, "utf8").catch(() => "0")).trim());
    if (Number.isInteger(localServicePid) && localServicePid > 0 && processExists(localServicePid)) {
      spawnSync("taskkill.exe", ["/pid", String(localServicePid), "/f"], { windowsHide: true });
    }
  }
  if (existsSync(localExternalPidFile)) {
    const localExternalPid = Number((await readFile(localExternalPidFile, "utf8").catch(() => "0")).trim());
    if (Number.isInteger(localExternalPid) && localExternalPid > 0 && processExists(localExternalPid)) {
      spawnSync("taskkill.exe", ["/pid", String(localExternalPid), "/f"], { windowsHide: true });
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
