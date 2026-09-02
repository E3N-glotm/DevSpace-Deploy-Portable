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
assert.match(ui, /bool createNew = _creatingNewAgent \|\| string\.IsNullOrWhiteSpace\(agentId\)/);
assert.match(ui, /if \(createNew\)[\s\S]*?CreateSshEnrollmentAsync\(_manager, "", agentName[\s\S]*?InstallEnrollmentViaLocalSshAsync\(newEnrollment, agentName, roots\)/);
assert.match(ui, /新的 Remote Workspace Agent 已部署并上线。未修改原有服务器配置。/);
assert.match(ui, /if \(silent && !createNew\)[\s\S]*?ExistingAgentRecoveryScript\(agentId, selectedRoots, selectedInstallRoot\)/,
  "background recovery must keep restart-first semantics on the last persisted Agent configuration");
assert.match(ui, /bool fullAccess = _fullAccess\.Checked/,
  "explicit update must use the current Full Access editor state");
assert.match(ui, /string\[\] editedRoots = _roots\.Lines[\s\S]*?string\[\] roots = fullAccess \? new string\[0\] : editedRoots/,
  "explicit update must use the current writable-root editor instead of the stored Agent roots");
assert.match(ui, /ResolveAgentInstallRootViaSshAsync\(requestedInstallRoot, fullAccess\)/,
  "explicit update must resolve the current install root against the remote host");
assert.match(ui, /ExistingAgentStateProbeScript\(agentId, selectedRoots, selectedInstallRoot\)/,
  "explicit update must locate the old state using persisted coordinates before applying the edited coordinates");
assert.match(ui, /if \(!string\.IsNullOrWhiteSpace\(existingState\)\)[\s\S]{0,900}?StopBackgroundAgentStateScript\(existingState\)/,
  "every explicit existing-Agent update must stop the old state before applying edited configuration, even when the install root does not move");
assert.match(ui, /state_pids=\$\(""\$python_bin"" - ""\$state""[\s\S]{0,1800}?exact_agent = agent_bin in args and config in args[\s\S]{0,500}?exact_state_arg/,
  "old-state cleanup must discover every process that references the exact stale Agent binary/config or exact --state-dir, not only the pid file");
assert.match(ui, /for pid in \$state_pids; do kill ""\$pid""[\s\S]{0,900}?kill -KILL ""\$pid""/,
  "old-state cleanup must terminate all exact stale-state processes and escalate only those exact pids when needed");
assert.match(ui, /systemctl --user cat devspace-agent\.service[\s\S]{0,300}?grep -F -- ""\$state\/""[\s\S]{0,300}?systemctl --user stop devspace-agent\.service/,
  "old-state cleanup may stop a user service only when its unit text references the exact stale state");
assert.doesNotMatch(ui, /pkill|killall/,
  "Agent cleanup must never broad-kill unrelated Agent processes");
assert.match(ui, /CreateSshEnrollmentAsync\([\s\S]{0,120}?_manager,[\s\S]{0,120}?agentId,[\s\S]{0,120}?agentName,[\s\S]{0,120}?roots,[\s\S]{0,120}?installRoot,[\s\S]{0,120}?accessMode\)/,
  "existing Agent updates must repair/re-enroll the same agentId with current editor values");
assert.match(ui, /Full Access Agent state root is not writable/);
assert.match(ui, /\$\{XDG_STATE_HOME:-\$HOME\/\.local\/state\}/,
  "Full Access must fall back to the SSH user's state directory when the requested install root is absent");
assert.doesNotMatch(ui, /roots != null && roots\.Length > 0 \? roots\[0\] : "\/home\/ubuntu\/workspace"/,
  "Full Access enrollment must not hardcode /home/ubuntu/workspace when roots are empty");
assert.match(ui, /Remote Workspace Agent 已更新并重新上线；Full Access 已生效，Writable Roots 限制已清空。/);
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
  explicitAgentUpdateUsesEditor: true,
  sameAgentRepairEnrollment: true,
  fullAccessInstallRootFallback: true,
  oldStateStoppedOnEveryExplicitUpdate: true,
  allExactOldStateProcessesStopped: true,
  systemdAndNohupRecovery: true,
  enrollmentInstallFallback: true,
  localSshInstallerPayload: true,
  repairEnrollmentAfterHeartbeatFailure: true,
  autoRecoveryDefaultEnabled: true,
  backgroundRecoveryBackoff: true,
  posixLfShellTransport: true,
  manualInstallFallbackPreserved: true,
}));
