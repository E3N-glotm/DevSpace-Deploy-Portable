import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Isolated E-drive UI preferences: never overwrites the installed D-live
// preference or touches its service. Electron smoke performs a real window X
// close, cancellation, second X close and tray transition.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dir=join(root,'reports');mkdirSync(dir,{recursive:true});
const isolated=mkdtempSync(join(dir,'.tmp-dev6-close-smoke-'));
try{
  const exe=join(root,'ui-next','runtime','electron.exe');
  const result=spawnSync(exe,[join(root,'ui-next'),'--devspace-ui-close-smoke','--disable-gpu'],{
    cwd:root,encoding:'utf8',windowsHide:true,timeout:90_000,maxBuffer:256*1024,
    env:{...process.env,DEVSPACE_PORTABLE_ROOT:root,DEVSPACE_PORTABLE_CONFIG_DIR:isolated},
  });
  if(result.status!==0)throw new Error('Close smoke exit '+result.status+': '+String(result.stdout||result.stderr).slice(-2600));
  const line=String(result.stdout||'').split(/\r?\n/).findLast(text=>text.startsWith('{')&&text.includes('closeDialog'));
  assert.ok(line,'Electron must return a close-dialog receipt');
  const receipt=JSON.parse(line);
  assert.equal(receipt.smoke,true);
  assert.equal(receipt.closeDialog,true);
  assert.equal(receipt.cancelKeptWindow,true);
  assert.equal(receipt.minimizedToTray,true);
  assert.equal(receipt.remembered,true);
  assert.equal(JSON.parse(readFileSync(join(isolated,'ui-preferences.json'),'utf8')).closeChoice,'minimize-tray');
  console.log(JSON.stringify({realWindowCloseDialog:true,cancelPreservesUi:true,trayKeepsUiProcess:true,
    rememberedLegacyCompatible:true,isolatedEDrive:true}));
}finally{rmSync(isolated,{recursive:true,force:true,maxRetries:3,retryDelay:120});}
