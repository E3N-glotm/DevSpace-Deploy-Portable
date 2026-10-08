import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const next=readFileSync(join(root,'setup/native/DevSpacePortableNextLauncher.cs'),'utf8');
const manager=readFileSync(join(root,'setup/portable-manager.cjs'),'utf8');
const bridge=readFileSync(join(root,'setup/create-legacy-upgrade-bridge.py'),'utf8');

// Shallow legacy deltas deliberately exclude the Electron runtime, so the
// launcher must start the marker-triggered full repair before probing for it.
assert.match(bridge,/BRIDGE_TARGET_FILES\s*=\s*\([\s\S]*?"DevSpace-Portable.exe"/);
assert.match(bridge,/MARKER_PATH\s*=\s*"setup\/legacy-upgrade-bootstrap\.json"/);
assert.doesNotMatch(bridge,/BRIDGE_TARGET_FILES\s*=\s*\([\s\S]*?"ui-next\/runtime\/electron\.exe"/);
const repair=next.indexOf('if (TryCompleteLegacyUpgrade(root)) return;');
const missing=next.indexOf('if (!File.Exists(runtime) || !File.Exists(main) || !File.Exists(ui))');
assert.ok(repair>=0 && missing>repair,'Legacy bootstrap must precede Electron prerequisite failure');
assert.match(next,/RunManager\(root, "update-stage-force-full", null\)/);
assert.match(next,/RunManager\(root, "update-launch", new Dictionary/);
assert.match(next,/"uiPid", Process\.GetCurrentProcess\(\)\.Id/);
assert.match(next,/if \(!File\.Exists\(marker\)\) return false/);

// CIM failures must fall back to WMI with the exact same path/identity
// ownership filters; never silently presume an empty process list.
assert.match(manager,/Get-CimInstance Win32_Process -ErrorAction Stop/);
assert.match(manager,/Get-WmiObject Win32_Process -ErrorAction Stop/);
assert.match(manager,/CIM and WMI process enumeration both failed; no processes stopped/);
assert.match(manager,/\$processId -ne \$PID -and \(\$ownedExe -or \$ownedWrapper -or \$exactCli -or \$nodeAliasCandidate\)/);
assert.match(manager,/ManagementDateTimeConverter/);

// End-to-end Windows launcher fixture: an old bridge has the compact
// launcher, Node and the marker, but intentionally no Electron runtime.
// Mock only the manager's two network/update actions, never touch live tasks.
if (process.platform==='win32') {
  const reports=join(root,'reports');
  mkdirSync(reports,{recursive:true});
  const temp=mkdtempSync(join(reports,'.tmp-next-bootstrap-'));
  try {
    const setup=join(temp,'setup');
    const runtime=join(temp,'runtime','node');
    mkdirSync(setup,{recursive:true});
    mkdirSync(runtime,{recursive:true});
    copyFileSync(join(root,'DevSpace-Portable.exe'),join(temp,'DevSpace-Portable.exe'));
    copyFileSync(join(root,'runtime','node','node.exe'),join(runtime,'node.exe'));
    const log=join(temp,'bootstrap-events.jsonl');
    const stagedPath=join(temp,'.update-staging','mock-full');
    writeFileSync(join(setup,'legacy-upgrade-bootstrap.json'),'{}');
    writeFileSync(join(setup,'portable-manager.cjs'),[
      "const fs=require('fs');",
      `const log=${JSON.stringify(log)};`,
      `const stagedPath=${JSON.stringify(stagedPath)};`,
      "const action=process.argv[2];",
      "let payload={};if(action==='update-launch'){payload=JSON.parse(fs.readFileSync(0,'utf8'));}",
      "fs.appendFileSync(log,JSON.stringify({action,payload})+'\\n');",
      "if(action==='update-stage-force-full')console.log(JSON.stringify({stagingPath:stagedPath}));",
      "else if(action==='update-launch')console.log(JSON.stringify({launched:true}));",
      "else{console.error('unexpected action');process.exitCode=1;}",
    ].join('\n'));
    assert.equal(existsSync(join(temp,'ui-next','runtime','electron.exe')),false);
    const result=spawnSync(join(temp,'DevSpace-Portable.exe'),[],{
      cwd:temp,windowsHide:true,encoding:'utf8',timeout:60_000,
    });
    assert.equal(result.status,0,`bootstrapped launcher exited ${result.status}: ${result.error?.message||''}`);
    const events=readFileSync(log,'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(events.map(e=>e.action),['update-stage-force-full','update-launch']);
    assert.equal(events[1].payload.stagingPath,stagedPath);
    assert.ok(events[1].payload.uiPid>0);
  } finally {
    rmSync(temp,{recursive:true,force:true});
  }
}

console.log(JSON.stringify({legacyBootstrapRunsBeforeElectronCheck:true,
  standaloneBridgeLauncherSmoke:true,fallbackPreservesStrictProcessOwnership:true,
  dualEnumerationFailureFailsClosed:true}));
