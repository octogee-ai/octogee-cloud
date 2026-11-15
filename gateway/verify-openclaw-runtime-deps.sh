#!/usr/bin/env bash
set -euo pipefail

runtime_root="${OPENCLAW_RUNTIME_DEPS_ROOT:-/opt/openclaw-runtime-deps/npm}"
bundled_root="${OPENCLAW_BUNDLED_PLUGIN_ROOT:-$(npm root -g)/openclaw/dist/extensions}"
required_csv="${1:-mattermost,parallel-plugin,codex}"

if [ ! -d "$runtime_root" ]; then
  echo "FATAL: OpenClaw runtime dependency root is absent: $runtime_root" >&2
  exit 1
fi

IFS=',' read -r -a required_packages <<< "$required_csv"
for package_name in "${required_packages[@]}"; do
  if [ -z "$package_name" ]; then
    echo "FATAL: OpenClaw runtime dependency package list is invalid: $required_csv" >&2
    exit 1
  fi
  package_json="$(find "$runtime_root" -type f -path "*/node_modules/@openclaw/$package_name/package.json" -print -quit)"
  if [ -z "$package_json" ]; then
    bundled_name="$package_name"
    if [ "$package_name" = parallel-plugin ]; then bundled_name=parallel; fi
    package_json="$bundled_root/$bundled_name/package.json"
    if [ ! -f "$package_json" ]; then
      echo "FATAL: @openclaw/$package_name is absent from $runtime_root and $bundled_root" >&2
      exit 1
    fi
  fi
done

echo "OpenClaw runtime dependency gate: PASS ($required_csv)"
