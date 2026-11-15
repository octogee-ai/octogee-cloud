#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Mattermost Setup — Bootstrap credentials + K8s secrets
# ═══════════════════════════════════════════════════════════════════════════
#
# NOTE: Mattermost is deployed by Helm (umbrella chart), NOT by this script.
# This script's job is:
#   1. Collect/generate credentials (admin pass, DB pass)
#   2. Sync DB password to Cloud SQL
#   3. Create K8s secrets consumed by Helm
#   4. Bootstrap the admin user, admin PAT, and team on a fresh MM instance
#   5. Save everything to .env.test / .env
#
# Run this BEFORE `helm upgrade --install` on a fresh environment.
# On an existing environment: re-run to refresh K8s secrets or re-bootstrap.
#
# Usage:
#   ./scripts/setup-mattermost.sh --env=test [--deployment-target=test-west] [--yes]
#   ./scripts/setup-mattermost.sh --env=prod
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"
# shellcheck source=scripts/lib/mattermost-admin-pat.sh
source "$SCRIPT_DIR/lib/mattermost-admin-pat.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ENV=""
YES=false
CUSTOM_NS=""
DEPLOYMENT_TARGET=""
ROTATE_PLATFORM_CREDENTIALS=false
CONFIRM_PLATFORM_MIGRATION=""
SKIP_CLOUD_SQL_PASSWORD_SYNC=false

for arg in "$@"; do
  case $arg in
    --env=*)       ENV="${arg#*=}" ;;
    --deployment-target=*) DEPLOYMENT_TARGET="${arg#*=}" ;;
    --namespace=*) CUSTOM_NS="${arg#*=}" ;;
    --rotate-platform-credentials) ROTATE_PLATFORM_CREDENTIALS=true ;;
    --confirm-platform-migration=*) CONFIRM_PLATFORM_MIGRATION="${arg#*=}" ;;
    --skip-cloud-sql-password-sync) SKIP_CLOUD_SQL_PASSWORD_SYNC=true ;;
    --yes|-y)      YES=true ;;
    --help|-h)
      echo "Usage: $0 --env=prod|test|custom [--deployment-target=TARGET] [--namespace=NAME] [--rotate-platform-credentials --confirm-platform-migration=TARGET] [--skip-cloud-sql-password-sync] [--yes]"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test|custom [--deployment-target=TARGET] [--namespace=NAME] [--yes]"; exit 1; }

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
GCP_PROJECT="$TARGET_FIREBASE_PROJECT"
CLUSTER_PROJECT="$TARGET_CLUSTER_PROJECT"
CLUSTER_NAME="$TARGET_CLUSTER_NAME"
K8S_CONTEXT="$TARGET_KUBE_CONTEXT"
TARGET_ARG=" --deployment-target=$TARGET_ID"

case "$ENV" in
  prod)
    ENV_FILE="$REPO_DIR/.env"
    ENV_LABEL="🔴 PRODUCTION"
    MM_DB_NAME="mattermost_prod"
    MM_DB_USER="mattermost"
    ;;
  test)
    ENV_FILE="$REPO_DIR/.env.test"
    ENV_LABEL="🟡 TEST"
    MM_DB_NAME="mattermost_test"
    MM_DB_USER="mattermost"
    ;;
  custom)
    [[ -z "$CUSTOM_NS" ]] && { echo "--env=custom requires --namespace=NAME"; exit 1; }
    [[ "$CUSTOM_NS" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "Invalid namespace '$CUSTOM_NS'"; exit 1; }
    K8S_NAMESPACE="$CUSTOM_NS"
    ENV_FILE="$REPO_DIR/.env.$CUSTOM_NS"
    ENV_LABEL="🟣 CUSTOM ($CUSTOM_NS)"
    MM_DB_NAME="mattermost_${CUSTOM_NS//-/_}"
    MM_DB_USER="mattermost"
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

if $ROTATE_PLATFORM_CREDENTIALS; then
  case "$TARGET_ID" in
    test-west|prod-west) ;;
    *) echo "Platform credential rotation is restricted to WEST platform migration targets" >&2; exit 1 ;;
  esac
  [[ "$CONFIRM_PLATFORM_MIGRATION" == "$TARGET_ID" ]] || {
    echo "Platform credential rotation requires --confirm-platform-migration=$TARGET_ID" >&2
    exit 1
  }
fi

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
status() {
  local label="$1" value="$2"
  if [[ -n "$value" ]]; then
    echo -e "  ${GREEN}✓${NC} $label"
  else
    echo -e "  ${RED}✗${NC} $label"
  fi
}

confirm() {
  $YES && return 0
  echo -ne "  ${YELLOW}$1 [Y/n]:${NC} "
  read -r yn
  [[ ! "$yn" =~ ^[Nn]$ ]]
}

save_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    local tmpfile; tmpfile=$(mktemp)
    grep -v "^${key}=" "$ENV_FILE" > "$tmpfile"
    echo "${key}=${val}" >> "$tmpfile"
    mv "$tmpfile" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

# Read a key from a K8s secret (empty string if secret or key is missing).
ksecret_key() {
  kubectl get secret "$1" -n "$K8S_NAMESPACE" \
    -o jsonpath="{.data.$2}" 2>/dev/null | base64 -d 2>/dev/null || echo ""
}

mm_field() {
  local response="$1" field="$2" json_file value
  json_file=$(mktemp)
  chmod 600 "$json_file"
  printf '%s' "$response" > "$json_file"
  if ! value=$(python3 -c '
import sys, json
field = sys.argv[1]
try:
    with open(sys.argv[2], encoding="utf-8") as source:
        r = json.load(source)
except Exception:
    sys.exit(1)
if isinstance(r, dict) and isinstance(r.get("status_code"), int) and r["status_code"] >= 400:
    sys.exit(1)
print(r.get(field, "") if isinstance(r, dict) else "")
' "$field" "$json_file" 2>/dev/null); then
    rm -f "$json_file"
    return 1
  fi
  rm -f "$json_file"
  printf '%s\n' "$value"
}

mm_gateway_pat_ids() {
  local response="$1" json_file value
  json_file=$(mktemp)
  chmod 600 "$json_file"
  printf '%s' "$response" > "$json_file"
  if ! value=$(python3 -c '
import sys, json
with open(sys.argv[1], encoding="utf-8") as source:
    tokens = json.load(source)
for token in tokens:
    if "gateway-edge" in token.get("description", "") or token.get("description") == sys.argv[2]:
        print(token["id"])
' "$json_file" "$MM_ADMIN_PLATFORM_PAT_DESCRIPTION" 2>/dev/null); then
    rm -f "$json_file"
    return 1
  fi
  rm -f "$json_file"
  printf '%s\n' "$value"
}

set_admin_pat_from_response() {
  local response="$1"
  MM_ADMIN_PAT=$(mm_field "$response" token || true)
  MM_ADMIN_PAT_ID=$(mm_field "$response" id || true)
  if [[ -z "$MM_ADMIN_PAT" || -z "$MM_ADMIN_PAT_ID" ]]; then
    MM_ADMIN_PAT_FINGERPRINT=""
    warn "Mattermost did not return a complete platform admin PAT record"
    return 1
  fi
  MM_ADMIN_PAT_FINGERPRINT=$(mm_admin_pat_fingerprint "$MM_ADMIN_PAT")
  save_env "MM_ADMIN_PAT" "$MM_ADMIN_PAT"
  save_env "MM_ADMIN_PAT_ID" "$MM_ADMIN_PAT_ID"
  save_env "MM_ADMIN_PAT_FINGERPRINT" "$MM_ADMIN_PAT_FINGERPRINT"
  ok "Platform admin PAT created"
}

ensure_mm_team() {
  local response team_id membership membership_user_id
  response=$(curl -s "http://localhost:8065/api/v4/teams/name/octogee" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null || true)
  team_id=$(mm_field "$response" id || true)
  if [[ -z "$team_id" ]]; then
    response=$(curl -s -X POST "http://localhost:8065/api/v4/teams" \
      -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d '{"name":"octogee","display_name":"Octogee","type":"I"}' 2>/dev/null)
    team_id=$(mm_field "$response" id || true)
    [[ -n "$team_id" ]] || fail "Failed to create team: $response"
    ok "Team created: $team_id"
  else
    ok "Team discovered: $team_id"
  fi

  MM_TEAM_ID="$team_id"
  save_env "MM_TEAM_ID" "$MM_TEAM_ID"
  curl -s -X POST "http://localhost:8065/api/v4/teams/$MM_TEAM_ID/members" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"team_id\":\"$MM_TEAM_ID\",\"user_id\":\"$MM_ADMIN_USER_ID\"}" >/dev/null 2>&1 || true
  membership=$(curl -s "http://localhost:8065/api/v4/teams/$MM_TEAM_ID/members/$MM_ADMIN_USER_ID" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null || true)
  membership_user_id=$(mm_field "$membership" user_id || true)
  [[ "$membership_user_id" == "$MM_ADMIN_USER_ID" ]] || fail "Admin team membership verification failed"
}

load_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  set +u
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    export "$key=$val"
  done < "$ENV_FILE"
  set -u
}

load_env

if [[ "$ENV" == "prod" ]] && $YES; then
  fail "--yes cannot be used with prod."
fi

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Mattermost Setup — ${ENV_LABEL}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ── 0. kubectl context ────────────────────────────────────────────────────
info "Setting kubectl context: $K8S_CONTEXT"
gcloud container clusters get-credentials "$CLUSTER_NAME" --region "$TARGET_REGION" --project "$CLUSTER_PROJECT"
kubectl config use-context "$K8S_CONTEXT"
CURRENT_CTX=$(kubectl config current-context)
[[ "$CURRENT_CTX" == "$K8S_CONTEXT" ]] || fail "kubectl context is '$CURRENT_CTX', expected '$K8S_CONTEXT'."
kubectl --context "$K8S_CONTEXT" cluster-info >/dev/null
ok "kubectl context: $CURRENT_CTX"
info "This script owns Mattermost bootstrap/app state: admin user, admin PAT, team, and the mattermost-gateway secret inputs."

# Ensure namespace exists
if [[ "$ENV" == "custom" ]]; then
  kubectl get namespace "$K8S_NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$K8S_NAMESPACE"
else
  "$SCRIPT_DIR/ensure-namespace-security.sh" --deployment-target="$TARGET_ID" --mode=enforce
fi

# ── 1. Credentials ────────────────────────────────────────────────────────
set +u

MM_URL_DEFAULT="http://mattermost.${K8S_NAMESPACE}.svc.cluster.local:8065"
MM_URL="${MM_URL:-$MM_URL_DEFAULT}"
save_env "MM_URL" "$MM_URL"
info "MM URL: $MM_URL"

MM_ADMIN_USER="${MM_ADMIN_USER:-$(ksecret_key mattermost-gateway admin_user)}"
[[ -z "$MM_ADMIN_USER" ]] && MM_ADMIN_USER="octogee-admin"
save_env "MM_ADMIN_USER" "$MM_ADMIN_USER"
info "Admin user: $MM_ADMIN_USER"

if $ROTATE_PLATFORM_CREDENTIALS; then
  MM_ADMIN_PASS="$(openssl rand -base64 48 | tr -d '\n')"
  info "Generated new WEST platform admin password"
else
  MM_ADMIN_PASS="${MM_ADMIN_PASS:-$(ksecret_key mattermost-gateway admin_pass)}"
fi
if [[ -z "$MM_ADMIN_PASS" ]]; then
  MM_ADMIN_PASS="Octogee$(openssl rand -hex 4)!"
  info "Generated admin password"
fi
save_env "MM_ADMIN_PASS" "$MM_ADMIN_PASS"

# DB password always comes from Secret Manager (octogee project owns Cloud SQL)
SM_PASS=$(gcloud secrets versions access latest \
  --secret="$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET" \
  --project="$TARGET_CLOUD_SQL_PROJECT" 2>/dev/null || echo "")
if [[ -n "$SM_PASS" ]]; then
  MM_DB_PASSWORD="$SM_PASS"
  info "MM_DB_PASSWORD from Secret Manager ($TARGET_CLOUD_SQL_PROJECT project)"
else
  fail "Secret Manager password is required before Mattermost bootstrap: $TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET"
fi
save_env "MM_DB_PASSWORD" "$MM_DB_PASSWORD"
set -u

# ── 2. Sync DB password to Cloud SQL ─────────────────────────────────────
if $SKIP_CLOUD_SQL_PASSWORD_SYNC; then
  info "Using the existing Cloud SQL password from Secret Manager"
else
  info "Syncing DB password to Cloud SQL user '$MM_DB_USER'..."
  if gcloud sql users set-password "$MM_DB_USER" \
      --instance="$TARGET_CLOUD_SQL_INSTANCE" \
      --project="$TARGET_CLOUD_SQL_PROJECT" \
      --password="$MM_DB_PASSWORD" 2>&1; then
    ok "Cloud SQL user '$MM_DB_USER' password synced"
  else
    fail "Could not sync Cloud SQL password — refusing to bootstrap against an unknown database credential"
  fi
fi

# ── 3. Create K8s secrets ─────────────────────────────────────────────────
info "Creating K8s secrets..."
kubectl create secret generic mattermost-cloud-sql -n "$K8S_NAMESPACE" \
  --from-literal=password="$MM_DB_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
ok "mattermost-cloud-sql secret materialized from Secret Manager"

# ── 4. Wait for Mattermost (Helm must already be deployed or running) ─────
info "Checking if Mattermost is deployed..."
if ! kubectl get deployment mattermost -n "$K8S_NAMESPACE" >/dev/null 2>&1; then
  info "Mattermost not deployed yet — Helm owns infra state, this script owns bootstrap state."
  echo ""
  echo "  Next step: deploy Helm first, then re-run this script"
  echo ""
  echo "  PLATFORM_SOURCE_SHA='<full 40-character source SHA from the tested Central release manifest>'"
  echo "  RELEASE_VALUES_FILE=\$(mktemp)"
  echo "  ./scripts/node_modules/.bin/tsx scripts/ops/render-release-helm-values.ts \"\$PLATFORM_SOURCE_SHA\" > \"\$RELEASE_VALUES_FILE\" || exit 1"
  echo "  UMBRELLA_CHART_DIR=\$(mktemp -d)"
  echo "  UMBRELLA_CHART=\$(./scripts/package-umbrella-chart.sh --output-dir \"\$UMBRELLA_CHART_DIR\")"
  echo "  helm upgrade --install octogee \"\$UMBRELLA_CHART\" \\"
  echo "    --server-side=true --force-conflicts \\"
  echo "    -f charts/octogee/values.${ENV}.yaml \\"
  echo "    -f <(node core/dist/render-deployment-target-helm-values.js --target=$TARGET_ID) \\"
  echo "    -f \"\$RELEASE_VALUES_FILE\" \\"
  echo "    -n $K8S_NAMESPACE --create-namespace \\"
  echo "    --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
  echo "    --kube-context $K8S_CONTEXT"
  echo ""
  ok "K8s secrets ready. Deploy Helm then re-run to complete Mattermost bootstrap."
  exit 0
fi

info "Restarting Mattermost so it reads the authoritative Cloud SQL password..."
kubectl rollout restart deployment/mattermost -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" >/dev/null \
  || fail "Could not restart Mattermost after materializing its Cloud SQL password"
info "Waiting for the restarted Mattermost rollout (up to 120s)..."
kubectl rollout status deployment/mattermost \
  -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" --timeout=120s \
  || fail "Mattermost rollout did not complete after 120s"
ok "Mattermost rollout complete"

if $ROTATE_PLATFORM_CREDENTIALS; then
  if MM_USER_GET=$(kubectl exec -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" deploy/mattermost -c mattermost -- \
    /mattermost/bin/mmctl --local user search "$MM_ADMIN_USER" 2>&1); then
    info "Rotating restored Mattermost admin password through the local control socket..."
    kubectl exec -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" deploy/mattermost -c mattermost -- \
      /mattermost/bin/mmctl --local user change-password "$MM_ADMIN_USER" \
        --password "$MM_ADMIN_PASS" >/dev/null \
      || fail "Could not rotate the restored Mattermost admin password"
    save_env "MM_ADMIN_PASS" "$MM_ADMIN_PASS"
    ok "Restored Mattermost admin password rotated"
  elif [[ "$MM_USER_GET" == *"not found"* ]]; then
    info "Fresh Mattermost admin is not present; bootstrap will create it with the rotated credential"
  else
    fail "Could not inspect the restored Mattermost admin: $MM_USER_GET"
  fi
fi

# ── 4b. Port-forward to MM (distroless image — no in-pod curl) ────────────
# MM 11.x ships a distroless image without curl/sh, so we can't `kubectl exec
# -- curl`. Forward MM's service port to localhost:8065 and have the script
# hit the API from the operator's machine. Trap ensures cleanup on any exit.
PF_PID=""
mm_cleanup() {
  if [[ -n "$PF_PID" ]] && kill -0 "$PF_PID" 2>/dev/null; then
    kill "$PF_PID" 2>/dev/null || true
    wait "$PF_PID" 2>/dev/null || true
  fi
}
trap mm_cleanup EXIT

# Tear down any stale local port-forward that would race with ours.
# (Operator may have left one running from a prior debug session.)
if lsof -ti :8065 >/dev/null 2>&1; then
  warn "Killing stale process holding localhost:8065"
  lsof -ti :8065 | xargs kill -9 2>/dev/null || true
  sleep 1
fi

info "Starting kubectl port-forward → localhost:8065..."
kubectl port-forward -n "$K8S_NAMESPACE" svc/mattermost 8065:8065 >/dev/null 2>&1 &
PF_PID=$!

# Wait for port-forward to be ready (separate from MM HTTP readiness).
PF_READY=false
for _ in $(seq 1 10); do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:8065 2>/dev/null | grep -qE "^[0-9]"; then
    PF_READY=true
    break
  fi
  sleep 1
done
$PF_READY || fail "kubectl port-forward did not establish on localhost:8065"

# ── 5. Wait for HTTP ──────────────────────────────────────────────────────
info "Waiting for Mattermost HTTP..."
MM_READY=false
for attempt in $(seq 1 24); do
  PING=$(curl -s -o /dev/null -w "%{http_code}" \
    http://localhost:8065/api/v4/system/ping 2>/dev/null || echo "000")
  [[ "$PING" == "200" ]] && { MM_READY=true; break; }
  sleep 5
  info "  Waiting (attempt $attempt/24, status=$PING)..."
done
$MM_READY || fail "Mattermost HTTP not responding after 120s"
ok "Mattermost HTTP ready"

# ── 6. Bootstrap or refresh credentials ──────────────────────────────────
ADMIN_CHECK=$(\
  curl -s -o /dev/null -w "%{http_code}" \
  -X POST "http://localhost:8065/api/v4/users/login" \
  -H "Content-Type: application/json" \
  -d "{\"login_id\":\"$MM_ADMIN_USER\",\"password\":\"$MM_ADMIN_PASS\"}" 2>/dev/null || echo "000")

if [[ "$ADMIN_CHECK" == "200" ]]; then
  info "Admin already exists — refreshing token only"
  LOGIN_RAW=$(\
    curl -s -i -X POST "http://localhost:8065/api/v4/users/login" \
    -H "Content-Type: application/json" \
    -d "{\"login_id\":\"$MM_ADMIN_USER\",\"password\":\"$MM_ADMIN_PASS\"}" 2>/dev/null)
  MM_ADMIN_TOKEN=$(echo "$LOGIN_RAW" | grep -i "^token:" | awk '{print $2}' | tr -d '\r')
  [[ -n "$MM_ADMIN_TOKEN" ]] && save_env "MM_ADMIN_TOKEN" "$MM_ADMIN_TOKEN" && ok "Admin session token refreshed"

  # Get real admin user ID from /me (stored IDs can drift after DB rebuilds)
  ME_RESP=$(curl -s "http://localhost:8065/api/v4/users/me" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null)
  MM_ADMIN_USER_ID=$(mm_field "$ME_RESP" id) && [[ -n "$MM_ADMIN_USER_ID" ]] \
    && save_env "MM_ADMIN_USER_ID" "$MM_ADMIN_USER_ID" \
    && ok "Admin user ID: $MM_ADMIN_USER_ID"

  # ── Admin PAT: test cached value first, only rotate if it's broken ──────
  CACHED_ADMIN_PAT=$(ksecret_key mattermost-gateway admin_token)
  CACHED_ADMIN_PAT_ID=$(ksecret_key mattermost-gateway admin_token_id)
  CACHED_ADMIN_PAT_FINGERPRINT=$(ksecret_key mattermost-gateway admin_token_fingerprint)
  $ROTATE_PLATFORM_CREDENTIALS && CACHED_ADMIN_PAT=""
  if mm_admin_pat_is_valid "$CACHED_ADMIN_PAT" "$MM_ADMIN_USER" "$MM_ADMIN_USER_ID" "$CACHED_ADMIN_PAT_ID" "$CACHED_ADMIN_PAT_FINGERPRINT" "http://localhost:8065"; then
    ok "Cached admin PAT still valid — skipping rotation"
    MM_ADMIN_PAT="$CACHED_ADMIN_PAT"
    MM_ADMIN_PAT_ID="$CACHED_ADMIN_PAT_ID"
    MM_ADMIN_PAT_FINGERPRINT="$CACHED_ADMIN_PAT_FINGERPRINT"
    save_env "MM_ADMIN_PAT" "$MM_ADMIN_PAT"
    save_env "MM_ADMIN_PAT_ID" "$MM_ADMIN_PAT_ID"
    save_env "MM_ADMIN_PAT_FINGERPRINT" "$MM_ADMIN_PAT_FINGERPRINT"
  else
    info "Cached platform admin PAT missing, invalid, or unproven — rotating"
    EXISTING_PATS=$(\
      curl -s "http://localhost:8065/api/v4/users/$MM_ADMIN_USER_ID/tokens" \
      -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null)
    OLD_PAT_IDS=$(mm_gateway_pat_ids "$EXISTING_PATS" || true)
    REVOKED=0
    for pat_id in $OLD_PAT_IDS; do
      \
        curl -s -X POST "http://localhost:8065/api/v4/users/tokens/revoke" \
        -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"token_id\":\"$pat_id\"}" >/dev/null 2>&1
      REVOKED=$((REVOKED + 1))
    done
    [[ $REVOKED -gt 0 ]] && ok "Revoked $REVOKED stale admin PAT(s)"

    PAT_RESP=$(\
      curl -s -X POST "http://localhost:8065/api/v4/users/$MM_ADMIN_USER_ID/tokens" \
      -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"description\":\"$MM_ADMIN_PLATFORM_PAT_DESCRIPTION\"}" 2>/dev/null)
    if ! set_admin_pat_from_response "$PAT_RESP"; then
      warn "octogee-api Mattermost broker routes will fail without this!"
    fi
  fi

  info "Discovering team state..."
  ensure_mm_team

else
  if MM_USER_GET=$(kubectl exec -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" deploy/mattermost -c mattermost -- \
    /mattermost/bin/mmctl --local user search "$MM_ADMIN_USER" 2>&1); then
    fail "Admin exists but API login failed; refusing to treat an active database as fresh"
  elif [[ "$MM_USER_GET" == *"not found"* ]]; then
    info "Fresh Mattermost admin is not present; creating it through mmctl --local..."
  else
    fail "Could not inspect Mattermost admin state: $MM_USER_GET"
  fi

  MMCTL_ERR=$(kubectl exec -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" deploy/mattermost -c mattermost -- \
    /mattermost/bin/mmctl --local user create \
      --username "$MM_ADMIN_USER" \
      --password "$MM_ADMIN_PASS" \
      --email "admin@octogee.com" \
      --system-admin \
      --email-verified 2>&1) \
    || fail "mmctl --local user create failed for $MM_ADMIN_USER: $MMCTL_ERR"
  ok "Admin user created via mmctl --local"

  # Login
  LOGIN_RAW=$(\
    curl -s -i -X POST "http://localhost:8065/api/v4/users/login" \
    -H "Content-Type: application/json" \
    -d "{\"login_id\":\"$MM_ADMIN_USER\",\"password\":\"$MM_ADMIN_PASS\"}" 2>/dev/null)
  MM_ADMIN_TOKEN=$(echo "$LOGIN_RAW" | grep -i "^token:" | awk '{print $2}' | tr -d '\r')
  [[ -n "$MM_ADMIN_TOKEN" ]] || fail "Failed to get admin token after mmctl create"
  save_env "MM_ADMIN_TOKEN" "$MM_ADMIN_TOKEN"
  ok "Admin login OK"

  ME_RESP=$(curl -s "http://localhost:8065/api/v4/users/me" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null)
  MM_ADMIN_USER_ID=$(mm_field "$ME_RESP" id) && [[ -n "$MM_ADMIN_USER_ID" ]] \
    || fail "Failed to fetch admin user ID: $ME_RESP"
  save_env "MM_ADMIN_USER_ID" "$MM_ADMIN_USER_ID"
  ok "Admin ID: $MM_ADMIN_USER_ID"

  ensure_mm_team

  # Enable bots + personal access tokens
  \
    curl -s -X PUT "http://localhost:8065/api/v4/config/patch" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"ServiceSettings":{"EnableBotAccountCreation":true,"EnableUserAccessTokens":true}}' >/dev/null 2>&1
  ok "Bot accounts + PATs enabled"

  # Admin personal access token (PAT) for the platform API and controller
  info "Creating platform admin personal access token (PAT)..."
  PAT_RESP=$(\
    curl -s -X POST "http://localhost:8065/api/v4/users/$MM_ADMIN_USER_ID/tokens" \
    -H "Authorization: Bearer $MM_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"description\":\"$MM_ADMIN_PLATFORM_PAT_DESCRIPTION\"}" 2>/dev/null)
  if ! set_admin_pat_from_response "$PAT_RESP"; then
    warn "octogee-api Mattermost broker routes will fail without this!"
  fi

  info "All credentials saved to $ENV_FILE"
fi

# ── 7. Validate all values before writing K8s secret ─────────────────────
set +u
info "Validating secret values before write..."

WRITE_ERRORS=0
for var_name in MM_ADMIN_USER MM_ADMIN_PASS MM_ADMIN_USER_ID MM_ADMIN_PAT MM_ADMIN_PAT_ID MM_ADMIN_PAT_FINGERPRINT MM_TEAM_ID; do
  val="${!var_name:-}"
  if [[ -z "$val" ]]; then
    warn "$var_name is empty — secret will be incomplete!"
    WRITE_ERRORS=$((WRITE_ERRORS + 1))
  fi
done

[[ "$WRITE_ERRORS" -eq 0 ]] || fail "$WRITE_ERRORS Mattermost bootstrap value(s) missing — refusing to write a partial secret"

# ── 8. Atomic K8s secret write (dry-run + apply) ────────────────────────
# Uses dry-run + apply instead of delete + create to avoid a window where
# the secret doesn't exist (which would crash pods on restart).
info "Writing mattermost-gateway K8s secret..."
kubectl create secret generic mattermost-gateway \
  -n "$K8S_NAMESPACE" \
  --from-literal=admin_user="${MM_ADMIN_USER:-}" \
  --from-literal=admin_pass="${MM_ADMIN_PASS:-}" \
  --from-literal=admin_token="${MM_ADMIN_PAT:-}" \
  --from-literal=admin_token_id="${MM_ADMIN_PAT_ID:-}" \
  --from-literal=admin_token_fingerprint="${MM_ADMIN_PAT_FINGERPRINT:-}" \
  --from-literal=admin_user_id="${MM_ADMIN_USER_ID:-}" \
  --from-literal=team_id="${MM_TEAM_ID:-}" \
  --dry-run=client -o yaml | kubectl apply -f -
ok "mattermost-gateway K8s secret written (atomic apply)"

# ── 9. Post-write verification ──────────────────────────────────────────
info "Verifying written secret..."
VERIFY_ERRORS=0
for key in admin_user admin_pass admin_token admin_token_id admin_token_fingerprint admin_user_id team_id; do
  VAL=$(kubectl get secret mattermost-gateway -n "$K8S_NAMESPACE" \
    -o jsonpath="{.data.$key}" 2>/dev/null | base64 -d 2>/dev/null || echo "")
  if [[ -z "$VAL" ]]; then
    echo -e "  ${RED}✗${NC} $key — EMPTY"
    VERIFY_ERRORS=$((VERIFY_ERRORS + 1))
  else
    echo -e "  ${GREEN}✓${NC} $key (${#VAL} chars)"
  fi
done

[[ "$VERIFY_ERRORS" -eq 0 ]] || fail "$VERIFY_ERRORS Mattermost gateway secret key(s) empty after write"
mm_admin_pat_is_valid "$MM_ADMIN_PAT" "$MM_ADMIN_USER" "$MM_ADMIN_USER_ID" "$MM_ADMIN_PAT_ID" "$MM_ADMIN_PAT_FINGERPRINT" "http://localhost:8065" \
  || fail "mattermost-gateway admin_token is not the tracked active platform PAT"
ok "Mattermost gateway secret contains the tracked active platform PAT"
set -u

echo ""
echo -e "${CYAN}Mattermost bootstrap summary${NC}"
status "MM_ADMIN_USER set" "${MM_ADMIN_USER:-}"
status "MM_ADMIN_PASS set" "${MM_ADMIN_PASS:-}"
status "MM_ADMIN_USER_ID set" "${MM_ADMIN_USER_ID:-}"
status "MM_ADMIN_PAT set (required for octogee-api Mattermost broker)" "${MM_ADMIN_PAT:-}"
status "MM_ADMIN_PAT_ID set" "${MM_ADMIN_PAT_ID:-}"
status "MM_ADMIN_PAT_FINGERPRINT set" "${MM_ADMIN_PAT_FINGERPRINT:-}"
status "MM_TEAM_ID set" "${MM_TEAM_ID:-}"

echo ""
if [[ -n "${MM_ADMIN_PAT:-}" && -n "${MM_TEAM_ID:-}" && -n "${MM_ADMIN_USER_ID:-}" ]]; then
  ok "mattermost-gateway inputs are complete"
  echo ""
  echo "  Next (canonical sequence — see teardown-env.sh --env=$ENV$TARGET_ARG for the full 9 steps):"
  echo "    4. ./scripts/setup-gitea.sh --env=$ENV$TARGET_ARG"
  echo "    5. ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG --phase=launch"
  echo "    6. kubectl rollout restart deploy -n $K8S_NAMESPACE   # pods pick up new secret env"
  echo ""
  echo "  octogee-api and glm-controller read mattermost-gateway directly."
  echo "  User account tokens are brokered into gateway-local SecretRefs; gateway"
  echo "  pods do not receive the Mattermost admin PAT."
else
  warn "Mattermost bootstrap is still incomplete"
  echo ""
  echo "  Expected healthy state includes:"
  echo "    - admin PAT for octogee-api Mattermost broker routes"
  echo "    - team id for user account provisioning"
  echo ""
  echo "  Next steps:"
  echo "    1. Review warnings above"
  echo "    2. Re-run ./scripts/setup-mattermost.sh --env=$ENV$TARGET_ARG"
  echo "    3. Do NOT trust admin chat until the missing values are fixed"
fi

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Mattermost setup complete!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Next (canonical step 4): ./scripts/setup-gitea.sh --env=$ENV$TARGET_ARG"
echo ""
