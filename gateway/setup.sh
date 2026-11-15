#!/usr/bin/env bash
# Octogee Gateway — Setup Script
# Builds the Docker image, runs first-time onboarding, and starts the gateway.
#
# Usage:
#   ./setup.sh                 — first run or normal start
#   ./setup.sh --rebuild       — force rebuild of the gateway image
#   ./setup.sh --reset         — wipe the data dir and start completely fresh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REBUILD=false
RESET=false

for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=true ;;
    --reset)   RESET=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

fail()        { echo "ERROR: $*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "Missing dependency: $1"; }

# --- Load .env ---
if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

GATEWAY_IMAGE="${OCTOGEE_GATEWAY_IMAGE:-octogee-gateway:local}"
BASE_IMAGE="${OPENCLAW_BASE_IMAGE:-openclaw:local}"
GATEWAY_PORT="${GATEWAY_PORT:-18791}"
DATA_DIR="${OCTOGEE_DATA_DIR:-$HOME/octogee-gateway}"
OPENCLAW_DIR="$DATA_DIR/.openclaw"
COMPOSE="docker compose -f $ROOT_DIR/docker-compose.yml"

require_cmd docker
docker compose version >/dev/null 2>&1 || fail "Docker Compose not available"

# --- Reset (nuclear option) ---
if [[ "$RESET" == true ]]; then
  echo "==> WARNING: This will wipe $OPENCLAW_DIR and all user data."
  read -r -p "    Type 'yes' to confirm: " confirm
  [[ "$confirm" == "yes" ]] || { echo "Aborted."; exit 0; }
  $COMPOSE down 2>/dev/null || true
  rm -rf "$OPENCLAW_DIR"
  echo "==> Data directory wiped."
fi

# --- Create host data directories ---
# These are bind-mounted into the container. Creating them here ensures
# Docker doesn't create them as root-owned on first mount.
mkdir -p "$OPENCLAW_DIR/customers"
mkdir -p "$OPENCLAW_DIR/identity"
mkdir -p "$OPENCLAW_DIR/secrets"
echo "==> Data directory: $OPENCLAW_DIR"

# --- Firestore auth (Application Default Credentials) ---
# The provisioner reaches Firestore via ADC — no service-account key file
# (firebase.ts is ADC/Workload-Identity only). Local dev:
# `gcloud auth application-default login`; in-cluster: Workload Identity.
echo "==> Firestore auth: Application Default Credentials (no key file)"

# --- Ensure openclaw base image exists ---
if ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
  echo "==> Base image '$BASE_IMAGE' not found — building from source (Dockerfile.base)."
  OCTOGEE_PROJECT_ROOT="$(cd "$(dirname "$ROOT_DIR")" && pwd)"
  bash "$ROOT_DIR/openclaw-tarball/extract-npm.sh" "$ROOT_DIR/openclaw-tarball/openclaw-fork.tgz"
  docker build --no-cache \
    --build-arg OPENCLAW_REF="${OPENCLAW_REF:-main}" \
    -f "$ROOT_DIR/Dockerfile.base" \
    -t "$BASE_IMAGE" \
    "$OCTOGEE_PROJECT_ROOT"
  echo "==> Base image built: $BASE_IMAGE"
fi

# --- Generate gateway token if not set ---
if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 32)"
  else
    OPENCLAW_GATEWAY_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  fi
  echo "OPENCLAW_GATEWAY_TOKEN=$OPENCLAW_GATEWAY_TOKEN" >> "$ROOT_DIR/.env"
  echo "==> Generated gateway token (saved to .env)"
fi

export OPENCLAW_GATEWAY_TOKEN
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
export OCTOGEE_GATEWAY_IMAGE="$GATEWAY_IMAGE"
export OPENCLAW_BASE_IMAGE="$BASE_IMAGE"
export GATEWAY_PORT="$GATEWAY_PORT"
export OCTOGEE_DATA_DIR="$DATA_DIR"

# --- Build gateway image ---
if [[ "$REBUILD" == true ]] || ! docker image inspect "$GATEWAY_IMAGE" >/dev/null 2>&1; then
  echo "==> Building Octogee gateway image: $GATEWAY_IMAGE"
  # Build context is the project root so the Dockerfile can reach scripts/ and templates/
  OCTOGEE_PROJECT_ROOT="$(dirname "$ROOT_DIR")"
  docker build \
    --build-arg "OPENCLAW_BASE_IMAGE=$BASE_IMAGE" \
    -f "$ROOT_DIR/Dockerfile" \
    -t "$GATEWAY_IMAGE" \
    "$OCTOGEE_PROJECT_ROOT"
else
  echo "==> Image '$GATEWAY_IMAGE' exists. Use --rebuild to force."
fi

# --- First-time onboarding (only if openclaw.json doesn't exist yet) ---
if [[ ! -f "$OPENCLAW_DIR/openclaw.json" ]]; then
  echo ""
  echo "==> First-time setup: running OpenClaw onboarding"
  echo "    When prompted, use these values:"
  echo "      Gateway bind:   lan"
  echo "      Gateway auth:   token"
  echo "      Gateway token:  $OPENCLAW_GATEWAY_TOKEN"
  echo "      Tailscale:      Off"
  echo "      Install daemon: No"
  echo ""
  OCTOGEE_DATA_DIR="$DATA_DIR" $COMPOSE run --rm octogee-cli onboard --no-install-daemon

  echo ""
  echo "==> Next: wire Discord bots (run once for each of the 5 Octogee bots):"
  echo ""
  echo "    docker compose -f $ROOT_DIR/docker-compose.yml run --rm octogee-cli \\"
  echo "      channels add --channel discord --token <TOKEN> --account <ACCOUNT_ID>"
  echo ""
  echo "    Accounts: octogee-coach, octogee-alex, octogee-morgan, octogee-riley, octogee-robert"
  echo ""
fi

# --- Start the gateway ---
echo "==> Starting Octogee gateway..."
OCTOGEE_DATA_DIR="$DATA_DIR" $COMPOSE up -d octogee-gateway

echo ""
echo "======================================="
echo "  Octogee Gateway is running!"
echo ""
echo "  Data:  $OPENCLAW_DIR"
echo "  Port:  localhost:$GATEWAY_PORT"
echo "  Token: $OPENCLAW_GATEWAY_TOKEN"
echo ""
echo "  Logs:  $COMPOSE logs -f octogee-gateway"
echo "  Stop:  $COMPOSE down"
echo "  Reset: ./setup.sh --reset"
echo "======================================="
