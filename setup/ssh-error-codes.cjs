"use strict";

// Only stable categorical codes cross the Electron IPC boundary. Never send
// OpenSSH stderr, enrollment output, host names, credentials or paths there.
const patterns = [
  ["HOST_KEY_CHANGED", /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|POSSIBLE DNS SPOOFING|Offending .*known_hosts/i],
  ["AUTH_FAILED", /Permission denied \(|Permission denied, please try again|Too many authentication failures|Authentication failed/i],
  ["SSH_TIMEOUT", /Connection timed out|Operation timed out|SSH execution timed out|ConnectionAttempts/i],
  ["SSH_REFUSED", /Connection refused|Network is unreachable|No route to host|Could not resolve hostname/i],
  ["PASSWORD_HELPER", /SSH password helper is missing|could not access encrypted SSH credentials/i],
  ["SSH_KEY_INVALID", /SSH 私钥路径无效|SSH 私钥文件不存在或不是有效文件/i],
  ["INSTALL_ROOT_INVALID", /DEVSPACE_AGENT_INSTALL_ROOT_NOT_WRITABLE|Cannot verify a writable remote Agent install root/i],
  ["STATE_NOT_FOUND", /DEVSPACE_AGENT_STATE_NOT_FOUND|Cannot verify an existing remote state matching the Agent ID/i],
  ["CONTROLLER_UNREACHABLE", /DEVSPACE_AGENT_WS_NOT_UPGRADED|DEVSPACE_AGENT_URL_INVALID|Linux .* Agent .* entrance|Agent WebSocket route|remote Linux.*Agent|远程 Linux 无法连接 Agent 服务入口/i],
  ["INSTALL_FAILED", /Agent SSH installer failed|Bundled Linux Agent asset missing|Bundled Agent SHA-256 does not match|Agent staging\/self-test failed/i],
  ["REVERSE_FORWARD_UNAVAILABLE", /SSH_REVERSE_FORWARD_UNAVAILABLE|SSH_REVERSE_FORWARD_UNSAFE_BINDING|SSH reverse tunnel.*did not|SSH remote port forwarding.*not establish/i],
  ["HEARTBEAT_MISSING", /no new controller heartbeat|no healthy heartbeat was observed/i],
  ["REMOTE_RESTART_FAILED", /Verified remote Agent restart failed|Could not safely stop the verified old Agent/i],
];

function sshFailureCode(error) {
  const message=String(error?.message||error||"");
  return (patterns.find(([,regex])=>regex.test(message))||["UNKNOWN"])[0];
}

module.exports={sshFailureCode};
