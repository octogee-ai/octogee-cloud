#!/usr/bin/env bash
set -euo pipefail
export OPENCLAW_STATE_DIR=/home/node/gateway-state
export OPENCLAW_GATEWAY_PASSWORD="$(cat /home/node/runtime/password)"
exec openclaw "$@"
