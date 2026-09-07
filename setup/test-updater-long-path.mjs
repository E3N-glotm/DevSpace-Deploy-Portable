import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const updater = join(root, "setup", "portable-updater.ps1");
const result = spawnSync(powershell, [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy", "Bypass",
  "-File", updater,
  "-Action", "SelfTestLongPath",
  "-Root", root,
  "-CurrentVersion", "1.1.59",
], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 120_000 });

assert.equal(result.status, 0, result.stderr || result.stdout);
const report = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
assert.equal(report.success, true);
assert.equal(report.longPath, true, `test path was not longer than MAX_PATH: ${report.pathLength}`);
assert.ok(report.pathLength > 260);

console.log(JSON.stringify({
  updaterLongPathExtraction: true,
  pathLength: report.pathLength,
}, null, 2));
