'use strict';
// DevSpace Portable Next: the renderer never receives Node, a shell, file IO,
// OAuth credentials, or a generic command runner. Only the main process can
// access the existing manager and the Windows clipboard.
const { app, BrowserWindow, ipcMain, clipboard, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(process.env.DEVSPACE_PORTABLE_ROOT || path.join(__dirname, '../..'));
const HERE = path.resolve(__dirname, '..');
const MANAGER = path.join(ROOT, 'setup', 'portable-manager.cjs');
const NODE = path.join(ROOT, 'runtime', 'node', 'node.exe');
const CONFIG = path.join(ROOT, 'data', 'config');
const APPLY_PENDING = path.join(ROOT, 'data', 'run', 'ui-next-pending-apply.json');
const HEALTH_TIMEOUT_MS = 2000;
const ACTIONS = new Set([
  'diagnose', 'restart-local', 'restart-tunnel', 'plugin-list',
  'continuation-list', 'memory-list', 'review-list', 'oauth-client-list', 'update-check',
]);
// Explicitly enumerate existing manager commands. The renderer can neither
// choose an arbitrary command nor access Node, shell, or a filesystem API.
const ADMIN_READ = new Set([
  'remote-agent-list','remote-ssh-list','plugin-list','continuation-list','review-list',
  'review-details','memory-list','oauth-client-list',
  'continuation-cutoff-estimate-get','log-paths','network-proxy-state',
  'dashboard-status','update-check',
]);
const ADMIN_WRITE = new Set([
  'remote-agent-create-enrollment','remote-agent-revoke','remote-agent-delete',
  'remote-ssh-save','remote-ssh-test','remote-ssh-deploy','remote-ssh-recover','remote-ssh-delete',
  'plugin-install','plugin-export','plugin-enable','plugin-disable',
  'plugin-uninstall','plugin-slot-bind','plugin-slot-unbind','plugin-refresh',
  'continuation-lock','continuation-unlock','continuation-pause',
  'continuation-resume','continuation-stop','continuation-delete',
  'continuation-cutoff-estimate-set',
  'review-update','review-rollback','review-restore-safety',
  'memory-upsert','memory-delete',
  'oauth-client-create','oauth-client-rotate-secret','oauth-client-delete',
  'set-auto-continuation','set-computer-use',
  'repair-stale-proxy','restore-proxy-repair',
  'start-local','stop-local','restart-local','start-tunnel','stop-tunnel',
  'restart-tunnel','enable','disable','uninstall-tasks','install-tasks',
  'update-stage','update-launch',
]);
const ADMIN_DESTRUCTIVE = new Set([
  'remote-agent-revoke','remote-agent-delete','plugin-uninstall',
  'remote-ssh-deploy','remote-ssh-recover','remote-ssh-delete',
  'continuation-stop','continuation-delete','review-rollback',
  'review-restore-safety','memory-delete','oauth-client-rotate-secret',
  'oauth-client-delete','uninstall-tasks','disable','update-launch',
  'repair-stale-proxy','restore-proxy-repair',
]);
const ADMIN_FOREIGN_SERVICE = new Set([
  'start-local','stop-local','restart-local','start-tunnel','stop-tunnel',
  'restart-tunnel','enable','disable','uninstall-tasks','install-tasks',
  'update-launch',
]);
const SECRETS = Object.freeze({
  owner: 'auth.json', ngrok: 'ngrok.yml', cloudflare: 'cloudflare.token',
});
let windowRef;
let activeOperation = false;
let currentStatus = {};
let watchers = [];
let refreshHandle = null;
let closing = false;
let computerUseLeaseId = '';
let computerUseHeartbeat;
let shutdownStarted = false;
let selectedPluginSource = '';
let selectedPluginExport = '';
let remoteAutoRecoverTimer;
let remoteAutoRecoverBusy = false;
const remoteLastAttempt = new Map();
const navigationSmokeMode = process.argv.includes('--devspace-ui-navigation-smoke');
const smokeMode = process.argv.includes('--devspace-ui-smoke') || navigationSmokeMode;
if (smokeMode) app.disableHardwareAcceleration();

function ensureRoot() {
  if (!fs.existsSync(MANAGER) || !fs.existsSync(NODE)) {
    throw new Error('无法识别完整的 DevSpace Portable 目录，未对系统执行任何操作。');
  }
}
function assertNoForeignServiceOwnership() {
  // DevSpace's Windows scheduled-task names are machine-wide. A Next UI
  // preview started from E: must never replace an active D-live installation.
  for (const task of ['DevSpace Portable MCP Server', 'DevSpace Portable Tunnel']) {
    const result = spawnSync('schtasks.exe', ['/query', '/tn', task, '/xml'], {
      windowsHide: true, encoding: 'utf8', timeout: 8000, maxBuffer: 256 * 1024,
    });
    if (result.error) throw new Error('无法核实计划任务归属，已阻止可能影响其他 DevSpace 实例的部署。');
    if (result.status !== 0) continue; // No existing task.
    const definition = String(result.stdout || '').replace(/\\/g, '/').toLowerCase();
    const sourceScripts = ROOT.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() + '/scripts/';
    if (!definition.includes(sourceScripts)) {
      throw new Error('检测到另一目录的 DevSpace 服务已安装。本开发界面不会覆盖现有计划任务；请从已部署的 Portable 目录打开 Next。');
    }
  }
}
function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function assertCaller(event) {
  if (!windowRef || windowRef.isDestroyed() || event.sender !== windowRef.webContents)
    throw new Error('Invalid IPC sender');
  const expected = path.normalize(path.join(HERE, 'dist', 'index.html'));
  const actual = event.senderFrame?.url || '';
  if (!actual.startsWith('file:') || !actual.includes('index.html')
    || path.normalize(decodeURIComponent(new URL(actual).pathname.replace(/^\/(\w:)/, '$1'))) !== expected) {
    throw new Error('UI origin rejected');
  }
}
function register(channel, fn) {
  ipcMain.handle('ds:' + channel, async (event, ...args) => {
    assertCaller(event);
    return fn(...args);
  });
}
function runManager(action, payload, timeoutMs = 90_000) {
  ensureRoot();
  // Every write is explicit, serialized and awaited. Status updates do not
  // launch this CLI, unlike the former 1–3 second WinForms polling loop.
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [MANAGER, action], {
      cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEVSPACE_PORTABLE_ROOT: ROOT,
        DEVSPACE_NATIVE_UI_PID: String(process.pid),
        // Avoid claiming the old WinForms computer-use broker/queue lease.
        DEVSPACE_NATIVE_UI_QUEUE_WORKER: '0',
      },
    });
    let stdout = '', stderr = '';
    const limit = 5 * 1024 * 1024;
    let settled = false;
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', b => {
      if (stdout.length + b.length > limit) { child.kill(); return; }
      stdout += b.toString('utf8');
    });
    child.stderr.on('data', b => {
      if (stderr.length + b.length > limit) { child.kill(); return; }
      stderr += b.toString('utf8');
    });
    child.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        // Never pass potentially credential-bearing stdout/stderr to the renderer.
        reject(new Error(`管理操作 ${action} 失败（退出码 ${code}），请到诊断页查看安全日志。`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ ok: true, message: stdout.trim().slice(0, 2000) }); }
    });
    child.stdin.end(payload === undefined ? '' : JSON.stringify(payload));
  });
}
async function operation(fn) {
  if (activeOperation) throw new Error('另一项配置或部署任务尚未结束。');
  activeOperation = true;
  try { return await fn(); } finally { activeOperation = false; }
}
async function lightweightStatus() {
  const configuration = readJson(path.join(CONFIG, 'config.json'));
  const deployment = readJson(path.join(CONFIG, 'deployment.json'));
  const port = Number(configuration.port || 7676);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  let localHealthy = false;
  // An unrelated Portable checkout can use the same loopback port. A 200
  // response alone must not paint *this* installation green.
  let ownerPid = 0;
  try {
    ownerPid = Number(fs.readFileSync(path.join(ROOT, 'data', 'run', 'devspace.pid'), 'utf8').trim());
    if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) ownerPid = 0;
    if (ownerPid) process.kill(ownerPid, 0);
  } catch { ownerPid = 0; }
  try {
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`, {
      signal: controller.signal, cache: 'no-store',
    });
    localHealthy = ownerPid > 0 && response.status === 200;
  } catch {} finally { clearTimeout(timer); }
  return {
    localHealthy, port, localUrl: `http://127.0.0.1:${port}/mcp`,
    provider: deployment.localOnly ? 'local' : deployment.tunnelProvider || 'local',
    publicUrl: deployment.localOnly ? '' : configuration.publicBaseUrl || '',
    configured: fs.existsSync(path.join(CONFIG, 'auth.json')) && fs.existsSync(path.join(CONFIG, 'config.json')),
    checkedAt: Date.now(),
  };
}
async function publishStatus() {
  if (closing) return;
  currentStatus = await lightweightStatus();
  if (!windowRef?.isDestroyed()) windowRef.webContents.send('ds:status', currentStatus);
  return currentStatus;
}
function broadcastProgress(phase, message, step, total) {
  if (!windowRef?.isDestroyed()) windowRef.webContents.send('ds:progress', {phase, message, step, total});
}
function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Invalid configuration');
  if (!['local', 'ngrok', 'cloudflare'].includes(input.provider)) throw new Error('Unknown connection mode');
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口必须介于 1024 和 65535。');
  if (!Array.isArray(input.allowedRoots) || !input.allowedRoots.length || input.allowedRoots.length > 24
    || input.allowedRoots.some(p => typeof p !== 'string' || !path.isAbsolute(p) || p.length > 1024)) {
    throw new Error('请选择至少一个有效的工作目录。');
  }
  if (!input.permissions || !['workspace','full-access','custom'].includes(input.permissions.profile)) {
    throw new Error('访问权限预设无效。');
  }
  if (input.provider !== 'local') {
    const url = new URL(String(input.publicBaseUrl || ''));
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('公网地址必须是 HTTPS 域名的根地址（不要填写 /mcp）。');
    }
  }
  return {
    localOnly: input.provider === 'local',
    tunnelProvider: input.provider === 'local' ? 'ngrok' : input.provider,
    publicBaseUrl: input.provider === 'local' ? '' : input.publicBaseUrl,
    allowedRoots: input.allowedRoots, port, toolMode: input.toolMode || 'full',
    allowAllFixedDrives: input.allowAllFixedDrives === true,
    permissions: input.permissions,
    ...(['ownerToken','ngrokToken','cloudflareToken'].reduce((out, key) => {
      if (typeof input[key] === 'string' && input[key].trim()) out[key] = input[key].trim();
      return out;
    }, {})),
    ngrokProxyUrl: input.ngrokProxyUrl || '',
  };
}
function secret(kind) {
  if (!Object.hasOwn(SECRETS, kind)) throw new Error('Unknown secret type');
  const file = path.join(CONFIG, SECRETS[kind]);
  if (kind === 'owner') return String(readJson(file).ownerToken || '');
  if (kind === 'cloudflare') return fs.readFileSync(file, 'utf8').trim();
  const match = fs.readFileSync(file, 'utf8').match(/^\s*authtoken:\s*(["']?)([^"'\r\n]+)\1\s*$/m);
  return match ? match[2].trim() : '';
}
function installHandlers() {
  register('initialize', async () => ({
    config: await runManager('show-config'), status: await publishStatus(),
    root: ROOT, applyPending: fs.existsSync(APPLY_PENDING),
  }));
  register('getConfig', () => runManager('show-config'));
  register('getStatus', () => publishStatus());
  register('save', input => operation(async () => {
    const checked = validateSettings(input);
    broadcastProgress('save', '正在检查并保存配置', 1, 4);
    const outcome = await runManager('configure', checked, 160_000);
    // Keep the save-versus-apply state across window restarts. Only the
    // existing manager can apply configuration to the running service.
    fs.mkdirSync(path.dirname(APPLY_PENDING), {recursive:true});
    fs.writeFileSync(APPLY_PENDING, JSON.stringify({version:1, savedAt:Date.now()}), {flag:'w',mode:0o600});
    await publishStatus();
    // configure may return a newly generated Owner Token; it MUST NOT be
    // forwarded to the renderer. The main process alone can copy it later.
    return {mcpUrl: outcome.mcpUrl, generatedOwnerToken: Boolean(outcome.generatedOwnerToken)};
  }));
  register('deploy', provider => operation(async () => {
    if (!['local', 'ngrok', 'cloudflare'].includes(provider)) throw new Error('Invalid provider');
    assertNoForeignServiceOwnership();
    broadcastProgress('tasks', '注册本地 MCP 服务', 2, 4);
    await runManager('install-tasks', undefined, 130_000);
    if (provider === 'local') {
      broadcastProgress('local', '仅启动本地 MCP，不启动公网隧道', 3, 4);
      await runManager('stop-tunnel', undefined, 90_000);
      // A mere start-local would leave a healthy *old* process running with
      // stale permissions or OAuth settings after configuration changes.
      await runManager('restart-local', undefined, 150_000);
    } else {
      broadcastProgress('start', '启动 MCP 与公网隧道', 3, 4);
      await runManager('restart-local', undefined, 150_000);
      await runManager('restart-tunnel', undefined, 180_000);
    }
    const result = await publishStatus();
    if (!result.localHealthy) throw new Error('服务已启动，但本地 OAuth 健康检查未通过。');
    try { fs.unlinkSync(APPLY_PENDING); } catch(e) { if(e.code!=='ENOENT') throw e; }
    broadcastProgress('complete', '部署成功，本地服务可用', 4, 4);
  }));
  register('copySecret', kind => {
    const value = secret(kind);
    if (!value) throw new Error('此 Token 尚未配置。');
    clipboard.writeText(value);
    return {copied: true};
  });
  register('copyUrl', kind => {
    if (kind !== 'local' && kind !== 'public') throw new Error('Unknown MCP URL kind');
    const cfg = readJson(path.join(CONFIG, 'config.json'));
    const d = readJson(path.join(CONFIG, 'deployment.json'));
    const port = Number(cfg.port || 7676);
    const value = kind === 'local' ? `http://127.0.0.1:${port}/mcp`
      : !d.localOnly && cfg.publicBaseUrl ? String(cfg.publicBaseUrl).replace(/\/$/, '') + '/mcp' : '';
    if (!value) throw new Error('公网地址尚未配置。');
    clipboard.writeText(value);
    return {copied: true};
  });
  register('pickPlugin', async () => {
    const result = await dialog.showOpenDialog(windowRef, {
      title: '选择 DevSpace 插件包',properties:['openFile'],
      filters:[{name:'插件 ZIP 或 manifest.json',extensions:['zip','json']}],
    });
    selectedPluginSource=result.canceled?'':String(result.filePaths[0]||'');
    return selectedPluginSource||null;
  });
  register('pickExport', async suggestedName => {
    const safe = String(suggestedName || 'devspace-plugin.zip')
      .replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120);
    const result = await dialog.showSaveDialog(windowRef, {
      title:'导出插件包',defaultPath:safe,filters:[{name:'ZIP',extensions:['zip']}],
    });
    selectedPluginExport=result.canceled?'':String(result.filePath||'');
    return selectedPluginExport||null;
  });
  register('copyValue', value => {
    if (typeof value !== 'string' || value.length > 20_000) throw new Error('无效的复制内容。');
    clipboard.writeText(value);
    return {copied:true};
  });
  register('admin', async (action, payload, confirmed = false) => {
    if (!ADMIN_READ.has(action) && !ADMIN_WRITE.has(action)) throw new Error('此管理操作不在授权列表内。');
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('无效的管理操作参数。');
    }
    const serializedPayload = JSON.stringify(payload);
    if (!serializedPayload || serializedPayload.length > 64 * 1024) throw new Error('管理操作参数过大。');
    if (ADMIN_DESTRUCTIVE.has(action) && confirmed !== true) throw new Error('此操作需要明确确认。');
    if (ADMIN_FOREIGN_SERVICE.has(action)) assertNoForeignServiceOwnership();
    if (action === 'set-computer-use' && payload.enabled === true) {
      const deployment = readJson(path.join(CONFIG, 'deployment.json'));
      if (!deployment.permissions?.allowComputerUse) {
        throw new Error('请先在权限页允许 Computer Use 并应用设置。');
      }
    }
    if (action === 'plugin-install') {
      if (!selectedPluginSource || payload.sourcePath !== selectedPluginSource
        || !fs.existsSync(payload.sourcePath)
        || !['.zip','.json'].includes(path.extname(payload.sourcePath).toLowerCase())) {
        throw new Error('请选择有效的插件包。');
      }
      selectedPluginSource='';
    }
    if (action === 'plugin-export') {
      if (!selectedPluginExport || payload.destinationPath !== selectedPluginExport ||
        path.extname(payload.destinationPath).toLowerCase() !== '.zip') {
        throw new Error('请选择有效的 ZIP 导出目标。');
      }
      selectedPluginExport='';
    }
    if (action === 'update-launch') {
      if (typeof payload.stagingPath !== 'string') throw new Error('必须选择已校验的更新暂存目录。');
      payload = {stagingPath: payload.stagingPath, uiPid: process.pid};
    }
    const exec = async () => {
      const response = await runManager(action, payload,
        action === 'update-stage' ? 4_200_000 : ADMIN_WRITE.has(action) ? 180_000 : 60_000);
      if (action === 'oauth-client-create' || action === 'oauth-client-rotate-secret') {
        // Newly issued secrets are visible only once; copy in Main and never
        // serialize the plaintext into React state or renderer DevTools.
        const secret = String(response?.clientSecret || '');
        if (secret) clipboard.writeText(secret);
        return {...response,clientSecret:undefined,secretCopied:Boolean(secret)};
      }
      if (action === 'set-computer-use') {
        if (payload.enabled===true) await ensureComputerUseLease();
        else computerUseLeaseId='';
      }
      if (action === 'update-launch' && response?.acknowledged === true) {
        // The detached updater owns the transaction after its launch ACK.
        // Give the renderer one second to display the handoff message, then
        // release the UI executable so Windows can replace program files.
        setTimeout(() => app.quit(), 1200);
      }
      return response;
    };
    if (ADMIN_WRITE.has(action)) return operation(exec);
    return exec();
  });
  register('chooseFolder', async () => {
    const result = await dialog.showOpenDialog(windowRef, {properties: ['openDirectory'], title: '选择允许 DevSpace 访问的工作目录'});
    return result.canceled ? null : result.filePaths[0] || null;
  });
  register('runAction', action => {
    if (!ACTIONS.has(action)) throw new Error('Action not allowed');
    if (action === 'restart-local' || action === 'restart-tunnel') assertNoForeignServiceOwnership();
    if (action === 'restart-tunnel' && readJson(path.join(CONFIG, 'deployment.json')).localOnly) {
      throw new Error('当前为仅本机模式，需先配置公网连接。');
    }
    return action === 'restart-local' || action === 'restart-tunnel'
      ? operation(() => runManager(action, undefined, 180_000))
      : runManager(action, undefined, 35_000);
  });
}
async function ensureComputerUseLease() {
  if (computerUseLeaseId) {
    const lease = await runManager('ui-heartbeat',{leaseId:computerUseLeaseId},20_000);
    computerUseLeaseId=String(lease.leaseId||computerUseLeaseId);
    return lease;
  }
  const lease=await runManager('ui-open',undefined,20_000);
  computerUseLeaseId=String(lease.leaseId||'');
  if(!computerUseLeaseId)throw new Error('本地桌面控制服务未返回有效租约。');
  return lease;
}
async function recoverOfflineAgents() {
  // Former WinForms performed this while its window was running. The new UI
  // preserves the opt-in per-profile policy, but only for this installation's
  // healthy service; an E-drive preview cannot act on D-live Agents.
  if (smokeMode || closing || remoteAutoRecoverBusy || activeOperation
    || currentStatus.localHealthy !== true
    || !fs.existsSync(path.join(ROOT,"data","remote-agent-ssh-profiles.json"))) return;
  try { assertNoForeignServiceOwnership(); } catch { return; }
  remoteAutoRecoverBusy = true;
  try {
    const stored = await runManager('remote-ssh-list', {}, 20_000);
    const profiles = Array.isArray(stored.profiles) ? stored.profiles : [];
    if (!profiles.some(p=>p.autoRecover)) return;
    const status = await runManager('remote-agent-list', {}, 30_000);
    for (const agent of status.agents || []) {
      if (closing || activeOperation) break;
      if (String(agent.status||'').toLowerCase() !== 'offline' || !agent.id) continue;
      const profile=profiles.find(p=>p.autoRecover && (
        p.key===agent.id || p.key===('name:'+String(agent.name||''))));
      if (!profile) continue;
      const now=Date.now(), last=remoteLastAttempt.get(agent.id)||0;
      if (now-last < 120_000) continue;
      remoteLastAttempt.set(agent.id,now);
      // Recover an existing verified state only. Never auto-enroll a new
      // identity or kill other users' Python/Agent processes in the background.
      try {
        await runManager('remote-ssh-recover',{
          key:profile.key,agentId:agent.id,
          installRoot:agent.installRoot||'',
          writableRoots:agent.writableRoots||agent.allowedRoots||[],
        },75_000);
      } catch {
        // Manual SSH management exposes the failed state; automatic recovery
        // must neither silently reinstall nor leak SSH diagnostics to React.
      }
    }
  } catch {} finally { remoteAutoRecoverBusy = false; }
}
function createWindow() {
  const main = new BrowserWindow({
    width: 1220, height: 820, minWidth: 860, minHeight: 640,
    backgroundColor: '#f7f8fb', title: 'DevSpace Portable Next',
    show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false, spellcheck: false,
    },
  });
  windowRef = main;
  if (!smokeMode) main.once('ready-to-show', () => main.show());
  main.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  main.webContents.on('will-navigate', e => e.preventDefault());
  main.loadFile(path.join(HERE, 'dist', 'index.html'));
  return main;
}
app.whenReady().then(() => {
  try {
    ensureRoot();
    app.on('web-contents-created', (_e, contents) => {
      contents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    });
    installHandlers();
    const activeWindow = createWindow();
    if (smokeMode) {
      const watchdog = setTimeout(() => {
        process.stdout.write(JSON.stringify({smoke: false, reason: 'renderer did not load in time'}) + '\n');
        app.exit(2);
      }, navigationSmokeMode ? 75_000 : 20_000);
      activeWindow.webContents.once('did-finish-load', async () => {
        try {
          // Wait for the initial read-only configuration IPC to complete.
          // Otherwise quitting the test window races an in-flight handler.
          for (let attempt = 0; attempt < 35; attempt++) {
            const ready = await activeWindow.webContents.executeJavaScript(
              '!!document.querySelector(".desktop") || !!document.querySelector(".alert.error")',
            );
            if (ready) break;
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          const view = await activeWindow.webContents.executeJavaScript(
            '({ title: document.title, bridge: !!window.devspace, hasRoot: !!document.querySelector(".desktop"), mainText: document.body.innerText.slice(0, 150) })',
          );
          if (navigationSmokeMode && view.bridge && view.hasRoot) {
            const coverage = [];
            const pageIds = ['home','workspaces','agents','extensions','tasks',
              'sessions','memories','oauth','services','diagnose','settings'];
            for (const pageId of pageIds) {
              const clicked = await activeWindow.webContents.executeJavaScript(`(() => {
                const button = [...document.querySelectorAll('.sidebar .nav')]
                  .find(item => item.getAttribute('data-page') === ${JSON.stringify(pageId)});
                if (!button) return false;
                button.click(); return true;
              })()`);
              await new Promise(resolve => setTimeout(resolve, 150));
              const rendered = await activeWindow.webContents.executeJavaScript(
                `({ heading: document.querySelector('.topbar h1')?.textContent || '',
                    hasPanel: !!document.querySelector('.page-body .panel, .page-body .hero'),
                    legacyLaunch: !![...document.querySelectorAll('button')].find(x => /打开旧版|旧版控制中心/.test(x.textContent)),
                    error: document.querySelector('.alert.error')?.textContent || '' })`,
              );
              coverage.push({page:pageId, clicked, ...rendered});
            }
            const valid = coverage.every(x => x.clicked && x.hasPanel && !x.legacyLaunch);
            clearTimeout(watchdog);
            process.stdout.write(JSON.stringify({smoke:valid, navigation:coverage}) + '\n');
            app.exit(valid ? 0 : 5);
            return;
          }
          clearTimeout(watchdog);
          process.stdout.write(JSON.stringify({smoke: true, ...view}) + '\n');
          app.exit(view.bridge && view.hasRoot ? 0 : 3);
        } catch {
          clearTimeout(watchdog);
          process.stdout.write(JSON.stringify({smoke: false, reason: 'renderer execution failed'}) + '\n');
          app.exit(4);
        }
      });
    }
    // One persistent main process pushes state. There is no spawned Node
    // manager process per timer tick; filesystem changes can trigger an
    // additional cheap health probe between the 20-second intervals.
    const debounced = (() => {
      let t;
      return () => { clearTimeout(t); t = setTimeout(() => publishStatus().catch(() => {}), 300); };
    })();
    for (const directory of [CONFIG, path.join(ROOT, 'data', 'run')]) {
      try { watchers.push(fs.watch(directory, debounced)); } catch {}
    }
    refreshHandle = setInterval(() => publishStatus().catch(() => {}), 20_000);
    // The existing lightweight Node fallback broker handles input/capture
    // requests after explicitly enabled permissions. It does not launch the
    // WinForms frontend; its lease expires if this window is terminated.
    computerUseHeartbeat=setInterval(async()=>{
      if(closing||!computerUseLeaseId)return;
      try { await ensureComputerUseLease(); }
      catch { computerUseLeaseId=''; }
    },30_000);
    remoteAutoRecoverTimer=setInterval(()=>recoverOfflineAgents().catch(()=>{}),120_000);
    if(readJson(path.join(CONFIG,'deployment.json')).features?.computerUse){
      ensureComputerUseLease().catch(()=>{ computerUseLeaseId=''; });
    }
    publishStatus().catch(() => {});
  } catch (e) {
    dialog.showErrorBox('DevSpace Next 无法启动', e.message);
    app.quit();
  }
});
app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  closing = true;
  if (refreshHandle) clearInterval(refreshHandle);
  if (computerUseHeartbeat) clearInterval(computerUseHeartbeat);
  if (remoteAutoRecoverTimer) clearInterval(remoteAutoRecoverTimer);
  for (const watcher of watchers) watcher.close();
  // The native file-queue broker must not retain input privileges after the
  // owner closes the Electron window. Expire this exact UI lease before exit.
  if (computerUseLeaseId) {
    event.preventDefault();
    const leaseId = computerUseLeaseId;
    computerUseLeaseId = '';
    runManager('ui-close', {leaseId}, 8_000)
      .catch(() => {})
      .finally(() => app.quit());
  }
});
app.on('window-all-closed', () => app.quit());
