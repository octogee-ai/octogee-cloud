#!/usr/bin/env bash
set -euo pipefail
children=()
cleanup() {
  trap '' TERM INT
  for pid in "${children[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  wait || true
}
trap cleanup EXIT
trap 'exit 143' TERM INT
python3 - <<'PY'
import json, os, secrets
from pathlib import Path
home = Path('/home/node')
password = secrets.token_hex(4)
(home / 'runtime/password').write_text(password)
(home / 'runtime/password').chmod(0o600)
common = {'gateway': {'mode': 'local', 'auth': {'mode': 'password', 'password': password}}, 'plugins': {'allow': ['browser', 'cua-computer'], 'entries': {'browser': {'enabled': True}, 'cua-computer': {'enabled': True}}}}
gateway = {**common, 'tools': {'profile': 'full'}, 'browser': {'enabled': True, 'defaultProfile': 'computer', 'attachOnly': True, 'headless': False, 'cdpUrl': 'http://127.0.0.1:9222', 'evaluateEnabled': True, 'ssrfPolicy': {'dangerouslyAllowPrivateNetwork': True}, 'profiles': {'computer': {'driver': 'openclaw', 'cdpUrl': 'http://127.0.0.1:9222', 'attachOnly': True}}}, 'agents': {'entries': {'bench': {'workspace': '/home/node/workspace'}}}}
gateway['gateway']['nodes'] = {'browser': {'mode': 'off'}}
gateway['models'] = {'mode': 'merge', 'providers': {'fixture': {'baseUrl': 'http://127.0.0.1:18181/v1', 'apiKey': 'benchmark-fixture', 'api': 'openai-completions', 'models': [{'id': 'fixture', 'name': 'Benchmark fixture', 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 128000, 'maxTokens': 4096}]}}}
gateway['agents']['entries']['bench']['model'] = {'primary': 'fixture/fixture'}
node = {'gateway': common['gateway'], 'plugins': {'allow': ['cua-computer'], 'entries': {'cua-computer': {'enabled': True}}}, 'nodeHost': {'browserProxy': {'enabled': False}}, 'desktop': {'host': {'enabled': True, 'managed': False, 'port': 5901, 'passwordFile': '/home/node/runtime/password'}}}
for name, config in [('gateway-state', gateway), ('node-state', node)]:
    path = home / name / 'openclaw.json'
    path.write_text(json.dumps(config)); path.chmod(0o600)
PY
export OPENCLAW_GATEWAY_PASSWORD="$(cat "$HOME/runtime/password")"
printf '%s\n' "$OPENCLAW_GATEWAY_PASSWORD" | tigervncpasswd -f > "$HOME/runtime/vnc-password"
chmod 600 "$HOME/runtime/vnc-password"
Xvnc :0 -geometry 1440x900 -depth 24 -SecurityTypes VncAuth \
  -PasswordFile "$HOME/runtime/vnc-password" -localhost -rfbport 5901 > "$HOME/results/xvnc.log" 2>&1 &
children+=("$!")
for _ in $(seq 1 100); do xdpyinfo >/dev/null 2>&1 && break; sleep 0.2; done
xdpyinfo >/dev/null
openbox > "$HOME/results/openbox.log" 2>&1 &
children+=("$!")
python3 /benchmark/control.py > "$HOME/results/control.log" 2>&1 &
children+=("$!")
python3 /benchmark/agent-model.py > "$HOME/results/model.log" 2>&1 &
children+=("$!")
chromium --ozone-platform=x11 --disable-gpu --force-renderer-accessibility \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chromium-profile" --no-first-run --no-default-browser-check \
  --password-store=basic http://127.0.0.1:7777/fixture > "$HOME/results/chromium.log" 2>&1 &
children+=("$!")
OPENCLAW_STATE_DIR="$HOME/gateway-state" openclaw gateway run --allow-unconfigured > "$HOME/results/gateway.log" 2>&1 &
children+=("$!")
for _ in $(seq 1 300); do curl -fsS http://127.0.0.1:18789/healthz >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:18789/healthz >/dev/null
OPENCLAW_STATE_DIR="$HOME/node-state" openclaw node run --host 127.0.0.1 --port 18789 --display-name octogee-desktop > "$HOME/results/node.log" 2>&1 &
children+=("$!")
node /benchmark/pair.mjs > "$HOME/results/pairing.log" 2>&1
curl -fsS http://127.0.0.1:9222/json/version > "$HOME/results/chromium-version.json"
date -u +%FT%TZ > "$HOME/results/ready"
printf 'Hobby benchmark ready\n'
wait -n "${children[@]}"
printf 'ERROR: a benchmark runtime process exited\n' >&2
exit 1
