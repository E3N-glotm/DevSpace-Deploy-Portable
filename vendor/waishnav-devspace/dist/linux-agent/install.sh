#!/usr/bin/env bash
set -Eeuo pipefail

SERVER=""
TOKEN=""
NAME=""
RUN_USER="${SUDO_USER:-${USER:-ubuntu}}"
STATE_DIR="/var/lib/devspace-agent"
CONFIG="$STATE_DIR/config.json"
INSTALL_DIR="$STATE_DIR/bin"
PID_FILE="$STATE_DIR/agent.pid"
LOG_FILE="$STATE_DIR/agent.log"
ALLOWED_ROOTS=()
AGENT_SHA256=""

while (($#)); do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --user) RUN_USER="$2"; shift 2 ;;
    --allowed-root) ALLOWED_ROOTS+=("$2"); shift 2 ;;
    --agent-sha256) AGENT_SHA256="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$SERVER" ]] || { echo "--server is required" >&2; exit 2; }
[[ -n "$TOKEN" ]] || { echo "--token is required" >&2; exit 2; }
[[ -n "$NAME" ]] || { echo "--name is required" >&2; exit 2; }
((${#ALLOWED_ROOTS[@]} > 0)) || { echo "At least one --allowed-root is required" >&2; exit 2; }
[[ "$EUID" -eq 0 ]] || { echo "Run installer with sudo/root; the installed service itself runs as the selected ordinary user." >&2; exit 2; }
if [[ "$RUN_USER" == "root" ]]; then
  if id ubuntu >/dev/null 2>&1; then
    RUN_USER="ubuntu"
  else
    echo "Refusing to run the DevSpace Agent service as root. Re-run with --user <ordinary-linux-user>." >&2
    exit 2
  fi
fi
id "$RUN_USER" >/dev/null 2>&1 || { echo "Linux user does not exist: $RUN_USER" >&2; exit 2; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 2; }
[[ "$AGENT_SHA256" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "--agent-sha256 with a 64-character SHA-256 digest is required" >&2; exit 2; }
for root in "${ALLOWED_ROOTS[@]}"; do
  [[ "$root" == /* ]] || { echo "Linux allowedRoot must be absolute: $root" >&2; exit 2; }
  [[ "$root" != "/" ]] || { echo "Linux allowedRoot cannot be /." >&2; exit 2; }
  [[ -d "$root" ]] || { echo "Linux allowedRoot does not exist or is not a directory: $root" >&2; exit 2; }
  sudo -u "$RUN_USER" -- test -x "$root" || { echo "Linux service user cannot traverse allowedRoot: $RUN_USER -> $root" >&2; exit 2; }
done

mkdir -p "$INSTALL_DIR" "$STATE_DIR"
curl -fsSL "${SERVER%/}/agent/v1/devspace-agent.py" -o "$INSTALL_DIR/devspace-agent.py"
echo "${AGENT_SHA256,,}  $INSTALL_DIR/devspace-agent.py" | sha256sum -c -
chmod 0755 "$INSTALL_DIR/devspace-agent.py"
chown -R "$RUN_USER":"$(id -gn "$RUN_USER")" "$STATE_DIR"

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
  chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$LOG_FILE"
  chmod 0600 "$LOG_FILE"
  sudo -u "$RUN_USER" -- sh -c \
    "umask 077; nohup /usr/bin/python3 '$INSTALL_DIR/devspace-agent.py' --config '$CONFIG' run >>'$LOG_FILE' 2>&1 </dev/null & echo \$! >'$PID_FILE'"
  chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$PID_FILE"
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
if has_systemd; then
  SERVICE_MODE="systemd"
  if systemctl is-active --quiet devspace-agent.service 2>/dev/null; then
    WAS_ACTIVE=1
    systemctl stop devspace-agent.service
  fi
else
  if [[ -f "$PID_FILE" ]]; then WAS_ACTIVE=1; fi
  stop_background_agent
fi
if ! sudo -u "$RUN_USER" -- python3 "${ARGS[@]}"; then
  if [[ "$WAS_ACTIVE" -eq 1 ]]; then
    if [[ "$SERVICE_MODE" == "systemd" ]]; then
      systemctl start devspace-agent.service || true
    elif [[ -s "$CONFIG" ]]; then
      start_background_agent || true
    fi
  fi
  exit 1
fi
chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$CONFIG"
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
ExecStart=/usr/bin/python3 $INSTALL_DIR/devspace-agent.py --config $CONFIG run
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
  echo "DevSpace Linux Agent installed and started as $RUN_USER using background fallback mode."
  echo "systemd is not PID 1 on this host; the Agent will survive SSH logout but must be restarted after the container/host itself restarts."
  echo "Background log: $LOG_FILE"
fi
echo "Allowed roots: ${ALLOWED_ROOTS[*]}"
