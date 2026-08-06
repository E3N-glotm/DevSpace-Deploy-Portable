#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
NODE_EXE="$ROOT/runtime/node/node.exe"
MANAGER="$ROOT/setup/portable-manager.cjs"
LAUNCHER="$ROOT/setup/tunnel-launcher.cjs"
PID_FILE_WIN="$("$NODE_EXE" "$MANAGER" get tunnelPidFile)"
PROVIDER="$("$NODE_EXE" "$MANAGER" get tunnelProvider)"
PORT="$("$NODE_EXE" "$MANAGER" get port)"
PUBLIC_URL="$("$NODE_EXE" "$MANAGER" get publicBaseUrl)"

export PATH="$ROOT/runtime/git/cmd:/usr/bin:/bin:$PATH"
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
unset http_proxy https_proxy all_proxy no_proxy NGROK_PROXY
export TUNNEL_PID_FILE="$PID_FILE_WIN"

mkdir -p "$ROOT/logs" "$ROOT/data/run"

rotate_log() {
  local log_file="$1"
  if [[ -f "$log_file" ]] && (( $(wc -c < "$log_file") > 10485760 )); then
    mv -f "$log_file" "$log_file.1"
  fi
}

case "$PROVIDER" in
  ngrok)
    TUNNEL_EXE="$ROOT/runtime/ngrok/ngrok.exe"
    NGROK_CONFIG_WIN="$("$NODE_EXE" "$MANAGER" get ngrokConfigFile)"
    NGROK_CONFIG="$(cygpath -u "$NGROK_CONFIG_WIN")"
    LOG_FILE="$ROOT/logs/ngrok.log"
    PUBLIC_DOMAIN="${PUBLIC_URL#https://}"
    [[ -x "$TUNNEL_EXE" ]] || { printf '[ERROR] Missing ngrok: %s\n' "$TUNNEL_EXE" >&2; exit 1; }
    [[ -f "$NGROK_CONFIG" ]] || { printf '[ERROR] ngrok configuration is missing.\n' >&2; exit 1; }
    [[ -n "$PUBLIC_DOMAIN" ]] || { printf '[ERROR] Public domain is not configured.\n' >&2; exit 1; }
    rotate_log "$LOG_FILE"
    printf '\n[%s] Starting portable ngrok on https://%s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$PUBLIC_DOMAIN" >> "$LOG_FILE"
    exec "$NODE_EXE" "$LAUNCHER" "$TUNNEL_EXE" \
      http "http://127.0.0.1:$PORT" \
      --url "https://$PUBLIC_DOMAIN" \
      --config "$NGROK_CONFIG_WIN" \
      --log stdout --log-format logfmt --log-level info >> "$LOG_FILE" 2>&1
    ;;
  cloudflare)
    TUNNEL_EXE="$ROOT/runtime/cloudflared/cloudflared.exe"
    TOKEN_FILE_WIN="$("$NODE_EXE" "$MANAGER" get cloudflareTokenFile)"
    TOKEN_FILE="$(cygpath -u "$TOKEN_FILE_WIN")"
    LOG_FILE="$ROOT/logs/cloudflared.log"
    [[ -x "$TUNNEL_EXE" ]] || { printf '[ERROR] Missing cloudflared: %s\n' "$TUNNEL_EXE" >&2; exit 1; }
    [[ -f "$TOKEN_FILE" ]] || { printf '[ERROR] Cloudflare Tunnel Token file is missing.\n' >&2; exit 1; }
    rotate_log "$LOG_FILE"
    printf '\n[%s] Starting portable Cloudflare Tunnel for %s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$PUBLIC_URL" >> "$LOG_FILE"
    exec "$NODE_EXE" "$LAUNCHER" "$TUNNEL_EXE" \
      tunnel --no-autoupdate --loglevel info --metrics 127.0.0.1:20241 \
      run --token-file "$TOKEN_FILE_WIN" >> "$LOG_FILE" 2>&1
    ;;
  *)
    printf '[ERROR] Unsupported tunnel provider: %s\n' "$PROVIDER" >&2
    exit 1
    ;;
esac
