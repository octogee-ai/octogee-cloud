#!/usr/bin/bash
set -euo pipefail
destination="${1:?wlrctl source directory required}"
version="0.2.2"
sha256="${WLRCTL_SHA256:-9d0654e0a3df08162ec893cde95fb0c46a708df22f3df4629c81e0d37ca87901}"
read -r -a sources <<< "${WLRCTL_SOURCES:-https://deb.debian.org/debian/pool/main/w/wlrctl/wlrctl_${version}.orig.tar.gz https://snapshot.debian.org/file/24ed772d23b51c78ac4727e3ad31674f2159bec9}"
archive="$(mktemp)"
trap 'rm -f "$archive"' EXIT
for source in "${sources[@]}"; do
  if curl -fsSL --retry 2 --connect-timeout 20 --max-time 300 "$source" -o "$archive" \
    && printf '%s  %s\n' "$sha256" "$archive" | sha256sum -c --quiet - >&2; then
    rm -rf "$destination"
    mkdir -p "$destination"
    tar -xzf "$archive" -C "$destination" --strip-components=1
    exit 0
  fi
  echo "wlrctl ${version} was not accepted from ${source}" >&2
done
echo "wlrctl ${version} could not be fetched from any pinned source" >&2
exit 1
