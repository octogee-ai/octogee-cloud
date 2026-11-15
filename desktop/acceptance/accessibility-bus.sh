#!/usr/bin/env bash
set -euo pipefail

export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
address="$(busctl --user --json=short call org.a11y.Bus /org/a11y/bus org.a11y.Bus GetAddress | jq -r '.data[0]')"
[[ -n "$address" ]] || { echo "org.a11y.Bus returned no accessibility bus address" >&2; exit 1; }

registered_apps() {
  busctl --address="$address" --json=short call org.a11y.atspi.Registry /org/a11y/atspi/accessible/root \
    org.a11y.atspi.Accessible GetChildren \
    | jq -r '.data[0][] | "\(.[0]) \(.[1])"' \
    | while read -r bus path; do
        busctl --address="$address" --json=short get-property "$bus" "$path" org.a11y.atspi.Accessible Name | jq -r '.data'
      done
}

apps=""
for _ in $(seq 1 30); do
  apps="$(registered_apps)"
  grep -qix chromium <<< "$apps" && break
  sleep 1
done
if ! grep -qix chromium <<< "$apps"; then
  echo "Chromium never registered on the accessibility bus at $address; registered: ${apps:-none}" >&2
  exit 1
fi
printf 'accessibility bus %s serves: %s\n' "$address" "$(paste -sd, <<< "$apps")"
