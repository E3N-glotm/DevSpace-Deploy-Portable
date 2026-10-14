'use strict';

// The old WinForms control center exposed an amber, click-through border while
// a computer-use operation was active. Electron kept the persistent local
// broker but lost the visual indication. Only broker-owned, lease-validated
// activity can activate these short-lived windows.
function createComputerUseIndicator({BrowserWindow, screen, now = () => Date.now()} = {}) {
  let overlays = [];
  let geometry = '';
  let shown = false;

  function hide() {
    for (const window of overlays) {
      if (!window.isDestroyed()) window.hide();
    }
    shown = false;
  }

  function dispose() {
    for (const window of overlays) {
      try { if (!window.isDestroyed()) window.destroy(); } catch {}
    }
    overlays = [];
    geometry = '';
    shown = false;
  }

  function ensureWindows() {
    const displays = screen.getAllDisplays().map(display => display.bounds)
      .filter(bounds => bounds.width > 0 && bounds.height > 0)
      .sort((a, b) => a.x - b.x || a.y - b.y);
    const next = JSON.stringify(displays);
    if (next === geometry && overlays.every(window => !window.isDestroyed())) return;
    dispose();
    geometry = next;
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
      <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
      body{box-sizing:border-box;border:7px solid #E2B73F;pointer-events:none}</style>
      </head><body></body></html>`;
    for (const bounds of displays) {
      const overlay = new BrowserWindow({
        ...bounds, frame: false, transparent: true, show: false,
        resizable: false, movable: false, focusable: false, skipTaskbar: true,
        alwaysOnTop: true, hasShadow: false, backgroundColor: '#00000000',
        webPreferences: {nodeIntegration: false, contextIsolation: true, sandbox: true,
          webSecurity: true, webviewTag: false},
      });
      overlay.setIgnoreMouseEvents(true, {forward: true});
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.setContentProtection(true); // exclude overlays from captured screenshots
      overlay.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
      overlay.webContents.on('will-navigate', event => event.preventDefault());
      overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
        .catch(() => {});
      overlays.push(overlay);
    }
  }

  function update({leaseId, enabled, broker} = {}) {
    const until = Date.parse(String(broker?.activityUntilAt || ''));
    const valid = enabled === true && Boolean(leaseId)
      && broker?.leaseId === leaseId && broker?.status === 'running'
      && Number.isFinite(until) && until > now();
    if (!valid) { hide(); return false; }
    ensureWindows();
    for (const window of overlays) {
      if (window.isDestroyed()) continue;
      if (!window.isVisible()) window.showInactive();
      window.setAlwaysOnTop(true, 'screen-saver');
    }
    shown = true;
    return true;
  }

  return {update, hide, dispose, get visible() { return shown; }};
}

module.exports = {createComputerUseIndicator};
