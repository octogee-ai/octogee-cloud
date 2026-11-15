#!/usr/bin/env bash
set -euo pipefail

source_dir="${1:?source directory required}"
destination="${2:?destination directory required}"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

archive="$(npm pack --ignore-scripts --quiet --cache "$scratch/cache" --pack-destination "$scratch" "$source_dir")"
mkdir -p "$destination"
tar --extract --gzip --file "$scratch/$archive" --directory "$destination" --strip-components=1 --no-same-owner
