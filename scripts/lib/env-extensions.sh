#!/usr/bin/env bash

# shellcheck disable=SC2034
ENV_VERIFY_SECTIONS=()
ENV_REBUILD_STEPS_AFTER_ROLLOUT=()
ENV_REBUILD_STEPS_AFTER_DEPLOY=()
ENV_TEARDOWN_FULL_PREFLIGHT=()
ENV_TEARDOWN_FULL_STEPS=()

load_env_extensions() {
  local extension loaded=()
  for extension in "$1"/*/env.sh; do
    [[ -f "$extension" ]] || continue
    # shellcheck source=/dev/null
    source "$extension"
    loaded+=("$(basename "$(dirname "$extension")")")
  done
  if [[ ${#loaded[@]} -eq 0 ]]; then
    echo "No env extensions loaded"
  else
    echo "Env extensions loaded: ${loaded[*]}"
  fi
}

run_env_hooks() {
  local hook
  for hook in "$@"; do
    "$hook"
  done
}
