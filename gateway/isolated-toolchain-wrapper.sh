#!/bin/sh
exec /octogee/scripts/node_modules/.bin/tsx \
  /octogee/scripts/entrypoints/isolated-toolchain-command.ts \
  "$(basename "$0")" "$@"
