#!/usr/bin/env bash
set -euo pipefail

: "${OCTOGEE_DESKTOP_NODE_IDENTITY_PATH:?OCTOGEE_DESKTOP_NODE_IDENTITY_PATH is required}"
identity="$OCTOGEE_DESKTOP_NODE_IDENTITY_PATH"
identity_pending="${identity}.pending"
node_pid=""
cleanup() {
  rm -f -- "$identity" "$identity_pending"
  if [ -n "$node_pid" ] && kill -0 "$node_pid" 2>/dev/null; then
    kill -TERM "$node_pid"
    wait "$node_pid" || true
  fi
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
rm -f -- "$identity" "$identity_pending"

: "${OCTOGEE_DESKTOP_NODE_NAME:?OCTOGEE_DESKTOP_NODE_NAME is required}"
: "${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR is required}"
: "${OPENCLAW_GATEWAY_PASSWORD:?OPENCLAW_GATEWAY_PASSWORD is required}"

if [ "${GATEWAY_COMPUTER_DESKTOP:-omarchy}" = x11 ]; then
  command -v xdotool >/dev/null
else
  if ! command -v wtype >/dev/null 2>&1; then
    echo "desktop-node: wtype is required for CUA Wayland keyboard input" >&2
    exit 1
  fi
fi
if ! command -v dbus-send >/dev/null 2>&1; then
  echo "desktop-node: dbus-send is required to reach the desktop's accessibility bus" >&2
  exit 1
fi

export HOME="${HOME:-/home/node}"
state="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
mkdir -p "$state"
chmod 00700 "$state"
node --input-type=module - "$state/openclaw.json" <<'JS'
import fs from "node:fs";
const file = process.argv[2];
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
config.plugins ??= {};
config.plugins.entries ??= {};
config.plugins.entries["cua-computer"] = { enabled: true };
config.nodeHost ??= {};
config.nodeHost.browserProxy = { enabled: false };
config.desktop = { host: {
  enabled: true, managed: false, port: 5901,
  passwordFile: `${process.env.XDG_RUNTIME_DIR}/octogee-openclaw-vnc/password`,
} };
fs.writeFileSync(file, JSON.stringify(config) + "\n", { mode: 0o600 });
JS

wayland_socket() {
  ls "$XDG_RUNTIME_DIR" 2>/dev/null | grep -E '^wayland-[0-9]+$' | head -n1
}
if [ "${GATEWAY_COMPUTER_DESKTOP:-omarchy}" = x11 ]; then
  export DISPLAY="${DISPLAY:-:0}" XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=Openbox
  unset WAYLAND_DISPLAY CUA_DRIVER_RS_ENABLE_WAYLAND
  until xdpyinfo >/dev/null 2>&1; do
    echo "desktop-node: waiting for X11 on $DISPLAY"
    sleep 2
  done
else
until socket="$(wayland_socket)" && [ -n "$socket" ]; do
  echo "desktop-node: waiting for a Wayland socket in $XDG_RUNTIME_DIR"
  sleep 2
done
export WAYLAND_DISPLAY="$socket"
export DISPLAY="${DISPLAY:-:0}"
export XDG_SESSION_TYPE=wayland
export XDG_CURRENT_DESKTOP=Hyprland
export CUA_DRIVER_RS_ENABLE_WAYLAND=1
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

fi

until dbus-send --session --print-reply --reply-timeout=5000 --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress >/dev/null; do
  echo "desktop-node: waiting for the accessibility bus (org.a11y.Bus) on $DBUS_SESSION_BUS_ADDRESS"
  sleep 2
done

gateway_checks=0
until curl -fsS --max-time 2 http://127.0.0.1:18789/healthz >/dev/null 2>&1; do
  if [ $((gateway_checks % 30)) -eq 0 ]; then
    echo "desktop-node: waiting for the gateway on 127.0.0.1:18789 (${gateway_checks} checks so far)"
  fi
  gateway_checks=$((gateway_checks + 1))
  sleep 2
done

openclaw doctor --lint --only cua-computer/driver-artifacts
openclaw node run --host 127.0.0.1 --port 18789 --display-name "$OCTOGEE_DESKTOP_NODE_NAME" &
node_pid=$!
attempt=0
until openclaw node identity --json > "$identity_pending"; do
  attempt=$((attempt + 1))
  if ! kill -0 "$node_pid" 2>/dev/null || [ "$attempt" -ge 60 ]; then
    echo "desktop-node: native public identity was not available after startup" >&2
    exit 1
  fi
  sleep 2
done
node --input-type=module - "$identity_pending" "$identity" <<'JS'
import { createHash } from "node:crypto";
import fs from "node:fs";
const pending = process.argv[2];
const identity = JSON.parse(fs.readFileSync(pending, "utf8"));
const { deviceId, publicKey } = identity;
if (Object.keys(identity).sort().join(",") !== "deviceId,publicKey" ||
  typeof deviceId !== "string" || !/^[a-f0-9]{64}$/u.test(deviceId) ||
  typeof publicKey !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(publicKey)) throw new Error("desktop-node: invalid native public identity");
const key = Buffer.from(publicKey, "base64url");
if (key.toString("base64url") !== publicKey || createHash("sha256").update(key).digest("hex") !== deviceId) throw new Error("desktop-node: native public identity fingerprint mismatch");
fs.chmodSync(pending, 0o644);
fs.renameSync(pending, process.argv[3]);
JS
wait "$node_pid"
