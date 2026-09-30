import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join,dirname,parse} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const ts=require(join(root,'ui-next','node_modules','typescript'));
const accessSource=readFileSync(join(root,'ui-next','src','access-policy.ts'),'utf8');
const commonJs=ts.transpileModule(accessSource,{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText;
const module={exports:{}};
runInNewContext(commonJs,{module,exports:module.exports});
const policy=module.exports;
const selected=[join(root,'setup')],other=join(root,'ui-next');
const base={
  provider:'local',port:17681,publicBaseUrl:'',allowedRoots:selected,
  fileScopeMode:'selected',operationMode:'standard',
  permissions:{profile:'custom',allowExternalPaths:false,...policy.standardOperations},
  toolMode:'full',ngrokProxyUrl:'',
};
const exact=JSON.stringify;
const standardSelected=policy.compileAccessSettings(base);
assert.equal(standardSelected.permissions.allowExternalPaths,false);
assert.equal(standardSelected.permissions.allowArbitraryCommands,false);
const fullSelected=policy.compileAccessSettings({...base,operationMode:'full'});
assert.equal(fullSelected.permissions.allowExternalPaths,false,
  'Full operations must not silently expand selected directory scope');
assert.ok(policy.operationNames.every(({key})=>fullSelected.permissions[key]===true));
const allStandard=policy.compileAccessSettings({...base,fileScopeMode:'all',
  allowedRoots:[],operationMode:'standard'});
assert.equal(allStandard.permissions.allowExternalPaths,true);
assert.equal(allStandard.permissions.allowArbitraryCommands,false,
  'All-directory scope must not silently grant arbitrary commands');
assert.equal(allStandard.allowAllFixedDrives,true);
assert.throws(()=>policy.compileAccessSettings({...base,allowedRoots:[]}),/至少一个目录/);
assert.equal(policy.detectOperationMode({
  operationMode:'full',
  permissions:{...fullSelected.permissions,allowArbitraryCommands:false},
}),'custom','An obsolete preset label must not conceal changed backend permission flags');

// Actual manager save/show-config contract, isolated beneath this checkout's
// source reports directory. Local development remains on E:, while GitHub's
// Windows runner checks out on D:. Never reads/writes a separate live install.
const report=join(root,'reports');
mkdirSync(report,{recursive:true});
const temp=mkdtempSync(join(report,'.tmp-dev5-scope-'));
const configDir=join(temp,'config'),stateDir=join(temp,'state'),runDir=join(temp,'run');
for(const dir of [configDir,stateDir,runDir])mkdirSync(dir);
const env={...process.env,DEVSPACE_PORTABLE_CONFIG_DIR:configDir,
  DEVSPACE_PORTABLE_STATE_DIR:stateDir,DEVSPACE_PORTABLE_RUN_DIR:runDir};
function command(action,payload){
  const run=spawnSync(process.execPath,[join(root,'setup','portable-manager.cjs'),action,'--ascii-json'],{
    cwd:root,env,encoding:'utf8',timeout:90000,
    input:payload===undefined?'':exact(payload),
  });
  if(run.status!==0)throw new Error(action+' failed '+run.status+': '+String(run.stderr).slice(0,700));
  return JSON.parse(run.stdout);
}
function save(settings) {
  return command('configure',{
    localOnly:true,tunnelProvider:'ngrok',port:settings.port,
    allowedRoots:settings.allowedRoots, fileScopeMode:settings.fileScopeMode,
    operationMode:settings.operationMode,
    allowAllFixedDrives:settings.allowAllFixedDrives,
    permissions:settings.permissions,toolMode:'full',
  });
}
function persisted() {
  return JSON.parse(readFileSync(join(configDir,'config.json'),'utf8'));
}
try {
  save(standardSelected);
  let cfg=command('show-config');
  assert.equal(cfg.permissionMode,'selected-roots');
  assert.deepEqual(cfg.selectedRoots,selected);
  assert.deepEqual(cfg.allowedRoots,selected);
  assert.equal(cfg.permissions.allowExternalPaths,false);
  save(fullSelected);
  cfg=command('show-config');
  assert.equal(cfg.permissionMode,'selected-roots');
  assert.equal(cfg.operationMode,'full');
  assert.equal(cfg.permissions.profile,'custom');
  assert.equal(cfg.permissions.allowExternalPaths,false);
  assert.equal(cfg.permissions.allowArbitraryCommands,true);
  assert.deepEqual(persisted().allowedRoots,selected);

  save(policy.compileAccessSettings({...base,fileScopeMode:'all',
    operationMode:'standard',allowedRoots:selected}));
  cfg=command('show-config');
  assert.equal(cfg.permissionMode,'all-drive-roots');
  assert.equal(cfg.operationMode,'standard');
  assert.equal(cfg.permissions.profile,'custom');
  assert.equal(cfg.permissions.allowExternalPaths,true);
  assert.equal(cfg.permissions.allowArbitraryCommands,false);
  assert.deepEqual(cfg.selectedRoots,selected,
    'Switching to all directories must retain the explicit project selection');
  const sourceDriveRoot=parse(root).root.toLowerCase();
  assert.ok(cfg.allowedRoots.some(dir=>dir.toLowerCase()===sourceDriveRoot),
    'Actual backend all-directory discovery must include the source checkout drive');
  assert.ok(persisted().allowedRoots.some(dir=>dir.toLowerCase()===sourceDriveRoot));

  const temporarilyUnavailable=join(root,'reports','.offline-dev5-volume-example');
  save(policy.compileAccessSettings({...base,fileScopeMode:'all',
    allowedRoots:[temporarilyUnavailable],operationMode:'standard'}));
  cfg=command('show-config');
  assert.deepEqual(cfg.selectedRoots,[temporarilyUnavailable],
    'All-directory mode must remember an unplugged/offline project path without requiring it to exist');
  assert.equal(cfg.permissions.allowExternalPaths,true);
  assert.throws(()=>save(policy.compileAccessSettings({...base,fileScopeMode:'selected',
    allowedRoots:[temporarilyUnavailable]})),/failed|must exist|Invalid|ENOENT/i,
    'Returning to selected mode must revalidate the remembered path');

  save(policy.compileAccessSettings({...base,allowedRoots:selected,fileScopeMode:'selected',
    operationMode:'full'}));
  cfg=command('show-config');
  assert.deepEqual(cfg.allowedRoots,selected);
  assert.equal(cfg.permissions.allowExternalPaths,false);
  assert.equal(cfg.permissions.allowArbitraryCommands,true);
  assert.equal(policy.initialFileScope(cfg),'selected');
  assert.deepEqual([...policy.selectedDirectoryList(cfg)],selected);

  // Legacy full-access could bypass selected roots despite an old
  // selected-roots label. The new UI must show its *effective* all scope.
  assert.equal(policy.initialFileScope({...cfg,permissions:{...cfg.permissions,
    allowExternalPaths:true}}),'all');
  assert.equal(policy.detectOperationMode({...cfg,operationMode:'standard',
    permissions:{...cfg.permissions,allowArbitraryCommands:true}}),'custom',
    'A stale saved preset must not hide current effective operation permissions');
  assert.equal(policy.detectOperationMode({...cfg,operationMode:'full',
    permissions:{...cfg.permissions,allowArbitraryCommands:false}}),'custom');
  // An offline project is remembered but not validated as an active allowed
  // root when all-directory mode is chosen. Returning to selected mode
  // must explicitly fail until it is available again.
  const unavailable=join(temp,'offline-project');
  save(policy.compileAccessSettings({...base,fileScopeMode:'all',
    allowedRoots:[unavailable],operationMode:'standard'}));
  cfg=command('show-config');
  assert.deepEqual(cfg.selectedRoots,[unavailable]);
  assert.equal(cfg.permissions.allowExternalPaths,true);
  assert.throws(()=>save(policy.compileAccessSettings({...base,fileScopeMode:'selected',
    allowedRoots:cfg.selectedRoots})),/Allowed root does not exist/);
  assert.ok(existsSync(join(configDir,'deployment.json')));
  console.log(JSON.stringify({selectedToFullOperationsDoesNotExpandRoots:true,
    allScopeKeepsStandardOperationRestrictions:true,allScopeRetainsExplicitProjects:true,
    restoredExplicitRootsAfterFullAccess:true,legacyEffectiveScopeVisible:true,
    isolatedEDrive:true}));
}finally{
  rmSync(temp,{recursive:true,force:true,maxRetries:3,retryDelay:250});
}
