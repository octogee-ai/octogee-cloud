#!/usr/bin/env bash
# =============================================================================
# verify-env.sh — Octogee Environment Health Check
#
# Usage:
#   ./scripts/verify-env.sh --env=test
#   ./scripts/verify-env.sh --env=prod
#   ./scripts/verify-env.sh --env=test --fix   # print fix commands for failures
#
# Checks (in order):
#   1. kubectl context
#   2. Cloud SQL proxy
#   3. Mattermost infra + bootstrap secret completeness
#   4. Gitea infra + token secret presence
#   5. Gateway
#   5b. Ingress / endpoint health
#   6. Firebase Hosting (site)
#   7. Cloud Functions / supporting services
#   8. chat surfaces (gateway-edge sidecar + octogee-api) health
#
# Exit codes:
#   0 — all green
#   1 — one or more checks failed
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"
# shellcheck source=scripts/lib/ready-assigned-gateway-probe.sh
source "$SCRIPT_DIR/lib/ready-assigned-gateway-probe.sh"
# shellcheck source=scripts/lib/gitea-token-convergence.sh
source "$SCRIPT_DIR/lib/gitea-token-convergence.sh"
# shellcheck source=scripts/lib/shared-pool-deployments.sh
source "$SCRIPT_DIR/lib/shared-pool-deployments.sh"
# shellcheck source=scripts/lib/iap-endpoint-health.sh
source "$SCRIPT_DIR/lib/iap-endpoint-health.sh"
# shellcheck source=scripts/lib/gateway-image-bundle.sh
source "$SCRIPT_DIR/lib/gateway-image-bundle.sh"
# shellcheck source=scripts/lib/gateway-capacity-placement.sh
source "$SCRIPT_DIR/lib/gateway-capacity-placement.sh"
# shellcheck source=scripts/lib/env-extensions.sh
source "$SCRIPT_DIR/lib/env-extensions.sh"

# ── Colors ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

pass()  { echo -e "  ${GREEN}✅ $1${NC}"; }
fail()  {
  local msg="$1"
  echo -e "  ${RED}❌ $msg${NC}"
  FAILURES+=("$msg")
  case "$CONTEXT_SECTION" in
    infra) INFRA_FAILS=$((INFRA_FAILS + 1)) ;;
    secrets) SECRET_FAILS=$((SECRET_FAILS + 1)) ;;
    bootstrap) BOOTSTRAP_FAILS=$((BOOTSTRAP_FAILS + 1)) ;;
  esac
}
warn()  { echo -e "  ${YELLOW}⚠️  $1${NC}"; WARNINGS+=("$1"); }
info()  { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
header(){ echo -e "\n${CYAN}── $1 ──────────────────────────────────────────────${NC}"; }
status(){
  local okmsg="$1"; local badmsg="$2"; local value="$3"
  if [[ -n "$value" ]]; then
    pass "$okmsg"
  else
    fail "$badmsg"
  fi
}
set_section(){ CONTEXT_SECTION="$1"; }

FAILURES=()
WARNINGS=()
FIX=false
ENV=""
CUSTOM_NS=""
DEPLOYMENT_TARGET=""
INFRA_FAILS=0
SECRET_FAILS=0
BOOTSTRAP_FAILS=0
CONTEXT_SECTION=""

for arg in "$@"; do
  case $arg in
    --env=*)       ENV="${arg#*=}" ;;
    --deployment-target=*) DEPLOYMENT_TARGET="${arg#*=}" ;;
    --namespace=*) CUSTOM_NS="${arg#*=}" ;;
    --fix)         FIX=true ;;
    --help|-h)
      echo "Usage: $0 --env=prod|test|custom [--deployment-target=TARGET] [--namespace=NAME] [--fix]"
      exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

if [[ -z "$ENV" ]]; then
  echo "Usage: $0 --env=prod|test|custom [--deployment-target=TARGET] [--namespace=NAME] [--fix]"
  exit 1
fi

TARGET_ENV="$ENV"
[[ "$TARGET_ENV" == "custom" ]] && TARGET_ENV="test"
if [[ -n "$DEPLOYMENT_TARGET" ]]; then
  [[ "$ENV" == "custom" ]] && { echo "--deployment-target cannot be used with --env=custom"; exit 1; }
  octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"
  [[ "$TARGET_ENVIRONMENT" == "$TARGET_ENV" ]] || {
    echo "Deployment target '$DEPLOYMENT_TARGET' does not belong to environment '$ENV'"
    exit 1
  }
else
  octogee_load_deployment_target "--environment=$TARGET_ENV"
fi
K8S_CONTEXT="$TARGET_KUBE_CONTEXT"
CLUSTER_NAME="$TARGET_CLUSTER_NAME"
CLUSTER_PROJECT="$TARGET_CLUSTER_PROJECT"
NAMESPACE="$TARGET_NAMESPACE"
GCP_PROJECT="$TARGET_FIREBASE_PROJECT"
FIREBASE_PROJECT="$TARGET_FIREBASE_PROJECT"
SITE_URL="$TARGET_SITE_ORIGIN"
AR_IMAGE_BASE="$TARGET_AR_REPOSITORY/octogee-gateway"
CF_SAMPLE="onSignup"
TARGET_ARG=" --deployment-target=$TARGET_ID"

# ── Per-env config ────────────────────────────────────────────────────────────
case "$ENV" in
  prod)
    ENV_LABEL="🔴 PRODUCTION"
    ENV_COLOR="$RED"
    ;;
  test)
    ENV_LABEL="🟡 TEST"
    ENV_COLOR="$YELLOW"
    ;;
  custom)
    [[ -z "$CUSTOM_NS" ]] && { echo "--env=custom requires --namespace=NAME"; exit 1; }
    [[ "$CUSTOM_NS" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "Invalid namespace '$CUSTOM_NS'"; exit 1; }
    NAMESPACE="$CUSTOM_NS"
    ENV_LABEL="🟣 CUSTOM ($CUSTOM_NS)"
    ENV_COLOR="$BLUE"
    TARGET_ARG=""
    ;;
  *)
    echo "Unknown environment: $ENV (use prod, test, or custom)"
    exit 1 ;;
esac

# ── Suffixes for fix-script hints ───────────────────────────────────────────
# Custom namespaces need --namespace= and a different values file path.
if [[ "$ENV" == "custom" ]]; then
  FIX_SUFFIX="--env=custom --namespace=$CUSTOM_NS"
  HELM_VALUES_FILE="charts/octogee/values.$CUSTOM_NS.yaml"
else
  FIX_SUFFIX="--env=$ENV$( [[ "$ENV" == "test" ]] && echo " --yes" || true )"
  HELM_VALUES_FILE="charts/octogee/values.$ENV.yaml"
fi

gcloud container clusters get-credentials "$CLUSTER_NAME" \
  --region "$TARGET_REGION" --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT" >/dev/null 2>&1 || true

# The shared pool is unnamed: automation adds `shared-N` slots through the Admin API, so the
# caller supplies the pool floor as SHARED_POOL_MIN_REPLICAS. Every Ready slot is an
# equivalent probe target; the first one drives the single-gateway checks.
GW_DEPLOYMENTS=$(kubectl get deploy -n "$NAMESPACE" --context "$K8S_CONTEXT" \
  -l "app.kubernetes.io/name=octogee-gateway" -o json 2>/dev/null || echo '{"items":[]}')
SHARED_GW_LIST=$(octogee_list_shared_gateway_deployments <<< "$GW_DEPLOYMENTS" 2>/dev/null || echo "")
SHARED_POOL_MIN_REPLICAS="${SHARED_POOL_MIN_REPLICAS:-}"
GW_DEPLOYMENT=""
GW_INSTANCE_ID=""
SHARED_GW_READY_COUNT=0
SHARED_GW_TOTAL=0
while IFS=$'\t' read -r SHARED_GW_NAME SHARED_GW_INSTANCE SHARED_GW_READY _; do
  [[ -z "$SHARED_GW_NAME" ]] && continue
  SHARED_GW_TOTAL=$((SHARED_GW_TOTAL + 1))
  if [[ "${SHARED_GW_READY:-0}" -gt 0 ]]; then
    SHARED_GW_READY_COUNT=$((SHARED_GW_READY_COUNT + 1))
    if [[ -z "$GW_DEPLOYMENT" ]]; then
      GW_DEPLOYMENT="$SHARED_GW_NAME"
      GW_INSTANCE_ID="$SHARED_GW_INSTANCE"
    fi
  fi
done <<< "$SHARED_GW_LIST"

# ── Header ────────────────────────────────────────────────────────────────────
print_platform_helm_repair() {
  echo "  Select PLATFORM_SOURCE_SHA from the tested Central release manifest."
  echo -e "  ${YELLOW}FIX:${NC} RELEASE_VALUES_FILE=\$(mktemp); ./scripts/node_modules/.bin/tsx scripts/ops/render-release-helm-values.ts \"\$PLATFORM_SOURCE_SHA\" > \"\$RELEASE_VALUES_FILE\" && UMBRELLA_CHART_DIR=\$(mktemp -d) && UMBRELLA_CHART=\$(./scripts/package-umbrella-chart.sh --output-dir \"\$UMBRELLA_CHART_DIR\") && helm upgrade --install octogee \"\$UMBRELLA_CHART\" --server-side=true --force-conflicts -f ${HELM_VALUES_FILE} -f <(node core/dist/render-deployment-target-helm-values.js --target=$TARGET_ID) -f \"\$RELEASE_VALUES_FILE\" -n ${NAMESPACE} --kube-context ${K8S_CONTEXT}"
}

echo ""
echo -e "${ENV_COLOR}════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Octogee Environment Verify — ${ENV_LABEL}${NC}"
echo -e "${ENV_COLOR}════════════════════════════════════════════════════════════${NC}"
echo -e "  Cluster:   ${BOLD}${CLUSTER_NAME}${NC} (${CLUSTER_PROJECT})"
echo -e "  Namespace: ${BOLD}${NAMESPACE}${NC}"
echo -e "  Firebase:  ${BOLD}${FIREBASE_PROJECT}${NC}"
echo -e "  Site:      ${BOLD}${SITE_URL}${NC}"
echo -e "  Time:      $(date '+%Y-%m-%d %H:%M:%S %Z')"
load_env_extensions "$SCRIPT_DIR"

# ── 1. kubectl context ────────────────────────────────────────────────────────
set_section infra
header "1. kubectl Context"
CURRENT_CTX=$(kubectl config current-context 2>/dev/null || echo "NONE")
if [[ "$CURRENT_CTX" == "$K8S_CONTEXT" ]]; then
  pass "Context: $CURRENT_CTX"
else
  fail "Context mismatch: got '$CURRENT_CTX', expected '$K8S_CONTEXT'"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} kubectl config use-context $K8S_CONTEXT"
  fi
fi

# ── 2. Cloud SQL Proxy ────────────────────────────────────────────────────────
set_section infra
header "2. Cloud SQL Proxy"
PROXY_READY=$(kubectl get deployment cloud-sql-proxy -n "$NAMESPACE" \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
PROXY_IMAGE=$(kubectl get deployment cloud-sql-proxy -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")

if [[ "${PROXY_READY:-0}" -ge 1 ]]; then
  pass "Running (image: $PROXY_IMAGE)"
else
  fail "cloud-sql-proxy not ready (readyReplicas=${PROXY_READY:-0})"
  if $FIX; then
    print_platform_helm_repair
  fi
fi

# ── 3. Mattermost ─────────────────────────────────────────────────────────────
set_section infra
header "3. Mattermost"
MM_READY=$(kubectl get deployment mattermost -n "$NAMESPACE" \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
MM_IMAGE=$(kubectl get deployment mattermost -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")
# Datasource lives in the MM_SQLSETTINGS_DATASOURCE env var (post v3 helm
# fix — we dropped the shell wrapper since MM 11.x is distroless). Look it
# up by env name instead of args[0].
MM_DATASOURCE=$(kubectl get deployment mattermost -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MM_SQLSETTINGS_DATASOURCE")].value}' 2>/dev/null \
  | grep -o 'cloud-sql-proxy:[0-9]*/[a-z_]*' | head -1 || echo "unknown")

if [[ "${MM_READY:-0}" -ge 1 ]]; then
  pass "Running (image: $MM_IMAGE)"
  info "DB target: $MM_DATASOURCE"
  # Check it's pointing at cloud-sql-proxy, not old in-cluster postgres
  if echo "$MM_DATASOURCE" | grep -q "cloud-sql-proxy"; then
    pass "DB: Cloud SQL ✓"
  else
    warn "DB may not be Cloud SQL — check datasource"
  fi

  set_section secrets
  MM_ADMIN_USER=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.admin_user}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_ADMIN_PASS=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.admin_pass}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_ADMIN_TOKEN=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.admin_token}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_ADMIN_TOKEN_ID=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.admin_token_id}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_ADMIN_TOKEN_FINGERPRINT=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.admin_token_fingerprint}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_ADMIN_USER_ID=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.admin_user_id}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  MM_TEAM_ID=$(kubectl get secret mattermost-gateway -n "$NAMESPACE" -o jsonpath='{.data.team_id}' 2>/dev/null | base64 -d 2>/dev/null || echo "")
  GITEA_TOKEN=$(kubectl get secret gitea-token -n "$NAMESPACE" -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null || echo "")

  status "mattermost-gateway admin_user present" "mattermost-gateway admin_user missing" "$MM_ADMIN_USER"
  status "mattermost-gateway admin_pass present" "mattermost-gateway admin_pass missing" "$MM_ADMIN_PASS"
  status "mattermost-gateway admin_token present" "mattermost-gateway admin_token missing (octogee-api Mattermost broker will fail)" "$MM_ADMIN_TOKEN"
  status "mattermost-gateway admin_token_id present" "mattermost-gateway admin_token_id missing" "$MM_ADMIN_TOKEN_ID"
  status "mattermost-gateway admin_token_fingerprint present" "mattermost-gateway admin_token_fingerprint missing" "$MM_ADMIN_TOKEN_FINGERPRINT"
  status "mattermost-gateway admin_user_id present" "mattermost-gateway admin_user_id missing" "$MM_ADMIN_USER_ID"
  status "mattermost-gateway team_id present" "mattermost-gateway team_id missing" "$MM_TEAM_ID"
  status "gitea-token present" "gitea-token missing" "$GITEA_TOKEN"

  MM_K8S_PASSWORD_FILE=$(mktemp)
  MM_SM_PASSWORD_FILE=$(mktemp)
  kubectl get secret mattermost-cloud-sql -n "$NAMESPACE" --context "$K8S_CONTEXT" \
    -o jsonpath='{.data.password}' 2>/dev/null | base64 -d > "$MM_K8S_PASSWORD_FILE" 2>/dev/null || true
  gcloud secrets versions access latest \
    --secret="$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET" \
    --project="$TARGET_CLOUD_SQL_PROJECT" > "$MM_SM_PASSWORD_FILE" 2>/dev/null || true
  if [[ ! -s "$MM_K8S_PASSWORD_FILE" || ! -s "$MM_SM_PASSWORD_FILE" ]]; then
    fail "mattermost-cloud-sql/password or its Secret Manager source is missing"
  elif ! cmp -s "$MM_K8S_PASSWORD_FILE" "$MM_SM_PASSWORD_FILE"; then
    fail "mattermost-cloud-sql/password does not match Secret Manager"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-mattermost.sh --env=$ENV$TARGET_ARG"
    fi
  else
    pass "mattermost-cloud-sql/password matches Secret Manager"
  fi
  rm -f "$MM_K8S_PASSWORD_FILE" "$MM_SM_PASSWORD_FILE"

  set_section bootstrap
  header "Mattermost authenticated admin contract"
  MM_ADMIN_TOKEN_ACTUAL_FINGERPRINT=$(printf '%s' "$MM_ADMIN_TOKEN" | openssl dgst -sha256 -r | awk '{print $1}')
  if [[ -z "$MM_ADMIN_TOKEN_ID" || -z "$MM_ADMIN_TOKEN_FINGERPRINT" || "$MM_ADMIN_TOKEN_ACTUAL_FINGERPRINT" != "$MM_ADMIN_TOKEN_FINGERPRINT" ]]; then
    fail "Mattermost authenticated admin contract failed: admin token does not match its tracked PAT fingerprint"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-mattermost.sh --env=$ENV$TARGET_ARG"
    fi
  else
    MM_PORT_FORWARD_LOG=$(mktemp)
    kubectl port-forward --address 127.0.0.1 -n "$NAMESPACE" --context "$K8S_CONTEXT" \
      svc/mattermost 0:8065 > "$MM_PORT_FORWARD_LOG" 2>&1 &
    MM_PORT_FORWARD_PID=$!
    MM_LOCAL_PORT=""
    for _ in $(seq 1 10); do
      MM_LOCAL_PORT=$(sed -nE 's/.*127\.0\.0\.1:([0-9]+).*/\1/p' "$MM_PORT_FORWARD_LOG" | head -1)
      [[ -n "$MM_LOCAL_PORT" ]] && break
      sleep 1
    done
    if [[ -z "$MM_LOCAL_PORT" ]]; then
      fail "Mattermost authenticated admin contract could not establish a port-forward"
    else
      MM_ME_RESPONSE=$(curl -s --max-time 10 "http://127.0.0.1:$MM_LOCAL_PORT/api/v4/users/me" \
        -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null || true)
      MM_PAT_RESPONSE=$(curl -s --max-time 10 "http://127.0.0.1:$MM_LOCAL_PORT/api/v4/users/tokens/$MM_ADMIN_TOKEN_ID" \
        -H "Authorization: Bearer $MM_ADMIN_TOKEN" 2>/dev/null || true)
      if python3 -c '
import json, sys
try:
    user, access_token = [json.loads(value) for value in sys.stdin.read().splitlines()]
except json.JSONDecodeError:
    raise SystemExit(1)
except ValueError:
    raise SystemExit(1)
roles = user.get("roles", "")
raise SystemExit(not (
    user.get("id") == sys.argv[1]
    and user.get("username") == sys.argv[2]
    and "system_admin" in roles.split()
    and access_token.get("id") == sys.argv[3]
    and access_token.get("user_id") == sys.argv[1]
    and access_token.get("description") == "octogee platform admin PAT"
    and access_token.get("is_active") is True
))
' "$MM_ADMIN_USER_ID" "$MM_ADMIN_USER" "$MM_ADMIN_TOKEN_ID" <<<"${MM_ME_RESPONSE}"$'\n'"${MM_PAT_RESPONSE}"; then
        pass "Mattermost authenticated platform PAT contract verified"
      else
        fail "Mattermost authenticated admin contract failed: admin token is not the tracked active platform PAT"
        if $FIX; then
          echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-mattermost.sh --env=$ENV$TARGET_ARG"
        fi
      fi
    fi
    if kill -0 "$MM_PORT_FORWARD_PID" 2>/dev/null; then
      kill "$MM_PORT_FORWARD_PID" 2>/dev/null || true
      wait "$MM_PORT_FORWARD_PID" 2>/dev/null || true
    fi
    rm -f "$MM_PORT_FORWARD_LOG"
  fi
else
  fail "Mattermost not ready (readyReplicas=${MM_READY:-0})"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  fi
fi

# ── 4. Gitea ──────────────────────────────────────────────────────────────────
set_section infra
header "4. Gitea"
# Gitea deployment name varies: "gitea" (standalone) or "octogee-gitea" (Helm umbrella)
GITEA_DEPLOY=$(kubectl get deployment -n "$NAMESPACE" -o name 2>/dev/null | grep gitea | head -1 | sed 's|deployment.apps/||' || echo "")
GITEA_READY=$(kubectl get deployment "$GITEA_DEPLOY" -n "$NAMESPACE" \
  -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
GITEA_IMAGE=$(kubectl get deployment "$GITEA_DEPLOY" -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || echo "unknown")
GITEA_CHART=$(helm list -n "$NAMESPACE" -o json 2>/dev/null \
  | python3 -c "import json,sys; charts=[r for r in json.load(sys.stdin) if 'gitea' in r['name']]; print(charts[0]['chart'] if charts else 'not installed')" 2>/dev/null || echo "unknown")

if [[ "${GITEA_READY:-0}" -ge 1 ]]; then
  pass "Running (image: $GITEA_IMAGE, chart: $GITEA_CHART)"
  GITEA_TOKEN_B64=$(kubectl get secret gitea-token -n "$NAMESPACE" \
    -o jsonpath='{.data.token}' 2>/dev/null || echo "")
  if [[ -n "$GITEA_TOKEN_B64" ]]; then
    pass "API token secret present"

    set_section bootstrap
    if GITEA_BROKER_DEPLOYMENT="$(probe_ready_assigned_gateway_gitea_broker "$K8S_CONTEXT" "$NAMESPACE")"; then
      pass "Authenticated Gitea admin broker read passed from assigned gateway tenant ($GITEA_BROKER_DEPLOYMENT)"
    else
      fail "Gitea admin broker contract failed; see the preceding Ready assigned-gateway probe error"
    fi
    K8S_NAMESPACE="$NAMESPACE"
    if validate_gitea_token_consumers; then
      pass "Gitea platform consumers authenticated with issue-route access"
    elif $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-gitea.sh ${FIX_SUFFIX}"
    fi
    set_section infra
  else
    warn "gitea-token secret missing — provisioner cannot create repos"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-gitea.sh ${FIX_SUFFIX}"
    fi
  fi
else
  fail "Gitea not ready (readyReplicas=${GITEA_READY:-0})"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-gitea.sh ${FIX_SUFFIX}"
  fi
fi

# ── 5. Gateway ────────────────────────────────────────────────────────────────
set_section infra
header "5. Gateway"

while IFS=$'\t' read -r SHARED_GW_NAME SHARED_GW_INSTANCE SHARED_GW_READY SHARED_GW_DESIRED; do
  [[ -z "$SHARED_GW_NAME" ]] && continue
  if [[ "${SHARED_GW_READY:-0}" -gt 0 ]]; then
    pass "shared slot $SHARED_GW_INSTANCE → $SHARED_GW_NAME ready=$SHARED_GW_READY/$SHARED_GW_DESIRED"
  elif [[ "${SHARED_GW_DESIRED:-0}" -eq 0 ]]; then
    info "shared slot $SHARED_GW_INSTANCE → $SHARED_GW_NAME empty (replicas=0)"
  else
    warn "shared slot $SHARED_GW_INSTANCE → $SHARED_GW_NAME not Ready (ready=$SHARED_GW_READY/$SHARED_GW_DESIRED)"
  fi
done <<< "$SHARED_GW_LIST"

if [[ -z "$SHARED_POOL_MIN_REPLICAS" ]]; then
  warn "SHARED_POOL_MIN_REPLICAS is not set; skipping the shared pool floor check"
elif [[ "$SHARED_GW_READY_COUNT" -ge "$SHARED_POOL_MIN_REPLICAS" ]]; then
  pass "shared pool has $SHARED_GW_READY_COUNT Ready slot(s) of $SHARED_GW_TOTAL (minReplicas=$SHARED_POOL_MIN_REPLICAS)"
else
  fail "shared pool has $SHARED_GW_READY_COUNT Ready slot(s), below minReplicas=$SHARED_POOL_MIN_REPLICAS"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} check the automation that adds shared gateways through the Admin API"
  fi
fi

if [[ -z "$GW_DEPLOYMENT" ]]; then
  if [[ "${SHARED_POOL_MIN_REPLICAS:-1}" -eq 0 ]]; then
    info "No Ready shared slot (minReplicas=0); single-gateway checks skipped"
  else
    fail "No Ready shared gateway deployment found."
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} kubectl logs deployment/glm-controller -n $NAMESPACE --tail=50    # check fleet controller reconciler"
    fi
  fi
else
  info "Gateway deployment: $GW_DEPLOYMENT (shared slot $GW_INSTANCE_ID)"
  GW_DESIRED=$(kubectl get deployment "$GW_DEPLOYMENT" -n "$NAMESPACE" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")
  GW_READY=$(kubectl get deployment "$GW_DEPLOYMENT" -n "$NAMESPACE" \
    -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
  GW_IMAGE=$(kubectl get deployment "$GW_DEPLOYMENT" -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[?(@.name=="gateway")].image}' 2>/dev/null || echo "unknown")

  # Extract git SHA from image tag if present. Image tags are pinned to
  # 7 chars by the build workflow; local `git rev-parse --short` defaults
  # to 7 but auto-extends to 8 on disambiguation or with core.abbrev
  # raised — comparing 7-char to 8-char would never match even when the
  # deploy is current. Normalize HEAD to GW_SHA's length.
  GW_SHA=$(octogee_gateway_image_release_sha "$GW_IMAGE" || echo "")
  if [[ -n "$GW_SHA" ]]; then
    LATEST_SHA=$(cd "$REPO_DIR" && git rev-parse HEAD 2>/dev/null | head -c "${#GW_SHA}" || echo "unknown")
  else
    LATEST_SHA=$(cd "$REPO_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  fi

  if [[ "${GW_DESIRED:-0}" -eq 0 ]]; then
    fail "Gateway scaled to 0 replicas — the fleet controller's glmGateways doc may have desiredStatus=retired"
  elif [[ "${GW_READY:-0}" -ge 1 ]]; then
    pass "Running ($GW_READY/$GW_DESIRED replicas)"
    info "Image: $GW_IMAGE"
    if [[ "$GW_IMAGE" == *":latest" ]]; then
      pass "Build: :latest (fleet controller auto-bootstrap default)"
    elif [[ -n "$GW_SHA" && "$GW_SHA" == "$LATEST_SHA" ]]; then
      pass "Build: $GW_SHA (matches HEAD ✓)"
    elif [[ -n "$GW_SHA" ]]; then
      warn "Build: $GW_SHA (HEAD is $LATEST_SHA — image may be stale)"
    fi
    # Check for crash loop
    GW_RESTARTS=$(kubectl get pods -n "$NAMESPACE" \
      -l "gateway-class,gateway-instance=$GW_INSTANCE_ID" \
      -o json 2>/dev/null | python3 -c '
import json, sys
items = [item for item in json.load(sys.stdin).get("items", []) if not item["metadata"].get("deletionTimestamp")]
statuses = items[0].get("status", {}).get("containerStatuses", []) if items else []
print(next((status.get("restartCount", 0) for status in statuses if status.get("name") == "gateway"), 0))
' 2>/dev/null || echo "0")
    if [[ "${GW_RESTARTS:-0}" -gt 5 ]]; then
      warn "Gateway has restarted ${GW_RESTARTS} times — possible crash loop"
      if $FIX; then
        echo -e "  ${YELLOW}FIX:${NC} kubectl logs deployment/$GW_DEPLOYMENT -n $NAMESPACE -c gateway --tail=50"
      fi
    else
      pass "Restarts: ${GW_RESTARTS:-0}"
    fi
    # Check openclaw config valid
    CONFIG_ERROR=$(kubectl logs "deployment/$GW_DEPLOYMENT" -n "$NAMESPACE" -c gateway \
      --tail=30 2>/dev/null | grep -i "config invalid\|additionalProperties\|openclaw.json" | \
      grep -v "onnxruntime\|pthread\|affinity" | head -1 || echo "")
    if [[ -n "$CONFIG_ERROR" ]]; then
      warn "Config issue detected in logs: $CONFIG_ERROR"
    else
      pass "Config: no errors in recent logs"
    fi
  else
    fail "Gateway not ready (readyReplicas=${GW_READY:-0}, desired=${GW_DESIRED:-0})"
    GW_POD_STATUS=$(kubectl get pods -n "$NAMESPACE" \
      -l "gateway-class,gateway-instance=$GW_INSTANCE_ID" \
      -o json 2>/dev/null | python3 -c '
import json, sys
items = [item for item in json.load(sys.stdin).get("items", []) if not item["metadata"].get("deletionTimestamp")]
print(items[0].get("status", {}).get("phase", "unknown") if items else "unknown")
' 2>/dev/null || echo "unknown")
    info "Pod status: $GW_POD_STATUS"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} kubectl logs deployment/$GW_DEPLOYMENT -n $NAMESPACE -c gateway --tail=50"
    fi
  fi
fi

# ── 5a. Gateway capacity placement ───────────────────────────────────────────
set_section infra
header "5a. Gateway capacity placement"
if CAPACITY_PREFER_SPOT=$(node - "$REPO_DIR" "$HELM_VALUES_FILE" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.argv[2];
const { parse } = require(path.join(root, 'scripts/node_modules/yaml'));
const base = parse(fs.readFileSync(path.join(root, 'charts/octogee/values.yaml'), 'utf8'));
const selected = parse(fs.readFileSync(path.resolve(root, process.argv[3]), 'utf8'));
const override = selected?.gatewayFleet?.computeClass?.preferSpot;
const policy = override === undefined ? base.gatewayFleet.computeClass.preferSpot : override;
if (typeof policy !== 'boolean') throw new Error('gatewayFleet.computeClass.preferSpot must be boolean');
process.stdout.write(String(policy));
NODE
); then
  if CAPACITY_PLACEMENT_ERRORS=$(octogee_verify_gateway_capacity_placement "$K8S_CONTEXT" "$NAMESPACE" "$CAPACITY_PREFER_SPOT" 2>&1); then
    pass "$CAPACITY_PLACEMENT_ERRORS"
  else
    fail "gateway capacity placement is invalid: $CAPACITY_PLACEMENT_ERRORS"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} reconcile the affected fleet controller gateway release, then rerun this verifier"
    fi
  fi
else
  fail "could not read configured gateway capacity policy"
fi

# ── 5c. Fleet controller gateway ServiceAccount ownership ──────────────────────────────
set_section infra
header "5c. Fleet controller gateway ServiceAccount ownership"
if KSA_OWNERSHIP_ERRORS=$(kubectl --context "$K8S_CONTEXT" get serviceaccounts -n "$NAMESPACE" -o json 2>/dev/null | \
  python3 -c '
import json
import sys

target = sys.argv[1]
payload = json.load(sys.stdin)
errors = []
for item in payload.get("items", []):
    metadata = item.get("metadata", {})
    name = metadata.get("name", "")
    if not name.startswith("octogee-gw-"):
        continue
    gateway_id = name.removeprefix("octogee-gw-")
    labels = metadata.get("labels", {})
    expected = {
        "app.kubernetes.io/managed-by": "glm-controller",
        "octogee.ai/controller": "cowboy",
        "octogee.ai/deployment-target": target,
        "octogee.ai/gateway-id": gateway_id,
        "octogee.ai/release": name,
        "octogee.ai/lifecycle-identity": f"gateway-{gateway_id}",
    }
    invalid = [key for key, value in expected.items() if labels.get(key) != value]
    if invalid:
        summary = ", ".join(invalid)
        errors.append(f"{name}: missing or invalid {summary}")
print("\n".join(errors))
sys.exit(1 if errors else 0)
' "$TARGET_ID"); then
  pass "all dynamic gateway KSAs are explicitly controller-owned"
elif [[ -n "$KSA_OWNERSHIP_ERRORS" ]]; then
  fail "unlabeled or incorrectly owned dynamic gateway KSA: $KSA_OWNERSHIP_ERRORS"
else
  fail "could not verify dynamic gateway KSA ownership in $NAMESPACE"
fi

# ── 5e. Gateway Storage Mode ──────────────────────────────────────────────────
# Gateway is always emptyDir. Pod-local state is disposable: the fleet
# controller restores user workspaces from Gitea post-boot, MEMORY.md
# rides the workspace tree (so it persists via the same Gitea path), and
# agent session continuity on restart comes from octogee_chat_history. This
# check catches accidental PVC reintroductions.
set_section infra
header "5e. Gateway Storage Mode"

if [[ -z "$GW_DEPLOYMENT" ]]; then
  info "Skipping storage-mode check — no gateway deployment yet"
else
  GW_VOLUME_JSON=$(kubectl get deployment "$GW_DEPLOYMENT" -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.volumes[?(@.name=="data")]}' 2>/dev/null || echo "")

  if [[ -z "$GW_VOLUME_JSON" ]]; then
    fail "$GW_DEPLOYMENT has no 'data' volume (chart broken)"
  elif echo "$GW_VOLUME_JSON" | grep -q '"emptyDir"'; then
    pass "Storage mode: emptyDir (cattle, expected)"
  else
    fail "Storage mode mismatch: expected emptyDir, got $GW_VOLUME_JSON"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} helm upgrade with the chart defaults — gateway is always emptyDir"
    fi
  fi
fi

# Check for orphan gateway PVCs left behind by a prior pvc-mode install.
ORPHAN_PVCS=$(kubectl get pvc -n "$NAMESPACE" \
  -l app.kubernetes.io/name=octogee-gateway -o name 2>/dev/null || echo "")
if [[ -n "$ORPHAN_PVCS" ]]; then
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    fail "Orphan gateway PVC: $p (gateway runs on emptyDir; this PVC is unmounted dead weight)"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} kubectl delete $p -n $NAMESPACE"
    fi
  done <<< "$ORPHAN_PVCS"
else
  pass "No orphan gateway PVCs"
fi

# ── 5b. GKE Ingresses ─────────────────────────────────────────────────────────
set_section infra
header "5b. Ingresses"
INGRESSES=$(kubectl --context "$K8S_CONTEXT" get ingress -n "$NAMESPACE" -o json 2>/dev/null)
if [[ -z "$INGRESSES" || "$INGRESSES" == "null" ]]; then
  warn "No ingresses found"
else
  for ING_NAME in $(echo "$INGRESSES" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i['metadata']['name']) for i in d.get('items',[])]" 2>/dev/null); do
    ING_IP=$(echo "$INGRESSES" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i.get('status',{}).get('loadBalancer',{}).get('ingress',[{}])[0].get('ip','')) for i in d.get('items',[]) if i['metadata']['name']=='$ING_NAME']" 2>/dev/null)
    ING_HOST=$(echo "$INGRESSES" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i['spec']['rules'][0]['host']) for i in d.get('items',[]) if i['metadata']['name']=='$ING_NAME']" 2>/dev/null)
    ING_STATICIP=$(echo "$INGRESSES" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i['metadata'].get('annotations',{}).get('kubernetes.io/ingress.global-static-ip-name','')) for i in d.get('items',[]) if i['metadata']['name']=='$ING_NAME']" 2>/dev/null)
    if [[ -n "$ING_IP" && "$ING_IP" != "None" ]]; then
      pass "$ING_NAME → $ING_HOST ($ING_IP)"
    else
      # A `<none>` address can be healthy only for an intentionally secondary
      # Ingress sharing a static IP with a sibling that already has the address.
      # The steady-state edge should normally be octogee-edge-ingress.
      SIBLING_IP=$(echo "$INGRESSES" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i.get('status',{}).get('loadBalancer',{}).get('ingress',[{}])[0].get('ip','')) for i in d.get('items',[]) if i['metadata']['name']!='$ING_NAME' and i['metadata'].get('annotations',{}).get('kubernetes.io/ingress.global-static-ip-name','')=='$ING_STATICIP' and i.get('status',{}).get('loadBalancer',{}).get('ingress',[{}])[0].get('ip','')]" 2>/dev/null | head -1)
      if [[ -n "$ING_STATICIP" && -n "$SIBLING_IP" ]]; then
        pass "$ING_NAME → $ING_HOST (shared IP $SIBLING_IP via $ING_STATICIP — fleet sibling, expected)"
      else
        fail "$ING_NAME → $ING_HOST has NO ADDRESS"
        if $FIX; then
          echo -e "  ${YELLOW}FIX:${NC} If this is a fleet sibling, its main ingress must own the shared static IP first."
          echo -e "  ${YELLOW}     ${NC} Else verify kubernetes.io/ingress.class=gce + the static IP isn't conflicted."
        fi
      fi
    fi
  done
fi

# ── 5c. Managed Certificates ─────────────────────────────────────────────────
set_section infra
header "5c. Managed Certificates"
CERTS=$(kubectl --context "$K8S_CONTEXT" get managedcertificate -n "$NAMESPACE" -o json 2>/dev/null)
if [[ -z "$CERTS" || "$CERTS" == "null" ]]; then
  warn "No managed certificates found"
else
  for CERT_NAME in $(echo "$CERTS" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i['metadata']['name']) for i in d.get('items',[])]" 2>/dev/null); do
    CERT_STATUS=$(echo "$CERTS" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i.get('status',{}).get('certificateStatus','Unknown')) for i in d.get('items',[]) if i['metadata']['name']=='$CERT_NAME']" 2>/dev/null)
    CERT_DOMAIN=$(echo "$CERTS" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(i['spec']['domains'][0]) for i in d.get('items',[]) if i['metadata']['name']=='$CERT_NAME']" 2>/dev/null)
    # Classify: does this cert belong in this env? Convention is test certs
    # have a -test suffix, prod certs don't. Custom namespaces opt out (any
    # naming is fine since they're already namespace-isolated).
    IS_STRANGER=false
    case "$ENV" in
      prod) [[ "$CERT_NAME" == *-test ]] && IS_STRANGER=true ;;
      test) [[ "$CERT_NAME" != *-test ]] && IS_STRANGER=true ;;
    esac
    if $IS_STRANGER; then
      warn "$CERT_NAME ($CERT_DOMAIN): cross-env cert in this namespace (stale leftover, status=$CERT_STATUS)"
      if $FIX; then
        echo -e "  ${YELLOW}FIX:${NC} kubectl delete managedcertificate $CERT_NAME -n $NAMESPACE"
      fi
      continue
    fi
    if [[ "$CERT_STATUS" == "Active" ]]; then
      pass "$CERT_NAME ($CERT_DOMAIN): Active"
    elif [[ "$CERT_STATUS" == "Provisioning" ]]; then
      warn "$CERT_NAME ($CERT_DOMAIN): Provisioning (may take 15-30 min)"
    else
      fail "$CERT_NAME ($CERT_DOMAIN): $CERT_STATUS"
      if $FIX; then
        echo -e "  ${YELLOW}FIX:${NC} Delete and recreate: kubectl delete managedcertificate $CERT_NAME -n $NAMESPACE"
        print_platform_helm_repair
      fi
    fi
  done
fi

# ── 5f. Fleet-control signing keypair ───────────────────────────────────────
# The fleet-control LB was retired (FLEET-CONTROL-NEG-SHED): migration now runs
# inside glm-controller over internal ClusterIP DNS — no fleet host / static IP /
# DNS to check. glm-controller signs the in-cluster migration RPCs with an
# Ed25519 private key; gateway pods verify with only the public key.
# Per-env:
#   - K8s Secret octogee-fleet-controller/private-key matches SM
#     FLEET_CONTROLLER_PRIVATE_KEY
#   - K8s Secret octogee-fleet-controller/public-key matches SM
#     FLEET_CONTROLLER_PUBLIC_KEY and derives from the private key
set_section infra
header "5f. Fleet-control signing keypair"

if [[ "$ENV" == "custom" ]]; then
  info "Custom namespaces don't use the fleet-control keypair — skipping"
else

  tmp_k8s_priv=$(mktemp) && tmp_k8s_pub=$(mktemp) && tmp_sm_priv=$(mktemp) && tmp_sm_pub=$(mktemp) && tmp_derived_pub=$(mktemp)
  kubectl get secret octogee-fleet-controller -n "$NAMESPACE" -o go-template='{{index .data "private-key"}}' 2>/dev/null | base64 -d > "$tmp_k8s_priv" 2>/dev/null || true
  kubectl get secret octogee-fleet-controller -n "$NAMESPACE" -o go-template='{{index .data "public-key"}}' 2>/dev/null | base64 -d > "$tmp_k8s_pub" 2>/dev/null || true
  gcloud secrets versions access latest --secret=FLEET_CONTROLLER_PRIVATE_KEY --project="$FIREBASE_PROJECT" > "$tmp_sm_priv" 2>/dev/null || true
  gcloud secrets versions access latest --secret=FLEET_CONTROLLER_PUBLIC_KEY --project="$FIREBASE_PROJECT" > "$tmp_sm_pub" 2>/dev/null || true
  K8S_PRIV_LEN=$(wc -c < "$tmp_k8s_priv" | tr -d ' ')
  K8S_PUB_LEN=$(wc -c < "$tmp_k8s_pub" | tr -d ' ')
  SM_PRIV_LEN=$(wc -c < "$tmp_sm_priv" | tr -d ' ')
  SM_PUB_LEN=$(wc -c < "$tmp_sm_pub" | tr -d ' ')
  K8S_PRIV_HASH=$(shasum -a 256 < "$tmp_k8s_priv" | awk '{print $1}' | head -c 12)
  K8S_PUB_HASH=$(shasum -a 256 < "$tmp_k8s_pub" | awk '{print $1}' | head -c 12)
  SM_PRIV_HASH=$(shasum -a 256 < "$tmp_sm_priv" | awk '{print $1}' | head -c 12)
  SM_PUB_HASH=$(shasum -a 256 < "$tmp_sm_pub" | awk '{print $1}' | head -c 12)

  if [[ "$K8S_PRIV_LEN" == "0" || "$K8S_PUB_LEN" == "0" ]]; then
    fail "K8s Secret octogee-fleet-controller missing private-key/public-key in $NAMESPACE — migration RPC auth will fail"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG"
    fi
  elif [[ "$SM_PRIV_LEN" == "0" || "$SM_PUB_LEN" == "0" ]]; then
    fail "Secret Manager fleet controller keypair missing in $FIREBASE_PROJECT — K8s Secret cannot be synced from SM"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG"
    fi
  elif ! openssl pkey -in "$tmp_sm_priv" -pubout -out "$tmp_derived_pub" >/dev/null 2>&1; then
    fail "FLEET_CONTROLLER_PRIVATE_KEY is not a valid private key"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} rotate FLEET_CONTROLLER_PRIVATE_KEY, then ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG"
    fi
  elif ! cmp -s "$tmp_sm_pub" "$tmp_derived_pub"; then
    fail "FLEET_CONTROLLER_PUBLIC_KEY does not derive from FLEET_CONTROLLER_PRIVATE_KEY"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG (re-derives public key)"
    fi
  elif [[ "$K8S_PRIV_HASH" != "$SM_PRIV_HASH" || "$K8S_PUB_HASH" != "$SM_PUB_HASH" ]]; then
    fail "octogee-fleet-controller keypair drift: K8s private=$K8S_PRIV_HASH public=$K8S_PUB_HASH vs SM private=$SM_PRIV_HASH public=$SM_PUB_HASH"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG (SM is source of truth; rewrites K8s)"
    fi
  else
    pass "Fleet controller keypair synced (private $K8S_PRIV_LEN bytes, public $K8S_PUB_LEN bytes, public=$K8S_PUB_HASH...)"
  fi
  rm -f "$tmp_k8s_priv" "$tmp_k8s_pub" "$tmp_sm_priv" "$tmp_sm_pub" "$tmp_derived_pub"

fi

# ── 5d. Endpoint Health (HTTPS) ──────────────────────────────────────────────
# Derive URLs from K8s Ingress resources — no hardcoded env-specific URLs.
# One consolidated public edge Ingress fronts the API, gateway-router, preview,
# git, and MM REST surfaces. Gateway-local public traffic uses /g/<gatewayId>/*
# and the router forwards to the selected gateway pod.
set_section bootstrap
header "5d. Endpoint Health"
for INGRESS_NAME in octogee-edge-ingress gateway-edge-ingress mattermost-ingress; do
  if ! kubectl get ingress "$INGRESS_NAME" -n "$NAMESPACE" >/dev/null 2>&1; then
    continue
  fi
  HOSTS=$(kubectl get ingress "$INGRESS_NAME" -n "$NAMESPACE" -o jsonpath='{range .spec.rules[*]}{.host}{"\n"}{end}' 2>/dev/null || echo "")
  if [[ -z "$HOSTS" ]]; then
    warn "$INGRESS_NAME — no host found"
    continue
  fi
  EXPECT_IAP_REDIRECT=false
  case "$INGRESS_NAME" in
    mattermost-ingress)
      # IAP-gated admin ingress — unauthenticated requests get a 302 to
      # accounts.google.com/o/oauth2 for sign-in. That IS the healthy
      # signal; a 200 here would mean IAP is off.
      HEALTH_PATH="/api/v4/system/ping"
      EXPECT_IAP_REDIRECT=true
      ;;
    *)
      DEPLOY_NAME="${INGRESS_NAME%-ingress}"
      HEALTH_PATH=$(kubectl get deployment "$DEPLOY_NAME" -n "$NAMESPACE" \
        -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.httpGet.path}' 2>/dev/null || echo "/health")
      ;;
  esac
  while IFS= read -r HOST; do
    [[ -z "$HOST" ]] && continue
    HOST_EXPECT_IAP_REDIRECT="$EXPECT_IAP_REDIRECT"
    if is_iap_protected_admin_host "$HOST"; then
      HOST_EXPECT_IAP_REDIRECT=true
    fi
    if [[ "$INGRESS_NAME" == "octogee-edge-ingress" ]]; then
      case "$HOST" in
        git*) HEALTH_PATH="/" ;;
        mattermost*) HEALTH_PATH="/api/v4/system/ping" ;;
        *) HEALTH_PATH="/health" ;;
      esac
    fi
    URL="https://${HOST}${HEALTH_PATH}"
    PROBE=$(curl -sk -o /dev/null -w "%{http_code} %{redirect_url}" --max-time 5 "$URL" 2>/dev/null || echo "000 ")
    HTTP_CODE="${PROBE%% *}"
    REDIRECT_URL="${PROBE#* }"
    if [[ "$HOST_EXPECT_IAP_REDIRECT" == "true" ]] && is_expected_iap_redirect "$HTTP_CODE" "$REDIRECT_URL"; then
      pass "$URL → $HTTP_CODE (IAP login redirect — admin access gated, expected)"
    elif [[ "$HOST_EXPECT_IAP_REDIRECT" == "true" && "$HTTP_CODE" == "200" ]]; then
      warn "$URL → $HTTP_CODE (expected IAP login redirect — admin access may be ungated)"
    elif [[ "$HOST_EXPECT_IAP_REDIRECT" == "true" && "$HTTP_CODE" == "302" ]]; then
      warn "$URL → $HTTP_CODE (expected Google IAP login redirect)"
    elif [[ "$HTTP_CODE" == "200" ]]; then
      pass "$URL → $HTTP_CODE"
    elif [[ "$HTTP_CODE" == "000" ]]; then
      warn "$URL → unreachable (TLS or DNS issue)"
    else
      warn "$URL → HTTP $HTTP_CODE"
    fi
  done <<< "$HOSTS"
done

# ── 5d.b Mattermost credential mint ───────────────────────────────────────────
# The mint (now on octogee-api, fronted by octogee-edge-ingress /
# api[-test].octogee.com) is the only path that hands the user's PAT to the
# browser. Unauthenticated POST must return 401 — proves the route is wired
# through the Ingress allowlist to octogee-api. A 404 means the
# /api/auth/* rule is missing or octogee-api isn't deployed.
API_HOST=$(kubectl get ingress octogee-edge-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || echo "")
if [[ -z "$API_HOST" ]]; then
  API_HOST=$(kubectl get ingress gateway-edge-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || echo "")
fi
if [[ -n "$API_HOST" ]]; then
  MINT_URL="https://${API_HOST}/api/auth/mattermost"
  MINT_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 -X POST "$MINT_URL" 2>/dev/null || echo "000")
  if [[ "$MINT_CODE" == "401" ]]; then
    pass "$MINT_URL → 401 (credential mint route present, auth-gated)"
  elif [[ "$MINT_CODE" == "404" ]]; then
    fail "$MINT_URL → 404 — Ingress /api/auth/* rule missing or octogee-api not deployed"
    if $FIX; then
      echo -e "  ${YELLOW}FIX:${NC} kubectl rollout restart deployment/octogee-api -n $NAMESPACE"
    fi
  elif [[ "$MINT_CODE" == "000" ]]; then
    warn "$MINT_URL → unreachable (TLS or DNS issue)"
  else
    warn "$MINT_URL → HTTP $MINT_CODE (expected 401 unauthenticated)"
  fi
fi

# ── 6. Site (Firebase Hosting) ────────────────────────────────────────────────
set_section infra
header "6. Site (Firebase Hosting)"
SITE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$SITE_URL" 2>/dev/null || echo "000")
if [[ "$SITE_STATUS" == "200" ]]; then
  pass "$SITE_URL → HTTP $SITE_STATUS"
else
  fail "$SITE_URL → HTTP $SITE_STATUS (expected 200)"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} cd site && npm run build && firebase deploy --only hosting --project=$FIREBASE_PROJECT"
  fi
fi

# Check deployed functions count (post-CF migration: only Firestore triggers remain, ~15 expected)
set_section infra
header "7. Cloud Functions"
CF_COUNT=$(gcloud run services list --project="$GCP_PROJECT" \
  --region="$TARGET_REGION" --format="value(name)" 2>/dev/null | wc -l | tr -d ' ' || echo "0")

if [[ "$CF_COUNT" -ge 10 ]]; then
  pass "$CF_COUNT Cloud Run services deployed"
else
  warn "Only $CF_COUNT Cloud Run services found (expected ~15 Firestore triggers)"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} cd functions && npm run build && firebase deploy --only functions --project=$FIREBASE_PROJECT"
  fi
fi

# ── 8. Chat (folded into gateway-edge + octogee-api) ──────────────────────────
# chat-proxy is gone as a separate container.
# - MM REST (/api/v4/*) + credential mint (/api/auth/mattermost) → octogee-api
#   (the mint route was preflighted in 5d.b above).
# - MM WS bridge + OpenClaw WS → gateway-router /g/<gw>/*
#   publicly, then the gateway-edge sidecar's internal /api/g/<gw>/* mount.
set_section infra
header "8. chat (gateway-edge sidecar + octogee-api)"
# Iterate EVERY running gateway pod (cattle fleet: walter, default, …) and
# assert each is on the post-fold architecture:
#   - has a gateway-edge container (WS surfaces live here),
#   - does NOT still carry a chat-proxy sidecar (the fold deleted it — a
#     lingering one means the pod is a stale pre-#1124 image that never
#     rolled, the exact failure mode that stalled gw-test/gw-prod),
#   - gateway + gateway-edge carry the same immutable build tag while each
#     package keeps its own digest (a tag mismatch = a partial/stuck roll).
# No running gateways is a WARN, not a failure — the fleet can legitimately
# be scaled to zero (e.g. an idle TEST env).
GW_PODS=$(kubectl get pods -l gateway-class -n "$NAMESPACE" -o json 2>/dev/null)
GW_POD_NAMES=$(echo "$GW_PODS" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(p['metadata']['name']) for p in d.get('items',[]) if not p['metadata'].get('deletionTimestamp')]" 2>/dev/null)
if [[ -z "$GW_POD_NAMES" ]]; then
  warn "no running gateway pods in $NAMESPACE — gateway-edge/WS surfaces not serving (OK if the fleet is scaled to zero)"
else
  while IFS= read -r POD; do
    [[ -z "$POD" ]] && continue
    CONTAINERS=$(kubectl get pod "$POD" -n "$NAMESPACE" -o jsonpath='{range .spec.containers[*]}{.name}{" "}{end}' 2>/dev/null)
    GE_IMG=$(kubectl get pod "$POD" -n "$NAMESPACE" -o jsonpath='{.spec.containers[?(@.name=="gateway-edge")].image}' 2>/dev/null)
    GW_IMG=$(kubectl get pod "$POD" -n "$NAMESPACE" -o jsonpath='{.spec.containers[?(@.name=="gateway")].image}' 2>/dev/null)
    if [[ -z "$GE_IMG" ]]; then
      fail "$POD: no gateway-edge container — stale pre-fold pod, needs a fleet controller roll"
    else
      pass "$POD: gateway-edge present (${GE_IMG##*/})"
    fi
    if echo " $CONTAINERS " | grep -q " chat-proxy "; then
      fail "$POD: chat-proxy sidecar still present — STALE pre-fold image; the fleet controller must roll it to the folded gateway-edge"
    else
      pass "$POD: chat-proxy sidecar gone (folded into gateway-edge)"
    fi
    if BUNDLE_RESULT=$(octogee_gateway_image_bundle_identity "$GW_IMG" "$GE_IMG" 2>&1); then
      pass "$POD: immutable gateway bundle $BUNDLE_RESULT (independent package digests)"
    else
      warn "$POD: $BUNDLE_RESULT"
    fi
  done <<< "$GW_POD_NAMES"
fi
OA_READY=$(kubectl get deployment octogee-api -n "$NAMESPACE" -o jsonpath='{.status.readyReplicas}' 2>/dev/null || echo "0")
if [[ "${OA_READY:-0}" -ge 1 ]]; then
  pass "octogee-api ready (serves MM REST + credential mint)"
else
  fail "octogee-api not ready (readyReplicas=${OA_READY:-0}) — MM REST + mint unavailable"
  if $FIX; then
    echo -e "  ${YELLOW}FIX:${NC} kubectl logs -n $NAMESPACE deployment/octogee-api --since=30m | tail -100"
  fi
fi

run_env_hooks ${ENV_VERIFY_SECTIONS[@]+"${ENV_VERIFY_SECTIONS[@]}"}

set_section bootstrap
# ── Env contract ──────────────────────────────────────────────────────
# The gateway-edge sidecar runs the folded MM WS proxy and Activity intake,
# so it MUST have MM_INTERNAL_URL (in-cluster MM Service DNS). The
# browser-facing URL is no longer an env on this container — octogee-api's
# API_PUBLIC_URL (verified via the mint preflight in 5d.b) is the single
# host the app talks to.
if [[ -z "$GW_DEPLOYMENT" ]]; then
  info "Skipping gateway-edge env check — no gateway deployment"
  GE_MM_INTERNAL_URL=""
else
  GE_MM_INTERNAL_URL=$(kubectl get deployment "$GW_DEPLOYMENT" -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[?(@.name=="gateway-edge")].env[?(@.name=="MM_INTERNAL_URL")].value}' 2>/dev/null || echo "")
fi
if [[ -n "$GE_MM_INTERNAL_URL" ]]; then
  pass "gateway-edge MM_INTERNAL_URL=$GE_MM_INTERNAL_URL (WS bridge data path)"
elif [[ -z "$GW_DEPLOYMENT" ]]; then
  : # already informed above
else
  fail "gateway-edge missing MM_INTERNAL_URL — the WS bridge will boot-fail. Re-render helm with values.${ENV}.yaml."
  if $FIX; then
    print_platform_helm_repair
  fi
fi
set_section infra

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${ENV_COLOR}════════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Summary — ${ENV_LABEL}${NC}"
echo -e "${ENV_COLOR}════════════════════════════════════════════════════════════${NC}"

echo ""
echo -e "  ${BOLD}State buckets:${NC}"
if [[ $INFRA_FAILS -eq 0 ]]; then
  echo -e "    ${GREEN}✓ Infra state healthy${NC}"
else
  echo -e "    ${RED}✗ Infra state has $INFRA_FAILS failure(s)${NC}"
fi
if [[ $SECRET_FAILS -eq 0 ]]; then
  echo -e "    ${GREEN}✓ Secret state healthy${NC}"
else
  echo -e "    ${RED}✗ Secret state has $SECRET_FAILS failure(s)${NC}"
fi
if [[ $BOOTSTRAP_FAILS -eq 0 ]]; then
  echo -e "    ${GREEN}✓ Bootstrap state healthy${NC}"
else
  echo -e "    ${RED}✗ Bootstrap state has $BOOTSTRAP_FAILS failure(s)${NC}"
fi

if [[ ${#FAILURES[@]} -eq 0 && ${#WARNINGS[@]} -eq 0 ]]; then
  echo -e "\n  ${GREEN}${BOLD}🎉 ALL GREEN — Environment is healthy${NC}"
  echo -e "  ${GREEN}Verdict: safe to deploy / promote.${NC}\n"
  exit 0
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  echo -e "\n  ${YELLOW}⚠️  Warnings (${#WARNINGS[@]}):${NC}"
  for w in "${WARNINGS[@]}"; do
    echo -e "    - $w"
  done
fi

if [[ ${#FAILURES[@]} -gt 0 ]]; then
  echo -e "\n  ${RED}❌ Failures (${#FAILURES[@]}):${NC}"
  for f in "${FAILURES[@]}"; do
    echo -e "    - $f"
  done

  echo ""
  if [[ $INFRA_FAILS -gt 0 ]]; then
    echo -e "  ${RED}Verdict: infra is not healthy. Repair before deploy/promotion.${NC}"
  elif [[ $SECRET_FAILS -gt 0 ]]; then
    echo -e "  ${YELLOW}Verdict: infra may be up, but secret state is broken. Repair secrets/bootstrap before trusting the environment.${NC}"
  elif [[ $BOOTSTRAP_FAILS -gt 0 ]]; then
    echo -e "  ${YELLOW}Verdict: infra/secrets may be mostly up, but app bootstrap state is not trustworthy. Repair before promotion.${NC}"
  fi

  if ! $FIX; then
    echo -e "  ${YELLOW}Run with --fix to see remediation commands.${NC}"
  fi
  echo ""
  exit 1
fi

echo -e "\n  ${YELLOW}Verdict: usable with warnings, but do not promote blindly.${NC}\n"
exit 0
