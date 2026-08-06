import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const setupDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(setupDir, "..");
const manager = join(setupDir, "portable-manager.cjs");
const temporary = await mkdtemp(join(tmpdir(), "devspace-strict-stop-"));
const configDir = join(temporary, "config");
const stateDir = join(temporary, "state");
const pidFile = join(temporary, "orphan.pid");
const childCode = "setInterval(()=>{},1000)";
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
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(configDir, "deployment.json"), JSON.stringify({ port: 17689, tunnelProvider: "ngrok" }), "utf8");
  const launched = spawnSync(process.execPath, ["-e", launcherCode], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(launched.status, 0, launched.stderr);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  assert.equal(processExists(pid), true, `orphan test process ${pid} did not start`);

  const stopped = spawnSync(process.execPath, [manager, "stop"], {
    cwd: root,
    env: {
      ...process.env,
      DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
      DEVSPACE_PORTABLE_STATE_DIR: stateDir,
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
  console.log(JSON.stringify({ strictStop: true, orphanPid: pid, output: stopped.stdout.trim() }));
}
finally {
  if (existsSync(pidFile)) {
    const pid = Number((await readFile(pidFile, "utf8").catch(() => "0")).trim());
    if (Number.isInteger(pid) && pid > 0 && processExists(pid)) {
      spawnSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    }
  }
  await rm(temporary, { recursive: true, force: true });
}
