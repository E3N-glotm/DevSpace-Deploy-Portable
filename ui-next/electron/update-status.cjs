'use strict';
// Only read the updater's own fixed state paths. Never accept a renderer path
// or forward free-form PowerShell errors, which may contain private URLs.
const fs = require('node:fs');
const path = require('node:path');

const PHASES = Object.freeze({
  metadata: ['正在获取更新信息', '连接发布服务并检查可用版本'],
  probing: ['正在选择下载线路', '正在寻找稳定、快速的下载连接'],
  downloading: ['正在下载更新', '可以继续使用当前软件，尚未安装'],
  downloaded: ['下载完成', '准备校验下载文件'],
  verifying: ['正在校验文件', '检查文件是否完整、安全'],
  extracting: ['正在准备安装文件', '正在解压并检查更新内容'],
  staged: ['更新已准备就绪', '文件已下载并校验，可以安排安装'],
  fallback: ['正在切换下载方案', '已自动尝试其他下载方式，无需操作'],
  'apply-started': ['已交给安装程序', '控制中心即将关闭，安装由独立程序继续'],
  applying: ['正在安装更新', '请勿关闭电脑，安装完成后会尝试重启服务'],
  completed: ['更新安装完成', '可在设置页检查版本号'],
  rollback: ['正在恢复原版本', '更新出现异常，正在保护已有程序和数据'],
  error: ['更新未完成', '请检查网络并重试；现有版本未必受到影响'],
});

function safeRead(file) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    if (data.length > 100_000) return null;
    const value = JSON.parse(data.replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; } // updater swaps the progress file atomically
}
function nonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
function readUpdateState(root, since = 0, now = Date.now()) {
  const stateDir = path.join(root, 'data', 'state');
  const raw = safeRead(path.join(stateDir, 'update-progress.json'));
  const updatedAt = Date.parse(String(raw?.updatedAt || '')) || 0;
  const notBefore = Number.isFinite(Number(since)) ? Math.max(0, Number(since)) : 0;
  const phase = typeof raw?.phase === 'string' && Object.hasOwn(PHASES, raw.phase)
    ? raw.phase : '';
  const fresh = phase && updatedAt >= notBefore && updatedAt <= now + 60_000;
  let progress = null;
  if (fresh) {
    const received = nonNegative(raw.bytesReceived);
    const total = nonNegative(raw.bytesTotal);
    progress = {
      phase, title: PHASES[phase][0], description: PHASES[phase][1],
      bytesReceived: received, bytesTotal: total,
      percent: total > 0 ? Math.round(Math.min(100, received * 100 / total) * 10) / 10 : null,
      speedBytesPerSecond: nonNegative(raw.speedBytesPerSecond),
      etaSeconds: Number.isFinite(Number(raw.etaSeconds)) && Number(raw.etaSeconds) >= 0
        ? Math.round(Number(raw.etaSeconds)) : null,
      updatedAt,
    };
  }
  const result = safeRead(path.join(stateDir, 'update-result.json'));
  const resultTime = Date.parse(String(result?.appliedAt || result?.failedAt || '')) || 0;
  const recentResult = resultTime > now - 7 * 24 * 60 * 60 * 1000 && resultTime <= now + 60_000;
  return {
    progress,
    lastInstall: recentResult ? {
      success: result?.success === true,
      version: /^\d+\.\d+\.\d+$/.test(String(result?.version || ''))
        ? String(result.version) : '',
      servicesRecovered: result?.servicesRecovered === true,
      occurredAt: resultTime,
    } : null,
  };
}

module.exports = { readUpdateState, PHASES };
