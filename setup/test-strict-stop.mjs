import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const setupDir = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(setupDir, "..");
const sourceManager = join(setupDir, "portable-manager.cjs");
const sourceManagerText = await readFile(sourceManager, "utf8");
assert.match(sourceManagerText, /function invokedFromLocalMcpServiceTree\(\)/,
  "restart-local must detect whether it is running inside the MCP service process tree");
assert.match(sourceManagerText, /DevSpace Portable Local Restart /,
  "self-restart must use a distinct one-shot Task Scheduler controller");
assert.match(sourceManagerText, /restart-local-worker/,
  "the one-shot controller must enter a dedicated restart worker command");
assert.match(sourceManagerText, /publicTunnelTouched:\s*false/,
  "local restart controller state must explicitly preserve the public tunnel");
const restartAckIndex = sourceManagerText.indexOf('status: "acknowledged"');
const restartGraceIndex = sourceManagerText.indexOf("sleepSync(3_000);");
const restartStopIndex = sourceManagerText.indexOf("const stopped = stopLocalServiceOnly();");
assert.ok(restartAckIndex >= 0 && restartGraceIndex > restartAckIndex && restartStopIndex > restartGraceIndex,
  "restart worker must acknowledge before its flush grace and only then stop the MCP task tree");
assert.match(sourceManagerText,
  /if \(invokedFromLocalMcpServiceTree\(\)\)[\s\S]*scheduleLocalRestartController\(\)[\s\S]*else \{[\s\S]*stopLocalServiceOnly\(\);[\s\S]*startLocalOnly\(\)/,
  "restart-local must delegate only for MCP-internal callers and retain synchronous external semantics");
assert.match(sourceManagerText, /CreationTicks/,
  "Portable process snapshots must carry process creation identity so stale ParentProcessId values cannot invent ancestry after PID reuse");
assert.match(sourceManagerText, /canonicalRoot = fs\.realpathSync\.native\(ROOT\)/,
  "Portable ownership must resolve Windows short and long filesystem aliases to the same existing root");
assert.match(sourceManagerText, /\$root=\(\$?[^\r\n]+\)\.TrimEnd\('\\\\'\)/,
  "Portable ownership must preserve the literal absolute root before adding GetFullPath aliases");
assert.match(sourceManagerText, /\$roots=@\(\$root,\$canonicalRoot,\[IO\.Path\]::GetFullPath\(\$root\),\[IO\.Path\]::GetFullPath\(\$canonicalRoot\)\)/,
  "Path-normalized roots must supplement rather than replace original process-path spellings");
assert.match(sourceManagerText, /\$cliPaths=@\(\$roots \| ForEach-Object[\s\S]{0,2500}\$exactCli=\(\$name -eq 'node\.exe' -and \$cmd[\s\S]{0,150}\.IndexOf\(\$_,\[StringComparison\]::OrdinalIgnoreCase\)/,
  "Only exact root-scoped cli.js arguments may establish fallback ownership across 8.3 aliases");
assert.match(sourceManagerText, /return parent\.creationTicks <= child\.creationTicks/,
  "Portable stop ancestry must reject a reused parent PID whose current process started after the child");
assert.match(sourceManagerText, /const provenListenerPids = new Map\(\)[\s\S]{0,2200}byPid\.get\(pid\)[\s\S]{0,900}provenListenerPids\.set\(pid, creationTicks\)/,
  "stop-local must durably remember the exact identity of a listener already proven to belong to the Portable root");
assert.match(sourceManagerText, /const terminateExactServiceInstance = \(pid, expectedCreationTicks = 0, freshOwnershipProof = false\)[\s\S]{0,1000}processCreationTicks\(pid\)[\s\S]{0,1000}taskkill\.exe/,
  "the central listener termination helper must compare process creation identities before directly killing the service");
assert.match(sourceManagerText, /portDrainDeadline[\s\S]{0,1800}provenListenerPids\.get\(pid\)[\s\S]{0,800}terminateExactServiceInstance\(pid, expectedCreationTicks\)/,
  "the port-drain phase must keep terminating only the exact previously-proven listener identity instead of merely extending a timeout");
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

function processStartTicks(pid) {
  const powershell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  const command = [
    // Match the production manager's Win32_Process.CreationDate identity.
    // Get-Process.StartTime may differ in tick precision/rounding, causing a
    // still-running owned child to be misclassified as a recycled PID.
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue`,
    "if(-not $p){exit 0}",
    "try{$p.CreationDate.ToUniversalTime().Ticks}catch{''}",
  ].join(";");
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  return String(result.stdout || "").trim();
}

function portableOwnedBySnapshot(pid, portableRoot, expectedStartTicks = "") {
  const powershell = join(
    process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
  );
  const escapedRoot = String(resolve(portableRoot)).replaceAll("'", "''");
  const expectedTicks = /^\d+$/.test(String(expectedStartTicks || ""))
    ? String(expectedStartTicks)
    : "";
  const command = [
    `$root='${escapedRoot}'`,
    `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${Number(pid)}\" -ErrorAction SilentlyContinue`,
    "if(-not $p){exit 0}",
    "if([int]$p.ProcessId -eq $PID){exit 0}",
    ...(expectedTicks ? [
      "try{$ticks=$p.CreationDate.ToUniversalTime().Ticks}catch{$ticks=0}",
      `if([string]$ticks -ne '${expectedTicks}'){exit 0}`,
    ] : []),
    "$exe=[string]$p.ExecutablePath",
    "$cmd=[string]$p.CommandLine",
    "if(($exe -and $exe.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) -or ($cmd -and $cmd.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0)){'owned'}",
  ].join(";");
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
  });
  return String(result.stdout || "").trim() === "owned";
}

function managerRecognizesFixture(pid) {
  // Ask the *same* ownership enumerator used by stop(), rather than relying
  // on the deliberately broader stand-alone fixture predicate. In particular,
  // command-line root matches alone do not establish ownership of node.exe.
  const probe = spawnSync(sandboxNode, [manager, "portable-processes"], {
    cwd: root,
    env: {
      ...process.env,
      DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
      DEVSPACE_PORTABLE_STATE_DIR: stateDir,
      DEVSPACE_PORTABLE_RUN_DIR: runDir,
    },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(probe.status, 0, `Portable ownership probe failed (exit=${probe.status})`);
  const reported = JSON.parse(probe.stdout);
  const matches = (reported.processes || []).filter((item) => item.pid === pid);
  return { recognized: matches.length === 1, rootAlias: matches[0]?.executablePath || "" };
}

function diagnoseFixtureOwnership(pid) {
  // Emit only structural evidence. Never print the full command line, which
  // could contain unrelated credentials on a shared CI or developer machine.
  const powershell = join(process.env.SystemRoot || "C:\\Windows",
    "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const cmd = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' -ErrorAction SilentlyContinue; if($p){$bulk=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${Number(pid)} }); [pscustomobject]@{Name=$p.Name;ExecutablePath=$p.ExecutablePath;CommandLine=$p.CommandLine;BulkVisible=($bulk.Count -eq 1);BulkExecutablePopulated=([bool]$bulk[0].ExecutablePath);BulkCommandPopulated=([bool]$bulk[0].CommandLine);BulkExecutableEqualsTarget=([string]$bulk[0].ExecutablePath -eq [string]$p.ExecutablePath);BulkCommandEqualsTarget=([string]$bulk[0].CommandLine -eq [string]$p.CommandLine)} | ConvertTo-Json -Compress}`;
  const probe = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  if (probe.status !== 0 || !String(probe.stdout || "").trim()) {
    return { cimReadable: false, exitCode: probe.status };
  }
  const item = JSON.parse(probe.stdout);
  const norm = (value) => String(value || "").replaceAll("\\", "/").toLowerCase();
  const exe = norm(item.ExecutablePath);
  const args = norm(item.CommandLine);
  const portableRoot = norm(root);
  const sandboxExecutable = norm(sandboxNode);
  const psRoot = `'${String(root).replaceAll("'", "''")}'`;
  const exactPredicate = [
    `$root=[IO.Path]::GetFullPath(${psRoot}).TrimEnd('\\')`,
    "$roots=@($root) | Select-Object -Unique",
    `$p=@(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine) | Where-Object { $_.ProcessId -eq ${Number(pid)} } | Select-Object -First 1`,
    "$exe=[string]$p.ExecutablePath",
    "$cmd=[string]$p.CommandLine",
    "$name=([string]$p.Name).ToLowerInvariant()",
    "$processId=[int]$p.ProcessId",
    "$ownedExe=($exe -and @($roots | Where-Object {$exe.StartsWith(($_+'\\'),[StringComparison]::OrdinalIgnoreCase)}).Count -gt 0)",
    "$candidate=($name -eq 'node.exe' -and $exe -and $exe.EndsWith('\\runtime\\node\\node.exe',[StringComparison]::OrdinalIgnoreCase) -and $cmd -and @($roots | Where-Object {$cmd.IndexOf(($_+'\\'),[StringComparison]::OrdinalIgnoreCase) -ge 0}).Count -gt 0)",
    "[pscustomobject]@{RootMatchesExecutable=$exe.StartsWith(($root+'\\'),[StringComparison]::OrdinalIgnoreCase);RootMatchesCommand=($cmd.IndexOf(($root+'\\'),[StringComparison]::OrdinalIgnoreCase) -ge 0);OwnedExe=[bool]$ownedExe;AliasCandidate=[bool]$candidate;SelfExcluded=($processId -eq $PID);RootLength=$root.Length} | ConvertTo-Json -Compress",
  ].join(";");
  const predicateProbe = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", exactPredicate], {
    encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  let predicateEvidence = { available: false, exitCode: predicateProbe.status };
  if (predicateProbe.status === 0 && String(predicateProbe.stdout || "").trim()) {
    predicateEvidence = JSON.parse(predicateProbe.stdout);
  }
  let actualIdentity = null;
  let expectedIdentity = null;
  try { actualIdentity = statSync(item.ExecutablePath, { bigint: true }); } catch {}
  try { expectedIdentity = statSync(sandboxNode, { bigint: true }); } catch {}
  return {
    cimReadable: true,
    bulkEnumerationVisible: Boolean(item.BulkVisible),
    bulkExecutablePopulated: Boolean(item.BulkExecutablePopulated),
    bulkCommandPopulated: Boolean(item.BulkCommandPopulated),
    bulkExecutableEqualsTarget: Boolean(item.BulkExecutableEqualsTarget),
    bulkCommandEqualsTarget: Boolean(item.BulkCommandEqualsTarget),
    processName: String(item.Name || ""),
    executableInsideRoot: exe.startsWith(`${portableRoot}/`),
    executableMatchesLiteralSandboxPath: exe === sandboxExecutable,
    executableEndsWithBundledRuntime: exe.endsWith("/runtime/node/node.exe"),
    commandMentionsRoot: args.includes(`${portableRoot}/`),
    commandMentionsExactCli: args.includes(`${portableRoot}/app/node_modules/@waishnav/devspace/dist/cli.js`),
    expectedFileIdAvailable: Boolean(expectedIdentity && expectedIdentity.ino !== 0n),
    actualFileIdAvailable: Boolean(actualIdentity && actualIdentity.ino !== 0n),
    sameRuntimeFile: Boolean(actualIdentity && expectedIdentity
      && actualIdentity.ino !== 0n && actualIdentity.dev === expectedIdentity.dev
      && actualIdentity.ino === expectedIdentity.ino),
    powershellPredicate: predicateEvidence,
    literalRootLength: String(root).length,
    literalRootMatchesPredicateLength: String(root).length === Number(predicateEvidence.RootLength),
  };
}


function listenerExists(port) {
  const result = spawnSync("netstat.exe", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const pattern = new RegExp(`\\b127\\.0\\.0\\.1:${port}\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+\\d+\\b`, "i");
  return pattern.test(String(result.stdout || ""));
}

function portBindable(port) {
  const code = [
    "const net=require('net');",
    "const s=net.createServer();",
    "s.once('error',()=>process.exit(2));",
    `s.listen(${Number(port)},'127.0.0.1',()=>s.close(()=>process.exit(0)));`,
    "setTimeout(()=>process.exit(3),3000).unref();",
  ].join("");
  const result = spawnSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  return result.status === 0;
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
  const orphanStartTicks = processStartTicks(pid);
  const externalStartTicks = processStartTicks(externalPid);
  assert.ok(orphanStartTicks, `orphan test process ${pid} has no stable start identity`);
  assert.ok(externalStartTicks, `external descendant ${externalPid} has no stable start identity`);
  // Process existence and a Get-Process StartTime do not establish that the
  // detached child is already visible to the CIM ownership enumerator used by
  // stopPortableOwnedProcesses(). Hosted Windows can publish those observations
  // in different orders. Do not race stop against a fixture it cannot yet see:
  // this test must start from a proven Portable-owned process, not merely a PID.
  let ownershipReady = false;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (portableOwnedBySnapshot(pid, root, orphanStartTicks)) {
      ownershipReady = true;
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
  assert.equal(ownershipReady, true,
    `orphan test process ${pid} never entered the Portable ownership snapshot before stop; `
    + `alive=${processExists(pid)}; startIdentityUnchanged=${processStartTicks(pid) === orphanStartTicks}; `
    + `ownedWithoutStartIdentity=${portableOwnedBySnapshot(pid, root)}`);
  let managerBefore = managerRecognizesFixture(pid);
  // Hosted Windows can publish the targeted CIM process before it appears in
  // the bulk snapshot. Probe the actual production predicate, not a weaker
  // fixture-specific approximation, before starting an ownership-based stop.
  for (let attempt = 0; attempt < 12 && !managerBefore.recognized; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    managerBefore = managerRecognizesFixture(pid);
  }
  assert.equal(managerBefore.recognized, true,
    `Fixture ${pid} is not recognized by the production Portable ownership enumerator before stop; `
    + `broaderFixturePredicate=${portableOwnedBySnapshot(pid, root, orphanStartTicks)}; `
    + `structuralEvidence=${JSON.stringify(managerBefore.recognized ? null : diagnoseFixtureOwnership(pid))}`);

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
    timeout: 90_000,
  });
  assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
  assert.match(stopped.stdout, /No background service PID remains/);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  // The manager's contract is ownership-based: after stop returns success, no
  // process that still satisfies the Portable ownership predicate may remain.
  // A detached test child can stay briefly observable through Get-Process on a
  // GitHub runner even after the manager has already removed it from the
  // ownership snapshot, so do not make the test stricter than the product
  // contract by requiring immediate process-object disappearance here.
  const orphanRemainsOwned = portableOwnedBySnapshot(pid, root, orphanStartTicks);
  if (orphanRemainsOwned) {
    const managerAfter = managerRecognizesFixture(pid);
    assert.equal(orphanRemainsOwned, false,
      `Portable-owned orphan ${pid} remains after stop; managerRecognizedBefore=${managerBefore.recognized}; `
      + `managerRecognizedAfter=${managerAfter.recognized}; sameCreationIdentity=${processStartTicks(pid) === orphanStartTicks}; `
      + `managerStopOutput=${JSON.stringify(String(stopped.stdout || "").trim())}`);
  }
  assert.equal(
    processStartTicks(externalPid),
    externalStartTicks,
    `Unrelated external descendant ${externalPid} was recursively terminated by Portable stop`,
  );

  // Reproduce the real Task Scheduler orphan case: the actual cli.js serve
  // listener survives but its recorded PID file is missing/stale. stop-local
  // must discover the Portable MCP service by command-line signature and the
  // real listener, without recursively killing unrelated user descendants.
  // Reproduce the hosted-Windows 8.3 alias fault in the disposable manager
  // copy: CIM may omit the live service PID from the root-filtered snapshot.
  // The production manager is never modified by this injected test failure.
  const originalSnapshotLine = "const snapshot = portableProcessSnapshot();\n    const serviceProcesses = snapshot.filter(isLocalMcpServiceProcess);";
  assert.ok(sourceManagerText.includes(originalSnapshotLine), "snapshot fault injection target changed");
  const hiddenSnapshotLine = `const snapshot = portableProcessSnapshot().filter(item => item.pid !== Number(fs.readFileSync(${JSON.stringify(localServicePidFile)}, 'utf8')));\n    const serviceProcesses = snapshot.filter(isLocalMcpServiceProcess);`;
  await writeFile(manager, sourceManagerText.replace(originalSnapshotLine, hiddenSnapshotLine), "utf8");
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
  const localServiceStartTicks = processStartTicks(localServicePid);
  const localExternalStartTicks = processStartTicks(localExternalPid);
  assert.ok(localServiceStartTicks, `orphan local MCP process ${localServicePid} has no stable start identity`);
  assert.ok(localExternalStartTicks, `local unrelated descendant ${localExternalPid} has no stable start identity`);
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
  // stop-local itself owns the exit-drain contract. A successful return must
  // mean the explicitly terminated service PID is already gone; callers must
  // not need to invent an additional post-stop sleep before restart/start.
  assert.equal(
    portableOwnedBySnapshot(localServicePid, root, localServiceStartTicks),
    false,
    `stop-local left orphan MCP service ${localServicePid} visible to the ownership snapshot`,
  );
  assert.equal(portBindable(17689), true,
    "stop-local reported success while 127.0.0.1:17689 still rejected an immediate replacement bind");
  assert.equal(processStartTicks(localExternalPid), localExternalStartTicks,
    `stop-local recursively killed unrelated descendant ${localExternalPid}`);

  console.log(JSON.stringify({
    strictStop: true,
    selfRestartDelegatesOutsideMcpTaskJob: true,
    orphanPid: pid,
    unrelatedDescendantPreserved: true,
    externalPid,
    stopLocalOrphanRecovery: true,
    missingSnapshotListenerFallbackVerified: true,
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
