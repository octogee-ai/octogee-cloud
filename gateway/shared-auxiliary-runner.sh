#!/bin/sh
set -eu

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--v8-pool-size=1"
export UV_THREADPOOL_SIZE=1
export GOMAXPROCS=1

case "${1:-}" in
  /octogee/scripts/entrypoints/*.ts) entrypoint=${1##*/} ;;
  *) printf 'Expected a Shared runner entrypoint\n' >&2; exit 2 ;;
esac
shift
exec node "/octogee/scripts/shared-runners/${entrypoint%.ts}.mjs" "$@"
