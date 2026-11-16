'use strict';

const fs = require('node:fs');
const path = require('node:path');

const unavailable = detail => new Error('AGENT_RUNTIME_UNAVAILABLE: ' + detail);

// Keep the IPC client's allowed actions at the tested HTTP request boundary.
// New local runtime actions must be added here as well as on the server.
const AGENT_ACTIONS = new Set([
  'list', 'events', 'start', 'status', 'pause', 'resume', 'cancel', 'accept',
  'delete-history', 'clear-history', 'routing-settings', 'set-routing-settings',
]);

function readAgentToken(filename) {
  let token;
  try {
    token = fs.readFileSync(filename, 'utf8').trim();
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw unavailable('当前目录的 Agent Runtime 尚未启动。请在控制中心启动本地 MCP，或从正在运行 MCP 的安装目录打开控制中心。');
    }
    throw unavailable('无法读取当前实例的 Agent Runtime 凭据，请检查服务状态后刷新。');
  }
  if (!token || /[\r\n]/.test(token)) {
    throw unavailable('本地 MCP 正在初始化 Agent Runtime，请稍后刷新。');
  }
  return token;
}

async function requestAgentRuntime({ root, config, env = process.env, fetch, action, payload }) {
  if (!AGENT_ACTIONS.has(action)) throw new Error('INVALID_AGENT_ACTION');
  const state = path.resolve(root,
    env.DEVSPACE_STATE_DIR || config.stateDir || env.DEVSPACE_PORTABLE_STATE_DIR || path.join('data', 'state'));
  const tokenFile = path.join(state, 'agent-runtime-ui.token');
  const port = Number(config.port || 7676);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw unavailable('当前实例的本地 MCP 端口无效，请检查服务配置。');
  }
  const send = async token => {
    try {
      return await fetch('http://127.0.0.1:' + port + '/agent-runtime/local', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-devspace-agent-token': token },
        body: JSON.stringify({ ...payload, action }),
        redirect: 'error',
        signal: AbortSignal.timeout(action === 'start' ? 30000 : 8000),
      });
    } catch {
      throw unavailable('无法连接当前实例的本地 MCP，请检查服务是否已启动。');
    }
  };
  const token = readAgentToken(tokenFile);
  let response = await send(token);
  if (response.status === 401 || response.status === 403) {
    const latest = readAgentToken(tokenFile);
    if (token !== latest) response = await send(latest);
    if (response.status === 401 || response.status === 403) {
      throw unavailable('当前目录的 Agent Runtime 凭据与运行实例不匹配。请从正在运行 MCP 的安装目录打开控制中心。');
    }
  }
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).error; } catch {}
    throw new Error(detail || 'Agent Runtime HTTP ' + response.status);
  }
  return response.json();
}

module.exports = { requestAgentRuntime };
