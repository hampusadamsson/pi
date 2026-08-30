#!/usr/bin/env bash
set -euo pipefail

# Keep the previous PI_WEBUI_* names working as aliases.
if [ -n "${PI_WEBUI_HOST:-}" ]; then
  export PI_WEB_HOST="$PI_WEBUI_HOST"
fi
if [ -n "${PI_WEBUI_PORT:-}" ]; then
  export PI_WEB_PORT="$PI_WEBUI_PORT"
fi

: "${HOME:=/root}"
PI_WEB_DATA_DIR="${PI_WEB_DATA_DIR:-$HOME/.pi-web}"
PI_WEB_SESSIOND_SOCKET="${PI_WEB_SESSIOND_SOCKET:-$PI_WEB_DATA_DIR/sessiond.sock}"
export PI_WEB_DATA_DIR PI_WEB_SESSIOND_SOCKET

sessiond_pid=""
server_pid=""

cleanup() {
  local status=$?
  trap - INT TERM EXIT
  if [ -n "$sessiond_pid" ]; then
    kill -TERM "$sessiond_pid" 2>/dev/null || true
  fi
  if [ -n "$server_pid" ]; then
    kill -TERM "$server_pid" 2>/dev/null || true
  fi
  if [ -n "$sessiond_pid" ]; then
    wait "$sessiond_pid" 2>/dev/null || true
  fi
  if [ -n "$server_pid" ]; then
    wait "$server_pid" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup INT TERM EXIT

pi-web-sessiond &
sessiond_pid=$!

ready=""
for _ in $(seq 1 240); do
  if [ -S "$PI_WEB_SESSIOND_SOCKET" ]; then
    ready=1
    break
  fi
  if ! kill -0 "$sessiond_pid" 2>/dev/null; then
    wait "$sessiond_pid" 2>/dev/null || true
    echo "pi-web-sessiond exited before creating $PI_WEB_SESSIOND_SOCKET" >&2
    exit 1
  fi
  sleep 0.5
done

if [ "$ready" != "1" ]; then
  echo "timed out waiting for pi-web sessiond socket: $PI_WEB_SESSIOND_SOCKET" >&2
  exit 1
fi

pi-web-server &
server_pid=$!

set +e
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3) )); then
  wait -n "$sessiond_pid" "$server_pid"
  status=$?
else
  # Bash < 4.3 lacks `wait -n`. Fall back to waiting on the web server;
  # the container image targets a newer bash where the any-wait path above runs.
  wait "$server_pid" 2>/dev/null
  status=$?
fi
set -e
exit "$status"
