#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Namespace Provisioner — DESTRUCTIVE scratch-env recreation
# ═══════════════════════════════════════════════════════════════════════════
#
# ⚠️  THIS IS NOT GENTLE PROVISIONING. ⚠️
#
# This script DELETES the target namespace if it exists (helm uninstall,
# force-delete pods/PVCs/secrets, drop the namespace, drop the Cloud SQL
# databases via psql) and then re-creates it from scratch. There is no
# preservation, no backup, no idempotent "noop if up-to-date" path.
#
# Run this when you want a clean disposable scratch/feature/dev environment
# in the shared `octogee-gateway` cluster. Each namespace gets:
#   - Its own Cloud SQL databases (per-namespace, on the shared instance)
#   - Its own PVCs (mattermost-data, gitea-shared-storage)
#   - Its own helm release + K8s secrets + MM/Gitea bootstrap
#   - Internal-only services (no ingress, no public URL)
#   - SHARED TEST Firebase project (Auth + Firestore)
#
# Custom namespaces are explicitly DISPOSABLE and NON-ROTATABLE.
# To "rotate" secrets, re-run this script (which destroys + recreates).
# scripts/rotate-secret.sh refuses --env=custom by design.
#
# Full flow:
#   PHASE 1 — DESTROY (always runs):
#     - helm uninstall
#     - force-delete deployments/statefulsets/jobs/pods
#     - patch + force-delete every PVC in the namespace
#     - delete the namespace (clear stuck finalizers via raw API if needed)
#     - cloud-sql-proxy + psql DROP DATABASE for both MM + Gitea per-ns DBs
#   PHASE 2 — PROVISION:
#     1. Terraform apply (per-namespace state prefix) → fresh Cloud SQL DBs
#     2. kubectl create namespace
#     3. Render helm values from template
#     4. setup-secrets.sh --phase=bootstrap → boot prerequisite secrets
#     5. helm upgrade --install  → fresh deployments
#     6. setup-mattermost.sh     → fresh admin/team/bot
#     7. setup-gitea.sh          → fresh org + API token
#     8. setup-secrets.sh --phase=launch → materialize generated tokens
#     9. rollout restart + verify pods running
#
# Access is INTERNAL ONLY. Use port-forward:
#   kubectl port-forward -n NAMESPACE svc/gateway-edge 3001:3001
#   kubectl port-forward -n NAMESPACE svc/mattermost 8065:8065
#
# Usage:
#   ./scripts/provision-namespace.sh feat-alice --sha=<built-full-sha>
#   ./scripts/provision-namespace.sh feat-alice --sha=<built-full-sha> --yes
#   ./scripts/provision-namespace.sh --destroy feat-alice
#   ./scripts/provision-namespace.sh feat-alice --sha=<built-full-sha> --skip-terraform
#   ./scripts/provision-namespace.sh feat-alice --sha=<built-full-sha> --deployment-target=test-west
#
# SAFETY GATES:
#   - PROD deployment namespaces require typed 'DESTROY PROD NAMESPACE' confirmation,
#     refuses --yes outright.
#   - TEST deployment namespaces are rejected entirely (use the canonical install sequence
#     printed by ./scripts/teardown-env.sh).
#   - Reserved K8s namespaces (kube-*, default, gke-*) are rejected.
#   - Any other existing namespace IS DELETED. There is no "merge" path.
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"
source "$SCRIPT_DIR/lib/agent-store-postgres-secret.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

NAMESPACE=""
YES=false
DESTROY_ONLY=false
SKIP_TERRAFORM=false
DEPLOYMENT_TARGET=""
SOURCE_SHA=""

for arg in "$@"; do
  case $arg in
    --yes|-y)        YES=true ;;
    --destroy)       DESTROY_ONLY=true ;;
    --skip-terraform) SKIP_TERRAFORM=true ;;
    --deployment-target=*) DEPLOYMENT_TARGET="${arg#*=}" ;;
    --sha=*) SOURCE_SHA="${arg#*=}" ;;
    --help|-h)
      sed -n '4,36p' "$0"
      exit 0
      ;;
    -*) echo "Unknown flag: $arg"; exit 1 ;;
    *)  [[ -z "$NAMESPACE" ]] && NAMESPACE="$arg" || { echo "Extra arg: $arg"; exit 1; } ;;
  esac
done

[[ -z "$NAMESPACE" ]] && {
  echo "Usage: $0 <namespace> --sha=<built-full-source-sha> [--deployment-target=TARGET] [--yes] [--destroy] [--skip-terraform]"
  exit 1
}

if ! $DESTROY_ONLY && ! [[ "$SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Provisioning requires --sha=<built-full-40-character-source-sha> before any destructive step" >&2
  exit 1
fi

# ── Validate namespace name ────────────────────────────────────────────────
if ! [[ "$NAMESPACE" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo -e "${RED}❌ Invalid namespace name '$NAMESPACE'${NC}"
  echo "  Must match DNS-1123 label: lowercase alphanumeric + dash, starting/ending alphanumeric."
  exit 1
fi
if [[ ${#NAMESPACE} -gt 63 ]]; then
  echo -e "${RED}❌ Namespace '$NAMESPACE' is too long (max 63 chars)${NC}"
  exit 1
fi

# DB-slug derivation (hyphen → underscore for Postgres database names)
DB_SLUG="${NAMESPACE//-/_}"

# ── Safety gate: reserved namespace handling ───────────────────────────────
TEST_NAMESPACE="$(octogee_deployment_target_field --environment=test namespace)"
case "$NAMESPACE" in
  octogee|octogee-west)
    echo ""
    echo -e "${RED}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}${BOLD}  ⚠️  NAMESPACE '$NAMESPACE' IS PRODUCTION${NC}"
    echo -e "${RED}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "  ${RED}This script will NUKE the namespace and all its data."
    echo -e "  ${RED}PVCs, secrets, MM DB, Gitea DB, everything.${NC}"
    echo ""
    echo -e "  ${RED}Do NOT use this script for production.${NC}"
    echo -e "  ${RED}Use scripts/teardown-env.sh for routine prod work.${NC}"
    echo ""
    if ! $YES; then
      echo -ne "  ${RED}${BOLD}Type 'DESTROY PROD NAMESPACE' to confirm (case-sensitive):${NC} "
      read -r confirmation
      [[ "$confirmation" == "DESTROY PROD NAMESPACE" ]] || { echo "  Cancelled."; exit 1; }
    else
      echo -e "  ${RED}${BOLD}--yes is forbidden with namespace=$NAMESPACE. Refusing.${NC}"
      exit 1
    fi
    ;;
  "$TEST_NAMESPACE"|"$TEST_NAMESPACE-west")
    echo ""
    echo -e "${YELLOW}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}${BOLD}  ⚠️  NAMESPACE '$NAMESPACE' IS A SHARED TEST ENV${NC}"
    echo -e "${YELLOW}${BOLD}═══════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "  This script is for ISOLATED custom namespaces. To rebuild the"
    echo "  shared test env, use scripts/teardown-env.sh --env=test --full"
    echo "  followed by the rebuild steps in RUNBOOK.md."
    echo ""
    exit 1
    ;;
  kube-system|kube-public|kube-node-lease|default|gke-*)
    echo -e "${RED}❌ Reserved K8s namespace: '$NAMESPACE'${NC}"
    exit 1
    ;;
esac

# ── Constants (shared cluster + test Firebase project) ─────────────────────
if [[ -n "$DEPLOYMENT_TARGET" ]]; then
  octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"
  [[ "$TARGET_ENVIRONMENT" == "test" ]] || {
    echo "Deployment target '$DEPLOYMENT_TARGET' does not belong to environment 'test'"
    exit 1
  }
else
  octogee_load_deployment_target --environment=test
fi
CLUSTER_PROJECT="$TARGET_CLUSTER_PROJECT"
CLOUDSQL_PROJECT="$TARGET_CLOUD_SQL_PROJECT"
CLOUDSQL_INSTANCE="$TARGET_CLOUD_SQL_INSTANCE"
MM_DB_PASSWORD_SECRET="$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET"
GITEA_DB_PASSWORD_SECRET="$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET"
CLUSTER_NAME="$TARGET_CLUSTER_NAME"
K8S_CONTEXT="$TARGET_KUBE_CONTEXT"
FIREBASE_PROJECT="$TARGET_FIREBASE_PROJECT"
TF_DIR="$REPO_DIR/terraform/environments/custom"
VALUES_TPL="$REPO_DIR/charts/octogee/values.custom.yaml.tpl"
VALUES_OUT="$REPO_DIR/charts/octogee/values.$NAMESPACE.yaml"
MM_DB_NAME="mattermost_${DB_SLUG}"
GITEA_DB_NAME="gitea_${DB_SLUG}"

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
fail() { echo -e "  ${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
step() { echo ""; echo -e "${CYAN}▶ $1${NC}"; }

RELEASE_VALUES=""
if ! $DESTROY_ONLY; then
  RELEASE_VALUES="$("$SCRIPT_DIR/node_modules/.bin/tsx" "$SCRIPT_DIR/ops/render-release-helm-values.ts" "$SOURCE_SHA")"
fi

confirm() {
  $YES && return 0
  echo -ne "  ${YELLOW}$1 [y/N]:${NC} "
  read -r yn
  [[ "$yn" =~ ^[Yy]$ ]]
}

# ── Banner ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${RED}${BOLD}═══════════════════════════════════════════════════════════${NC}"
if $DESTROY_ONLY; then
  echo -e "${RED}${BOLD}  ⚠️  DESTRUCTIVE: Namespace DESTROY — ${NAMESPACE}${NC}"
else
  echo -e "${RED}${BOLD}  ⚠️  DESTRUCTIVE: Scratch-Env RECREATE — ${NAMESPACE}${NC}"
fi
echo -e "${RED}${BOLD}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${RED}This is NOT gentle provisioning. It will:${NC}"
if $DESTROY_ONLY; then
  echo -e "  ${RED}  • helm uninstall the release${NC}"
  echo -e "  ${RED}  • force-delete every pod, deployment, statefulset, job, PVC${NC}"
  echo -e "  ${RED}  • delete the namespace itself${NC}"
  echo -e "  ${RED}  • DROP DATABASE on the per-namespace Cloud SQL DBs${NC}"
else
  echo -e "  ${RED}  • DESTROY any existing state in this namespace (if present):${NC}"
  echo -e "  ${RED}    helm uninstall, force-delete pods/PVCs/secrets, delete${NC}"
  echo -e "  ${RED}    namespace, DROP DATABASE on the Cloud SQL DBs${NC}"
  echo -e "  ${RED}  • RECREATE everything from scratch (terraform → helm → bootstrap)${NC}"
fi
echo ""
echo -e "  Custom namespaces are explicitly DISPOSABLE and NON-ROTATABLE."
echo -e "  ${BOLD}This script is the rotation path.${NC} (rotate-secret.sh refuses --env=custom)"
echo ""
echo -e "  Target namespace:  ${BOLD}$NAMESPACE${NC}"
echo -e "  DB slug:           ${BOLD}$DB_SLUG${NC}"
echo -e "  Mattermost DB:     ${BOLD}$MM_DB_NAME${NC} (will be DROPped if it exists)"
echo -e "  Gitea DB:          ${BOLD}$GITEA_DB_NAME${NC} (will be DROPped if it exists)"
echo -e "  Cluster:           ${BOLD}$CLUSTER_NAME${NC}"
echo -e "  Firebase (shared): ${BOLD}$FIREBASE_PROJECT${NC} (NOT touched — shared with the TEST environment)"
echo ""

# ── Tool checks ────────────────────────────────────────────────────────────
for tool in gcloud kubectl helm terraform psql; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required tool missing: $tool"
done
command -v cloud-sql-proxy >/dev/null 2>&1 || \
  ls /opt/homebrew/bin/cloud-sql-proxy >/dev/null 2>&1 || \
  fail "cloud-sql-proxy not found (try: brew install cloud-sql-proxy)"
ok "All required tools present"

# ── kubectl context ────────────────────────────────────────────────────────
step "Setting kubectl context"
gcloud container clusters get-credentials "$CLUSTER_NAME" --region "$TARGET_REGION" --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT" >/dev/null
[[ "$(kubectl config current-context)" == "$K8S_CONTEXT" ]] || fail "Wrong kubectl context"
ok "kubectl context: $K8S_CONTEXT"

if ! $DESTROY_ONLY; then
  AGENT_STORE_POSTGRES_CIDR="$(require_agent_store_postgres_secrets "$FIREBASE_PROJECT" "agent-store-postgres-$NAMESPACE")"
fi

# ── Confirm if not --yes ───────────────────────────────────────────────────
if ! $YES && ! $DESTROY_ONLY; then
  echo ""
  confirm "DESTROY '$NAMESPACE' (if it exists) and recreate from scratch?" || { echo "  Cancelled."; exit 0; }
fi

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 1: DESTROY existing state (idempotent)
# ═══════════════════════════════════════════════════════════════════════════

destroy_namespace() {
  step "Phase 1: Destroying existing state for '$NAMESPACE'"

  # 1a. Helm release
  if helm status octogee -n "$NAMESPACE" --kube-context "$K8S_CONTEXT" >/dev/null 2>&1; then
    info "Uninstalling helm release 'octogee' in $NAMESPACE..."
    helm uninstall octogee -n "$NAMESPACE" --kube-context "$K8S_CONTEXT" --no-hooks --timeout=2m 2>/dev/null || true
    ok "Helm release uninstalled"
  else
    info "No Helm release to uninstall"
  fi

  # 1b. Force-delete pods/deploys/pvcs in the namespace (cascades on namespace delete,
  #     but explicit delete is faster and avoids finalizer hangs)
  if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
    info "Force-deleting deployments, statefulsets, jobs, pods, PVCs..."
    kubectl delete deploy,sts,job --all -n "$NAMESPACE" --force --grace-period=0 2>/dev/null || true
    kubectl delete pod --all -n "$NAMESPACE" --force --grace-period=0 2>/dev/null || true
    for pvc in $(kubectl get pvc -n "$NAMESPACE" -o name 2>/dev/null); do
      kubectl patch "$pvc" -n "$NAMESPACE" -p '{"metadata":{"finalizers":null}}' 2>/dev/null || true
      kubectl delete "$pvc" -n "$NAMESPACE" --force --grace-period=0 2>/dev/null || true
    done

    info "Deleting namespace $NAMESPACE..."
    kubectl delete namespace "$NAMESPACE" --force --grace-period=0 --wait=false 2>/dev/null || true
    # Clear spec.finalizers via raw API (actual blocker for stuck namespaces)
    kubectl get namespace "$NAMESPACE" -o json 2>/dev/null | \
      jq '.spec.finalizers = []' 2>/dev/null | \
      kubectl replace --raw "/api/v1/namespaces/$NAMESPACE/finalize" -f - 2>/dev/null || true
    # Wait briefly for it to disappear
    for i in $(seq 1 15); do
      kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || break
      sleep 1
    done
    ok "Namespace deleted"
  else
    info "Namespace $NAMESPACE does not exist — nothing to delete"
  fi

  # 1c. Drop Cloud SQL databases (via cloud-sql-proxy + psql)
  info "Dropping Cloud SQL databases if present..."
  drop_cloud_sql_dbs
}

drop_cloud_sql_dbs() {
  MM_DB_PASS=$(gcloud secrets versions access latest --secret="$MM_DB_PASSWORD_SECRET" --project="$CLOUDSQL_PROJECT" 2>/dev/null || echo "")
  GITEA_DB_PASS=$(gcloud secrets versions access latest --secret="$GITEA_DB_PASSWORD_SECRET" --project="$CLOUDSQL_PROJECT" 2>/dev/null || echo "")
  [[ -z "$MM_DB_PASS" || -z "$GITEA_DB_PASS" ]] && {
    warn "Could not read DB passwords from Secret Manager — skipping DB drop"
    return
  }

  PROXY_BIN=$(command -v cloud-sql-proxy 2>/dev/null || ls /opt/homebrew/bin/cloud-sql-proxy 2>/dev/null || echo "")
  [[ -z "$PROXY_BIN" ]] && { warn "cloud-sql-proxy not found — skipping DB drop"; return; }

  "$PROXY_BIN" "$TARGET_CLOUD_SQL_CONNECTION" --port=5434 &
  PROXY_PID=$!
  sleep 4
  trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT

  PGPASSWORD=$MM_DB_PASS psql -h 127.0.0.1 -p 5434 -U mattermost -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$MM_DB_NAME';" >/dev/null 2>&1 || true
  PGPASSWORD=$MM_DB_PASS psql -h 127.0.0.1 -p 5434 -U mattermost -d postgres \
    -c "DROP DATABASE IF EXISTS $MM_DB_NAME;" >/dev/null 2>&1 && ok "Dropped DB: $MM_DB_NAME" || warn "DB drop failed: $MM_DB_NAME"

  PGPASSWORD=$GITEA_DB_PASS psql -h 127.0.0.1 -p 5434 -U gitea -d postgres \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$GITEA_DB_NAME';" >/dev/null 2>&1 || true
  PGPASSWORD=$GITEA_DB_PASS psql -h 127.0.0.1 -p 5434 -U gitea -d postgres \
    -c "DROP DATABASE IF EXISTS $GITEA_DB_NAME;" >/dev/null 2>&1 && ok "Dropped DB: $GITEA_DB_NAME" || warn "DB drop failed: $GITEA_DB_NAME"

  kill "$PROXY_PID" 2>/dev/null || true
  trap - EXIT
}

# ── Destroy ────────────────────────────────────────────────────────────────
destroy_namespace

# Clean up rendered values file + terraform state for this namespace on destroy
if $DESTROY_ONLY; then
  step "Cleaning up rendered config"
  [[ -f "$VALUES_OUT" ]] && rm -f "$VALUES_OUT" && ok "Removed $VALUES_OUT"
  info "Terraform state prefix 'custom/$NAMESPACE' is preserved (run 'terraform destroy' if you want it gone)"
  echo ""
  echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}  Namespace destroyed — ${NAMESPACE}${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
  exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 2: PROVISION fresh state
# ═══════════════════════════════════════════════════════════════════════════

# ── 2a. Terraform: create Cloud SQL databases ──────────────────────────────
if $SKIP_TERRAFORM; then
  step "Phase 2a: Skipping Terraform (--skip-terraform) — creating DBs via gcloud"
  PROXY_BIN=$(command -v cloud-sql-proxy 2>/dev/null || ls /opt/homebrew/bin/cloud-sql-proxy 2>/dev/null || echo "")
  MM_DB_PASS=$(gcloud secrets versions access latest --secret="$MM_DB_PASSWORD_SECRET" --project="$CLOUDSQL_PROJECT")
  GITEA_DB_PASS=$(gcloud secrets versions access latest --secret="$GITEA_DB_PASSWORD_SECRET" --project="$CLOUDSQL_PROJECT")
  "$PROXY_BIN" "$TARGET_CLOUD_SQL_CONNECTION" --port=5434 &
  PROXY_PID=$!
  sleep 4
  trap 'kill "$PROXY_PID" 2>/dev/null || true' EXIT
  PGPASSWORD=$MM_DB_PASS psql -h 127.0.0.1 -p 5434 -U mattermost -d postgres \
    -c "CREATE DATABASE $MM_DB_NAME;" >/dev/null 2>&1 && ok "Created DB: $MM_DB_NAME" || warn "DB already exists: $MM_DB_NAME"
  PGPASSWORD=$GITEA_DB_PASS psql -h 127.0.0.1 -p 5434 -U gitea -d postgres \
    -c "CREATE DATABASE $GITEA_DB_NAME;" >/dev/null 2>&1 && ok "Created DB: $GITEA_DB_NAME" || warn "DB already exists: $GITEA_DB_NAME"
  kill "$PROXY_PID" 2>/dev/null || true
  trap - EXIT
else
  step "Phase 2a: Terraform — provisioning Cloud SQL databases"
  (
    cd "$TF_DIR"
    info "terraform init (backend prefix: custom/$NAMESPACE)..."
    terraform init -reconfigure -backend-config="prefix=custom/$NAMESPACE" -input=false
    info "terraform apply -var=namespace=$NAMESPACE -var=region=$TARGET_REGION -var=cloudsql_project_id=$TARGET_CLOUD_SQL_PROJECT..."
    terraform apply \
      -var="namespace=$NAMESPACE" \
      -var="region=$TARGET_REGION" \
      -var="cloudsql_project_id=$TARGET_CLOUD_SQL_PROJECT" \
      -var="cloudsql_instance_name=$TARGET_CLOUD_SQL_INSTANCE" \
      -auto-approve \
      -input=false
  )
  ok "Terraform apply complete"
fi

# ── 2b. Create K8s namespace ───────────────────────────────────────────────
step "Phase 2b: Creating K8s namespace"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
ok "Namespace $NAMESPACE ready"

# ── 2c. Render helm values from template ───────────────────────────────────
step "Phase 2c: Rendering helm values"
[[ -f "$VALUES_TPL" ]] || fail "Values template missing: $VALUES_TPL"
sed -e "s|__NAMESPACE__|$NAMESPACE|g" \
    -e "s|__DB_SLUG__|$DB_SLUG|g" \
    -e "s|__TARGET_ID__|$TARGET_ID|g" \
    -e "s|__FIREBASE_PROJECT__|$TARGET_FIREBASE_PROJECT|g" \
    -e "s|__AR_REPOSITORY__|$TARGET_AR_REPOSITORY|g" \
    -e "s|__CLOUD_SQL_CONNECTION__|$TARGET_CLOUD_SQL_CONNECTION|g" \
    -e "s|__KMS_KEY_NAME__|$TARGET_KMS_KEY_NAME|g" \
    -e "s|__AGENT_STORE_POSTGRES_CIDR__|$AGENT_STORE_POSTGRES_CIDR|g" \
    -e "s|__CLUSTER_PROJECT__|$TARGET_CLUSTER_PROJECT|g" \
    -e "s|__HOSTING_PROJECT__|$TARGET_HOSTING_PROJECT|g" \
    -e "s|__SITE_ORIGIN__|$TARGET_SITE_ORIGIN|g" \
    -e "s|__APP_ORIGIN__|$TARGET_APP_ORIGIN|g" \
    "$VALUES_TPL" > "$VALUES_OUT"
ok "Rendered: $VALUES_OUT"

# ── 2d. Pre-create env file so setup-secrets can load it ───────────────────
ENV_FILE="$REPO_DIR/.env.$NAMESPACE"
touch "$ENV_FILE"
# Seed with values pulled from .env.test (shared app secrets)
if [[ -f "$REPO_DIR/.env.test" ]]; then
  # Copy anything that isn't MM_* or GIT_* — those are bootstrap-specific
  grep -vE '^(MM_|GIT_API_TOKEN)' "$REPO_DIR/.env.test" > "$ENV_FILE" 2>/dev/null || true
  ok "Seeded $ENV_FILE from .env.test (shared app secrets)"
fi

# ── 2e. Materialize K8s secrets ────────────────────────────────────────────
step "Phase 2d: Materializing K8s secrets"
"$SCRIPT_DIR/setup-secrets.sh" --env=custom --namespace="$NAMESPACE" --yes --deployment-target="$TARGET_ID" --phase=bootstrap

# ── 2f. Helm install ───────────────────────────────────────────────────────
step "Phase 2e: Helm install"
GITEA_DB_PASS=$(gcloud secrets versions access latest --secret="$GITEA_DB_PASSWORD_SECRET" --project="$CLOUDSQL_PROJECT")
UMBRELLA_CHART_DIR="$(mktemp -d)"
UMBRELLA_CHART="$("$SCRIPT_DIR/package-umbrella-chart.sh" --output-dir "$UMBRELLA_CHART_DIR")"
helm upgrade --install octogee "$UMBRELLA_CHART" \
  --server-side=true --force-conflicts \
  -f "$VALUES_OUT" \
  -f <(printf '%s' "$RELEASE_VALUES") \
  -n "$NAMESPACE" \
  --set "gitea.gitea.config.database.PASSWD=$GITEA_DB_PASS" \
  --kube-context "$K8S_CONTEXT" \
  --wait --timeout=10m
ok "Helm install complete"

# ── 2g. Bootstrap Mattermost ───────────────────────────────────────────────
step "Phase 2f: Bootstrapping Mattermost (admin, team, bot, PAT)"
"$SCRIPT_DIR/setup-mattermost.sh" --env=custom --namespace="$NAMESPACE" --yes --deployment-target="$TARGET_ID"

# ── 2h. Bootstrap Gitea ────────────────────────────────────────────────────
step "Phase 2g: Bootstrapping Gitea (org + API token)"
"$SCRIPT_DIR/setup-gitea.sh" --env=custom --namespace="$NAMESPACE" --yes --deployment-target="$TARGET_ID"

info "Re-materializing K8s secrets with fresh Mattermost and Gitea tokens..."
"$SCRIPT_DIR/setup-secrets.sh" --env=custom --namespace="$NAMESPACE" --yes --deployment-target="$TARGET_ID" --phase=launch

# ── 2i. Restart everything to pick up final secrets ────────────────────────
step "Phase 2h: Rolling restart"
kubectl rollout restart deploy -n "$NAMESPACE" --context "$K8S_CONTEXT"
kubectl rollout status deploy/octogee-gateway -n "$NAMESPACE" --context "$K8S_CONTEXT" --timeout=180s || warn "Gateway rollout did not fully complete — check logs"

# ── 2j. Verify ─────────────────────────────────────────────────────────────
step "Phase 2i: Verification"
kubectl get pods -n "$NAMESPACE" --context "$K8S_CONTEXT"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Namespace provisioned — ${NAMESPACE}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo "  Internal access (no public ingress):"
echo "    kubectl port-forward -n $NAMESPACE svc/gateway-edge 3001:3001"
echo "    kubectl port-forward -n $NAMESPACE svc/mattermost 8065:8065"
echo "    kubectl port-forward -n $NAMESPACE svc/octogee-gitea-http 3000:3000"
echo ""
echo "  Logs:"
echo "    kubectl logs -n $NAMESPACE deploy/octogee-gateway -f"
echo ""
echo "  Teardown (fully destroy this namespace):"
echo "    $0 --destroy $NAMESPACE"
echo ""
echo "  Env file: .env.$NAMESPACE"
echo "  Values:   charts/octogee/values.$NAMESPACE.yaml"
echo ""
