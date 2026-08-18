#!/usr/bin/env bash
set -Eeuo pipefail

SERVER=""
TOKEN=""
NAME=""
RUN_USER="${SUDO_USER:-${USER:-ubuntu}}"
STATE_DIR="/var/lib/devspace-agent"
CONFIG="$STATE_DIR/config.json"
INSTALL_DIR="$STATE_DIR/bin"
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

ARGS=("$INSTALL_DIR/devspace-agent.py" enroll --config "$CONFIG" --server "$SERVER" --token "$TOKEN" --name "$NAME" --state-dir "$STATE_DIR")
for root in "${ALLOWED_ROOTS[@]}"; do ARGS+=(--allowed-root "$root"); done
sudo -u "$RUN_USER" -- python3 "${ARGS[@]}"
chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$CONFIG"
chmod 0600 "$CONFIG"

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
echo "DevSpace Linux Agent installed and started as $RUN_USER."
echo "Allowed roots: ${ALLOWED_ROOTS[*]}"
