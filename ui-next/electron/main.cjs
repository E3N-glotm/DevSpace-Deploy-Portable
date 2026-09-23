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
const SECRETS = Object.freeze({
  owner: 'auth.json', ngrok: 'ngrok.yml', cloudflare: 'cloudflare.token',
});
let windowRef;
let activeOperation = false;
let currentStatus = {};
let watchers = [];
let refreshHandle = null;
let closing = false;
const smokeMode = process.argv.includes('--devspace-ui-smoke');
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
  register('openLegacy', async () => {
    const executable = path.join(ROOT, 'DevSpace-Portable.exe');
    if (!fs.existsSync(executable)) throw new Error('原版控制中心不存在。');
    spawn(executable, [], {cwd: ROOT, detached: true, windowsHide: false, stdio: 'ignore'}).unref();
  });
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
      }, 20_000);
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
    publishStatus().catch(() => {});
  } catch (e) {
    dialog.showErrorBox('DevSpace Next 无法启动', e.message);
    app.quit();
  }
});
app.on('before-quit', () => {
  closing = true;
  if (refreshHandle) clearInterval(refreshHandle);
  for (const watcher of watchers) watcher.close();
});
app.on('window-all-closed', () => app.quit());
