#!/usr/bin/env bash
set -euo pipefail

: "${OPENCLAW_GATEWAY_TOKEN:?run inside the gateway VM gateway container}"
node_name="${OCTOGEE_DESKTOP_NODE_NAME:-octogee-desktop}"
control_url="${GATEWAY_COMPUTER_CONTROL_URL:-http://127.0.0.1:7777}"
target_url="${OCTOGEE_ACCEPT_TARGET_URL:-https://example.com/}"
expected_title="${OCTOGEE_ACCEPT_EXPECTED_TITLE:-Example Domain}"

export OPENCLAW_GATEWAY_PASSWORD="$OPENCLAW_GATEWAY_TOKEN"
OPENCLAW_STATE_DIR="$(mktemp -d)"
export OPENCLAW_STATE_DIR
trap 'rm -rf "$OPENCLAW_STATE_DIR"' EXIT
printf '{"gateway":{"auth":{"mode":"password"}}}\n' > "$OPENCLAW_STATE_DIR/openclaw.json"

oc() { openclaw "$@" --json; }

chromium_title() {
  curl -fsS "$control_url/windows" | jq -r '.[] | select(.class | test("chromium"; "i")) | .title' | head -n1
}

status="$(oc nodes status --connected)"
node_json="$(printf '%s' "$status" | jq -c --arg name "$node_name" '.nodes[] | select(.displayName == $name)')"
if [ -z "$node_json" ]; then
  echo "no connected node named $node_name"
  printf '%s\n' "$status"
  exit 1
fi
if ! printf '%s' "$node_json" | jq -e '.paired == true and (.commands | index("computer.act")) != null and (.commands | index("screen.snapshot")) != null' >/dev/null; then
  echo "$node_name is not paired with computer.act and screen.snapshot"
  printf '%s\n' "$node_json"
  exit 1
fi
node_id="$(printf '%s' "$node_json" | jq -r '.nodeId')"

execution_id="$(cat /proc/sys/kernel/random/uuid)"
act() {
  local params
  params="$(jq -c --arg id "$execution_id" '. + {executionId: $id}' <<< "$1")"
  oc nodes invoke --node "$node_id" --command computer.act --invoke-timeout 30000 --params "$params"
}

cleanup() {
  local status=$?
  if ! act '{"action":"__close_execution","reason":"acceptance-complete"}' >/dev/null; then
    echo "native computer acceptance: execution cleanup failed" >&2
    status=1
  fi
  rm -rf "$OPENCLAW_STATE_DIR"
  exit "$status"
}
trap cleanup EXIT

echo "native computer acceptance: screenshot"
oc nodes invoke --node "$node_id" --command screen.snapshot --invoke-timeout 30000 \
  --params "$(jq -cn --arg id "$execution_id" '{executionId: $id}')" \
  | jq -e '(.payload // (.payloadJSON | fromjson)).displayFrameId' >/dev/null

title_before="$(chromium_title)"
echo "native computer acceptance: keyboard navigation"
act '{"action":"key","keys":"ctrl+l"}' >/dev/null
act "$(jq -cn --arg url "$target_url" '{action: "type", text: $url}')" >/dev/null
act '{"action":"key","keys":"Return"}' >/dev/null

title_after=""
for _ in $(seq 1 40); do
  title_after="$(chromium_title)"
  [[ "$title_after" == *"$expected_title"* ]] && break
  sleep 0.5
done

printf 'node=%s before=%q after=%q\n' "$node_id" "$title_before" "$title_after"
if [[ "$title_after" != *"$expected_title"* ]]; then
  echo "native computer acceptance failed: Chromium did not navigate through computer.act"
  exit 1
fi

echo "native computer acceptance: accessibility tree"
act_payload() { act "$1" | jq -c '(.payload // (.payloadJSON | fromjson))'; }
desktop_tree="$(act_payload '{"action":"get_accessibility_tree"}')"
if ! jq -e --arg title "$expected_title" '.details.windows | any((.title // "") | contains($title))' <<< "$desktop_tree" >/dev/null; then
  echo "native computer acceptance failed: get_accessibility_tree does not list the Chromium window"
  printf '%s\n' "$desktop_tree"
  exit 1
fi
window_ref="$(act_payload '{"action":"list_windows"}' \
  | jq -r --arg title "$expected_title" '[.details.windows[] | select((.title // "") | contains($title))][0].windowRef // empty')"
if [ -z "$window_ref" ]; then
  echo "native computer acceptance failed: list_windows has no Chromium window titled $expected_title"
  exit 1
fi
window_tree="$(act_payload "$(jq -cn --arg ref "$window_ref" '{action: "get_window_state", windowRef: $ref, includeScreenshot: false}')")"
if ! jq -e '(.details.degraded // false) == false and ((.observation.elements // []) | length) > 0' <<< "$window_tree" >/dev/null; then
  echo "native computer acceptance failed: the Chromium window has no accessibility elements"
  printf '%s\n' "$window_tree"
  exit 1
fi
printf 'accessibility elements=%s\n' "$(jq '.observation.elements | length' <<< "$window_tree")"

echo "native computer acceptance: pointer input"
pointer="$(oc nodes invoke --node "$node_id" --command screen.snapshot --invoke-timeout 30000 \
  --params "$(jq -cn --arg id "$execution_id" '{executionId: $id}')" \
  | jq -c '(.payload // (.payloadJSON | fromjson)) | {displayFrameId, refWidth: .width, x: (.width * 0.9 | floor), y: (.height * 0.9 | floor)}')"
act "$(jq -c '. + {action: "mouse_move"}' <<< "$pointer")" >/dev/null
act "$(jq -c '. + {action: "left_click"}' <<< "$pointer")" >/dev/null
echo "native computer acceptance ok"
