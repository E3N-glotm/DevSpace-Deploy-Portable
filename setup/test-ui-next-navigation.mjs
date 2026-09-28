import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(readFileSync(join(root,'VERSION-MANIFEST.json'),'utf8'));
const iteration=Number(manifest.development?.iteration||0);
const versionParts=String(manifest.runtime?.devspacePortable||'0.0.0').split('.').map(Number);
const stableNextDefault=(
  (versionParts[0]||0)>1 ||
  ((versionParts[0]||0)===1 && (versionParts[1]||0)>1) ||
  ((versionParts[0]||0)===1 && (versionParts[1]||0)===1 && (versionParts[2]||0)>=62)
);
const effectiveIteration=stableNextDefault?999:iteration;
if(effectiveIteration<4){
  console.log('Next-only launcher acceptance requires dev4+ or stable 1.1.62+.');
  process.exit(0);
}
const alias=join(root,'DevSpace-Portable.exe');
const next=join(root,'DevSpace-Portable-Next.exe');
const electron=join(root,'ui-next','runtime','electron.exe');
assert.ok(statSync(alias).size<20_000,'default executable must be the compact Electron launcher, not the old WinForms UI');
assert.ok(statSync(next).size<20_000,'Next alias must be present for existing shortcuts');
const run=spawnSync(electron,[join(root,'ui-next'),'--devspace-ui-navigation-smoke','--disable-gpu'],{
  cwd:root,env:{...process.env,DEVSPACE_PORTABLE_ROOT:root},
  timeout:90_000,encoding:'utf8',windowsHide:true,maxBuffer:128*1024,
});
if(run.status!==0)throw new Error('Electron navigation smoke failed: '+String(run.stdout||run.stderr).slice(-3500));
const resultLine=run.stdout.trim().split(/\r?\n/).findLast(line=>line.startsWith('{')&&line.includes('"navigation"'));
assert.ok(resultLine,'missing Electron navigation acceptance');
const result=JSON.parse(resultLine);
assert.equal(result.smoke,true);
assert.equal(result.navigation.length,10);
assert.ok(result.navigation.every(row=>row.clicked&&row.hasPanel&&!row.legacyLaunch&&!row.error));
if(effectiveIteration>=5){
  if(effectiveIteration<8){
    assert.equal(result.heroService?.found,true,'Dark hero must show service action');
    assert.ok(result.heroService?.contrast>=4.5,
      'Service-management action must meet WCAG AA normal-text contrast in actual Electron');
  } else {
    assert.equal(result.homeHasNoDuplicateActions,true,'Homepage must not duplicate configuration and service controls');
  }
  assert.equal(result.scopeOperationsIndependent,true,
    'Choosing full operations must not change the selected file scope');
}
if(effectiveIteration>=6){
  assert.equal(result.updateInSettingsOnly,true,
    'Update controls and close-choice reset must be available in Settings and not Diagnostics');
}
console.log(JSON.stringify({nextDefaultLauncher:true,legacyUIEntrypoints:0,
  nativePages:result.navigation.length,homeHasNoDuplicateActions:result.homeHasNoDuplicateActions,
  scopeOperationsIndependent:result.scopeOperationsIndependent,smoke:true}));
