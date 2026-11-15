#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

control="http://localhost:${OCTO_CONTROL_PORT:-7777}"
out_dir="${OCTO_MEASURE_DIR:-./.measure}"
compositor="${OCTO_COMPOSITOR:-hyprland}"
compose=(docker compose -f docker-compose.yml)
[[ "$compositor" == hyprland ]] && compose+=(-f docker-compose.gpu.yml)
mkdir -p "$out_dir"

"${compose[@]}" down -t 5 -v >/dev/null 2>&1 || true
rm -rf "$out_dir"; mkdir -p "$out_dir"
t0=$(date +%s.%N)
"${compose[@]}" up -d
for _ in $(seq 1 1800); do
  if curl -fsS "$control/health" >"$out_dir/health.json" 2>/dev/null; then break; fi
  sleep 0.2
done
t_ready=$(date +%s.%N)
curl -fsS "$control/health" >/dev/null || { echo "desktop never became healthy" >&2; "${compose[@]}" logs --no-color | tail -50; exit 1; }

for _ in $(seq 1 300); do
  if jq -e '.clients | index("chromium")' "$out_dir/health.json" >/dev/null 2>&1; then break; fi
  sleep 0.5
  curl -fsS "$control/health" >"$out_dir/health.json" 2>/dev/null || true
done
jq -e '.clients | index("chromium")' "$out_dir/health.json" >/dev/null 2>&1 || {
  echo "chromium never mapped a window; health: $(cat "$out_dir/health.json")" >&2
  "${compose[@]}" exec desktop tail -20 /home/octo/.local/state/octo-desktop/chromium.log >&2 || true
  exit 1
}
t_chromium=$(date +%s.%N)

sample() {
  docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' octo-desktop
}

sleep 10
idle=$(sample)

curl -fsS "$control/screenshot" -o "$out_dir/screenshot.png"
shot_t0=$(date +%s.%N)
for _ in $(seq 1 10); do curl -fsS "$control/screenshot" -o /dev/null; done
shot_t1=$(date +%s.%N)
busy=$(sample)

chromium_title=$(curl -fsS "$control/windows" | jq -r '.[] | select(.class | test("chromium"; "i")) | .title' | head -n1)

image_size=$(docker image inspect "${OCTO_DESKTOP_IMAGE:-octogee-desktop:spike}" --format '{{.Size}}')

cat <<RESULT

## Measured $(date -u +%Y-%m-%dT%H:%MZ) on $(uname -m) ($(docker info --format '{{.NCPU}} cpu / {{.MemTotal}} bytes' 2>/dev/null)), OCTO_COMPOSITOR=${compositor}

| Metric | Value |
| --- | --- |
| Image size | $(( image_size / 1024 / 1024 )) MiB |
| Container start to control API healthy | $(python3 -c 'import sys; print(f"{float(sys.argv[2])-float(sys.argv[1]):.1f}")' "$t0" "$t_ready") s |
| Container start to Chromium window mapped | $(python3 -c 'import sys; print(f"{float(sys.argv[2])-float(sys.argv[1]):.1f}")' "$t0" "$t_chromium") s |
| Idle CPU / memory | $idle |
| CPU / memory during screenshot loop | $busy |
| Screenshot latency (avg of 10) | $(python3 -c 'import sys; print(f"{(float(sys.argv[2])-float(sys.argv[1]))/10:.2f}")' "$shot_t0" "$shot_t1") s |
| Chromium window | "$chromium_title" |
| Compositor | $compositor (health: $(jq -r .compositor "$out_dir/health.json")) |
| Screenshot artifacts | $out_dir/screenshot.png, $out_dir/after-navigate.png |
RESULT

[[ -n "$chromium_title" ]] || { echo "desktop acceptance failed: no Chromium window" >&2; exit 1; }
