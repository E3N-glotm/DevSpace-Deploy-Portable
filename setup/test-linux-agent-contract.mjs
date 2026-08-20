import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_AGENT = join(ROOT, "vendor", "waishnav-devspace", "dist", "linux-agent", "devspace-agent.py");
const SOURCE_INSTALLER = join(ROOT, "vendor", "waishnav-devspace", "dist", "linux-agent", "install.sh");
const PACKAGED_AGENT = join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "linux-agent", "devspace-agent.py");
const PACKAGED_INSTALLER = join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "linux-agent", "install.sh");
const BUNDLED_BASH = join(ROOT, "runtime", "git", "bin", "bash.exe");

function resolveBash() {
  const candidates = [BUNDLED_BASH];
  if (process.env.GIT_BASH) candidates.push(process.env.GIT_BASH);
  if (process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, "Git", "bin", "bash.exe"));

  const where = spawnSync("where.exe", ["bash.exe"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (where.status === 0) {
    candidates.push(...String(where.stdout || "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean));
  }
  return candidates.find((candidate) => existsSync(candidate)) || "bash";
}

const BASH = resolveBash();

const agent = readFileSync(SOURCE_AGENT, "utf8");
const installer = readFileSync(SOURCE_INSTALLER, "utf8");
const remoteAgentStore = readFileSync(join(ROOT, "vendor", "waishnav-devspace", "dist", "remote-agent-store.js"), "utf8");

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
  /XDG_STATE_HOME/,
  /\.local\/state/,
  /LEGACY_STATE_DIR="\/var\/lib\/devspace-agent"/,
  /run_as_agent_user\(\)/,
  /PYTHON_BIN="\$\(command -v python3\)"/,
  /--agent-file\) AGENT_FILE=/,
  /--state-dir\) REQUESTED_STATE_DIR=/,
  /if \[\[ -n "\$AGENT_FILE" \]\]/,
  /--state-dir must be inside one of the selected --allowed-root paths/,
  /urllib\.request/,
  /hashlib\.sha256/,
  /A non-root install can only run as the current Linux user/,
  /Linux allowedRoot cannot be \/\./,
  /User=\$RUN_USER/,
  /NoNewPrivileges=true/,
  /ProtectSystem=strict/,
  /ProtectHome=read-only/,
  /ReadWritePaths=\$STATE_DIR/,
  /systemctl stop devspace-agent\.service/,
  /has_systemd\(\)/,
  /ps -p 1 -o comm=/,
  /start_background_agent\(\)/,
  /nohup '\$PYTHON_BIN'/,
  /PID_FILE="\$STATE_DIR\/agent\.pid"/,
  /LOG_FILE="\$STATE_DIR\/agent\.log"/,
  /systemd is not PID 1 on this host/,
]) {
  assert.match(installer, contract);
}
assert.doesNotMatch(installer, /curl is required/);
assert.doesNotMatch(installer, /sha256sum is required/);

const python = spawnSync("python", ["-c", [
  "import ast, pathlib, sys",
  "p=pathlib.Path(sys.argv[1])",
  "ast.parse(p.read_text(encoding='utf-8'))",
  "print('python-ast-ok')",
].join("; "), SOURCE_AGENT], { cwd: ROOT, encoding: "utf8" });
assert.equal(python.status, 0, python.stderr || python.stdout || "Python AST validation failed");
assert.match(python.stdout, /python-ast-ok/);

const bash = spawnSync(BASH, ["-n", SOURCE_INSTALLER], { cwd: ROOT, encoding: "utf8" });
assert.equal(
  bash.status,
  0,
  bash.error?.message || bash.stderr || bash.stdout || `install.sh syntax validation failed with ${BASH}`,
);

assert.match(remoteAgentStore, /\? `\( tmp=\$\(mktemp\);/);
assert.match(remoteAgentStore, /&& bash "\$tmp" --server/);
assert.match(remoteAgentStore, /--state-dir '\$\{stateDir\.replace/);
assert.match(remoteAgentStore, /const stateDir = `\$\{enrollment\.allowedRoots\[0\]/);
assert.match(remoteAgentStore, /const stateKey = enrollment\.agentId \|\| `enroll-\$\{sha256\(enrollment\.token\)\.slice\(0, 12\)\}`/);
assert.match(remoteAgentStore, /rm -f "\$tmp"; exit \$rc \)`/);
assert.match(remoteAgentStore, /requestedAgentId/);
assert.match(remoteAgentStore, /repaired: true/);
assert.match(remoteAgentStore, /serverUrl: base \|\| undefined/);
assert.doesNotMatch(remoteAgentStore, /\? `tmp=\$\(mktemp\);[^`]+exit \$rc`/);
assert.doesNotMatch(remoteAgentStore, /sudo bash "\$tmp"/);

const packagedRemoteAgentStore = join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "remote-agent-store.js");
const { remoteAgentAdmin } = await import(`${pathToFileURL(packagedRemoteAgentStore).href}?contract=${Date.now()}`);
const stateDir = mkdtempSync(join(tmpdir(), "devspace-agent-contract-"));
try {
  const first = remoteAgentAdmin({
    stateDir,
    action: "create-enrollment",
    payload: { name: "shared-server", allowedRoots: ["/home/ubuntu"], ttlMinutes: 15 },
    publicBaseUrl: "https://example.invalid",
  });
  const second = remoteAgentAdmin({
    stateDir,
    action: "create-enrollment",
    payload: { name: "shared-server", allowedRoots: ["/home/ubuntu"], ttlMinutes: 15 },
    publicBaseUrl: "https://example.invalid",
  });
  assert.match(first.stateDir, /^\/home\/ubuntu\/\.devspace-agent\/enroll-[0-9a-f]{12}$/);
  assert.match(second.stateDir, /^\/home\/ubuntu\/\.devspace-agent\/enroll-[0-9a-f]{12}$/);
  assert.notEqual(first.stateDir, second.stateDir, "two users/enrollments sharing one allowedRoot must not share Agent state");
  assert.match(first.installCommand, /--state-dir '\/home\/ubuntu\/\.devspace-agent\/enroll-[0-9a-f]{12}'/);
  assert.doesNotMatch(first.installCommand, /sudo\s+bash/);
}
finally {
  rmSync(stateDir, { recursive: true, force: true });
}

console.log(JSON.stringify({
  linuxAgentSourceMatchesInstalledCore: true,
  pythonSyntax: true,
  installerSyntax: true,
  passwordlessUserInstall: true,
  installerAndAgentHashChain: true,
  sshOfflineAgentFileInstall: true,
  selectedAllowedRootStateDir: true,
  multiInstanceStateDirectoryIsolation: true,
  installerDoesNotRequireCurl: true,
  repairEnrollmentPreservesAgentIdentity: true,
  recoverableEnrollmentRetry: true,
  websocketCloseDiagnostics: true,
  nonSystemdBackgroundFallback: true,
  legacyWritableStateReuse: true,
  generatedInstallCommandRequiresSudo: false,
  installCommandKeepsInteractiveShellOpen: true,
  boundedRpcAndResources: true,
  allowedRootAndSymlinkGuard: true,
}));
