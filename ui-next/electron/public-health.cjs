'use strict';

// A public probe is useful telemetry, not proof that established MCP clients
// lost their sessions. Desktop outbound DNS/TLS/proxy routing may differ from
// that used by remote clients. Retain recent positive evidence and never turn
// a single timeout into a red "service offline" indicator.
function createPublicHealthMonitor({
  request = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = 8000,
  recentSuccessMs = 120_000,
  failureThreshold = 3,
} = {}) {
  let current = {
    fingerprint: '', checked: false, healthy: false, state: 'checking',
    checkedAt: 0, lastSuccessAt: 0, consecutiveFailures: 0,
    metadataStatus: 0, mcpStatus: 0, error: '',
  };
  let inFlight = null;

  function snapshot() {
    const recent = current.lastSuccessAt > 0 && now() - current.lastSuccessAt <= recentSuccessMs;
    if (current.state === 'healthy' && !recent) {
      // A once-good endpoint is not considered green forever without new evidence.
      return {...current, healthy: false, state: 'uncertain', error: '最近一次公网核验已过期'};
    }
    return {...current};
  }

  async function check(publicUrl, provider, verify = false) {
    if (provider === 'local' || !publicUrl) {
      current = {fingerprint: '', checked: Boolean(publicUrl), healthy: false, state: 'idle',
        checkedAt: now(), lastSuccessAt: 0, consecutiveFailures: 0,
        metadataStatus: 0, mcpStatus: 0, error: publicUrl ? '' : '公网入口未配置'};
      return snapshot();
    }
    const base = String(publicUrl).replace(/\/$/, '');
    const fingerprint = `${provider}|${base}`;
    if (current.fingerprint !== fingerprint) {
      current = {fingerprint, checked: false, healthy: false, state: 'checking',
        checkedAt: 0, lastSuccessAt: 0, consecutiveFailures: 0,
        metadataStatus: 0, mcpStatus: 0, error: ''};
      inFlight = null;
    }
    if (!verify) return snapshot();
    if (inFlight?.fingerprint === fingerprint) return inFlight.promise;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const promise = (async () => {
      let results;
      try {
        results = await Promise.allSettled([
          request(`${base}/.well-known/oauth-protected-resource/mcp`,
            {signal: controller.signal, cache: 'no-store'}),
          request(`${base}/mcp`, {signal: controller.signal, cache: 'no-store'}),
        ]);
      } finally {
        clearTimeout(timer);
      }
      // Discard the response of a superseded config/URL. It must never paint
      // the state of a newly configured tunnel green or red.
      if (current.fingerprint !== fingerprint) return snapshot();
      const metadataStatus = results[0].status === 'fulfilled' ? results[0].value.status : 0;
      const mcpStatus = results[1].status === 'fulfilled' ? results[1].value.status : 0;
      const passed = metadataStatus === 200 && mcpStatus === 401;
      const checkedAt = now();
      if (passed) {
        current = {...current, checked: true, healthy: true, state: 'healthy',
          checkedAt, lastSuccessAt: checkedAt, consecutiveFailures: 0,
          metadataStatus, mcpStatus, error: ''};
      } else {
        const recent = current.lastSuccessAt > 0 && checkedAt - current.lastSuccessAt <= recentSuccessMs;
        const failures = current.consecutiveFailures + 1;
        const timeout = results.some(r => r.status === 'rejected'
          && r.reason?.name === 'AbortError');
        const noResponse = metadataStatus === 0 || mcpStatus === 0;
        const explicitFailure = !noResponse && (metadataStatus !== 200 || mcpStatus !== 401);
        const state = recent ? 'healthy'
          : explicitFailure && failures >= failureThreshold ? 'unhealthy' : 'uncertain';
        const error = timeout ? '公网探测响应超时'
          : noResponse ? '本机无法完成公网探测'
          : `公网返回非预期状态（${metadataStatus}/${mcpStatus}）`;
        current = {...current, checked: true, healthy: state === 'healthy', state,
          checkedAt, consecutiveFailures: failures, metadataStatus, mcpStatus, error};
      }
      return snapshot();
    })();
    inFlight = {fingerprint, promise};
    try { return await promise; }
    finally { if (inFlight?.promise === promise) inFlight = null; }
  }
  return {check, snapshot};
}

module.exports = {createPublicHealthMonitor};
