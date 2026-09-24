import type {Permission, Settings, Config} from './api';

export type FileScopeMode = 'selected' | 'all';
export type OperationMode = 'standard' | 'full' | 'custom';
export type OperationKey = Exclude<keyof Permission,'profile'|'allowExternalPaths'>;

export const operationNames: {key:OperationKey;label:string;desc:string}[] = [
  {key:'allowArbitraryCommands',label:'执行任意命令',desc:'允许运行未预先列入安全列表的命令。'},
  {key:'allowShellMutation',label:'Shell 修改文件',desc:'允许 Shell 写入、删除或移动文件；操作仍遵守上方的文件访问范围。'},
  {key:'allowNetworkAccess',label:'网络与 SSH',desc:'允许网络连接与远程 SSH，不会改变本机文件访问范围。'},
  {key:'allowCredentialAccess',label:'访问受保护凭据',desc:'允许调用凭据接口，可能接触密码或登录信息。'},
  {key:'allowComputerUse',label:'桌面控制',desc:'允许控制鼠标、键盘和屏幕；桌面应用的文件操作不受工作区目录沙箱保证。'},
  {key:'allowInteractiveProcesses',label:'交互式进程',desc:'允许运行需要交互输入的终端进程。'},
  {key:'allowPersistentProcesses',label:'持续进程',desc:'允许训练和服务器等持续后台运行的进程。'},
];

export const standardOperations: Omit<Permission,'profile'|'allowExternalPaths'> = {
  allowArbitraryCommands:false,allowShellMutation:false,allowNetworkAccess:true,
  allowCredentialAccess:false,allowComputerUse:false,
  allowInteractiveProcesses:true,allowPersistentProcesses:true,
};
export const fullOperations: Omit<Permission,'profile'|'allowExternalPaths'> =
  Object.fromEntries(operationNames.map(({key})=>[key,true])) as Omit<Permission,'profile'|'allowExternalPaths'>;

export function effectivePermissions(fileScopeMode:FileScopeMode,operationMode:OperationMode,
  custom:Permission):Permission {
  const flags=operationMode==='standard'?standardOperations:
    operationMode==='full'?fullOperations:custom;
  // Manager's workspace/full-access profiles silently overwrite
  // allowExternalPaths. custom keeps file scope independent of operations.
  return {
    ...flags, profile:'custom', allowExternalPaths:fileScopeMode==='all',
  };
}

export function detectOperationMode(c:Config):OperationMode {
  const p=c.permissions||({} as Permission);
  const isStandard=operationNames.every(({key})=>Boolean(p[key])===Boolean(standardOperations[key]));
  const isFull=operationNames.every(({key})=>Boolean(p[key])===Boolean(fullOperations[key]));
  // Other clients can change effective flags without updating dev5 metadata.
  // Display actual permissions, not a stale label suggesting capabilities
  // are disabled/enabled when the backend says otherwise.
  if(c.operationMode==='custom')return 'custom';
  if(c.operationMode==='standard'&&!isStandard || c.operationMode==='full'&&!isFull)return 'custom';
  if(isStandard)return 'standard';
  if(isFull)return 'full';
  return 'custom';
}

export function initialFileScope(c:Config):FileScopeMode {
  // A legacy full-access preset already bypasses selected roots; reflect
  // effective access rather than misleadingly showing the old directory list.
  return c.permissionMode==='all-drive-roots'||c.permissions?.allowExternalPaths ? 'all':'selected';
}

export function selectedDirectoryList(c:Config):string[] {
  if(Array.isArray(c.selectedRoots))return c.selectedRoots;
  return c.permissionMode==='all-drive-roots'?[]:Array.isArray(c.allowedRoots)?c.allowedRoots:[];
}

export function compileAccessSettings(settings:Settings):Settings {
  const fileScopeMode=settings.fileScopeMode;
  if(!['selected','all'].includes(fileScopeMode))throw new Error('请选择文件访问范围。');
  if(fileScopeMode==='selected'&&!settings.allowedRoots.length)
    throw new Error('仅限工作目录模式需要至少一个目录；也可明确选择全部可访问目录。');
  return {
    ...settings,
    allowAllFixedDrives:fileScopeMode==='all',
    permissions:effectivePermissions(fileScopeMode,settings.operationMode,settings.permissions),
  };
}
