#!/usr/bin/bash
set -euo pipefail
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
protocol="${1:?virtual keyboard protocol XML required}"
output="${2:?output binary path required}"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
wayland-scanner client-header "$protocol" "$build_dir/virtual-keyboard-client-protocol.h"
wayland-scanner private-code "$protocol" "$build_dir/virtual-keyboard-protocol.c"
pointer_protocol="$(dirname "$protocol")/wlr-virtual-pointer-unstable-v1.xml"
wayland-scanner client-header "$pointer_protocol" "$build_dir/virtual-pointer-client-protocol.h"
wayland-scanner private-code "$pointer_protocol" "$build_dir/virtual-pointer-protocol.c"
cc -Wall -Wextra -Werror -O2 -I"$build_dir" \
  "$source_dir/seat-input.c" "$build_dir/virtual-keyboard-protocol.c" "$build_dir/virtual-pointer-protocol.c" \
  $(pkg-config --cflags --libs wayland-client xkbcommon) -o "$build_dir/octo-seat-input"
install -m 0755 "$build_dir/octo-seat-input" "$output"
