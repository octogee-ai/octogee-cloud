# shellcheck shell=bash
# Sets ZONE to the zone that accepted the instance.
create_instance_in_first_available_zone() {
  local name="$1" zone out
  shift
  for zone in "$ZONE" ${FALLBACK_ZONES//,/ }; do
    if out="$(gcloud compute instances create "$name" --zone "$zone" "$@" 2>&1)"; then
      ZONE="$zone"
      return 0
    fi
    grep -q ZONE_RESOURCE_POOL_EXHAUSTED <<<"$out" || { printf '%s\n' "$out" >&2; return 1; }
    echo "zone $zone has no capacity for $name; trying the next zone" >&2
  done
  printf '%s\n' "$out" >&2
  return 1
}

start_instance_with_capacity_retry() {
  local name="$1" out deadline=$((SECONDS + 300))
  shift
  while true; do
    if out="$(gcloud compute instances start "$name" "$@" 2>&1)"; then
      return 0
    fi
    if ! grep -q ZONE_RESOURCE_POOL_EXHAUSTED <<<"$out" || (( SECONDS >= deadline )); then
      printf '%s\n' "$out" >&2
      return 1
    fi
    echo "capacity unavailable for restarting $name; retrying in 15s" >&2
    sleep 15
  done
}
