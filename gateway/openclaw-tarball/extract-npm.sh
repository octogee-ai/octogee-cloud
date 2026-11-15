#!/usr/bin/env bash
set -euo pipefail

archive="${1:?OpenClaw fork tarball required}"
destination="$(dirname "$archive")/npm-fork.tgz"
rm -f "$destination"
temporary="$(mktemp "${destination}.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
tar -xOf "$archive" package/vendor/npm.tgz > "$temporary"
if [[ ! -s "$temporary" ]]; then
  echo "Missing vendored npm archive in $archive" >&2
  exit 1
fi
chmod 644 "$temporary"
mv -f "$temporary" "$destination"
