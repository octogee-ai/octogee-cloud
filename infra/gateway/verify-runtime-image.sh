#!/usr/bin/env bash
set -euo pipefail

profile="${1:?image profile required: gateway or isolated}"
runtime_root="${OPENCLAW_RUNTIME_DEPS_ROOT:-/opt/openclaw-runtime-deps/npm}"
global_root="${NPM_GLOBAL_ROOT:-$(npm root -g)}"
tool_bin="${OCTOGEE_TOOL_BIN_DIR:-/usr/local/bin}"
chromium_bin="${OCTOGEE_CHROMIUM_BIN:-/usr/bin/chromium}"

fail() {
  echo "FATAL: $*" >&2
  exit 1
}

staged_plugin() {
  [ -n "$(find "$runtime_root" -type d -path "*/node_modules/@openclaw/$1" -print -quit)" ]
}

case "$profile" in
  gateway|isolated) ;;
  *) fail "unknown image profile: $profile" ;;
esac

test -d "$runtime_root" || fail "OpenClaw runtime dependency root is absent: $runtime_root"
test -f "$global_root/openclaw/dist/extensions/mattermost/package.json" \
  || fail "Mattermost is not bundled under $global_root/openclaw/dist/extensions"
! staged_plugin mattermost || fail "@openclaw/mattermost must not be staged under $runtime_root"
test -f "$global_root/openclaw/dist/extensions/codex/package.json" \
  || fail "Codex is not bundled under $global_root/openclaw/dist/extensions"
! staged_plugin codex || fail "@openclaw/codex must not be staged under $runtime_root"
test -f "$global_root/openclaw/dist/extensions/parallel/package.json" \
  || fail "Parallel is not bundled under $global_root/openclaw/dist/extensions"
! staged_plugin parallel-plugin || fail "@openclaw/parallel-plugin must not be staged under $runtime_root"
test -e "$global_root/@anthropic-ai/claude-code" || fail "@anthropic-ai/claude-code is absent from $global_root"
test -e "$global_root/@openai/codex" || fail "@openai/codex is absent from $global_root"
test -x "$tool_bin/claude" || fail "$tool_bin/claude is not executable"
"$tool_bin/claude" --version >/dev/null || fail "claude --version failed"
test -x "$tool_bin/codex" || fail "$tool_bin/codex is not executable"
test ! -e "$global_root/@sparticuz/chromium" || fail "@sparticuz/chromium must not be installed under $global_root"
test -x "$chromium_bin" || fail "$chromium_bin is not executable"

if [ "$profile" = isolated ]; then
  for name in \
    OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256 \
    OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_LOCK_PATH \
    OCTOGEE_BUILDER_TOOL_GROUPS_SHA256 \
    OCTOGEE_BUILDER_TOOL_GROUPS_PATH; do
    test -n "${!name:-}" || fail "$name is unset in the isolated image"
  done
  echo "$OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256  $OCTOGEE_BUILDER_TOOLCHAIN_PACKAGE_LOCK_PATH" | sha256sum -c - >/dev/null \
    || fail "Isolated toolchain lock does not match OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256"
  echo "$OCTOGEE_BUILDER_TOOL_GROUPS_SHA256  $OCTOGEE_BUILDER_TOOL_GROUPS_PATH" | sha256sum -c - >/dev/null \
    || fail "Isolated tool groups do not match OCTOGEE_BUILDER_TOOL_GROUPS_SHA256"
fi

echo "OpenClaw runtime image gate: PASS ($profile)"
