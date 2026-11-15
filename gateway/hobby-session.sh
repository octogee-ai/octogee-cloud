#!/usr/bin/env bash
set -euo pipefail
desktop_config=/usr/share/octogee/hobby-desktop
children=()
browser_pid=""
panel_pid=""
restart_browser=0
cleanup() {
  local exit_status=$? signal_failed=0
  trap '' TERM INT
  for pid in "${children[@]}" "$browser_pid" "$panel_pid" "$reopen_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      if ! kill -TERM "$pid" 2>/dev/null; then
        if kill -0 "$pid" 2>/dev/null; then
          echo "hobby-desktop: could not stop owned process $pid" >&2
          signal_failed=1
        else
          echo "hobby-desktop: owned process $pid exited before termination" >&2
        fi
      fi
    fi
  done
  wait || true
  if (( signal_failed && exit_status == 0 )); then exit 1; fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
request_browser_restart() {
  restart_browser=1
  if [[ -n "$browser_pid" ]]; then kill -TERM "$browser_pid" 2>/dev/null || true; fi
}
trap request_browser_restart USR1
reopen_desk=0
request_desk_reopen() { reopen_desk=1; }
trap request_desk_reopen USR2
browser_started=0
launch_browser() {
  /usr/local/bin/octo-desktop-browser &
  browser_pid=$!
  browser_started=$SECONDS
}
desk_window_open() { wmctrl -lx 2>/dev/null | grep -q '127\.0\.0\.1__desk'; }
reopen_pid=""
reopen_desk_window() {
  reopen_desk=0
  if [[ -n "$reopen_pid" || -z "$browser_pid" ]] || ! kill -0 "$browser_pid" 2>/dev/null; then return 0; fi
  if (( SECONDS - browser_started < ${OCTO_DESK_REOPEN_GRACE:-20} )) || desk_window_open; then return 0; fi
  echo "hobby-desktop: Desk window closed; reopening" >&2
  timeout 30 /usr/local/bin/octo-desktop-browser &
  reopen_pid=$!
}
watch_desk_window() {
  while true; do
    sleep "${OCTO_DESK_WATCH_INTERVAL:-5}"
    desk_window_open || kill -USR2 "$OCTO_SUPERVISOR_PID" 2>/dev/null || true
  done
}
launch_panel() {
  tint2 -c "$desktop_config/tint2rc" &
  panel_pid=$!
}
export OCTO_SUPERVISOR_PID=$$
password_file="$XDG_RUNTIME_DIR/octogee-openclaw-vnc/password"
python3 - "$password_file" <<'PYTHON'
import os, secrets, string, sys
from pathlib import Path
os.umask(0o077)
Path(sys.argv[1]).write_text(''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(8)) + '\n')
PYTHON
tigervncpasswd -f < "$password_file" > "$XDG_RUNTIME_DIR/vnc-password"
chmod 600 "$XDG_RUNTIME_DIR/vnc-password"
Xvnc :0 -geometry 1440x900 -depth 24 -SecurityTypes VncAuth -PasswordFile "$XDG_RUNTIME_DIR/vnc-password" -localhost -rfbport 5901 &
children+=("$!")
for _ in $(seq 1 100); do
  xdpyinfo >/dev/null 2>&1 && break
  kill -0 "${children[0]}"
  sleep 0.2
done
xdpyinfo >/dev/null
xsetroot -solid '#e9ebef' -cursor_name left_ptr
openbox --config-file "$desktop_config/rc.xml" &
children+=("$!")
/usr/local/bin/octo-desktop-control &
children+=("$!")
HOME=/home/node setsid /usr/local/bin/entrypoint.sh &
gateway_pid=$!
children+=("$gateway_pid")
OPENCLAW_STATE_DIR="$HOME/.openclaw-desktop" OPENCLAW_CONFIG_PATH="$HOME/.openclaw-desktop/openclaw.json" \
  OPENCLAW_GATEWAY_PASSWORD="${OPENCLAW_GATEWAY_TOKEN:?OPENCLAW_GATEWAY_TOKEN is required}" \
  /usr/local/bin/octogee-desktop-node &
children+=("$!")
watch_desk_window &
children+=("$!")
launch_panel
launch_browser
while true; do
  exited=""
  status=0
  wait -n -p exited "${children[@]}" "$browser_pid" "$panel_pid" ${reopen_pid:+"$reopen_pid"} || status=$?
  if [[ ! -v exited ]]; then exited=""; fi
  if [[ -z "$exited" ]] && (( reopen_desk )) && ! (( restart_browser )); then
    reopen_desk_window
  elif [[ -n "$reopen_pid" && "$exited" == "$reopen_pid" ]]; then
    if (( status )); then echo "hobby-desktop: Desk reopen failed (status=$status)" >&2; fi
    reopen_pid=""
  elif [[ "$exited" == "$panel_pid" ]]; then
    echo "hobby-desktop: dock exited (status=$status); restarting" >&2
    sleep 2
    launch_panel
  elif [[ "$exited" == "$browser_pid" || -z "$exited" ]]; then
    if (( restart_browser )); then
      wait "$browser_pid" || true
      restart_browser=0
    elif [[ -z "$exited" ]]; then
      echo "hobby-desktop: wait failed without a process exit (status=$status)" >&2
      exit 1
    else
      echo "hobby-desktop: Chromium exited (status=$status); restarting" >&2
      sleep 2
    fi
    launch_browser
  elif [[ "$exited" == "$gateway_pid" && "$status" == 72 ]]; then
    echo "hobby-desktop: gateway belongs to a rebound VM; stopping for replacement" >&2
    exit 0
  else
    echo "hobby-desktop: required process $exited exited (status=$status)" >&2
    exit 1
  fi
done
