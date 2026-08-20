import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ui = readFileSync(join(root, "setup", "native", "DevSpacePortableApp.cs"), "utf8");
const askPassSource = readFileSync(join(root, "setup", "native", "DevSpaceSshAskPass.cs"), "utf8");
const build = readFileSync(join(root, "setup", "build-native-ui.cjs"), "utf8");
const askPassExe = join(root, "DevSpace-SshAskPass.exe");

assert.match(ui, /ProtectedData\.Protect/);
assert.match(ui, /DataProtectionScope\.CurrentUser/);
assert.match(ui, /SSH_ASKPASS/);
assert.match(ui, /SSH_ASKPASS_REQUIRE/);
assert.match(ui, /DEVSPACE_SSH_PASSWORD/);
assert.match(ui, /StrictHostKeyChecking=accept-new/);
assert.match(ui, /ExistingAgentRecoveryScript/);
assert.match(ui, /DEVSPACE_AGENT_NOT_INSTALLED/);
assert.match(ui, /systemctl --user restart devspace-agent\.service/);
assert.match(ui, /sudo -n systemctl restart devspace-agent\.service/);
assert.match(ui, /nohup .*devspace-agent\.py/);
assert.match(ui, /AutoRecoverConfiguredAgentsAsync/);
assert.match(ui, /TimeSpan\.FromMinutes\(2\)/);
assert.match(ui, /remote-agent-create-enrollment/);
assert.match(ui, /installCommand/);
assert.match(ui, /BuildOfflineSshInstallScript/);
assert.match(ui, /--agent-file/);
assert.match(ui, /base64\.b64decode/);
assert.match(ui, /AgentBundlePath\(manager, "install\.sh"\)/);
assert.match(ui, /AgentBundlePath\(manager, "devspace-agent\.py"\)/);
assert.match(ui, /agentId = agentId \?\? ""/);
assert.match(ui, /heartbeat 未恢复；正在通过本机 SSH 修复 endpoint\/凭据并重新登记原 Agent/);
assert.match(ui, /_sshAutoRecover\.Checked = true/);
assert.match(ui, /NormalizeSshScriptForBash/);
assert.match(ui, /Replace\("\\r\\n", "\\n"\)\.Replace\("\\r", "\\n"\)/);
assert.match(ui, /process\.StandardInput\.NewLine = "\\n"/);
assert.doesNotMatch(ui, /process\.StandardInput\.WriteLine\(\)/);
assert.doesNotMatch(ui, /-pw\s/);
assert.doesNotMatch(ui, /password\s*=\s*[^;]+Arguments/);

assert.match(askPassSource, /Environment\.GetEnvironmentVariable\("DEVSPACE_SSH_PASSWORD"\)/);
assert.doesNotMatch(askPassSource, /File\.Read|Console\.Error|password=/i);
assert.match(build, /DevSpaceSshAskPass\.cs/);
assert.match(build, /DevSpace-SshAskPass\.exe/);
assert.ok(existsSync(askPassExe), "native SSH askpass helper was not built");

const sentinel = "devspace-askpass-contract-secret";
const helper = spawnSync(askPassExe, [], {
  cwd: root,
  encoding: "utf8",
  windowsHide: true,
  env: { ...process.env, DEVSPACE_SSH_PASSWORD: sentinel },
});
assert.equal(helper.status, 0, helper.stderr || "SSH askpass helper failed");
assert.equal(helper.stdout, sentinel);

console.log(JSON.stringify({
  dpapiCurrentUser: true,
  passwordOnlyInChildEnvironment: true,
  askPassHelper: true,
  existingAgentRestartFirst: true,
  systemdAndNohupRecovery: true,
  enrollmentInstallFallback: true,
  localSshInstallerPayload: true,
  repairEnrollmentAfterHeartbeatFailure: true,
  autoRecoveryDefaultEnabled: true,
  backgroundRecoveryBackoff: true,
  posixLfShellTransport: true,
  manualInstallFallbackPreserved: true,
}));
