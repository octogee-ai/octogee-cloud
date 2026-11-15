#!/usr/bin/env bash
set -euo pipefail

FORK_DIR="${1:-$HOME/workspace/openclaw/openclaw}"
OUT_DIR="${2:-/tmp/openclaw-fork}"
cd "$FORK_DIR"

RAW_DIR="$(mktemp -d -t openclaw-mattermost-raw-XXXXXX)"
STAGE_DIR="$(mktemp -d -t openclaw-mattermost-stage-XXXXXX)"
cleanup() { rm -rf "$RAW_DIR" "$STAGE_DIR"; }
trap cleanup EXIT

OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR="$RAW_DIR" \
  bash scripts/plugin-npm-publish.sh --pack extensions/mattermost >&2

set -- "$RAW_DIR"/openclaw-mattermost-*.tgz
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "FATAL: Mattermost pack must emit exactly one tarball" >&2
  exit 1
fi
tar -xzf "$1" -C "$STAGE_DIR"
if [ ! -f "$STAGE_DIR/package/dist/index.js" ]; then
  echo "FATAL: Mattermost artifact is missing compiled runtime output" >&2
  exit 1
fi
mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/openclaw-mattermost-[0-9]*.tgz
(
  cd "$STAGE_DIR/package"
  npm pack --ignore-scripts --pack-destination "$OUT_DIR" >&2
)
set -- "$OUT_DIR"/openclaw-mattermost-*.tgz
if [ "$#" -ne 1 ] || [ ! -f "$1" ]; then
  echo "FATAL: Mattermost repack must emit exactly one tarball" >&2
  exit 1
fi
echo "$1"
