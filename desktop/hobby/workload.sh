#!/usr/bin/env bash
set -euo pipefail
phase() { printf '%s\n' "$1" > /home/node/results/phase; }
phase idle
sleep 30
phase native
node /benchmark/native.mjs
cp /home/node/results/native.json /home/node/results/native-idle.json
phase browser-tool
OPENCLAW_PACKAGE_DIR=/usr/local/lib/node_modules/openclaw \
  OCTOGEE_ACCEPT_ISOLATED_COMPUTER=1 OCTOGEE_ACCEPT_PHASE="${BENCH_BROWSER_PHASE:-seed}" \
  OCTOGEE_ACCEPT_OUTPUT=/home/node/results/browser \
  node "${BENCH_ACCEPTANCE_ROOT:-/benchmark}/desktop/acceptance/openclaw-browser.mts" > /home/node/results/browser.log 2>&1
python3 /benchmark/desktop-apps.py
phase multi-tab
node /benchmark/browser-load.mjs
phase agent-turn
/benchmark/oc.sh agent --agent bench --session-id "hobby-${BENCH_CASE:-run}-$(date +%s)" \
  --message 'Create the benchmark tasks file with the exec tool.' --json > /home/node/results/agent-turn.json
test "$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/home/node/workspace/tasks.json")).length)')" = 10000
phase multi-tab-idle
sleep 60
phase loaded-native
BENCH_NATIVE_KEEP_PAGE=1 BENCH_MIN_ACCESSIBILITY_ELEMENTS=1000 node /benchmark/native.mjs
cp /home/node/results/native.json /home/node/results/native-loaded.json
phase complete
python3 /benchmark/summarize.py /home/node/results/samples.jsonl > /home/node/results/summary.json
