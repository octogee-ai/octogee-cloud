#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee K8s Secrets Materialization
# ═══════════════════════════════════════════════════════════════════════════
#
# Idempotent — safe to re-run any time (uses kubectl apply, not delete+create).
# Run TWICE in the canonical install sequence:
#
#   Phase 1 (pre-helm):  creates the secrets MM/Gitea/gateway pods need to
#                        BOOT (gitea-ssh-key, mattermost-cloud-sql DB pass,
#                        gitea-credentials with stable SECRET_KEY/INTERNAL_TOKEN,
#                        empty mattermost-gateway + gitea-token shells, etc.).
#                        Helm install can now schedule pods that mount these.
#
#   Phase 2 (post-bootstrap): setup-mattermost.sh owns the complete
#                        mattermost-gateway PAT contract; this script retains it
#                        and materializes gitea-token plus the remaining values.
#                        kubectl rollout restart afterwards picks them up.
#
# Reads from: .env.test / .env + Secret Manager (octogee project).
#
# Canonical sequence printed by ./scripts/teardown-env.sh.
#
# Usage:
#   ./scripts/setup-secrets.sh --env=test [--deployment-target=test-west] --phase=bootstrap [--yes]
#   ./scripts/setup-secrets.sh --env=test [--deployment-target=test-west] --phase=launch [--yes]
#   ./scripts/setup-secrets.sh --env=prod --phase=launch
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=scripts/lib/shell-env.sh
source "$SCRIPT_DIR/lib/shell-env.sh"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"
# shellcheck source=scripts/lib/github-oauth-redirect.sh
source "$SCRIPT_DIR/lib/github-oauth-redirect.sh"
# shellcheck source=scripts/lib/openai-key-validation.sh
source "$SCRIPT_DIR/lib/openai-key-validation.sh"
source "$SCRIPT_DIR/lib/signature-key-validation.sh"
# shellcheck source=scripts/lib/secret-extensions.sh
source "$SCRIPT_DIR/lib/secret-extensions.sh"
load_secret_extensions "$SCRIPT_DIR"
source "$SCRIPT_DIR/lib/agent-store-postgres-secret.sh"
source "$SCRIPT_DIR/lib/platform-state-postgres-secret.sh"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# shellcheck source=scripts/lib/secret-completeness.sh
source "$SCRIPT_DIR/lib/secret-completeness.sh"

ENV=""; YES=false; CUSTOM_NS=""; DEPLOYMENT_TARGET=""; SECRET_SETUP_PHASE="launch"

for arg in "$@"; do
  case $arg in
    --env=*)       ENV="${arg#*=}" ;;
    --deployment-target=*) DEPLOYMENT_TARGET="${arg#*=}" ;;
    --namespace=*) CUSTOM_NS="${arg#*=}" ;;
    --phase=*)     SECRET_SETUP_PHASE="${arg#*=}" ;;
    --yes|-y)      YES=true ;;
    --help|-h) echo "Usage: $0 --env=prod|test|custom [--deployment-target=TARGET] [--namespace=NAME] [--phase=bootstrap|launch] [--yes]"; exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done
[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test|custom [--deployment-target=TARGET] [--namespace=NAME] [--phase=bootstrap|launch] [--yes]"; exit 1; }
case "$SECRET_SETUP_PHASE" in
  bootstrap|launch) ;;
  *) echo "--phase must be bootstrap or launch"; exit 1 ;;
esac

TARGET_ENV="$ENV"
[[ "$TARGET_ENV" == "custom" ]] && TARGET_ENV="test"
if [[ -n "$DEPLOYMENT_TARGET" ]]; then
  octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"
  [[ "$TARGET_ENVIRONMENT" != "$TARGET_ENV" ]] && {
    echo "Deployment target '$DEPLOYMENT_TARGET' does not belong to environment '$TARGET_ENV'"
    exit 1
  }
else
  octogee_load_deployment_target "--environment=$TARGET_ENV"
fi
K8S_NAMESPACE="$TARGET_NAMESPACE"
CLUSTER_PROJECT="$TARGET_CLUSTER_PROJECT"
CLUSTER_NAME="$TARGET_CLUSTER_NAME"
K8S_CONTEXT="$TARGET_KUBE_CONTEXT"
FIREBASE_PROJECT="$TARGET_FIREBASE_PROJECT"
SM_PROJECT="$TARGET_CLOUD_SQL_PROJECT"
INTERNAL_SECRET_SUFFIX="$TARGET_SECRET_NAME_SUFFIX"
TARGET_ARG=" --deployment-target=$TARGET_ID"

case "$ENV" in
  prod)
    ENV_FILE="$REPO_DIR/.env"
    ENV_LABEL="🔴 PRODUCTION"
    NS_SLUG="prod"
    ;;
  test)
    ENV_FILE="$REPO_DIR/.env.test"
    ENV_LABEL="🟡 TEST"
    NS_SLUG="test"
    ;;
  custom)
    # Ephemeral/feature namespaces sharing the TEST Firebase project.
    [[ -z "$CUSTOM_NS" ]] && { echo "--env=custom requires --namespace=NAME"; exit 1; }
    [[ "$CUSTOM_NS" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "Invalid namespace '$CUSTOM_NS'"; exit 1; }
    [[ ${#CUSTOM_NS} -le 63 ]] || { echo "Namespace too long (max 63)"; exit 1; }
    K8S_NAMESPACE="$CUSTOM_NS"
    ENV_FILE="$REPO_DIR/.env.$CUSTOM_NS"
    ENV_LABEL="🟣 CUSTOM ($CUSTOM_NS)"
    NS_SLUG="${CUSTOM_NS//-/_}"
    INTERNAL_SECRET_SUFFIX="custom"
    TARGET_ARG=""
    ;;
  *) echo "Unknown environment: $ENV"; exit 1 ;;
esac
if [[ "$ENV" != "custom" ]]; then
  case "$TARGET_ID" in
    prod-central|test-central) ;;
    *) ENV_FILE="$REPO_DIR/.env.$TARGET_ID" ;;
  esac
fi

GITHUB_OAUTH_PEER_ENV_FILE=""
case "$TARGET_ID" in
  test-central) GITHUB_OAUTH_PEER_ENV_FILE="$REPO_DIR/.env" ;;
  prod-central) GITHUB_OAUTH_PEER_ENV_FILE="$REPO_DIR/.env.test" ;;
  test-west) GITHUB_OAUTH_PEER_ENV_FILE="$REPO_DIR/.env.prod-west" ;;
  prod-west) GITHUB_OAUTH_PEER_ENV_FILE="$REPO_DIR/.env.test-west" ;;
esac

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }

ksecret() {
  # Atomic idempotent apply — no delete + create window, no pod-mount failure
  # if a volume-mounting pod gets scheduled mid-update.
  local name="$1"; shift
  kubectl create secret generic "$name" -n "$K8S_NAMESPACE" \
    --dry-run=client -o yaml "$@" | kubectl apply -f - >/dev/null
  ok "Secret: $name"
}

ksecret_exists() {
  kubectl get secret "$1" -n "$K8S_NAMESPACE" >/dev/null 2>&1
}

ksecret_key() {
  # Read a key from an existing K8s secret. Empty string if missing.
  kubectl get secret "$1" -n "$K8S_NAMESPACE" -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null || echo ""
}

sm_get() {
  gcloud secrets versions access latest --secret="$1" --project="${2:-$SM_PROJECT}" 2>/dev/null || echo ""
}

secret_manager_destroy_superseded_versions() {
  local name="$1" project="$2"
  local listing version state newest=0 newest_state="" failures=0
  listing="$(mktemp)"
  if ! gcloud secrets versions list "$name" --project="$project" --format='value(name,state)' >"$listing"; then
    rm -f "$listing"
    printf 'Could not list Secret Manager versions for %s/%s\n' "$project" "$name" >&2
    return 1
  fi
  while IFS=$'\t' read -r version state || [[ -n "$version" ]]; do
    version="${version##*/}"
    if [[ ! "$version" =~ ^[0-9]+$ || "$state" == "DESTROYED" ]]; then
      continue
    fi
    if (( version > newest )); then
      newest="$version"
      newest_state="$state"
    fi
  done <"$listing"
  if [[ "$newest_state" != "ENABLED" ]]; then
    rm -f "$listing"
    printf 'Refusing to prune %s/%s: newest live version is %s\n' "$project" "$name" "${newest_state:-absent}" >&2
    return 1
  fi
  while IFS=$'\t' read -r version state || [[ -n "$version" ]]; do
    version="${version##*/}"
    if [[ ! "$version" =~ ^[0-9]+$ || "$state" == "DESTROYED" ]]; then
      continue
    fi
    if (( version >= newest )); then
      continue
    fi
    if ! gcloud secrets versions destroy "$version" --secret="$name" --project="$project" --quiet >/dev/null; then
      printf 'Failed to destroy superseded Secret Manager version %s/%s/%s\n' "$project" "$name" "$version" >&2
      failures=$((failures + 1))
    fi
  done <"$listing"
  rm -f "$listing"
  if (( failures > 0 )); then
    return 1
  fi
  return 0
}

secret_manager_persist_version_file() {
  local name="$1" file="$2" project="$3"
  local current
  if ! gcloud secrets describe "$name" --project="$project" >/dev/null 2>&1; then
    if ! gcloud secrets create "$name" --data-file="$file" --project="$project" \
      --replication-policy=user-managed --locations="$TARGET_REGION" --quiet >/dev/null; then
      printf 'Could not create Secret Manager secret %s/%s\n' "$project" "$name" >&2
      return 1
    fi
    return 0
  fi
  current="$(mktemp)"
  chmod 600 "$current"
  if gcloud secrets versions access latest --secret="$name" --project="$project" >"$current" 2>/dev/null \
    && cmp -s "$current" "$file"; then
    rm -f "$current"
    return 0
  fi
  rm -f "$current"
  if ! gcloud secrets versions add "$name" --data-file="$file" --project="$project" --quiet >/dev/null; then
    printf 'Could not add Secret Manager version for %s/%s\n' "$project" "$name" >&2
    return 1
  fi
  if ! secret_manager_destroy_superseded_versions "$name" "$project"; then
    printf 'Superseded Secret Manager versions remain for %s/%s\n' "$project" "$name" >&2
  fi
  return 0
}

secret_manager_persist_value() {
  local name="$1" value="$2" project="$3"
  local payload status=0
  payload="$(mktemp)"
  chmod 600 "$payload"
  printf '%s' "$value" >"$payload"
  secret_manager_persist_version_file "$name" "$payload" "$project" || status=$?
  rm -f "$payload"
  return "$status"
}

sync_secret_manager_value() {
  local name="$1"
  local value="$2"
  local project="${3:-$SM_PROJECT}"
  local normalizer="${4:-configured_secret_value}"
  [[ -n "$value" ]] || fail "Refusing to persist empty Secret Manager value: $name"

  local state current normalized_current normalized_value
  state="$(secret_manager_secret_state "$name" "$project")"
  case "$state" in
    present)
      current="$(gcloud secrets versions access latest \
        --secret="$name" --project="$project" 2>/dev/null)" \
        || fail "Could not read existing Secret Manager value: $name"
      normalized_current="$("$normalizer" "$current")" \
        || fail "Existing Secret Manager value is invalid: $name"
      normalized_value="$("$normalizer" "$value")" \
        || fail "Proposed Secret Manager value is invalid: $name"
      [[ "$normalized_current" == "$normalized_value" ]] \
        || fail "Secret Manager is authoritative for $name; rotate it there before running setup-secrets.sh"
      ok "Secret Manager: $name"
      ;;
    absent)
      secret_manager_persist_value "$name" "$value" "$project" \
        || fail "Could not create absent Secret Manager value: $name"
      ok "Secret Manager: $name"
      ;;
    *) fail "Could not establish Secret Manager state: $name" ;;
  esac
}

read_authoritative_secret_manager_value() {
  local name="$1"
  local project="$2"
  local normalizer="$3"
  local state raw
  state="$(secret_manager_secret_state "$name" "$project")"
  case "$state" in
    present)
      raw="$(gcloud secrets versions access latest \
        --secret="$name" --project="$project" 2>/dev/null)" \
        || { echo "Could not read authoritative Secret Manager value: $name" >&2; return 1; }
      "$normalizer" "$raw"
      ;;
    absent) return 0 ;;
    *) echo "Could not establish authoritative Secret Manager state: $name" >&2; return 1 ;;
  esac
}

resolve_environment_secret_value() {
  local initial="$1"
  local sm_name="$2"
  local k8s_secret="$3"
  local k8s_key="$4"
  local normalizer="$5"
  local secret_manager_project="${6:-$FIREBASE_PROJECT}"
  local env_value secret_manager_value kubernetes_value
  env_value="$("$normalizer" "$initial")"
  kubernetes_value="$("$normalizer" "$(ksecret_key "$k8s_secret" "$k8s_key")")"
  if [[ "$ENV" == "custom" ]]; then
    if [[ -n "$kubernetes_value" ]]; then
      printf '%s' "$kubernetes_value"
      return 0
    fi
    secret_manager_value="$("$normalizer" "$(sm_get "$sm_name" "$secret_manager_project")")"
    select_environment_secret_value \
      "$ENV" "$secret_manager_value" "$env_value" "$kubernetes_value"
    return 0
  fi
  secret_manager_value="$(read_authoritative_secret_manager_value \
    "$sm_name" "$secret_manager_project" "$normalizer")" || return 1
  select_environment_secret_value \
    "$ENV" "$secret_manager_value" "$env_value" "$kubernetes_value"
}

# Load env file
set +u
load_env_file "$ENV_FILE"
set -u

if [[ -n "$GITHUB_OAUTH_PEER_ENV_FILE" && -f "$GITHUB_OAUTH_PEER_ENV_FILE" ]]; then
  CURRENT_GITHUB_CLIENT_ID="$(github_oauth_configured_client_id "$ENV_FILE")"
  PEER_GITHUB_CLIENT_ID="$(github_oauth_configured_client_id "$GITHUB_OAUTH_PEER_ENV_FILE")"
  github_oauth_require_distinct_client_ids \
    "$CURRENT_GITHUB_CLIENT_ID" \
    "$PEER_GITHUB_CLIENT_ID" \
    "$TARGET_ID" \
    "$(basename "$GITHUB_OAUTH_PEER_ENV_FILE" | sed 's/^\.env\.//')"
fi

[[ "$ENV" == "prod" && "$YES" == "true" ]] && fail "--yes cannot be used with prod."

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Pre-Helm Secrets — ${ENV_LABEL}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── kubectl context ───────────────────────────────────────────────────────
info "Setting kubectl context: $K8S_CONTEXT"
gcloud container clusters get-credentials "$CLUSTER_NAME" --region "$TARGET_REGION" --project "$CLUSTER_PROJECT"
kubectl config use-context "$K8S_CONTEXT" >/dev/null
[[ "$(kubectl config current-context)" == "$K8S_CONTEXT" ]] || fail "Wrong kubectl context"
kubectl --context "$K8S_CONTEXT" cluster-info >/dev/null
ok "kubectl context: $K8S_CONTEXT"
info "This script owns secret materialization into Kubernetes. It does not fully repair Mattermost/Gitea bootstrap state by itself."

# Ensure namespace
if [[ "$ENV" == "custom" ]]; then
  kubectl get namespace "$K8S_NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$K8S_NAMESPACE"
else
  "$SCRIPT_DIR/ensure-namespace-security.sh" --deployment-target="$TARGET_ID" --mode=enforce
fi
ok "Namespace: $K8S_NAMESPACE"
echo ""

# ── 0. Gitea SSH key (gateway volume mount — blocks Init if missing) ──────
info "gitea-ssh-key"
if kubectl get secret gitea-ssh-key -n "$K8S_NAMESPACE" >/dev/null 2>&1; then
  ok "gitea-ssh-key already exists"
else
  info "  Generating SSH keypair for Gitea..."
  TMPKEY=$(mktemp)
  rm -f "$TMPKEY" "${TMPKEY}.pub"
  ssh-keygen -t ed25519 -f "$TMPKEY" -N "" -C "octogee-gateway" -q
  ksecret gitea-ssh-key \
    --from-file=id_ed25519="$TMPKEY" \
    --from-file=id_ed25519.pub="${TMPKEY}.pub"
  info "  Register this public key in Gitea after setup-gitea.sh:"
  info "  $(cat "${TMPKEY}.pub")"
  rm -f "$TMPKEY" "${TMPKEY}.pub"
fi
echo ""

# ── 1. Mattermost DB password ─────────────────────────────────────────────
AGENT_STORE_SECRET_PREFIX="agent-store-postgres"
[[ "$ENV" != custom ]] || AGENT_STORE_SECRET_PREFIX="agent-store-postgres-$K8S_NAMESPACE"
materialize_agent_store_postgres_secret "$FIREBASE_PROJECT" "$K8S_NAMESPACE" "$K8S_CONTEXT" "$AGENT_STORE_SECRET_PREFIX"
ok "Secret: agent-store-postgres"

if [[ "$ENV" != custom ]]; then
  materialize_platform_state_postgres_secret "$FIREBASE_PROJECT" "$TARGET_CLOUD_SQL_PROJECT" "$TARGET_CLOUD_SQL_PLATFORM_STATE_INSTANCE" "$K8S_NAMESPACE" "$K8S_CONTEXT"
  ok "Secret: platform-state-postgres"
fi

info "mattermost-cloud-sql"
MM_DB_PASSWORD=$(sm_get "$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET" "$SM_PROJECT")
[[ -n "$MM_DB_PASSWORD" ]] || fail "$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET not in Secret Manager ($SM_PROJECT project)"
ksecret mattermost-cloud-sql --from-literal=password="$MM_DB_PASSWORD"

# ── 2. Mattermost gateway creds ───────────────────────────────────────────
info "mattermost-gateway"
set +u
if [[ "$SECRET_SETUP_PHASE" == "launch" ]]; then
  MM_ADMIN_USER="$(ksecret_key mattermost-gateway admin_user)"
  MM_ADMIN_PASS="$(ksecret_key mattermost-gateway admin_pass)"
  MM_ADMIN_PAT="$(ksecret_key mattermost-gateway admin_token)"
  MM_ADMIN_PAT_ID="$(ksecret_key mattermost-gateway admin_token_id)"
  MM_ADMIN_PAT_FINGERPRINT="$(ksecret_key mattermost-gateway admin_token_fingerprint)"
  MM_TEAM_ID="$(ksecret_key mattermost-gateway team_id)"
  MM_ADMIN_USER_ID="$(ksecret_key mattermost-gateway admin_user_id)"
else
  MM_ADMIN_USER="${MM_ADMIN_USER:-$(ksecret_key mattermost-gateway admin_user)}"
  MM_ADMIN_USER="${MM_ADMIN_USER:-octogee-admin}"
  MM_ADMIN_PASS="${MM_ADMIN_PASS:-$(ksecret_key mattermost-gateway admin_pass)}"
  MM_ADMIN_PAT="$(ksecret_key mattermost-gateway admin_token)"
  MM_ADMIN_PAT_ID="$(ksecret_key mattermost-gateway admin_token_id)"
  MM_ADMIN_PAT_FINGERPRINT="$(ksecret_key mattermost-gateway admin_token_fingerprint)"
  MM_TEAM_ID="${MM_TEAM_ID:-$(ksecret_key mattermost-gateway team_id)}"
  MM_ADMIN_USER_ID="${MM_ADMIN_USER_ID:-$(ksecret_key mattermost-gateway admin_user_id)}"
fi
set -u
if [[ "$SECRET_SETUP_PHASE" == "bootstrap" ]]; then
  ksecret mattermost-gateway \
    --from-literal=admin_user="$MM_ADMIN_USER" \
    --from-literal=admin_pass="$MM_ADMIN_PASS" \
    --from-literal=admin_token="$MM_ADMIN_PAT" \
    --from-literal=admin_token_id="$MM_ADMIN_PAT_ID" \
    --from-literal=admin_token_fingerprint="$MM_ADMIN_PAT_FINGERPRINT" \
    --from-literal=team_id="$MM_TEAM_ID" \
    --from-literal=admin_user_id="$MM_ADMIN_USER_ID"
else
  ok "mattermost-gateway retained; setup-mattermost.sh owns the platform PAT"
fi

if [[ -z "$MM_ADMIN_PAT" || -z "$MM_ADMIN_PAT_ID" || -z "$MM_ADMIN_PAT_FINGERPRINT" || -z "$MM_TEAM_ID" || -z "$MM_ADMIN_USER_ID" ]]; then
  warn "mattermost-gateway contains blank bootstrap values. Run ./scripts/setup-mattermost.sh --env=$ENV$TARGET_ARG before trusting this environment."
fi

# ── 2c. Mattermost callback router signing secret ─────────────────────────
info "agent-control-router"
AGENT_CONTROL_ROUTER_SM_KEY="agent-control-router-ed25519-${INTERNAL_SECRET_SUFFIX}"
[[ "$ENV" == "custom" ]] && AGENT_CONTROL_ROUTER_SM_KEY="agent-control-router-ed25519-custom-${CUSTOM_NS}"
AGENT_CONTROL_ROUTER_SECRET=$(sm_get "$AGENT_CONTROL_ROUTER_SM_KEY" "$SM_PROJECT" 2>/dev/null || echo "")
if [[ -z "$AGENT_CONTROL_ROUTER_SECRET" ]]; then
  AGENT_CONTROL_ROUTER_SECRET=$(openssl genpkey -algorithm ED25519)
  info "  Generated new agent-control-router secret — saving to Secret Manager..."
  secret_manager_persist_value "$AGENT_CONTROL_ROUTER_SM_KEY" "$AGENT_CONTROL_ROUTER_SECRET" "$SM_PROJECT" \
    || fail "Could not persist agent-control-router secret to Secret Manager (key=${AGENT_CONTROL_ROUTER_SM_KEY})."
fi
AGENT_CONTROL_ROUTER_PUBLIC_KEY=$(printf '%s\n' "$AGENT_CONTROL_ROUTER_SECRET" | openssl pkey -pubout) \
  || fail "Could not derive the Mattermost callback Ed25519 public key"
validate_ed25519_keypair "$AGENT_CONTROL_ROUTER_SECRET" "$AGENT_CONTROL_ROUTER_PUBLIC_KEY" \
  || fail "Mattermost callback signing keys must be a matching Ed25519 keypair"
ksecret agent-control-router --from-literal=secret="$AGENT_CONTROL_ROUTER_SECRET" --from-literal=public-key="$AGENT_CONTROL_ROUTER_PUBLIC_KEY"

# ── 2d. BYOT sync internal signing secret ─────────────────────────────────
info "byot-sync-internal"
BYOT_SYNC_INTERNAL_SM_KEY="byot-sync-internal-ed25519-${INTERNAL_SECRET_SUFFIX}"
[[ "$ENV" == "custom" ]] && BYOT_SYNC_INTERNAL_SM_KEY="byot-sync-internal-ed25519-custom-${CUSTOM_NS}"
BYOT_SYNC_INTERNAL_SECRET=$(sm_get "$BYOT_SYNC_INTERNAL_SM_KEY" "$SM_PROJECT" 2>/dev/null || echo "")
if [[ -z "$BYOT_SYNC_INTERNAL_SECRET" ]]; then
  BYOT_SYNC_INTERNAL_SECRET=$(openssl genpkey -algorithm ED25519)
  info "  Generated new BYOT sync signing secret — saving to Secret Manager..."
  secret_manager_persist_value "$BYOT_SYNC_INTERNAL_SM_KEY" "$BYOT_SYNC_INTERNAL_SECRET" "$SM_PROJECT" \
    || fail "Could not persist BYOT sync signing secret to Secret Manager (key=${BYOT_SYNC_INTERNAL_SM_KEY}). Refusing to materialize a K8s secret that exists nowhere else."
fi
BYOT_SYNC_INTERNAL_PUBLIC_KEY=$(printf '%s\n' "$BYOT_SYNC_INTERNAL_SECRET" | openssl pkey -pubout) \
  || fail "Could not derive the model sync Ed25519 public key"
validate_ed25519_keypair "$BYOT_SYNC_INTERNAL_SECRET" "$BYOT_SYNC_INTERNAL_PUBLIC_KEY" \
  || fail "Model sync signing keys must be a matching Ed25519 keypair"
ksecret byot-sync-internal --from-literal=secret="$BYOT_SYNC_INTERNAL_SECRET" --from-literal=public-key="$BYOT_SYNC_INTERNAL_PUBLIC_KEY"

# ── 3. Gitea admin ────────────────────────────────────────────────────────
info "gitea-admin"
GITEA_ADMIN_PASSWORD_SM_KEY="gitea-admin-password-${INTERNAL_SECRET_SUFFIX}"
GITEA_ADMIN_PASS=$(sm_get "$GITEA_ADMIN_PASSWORD_SM_KEY" "$SM_PROJECT" 2>/dev/null || echo "")
if [[ -z "$GITEA_ADMIN_PASS" ]]; then
  GITEA_ADMIN_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
  info "  Generated new Gitea admin password — saving to Secret Manager..."
  secret_manager_persist_value "$GITEA_ADMIN_PASSWORD_SM_KEY" "$GITEA_ADMIN_PASS" "$SM_PROJECT" \
    || warn "  Could not persist Gitea admin password to Secret Manager (key=${GITEA_ADMIN_PASSWORD_SM_KEY})"
fi
ksecret gitea-admin \
  --from-literal=username="octogee-admin" \
  --from-literal=password="$GITEA_ADMIN_PASS"

# ── 4. Gitea credentials (internal tokens) ───────────────────────────────
# SECRET_KEY and INTERNAL_TOKEN are Gitea's internal crypto. They must NOT
# rotate across rebuilds — Gitea encrypts persisted data with them. First
# install: generate. Re-run: reuse what's already in the K8s secret.
info "gitea-credentials"
GITEA_DB_PASS=$(sm_get "$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET" "$SM_PROJECT")
[[ -n "$GITEA_DB_PASS" ]] || fail "$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET not in Secret Manager"

EXISTING_SECRET_KEY=$(ksecret_key gitea-credentials secret-key)
EXISTING_INTERNAL_TOKEN=$(ksecret_key gitea-credentials internal-token)

if [[ -n "$EXISTING_SECRET_KEY" && -n "$EXISTING_INTERNAL_TOKEN" ]]; then
  info "  Reusing existing Gitea SECRET_KEY + INTERNAL_TOKEN (do not rotate — encrypts persisted data)"
  GITEA_SECRET_KEY="$EXISTING_SECRET_KEY"
  GITEA_INTERNAL_TOKEN="$EXISTING_INTERNAL_TOKEN"
else
  info "  First install — generating Gitea SECRET_KEY + INTERNAL_TOKEN"
  GITEA_SECRET_KEY=$(openssl rand -hex 32)
  GITEA_INTERNAL_TOKEN=$(openssl rand -hex 64)
fi

ksecret gitea-credentials \
  --from-literal=admin-password="$GITEA_ADMIN_PASS" \
  --from-literal=db-password="$GITEA_DB_PASS" \
  --from-literal=secret-key="$GITEA_SECRET_KEY" \
  --from-literal=internal-token="$GITEA_INTERNAL_TOKEN"

# ── 5. Gitea API token (may not exist yet — created by setup-gitea.sh) ────
info "gitea-token"
GITEA_API_TOKEN_SM_KEY="gitea-api-token-${INTERNAL_SECRET_SUFFIX}"
GIT_API_TOKEN=$(sm_get "$GITEA_API_TOKEN_SM_KEY" "$SM_PROJECT" 2>/dev/null || echo "")
if [[ -n "$GIT_API_TOKEN" ]]; then
  ksecret gitea-token --from-literal=token="$GIT_API_TOKEN"
else
  warn "$GITEA_API_TOKEN_SM_KEY not in Secret Manager yet — run setup-gitea.sh after Helm to create it"
  ksecret gitea-token --from-literal=token=""
fi

# ── 6. Anthropic API key ──────────────────────────────────────────────────
info "octogee-anthropic"
ANTHROPIC_API_KEY="$(resolve_environment_secret_value \
  "${ANTHROPIC_API_KEY:-}" ANTHROPIC_API_KEY octogee-anthropic api_key configured_secret_value)" \
  || fail "Could not resolve ANTHROPIC_API_KEY from its environment source of truth"
[[ -n "$ANTHROPIC_API_KEY" ]] || fail "ANTHROPIC_API_KEY not found in .env or Secret Manager"
if [[ "$ENV" != "custom" ]]; then
  sync_secret_manager_value ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY" "$FIREBASE_PROJECT"
  save_env_file_value "$ENV_FILE" ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
fi
ksecret octogee-anthropic --from-literal=api_key="$ANTHROPIC_API_KEY"

# ── 6b. OpenRouter API key ─────────────────────────────────────────────────
info "octogee-openrouter"
OPENROUTER_API_KEY="$(resolve_environment_secret_value \
  "${OPENROUTER_API_KEY:-}" OPENROUTER_API_KEY octogee-openrouter api_key configured_secret_value)" \
  || fail "Could not resolve OPENROUTER_API_KEY from its environment source of truth"
[[ -n "$OPENROUTER_API_KEY" ]] || fail "OPENROUTER_API_KEY not found in .env or Secret Manager"
if [[ "$ENV" != "custom" ]]; then
  sync_secret_manager_value OPENROUTER_API_KEY "$OPENROUTER_API_KEY" "$FIREBASE_PROJECT"
  save_env_file_value "$ENV_FILE" OPENROUTER_API_KEY "$OPENROUTER_API_KEY"
fi
ksecret octogee-openrouter --from-literal=api_key="$OPENROUTER_API_KEY"

# ── 6c. OpenAI API key (llm-broker platform provider + embeddings) ────────
info "OPENAI_API_KEY (llm-broker platform provider + memory search embeddings)"
set +u
OPENAI_API_KEY="${OPENAI_API_KEY:-}"
OPENAI_EMBEDDINGS_API_KEY="${OPENAI_EMBEDDINGS_API_KEY:-}"
set -u
[[ -z "$OPENAI_API_KEY" && -n "$OPENAI_EMBEDDINGS_API_KEY" ]] && OPENAI_API_KEY="$OPENAI_EMBEDDINGS_API_KEY"
OPENAI_API_KEY="$(resolve_environment_secret_value \
  "$OPENAI_API_KEY" OPENAI_API_KEY octogee-openai api_key configured_secret_value)" \
  || fail "Could not resolve OPENAI_API_KEY from its environment source of truth"
if [[ -n "$OPENAI_API_KEY" ]]; then
  validate_openai_api_key "$OPENAI_API_KEY" \
    || fail "OPENAI_API_KEY cannot authenticate to the OpenAI models endpoint"
  if [[ "$ENV" != "custom" ]]; then
    sync_secret_manager_value OPENAI_API_KEY "$OPENAI_API_KEY" "$FIREBASE_PROJECT"
  fi
  # The llm-broker's platform-openai provider rides the same key (gpt-5.4-mini
  # via the free-tier dial); optional in helm, so absence only 503s openai traffic.
  ksecret octogee-openai --from-literal=api_key="$OPENAI_API_KEY"
else
  warn "OPENAI_API_KEY not found in .env or Secret Manager ($FIREBASE_PROJECT) — memory search embeddings stay disabled and the llm-broker serves no platform-openai traffic until the key is seeded"
fi

info "META_MODEL_API_KEY (llm-broker Meta Responses provider)"
META_MODEL_API_KEY="$(resolve_environment_secret_value \
  "${META_MODEL_API_KEY:-}" META_MODEL_API_KEY octogee-meta api_key configured_secret_value)" \
  || fail "Could not resolve META_MODEL_API_KEY from its environment source of truth"
if [[ -n "$META_MODEL_API_KEY" ]]; then
  [[ "$META_MODEL_API_KEY" == LLM_* ]] || fail "META_MODEL_API_KEY is not a Meta Model API key"
  ksecret octogee-meta --from-literal=api_key="$META_MODEL_API_KEY"
fi

# ── 7. Brave API key ──────────────────────────────────────────────────────
info "octogee-brave"
BRAVE_API_KEY="$(resolve_environment_secret_value \
  "${BRAVE_API_KEY:-}" BRAVE_API_KEY octogee-brave key configured_secret_value octogee)" \
  || fail "Could not resolve BRAVE_API_KEY from its platform source of truth"
if [[ -n "$BRAVE_API_KEY" ]]; then
  if [[ "$ENV" != "custom" ]]; then
    sync_secret_manager_value BRAVE_API_KEY "$BRAVE_API_KEY" octogee
    save_env_file_value "$ENV_FILE" BRAVE_API_KEY "$BRAVE_API_KEY"
  fi
  ksecret octogee-brave --from-literal=key="$BRAVE_API_KEY"
else
  warn "BRAVE_API_KEY not found — creating empty secret (optional)"
  ksecret octogee-brave --from-literal=key=""
fi

# ── 7b. Tavily API key ────────────────────────────────────────────────────
info "octogee-tavily"
set +u
TAVILY_API_KEY="${TAVILY_API_KEY:-}"
TAVILY_COST_PER_CREDIT_USD="${TAVILY_COST_PER_CREDIT_USD:-0.008}"
set -u
[[ -z "$TAVILY_API_KEY" ]] && TAVILY_API_KEY=$(sm_get TAVILY_API_KEY octogee 2>/dev/null || echo "")
if [[ -n "$TAVILY_API_KEY" ]]; then
  ksecret octogee-tavily \
    --from-literal=api_key="$TAVILY_API_KEY" \
    --from-literal=cost_per_credit_usd="$TAVILY_COST_PER_CREDIT_USD"
else
  warn "TAVILY_API_KEY not found — creating empty secret (optional)"
  ksecret octogee-tavily \
    --from-literal=api_key="" \
    --from-literal=cost_per_credit_usd="$TAVILY_COST_PER_CREDIT_USD"
fi

# ── 7c. Voice relay speech-provider keys (octogee-api /internal/voice) ─────
# Talk mode's relay is the only place speech-provider keys live (gateway pods
# never see them). One Mistral key serves Voxtral Realtime STT + Voxtral TTS;
# VOICE_STT_API_KEY / VOICE_TTS_API_KEY override either half. Talk stays dark
# until VOICE_* engine env is set on octogee-api regardless of these keys.
info "voice-provider"
set +u
MISTRAL_API_KEY="${MISTRAL_API_KEY:-}"
VOICE_STT_API_KEY="${VOICE_STT_API_KEY:-}"
VOICE_TTS_API_KEY="${VOICE_TTS_API_KEY:-}"
set -u
voice_key_from_env() {
  local name="$1" value="$2"
  [[ -n "$value" ]] || return 0
  secret_manager_persist_value "$name" "$value" "$FIREBASE_PROJECT" \
    || fail "Could not persist $name to Secret Manager ($FIREBASE_PROJECT)"
  ok "Secret Manager: $name"
}
voice_key_from_env MISTRAL_API_KEY "$MISTRAL_API_KEY"
voice_key_from_env VOICE_STT_API_KEY "$VOICE_STT_API_KEY"
voice_key_from_env VOICE_TTS_API_KEY "$VOICE_TTS_API_KEY"
[[ -z "$MISTRAL_API_KEY" ]] && MISTRAL_API_KEY=$(sm_get MISTRAL_API_KEY "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$VOICE_STT_API_KEY" ]] && VOICE_STT_API_KEY=$(sm_get VOICE_STT_API_KEY "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$VOICE_TTS_API_KEY" ]] && VOICE_TTS_API_KEY=$(sm_get VOICE_TTS_API_KEY "$FIREBASE_PROJECT" 2>/dev/null || echo "")
# Without a Mistral key the platform OpenRouter key serves both halves (batch
# Voxtral transcription + Kokoro/Voxtral speech through OpenRouter — the
# zero-signup recipe in docs/operations/VOICE-TALK.md); the VOICE_* engine env
# in helm values decides which provider each half actually calls.
if [[ -n "$MISTRAL_API_KEY" ]]; then
  [[ -z "$VOICE_STT_API_KEY" ]] && VOICE_STT_API_KEY="$MISTRAL_API_KEY"
  [[ -z "$VOICE_TTS_API_KEY" ]] && VOICE_TTS_API_KEY="$MISTRAL_API_KEY"
  ok "voice-provider: Mistral key (Voxtral Realtime STT + Voxtral TTS)"
else
  [[ -z "$VOICE_STT_API_KEY" ]] && VOICE_STT_API_KEY="$OPENROUTER_API_KEY"
  [[ -z "$VOICE_TTS_API_KEY" ]] && VOICE_TTS_API_KEY="$OPENROUTER_API_KEY"
  ok "voice-provider: no MISTRAL_API_KEY — platform OpenRouter key serves the halves not overridden (batch STT; use the OpenRouter blocks in VOICE_* env)"
fi
ksecret voice-provider \
  --from-literal=stt_api_key="$VOICE_STT_API_KEY" \
  --from-literal=tts_api_key="$VOICE_TTS_API_KEY"

# ── 8. Connector OAuth client secrets (octogee-api /api/connect/<provider>) ─
# octogee-api reads client_id + client_secret from these K8s secrets to run the
# Connections OAuth flow (helm wires them with optional:true). Sourced from the
# env file, Secret Manager fallback. The original single GitHub *token* was
# dropped 2026-05-14 when GitHub was thought dead; GitHub returned as a
# Connections connector, so the per-provider OAuth client secrets are
# established here — a regression caused "GitHub connection is not configured".
oauth_secret() {
  local provider="$1" secret="$2" id_var="$3" sec_var="$4"
  info "$secret"
  if [[ "$(octogee_oauth_provider_requirement "$provider")" == "disabled" ]]; then
    info "  skipped — provider disabled"
    return 0
  fi
  local id sec
  set +u
  id="$(resolve_environment_secret_value "${!id_var:-}" "$id_var" "$secret" client_id configured_secret_value)" \
    || fail "could not resolve $id_var for $TARGET_ID"
  sec="$(resolve_environment_secret_value "${!sec_var:-}" "$sec_var" "$secret" client_secret configured_secret_value)" \
    || fail "could not resolve $sec_var for $TARGET_ID"
  set -u
  [[ -n "$id" && -n "$sec" ]] \
    || fail "$id_var and $sec_var are required for $TARGET_ID; add them to $ENV_FILE or Secret Manager ($FIREBASE_PROJECT). $secret was left unchanged."
  export "$id_var=$id" "$sec_var=$sec"
  ksecret "$secret" --from-literal=client_id="$id" --from-literal=client_secret="$sec"
}
oauth_secret github    github-oauth    GITHUB_CLIENT_ID    GITHUB_CLIENT_SECRET
oauth_secret microsoft microsoft-oauth MICROSOFT_CLIENT_ID MICROSOFT_CLIENT_SECRET

info "google-oauth"
persist_google_env() {
  local env_file="$1"
  save_env_file_value "$env_file" GOOGLE_CLIENT_ID "$G_ID"
  save_env_file_value "$env_file" GOOGLE_CLIENT_SECRET "$G_SEC"
  save_env_file_value "$env_file" GOOGLE_PICKER_CLIENT_ID "$G_PICKER_ID"
  save_env_file_value "$env_file" GOOGLE_PICKER_API_KEY "$G_PICKER_KEY"
  save_env_file_value "$env_file" GOOGLE_PICKER_APP_ID "$G_PICKER_APP"
}

G_ID="$(resolve_environment_secret_value "${GOOGLE_CLIENT_ID:-}" GOOGLE_CLIENT_ID google-oauth client_id configured_secret_value)"
G_SEC="$(resolve_environment_secret_value "${GOOGLE_CLIENT_SECRET:-}" GOOGLE_CLIENT_SECRET google-oauth client_secret configured_secret_value)"
G_PICKER_ID="$(resolve_environment_secret_value "${GOOGLE_PICKER_CLIENT_ID:-}" GOOGLE_PICKER_CLIENT_ID google-oauth picker_client_id configured_secret_value)"
G_PICKER_KEY="$(resolve_environment_secret_value "${GOOGLE_PICKER_API_KEY:-}" GOOGLE_PICKER_API_KEY google-oauth picker_api_key configured_secret_value)"
G_PICKER_APP="$(resolve_environment_secret_value "${GOOGLE_PICKER_APP_ID:-}" GOOGLE_PICKER_APP_ID google-oauth picker_app_id configured_secret_value)"
[[ -z "$G_ID" || -z "$G_SEC" ]] && warn "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not set — Google connect disabled"
[[ -n "$G_PICKER_ID" && "$G_PICKER_ID" == "$G_ID" ]] && fail "GOOGLE_PICKER_CLIENT_ID must be a dedicated browser client, not GOOGLE_CLIENT_ID"
[[ -z "$G_PICKER_ID" || -z "$G_PICKER_KEY" || -z "$G_PICKER_APP" ]] && warn "GOOGLE_PICKER_CLIENT_ID/GOOGLE_PICKER_API_KEY/GOOGLE_PICKER_APP_ID not set — Drive picker disabled"
if [[ "$ENV" != "custom" ]]; then
  [[ -n "$G_ID" ]] && sync_secret_manager_value GOOGLE_CLIENT_ID "$G_ID" "$FIREBASE_PROJECT"
  [[ -n "$G_SEC" ]] && sync_secret_manager_value GOOGLE_CLIENT_SECRET "$G_SEC" "$FIREBASE_PROJECT"
  [[ -n "$G_PICKER_ID" ]] && sync_secret_manager_value GOOGLE_PICKER_CLIENT_ID "$G_PICKER_ID" "$FIREBASE_PROJECT"
  [[ -n "$G_PICKER_KEY" ]] && sync_secret_manager_value GOOGLE_PICKER_API_KEY "$G_PICKER_KEY" "$FIREBASE_PROJECT"
  [[ -n "$G_PICKER_APP" ]] && sync_secret_manager_value GOOGLE_PICKER_APP_ID "$G_PICKER_APP" "$FIREBASE_PROJECT"
fi
if [[ -n "$G_ID" && -n "$G_SEC" && -n "$G_PICKER_ID" && -n "$G_PICKER_KEY" && -n "$G_PICKER_APP" ]]; then
  persist_google_env "$ENV_FILE"
  [[ "$ENV" == "test" ]] && persist_google_env "$REPO_DIR/.env.local"
fi
export GOOGLE_CLIENT_ID="$G_ID"
export GOOGLE_CLIENT_SECRET="$G_SEC"
export GOOGLE_PICKER_CLIENT_ID="$G_PICKER_ID"
export GOOGLE_PICKER_API_KEY="$G_PICKER_KEY"
export GOOGLE_PICKER_APP_ID="$G_PICKER_APP"
ksecret google-oauth \
  --from-literal=client_id="$G_ID" \
  --from-literal=client_secret="$G_SEC" \
  --from-literal=picker_client_id="$G_PICKER_ID" \
  --from-literal=picker_api_key="$G_PICKER_KEY" \
  --from-literal=picker_app_id="$G_PICKER_APP"

# ── 8a. Firebase Auth login providers (WEST data projects only) ──────────
case "$TARGET_ID" in
  test-west|prod-west)
    info "identity-platform-login"
    FIREBASE_AUTH_GOOGLE_CLIENT_ID="$(resolve_environment_secret_value "${FIREBASE_AUTH_GOOGLE_CLIENT_ID:-}" FIREBASE_AUTH_GOOGLE_CLIENT_ID identity-platform-login FIREBASE_AUTH_GOOGLE_CLIENT_ID configured_secret_value)"
    FIREBASE_AUTH_GOOGLE_CLIENT_SECRET="$(resolve_environment_secret_value "${FIREBASE_AUTH_GOOGLE_CLIENT_SECRET:-}" FIREBASE_AUTH_GOOGLE_CLIENT_SECRET identity-platform-login FIREBASE_AUTH_GOOGLE_CLIENT_SECRET configured_secret_value)"
    FIREBASE_AUTH_GITHUB_CLIENT_ID="$(resolve_environment_secret_value "${FIREBASE_AUTH_GITHUB_CLIENT_ID:-}" FIREBASE_AUTH_GITHUB_CLIENT_ID identity-platform-login FIREBASE_AUTH_GITHUB_CLIENT_ID configured_secret_value)"
    FIREBASE_AUTH_GITHUB_CLIENT_SECRET="$(resolve_environment_secret_value "${FIREBASE_AUTH_GITHUB_CLIENT_SECRET:-}" FIREBASE_AUTH_GITHUB_CLIENT_SECRET identity-platform-login FIREBASE_AUTH_GITHUB_CLIENT_SECRET configured_secret_value)"
    [[ -n "$FIREBASE_AUTH_GOOGLE_CLIENT_ID" ]] || fail "FIREBASE_AUTH_GOOGLE_CLIENT_ID is required for $TARGET_ID"
    [[ -n "$FIREBASE_AUTH_GOOGLE_CLIENT_SECRET" ]] || fail "FIREBASE_AUTH_GOOGLE_CLIENT_SECRET is required for $TARGET_ID"
    [[ -n "$FIREBASE_AUTH_GITHUB_CLIENT_ID" ]] || fail "FIREBASE_AUTH_GITHUB_CLIENT_ID is required for $TARGET_ID"
    [[ -n "$FIREBASE_AUTH_GITHUB_CLIENT_SECRET" ]] || fail "FIREBASE_AUTH_GITHUB_CLIENT_SECRET is required for $TARGET_ID"
    sync_secret_manager_value FIREBASE_AUTH_GOOGLE_CLIENT_ID "$FIREBASE_AUTH_GOOGLE_CLIENT_ID" "$FIREBASE_PROJECT"
    sync_secret_manager_value FIREBASE_AUTH_GOOGLE_CLIENT_SECRET "$FIREBASE_AUTH_GOOGLE_CLIENT_SECRET" "$FIREBASE_PROJECT"
    sync_secret_manager_value FIREBASE_AUTH_GITHUB_CLIENT_ID "$FIREBASE_AUTH_GITHUB_CLIENT_ID" "$FIREBASE_PROJECT"
    sync_secret_manager_value FIREBASE_AUTH_GITHUB_CLIENT_SECRET "$FIREBASE_AUTH_GITHUB_CLIENT_SECRET" "$FIREBASE_PROJECT"
    ;;
esac

# ── 8b. Connect-state signing secret (octogee-api OAuth state HMAC) ────────
# HMAC secret that signs the OAuth `state` round-tripped through the provider
# (CSRF + payload integrity, 10min TTL). Self-generated — not a provider cred.
# Must NOT rotate during the lifetime of an in-flight connect (rotating
# mid-flow invalidates states users are mid-redirect on). First install:
# generate. Re-run: reuse what's already in Secret Manager. Its absence makes
# every connect throw "CONNECT_STATE_SECRET environment variable is required".
info "connect-state-secret"
CONNECT_STATE_SM_KEY="connect-state-secret-${INTERNAL_SECRET_SUFFIX}"
[[ "$ENV" == "custom" ]] && CONNECT_STATE_SM_KEY="connect-state-secret-custom-${CUSTOM_NS}"
CONNECT_STATE_SECRET=$(sm_get "$CONNECT_STATE_SM_KEY" "$SM_PROJECT" 2>/dev/null || echo "")
if [[ -z "$CONNECT_STATE_SECRET" ]]; then
  CONNECT_STATE_SECRET=$(openssl rand -hex 32)
  info "  Generated new connect-state secret — saving to Secret Manager..."
  secret_manager_persist_value "$CONNECT_STATE_SM_KEY" "$CONNECT_STATE_SECRET" "$SM_PROJECT" \
    || fail "Could not persist connect-state secret to Secret Manager (key=${CONNECT_STATE_SM_KEY}). Refusing to materialize a K8s secret that exists nowhere else."
fi
ksecret connect-state-secret --from-literal=secret="$CONNECT_STATE_SECRET"

# ── 9a. Gateway model-key issuer bearer (glm-controller → octogee-api) ─
# A dedicated bearer, separate from the gateway tenant-binding auth. It only
# authorizes the fleet controller to mint and revoke opaque LLM broker tokens via
# /internal/model-keys, and is never mounted into gateway pods.
info "gateway-model-key-issuer"
GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN=$(sm_get "GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" "$FIREBASE_PROJECT" 2>/dev/null || echo "")
if [[ -z "$GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" ]]; then
  EXISTING_MODEL_ISSUER=$(ksecret_key gateway-model-key-issuer bearer_token)
  if [[ -n "$EXISTING_MODEL_ISSUER" ]]; then
    info "  Reusing existing GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN from K8s, back-filling Secret Manager"
    GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN="$EXISTING_MODEL_ISSUER"
    secret_manager_persist_value "GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" "$GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" "$FIREBASE_PROJECT" \
      || warn "  Could not back-fill GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN into Secret Manager"
  else
    GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN=$(openssl rand -hex 32)
    info "  First install — generating GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN, saving to Secret Manager ($FIREBASE_PROJECT)"
    if secret_manager_persist_value "GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" "$GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN" "$FIREBASE_PROJECT"; then
      ok "  Saved SM secret: GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN"
    else
      warn "  Could not persist to SM — key only in K8s this run; re-run to persist"
    fi
  fi
fi
ksecret gateway-model-key-issuer --from-literal=bearer_token="$GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN"

# ── 9a2. Ops Agent bearer (octogee-api → octogee-ops-agent) ─────────────
info "ops-agent-bearer"
OPS_AGENT_BEARER_TOKEN="$(configured_secret_value "${OPS_AGENT_BEARER_TOKEN:-}")"
[[ -n "$OPS_AGENT_BEARER_TOKEN" ]] || OPS_AGENT_BEARER_TOKEN=$(sm_get "OPS_AGENT_BEARER_TOKEN" "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -n "$OPS_AGENT_BEARER_TOKEN" ]] || OPS_AGENT_BEARER_TOKEN=$(ksecret_key ops-agent-bearer bearer_token)
[[ -n "$OPS_AGENT_BEARER_TOKEN" ]] || OPS_AGENT_BEARER_TOKEN=$(openssl rand -hex 32)
if [[ "$ENV" != "custom" ]]; then
  sync_secret_manager_value OPS_AGENT_BEARER_TOKEN "$OPS_AGENT_BEARER_TOKEN" "$FIREBASE_PROJECT"
fi
save_env_file_value "$ENV_FILE" OPS_AGENT_BEARER_TOKEN "$OPS_AGENT_BEARER_TOKEN"
ksecret ops-agent-bearer --from-literal=bearer_token="$OPS_AGENT_BEARER_TOKEN"

# ── 9a2. Social notification bearer (Cloud Functions → octogee-api /social) ─
# Dedicated bearer for the out-of-cluster social inbox producer — the only auth
# on the public /api/notifications/social route. octogee-api reads
# the K8s secret; Functions read the Secret Manager copy via defineSecret — both
# must carry the SAME value. Precedence: Secret Manager > existing K8s > generated.
info "social-notification-bearer"
SOCIAL_NOTIFICATION_BEARER=$(sm_get "SOCIAL_NOTIFICATION_BEARER_TOKEN" "$FIREBASE_PROJECT" 2>/dev/null || echo "")
if [[ -z "$SOCIAL_NOTIFICATION_BEARER" ]]; then
  EXISTING_SNB=$(ksecret_key social-notification-bearer bearer-token)
  if [[ -n "$EXISTING_SNB" ]]; then
    info "  Reusing existing social bearer from K8s, back-filling Secret Manager"
    SOCIAL_NOTIFICATION_BEARER="$EXISTING_SNB"
    secret_manager_persist_value "SOCIAL_NOTIFICATION_BEARER_TOKEN" "$SOCIAL_NOTIFICATION_BEARER" "$FIREBASE_PROJECT" \
      || warn "  Could not back-fill SOCIAL_NOTIFICATION_BEARER_TOKEN into Secret Manager"
  else
    SOCIAL_NOTIFICATION_BEARER=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 40)
    info "  First install — generating social bearer, saving to Secret Manager ($FIREBASE_PROJECT)"
    if secret_manager_persist_value "SOCIAL_NOTIFICATION_BEARER_TOKEN" "$SOCIAL_NOTIFICATION_BEARER" "$FIREBASE_PROJECT"; then
      ok "  Saved SM secret: SOCIAL_NOTIFICATION_BEARER_TOKEN"
    else
      warn "  Could not persist to SM — bearer only in K8s this run; re-run to persist"
    fi
  fi
fi
ksecret social-notification-bearer --from-literal=bearer-token="$SOCIAL_NOTIFICATION_BEARER"

# ── 9b. Fleet controller signing keypair (glm-controller ↔ gateway) ──────
# glm-controller signs the in-cluster migration RPCs with an Ed25519 private
# key; gateway pods verify with only the public key. Secret Manager is the
# durable store and the K8s Secret fans the split material into the right pods:
#   - octogee-fleet-controller/private-key → glm-controller only
#   - octogee-fleet-controller/public-key  → gateway pods only
# Rotating = new SM private-key version + derived public-key version + re-run
# this script + rollout the gateway/controller pods.
info "octogee-fleet-controller (fleet controller Ed25519 keypair)"

persist_sm_file() {
  local name="$1" file="$2"
  secret_manager_persist_version_file "$name" "$file" "$FIREBASE_PROJECT" \
    || fail "Could not persist Secret Manager secret: $name"
  ok "  Persisted SM secret: $name"
}

FLEET_PRIVATE_TMP=$(mktemp)
FLEET_PUBLIC_TMP=$(mktemp)
FLEET_DERIVED_PUBLIC_TMP=$(mktemp)
gcloud secrets versions access latest --secret=FLEET_CONTROLLER_PRIVATE_KEY \
  --project="$FIREBASE_PROJECT" > "$FLEET_PRIVATE_TMP" 2>/dev/null || true
gcloud secrets versions access latest --secret=FLEET_CONTROLLER_PUBLIC_KEY \
  --project="$FIREBASE_PROJECT" > "$FLEET_PUBLIC_TMP" 2>/dev/null || true

if [[ ! -s "$FLEET_PRIVATE_TMP" ]]; then
  info "  First install — generating FLEET_CONTROLLER_PRIVATE_KEY, saving to Secret Manager ($FIREBASE_PROJECT)"
  openssl genpkey -algorithm Ed25519 -out "$FLEET_PRIVATE_TMP"
  persist_sm_file "FLEET_CONTROLLER_PRIVATE_KEY" "$FLEET_PRIVATE_TMP"
fi

if ! openssl pkey -in "$FLEET_PRIVATE_TMP" -noout >/dev/null 2>&1; then
  rm -f "$FLEET_PRIVATE_TMP" "$FLEET_PUBLIC_TMP" "$FLEET_DERIVED_PUBLIC_TMP"
  fail "FLEET_CONTROLLER_PRIVATE_KEY is not a valid private key"
fi

openssl pkey -in "$FLEET_PRIVATE_TMP" -pubout -out "$FLEET_DERIVED_PUBLIC_TMP" >/dev/null 2>&1
if [[ ! -s "$FLEET_PUBLIC_TMP" ]] || ! cmp -s "$FLEET_PUBLIC_TMP" "$FLEET_DERIVED_PUBLIC_TMP"; then
  info "  Deriving FLEET_CONTROLLER_PUBLIC_KEY from the private key"
  cp "$FLEET_DERIVED_PUBLIC_TMP" "$FLEET_PUBLIC_TMP"
  persist_sm_file "FLEET_CONTROLLER_PUBLIC_KEY" "$FLEET_PUBLIC_TMP"
fi

# No runtime service account reads these from Secret Manager. SM is only the
# durable store this script reads/writes with operator creds.
ksecret octogee-fleet-controller \
  --from-file=private-key="$FLEET_PRIVATE_TMP" \
  --from-file=public-key="$FLEET_PUBLIC_TMP"
rm -f "$FLEET_PRIVATE_TMP" "$FLEET_PUBLIC_TMP" "$FLEET_DERIVED_PUBLIC_TMP"

# ── 9c. Gateway auth token secret shell + IAM ────────────────────────────
# Legacy compatibility shell for the old Secret Manager OpenClaw-token path.
# Normal Kubernetes gateway pods keep gateway auth pod-local now:
# gateway-edge receives the same per-gateway OPENCLAW_GATEWAY_TOKEN env
# exception, pairs once with OpenClaw, then uses a sidecar-local device token.
# The Secret Manager publisher is opt-in via
# GATEWAY_AUTH_SECRET_MANAGER_PUBLISH=true for rollback/legacy deployments.
#
# Why NOT pre-populate the live value here: the normal runtime does not use SM
# for gateway auth. Legacy opt-in publishing overwrites the placeholder at
# boot if explicitly enabled.
#
# Each stable shared gateway member and disposable gateway gets its own secret so
# gateway-edge can route an assigned user without mixing tokens.
#
# Gateway IDs by env (match helm/octogee/values.{test,prod}.yaml):
info "gateway-auth-token (Secret Manager, per-gatewayId)"
case "$ENV" in
  prod|test|custom)
    GATEWAY_IDS=("shared-a" "shared-b" "shared-c" "shared-d")
    ;;
esac

# Legacy opt-in publisher/reader roles. These are resource-scoped to the
# per-gateway auth-token secret and should be removed once the SM rollback path
# is deleted.
GATEWAY_SA="octogee-gateway@${FIREBASE_PROJECT}.iam.gserviceaccount.com"

for gw_id in "${GATEWAY_IDS[@]}"; do
  SECRET_NAME="gateway-auth-token-${gw_id}"
  if gcloud secrets describe "$SECRET_NAME" --project="$FIREBASE_PROJECT" >/dev/null 2>&1; then
    info "  $SECRET_NAME already exists in SM ($FIREBASE_PROJECT)"
  else
    # Seed with a placeholder ONLY so the secret has a version — the first
    # gateway boot overwrites this within seconds. Required because
    # accessSecretVersion on a version-less secret throws NOT_FOUND, which
    # would blackhole chat-proxy if it happened to boot first.
    #
    # The literal MUST match GATEWAY_TOKEN_PLACEHOLDER in
    # chat-proxy/src/openclaw/gateway-token-constants.ts — the fetcher
    # detects this exact string and rejects it with `empty-token` so the
    # bootstrap window surfaces as a clean 503 instead of a doomed
    # auth-failed dance.
    if secret_manager_persist_value "$SECRET_NAME" "placeholder-awaiting-gateway-boot" "$FIREBASE_PROJECT"; then
      ok "  Created SM secret: $SECRET_NAME (placeholder)"
    else
      warn "  Could not create $SECRET_NAME"
      continue
    fi
  fi

  # IAM: gateway SA needs BOTH roles — add versions on boot, access to
  # verify its own publish round-tripped. Scoped to this single secret.
  gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
    --member="serviceAccount:$GATEWAY_SA" \
    --role="roles/secretmanager.secretVersionAdder" \
    --project="$FIREBASE_PROJECT" --quiet >/dev/null 2>&1 \
    && ok "  IAM: $GATEWAY_SA → secretVersionAdder on $SECRET_NAME" \
    || warn "  Could not grant secretVersionAdder on $SECRET_NAME"
  gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
    --member="serviceAccount:$GATEWAY_SA" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$FIREBASE_PROJECT" --quiet >/dev/null 2>&1 \
    && ok "  IAM: $GATEWAY_SA → secretAccessor on $SECRET_NAME" \
    || warn "  Could not grant secretAccessor on $SECRET_NAME"
  # Version destroyer for publish-gateway-token.mjs's prune step.
  gcloud secrets add-iam-policy-binding "$SECRET_NAME" \
    --member="serviceAccount:$GATEWAY_SA" \
    --role="roles/secretmanager.secretVersionManager" \
    --project="$FIREBASE_PROJECT" --quiet >/dev/null 2>&1 \
    && ok "  IAM: $GATEWAY_SA → secretVersionManager on $SECRET_NAME" \
    || warn "  Could not grant secretVersionManager on $SECRET_NAME"
done

run_secret_steps ${SECRET_SETUP_STEPS[@]+"${SECRET_SETUP_STEPS[@]}"}

# ── 11c. Invite token signing secret ─────────────────────────────────────
# HMAC key for signed invite tokens (gateway-edge/octogee-api inviteTokens.ts).
# Required for user invites; the route 500s without it. K8s Secret:
# invite-secret { secret → INVITE_SECRET }.
info "invite-secret"
set +u
INVITE_SECRET="${INVITE_SECRET:-}"
set -u
[[ -z "$INVITE_SECRET" ]] && INVITE_SECRET=$(sm_get INVITE_SECRET "$FIREBASE_PROJECT" 2>/dev/null || echo "")
[[ -z "$INVITE_SECRET" ]] && warn "INVITE_SECRET not found — invite links will fail until configured"
ksecret invite-secret --from-literal=secret="${INVITE_SECRET:-placeholder}"

# ── Firebase / Cloud Functions secrets (must exist before firebase deploy) ───
# Firebase prompts interactively if these secrets don't exist in Secret Manager.
# Pre-create them with placeholder values; runtime services read the canonical
# K8s secrets directly where possible.
info "Pre-creating Firebase function secrets in Secret Manager (suppress deploy prompts)..."
SM_PROJECT_CF="$FIREBASE_PROJECT"  # Functions run in the target's Firebase project

function_secret_value() {
  case "$1" in
    SOCIAL_NOTIFICATION_BEARER_TOKEN) configured_secret_value "${SOCIAL_NOTIFICATION_BEARER:-}" ;;
    *)
      set +u
      local value="${!1:-}"
      set -u
      configured_secret_value "$value"
      ;;
  esac
}

sync_function_secret() {
  local secret="$1" configured="$2"
  if [[ -z "$configured" ]] && gcloud secrets describe "$secret" --project="$SM_PROJECT_CF" >/dev/null 2>&1; then
    info "  $secret already exists in SM ($SM_PROJECT_CF)"
    return 0
  fi

  [[ -n "$configured" ]] || configured="placeholder"
  secret_manager_persist_value "$secret" "$configured" "$SM_PROJECT_CF" || return 1
  ok "  Synced SM secret: $secret"
}

# Full list of all defineSecret() references in Cloud Functions — must exist before firebase deploy
for sm_secret in \
  SOCIAL_NOTIFICATION_BEARER_TOKEN \
  DISCORD_OPS_WEBHOOK_URL; do
  function_value="$(function_secret_value "$sm_secret")"
  sync_function_secret "$sm_secret" "$function_value" || warn "  Could not sync $sm_secret"
done

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}Secret completeness summary${NC}"
OCTOGEE_SECRET_COMPLETENESS_FAILURES=0
# One row per secret — label, value, requirement travel together so the
# summary cannot silently misalign the way parallel arrays did.
completeness_row() {
  octogee_secret_completeness_entry "$1" "$2" "$3" "$TARGET_LIFECYCLE" "$SECRET_SETUP_PHASE"
}
completeness_row "mattermost-gateway / admin_user"              "${MM_ADMIN_USER:-}"                        post-bootstrap
completeness_row "mattermost-gateway / admin_pass"              "${MM_ADMIN_PASS:-}"                        post-bootstrap
completeness_row "mattermost-gateway / admin_pat"               "${MM_ADMIN_PAT:-}"                         post-bootstrap
completeness_row "mattermost-gateway / admin_pat_id"            "${MM_ADMIN_PAT_ID:-}"                      post-bootstrap
completeness_row "mattermost-gateway / admin_pat_fingerprint"   "${MM_ADMIN_PAT_FINGERPRINT:-}"             post-bootstrap
completeness_row "mattermost-gateway / admin_user_id"           "${MM_ADMIN_USER_ID:-}"                     post-bootstrap
completeness_row "mattermost-gateway / team_id"                 "${MM_TEAM_ID:-}"                           post-bootstrap
completeness_row "gitea-token"                                  "${GIT_API_TOKEN:-}"                        post-bootstrap
completeness_row "gateway-model-key-issuer"                     "${GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN:-}" launch
completeness_row "ops-agent-bearer"                             "${OPS_AGENT_BEARER_TOKEN:-}"               launch
completeness_row "social-notification-bearer"                   "${SOCIAL_NOTIFICATION_BEARER:-}"           launch
completeness_row "octogee-anthropic"                            "${ANTHROPIC_API_KEY:-}"                    launch
completeness_row "octogee-openrouter"                           "${OPENROUTER_API_KEY:-}"                   launch
completeness_row "openai-embeddings"                            "${OPENAI_API_KEY:-}"                       optional
completeness_row "voice-provider / stt_api_key"                 "${VOICE_STT_API_KEY:-}"                    optional
completeness_row "voice-provider / tts_api_key"                 "${VOICE_TTS_API_KEY:-}"                    optional
completeness_row "github-oauth / client_id"                     "${GITHUB_CLIENT_ID:-}"                     "$(octogee_oauth_provider_requirement github)"
completeness_row "github-oauth / client_secret"                 "${GITHUB_CLIENT_SECRET:-}"                 "$(octogee_oauth_provider_requirement github)"
completeness_row "google-oauth / client_id"                     "${G_ID:-}"                                 "$(octogee_oauth_provider_requirement google)"
completeness_row "google-oauth / client_secret"                 "${G_SEC:-}"                                "$(octogee_oauth_provider_requirement google)"
completeness_row "google-oauth / picker_client_id"              "${G_PICKER_ID:-}"                          "$(octogee_oauth_provider_requirement google)"
completeness_row "google-oauth / picker_api_key"                "${G_PICKER_KEY:-}"                         "$(octogee_oauth_provider_requirement google)"
completeness_row "google-oauth / picker_app_id"                 "${G_PICKER_APP:-}"                         "$(octogee_oauth_provider_requirement google)"
completeness_row "microsoft-oauth / client_id"                  "${MICROSOFT_CLIENT_ID:-}"                  "$(octogee_oauth_provider_requirement microsoft)"
completeness_row "microsoft-oauth / client_secret"              "${MICROSOFT_CLIENT_SECRET:-}"              "$(octogee_oauth_provider_requirement microsoft)"
completeness_row "connect-state-secret"                         "${CONNECT_STATE_SECRET:-}"                 launch
run_secret_steps ${SECRET_COMPLETENESS_STEPS[@]+"${SECRET_COMPLETENESS_STEPS[@]}"}
case "$TARGET_ID" in
  test-west|prod-west)
    completeness_row "identity-platform-login / google client_id"     "${FIREBASE_AUTH_GOOGLE_CLIENT_ID:-}"     launch
    completeness_row "identity-platform-login / google client_secret" "${FIREBASE_AUTH_GOOGLE_CLIENT_SECRET:-}" launch
    completeness_row "identity-platform-login / github client_id"     "${FIREBASE_AUTH_GITHUB_CLIENT_ID:-}"     launch
    completeness_row "identity-platform-login / github client_secret" "${FIREBASE_AUTH_GITHUB_CLIENT_SECRET:-}" launch
    ;;
esac

echo ""
if [[ "$OCTOGEE_SECRET_COMPLETENESS_FAILURES" -gt 0 ]]; then
  echo -e "${RED}${BOLD}  Secret setup incomplete — ${OCTOGEE_SECRET_COMPLETENESS_FAILURES} required launch input(s) missing${NC}"
  echo "  Do not deploy $TARGET_ID until every required launch input is configured."
  exit 1
fi

echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
if [[ "$SECRET_SETUP_PHASE" == "bootstrap" ]]; then
  echo -e "${BOLD}  Bootstrap secrets created — ${ENV_LABEL}${NC}"
else
  echo -e "${BOLD}  All launch secrets materialized — ${ENV_LABEL}${NC}"
fi
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
VALUES_FILE="values.${ENV}.yaml"
[[ "$ENV" == "custom" ]] && VALUES_FILE="values.$CUSTOM_NS.yaml (rendered from template)"
echo "  Canonical sequence (run teardown-env.sh --env=$ENV$TARGET_ARG to see all 9 steps)."
echo ""
if [[ "$SECRET_SETUP_PHASE" == "launch" ]]; then
  echo "  Next: restart workloads, then run verify-env.sh for $TARGET_ID."
  exit 0
fi
echo "  Next (Phase 1 → Helm):"
echo "    PLATFORM_SOURCE_SHA=<full 40-character source SHA from the tested Central release manifest>"
echo "    RELEASE_VALUES_FILE=\$(mktemp)"
echo "    ./scripts/node_modules/.bin/tsx scripts/ops/render-release-helm-values.ts \"\$PLATFORM_SOURCE_SHA\" > \"\$RELEASE_VALUES_FILE\" || exit 1"
    echo "    GITEA_DB_PASS=\$(gcloud secrets versions access latest --secret=$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET --project=$SM_PROJECT)"
echo "    UMBRELLA_CHART_DIR=\$(mktemp -d)"
echo "    UMBRELLA_CHART=\$(./scripts/package-umbrella-chart.sh --output-dir \"\$UMBRELLA_CHART_DIR\")"
echo "    helm upgrade --install octogee \"\$UMBRELLA_CHART\" \\"
echo "      --server-side=true --force-conflicts \\"
echo "      -f helm/octogee/$VALUES_FILE \\"
echo "      -f <(node core/dist/render-deployment-target-helm-values.js --target=$TARGET_ID) \\"
echo "      -f \"\$RELEASE_VALUES_FILE\" \\"
echo "      -n $K8S_NAMESPACE \\"
echo "      --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
echo "      --kube-context $K8S_CONTEXT \\"
echo "      --wait --timeout=10m"
echo ""
echo "  Phase 2 callers should run after setup-mattermost + setup-gitea, then"
echo "  kubectl rollout restart deploy -n $K8S_NAMESPACE."
echo ""
