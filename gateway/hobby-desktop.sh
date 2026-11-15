#!/usr/bin/env bash
set -euo pipefail
export HOME=/home/octo
export DISPLAY=:0 XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=Openbox
export XDG_RUNTIME_DIR=/run/user/1000
export OCTO_COMPOSITOR=openbox OCTO_CHROMIUM_PLATFORM=x11 OCTO_BIND=127.0.0.1
export OCTO_HOME_URL=http://127.0.0.1:7777/desk OCTOGEE_X11_SESSION=1 NO_AT_BRIDGE=0 GTK_MODULES=gail:atk-bridge
export OCTO_PINNED_APPS=chromium:octogee-files:octogee-terminal:org.xfce.mousepad
unset WAYLAND_DISPLAY CUA_DRIVER_RS_ENABLE_WAYLAND
mkdir -p "$XDG_RUNTIME_DIR/octogee-openclaw-vnc" "$HOME/.config/octogee-chromium" "$HOME/.openclaw-desktop"
chmod 700 "$XDG_RUNTIME_DIR" "$XDG_RUNTIME_DIR/octogee-openclaw-vnc"
rm -f "$HOME/.config/octogee-chromium/SingletonLock" "$HOME/.config/octogee-chromium/SingletonSocket" "$HOME/.config/octogee-chromium/SingletonCookie"
session_runtime=$(mktemp -d "$XDG_RUNTIME_DIR/octogee-hobby-session.XXXXXX")
session_pid_file="$session_runtime/pid"
dbus_pid=""
signal_count=0
stop_requested=0
stop_forwarded=0
stop_error=0
cleanup_session_runtime() {
  rm -f "$session_pid_file" "$session_pid_file.tmp"
  rmdir "$session_runtime"
}
trap cleanup_session_runtime EXIT
forward_session_stop() {
  if [[ -z "$dbus_pid" || "$stop_forwarded" == 1 ]]; then return 0; fi
  stop_forwarded=1
  local session_pid="" parent_pid=""
  while kill -0 "$dbus_pid" 2>/dev/null; do
    if [[ -f "$session_pid_file" && ! -L "$session_pid_file" ]] && IFS= read -r session_pid < "$session_pid_file"; then
      if [[ ! "$session_pid" =~ ^[1-9][0-9]*$ || "$session_pid" == 1 || "$session_pid" == "$$" || "$session_pid" == "$dbus_pid" ]]; then
        echo "hobby-desktop: invalid owned session PID" >&2
        stop_error=1
        return 0
      fi
      parent_pid=$(ps -o ppid= -p "$session_pid" 2>/dev/null) || parent_pid=""
      parent_pid=${parent_pid//[[:space:]]/}
      if [[ "$parent_pid" != "$dbus_pid" ]]; then
        if ! kill -0 "$session_pid" 2>/dev/null; then return 0; fi
        echo "hobby-desktop: session PID is not owned by dbus-run-session" >&2
        stop_error=1
        return 0
      fi
      if ! kill -TERM "$session_pid" 2>/dev/null && kill -0 "$session_pid" 2>/dev/null; then
        echo "hobby-desktop: could not stop owned session" >&2
        stop_error=1
      fi
      return 0
    fi
    sleep 0.01
  done
}
request_session_stop() {
  signal_count=$((signal_count + 1))
  stop_requested=1
  forward_session_stop
  return 0
}
trap request_session_stop TERM INT
dbus-run-session -- bash -c '
  set -euo pipefail
  umask 077
  printf "%s\n" "$$" > "$1.tmp"
  mv "$1.tmp" "$1"
  exec /usr/local/bin/octogee-hobby-session
' octogee-hobby-session "$session_pid_file" &
dbus_pid=$!
if (( stop_requested )); then forward_session_stop; fi
while true; do
  wait_signal_count=$signal_count
  status=0
  wait "$dbus_pid" || status=$?
  if (( wait_signal_count == signal_count )); then break; fi
done
if (( stop_error && status == 0 )); then status=1; fi
exit "$status"
