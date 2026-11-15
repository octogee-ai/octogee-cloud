# shellcheck shell=bash
DESKTOP_DEFAULT_REGISTRY="ghcr.io/octogee-ai/octogee-cloud"

desktop_registry() {
  local registry="${OCTOGEE_DESKTOP_REGISTRY:-$DESKTOP_DEFAULT_REGISTRY}"
  if [[ ! "$registry" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)+$ ]]; then
    echo "invalid OCTOGEE_DESKTOP_REGISTRY '$registry': expected host[:port]/repository in lower case, without a scheme" >&2
    return 2
  fi
  printf '%s\n' "$registry"
}

desktop_registry_image() {
  local name="$1" label="$2" image="$3" registry="$4"
  if [[ ! "$image" =~ ^(.+)/${name}@sha256:[a-f0-9]{64}$ ]]; then
    echo "$label image $image is not an immutable digest-pinned image (<registry>/${name}@sha256:<digest>)" >&2
    return 2
  fi
  if [[ "${BASH_REMATCH[1]}" != "$registry" ]]; then
    echo "$label image $image is not in the configured registry $registry (OCTOGEE_DESKTOP_REGISTRY)" >&2
    return 2
  fi
}
