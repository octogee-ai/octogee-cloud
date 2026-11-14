#!/bin/sh
set -e

. "${OCTOGEE_LIBEXEC_DIR:-/usr/local/libexec}/gateway-class-dual-read.sh"
GATEWAY_CLASS_EFFECTIVE="$(dual_read_gateway_class "${GATEWAY_CLASS:-shared}")"

if [ "$GATEWAY_CLASS_EFFECTIVE" = isolated ] && [ "${GATEWAY_COMPUTER_DESKTOP:-}" = x11 ] && [ "${OCTOGEE_X11_SESSION:-0}" != 1 ]; then
  exec /usr/local/bin/octogee-hobby-desktop
fi

# OPENCLAW_DIR must be `export`ed: subprocesses (python in the openclaw.json
# re-sync block below, publish-gateway-token.mjs, and openclaw itself) read it
# from their environment. Caught by independent audit on PR #1166 — the
# unexported assignment would crash-loop gateway boot
# (KeyError in the re-sync block → `set -e` exit). Same pattern as
# OPENCLAW_GATEWAY_TOKEN (L57) and GATEWAY_ID (L92).
export OPENCLAW_DIR=/home/node/.openclaw
export OPENCLAW_STATE_DIR="$OPENCLAW_DIR"
TEMPLATES_DIR="${OCTOGEE_TEMPLATES_DIR:-/octogee/templates}"
TSX=/octogee/scripts/node_modules/.bin/tsx
case "$GATEWAY_CLASS_EFFECTIVE" in
  shared|isolated) ;;
  *) echo "FATAL: GATEWAY_CLASS must be shared or isolated" >&2; exit 1 ;;
esac
case "$(dual_read_gateway_class "${GATEWAY_PROFILE:-standard}")" in
  standard|isolated) ;;
  *) echo "FATAL: GATEWAY_PROFILE must be standard or isolated" >&2; exit 1 ;;
esac

# Consistent ISO timestamp logging (matches OpenClaw gateway format)
log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000+00:00) [entrypoint] $*"
}

SUPERVISE="$TSX /octogee/scripts/entrypoints/supervise-runner.ts"
PRESTOP_FLUSH="timeout 10s $TSX /octogee/scripts/entrypoints/prestop-flush.ts"

exit_when_openclaw_dies() {
  _openclaw_pid="$1"
  set +e
  wait "$_openclaw_pid"
  _openclaw_status=$?
  set -e
  if [ "$_openclaw_status" -eq 0 ]; then
    _openclaw_status=1
  fi
  trap '' TERM INT
  log "FATAL: OpenClaw gateway process exited (status=${_openclaw_status}); exiting container so Kubernetes restarts it"
  $PRESTOP_FLUSH || log "prestop-flush failed (exit $?) during the OpenClaw-death container exit"
  kill -TERM 0 2>/dev/null || true
  exit "$_openclaw_status"
}

supervise_runner() {
  _name="$1"; shift
  _restart_delay_ms="$1"; shift
  (
    _supervisor_pid=""
    stop_supervisor() {
      trap '' TERM INT
      _supervisor_status=0
      if [ -n "$_supervisor_pid" ]; then
        kill -TERM "$_supervisor_pid" 2>/dev/null || true
        wait "$_supervisor_pid" || _supervisor_status=$?
      fi
      exit "$_supervisor_status"
    }
    trap stop_supervisor TERM INT
    while true; do
      $SUPERVISE "$_name" "--restart-delay-ms=${_restart_delay_ms}" "$@" &
      _supervisor_pid=$!
      wait "$_supervisor_pid" || true
      _supervisor_pid=""
      log "supervise-runner[$_name] exited — restarting in 5s..."
      sleep 5
    done
  ) &
}

# ── Signal forwarding ──────────────────────────────────────────────────────
# Kubernetes sends SIGTERM → PID 1 (this sh) → our trap → SIGTERM every
# direct child → exit cleanly within the pod's terminationGracePeriodSeconds
# (default 30s). Without this trap, the shell ignores SIGTERM and k8s
# eventually SIGKILLs the pod, which drops MM WebSockets ungracefully.
shutdown() {
  # Clear the trap FIRST. `kill 0` below signals the entire process group,
  # which includes this shell — without clearing, the re-delivered SIGTERM
  # re-enters the handler and we loop (observed in 2026-04-17 rollout: the
  # entrypoint logged `received SIGTERM — forwarding to children` 6+ times
  # in the same second). Setting to '' makes subsequent signals ignored.
  trap '' TERM INT
  log "entrypoint: received SIGTERM — forwarding to children"
  kill -TERM 0 2>/dev/null || true
  _shutdown_status=0
  if [ -n "${OPENCLAW_PID:-}" ]; then
    wait "$OPENCLAW_PID" || _shutdown_status=$?
  fi
  exit "$_shutdown_status"
}
trap shutdown TERM INT

log "boot: gateway-image=${BUILD_SHA:-unknown}"

# ── Ensure workspace structure exists (idempotent) ──────────────────────────
mkdir -p "$OPENCLAW_DIR"
chmod 00700 "$OPENCLAW_DIR"
mkdir -p "$OPENCLAW_DIR/customers"
mkdir -p "$OPENCLAW_DIR/identity"
mkdir -p "$OPENCLAW_DIR/secrets"
mkdir -p "$OPENCLAW_DIR/agents"
MATTERMOST_ACCOUNT_SECRETS="$OPENCLAW_DIR/secrets/mattermost-accounts.json"
if [ ! -f "$MATTERMOST_ACCOUNT_SECRETS" ]; then
  umask 077
  printf '{}\n' > "$MATTERMOST_ACCOUNT_SECRETS"
fi
chmod 600 "$MATTERMOST_ACCOUNT_SECRETS"

# GATEWAY_ID is set by the deployment's env block. Fail fast if it is missing.
export GATEWAY_ID="${GATEWAY_ID:?GATEWAY_ID env var is required (set via Helm values.env.gatewayId)}"

# ── User identity ───────────────────────────────────────────────────────
BUILDER_SLUG=""
if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ]; then
  log "Pre-boot: reading user identity for ${GATEWAY_ID}..."
  while true; do
    if BUILDER_SLUG=$("$TSX" /octogee/scripts/entrypoints/user-identity.ts); then
      break
    else
      identity_status=$?
    fi
    if [ "$identity_status" -eq 72 ]; then
      log "FATAL: User identity for ${GATEWAY_ID} belongs to a rebound VM"
      if [ "${GATEWAY_RUNTIME_KIND:-}" = gce-vm ] && [ "${GATEWAY_COMPUTER_DESKTOP:-}" != x11 ]; then
        exit 0
      fi
      exit 72
    fi
    if [ "$identity_status" -eq 2 ]; then
      log "FATAL: User identity for ${GATEWAY_ID} is unavailable or conflicts with this pod's claim"
      exit 2
    fi
    log "Pre-boot: User identity unavailable; retrying in 5s..."
    sleep 5
  done
  log "Pre-boot: User identity claimed for ${BUILDER_SLUG}"
fi

if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ]; then
  log "Pre-boot: removing empty user project placeholders..."
  "$TSX" /octogee/scripts/entrypoints/clean-user-project-placeholders.ts
fi

GIT_SSH_HOST="${GIT_SSH_HOST:-octogee-gitea-ssh.octogee.svc.cluster.local}"
if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ]; then
  case "${BUILDER_SLUG}" in
    ""|*[!a-z0-9-]*) log "FATAL: a valid user slug is required for user SSH"; exit 1 ;;
  esac
fi
mkdir -p "$HOME/.ssh"
cat > "$HOME/.ssh/config" <<SSHEOF
Host gitea
  HostName ${GIT_SSH_HOST}
  Port 2222
  User git
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
SSHEOF
if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ]; then
  cat >> "$HOME/.ssh/config" <<SSHEOF
  IdentityFile ${OPENCLAW_DIR}/customer-keys/${BUILDER_SLUG}/id_ed25519
  IdentitiesOnly yes
SSHEOF
fi
chmod 600 "$HOME/.ssh/config"
log "SSH config written for Gitea (host: ${GIT_SSH_HOST}, class: ${GATEWAY_CLASS_EFFECTIVE})"

# ── OpenClaw environment inputs ─────────────────────────────────────────────
export MM_URL="${MM_URL:-}"
export MM_INTERACTIONS_CALLBACK_BASE_URL="${MM_INTERACTIONS_CALLBACK_BASE_URL:-}"
export MM_INTERACTIONS_ALLOWED_SOURCE_IPS="${MM_INTERACTIONS_ALLOWED_SOURCE_IPS:-}"

# ── Require OPENCLAW_GATEWAY_TOKEN from the K8s secret ─────────────────────
# Platform-owned: the fleet controller ensures the per-gateway K8s secret
# `gateway-auth-token-<gatewayId>` exists before `helm upgrade`; the chart
# threads it via secretKeyRef on init/gateway/gateway-edge. No fallback —
# absent env means the secretKeyRef binding broke or someone trimmed the
# chart's env block. Crash-loop loudly so the failure shows up in
# `kubectl describe pod` instead of silently producing a gateway that
# nobody can authenticate against.
if [ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  echo "████████████████████████████████████████████████████████████████" >&2
  echo "FATAL: OPENCLAW_GATEWAY_TOKEN is empty or unset." >&2
  echo "The chart's secretKeyRef → gateway-auth-token-<gatewayId> didn't" >&2
  echo "resolve. Likely causes:" >&2
  echo "  - The fleet controller hasn't created the K8s secret yet (check glmGateways/<id>)" >&2
  echo "  - The chart's env block was edited to omit OPENCLAW_GATEWAY_TOKEN" >&2
  echo "  - The K8s secret was deleted out-of-band" >&2
  echo "████████████████████████████████████████████████████████████████" >&2
  exit 1
fi
export OPENCLAW_GATEWAY_TOKEN
# In-pod relay credential for plugins that run inside the OpenClaw process.
# Under per-user control identity the OpenClaw process itself must not see
# OPENCLAW_GATEWAY_TOKEN (trusted-proxy and token auth are mutually exclusive),
# so the activity plugin reads this name instead. Always exported so the
# plugin has one code path in both identity modes.
export OCTOGEE_POD_RELAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN"
# ── End require ────────────────────────────────────────────────────────────

if [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ]; then
  export OPENCLAW_CONFIG_PATH="$OPENCLAW_DIR/system_config/openclaw.json"
else
  export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$OPENCLAW_DIR/openclaw.json}"
fi

# ── Gateway lock records of an earlier gateway container in this pod ────────
GATEWAY_CLASS="$GATEWAY_CLASS_EFFECTIVE" "$TSX" /octogee/scripts/entrypoints/recover-restarted-gateway-container-locks.ts

# ── Owner-bound runtime system_config restore ───────────────────────────────
# Isolated gateways run the tracked Gitea checkout as OpenClaw's active
# regular config file. Restore includes the idempotent schema migration
# (roll-forward only; reconcileSystemConfigSchema).
if [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ]; then
  log "Pre-boot: restoring system_config for user slug ${BUILDER_SLUG}..."
  until "$TSX" /octogee/scripts/entrypoints/system-config-restore.ts; do
    log "Pre-boot: system_config restore unavailable; retrying in 5s..."
    sleep 5
  done
  log "Pre-boot: hydrating the configured user credential for ${GATEWAY_ID}..."
  until "$TSX" /octogee/scripts/entrypoints/configured-user-bootstrap.ts; do
    log "Pre-boot: configured user credential unavailable; retrying in 5s..."
    sleep 5
  done
  log "Pre-boot: restoring user OpenClaw runtime state for ${BUILDER_SLUG}..."
  while true; do
    if "$TSX" /octogee/scripts/entrypoints/isolated-runtime-state-restore.ts --defer-builder-store-migration; then
      break
    else
      restore_status=$?
    fi
    if [ "$restore_status" -eq 2 ]; then
      log "FATAL: Isolated runtime state recovery stopped for a permanent local-state or policy refusal"
      exit 2
    fi
    log "Pre-boot: Isolated runtime state restore unavailable; retrying in 5s..."
    sleep 5
  done
  log "Pre-boot: landing recorded PostgreSQL agent anchors for ${BUILDER_SLUG}..."
  until "$TSX" /octogee/scripts/entrypoints/agent-anchor-restore.ts; do
    log "Pre-boot: agent anchor record unavailable; retrying in 5s..."
    sleep 5
  done
else
  if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
    mkdir -p "$(dirname "$OPENCLAW_CONFIG_PATH")"
    cp /octogee/infra/gateway/openclaw.template.json "$OPENCLAW_CONFIG_PATH"
    log "openclaw.json copied from raw template (gatewayId=${GATEWAY_ID})"
  fi
fi

# ── Prepare canonical plugin roots ─────────────────────────────────────────
if [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ]; then
  OPENCLAW_CONFIG_DIR=$(dirname "$OPENCLAW_CONFIG_PATH")
  if [ "$OPENCLAW_CONFIG_DIR" != "$OPENCLAW_DIR" ]; then
    RUNTIME_ROOT_QUARANTINE=""
    for runtime_name in npm extensions; do
      runtime_root="$OPENCLAW_CONFIG_DIR/$runtime_name"
      if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ]; then
        if [ -n "$(git -C "$OPENCLAW_CONFIG_DIR" ls-files -- "$runtime_name" "$runtime_name/**")" ]; then
          log "FATAL: tracked system_config path conflicts with OpenClaw runtime root: ${runtime_name}"
          exit 1
        fi
        grep -qxF "/$runtime_name" "$OPENCLAW_CONFIG_DIR/.git/info/exclude" 2>/dev/null || \
          printf '/%s\n' "$runtime_name" >> "$OPENCLAW_CONFIG_DIR/.git/info/exclude"
      fi
      if [ -L "$runtime_root" ]; then
        if [ "$(readlink "$runtime_root")" != "$OPENCLAW_DIR/$runtime_name" ]; then
          log "FATAL: unrecognized system_config runtime alias: ${runtime_name}"
          exit 1
        fi
        rm "$runtime_root"
      elif [ -e "$runtime_root" ]; then
        if [ -z "$RUNTIME_ROOT_QUARANTINE" ]; then
          RUNTIME_ROOT_QUARANTINE=$(mktemp -d "${TMPDIR:-/tmp}/openclaw-system-config.XXXXXX")
        fi
        mv "$runtime_root" "$RUNTIME_ROOT_QUARANTINE/$runtime_name"
        log "Existing system_config runtime root quarantined: ${runtime_name}"
      fi
    done
    log "Config-adjacent plugin aliases retired"
  fi
fi

chmod 600 "$OPENCLAW_CONFIG_PATH"

# Enforce the class-level OpenClaw policy before startup. The base template is
# user-safe (host execution denied, Codex disabled).
CLASS_POLICY=/octogee/infra/gateway/apply-gateway-class-policy.mjs
if [ -f "$CLASS_POLICY" ]; then
  node "$CLASS_POLICY"
fi

(cd /octogee/scripts && node --input-type=module -e 'import { beginWorkspaceIdentityBoot } from "@octogee/core/openclaw-workspace-bootstrap"; beginWorkspaceIdentityBoot();')

# Publish the fresh gateway auth token to Secret Manager only when explicitly
# requested. The normal Kubernetes path keeps gateway auth pod-local:
# gateway-edge gets the same per-gateway OPENCLAW_GATEWAY_TOKEN env exception,
# uses it once to pair with OpenClaw, then persists a sidecar-only device token.
#
# The OpenClaw gateway container must not need platform Secret Manager
# reach under the platform-credential floor. Leaving this publisher as opt-in
# preserves a rollback hook for legacy deployments without making normal boots
# block on ADC/metadata or requiring a secretmanager role on the cattle GSA.
#
# Exit-code contract with publish-gateway-token.mjs:
#   0 — published successfully; boot continues
#   2 — setup-incomplete (secret missing, IAM not granted, Workload
#       Identity misconfigured). FATAL: crash-loop the pod so the
#       operator fixes setup-secrets.sh before traffic arrives at a
#       gateway chat-proxy can never authenticate against.
#   1 — transient SM error (UNAVAILABLE, DNS blip). WARN + continue;
#       the next boot retries. Gateway-local tools keep working.
#
# Skipped unless GATEWAY_AUTH_SECRET_MANAGER_PUBLISH=true/1 and GCP_PROJECT_ID
# is set.
if [ "${GATEWAY_AUTH_SECRET_MANAGER_PUBLISH:-}" = "true" ] || [ "${GATEWAY_AUTH_SECRET_MANAGER_PUBLISH:-}" = "1" ]; then
  if [ -z "${GCP_PROJECT_ID:-}" ]; then
    log "gateway auth token Secret Manager publish requested but GCP_PROJECT_ID is unset; skipping"
  else
    set +e
    node /octogee/scripts/publish-gateway-token.mjs
    PUBLISH_RC=$?
    set -e
    case "$PUBLISH_RC" in
      0)
        log "gateway auth token published to Secret Manager (gateway-auth-token-${GATEWAY_ID})"
        ;;
      2)
        log "████████████████████████████████████████████████████████████████"
        log "FATAL: GATEWAY_AUTH_PUBLISH_FAILED (setup-incomplete). Secret"
        log "shell missing, IAM missing, or Workload Identity misconfigured."
        log "Gateway cannot be authenticated by chat-proxy until this is fixed."
        log "Run: ./scripts/setup-secrets.sh --env=<env> to provision."
        log "Crash-looping pod so the failure surfaces in kubectl events."
        log "████████████████████████████████████████████████████████████████"
        exit 1
        ;;
      *)
        log "WARN: publish-gateway-token.mjs exit=${PUBLISH_RC} (transient) — chat-proxy will reject upstream WS until the next successful publish; not crash-looping since gateway can serve ops traffic meanwhile"
        ;;
    esac
  fi
else
  log "skipping gateway auth token Secret Manager publish; gateway-edge uses the in-pod OPENCLAW_GATEWAY_TOKEN/device token"
fi
# ── End gateway auth token publish ──────────────────────────────────────────

# ── Harden file permissions ─────────────────────────────────────────────────
chmod 600 "$OPENCLAW_CONFIG_PATH" 2>/dev/null || true
log "File permissions hardened"

# ── Project immutable plugin extensions from the image ─────────────────────
if [ -d /octogee/extensions ]; then
  if [ -e "$OPENCLAW_DIR/extensions" ] || [ -L "$OPENCLAW_DIR/extensions" ]; then
    rm -rf "$OPENCLAW_DIR/extensions"
  fi
  ln -s /octogee/extensions "$OPENCLAW_DIR/extensions"
  log "Plugin extensions projected from image"
fi

# ── Restore staged external OpenClaw runtime plugins into the emptyDir ───────
# `openclaw plugins install` writes under ~/.openclaw/npm, which is an emptyDir
# at runtime (no PVC) — so the build-time install is shadowed every boot.
# The plugin tree is staged in the base image at /opt/openclaw-runtime-deps;
# symlink the whole `npm` dir into place so externalized plugins load. Same
# /opt→emptyDir pattern as the extension node_modules symlinks above.
#
# We symlink the whole `npm` tree regardless of layout; loading is driven by
# openclaw.json resolving packages from the managed npm root, not by the
# plugins/installs.json cache.
if [ -d /opt/openclaw-runtime-deps/npm ]; then
  if [ -e "$OPENCLAW_DIR/npm" ] || [ -L "$OPENCLAW_DIR/npm" ]; then
    rm -rf "$OPENCLAW_DIR/npm"
  fi
  ln -s /opt/openclaw-runtime-deps/npm "$OPENCLAW_DIR/npm"
  log "OpenClaw runtime plugins projected from /opt/openclaw-runtime-deps/npm"
else
  log "FATAL: /opt/openclaw-runtime-deps absent — required runtime plugins unavailable"
  exit 1
fi

# ── Pre-boot: sync env/runtime config into openclaw.json ─────────────────
# Must run on db-less isolated gateways too: system_config restore can
# bring back an old auth profile, but ANTHROPIC_BASE_URL is env-owned and is
# what keeps capped broker tokens from being sent directly to Anthropic.
if [ "$GATEWAY_CLASS_EFFECTIVE" = "shared" ] && [ -f "$OPENCLAW_CONFIG_PATH" ]; then
  log "Pre-boot: applying env/runtime config patches..."
  GATEWAY_CLASS="$GATEWAY_CLASS_EFFECTIVE" "$TSX" /octogee/scripts/entrypoints/pre-boot-config.ts
  if [ -f "$CLASS_POLICY" ]; then
    node "$CLASS_POLICY"
  fi
fi

# ── Apply Octogee-owned runtime config once ─────────────────────────────────
if [ "$GATEWAY_CLASS_EFFECTIVE" != "shared" ]; then
  log "Pre-boot: applying env/runtime config patches..."
  GATEWAY_CLASS="$GATEWAY_CLASS_EFFECTIVE" "$TSX" /octogee/scripts/entrypoints/pre-boot-config.ts --defer-builder-store-migration
  if [ -f "$CLASS_POLICY" ]; then
    node "$CLASS_POLICY"
  fi
fi

if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ]; then
  log "Pre-boot: initializing configured user agent runtime directories..."
  "$TSX" /octogee/scripts/entrypoints/ensure-configured-agent-runtime-dirs.ts \
    || log "⚠ configured user agent runtime directories failed to initialize (exit $?); the OpenClaw supervisor re-runs this before every start"
fi

if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ]; then
  "$TSX" /octogee/scripts/entrypoints/user-claim.ts mark-overlay-applied
fi

USER_CRON_QUARANTINE=/octogee/infra/gateway/quarantine-user-cron-jobs.mjs
if [ "$GATEWAY_CLASS_EFFECTIVE" = "shared" ] && [ -f "$USER_CRON_QUARANTINE" ]; then
  log "Pre-boot: quarantining unsafe persisted user cron jobs..."
  node "$USER_CRON_QUARANTINE"
fi

# ── Start OpenClaw before auxiliary runners compete for cold CPU ────────────
# Isolated gateways delegate the OpenClaw process to the surge supervisor: a new
# pod boots with OpenClaw held until the surge readiness path permits it, so the
# entrypoint must not gate the auxiliary runners on OpenClaw health — the fleet
# controller is what hydrates and releases a held pod.
if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ]; then
  supervise_runner github-cli-auth 5000 "$TSX" /octogee/scripts/entrypoints/github-cli-auth-hydrate.ts
  log "Starting OpenClaw process supervisor (hold-capable isolated boot: ${BUILD_SHA:-unknown})..."
  supervise_runner surge-openclaw-supervisor 5000 "$TSX" /octogee/scripts/entrypoints/surge-openclaw-supervisor.ts
  OPENCLAW_PID=$!
else
  "$TSX" /octogee/scripts/entrypoints/prepare-openclaw-sqlite-journals.ts
  "$TSX" /octogee/scripts/entrypoints/openclaw-boot-sentinel.ts before-start
  log "Starting OpenClaw gateway... (build: ${BUILD_SHA:-unknown})"
  openclaw gateway run --bind lan --port 18789 &
  OPENCLAW_PID=$!

  until curl -fsS --max-time 2 http://127.0.0.1:18789/healthz >/dev/null 2>&1; do
    if ! kill -0 "$OPENCLAW_PID" 2>/dev/null; then
      log "OpenClaw exited before becoming healthy"
      wait "$OPENCLAW_PID"
      exit $?
    fi
    sleep 1
  done
  "$TSX" /octogee/scripts/entrypoints/openclaw-boot-sentinel.ts healthy
  log "OpenClaw gateway healthy; starting auxiliary runners"
fi

# ── In-pod runners: supervised + observable ─────────────────────────────────
# Each remaining runner is wrapped by supervise-runner.ts, which owns respawn AND writes
# a heartbeat that runner-metrics-exporter publishes (octogee_runner_up /
# _restart_total / _last_start). The thin shell `while true` guard here only
# re-runs the supervisor itself if IT ever dies; the supervisor handles the
# child's crash-loop. Replaces the bare per-runner respawn loops, which were
# invisible to monitoring (PID 1 stays alive, so a crash-looping child never
# showed as a container restart). See GATEWAY-RUNNER-OBSERVABILITY-SPEC.md.
# The local fleet controller is db-less for every class. The fleet controller owns liveness
# writes, and standard-image gateways mount users from tenant-bound
# octogee-api broker reads rather than local Firestore credentials.
if [ "$GATEWAY_CLASS_EFFECTIVE" = "shared" ]; then
  TSX=/octogee/infra/gateway/shared-auxiliary-runner.sh
  SUPERVISE="$TSX /octogee/scripts/entrypoints/supervise-runner.ts"
fi
supervise_runner fleet-controller 5000 "$TSX" /octogee/scripts/entrypoints/fleet-controller.ts
if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ]; then
  supervise_runner isolated-toolchain-hydrator 30000 "$TSX" /octogee/scripts/entrypoints/isolated-toolchain-hydrator.ts
fi
log "In-gateway project code runners disabled: previews and publishing use the isolated build service"
log "site-build-api disabled: site publishing runs through trusted CI/CD, not the gateway pod"
supervise_runner byosub-syncback 30000 "$TSX" /octogee/scripts/entrypoints/byosub-syncback-runner.ts
if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ]; then
  supervise_runner system-config-watch 5000 "$TSX" /octogee/scripts/entrypoints/system-config-watch.ts
fi

# ── Runner metrics exporter (all profiles) ──────────────────────────────────
# Serves /metrics on :9092 from the runner heartbeat files; one ServiceMonitor
# scrapes it. Its own thin guard — if the exporter dies, runner liveness goes
# dark, so keep it up.
(
  while true; do
    "$TSX" /octogee/scripts/entrypoints/runner-metrics-exporter.ts || true
    log "runner-metrics-exporter exited — restarting in 5s..."
    sleep 5
  done
) &

STAMPER=/octogee/infra/gateway/stamp-claude-first-run.mjs
if [ "$GATEWAY_CLASS_EFFECTIVE" = "isolated" ] && [ -f "$STAMPER" ]; then
  node "$STAMPER" || log "stamp-claude-first-run: non-fatal failure"
fi

# OpenClaw file-log mirror REMOVED 2026-05-18. The richer log is available
# on demand via `openclaw logs` from the running gateway, so permanently
# tailing /tmp/openclaw-*.log through an unbuffered `sed -u` to stdout was
# pure waste: continuous CPU/syscall churn plus ~2x container-stdout volume
# — a credible message-loop-latency contributor (see GATEWAY-PERFORMANCE-
# BASELINE). Do NOT reinstate an unconditional tail mirror. Proper
# root-cause follow-up: make OpenClaw log k8s-native (stdout) instead of to
# a rotating file, then no mirror is ever needed.

if [ "$GATEWAY_CLASS_EFFECTIVE" = "shared" ]; then
  exit_when_openclaw_dies "$OPENCLAW_PID"
else
  wait
fi
