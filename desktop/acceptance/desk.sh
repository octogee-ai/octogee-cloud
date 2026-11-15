#!/usr/bin/env bash
set -euo pipefail

XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR
for signature in "$XDG_RUNTIME_DIR"/hypr/*; do
  [[ -d "$signature" ]] && export HYPRLAND_INSTANCE_SIGNATURE="${signature##*/}"
done
[[ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]] || { echo "desk: no Hyprland instance signature under $XDG_RUNTIME_DIR/hypr" >&2; exit 1; }

control="http://127.0.0.1:7777"
default_note="This is my computer. Watch me work here, or take the controls whenever you like."
policy=/etc/chromium/policies/managed/octogee-desk.json

fail() { echo "desk: $*" >&2; exit 1; }
post() { curl -fsS -X POST -H 'content-type: application/json' -d "$2" "$control$1"; }

html="$(curl -fsS "$control/desk")" || fail "/desk did not answer"
grep -qi '<!doctype html>' <<<"$html" || fail "/desk is not an HTML page"
grep -q '/desk/desk.js' <<<"$html" || fail "/desk does not load the Desk script"

state="$(curl -fsS "$control/desk/state")" || fail "/desk/state did not answer"
note="$(jq -r .note <<<"$state")"
[[ "$note" == "$default_note" ]] || fail "default note is: $note"
jq -e '.characterSvg | startswith("<svg")' <<<"$state" >/dev/null || fail "/desk/state carries no character SVG"
jq -e '.look.style and .look.color' <<<"$state" >/dev/null || fail "/desk/state carries no look"

apps="$(curl -fsS "$control/apps")" || fail "/apps did not answer"
for id in chromium org.gnome.Nautilus; do
  jq -e --arg id "$id" 'any(.[]; .id == $id)' <<<"$apps" >/dev/null || fail "/apps does not list $id: $(jq -c '[.[].id]' <<<"$apps")"
done
icon="$(jq -r '.[] | select(.id == "chromium") | .icon' <<<"$apps")"
[[ "$icon" == /apps/icon/chromium ]] || fail "chromium has no resolvable icon: $icon"
curl -fsS -o /dev/null "$control$icon" || fail "$icon did not serve"

marker="desk acceptance $(date +%s)"
post /desk/note "$(jq -cn --arg note "$marker" '{note: $note}')" >/dev/null || fail "POST /desk/note failed"
[[ "$(curl -fsS "$control/desk/state" | jq -r .note)" == "$marker" ]] || fail "note did not round-trip through /desk/state"
[[ "$(jq -r .note "$HOME/.config/octogee/desk.json")" == "$marker" ]] || fail "desk.json does not hold the note"
post /desk/note "$(jq -cn --arg note "$default_note" '{note: $note}')" >/dev/null || fail "restoring the default note failed"
rejected="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"id":"../etc/passwd"}' "$control/launch")"
[[ "$rejected" == 400 ]] || fail "POST /launch accepted a bad id (HTTP $rejected)"
plain="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: text/plain' -d '{"note":"forged"}' "$control/desk/note")"
[[ "$plain" == 403 ]] || fail "POST /desk/note took a text/plain body (HTTP $plain)"
cross_origin="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'origin: https://attacker.example' -d '{"note":"forged"}' "$control/desk/note")"
[[ "$cross_origin" == 403 ]] || fail "POST /desk/note took a request from another origin (HTTP $cross_origin)"

zone_before="$(timedatectl show -p Timezone --value)"
post /timezone '{"timeZone":"Pacific/Auckland"}' >/dev/null || fail "POST /timezone failed"
[[ "$(timedatectl show -p Timezone --value)" == Pacific/Auckland ]] || fail "system time zone did not change: $(timedatectl show -p Timezone --value)"
[[ "$(curl -fsS "$control/timezone" | jq -r .timeZone)" == Pacific/Auckland ]] || fail "GET /timezone disagrees with timedatectl"
post /timezone "$(jq -cn --arg zone "$zone_before" '{timeZone: $zone}')" >/dev/null || fail "restoring the time zone $zone_before failed"
rejected_zone="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"timeZone":"../../etc/passwd"}' "$control/timezone")"
[[ "$rejected_zone" == 400 ]] || fail "POST /timezone accepted a bad zone (HTTP $rejected_zone)"
desk_zone="$(jq -r '.timeZone // empty' "$HOME/.config/octogee/desk.json")"
[[ -z "$desk_zone" || "$desk_zone" == "$(timedatectl show -p Timezone --value)" ]] || fail "system zone $(timedatectl show -p Timezone --value) differs from desk.json $desk_zone"

desk_class="chrome-127.0.0.1__desk-Default"
desk_window="$(hyprctl -j clients | jq -c --arg c "$desk_class" '[.[] | select(.class == $c)][0] | {floating, title}')"
[[ "$desk_window" == *'"floating":true'* ]] || fail "the Desk app window ($desk_class) is missing or not floating: $(hyprctl -j clients | jq -c '[.[] | {class, floating}]')"
browser_windows="$(hyprctl -j clients | jq '[.[] | select(.class | test("^chromium$"; "i"))] | length')"
[[ "$browser_windows" == 0 ]] || fail "$browser_windows normal browser window(s) open at session start"

sleep 5
idle="$(top -bn2 -d5 | grep -F 'Cpu(s)' | tail -1 | awk '{print $8}')"
awk -v idle="$idle" 'BEGIN { exit !(idle + 0 >= 85) }' || fail "the Desk keeps the compositor busy: ${idle}% idle with the Desk in front (need 85%)"

[[ -f "$policy" ]] || fail "Chromium policy $policy is missing"
[[ "$(jq -r .HomepageLocation "$policy")" == "$control/desk" ]] || fail "policy homepage is $(jq -r .HomepageLocation "$policy")"
[[ "$(jq -r .NewTabPageLocation "$policy")" == "$control/desk" ]] || fail "policy new tab is $(jq -r .NewTabPageLocation "$policy")"
tabs="$(curl -fsS http://127.0.0.1:9222/json)" || fail "Chromium's debugging port did not answer"
jq -e --arg url "$control/desk" 'any(.[]; .type == "page" and .url == $url)' <<<"$tabs" >/dev/null \
  || fail "Chromium is not showing the Desk: $(jq -c '[.[] | select(.type == "page") | .url]' <<<"$tabs")"
title="$(jq -r --arg url "$control/desk" '[.[] | select(.type == "page" and .url == $url) | .title][0]' <<<"$tabs")"

printf 'desk: app window %s floating with no browser window, page served, default note, %s apps with chromium + Nautilus, note round trip, launch validated, time zone round trip (%s), idle %s%% with the Desk in front, Chromium policy homepage on "%s"\n' "$desk_class" "$(jq length <<<"$apps")" "${desk_zone:-not set yet}" "$idle" "$title"
