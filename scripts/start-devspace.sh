#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
ROOT_WIN="$(cygpath -w "$ROOT")"
NODE_EXE="$ROOT/runtime/node/node.exe"
CLI_FILE="$ROOT/app/node_modules/@waishnav/devspace/dist/cli.js"
MANAGER_FILE="$ROOT/setup/portable-manager.cjs"
LOGGED_LAUNCHER="$ROOT/setup/logged-launcher.cjs"
PID_PRELOAD="$ROOT/setup/pid-preload.cjs"
CONFIG_DIR_WIN="$ROOT_WIN\\data\\config"
PID_FILE_WIN="$ROOT_WIN\\data\\run\\devspace.pid"
LOG_FILE="$ROOT/logs/devspace.log"

export DEVSPACE_HOST_PATH="$(cygpath -wp "$PATH")"
export PATH="$ROOT/runtime/node:$ROOT/runtime/git/cmd:/usr/bin:/bin:$PATH"
export DEVSPACE_CONFIG_DIR="$CONFIG_DIR_WIN"
export DEVSPACE_PID_FILE="$PID_FILE_WIN"
export DEVSPACE_PORTABLE_ROOT="$ROOT_WIN"
export DEVSPACE_PORTABLE_VERSION="1.1.45"
export DEVSPACE_TRUST_PROXY=1
TOOL_MODE="$("$NODE_EXE" "$MANAGER_FILE" get toolMode 2>/dev/null || true)"
case "$TOOL_MODE" in
  minimal|full|codex) ;;
  *) TOOL_MODE="full" ;;
esac
ACCESS_PROFILE="$("$NODE_EXE" "$MANAGER_FILE" get accessProfile 2>/dev/null || true)"
case "$ACCESS_PROFILE" in
  workspace|full-access|custom) ;;
  *) ACCESS_PROFILE="workspace" ;;
esac
export DEVSPACE_TOOL_MODE="$TOOL_MODE"
export DEVSPACE_WIDGETS=changes
export DEVSPACE_ARTIFACTS=0
export DEVSPACE_SUBAGENTS=0
export DEVSPACE_DYNAMIC_PLUGIN_ALIASES=0
export DEVSPACE_LOG_LEVEL=info
export DEVSPACE_LOG_FORMAT=pretty
export DEVSPACE_LOG_REQUESTS=1
export DEVSPACE_LOG_TOOL_CALLS=1
export DEVSPACE_LOG_SHELL_COMMANDS=0

[[ -x "$NODE_EXE" ]] || { printf '[ERROR] Missing Node: %s\n' "$NODE_EXE" >&2; exit 1; }
[[ -f "$CLI_FILE" ]] || { printf '[ERROR] Missing DevSpace CLI: %s\n' "$CLI_FILE" >&2; exit 1; }
[[ -f "$MANAGER_FILE" ]] || { printf '[ERROR] Missing portable manager: %s\n' "$MANAGER_FILE" >&2; exit 1; }
[[ -f "$ROOT/data/config/config.json" ]] || { printf '[ERROR] Run Portable Setup first.\n' >&2; exit 1; }

mkdir -p "$ROOT/logs" "$ROOT/data/run"
if [[ -f "$LOG_FILE" ]] && (( $(wc -c < "$LOG_FILE") > 10485760 )); then
  mv -f "$LOG_FILE" "$LOG_FILE.1"
fi

cd "$ROOT/app"
PATH_NODE="$(command -v node 2>/dev/null || true)"
PATH_GIT="$(command -v git 2>/dev/null || true)"
PATH_SSH="$(command -v ssh 2>/dev/null || true)"
printf '\n[%s] Starting portable DevSpace 1.1.45, tool mode=%s, access profile=%s\n' "$(date '+%Y-%m-%d %H:%M:%S %z')" "$TOOL_MODE" "$ACCESS_PROFILE" >> "$LOG_FILE"
printf '[provenance] root=%s node=%s path-node=%s git=%s ssh=%s\n' "$ROOT_WIN" "$NODE_EXE" "$PATH_NODE" "$PATH_GIT" "$PATH_SSH" >> "$LOG_FILE"
if [[ "$PATH_NODE" != "$ROOT/runtime/node/node" && "$PATH_NODE" != "$ROOT/runtime/node/node.exe" ]]; then
  printf '[warning] Portable Node is not first on PATH: %s\n' "$PATH_NODE" >> "$LOG_FILE"
fi
exec "$NODE_EXE" "$LOGGED_LAUNCHER" "$LOG_FILE" "$NODE_EXE" --require "$PID_PRELOAD" "$CLI_FILE" serve
