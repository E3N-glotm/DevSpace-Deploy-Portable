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
  console.log(JSON.stringify({
    strictStop: true,
    orphanPid: pid,
    unrelatedDescendantPreserved: true,
    externalPid,
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
  await rm(temporary, { recursive: true, force: true });
}
