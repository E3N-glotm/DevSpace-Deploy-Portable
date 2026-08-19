import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_AGENT = join(ROOT, "vendor", "waishnav-devspace", "dist", "linux-agent", "devspace-agent.py");
const SOURCE_INSTALLER = join(ROOT, "vendor", "waishnav-devspace", "dist", "linux-agent", "install.sh");
const PACKAGED_AGENT = join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "linux-agent", "devspace-agent.py");
const PACKAGED_INSTALLER = join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "linux-agent", "install.sh");
const BASH = join(ROOT, "runtime", "git", "bin", "bash.exe");

const agent = readFileSync(SOURCE_AGENT, "utf8");
const installer = readFileSync(SOURCE_INSTALLER, "utf8");

assert.equal(readFileSync(PACKAGED_AGENT, "utf8"), agent, "installed Portable Agent must match maintained source");
assert.equal(readFileSync(PACKAGED_INSTALLER, "utf8"), installer, "installed Portable installer must match maintained source");

for (const contract of [
  /AGENT_VERSION = "1\.0\.0"/,
  /MAX_MESSAGE_BYTES = 8 \* 1024 \* 1024/,
  /TRANSFER_CHUNK_BYTES = 512 \* 1024/,
  /MAX_WATCHES = 64/,
  /MAX_PROCESS_RECORDS = 500/,
  /MAX_LIVE_PROCESSES = 128/,
  /ENROLL_ATTEMPTS = 3/,
  /request_slots = threading\.BoundedSemaphore\(16\)/,
  /"agent\.selfUpdate": self\.agent_self_update/,
  /"system\.status": self\.system_status/,
  /"type": "enrollment_confirm"/,
  /WebSocket was closed by the server\{detail\}/,
  /self\.guard\.absolute\(root, resolved_link_target\)/,
]) {
  assert.match(agent, contract);
}

for (const contract of [
  /INSTALL_DIR="\$STATE_DIR\/bin"/,
  /Refusing to run the DevSpace Agent service as root/,
  /Linux allowedRoot cannot be \/\./,
  /sha256sum -c -/,
  /User=\$RUN_USER/,
  /NoNewPrivileges=true/,
  /ProtectSystem=strict/,
  /ProtectHome=read-only/,
  /ReadWritePaths=\$STATE_DIR/,
  /systemctl stop devspace-agent\.service/,
]) {
  assert.match(installer, contract);
}

const python = spawnSync("python", ["-c", [
  "import ast, pathlib, sys",
  "p=pathlib.Path(sys.argv[1])",
  "ast.parse(p.read_text(encoding='utf-8'))",
  "print('python-ast-ok')",
].join("; "), SOURCE_AGENT], { cwd: ROOT, encoding: "utf8" });
assert.equal(python.status, 0, python.stderr || python.stdout || "Python AST validation failed");
assert.match(python.stdout, /python-ast-ok/);

const bash = spawnSync(BASH, ["-n", SOURCE_INSTALLER], { cwd: ROOT, encoding: "utf8" });
assert.equal(bash.status, 0, bash.stderr || bash.stdout || "install.sh syntax validation failed");

console.log(JSON.stringify({
  linuxAgentSourceMatchesInstalledCore: true,
  pythonSyntax: true,
  installerSyntax: true,
  ordinaryUserService: true,
  installerAndAgentHashChain: true,
  recoverableEnrollmentRetry: true,
  websocketCloseDiagnostics: true,
  boundedRpcAndResources: true,
  allowedRootAndSymlinkGuard: true,
}));
