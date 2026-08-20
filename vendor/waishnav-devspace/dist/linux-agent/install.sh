#!/usr/bin/env bash
set -Eeuo pipefail

SERVER=""
TOKEN=""
NAME=""
RUN_USER="${SUDO_USER:-${USER:-$(id -un 2>/dev/null || echo ubuntu)}}"
STATE_DIR=""
CONFIG=""
INSTALL_DIR=""
PID_FILE=""
LOG_FILE=""
ALLOWED_ROOTS=()
AGENT_SHA256=""
AGENT_FILE=""
REQUESTED_STATE_DIR=""

while (($#)); do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --allowed-root) ALLOWED_ROOTS+=("$2"); shift 2 ;;
    --agent-sha256) AGENT_SHA256="$2"; shift 2 ;;
    --agent-file) AGENT_FILE="$2"; shift 2 ;;
    --state-dir) REQUESTED_STATE_DIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SERVER" ]] || { echo "--server is required" >&2; exit 2; }
[[ -n "$TOKEN" ]] || { echo "--token is required" >&2; exit 2; }
[[ -n "$NAME" ]] || { echo "--name is required" >&2; exit 2; }
((${#ALLOWED_ROOTS[@]} > 0)) || { echo "At least one --allowed-root is required" >&2; exit 2; }
if [[ "$EUID" -eq 0 && "$RUN_USER" == "root" ]]; then
  if id ubuntu >/dev/null 2>&1; then
    RUN_USER="ubuntu"
  else
    echo "Refusing to run the DevSpace Agent service as root. Re-run with --user <ordinary-linux-user>." >&2
    exit 2
  fi
fi
id "$RUN_USER" >/dev/null 2>&1 || { echo "Linux user does not exist: $RUN_USER" >&2; exit 2; }
if [[ "$EUID" -ne 0 && "$RUN_USER" != "$(id -un)" ]]; then
  echo "A non-root install can only run as the current Linux user ($(id -un)). Remove --user or use an administrator for a system-wide install." >&2
  exit 2
fi
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 2; }
PYTHON_BIN="$(command -v python3)"
[[ "$AGENT_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "--agent-sha256 with a 64-character SHA-256 digest is required" >&2; exit 2; }
if [[ -n "$AGENT_FILE" ]]; then
  [[ -f "$AGENT_FILE" ]] || { echo "--agent-file does not exist: $AGENT_FILE" >&2; exit 2; }
fi

if [[ -n "$REQUESTED_STATE_DIR" ]]; then
  [[ "$REQUESTED_STATE_DIR" == /* ]] || { echo "--state-dir must be absolute: $REQUESTED_STATE_DIR" >&2; exit 2; }
  [[ "$REQUESTED_STATE_DIR" != "/" ]] || { echo "--state-dir cannot be /." >&2; exit 2; }
  state_allowed=0
  for root in "${ALLOWED_ROOTS[@]}"; do
    normalized_root="${root%/}"
    if [[ "$REQUESTED_STATE_DIR" == "$normalized_root" || "$REQUESTED_STATE_DIR" == "$normalized_root/"* ]]; then
      state_allowed=1
      break
    fi
  done
  [[ "$state_allowed" -eq 1 ]] || { echo "--state-dir must be inside one of the selected --allowed-root paths." >&2; exit 2; }
  STATE_DIR="$REQUESTED_STATE_DIR"
elif [[ "$EUID" -eq 0 ]]; then
  STATE_DIR="/var/lib/devspace-agent"
else
  LEGACY_STATE_DIR="/var/lib/devspace-agent"
  USER_STATE_HOME="${XDG_STATE_HOME:-${HOME:?HOME is required for a user-mode install}/.local/state}"
  if [[ -d "$LEGACY_STATE_DIR" && -w "$LEGACY_STATE_DIR" && -x "$LEGACY_STATE_DIR" ]]; then
    # 1.1.39 revision 2 installed the background Agent under /var/lib but
    # chowned it to the ordinary service user. Reuse that writable location so
    # a subsequent passwordless reinstall upgrades the existing Agent in place
    # instead of starting a duplicate identity from a second state directory.
    STATE_DIR="$LEGACY_STATE_DIR"
  else
    STATE_DIR="$USER_STATE_HOME/devspace-agent"
  fi
fi
CONFIG="$STATE_DIR/config.json"
INSTALL_DIR="$STATE_DIR/bin"
PID_FILE="$STATE_DIR/agent.pid"
LOG_FILE="$STATE_DIR/agent.log"

run_as_agent_user() {
  if [[ "$EUID" -ne 0 || "$RUN_USER" == "$(id -un)" ]]; then
    "$@"
    return
  fi
  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$RUN_USER" -- "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo -u "$RUN_USER" -- "$@"
    return
  fi
  echo "System-wide install requires runuser or sudo to launch the Agent as $RUN_USER." >&2
  return 1
}

for root in "${ALLOWED_ROOTS[@]}"; do
  [[ "$root" == /* ]] || { echo "Linux allowedRoot must be absolute: $root" >&2; exit 2; }
  [[ "$root" != "/" ]] || { echo "Linux allowedRoot cannot be /." >&2; exit 2; }
  [[ -d "$root" ]] || { echo "Linux allowedRoot does not exist or is not a directory: $root" >&2; exit 2; }
  run_as_agent_user test -x "$root" || { echo "Linux Agent user cannot traverse allowedRoot: $RUN_USER -> $root" >&2; exit 2; }
done

mkdir -p "$INSTALL_DIR" "$STATE_DIR"
[[ -w "$STATE_DIR" && -x "$STATE_DIR" ]] || { echo "Agent state directory is not writable by the current user: $STATE_DIR" >&2; exit 2; }
if [[ -n "$AGENT_FILE" ]]; then
  cp "$AGENT_FILE" "$INSTALL_DIR/devspace-agent.py"
else
  "$PYTHON_BIN" - "${SERVER%/}/agent/v1/devspace-agent.py" "$INSTALL_DIR/devspace-agent.py" <<'PY'
import pathlib
import sys
import urllib.request

url, output = sys.argv[1], pathlib.Path(sys.argv[2])
with urllib.request.urlopen(url, timeout=30) as response:
    output.write_bytes(response.read())
PY
fi
"$PYTHON_BIN" - "$INSTALL_DIR/devspace-agent.py" "${AGENT_SHA256,,}" <<'PY'
import hashlib
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
expected = sys.argv[2].lower()
actual = hashlib.sha256(path.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit(f"DevSpace Agent SHA-256 mismatch: expected {expected}, received {actual}")
PY
chmod 0755 "$INSTALL_DIR/devspace-agent.py"
if [[ "$EUID" -eq 0 ]]; then
  chown -R "$RUN_USER":"$(id -gn "$RUN_USER")" "$STATE_DIR"
fi

has_systemd() {
  [[ "$(ps -p 1 -o comm= 2>/dev/null | tr -d '[:space:]')" == "systemd" ]] \
    && [[ -d /run/systemd/system ]] \
    && command -v systemctl >/dev/null 2>&1
}

stop_background_agent() {
  [[ -f "$PID_FILE" ]] || return 0
  local pid=""
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && [[ -r "/proc/$pid/cmdline" ]]; then
    local cmdline=""
    cmdline="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true)"
    if [[ "$cmdline" == *"$INSTALL_DIR/devspace-agent.py"* && "$cmdline" == *"$CONFIG"* ]]; then
      kill "$pid" 2>/dev/null || true
      for _ in {1..20}; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
    fi
  fi
  rm -f "$PID_FILE"
}

start_background_agent() {
  touch "$LOG_FILE"
  if [[ "$EUID" -eq 0 ]]; then
    chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$LOG_FILE"
  fi
  chmod 0600 "$LOG_FILE"
  if [[ "$EUID" -eq 0 && "$RUN_USER" != "$(id -un)" ]]; then
    if command -v runuser >/dev/null 2>&1; then
      runuser -u "$RUN_USER" -- sh -c \
        "umask 077; nohup '$PYTHON_BIN' '$INSTALL_DIR/devspace-agent.py' --config '$CONFIG' run >>'$LOG_FILE' 2>&1 </dev/null & echo \$! >'$PID_FILE'"
    elif command -v sudo >/dev/null 2>&1; then
      sudo -u "$RUN_USER" -- sh -c \
        "umask 077; nohup '$PYTHON_BIN' '$INSTALL_DIR/devspace-agent.py' --config '$CONFIG' run >>'$LOG_FILE' 2>&1 </dev/null & echo \$! >'$PID_FILE'"
    else
      echo "Cannot start system-wide Agent as $RUN_USER: runuser/sudo is unavailable." >&2
      return 1
    fi
  else
    sh -c "umask 077; nohup '$PYTHON_BIN' '$INSTALL_DIR/devspace-agent.py' --config '$CONFIG' run >>'$LOG_FILE' 2>&1 </dev/null & echo \$! >'$PID_FILE'"
  fi
  if [[ "$EUID" -eq 0 ]]; then
    chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$PID_FILE"
  fi
  sleep 0.5
  local pid=""
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || {
    echo "DevSpace Agent background process failed to start. See $LOG_FILE" >&2
    return 1
  }
}

ARGS=("$INSTALL_DIR/devspace-agent.py" enroll --config "$CONFIG" --server "$SERVER" --token "$TOKEN" --name "$NAME" --state-dir "$STATE_DIR")
for root in "${ALLOWED_ROOTS[@]}"; do ARGS+=(--allowed-root "$root"); done
WAS_ACTIVE=0
SERVICE_MODE="background"
if [[ "$EUID" -eq 0 ]] && has_systemd; then
  SERVICE_MODE="systemd"
  if systemctl is-active --quiet devspace-agent.service 2>/dev/null; then
    WAS_ACTIVE=1
    systemctl stop devspace-agent.service
  fi
else
  if [[ -f "$PID_FILE" ]]; then WAS_ACTIVE=1; fi
  stop_background_agent
fi
if ! run_as_agent_user "$PYTHON_BIN" "${ARGS[@]}"; then
  if [[ "$WAS_ACTIVE" -eq 1 ]]; then
    if [[ "$SERVICE_MODE" == "systemd" ]]; then
      systemctl start devspace-agent.service || true
    elif [[ -s "$CONFIG" ]]; then
      start_background_agent || true
    fi
  fi
  exit 1
fi
if [[ "$EUID" -eq 0 ]]; then
  chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$CONFIG"
fi
chmod 0600 "$CONFIG"

if [[ "$SERVICE_MODE" == "systemd" ]]; then
  cat >/etc/systemd/system/devspace-agent.service <<EOF
[Unit]
Description=DevSpace Linux Remote Workspace Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
ExecStart=$PYTHON_BIN $INSTALL_DIR/devspace-agent.py --config $CONFIG run
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$STATE_DIR ${ALLOWED_ROOTS[*]}

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now devspace-agent.service
  echo "DevSpace Linux Agent installed and started as $RUN_USER using systemd."
else
  start_background_agent
  if [[ "$EUID" -eq 0 ]]; then
    echo "DevSpace Linux Agent installed and started as $RUN_USER using background fallback mode."
    echo "systemd is not PID 1 on this host; the Agent will survive SSH logout but must be restarted after the container/host itself restarts."
  else
    echo "DevSpace Linux Agent installed without sudo as $RUN_USER using user-mode background service."
    echo "State directory: $STATE_DIR"
    echo "The Agent survives normal SSH logout. After a host/container reboot, restart it from the user session or reinstall if no user init service is available."
  fi
  echo "Background log: $LOG_FILE"
fi
echo "Allowed roots: ${ALLOWED_ROOTS[*]}"
