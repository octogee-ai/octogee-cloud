#!/usr/bin/env bash
set -euo pipefail
export HOME=/home/node
if [[ -d "$HOME/results" && -n "${BENCH_CASE:-}" ]]; then
  mkdir -p "$HOME/archive"
  mv "$HOME/results" "$HOME/archive/${BENCH_CASE}-$(date +%s)"
fi
rm -f "$HOME/chromium-profile/SingletonLock" "$HOME/chromium-profile/SingletonSocket" "$HOME/chromium-profile/SingletonCookie"
mkdir -p "$HOME/results" "$HOME/gateway-state" "$HOME/node-state" "$HOME/runtime/session"
chmod 700 "$HOME/runtime/session"
export XDG_RUNTIME_DIR="$HOME/runtime/session" DISPLAY=:0 XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=Openbox
export NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge
unset WAYLAND_DISPLAY CUA_DRIVER_RS_ENABLE_WAYLAND
python3 /benchmark/collect.py &
exec dbus-run-session -- /benchmark/session.sh
