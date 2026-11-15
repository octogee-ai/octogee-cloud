#!/usr/bin/env bash
set -euo pipefail

XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR
for signature in "$XDG_RUNTIME_DIR"/hypr/*; do
  [[ -d "$signature" ]] && export HYPRLAND_INSTANCE_SIGNATURE="${signature##*/}"
done
[[ -n "${HYPRLAND_INSTANCE_SIGNATURE:-}" ]] || { echo "no Hyprland instance signature under $XDG_RUNTIME_DIR/hypr" >&2; exit 1; }
export OMARCHY_PATH="${OMARCHY_PATH:-/usr/share/omarchy}"
share="$OMARCHY_PATH/octo-desktop"
shell_json="$HOME/.config/omarchy/shell.json"

fail() { echo "familiar desktop: $*" >&2; exit 1; }
config_errors() {
  local errors
  errors="$(hyprctl configerrors 2>/dev/null || true)"
  [[ -z "$errors" || "$errors" == "no errors" ]] || fail "hyprctl configerrors after $1: $errors"
}
hyprland_pid() { pgrep -xu "$(id -u)" Hyprland | head -n1; }
familiar_title_bars_loaded() { grep -qF "$share/hyprbars.so" "/proc/$(hyprland_pid)/maps"; }
title_bar_plugins() {
  printf 'plugins: %s; mapped: %s' "$(hyprctl plugins list | tr '\n' ' ')" \
    "$(grep -oE '/[^ ]*(hyprbars|titlebars)[^ ]*\.so' "/proc/$(hyprland_pid)/maps" | sort -u | tr '\n' ' ')"
}
expect_style() {
  local style
  style="$(octo-desktop-style status)"
  [[ "$style" == "$1" ]] || fail "style is $style, expected $1"
}

expect_style familiar
config_errors "boot"
grep -Fq 'require("octo-desktop.familiar")' "$HOME/.config/hypr/hyprland.lua" || fail "hyprland.lua does not require octo-desktop.familiar"
familiar_title_bars_loaded || fail "Familiar's hyprbars.so is not loaded in Hyprland ($(title_bar_plugins))"
[[ "$(cat "$HOME/.local/state/omarchy/current/theme.name")" == octogee ]] || fail "theme is $(cat "$HOME/.local/state/omarchy/current/theme.name"), expected octogee"
readlink -f "$HOME/.local/state/omarchy/current/background" | grep -q '/[0-9]*-quattro\.' || fail "background is not the Quattro wallpaper: $(readlink -f "$HOME/.local/state/omarchy/current/background")"
for id in rdf.dock community.window-switcher; do
  [[ "$(readlink "$HOME/.config/omarchy/plugins/$id")" == "$share/plugins/$id" ]] || fail "plugin $id is not linked from the image"
  jq -e --arg id "$id" 'any(.plugins[]; .id == $id)' "$shell_json" >/dev/null || fail "shell.json does not enable $id"
done
for entry in $(jq -r '.plugins[] | select(.id == "rdf.dock") | .items[] | .desktop // empty' "$shell_json"); do
  [[ -f "/usr/share/applications/$entry.desktop" || -f "$HOME/.local/share/applications/$entry.desktop" ]] || fail "dock pins $entry but no desktop entry exists"
done
for _ in $(seq 1 30); do
  reserved_bottom="$(hyprctl -j monitors | jq '.[0].reserved[3]')"
  [[ "$reserved_bottom" =~ ^[0-9]+$ && "$reserved_bottom" -gt 0 ]] && break
  sleep 1
done
[[ "$reserved_bottom" =~ ^[0-9]+$ && "$reserved_bottom" -gt 0 ]] || fail "the dock reserves no space at the bottom edge (reserved: $(hyprctl -j monitors | jq -c '.[0].reserved'))"
chromium="$(hyprctl -j clients | jq -c '[.[] | select(.class | test("chrom"; "i"))][0] | {class, floating, size}')"
[[ "$chromium" == *'"floating":true'* ]] || fail "Chromium is not floating: $chromium"

octo-desktop-style omarchy || fail "octo-desktop-style omarchy failed"
expect_style omarchy
config_errors "switching to omarchy"
grep -Fq 'octo-desktop.familiar' "$HOME/.config/hypr/hyprland.lua" && fail "hyprland.lua still requires octo-desktop.familiar after switching to omarchy"
[[ "$(cat "$HOME/.local/state/omarchy/current/theme.name")" == tokyo-night ]] || fail "theme after omarchy is $(cat "$HOME/.local/state/omarchy/current/theme.name")"
jq -e 'all(.plugins[]; .id != "rdf.dock" and .id != "community.window-switcher")' "$shell_json" >/dev/null || fail "shell.json still enables the Familiar plugins"
! familiar_title_bars_loaded || fail "Familiar's hyprbars.so is still loaded after switching to omarchy ($(title_bar_plugins))"

octo-desktop-style familiar || fail "octo-desktop-style familiar failed"
expect_style familiar
config_errors "switching back to familiar"
[[ "$(cat "$HOME/.local/state/omarchy/current/theme.name")" == octogee ]] || fail "theme after returning to familiar is $(cat "$HOME/.local/state/omarchy/current/theme.name")"

sleep 5
idle="$(top -bn2 -d5 | grep -F 'Cpu(s)' | tail -1 | awk '{print $8}')"
printf 'familiar desktop: hyprbars loaded, theme octogee on %s, dock visible reserving %spx + switcher linked, Chromium %s, omarchy round trip clean, idle %s%%\n' \
  "$(basename "$(readlink -f "$HOME/.local/state/omarchy/current/background")")" "$reserved_bottom" "$chromium" "$idle"
