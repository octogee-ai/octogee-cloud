#!/bin/sh
set -eu

case "${1:-}" in
  */entrypoints/*.ts)
    scripts_root=${1%/entrypoints/*.ts}
    entrypoint=${1##*/}
    stem=${entrypoint%.ts}
    for dir in "${scripts_root}/bundled-entrypoints" "${scripts_root}/shared-runners"; do
      bundled="${dir}/${stem}.mjs"
      if [ -f "$bundled" ]; then
        shift
        exec node "$bundled" "$@"
      fi
    done
    exec "${scripts_root}/node_modules/.bin/tsx" "$@"
    ;;
esac
exec /octogee/scripts/node_modules/.bin/tsx "$@"
