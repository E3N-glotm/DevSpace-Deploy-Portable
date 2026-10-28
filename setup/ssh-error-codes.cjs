"use strict";

// Only stable categorical codes cross the Electron IPC boundary. Never send
// OpenSSH stderr, enrollment output, host names, credentials or paths there.
const patterns = [
  ["HOST_KEY_CHANGED", /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|POSSIBLE DNS SPOOFING|Offending .*known_hosts/i],
  ["AUTH_FAILED", /Permission denied \(|Permission denied, please try again|Too many authentication failures|Authentication failed/i],
  ["SSH_TIMEOUT", /Connection timed out|Operation timed out|SSH execution timed out|ConnectionAttempts/i],
  ["SSH_REFUSED", /Connection refused|Network is unreachable|No route to host|Could not resolve hostname/i],
  ["PASSWORD_HELPER", /SSH password helper is missing|could not access encrypted SSH credentials/i],
  ["STATE_NOT_FOUND", /DEVSPACE_AGENT_STATE_NOT_FOUND|Cannot verify an existing remote state matching the Agent ID/i],
  ["CONTROLLER_UNREACHABLE", /DEVSPACE_AGENT_WS_NOT_UPGRADED|Linux .* Agent .* entrance|Agent WebSocket route|remote Linux.*Agent/i],
  ["HEARTBEAT_MISSING", /no new controller heartbeat|no healthy heartbeat was observed/i],
  ["REMOTE_RESTART_FAILED", /Verified remote Agent restart failed|Could not safely stop the verified old Agent/i],
];

function sshFailureCode(error) {
  const message=String(error?.message||error||"");
  return (patterns.find(([,regex])=>regex.test(message))||["UNKNOWN"])[0];
}

module.exports={sshFailureCode};
