#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Octogee Environment Teardown
# ═══════════════════════════════════════════════════════════════════════════
#
# Uninstalls the umbrella helm release AND every per-instance gateway
# helm release (octogee-gw-*) the fleet controller provisioned. Leaving the per-instance
# releases behind made the fleet controller re-register them on the next install via
# bootstrapGlmGateways with whatever stale image tag was last deployed.
#
# Default teardown preserves PVCs. Full teardown deletes the two durable
# application PVCs together with its other clean-slate data boundaries.
#
# Default (no flags): `helm uninstall` and nothing else.
#   Preserves: all PVCs, K8s secrets, namespace, Secret Manager, Cloud SQL,
#              Firestore, Functions, Auth.
#
# --full: also drops the per-env Cloud SQL databases, wipes Firebase Storage
#         and Firestore collections, deletes per-env Cloud Functions (chat
#         proxy preserved), Firebase Auth users, durable application PVCs,
#         dynamic per-gateway K8s ServiceAccounts/auth/model-key secrets, and
#         Gitea API token material invalidated by the database reset.
#         Still preserves: platform/static K8s secrets and namespace.
#
# Does NOT delete (ever): GCP projects, GKE clusters, AR repos,
#   Firebase projects, GCP Service Accounts, IAM bindings,
#   platform/static K8s secrets, any Secret Manager infra entry, the namespace itself.
# To rotate a secret, use scripts/rotate-secret.sh.
#
# Usage:
#   ./scripts/teardown-env.sh --env=test           # Helm uninstall only
#   ./scripts/teardown-env.sh --env=test --yes     # Non-interactive (test only)
#   ./scripts/teardown-env.sh --env=test --full    # Full clean slate (DB wipe)
#   ./scripts/teardown-env.sh --env=prod           # Prod (interactive, requires "DESTROY PROD")
# ═══════════════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"
# shellcheck source=scripts/lib/env-extensions.sh
source "$SCRIPT_DIR/lib/env-extensions.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

ENV="prod"
DEPLOYMENT_TARGET=""
FORCE=false
FULL=false
RESUME=false
PROXY_PID=""
PRIVATE_SQL_OWNER_RESET_DONE=false
GATEWAY_RUNTIME_CLEANUP_DONE=false

for arg in "$@"; do
  case $arg in
    --env=*)        ENV="${arg#*=}" ;;
    --deployment-target=*) DEPLOYMENT_TARGET="${arg#*=}" ;;
    --force|--yes|-y) FORCE=true ;;
    --full)         FULL=true ;;
    --resume)       RESUME=true ;;
    --help|-h)
      echo "Usage: $0 [--env=prod|test] [--deployment-target=TARGET] [--force|--yes] [--full [--resume]]"
      echo ""
      echo "  (default)  helm uninstall only — preserves PVCs, K8s secrets,"
      echo "             namespace, Secret Manager, Cloud SQL, Firebase Storage, Firestore, Auth"
      echo "  --full     Also drops Cloud SQL DBs + wipes Firebase Storage, Firestore + Cloud"
      echo "             Functions + Auth users + deletes durable PVCs."
      echo "             Still preserves platform/static K8s secrets, Secret Manager infra entries,"
      echo "             and namespace; removes dynamic per-gateway identities/secrets and"
      echo "             database-bound Gitea API token material."
      echo ""
      echo "  --resume   With --full: finish a full teardown whose earlier run already reset the"
      echo "             private Cloud SQL databases and removed Mattermost and Gitea."
      echo ""
      echo "  To rotate a secret: scripts/rotate-secret.sh"
      exit 0
      ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

case "$ENV" in
  prod|test)
    if [[ -n "$DEPLOYMENT_TARGET" ]]; then
      octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"
      [[ "$TARGET_ENVIRONMENT" == "$ENV" ]] || {
        echo "Deployment target '$DEPLOYMENT_TARGET' does not belong to environment '$ENV'"
        exit 1
      }
    else
      octogee_load_deployment_target "--environment=$ENV"
    fi
    ;;
  *) echo "Unknown environment: $ENV (use prod or test)"; exit 1 ;;
esac
if $RESUME && ! $FULL; then
  echo "--resume only applies to --full"
  exit 1
fi
GCP_PROJECT="$TARGET_FIREBASE_PROJECT"
FIREBASE_PROJECT="$TARGET_FIREBASE_PROJECT"
CLUSTER_PROJECT="$TARGET_CLUSTER_PROJECT"
CLUSTER_NAME="$TARGET_CLUSTER_NAME"
K8S_CONTEXT="$TARGET_KUBE_CONTEXT"
K8S_NAMESPACE="$TARGET_NAMESPACE"
REGION="$TARGET_REGION"
TARGET_ARG=" --deployment-target=$TARGET_ID"
GITEA_API_TOKEN_SM_KEY="gitea-api-token-${TARGET_SECRET_NAME_SUFFIX}"

case "$ENV" in
  prod)
    ENV_FILE="$REPO_DIR/.env"
    ENV_LABEL="🔴 PRODUCTION"
    MM_DB_NAME="mattermost_prod"
    GITEA_DB_NAME="gitea_prod"
    ;;
  test)
    ENV_FILE="$REPO_DIR/.env.test"
    ENV_LABEL="🟡 TEST"
    MM_DB_NAME="mattermost_test"
    GITEA_DB_NAME="gitea_test"
    ;;
  *)
    echo "Unknown environment: $ENV (use prod or test)"
    exit 1
    ;;
esac
case "$TARGET_ID" in
  prod-central|test-central) ;;
  *) ENV_FILE="$REPO_DIR/.env.$TARGET_ID" ;;
esac

ok()   { echo -e "  ${GREEN}✅ $1${NC}"; }
info() { echo -e "  ${BLUE}ℹ️  $1${NC}"; }
warn() { echo -e "  ${YELLOW}⚠️  $1${NC}"; }
die()  { echo -e "  ${RED}❌ $1${NC}" >&2; exit 1; }

confirm() {
  $FORCE && return 0
  if [[ "$ENV" == "test" ]]; then
    echo -ne "  ${YELLOW}$1 [Y/n]:${NC} "
    read -r yn
    [[ ! "$yn" =~ ^[Nn]$ ]]
  else
    echo -ne "  ${YELLOW}$1 [y/N]:${NC} "
    read -r yn
    [[ "$yn" =~ ^[Yy]$ ]]
  fi
}

cleanup_proxy() {
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null || true
}
trap cleanup_proxy EXIT

# ── Banner ────────────────────────────────────────────────────────────────
echo ""
echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  ⚠️  Octogee Teardown — ${ENV_LABEL}${NC}"
echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Mode: ${BOLD}$(if $FULL; then echo "FULL (clean slate)"; else echo "Helm release only"; fi)${NC}"
echo ""
echo "  Will remove:"
echo "    • Helm release 'octogee' (gateway, gateway-edge, chat-proxy, MM + Gitea pods)"
if $FULL; then
  echo -e "  ${RED}  + Cloud SQL DBs: $MM_DB_NAME, $GITEA_DB_NAME (DROP DATABASE)${NC}"
  echo -e "  ${RED}  + PVCs: mattermost-data, gitea-shared-storage (Helm-recreated on rebuild)${NC}"
  echo -e "  ${RED}  + Firebase Storage objects (all)${NC}"
  echo -e "  ${RED}  + Firestore collections (all)${NC}"
  echo -e "  ${RED}  + Cloud Functions (chat proxy preserved)${NC}"
  echo -e "  ${RED}  + Firebase Auth users (all)${NC}"
  echo -e "  ${RED}  + Secret Manager: byok-* (per-user BYOK keys orphaned by Firestore wipe)${NC}"
  echo -e "  ${RED}  + Dynamic gateway K8s ServiceAccounts + auth/model-key secrets${NC}"
  echo -e "  ${RED}  + Gitea API token material (K8s + Secret Manager; invalid after DB reset)${NC}"
fi
echo ""
echo "  Will preserve:"
if $FULL; then
  echo "    • Platform/static K8s secrets in $K8S_NAMESPACE except database-bound gitea-token"
else
  echo "    • All K8s secrets in $K8S_NAMESPACE (rotate via scripts/rotate-secret.sh)"
fi
if ! $FULL; then
  echo "    • All PVCs (mattermost-data, gitea-shared-storage)"
fi
echo "    • Namespace: $K8S_NAMESPACE"
echo "    • Secret Manager: infra entries (DB passwords, API keys, tokens)"
echo "    • Cloud SQL instance ($TARGET_CLOUD_SQL_INSTANCE)"
echo "    • GCP projects, GKE cluster, AR repo"
echo "    • Firebase project, IAM, Service Accounts"
if ! $FULL; then
  echo "    • Cloud SQL data, Firestore, Functions (excl. chat proxy), Auth"
fi
echo ""

# ── Prod safety ───────────────────────────────────────────────────────────
if [[ "$ENV" == "prod" ]] && $FORCE; then
  echo -e "  ${RED}${BOLD}--force/--yes cannot be used with prod. Refusing.${NC}"
  exit 1
fi

if [[ "$ENV" == "prod" ]]; then
  echo -e "  ${RED}${BOLD}⚠️  YOU ARE ABOUT TO TEAR DOWN PRODUCTION${NC}"
  echo ""
  echo -ne "  ${RED}${BOLD}Type 'DESTROY PROD' to confirm:${NC} "
  read -r confirmation
  [[ "$confirmation" == "DESTROY PROD" ]] || { echo "  Cancelled."; exit 1; }
elif ! confirm "Proceed with $ENV teardown?"; then
  echo "  Cancelled."
  exit 0
fi

# ── Context guard ─────────────────────────────────────────────────────────
echo ""
info "Setting kubectl context..."
gcloud container clusters get-credentials "$CLUSTER_NAME" --region "$TARGET_REGION" --project "$CLUSTER_PROJECT" 2>/dev/null || true
kubectl config use-context "$K8S_CONTEXT" >/dev/null
CURRENT_CTX=$(kubectl config current-context)
[[ "$CURRENT_CTX" == "$K8S_CONTEXT" ]] || { echo -e "  ${RED}❌ Wrong context: $CURRENT_CTX${NC}"; exit 1; }
ok "kubectl context: $CURRENT_CTX"

load_env_extensions "$SCRIPT_DIR"
if $FULL; then
  run_env_hooks ${ENV_TEARDOWN_FULL_PREFLIGHT[@]+"${ENV_TEARDOWN_FULL_PREFLIGHT[@]}"}
  FIREBASE_STORAGE_BUCKET="gs://${FIREBASE_PROJECT}.firebasestorage.app"
  gcloud storage buckets describe "$FIREBASE_STORAGE_BUCKET" --project="$TARGET_STORAGE_PROJECT" >/dev/null \
    || die "Firebase Storage preflight failed for $FIREBASE_STORAGE_BUCKET; nothing has been torn down"
  firebase firestore:databases:get "(default)" --project "$FIREBASE_PROJECT" >/dev/null \
    || die "Firebase CLI preflight failed for $FIREBASE_PROJECT (try 'firebase login --reauth'); nothing has been torn down"
fi

# ── 1a. Full: delete PVCs ────────────────────────────────────────────────
# Pre-customer / F&F discipline: --full already drops Cloud SQL DBs and
# wipes Firestore — there is no "data-preservation" contract to honor at
# this stage. The previous wipe-ceremony tried to surgically wipe the
# octogee/ org subtree on the Gitea PVC to avoid PVC/DB drift, but it
# only handled the Gitea-as-statefulset shape (PROD runs Gitea as a
# Deployment, no statefulset selector match → ephemeral-pod fallback →
# RWO Multi-Attach failure when the Deployment pod still held the PVC).
#
# Cleaner: delete the PVCs. Helm install on rebuild auto-recreates fresh
# ones from the chart manifests. --wait=false so the delete returns
# immediately; PVCs enter Terminating until the Helm uninstall (next
# step) drains the pods that hold them, at which point finalizers
# complete and the PVs (Delete reclaim policy on standard-rwo) are GC'd
# by GKE. Re-introduce preservation when F&F users have data on disk.
inspect_pvc() {
  local pvc="$1"
  local output
  if ! output=$(kubectl get pvc "$pvc" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
      --ignore-not-found -o name 2>&1); then
    [[ -n "$output" ]] && echo "$output" >&2
    die "could not inspect PVC $pvc"
  fi
  PVC_INSPECTION="$output"
}

if $FULL; then
  echo ""
  info "Deleting PVCs (Helm-recreated on rebuild)..."
  for pvc in gitea-shared-storage mattermost-data; do
    inspect_pvc "$pvc"
    if [[ -n "$PVC_INSPECTION" ]]; then
      kubectl delete pvc "$pvc" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
        --wait=false >/dev/null 2>&1 \
        || die "delete request failed for PVC $pvc"
      ok "PVC $pvc deletion requested (will finalize after Helm uninstall)"
    else
      info "PVC $pvc not present — already gone"
    fi
  done
fi

database_exists() {
  local dbname="$1" stderr_file rc
  stderr_file=$(mktemp)
  gcloud sql databases describe "$dbname" --instance="$TARGET_CLOUD_SQL_INSTANCE" \
    --project="$TARGET_CLOUD_SQL_PROJECT" --format='value(name)' >/dev/null 2>"$stderr_file"
  rc=$?
  if [[ $rc -eq 0 ]]; then
    rm -f "$stderr_file"
    return 0
  fi
  if grep -qE "NOT_FOUND|was not found|does not exist" "$stderr_file"; then
    rm -f "$stderr_file"
    return 1
  fi
  echo -e "  ${RED}❌ Cloud SQL Admin API describe failed for $dbname:${NC}" >&2
  sed 's/^/      /' "$stderr_file" >&2
  rm -f "$stderr_file"
  return 2
}

verify_database_through_api() {
  local dbname="$1" verified_name
  verified_name="$(gcloud sql databases describe "$dbname" --instance="$TARGET_CLOUD_SQL_INSTANCE" \
    --project="$TARGET_CLOUD_SQL_PROJECT" --format='value(name)')" \
    || die "Cloud SQL Admin API verification failed for $dbname"
  [[ "$verified_name" == "$dbname" ]] \
    || die "Cloud SQL Admin API verification returned '$verified_name' for $dbname"
  ok "$dbname — Cloud SQL API confirmed the app-owned recreated database"
}

private_sql_writers_absent() {
  local selector resources
  for selector in 'app=mattermost' 'app.kubernetes.io/name=gitea'; do
    resources=$(kubectl get deployment,statefulset -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
      -l "$selector" -o name) \
      || die "could not inspect SQL writer workloads ($selector) before private Cloud SQL reset"
    [[ -z "$resources" ]] || return 1
  done
  return 0
}

quiesce_private_sql_writers() {
  local writer selector resources resource pods
  for writer_selector in \
    'mattermost:app=mattermost' \
    'gitea:app.kubernetes.io/name=gitea'; do
    writer="${writer_selector%%:*}"
    selector="${writer_selector#*:}"
    resources=$(kubectl get deployment,statefulset -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
      -l "$selector" -o name) \
      || die "could not inspect SQL writer workloads ($selector) before private Cloud SQL reset"
    [[ -n "$resources" ]] \
      || die "no SQL writer workload matched $writer ($selector) before private Cloud SQL reset"
    while IFS= read -r resource; do
      [[ -n "$resource" ]] || continue
      case "$resource" in
        deployment.apps/*) resource="deployment/${resource#deployment.apps/}" ;;
        deployment/*) ;;
        statefulset.apps/*) resource="statefulset/${resource#statefulset.apps/}" ;;
        statefulset/*) ;;
        *) die "SQL writer workload has an unsupported resource reference: $resource" ;;
      esac
      kubectl scale "$resource" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" --replicas=0 \
        || die "could not quiesce SQL writer $resource before private Cloud SQL reset"
    done <<<"$resources"
    pods=$(kubectl get pods -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" -l "$selector" -o name) \
      || die "could not inspect SQL writer pods ($selector) before private Cloud SQL reset"
    if [[ -n "$pods" ]]; then
      kubectl wait --for=delete -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
        -l "$selector" pod --timeout=120s \
        || die "SQL writer pods ($selector) did not terminate before private Cloud SQL reset"
    fi
  done
}

run_private_sql_owner_job() {
  local service="$1" dbname="$2" owner="$3" secret_name="$4" secret_key="$5"
  local job_name logs observed_owner
  job_name="octogee-sql-reset-${service}-${RANDOM}${RANDOM}"

  kubectl get serviceaccount octogee-api -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
    -o jsonpath='{.metadata.annotations.iam\.gke\.io/gcp-service-account}' | grep -q . \
    || die "target KSA octogee-api has no Workload Identity credential for private Cloud SQL reset"

  cat <<YAML | kubectl apply -f - --context "$K8S_CONTEXT" >/dev/null \
    || die "could not create private Cloud SQL owner reset job for $dbname"
apiVersion: batch/v1
kind: Job
metadata:
  name: ${job_name}
  namespace: ${K8S_NAMESPACE}
  labels:
    app: cloud-sql-proxy
    octogee.ai/reset: private-sql-owner
    octogee.ai/deployment-target: ${TARGET_ID}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        app: cloud-sql-proxy
        octogee.ai/reset: private-sql-owner
    spec:
      serviceAccountName: octogee-api
      automountServiceAccountToken: true
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      volumes:
        - name: tmp
          emptyDir: {}
      initContainers:
        - name: cloud-sql-proxy
          image: gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.27.0@sha256:7d156a5c466e31596afd6c8ed134f19c207a297418392fdad2686524ca4e7a3c
          restartPolicy: Always
          args:
            - --private-ip
            - --address=127.0.0.1
            - --port=5432
            - ${TARGET_CLOUD_SQL_CONNECTION}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
          volumeMounts:
            - name: tmp
              mountPath: /tmp
      containers:
        - name: reset-owner
          image: postgres:16.14-alpine3.24@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
          command: ["/bin/sh", "-ceu"]
          args:
            - |
              for attempt in \$(seq 1 60); do
                if pg_isready -h 127.0.0.1 -p 5432 -U "\$PGUSER" -d postgres >/dev/null 2>&1; then break; fi
                if [ "\$attempt" = 60 ]; then echo "Cloud SQL proxy did not become ready" >&2; exit 1; fi
                sleep 1
              done
              database='${dbname}'
              owner="\$(
                printf '%s\\n' "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = :'database';" |
                  psql -X -q -h 127.0.0.1 -p 5432 -U "\$PGUSER" -d postgres -v ON_ERROR_STOP=1 -At -v database="\$database"
              )"
              case "\$owner" in
                '')
                  printf '%s\\n' 'CREATE DATABASE :"database";' |
                    psql -X -q -h 127.0.0.1 -p 5432 -U "\$PGUSER" -d postgres -v ON_ERROR_STOP=1 -v database="\$database"
                  owner='${owner}'
                  ;;
                '${owner}')
                  printf '%s\\n' "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'database' AND pid <> pg_backend_pid();" |
                    psql -X -q -h 127.0.0.1 -p 5432 -U "\$PGUSER" -d postgres -v ON_ERROR_STOP=1 -v database="\$database"
                  printf '%s\\n' 'DROP DATABASE :"database";' |
                    psql -X -q -h 127.0.0.1 -p 5432 -U "\$PGUSER" -d postgres -v ON_ERROR_STOP=1 -v database="\$database"
                  printf '%s\\n' 'CREATE DATABASE :"database";' |
                    psql -X -q -h 127.0.0.1 -p 5432 -U "\$PGUSER" -d postgres -v ON_ERROR_STOP=1 -v database="\$database"
                  ;;
                cloudsqlsuperuser) ;;
                *) echo "Unexpected owner for ${dbname}: \$owner" >&2; exit 1 ;;
              esac
              printf 'OCTOGEE_DATABASE_OWNER=%s\\n' "\$owner"
              if [ "\$owner" = cloudsqlsuperuser ]; then exit 0; fi
              tables="\$(psql -X -q -h 127.0.0.1 -p 5432 -U "\$PGUSER" -d "${dbname}" -v ON_ERROR_STOP=1 -At -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")"
              [ "\$tables" = 0 ] || { echo "Recreated database ${dbname} is not empty (tables=\$tables)" >&2; exit 1; }
          env:
            - name: PGUSER
              value: ${owner}
            - name: PGPASSWORD
              valueFrom:
                secretKeyRef:
                  name: ${secret_name}
                  key: ${secret_key}
          securityContext:
            runAsNonRoot: true
            runAsUser: 70
            runAsGroup: 70
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 250m
              memory: 256Mi
          volumeMounts:
            - name: tmp
              mountPath: /tmp
YAML

  if ! kubectl wait --for=condition=complete "job/$job_name" -n "$K8S_NAMESPACE" \
      --context "$K8S_CONTEXT" --timeout=180s >/dev/null; then
    kubectl logs "job/$job_name" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" --all-containers=true >&2 || true
    kubectl delete job "$job_name" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" --wait=true >/dev/null 2>&1 || true
    die "private Cloud SQL owner reset job failed for $dbname"
  fi
  if ! logs=$(kubectl logs "job/$job_name" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" -c reset-owner); then
    kubectl delete job "$job_name" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" --wait=true >/dev/null 2>&1 || true
    die "could not read private Cloud SQL owner reset job output for $dbname"
  fi
  kubectl delete job "$job_name" -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" --wait=true >/dev/null \
    || die "could not clean up private Cloud SQL owner reset job for $dbname"
  observed_owner=$(printf '%s\n' "$logs" | sed -n 's/^OCTOGEE_DATABASE_OWNER=//p')
  [[ "$(printf '%s\n' "$observed_owner" | sed '/^$/d' | wc -l | tr -d ' ')" == 1 ]] \
    || die "private Cloud SQL owner reset job returned an invalid owner record for $dbname"
  [[ "$observed_owner" == "$owner" || "$observed_owner" == cloudsqlsuperuser ]] \
    || die "private Cloud SQL owner reset job returned unexpected owner '$observed_owner' for $dbname"
  printf '%s' "$observed_owner"
}

remove_gitea_database_credentials() {
  local inspection secret_manager_stderr

  kubectl delete secret gitea-token -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
    --ignore-not-found=true --wait=true >/dev/null \
    || die "could not delete database-bound Kubernetes secret gitea-token"
  inspection=$(kubectl get secret gitea-token -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
    --ignore-not-found -o name) \
    || die "could not verify database-bound Kubernetes secret gitea-token removal"
  [[ -z "$inspection" ]] \
    || die "database-bound Kubernetes secret gitea-token remains after cleanup"

  secret_manager_stderr=$(mktemp)
  if gcloud secrets describe "$GITEA_API_TOKEN_SM_KEY" --project="$TARGET_CLOUD_SQL_PROJECT" \
      --format='value(name)' >/dev/null 2>"$secret_manager_stderr"; then
    gcloud secrets delete "$GITEA_API_TOKEN_SM_KEY" --project="$TARGET_CLOUD_SQL_PROJECT" --quiet \
      || die "could not delete database-bound Secret Manager token $GITEA_API_TOKEN_SM_KEY"
  elif ! grep -qE "NOT_FOUND|was not found|does not exist" "$secret_manager_stderr"; then
    sed 's/^/      /' "$secret_manager_stderr" >&2
    rm -f "$secret_manager_stderr"
    die "could not inspect database-bound Secret Manager token $GITEA_API_TOKEN_SM_KEY"
  fi

  if gcloud secrets describe "$GITEA_API_TOKEN_SM_KEY" --project="$TARGET_CLOUD_SQL_PROJECT" \
      --format='value(name)' >/dev/null 2>"$secret_manager_stderr"; then
    rm -f "$secret_manager_stderr"
    die "database-bound Secret Manager token $GITEA_API_TOKEN_SM_KEY remains after cleanup"
  elif ! grep -qE "NOT_FOUND|was not found|does not exist" "$secret_manager_stderr"; then
    sed 's/^/      /' "$secret_manager_stderr" >&2
    rm -f "$secret_manager_stderr"
    die "could not verify database-bound Secret Manager token $GITEA_API_TOKEN_SM_KEY removal"
  fi
  rm -f "$secret_manager_stderr"
  ok "Database-bound Gitea token material confirmed absent"
}

reset_private_cloud_sql_databases() {
  local dbname owner secret_name secret_key observed_owner exists_rc
  quiesce_private_sql_writers
  for dbname in "$MM_DB_NAME" "$GITEA_DB_NAME"; do
    case "$dbname" in
      "$MM_DB_NAME") owner=mattermost; secret_name=mattermost-cloud-sql; secret_key=password ;;
      "$GITEA_DB_NAME")
        info "Deleting Gitea token material invalidated by the database reset..."
        remove_gitea_database_credentials
        owner=gitea
        secret_name=gitea-credentials
        secret_key=db-password
        ;;
      *) die "no private Cloud SQL owner reset credential is configured for $dbname" ;;
    esac
    if database_exists "$dbname"; then
      :
    else
      exists_rc=$?
      [[ $exists_rc -eq 1 ]] || die "Cloud SQL Admin API could not inspect $dbname"
    fi
    observed_owner=$(run_private_sql_owner_job "$owner" "$dbname" "$owner" "$secret_name" "$secret_key")
    if [[ "$observed_owner" == cloudsqlsuperuser ]]; then
      gcloud sql databases delete "$dbname" --instance="$TARGET_CLOUD_SQL_INSTANCE" \
        --project="$TARGET_CLOUD_SQL_PROJECT" --quiet \
        || die "Cloud SQL Admin API delete failed for API-owned $dbname"
      observed_owner=$(run_private_sql_owner_job "$owner" "$dbname" "$owner" "$secret_name" "$secret_key")
    fi
    [[ "$observed_owner" == "$owner" ]] \
      || die "private Cloud SQL owner reset did not recreate $dbname under $owner"
    verify_database_through_api "$dbname"
  done
}

verify_durable_pvcs_absent() {
  local pvc
  for pvc in gitea-shared-storage mattermost-data; do
    inspect_pvc "$pvc"
    if [[ -n "$PVC_INSPECTION" ]]; then
      kubectl wait --for=delete "pvc/$pvc" -n "$K8S_NAMESPACE" \
        --context "$K8S_CONTEXT" --timeout=120s >/dev/null 2>&1 \
        || die "PVC $pvc did not finalize"
    fi
    inspect_pvc "$pvc"
    if [[ -n "$PVC_INSPECTION" ]]; then
      die "PVC $pvc still exists after deletion wait"
    fi
  done
  ok "Durable PVCs confirmed absent"
}

inspect_namespace_resource_names() {
  local resource_type="$1" description="$2" output
  if ! output=$(kubectl get "$resource_type" -n "$K8S_NAMESPACE" \
      --context "$K8S_CONTEXT" \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>&1); then
    [[ -n "$output" ]] && echo "$output" >&2
    die "could not inspect $description"
  fi
  NAMESPACE_RESOURCE_NAMES="$output"
}

select_dynamic_gateway_service_accounts() {
  local name
  while IFS= read -r name; do
    case "$name" in
      octogee-gw-?*) printf '%s\n' "$name" ;;
    esac
  done <<<"$1"
}

select_per_gateway_runtime_secrets() {
  local name
  while IFS= read -r name; do
    case "$name" in
      gateway-auth-token-?*) printf '%s\n' "$name" ;;
      gateway-model-key-issuer) ;;
      gateway-model-key-?*) printf '%s\n' "$name" ;;
    esac
  done <<<"$1"
}

delete_dynamic_gateway_resources() {
  local resource_type="$1" description="$2" names="$3" name
  if [[ -z "$names" ]]; then
    info "No $description to delete"
    return
  fi
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    kubectl delete "$resource_type" "$name" -n "$K8S_NAMESPACE" \
      --context "$K8S_CONTEXT" --wait=true >/dev/null \
      || die "could not delete $description $name"
    ok "Deleted $description $name"
  done <<<"$names"
}

cleanup_dynamic_gateway_runtime_identities() {
  local service_accounts secrets residual
  inspect_namespace_resource_names serviceaccounts "dynamic gateway ServiceAccounts"
  service_accounts="$(select_dynamic_gateway_service_accounts "$NAMESPACE_RESOURCE_NAMES")"
  delete_dynamic_gateway_resources serviceaccount "dynamic gateway ServiceAccount" "$service_accounts"

  inspect_namespace_resource_names secrets "per-gateway runtime Secrets"
  secrets="$(select_per_gateway_runtime_secrets "$NAMESPACE_RESOURCE_NAMES")"
  delete_dynamic_gateway_resources secret "per-gateway runtime Secret" "$secrets"

  inspect_namespace_resource_names serviceaccounts "dynamic gateway ServiceAccounts"
  residual="$(select_dynamic_gateway_service_accounts "$NAMESPACE_RESOURCE_NAMES")"
  [[ -z "$residual" ]] \
    || die "dynamic gateway ServiceAccounts remain after cleanup: $(printf '%s' "$residual" | tr '\n' ' ')"

  inspect_namespace_resource_names secrets "per-gateway runtime Secrets"
  residual="$(select_per_gateway_runtime_secrets "$NAMESPACE_RESOURCE_NAMES")"
  [[ -z "$residual" ]] \
    || die "per-gateway runtime Secrets remain after cleanup: $(printf '%s' "$residual" | tr '\n' ' ')"

  ok "Dynamic gateway runtime identities confirmed absent"
}

quiesce_gateway_controller() {
  local deployment pods
  if ! deployment=$(kubectl get deployment/glm-controller -n "$K8S_NAMESPACE" \
      --context "$K8S_CONTEXT" --ignore-not-found -o name 2>&1); then
    [[ -n "$deployment" ]] && echo "$deployment" >&2
    die "could not inspect glm-controller before full gateway cleanup"
  fi
  if [[ -n "$deployment" ]]; then
    kubectl scale deployment/glm-controller -n "$K8S_NAMESPACE" \
      --context "$K8S_CONTEXT" --replicas=0 \
      || die "could not quiesce glm-controller before full gateway cleanup"
  fi

  pods=$(kubectl get pods -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
    -l app=glm-controller -o name) \
    || die "could not inspect glm-controller pods before full gateway cleanup"
  if [[ -n "$pods" ]]; then
    kubectl wait --for=delete pod -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
      -l app=glm-controller --timeout=120s \
      || die "glm-controller pods did not terminate before full gateway cleanup"
  fi
  pods=$(kubectl get pods -n "$K8S_NAMESPACE" --context "$K8S_CONTEXT" \
    -l app=glm-controller -o name) \
    || die "could not verify glm-controller pod termination before full gateway cleanup"
  [[ -z "$pods" ]] \
    || die "glm-controller pods remain before full gateway cleanup: $(printf '%s' "$pods" | tr '\n' ' ')"
  ok "glm-controller quiesced before per-instance Helm removal"
}

HELM_RELEASE_LIST_PAGE_SIZE=256

inspect_per_instance_gateway_releases() {
  local offset=0 page page_count inventory=""
  while true; do
    if ! page=$(helm list -n "$K8S_NAMESPACE" --kube-context "$K8S_CONTEXT" -q \
        --filter '^octogee-gw-' \
        --max "$HELM_RELEASE_LIST_PAGE_SIZE" \
        --offset "$offset" 2>&1); then
      GATEWAY_HELM_LIST_ERROR="$page"
      return 1
    fi
    [[ -n "$page" ]] || break
    if [[ -n "$inventory" ]]; then
      inventory+=$'\n'
    fi
    inventory+="$page"
    page_count=$(printf '%s\n' "$page" | sed '/^$/d' | wc -l | tr -d ' ')
    offset=$((offset + page_count))
    [[ "$page_count" -eq "$HELM_RELEASE_LIST_PAGE_SIZE" ]] || break
  done
  GATEWAY_HELM_RELEASES="$inventory"
  GATEWAY_HELM_LIST_ERROR=""
}

uninstall_per_instance_gateways() {
  local timeout_flag="$1"
  local hook_flag="${2:-}"
  local releases residual
  if ! inspect_per_instance_gateway_releases; then
    [[ -n "$GATEWAY_HELM_LIST_ERROR" ]] && echo "$GATEWAY_HELM_LIST_ERROR" >&2
    if $FULL; then
      die "could not list per-instance gateway Helm releases"
    fi
    warn "Could not list per-instance gateway Helm releases — continuing ordinary Helm-only teardown"
    return
  fi
  releases="$GATEWAY_HELM_RELEASES"
  if [[ -z "$releases" ]]; then
    info "No per-instance gateway releases (octogee-gw-*) to uninstall"
  else
    while IFS= read -r rel; do
      [[ -z "$rel" ]] && continue
      info "Uninstalling per-instance gateway release: $rel"
      # shellcheck disable=SC2086
      if helm uninstall "$rel" -n "$K8S_NAMESPACE" --kube-context "$K8S_CONTEXT" \
          $hook_flag --wait --timeout="$timeout_flag" 2>&1; then
        ok "Uninstalled $rel"
      elif $FULL; then
        die "could not uninstall per-instance gateway release $rel"
      else
        warn "Failed to uninstall $rel — continuing ordinary Helm-only teardown"
      fi
    done <<<"$releases"
  fi

  if $FULL; then
    if ! inspect_per_instance_gateway_releases; then
      [[ -n "$GATEWAY_HELM_LIST_ERROR" ]] && echo "$GATEWAY_HELM_LIST_ERROR" >&2
      die "could not verify per-instance gateway Helm release removal"
    fi
    residual="$GATEWAY_HELM_RELEASES"
    [[ -z "$residual" ]] \
      || die "per-instance gateway Helm releases remain after uninstall: $(printf '%s' "$residual" | tr '\n' ' ')"
  fi
}

prepare_gateway_runtime_for_database_reset() {
  info "Quiescing glm-controller before per-instance Helm removal..."
  quiesce_gateway_controller
  if $FORCE && [[ "$ENV" == "test" ]]; then
    uninstall_per_instance_gateways 1m --no-hooks
  else
    uninstall_per_instance_gateways 2m
  fi
  info "Deleting dynamic gateway runtime identities retained outside Helm..."
  cleanup_dynamic_gateway_runtime_identities
  GATEWAY_RUNTIME_CLEANUP_DONE=true
}

if $FULL; then
  instance_ip_types="$(gcloud sql instances describe "$TARGET_CLOUD_SQL_INSTANCE" \
    --project="$TARGET_CLOUD_SQL_PROJECT" --format='value(ipAddresses.type)')" \
    || die "Cloud SQL instance inspection failed; refusing to classify a transport/config failure as a credential failure"
  if [[ "$instance_ip_types" != *"PRIMARY"* ]]; then
    prepare_gateway_runtime_for_database_reset
    if private_sql_writers_absent; then
      $RESUME || die "Mattermost and Gitea are not running in $K8S_NAMESPACE, so the private Cloud SQL reset cannot run. A full teardown resets both databases before it removes them; if an earlier run got that far, rerun with --resume to finish the remaining wipes."
      info "Resuming: an earlier full teardown reset the private Cloud SQL databases before removing Mattermost and Gitea"
    else
      $RESUME && die "--resume finishes a teardown whose Mattermost and Gitea are already gone, but they are still running in $K8S_NAMESPACE; rerun without --resume"
      info "Cloud SQL has no public IP; resetting application-owned databases through exact-target in-cluster credentials..."
      reset_private_cloud_sql_databases
    fi
    PRIVATE_SQL_OWNER_RESET_DONE=true
    ok "Private Cloud SQL owner reset completed before Helm uninstall"
  fi
fi

# ── 1. Helm uninstall + resource cleanup ─────────────────────────────────
echo ""
if $FULL && ! $GATEWAY_RUNTIME_CLEANUP_DONE; then
  info "Quiescing glm-controller before per-instance Helm removal..."
  quiesce_gateway_controller
fi
if $FORCE && [[ "$ENV" == "test" ]]; then
  # Fast path for test --yes: force-delete gateway/app resources. --full
  # has already requested deletion of the durable PVCs in step 1a.
  info "Fast teardown (test + --yes)..."
  if ! $GATEWAY_RUNTIME_CLEANUP_DONE; then
    uninstall_per_instance_gateways 1m --no-hooks
  fi
  helm uninstall octogee -n "$K8S_NAMESPACE" \
    --kube-context "$K8S_CONTEXT" --no-hooks --timeout=1m 2>/dev/null || true
  kubectl delete deploy,statefulset,job --all -n "$K8S_NAMESPACE" --force --grace-period=0 2>/dev/null || true
  kubectl delete pod --all -n "$K8S_NAMESPACE" --force --grace-period=0 2>/dev/null || true
  if $FULL; then
    ok "Fast teardown complete (PVCs deleted via step 1a; finalizers complete now that holders are gone)"
  else
    ok "Fast teardown complete (PVCs preserved)"
  fi
  FAST_DONE=true
else
  if ! $GATEWAY_RUNTIME_CLEANUP_DONE; then
    uninstall_per_instance_gateways 2m
  fi
  info "Uninstalling Helm release 'octogee'..."
  if helm status octogee -n "$K8S_NAMESPACE" \
      --kube-context "$K8S_CONTEXT" >/dev/null 2>&1; then
    helm uninstall octogee -n "$K8S_NAMESPACE" \
      --kube-context "$K8S_CONTEXT" \
      --wait --timeout=3m 2>&1
    ok "Helm release uninstalled"
  else
    warn "No Helm release found — skipping"
  fi

  # Wait for pods to terminate (PVCs can't delete while pods are running)
  info "Waiting for pods to terminate..."
  kubectl wait --for=delete pod --all -n "$K8S_NAMESPACE" \
    --timeout=90s 2>/dev/null || true
  ok "Pods terminated"

  echo ""
  if $FULL; then
    info "Durable PVC deletion requested; finalizers complete after Helm holders drain"
  else
    info "Preserving all PVCs"
  fi
fi

if $FULL; then
  echo ""
  if ! $GATEWAY_RUNTIME_CLEANUP_DONE; then
    info "Deleting dynamic gateway runtime identities retained outside Helm..."
    cleanup_dynamic_gateway_runtime_identities
  fi
  verify_durable_pvcs_absent
fi

if [[ "${FAST_DONE:-}" != "true" ]]; then
  echo ""
  if $FULL; then
    info "Preserving platform/static K8s secrets"
  else
    info "Preserving all K8s secrets"
  fi

  # ── 4. Namespace preserved ──────────────────────────────────────────────
  info "Preserving namespace: $K8S_NAMESPACE"
fi

# ── 5. Full: Cloud SQL DBs ────────────────────────────────────────────────
# 2026-05-14 incident: --full ran "successfully" on PROD + TEST but every DB
# still had data afterward. Two silent-failure paths existed: (a) gcloud
# read errors got swallowed by `|| echo ""`, then both passwords looked
# empty, then the script took the "fresh env, skipping DB drop" path with
# only a `warn`; (b) the `sleep 4` after launching cloud-sql-proxy didn't
# actually verify the proxy was up and pointed at the right instance.
#
# Hardening below:
#   * `sm_read` distinguishes "secret legitimately absent" (NOT_FOUND) from
#     "gcloud failed for some other reason" — only the former is allowed.
#   * The silent "fresh env" skip is gone. If --full is requested and either
#     password is missing, the script dies with explicit guidance.
#   * Private-only instances use the retained app credentials from the exact
#     target namespace to drop app-owned databases, then verify each API
#     recreation before any later environment cleanup.
#   * Public-IP instances verify the proxy listener and process, authenticate
#     both users, inventory the databases, and stop on every SQL error.
if $FULL; then
  echo ""
  info "Resetting Cloud SQL databases ($MM_DB_NAME, $GITEA_DB_NAME)..."

  if $PRIVATE_SQL_OWNER_RESET_DONE; then
    info "Private Cloud SQL databases were reset through exact-target owner credentials before Helm uninstall"
  else

  # ── 5a. Secret reads — fail loud on anything that isn't a clean NOT_FOUND.
  sm_read() {
    local secret_name="$1"
    local stderr_file
    stderr_file=$(mktemp)
    gcloud secrets versions access latest --secret="$secret_name" --project="$TARGET_CLOUD_SQL_PROJECT" 2>"$stderr_file"
    local rc=$?
    if [[ $rc -eq 0 ]]; then
      rm -f "$stderr_file"
      return 0
    fi
    if grep -qE "NOT_FOUND|was not found|does not exist" "$stderr_file" 2>/dev/null; then
      rm -f "$stderr_file"
      return 1  # legitimately absent — caller decides
    fi
    echo -e "  ${RED}❌ gcloud read failed for $secret_name (not a 404):${NC}" >&2
    sed 's/^/      /' "$stderr_file" >&2
    rm -f "$stderr_file"
    return 2
  }

  MM_DB_PASS=""
  MM_DB_PASS_STATUS="present"
  if MM_DB_PASS=$(sm_read "$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET"); then
    :
  else
    rc=$?
    if [[ $rc -eq 1 ]]; then
      MM_DB_PASS_STATUS="absent"
    else
      die "$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET read failed (gcloud auth or network). Fix and re-run."
    fi
  fi

  GITEA_DB_PASS=""
  GITEA_DB_PASS_STATUS="present"
  if GITEA_DB_PASS=$(sm_read "$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET"); then
    :
  else
    rc=$?
    if [[ $rc -eq 1 ]]; then
      GITEA_DB_PASS_STATUS="absent"
    else
      die "$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET read failed (gcloud auth or network). Fix and re-run."
    fi
  fi

  # 2026-05-14: removed the "both absent → fresh env, skip drop" path. If
  # --full was requested, the operator believes there is data to drop;
  # making the drop optional based on Secret Manager presence is what
  # caused both envs to silently retain stale data. If the operator wants
  # to skip the DB drop deliberately, they can leave off --full.
  if [[ "$MM_DB_PASS_STATUS" == "absent" || "$GITEA_DB_PASS_STATUS" == "absent" ]]; then
    echo ""
    echo -e "  ${RED}❌ Refusing to silently skip the DB drop.${NC}"
    echo "     MM_DB_PASSWORD:    $MM_DB_PASS_STATUS"
    echo "     gitea-db-password: $GITEA_DB_PASS_STATUS"
    echo ""
    echo "     Either: the DB is truly empty / never provisioned —"
    echo "             rerun WITHOUT --full to skip the DB section."
    echo "         Or: passwords were lost — restore via setup-cloud-sql.sh,"
    echo "             then re-run with --full."
    exit 1
  fi

  database_exists() {
    local dbname="$1" stderr_file rc
    stderr_file=$(mktemp)
    gcloud sql databases describe "$dbname" --instance="$TARGET_CLOUD_SQL_INSTANCE" \
      --project="$TARGET_CLOUD_SQL_PROJECT" --format='value(name)' >/dev/null 2>"$stderr_file"
    rc=$?
    if [[ $rc -eq 0 ]]; then
      rm -f "$stderr_file"
      return 0
    fi
    if grep -qE "NOT_FOUND|was not found|does not exist" "$stderr_file"; then
      rm -f "$stderr_file"
      return 1
    fi
    echo -e "  ${RED}❌ Cloud SQL Admin API describe failed for $dbname:${NC}" >&2
    sed 's/^/      /' "$stderr_file" >&2
    rm -f "$stderr_file"
    return 2
  }

  reset_database_through_api() {
    local dbname="$1" exists_rc recreated_name
    if database_exists "$dbname"; then
      info "Deleting $dbname through the Cloud SQL Admin API..."
      gcloud sql databases delete "$dbname" --instance="$TARGET_CLOUD_SQL_INSTANCE" \
        --project="$TARGET_CLOUD_SQL_PROJECT" --quiet \
        || die "Cloud SQL Admin API delete failed for $dbname"
    else
      exists_rc=$?
      [[ $exists_rc -eq 1 ]] || die "Cloud SQL Admin API could not inspect $dbname"
      info "$dbname is absent; creating its required fresh database through the Cloud SQL Admin API..."
    fi
    gcloud sql databases create "$dbname" --instance="$TARGET_CLOUD_SQL_INSTANCE" \
      --project="$TARGET_CLOUD_SQL_PROJECT" --quiet \
      || die "Cloud SQL Admin API create failed for $dbname"
    recreated_name="$(gcloud sql databases describe "$dbname" --instance="$TARGET_CLOUD_SQL_INSTANCE" \
      --project="$TARGET_CLOUD_SQL_PROJECT" --format='value(name)')" \
      || die "Cloud SQL Admin API verification failed for $dbname"
    [[ "$recreated_name" == "$dbname" ]] \
      || die "Cloud SQL Admin API verification returned '$recreated_name' for $dbname"
    ok "$dbname — Cloud SQL API confirmed a newly-created empty database"
  }

  instance_ip_types="$(gcloud sql instances describe "$TARGET_CLOUD_SQL_INSTANCE" \
    --project="$TARGET_CLOUD_SQL_PROJECT" --format='value(ipAddresses.type)')" \
    || die "Cloud SQL instance inspection failed; refusing to classify a transport/config failure as a credential failure"

  if [[ "$instance_ip_types" != *"PRIMARY"* ]]; then
    info "Cloud SQL has no public IP; resetting databases through the Cloud SQL Admin API..."
    reset_database_through_api "$MM_DB_NAME"
    info "Deleting Gitea token material invalidated by the database reset..."
    remove_gitea_database_credentials
    reset_database_through_api "$GITEA_DB_NAME"
    echo ""
    echo -e "  ${BOLD}Cloud SQL reset complete:${NC}"
    echo -e "    ${GREEN}✅ Cloud SQL API confirmed both recreated databases are empty${NC}"
  else
    PROXY_BIN=$(command -v cloud-sql-proxy 2>/dev/null || \
      ls /opt/homebrew/bin/cloud-sql-proxy 2>/dev/null || \
      ls /opt/homebrew/share/google-cloud-sdk/bin/cloud-sql-proxy 2>/dev/null || \
      echo "")
    if [[ -z "$PROXY_BIN" ]] && command -v brew >/dev/null 2>&1; then
      info "cloud-sql-proxy not found — installing via Homebrew..."
      brew install cloud-sql-proxy >/dev/null 2>&1 && PROXY_BIN=$(command -v cloud-sql-proxy 2>/dev/null || echo "")
      [[ -n "$PROXY_BIN" ]] && ok "cloud-sql-proxy installed: $PROXY_BIN"
    fi
    [[ -n "$PROXY_BIN" ]] || die "cloud-sql-proxy not found and --full requested. Install it (brew install cloud-sql-proxy) or run DB drops manually and rerun without --full."

    if lsof -nP -iTCP:5433 -sTCP:LISTEN >/dev/null 2>&1; then
      holders=$(lsof -nP -iTCP:5433 -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $1"("$2")"}' | sort -u | tr '\n' ' ')
      die "Local port 5433 is already in use by: ${holders:-(unknown)}. Stale cloud-sql-proxy? Kill it (pkill -f 'cloud-sql-proxy.*5433') and rerun."
    fi

    PROXY_LOG=$(mktemp -t cloud-sql-proxy-teardown.XXXXX)
    "$PROXY_BIN" "$TARGET_CLOUD_SQL_CONNECTION" --port=5433 >"$PROXY_LOG" 2>&1 &
    PROXY_PID=$!
    trap '[[ -n "${PROXY_PID:-}" ]] && kill "$PROXY_PID" 2>/dev/null' EXIT

    info "Waiting for cloud-sql-proxy listener on 127.0.0.1:5433..."
    PROXY_UP=false
    for i in $(seq 1 30); do
      if ! kill -0 "$PROXY_PID" 2>/dev/null; then
        echo -e "  ${RED}❌ cloud-sql-proxy exited during startup. Last 20 lines of log:${NC}" >&2
        tail -20 "$PROXY_LOG" | sed 's/^/      /' >&2
        die "cloud-sql-proxy died — see above ($PROXY_LOG)"
      fi
      if nc -z 127.0.0.1 5433 2>/dev/null; then
        PROXY_UP=true
        ok "cloud-sql-proxy listening on :5433 (after ${i}s)"
        break
      fi
      sleep 1
    done
    if ! $PROXY_UP; then
      echo -e "  ${RED}❌ cloud-sql-proxy never started listening on :5433 (30s timeout). Log tail:${NC}" >&2
      tail -20 "$PROXY_LOG" | sed 's/^/      /' >&2
      die "cloud-sql-proxy didn't come up — see above"
    fi

    probe_database_user() {
      local user="$1" pass="$2" dbname="$3" error_file
      error_file=$(mktemp)
      if PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d postgres -tAc "SELECT 1" \
          >/dev/null 2>"$error_file"; then
        rm -f "$error_file"
        return 0
      fi
      if grep -qiE 'password authentication failed|authentication failed' "$error_file"; then
        rm -f "$error_file"
        die "Authentication failed for '$user' user against $dbname. Its Secret Manager password may be out of sync with the DB user."
      fi
      echo -e "  ${RED}❌ Database connection probe failed for '$user' against $dbname; this is a transport/config failure, not a credential mismatch:${NC}" >&2
      sed 's/^/      /' "$error_file" >&2
      rm -f "$error_file"
      die "Fix Cloud SQL proxy/private-network reachability and retry."
    }

    probe_database_user mattermost "$MM_DB_PASS" "$MM_DB_NAME"
    probe_database_user gitea "$GITEA_DB_PASS" "$GITEA_DB_NAME"
    ok "Both DB user credentials authenticate against the live instance"

  # ── 5d. Pre-drop inventory — operator sees what's about to be nuked.
  inventory_db() {
    local user="$1" pass="$2" dbname="$3"
    local line
    line=$(PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d "$dbname" -tAc "
      SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema='public') || ' tables, ' ||
             pg_size_pretty(pg_database_size('$dbname'))
    " 2>/dev/null)
    line=${line//[[:space:]]/ }
    line=${line## }
    if [[ -z "$line" ]]; then line="(could not inspect — DB may not exist yet)"; fi
    echo "    $dbname: $line"
  }

  echo ""
  info "Pre-drop inventory:"
  inventory_db mattermost "$MM_DB_PASS" "$MM_DB_NAME"
  inventory_db gitea      "$GITEA_DB_PASS" "$GITEA_DB_NAME"
  echo ""

  # ── 5e. Drop + recreate + verify, per DB.
  # Single -c per psql call (DROP DATABASE rejects transaction blocks).
  # ON_ERROR_STOP=1 promotes every SQL warning into a non-zero exit so `|| die`
  # actually fires; default psql silently swallows certain errors.
  drop_and_verify() {
    local user="$1" pass="$2" dbname="$3"
    local before
    before=$(PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d "$dbname" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "?")
    before=${before//[[:space:]]/}
    info "Dropping $dbname (before: ${before:-?} tables)..."
    PGPASSWORD="$pass" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -U "$user" -d postgres \
      -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$dbname' AND pid <> pg_backend_pid();" >/dev/null \
      || die "Could not terminate active backends on $dbname (psql failed)"
    PGPASSWORD="$pass" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -U "$user" -d postgres \
      -c "DROP DATABASE IF EXISTS $dbname;" >/dev/null \
      || die "DROP DATABASE $dbname failed — check active sessions or owner permissions"
    PGPASSWORD="$pass" psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5433 -U "$user" -d postgres \
      -c "CREATE DATABASE $dbname;" >/dev/null \
      || die "CREATE DATABASE $dbname failed"
    local after
    after=$(PGPASSWORD="$pass" psql -h 127.0.0.1 -p 5433 -U "$user" -d "$dbname" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "ERR")
    after=${after//[[:space:]]/}
    if [[ "$after" != "0" ]]; then
      die "$dbname not empty after drop+create (tables=$after) — DROP DATABASE may have failed silently. Check $PROXY_LOG and active sessions."
    fi
    ok "$dbname: ${before:-?} tables → 0 (verified empty)"
  }

    drop_and_verify mattermost "$MM_DB_PASS" "$MM_DB_NAME"
    info "Deleting Gitea token material invalidated by the database reset..."
    remove_gitea_database_credentials
    drop_and_verify gitea      "$GITEA_DB_PASS" "$GITEA_DB_NAME"

    kill "$PROXY_PID" 2>/dev/null || true
    PROXY_PID=""
    trap - EXIT
    rm -f "$PROXY_LOG"

    echo ""
    echo -e "  ${BOLD}Cloud SQL reset complete:${NC}"
    echo -e "    ${GREEN}✅ $MM_DB_NAME — dropped + recreated empty${NC}"
    echo -e "    ${GREEN}✅ $GITEA_DB_NAME — dropped + recreated empty${NC}"
  fi
  fi
fi

# ── 6. Secret Manager: preserve infra secrets, wipe per-user byok-* ──
# Infra secrets (ANTHROPIC_API_KEY, STRIPE_*, RESEND_*,
# Firebase web config, DB passwords) are preserved across teardown — they're
# the source of truth, rotating them is a deliberate operation, use
# scripts/rotate-secret.sh, not teardown.
#
# Per-user `byok-{slug}-{provider}` secrets (set by users via the
# admin UI for bring-your-own-key) are env-coupled through the user's
# slug: --full wipes Firestore + Auth, which deletes the user record
# that owned the byok. The corresponding Secret Manager entry becomes an
# orphan with no Firestore pointer. Wipe under --full to keep SM clean.
#
if $FULL; then
  echo ""
  BYOK_SECRETS="$(gcloud secrets list --project="$FIREBASE_PROJECT" --filter="name~^byok-" --format="value(name)")" \
    || die "could not list BYOK secrets in $FIREBASE_PROJECT"
  if [[ -n "$BYOK_SECRETS" ]]; then
    byok_count=$(printf '%s\n' "$BYOK_SECRETS" | wc -l | tr -d ' ')
  else
    byok_count=0
  fi
  if [[ "$byok_count" -gt 0 ]]; then
    if confirm "Delete $byok_count byok-* secret(s) in Secret Manager (user BYOK keys)?"; then
      while read -r sm; do
        [[ -z "$sm" ]] && continue
        gcloud secrets delete "$sm" --project="$FIREBASE_PROJECT" --quiet >/dev/null \
          || die "could not delete BYOK secret $sm in $FIREBASE_PROJECT"
        ok "Deleted byok secret: $sm"
      done <<< "$BYOK_SECRETS"
    else
      die "Full teardown cancelled; BYOK secrets remain in $FIREBASE_PROJECT"
    fi
  else
    info "No byok-* secrets to wipe"
  fi
fi

# ── 7. Full: Cloud Functions ──────────────────────────────────────────────
if $FULL; then
  echo ""
  if confirm "Delete all Cloud Functions in '$FIREBASE_PROJECT'? (chat proxy preserved)"; then
    FN_LIST=$(gcloud functions list --regions="$REGION" \
      --project="$FIREBASE_PROJECT" --format="csv[no-heading](name,environment)") \
      || die "could not list Cloud Functions in $FIREBASE_PROJECT"
    FILTERED_FN_LIST=""
    while IFS=, read -r fn generation extra; do
      [[ -z "$fn" ]] && continue
      [[ -z "$extra" && ( "$generation" == "GEN_1" || "$generation" == "GEN_2" ) ]] \
        || die "unexpected Cloud Function inventory row '$fn,$generation${extra:+,$extra}'"
      [[ "$fn" == "octogee-chat-proxy" ]] && continue
      FILTERED_FN_LIST+="$fn,$generation"$'\n'
    done <<< "$FN_LIST"
    FN_LIST="${FILTERED_FN_LIST%$'\n'}"
    if [[ -z "$FN_LIST" ]]; then
      FN_COUNT=0
    else
      FN_COUNT=$(printf '%s\n' "$FN_LIST" | wc -l | tr -d ' ')
    fi
    if [[ "$FN_COUNT" -gt 0 ]]; then
      info "Deleting $FN_COUNT Cloud Functions across Gen 1 and Gen 2 (preserving chat proxy)..."
      while IFS=, read -r fn generation; do
        [[ -z "$fn" ]] && continue
        gcloud functions delete "$fn" --region="$REGION" \
          --project="$FIREBASE_PROJECT" --quiet \
          || die "could not delete $generation Cloud Function $fn in $FIREBASE_PROJECT"
      done <<< "$FN_LIST"
      ok "Cloud Functions deleted (chat proxy preserved)"
    else
      info "No Cloud Functions found"
    fi
  else
    die "Full teardown cancelled; Cloud Functions remain in $FIREBASE_PROJECT"
  fi
fi

# ── 8. Full: Firebase Storage + Firestore ──────────────────────────────────
if $FULL; then
  echo ""
  if confirm "Wipe ALL Firebase Storage objects in '$FIREBASE_PROJECT'?"; then
    list_storage_versions() {
      local output
      if output="$(gcloud storage ls --all-versions "$FIREBASE_STORAGE_BUCKET/**" --project="$TARGET_STORAGE_PROJECT" 2>&1)"; then
        STORAGE_OBJECT_GENERATIONS="$output"
        return 0
      fi
      if [[ "$output" == "ERROR: (gcloud.storage.ls) One or more URLs matched no objects." ]]; then
        STORAGE_OBJECT_GENERATIONS=""
        return 0
      fi
      [[ -n "$output" ]] && printf '%s\n' "$output" >&2
      return 1
    }
    list_storage_versions || die "Firebase Storage listing failed for $FIREBASE_PROJECT"
    if [[ -n "$STORAGE_OBJECT_GENERATIONS" ]]; then
      gcloud storage rm --all-versions "$FIREBASE_STORAGE_BUCKET/**" --project="$TARGET_STORAGE_PROJECT" --quiet \
        || die "Firebase Storage wipe failed for $FIREBASE_PROJECT"
      list_storage_versions \
        || die "Firebase Storage verification failed for $FIREBASE_PROJECT"
      [[ -z "$STORAGE_OBJECT_GENERATIONS" ]] \
        || die "Firebase Storage still contains object generations after wipe in $FIREBASE_PROJECT"
      ok "Firebase Storage wiped"
    else
      info "Firebase Storage already empty"
    fi
  else
    die "Full teardown cancelled; Firebase Storage objects remain in $FIREBASE_PROJECT"
  fi

  if confirm "Wipe ALL Firestore collections in '$FIREBASE_PROJECT'?"; then
    firebase firestore:delete --all-collections --project "$FIREBASE_PROJECT" --force
    ok "Firestore wiped"
  else
    die "Full teardown cancelled; Firestore data remains in $FIREBASE_PROJECT"
  fi
fi

# ── 9. Full: extension cleanup ────────────────────────────────────────────
if $FULL; then
  run_env_hooks ${ENV_TEARDOWN_FULL_STEPS[@]+"${ENV_TEARDOWN_FULL_STEPS[@]}"}
fi

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BOLD}  Teardown complete — ${ENV_LABEL}${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
YES_FLAG=""
[[ "$ENV" == "test" ]] && YES_FLAG=" --yes"

echo ""
echo "  ╔═══════════════════════════════════════════════════════════════╗"
echo "  ║           CANONICAL INSTALL SEQUENCE (run in order)           ║"
echo "  ╚═══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Each step is idempotent — re-running any one is safe. The two"
echo "  setup-secrets.sh runs are NOT a typo:"
echo "     • run #1 (pre-helm) — creates K8s secrets the pods need to BOOT"
echo "       (gitea-ssh-key, mattermost-cloud-sql DB password, empty"
echo "       mattermost-gateway/gitea-token shells, etc.)"
echo "     • run #2 (post-bootstrap) — re-materializes the same secrets"
echo "       now that setup-mattermost + setup-gitea wrote real values"
echo "       to .env, then validates everything"
echo ""
echo "  GITEA_DB_PASS=\$(gcloud secrets versions access latest --secret=$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET --project=$TARGET_CLOUD_SQL_PROJECT)"
echo "  PLATFORM_SOURCE_SHA=<full 40-character source SHA from the tested Central release manifest>"
echo "  RELEASE_VALUES_FILE=\$(mktemp)"
echo "  ./scripts/node_modules/.bin/tsx scripts/ops/render-release-helm-values.ts \"\$PLATFORM_SOURCE_SHA\" > \"\$RELEASE_VALUES_FILE\" || exit 1"
echo ""
echo "  # 0. Cloud SQL instance settings (right-size + databases + users + creds)"
echo "  #    Idempotent — patches tier/PITR only if they drift, runs once across"
echo "  #    both envs (instance is shared)."
echo "  ./scripts/setup-cloud-sql.sh --target=$TARGET_ID"
echo ""
echo "  # 1. Pre-helm secrets (boot prereqs)"
echo "  ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG --phase=bootstrap${YES_FLAG}"
echo ""
echo "  # 2. Helm install (gateway, gateway-edge, chat-proxy sidecar, MM, Gitea)"
echo "  UMBRELLA_CHART_DIR=\$(mktemp -d)"
echo "  UMBRELLA_CHART=\$(./scripts/package-umbrella-chart.sh --output-dir \"\$UMBRELLA_CHART_DIR\")"
echo "  helm upgrade --install octogee \"\$UMBRELLA_CHART\" \\"
echo "    --server-side=true --force-conflicts \\"
echo "    -f helm/octogee/values.${ENV}.yaml \\"
echo "    -f <(node core/dist/render-deployment-target-helm-values.js --target=$TARGET_ID) \\"
echo "    -f \"\$RELEASE_VALUES_FILE\" \\"
echo "    -n $K8S_NAMESPACE \\"
echo "    --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" \\"
echo "    --kube-context $K8S_CONTEXT"
echo ""
echo "  # 2b. Wait for Mattermost and Gitea only. glm-controller cannot start until"
echo "  #     setup-gitea mints the Gitea token (steps 4-6), so do not wait on the release."
echo "  kubectl rollout status deployment/mattermost -n $K8S_NAMESPACE --context $K8S_CONTEXT --timeout=10m"
echo "  kubectl rollout status deployment/octogee-gitea -n $K8S_NAMESPACE --context $K8S_CONTEXT --timeout=10m"
echo ""
echo "  # 3. Bootstrap Mattermost (admin user, team, bot, PATs)"
echo "  ./scripts/setup-mattermost.sh --env=$ENV$TARGET_ARG${YES_FLAG}"
echo ""
echo "  # 4. Bootstrap Gitea (org, admin token)"
echo "  ./scripts/setup-gitea.sh --env=$ENV$TARGET_ARG${YES_FLAG}"
echo ""
echo "  # 5. Post-bootstrap secrets (picks up the values steps 3+4 wrote to .env)"
echo "  ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG --phase=launch${YES_FLAG}"
echo ""
echo "  # 6. Roll pods so they pick up the freshly-populated secret env vars"
echo "  # Skip the gateway Deployments: the fleet controller owns their rollouts, and restarting a"
echo "  # just-minted Shared slot leaves two unreleased pods waiting on each other."
echo "  kubectl rollout restart deploy -n $K8S_NAMESPACE --context $K8S_CONTEXT -l 'app!=octogee-gateway'"
echo "  # the fleet controller mints shared-<id> slots from the platform release; existing durable"
echo "  # roots/releases are never reconstructed or overwritten."
echo "  until kubectl get deploy -n $K8S_NAMESPACE --context $K8S_CONTEXT -l app=octogee-gateway,gateway-class=shared -o name | grep -q .; do sleep 15; done"
echo "  kubectl wait --for=condition=Available deploy -l app=octogee-gateway,gateway-class=shared -n $K8S_NAMESPACE --context $K8S_CONTEXT --timeout=30m"
echo ""
run_env_hooks ${ENV_REBUILD_STEPS_AFTER_ROLLOUT[@]+"${ENV_REBUILD_STEPS_AFTER_ROLLOUT[@]}"}
echo "  # 7. Deploy the platform and site through CI (Firestore rules and indexes, Functions, site, hosting)"
echo "  npm run ci:deploy -- --environment=$ENV --sha=\"\$PLATFORM_SOURCE_SHA\" --actor=operator:<you>"
echo ""
run_env_hooks ${ENV_REBUILD_STEPS_AFTER_DEPLOY[@]+"${ENV_REBUILD_STEPS_AFTER_DEPLOY[@]}"}
echo "  # 8. Verify"
echo "  ./scripts/verify-env.sh --env=$ENV$TARGET_ARG$(if [[ "$ENV" == "test" ]]; then echo " --fix"; fi)"
echo ""
echo "  ──────────────────────────────────────────────────────────────────"
echo "  In-pod smoke checks (run after step 6):"
echo "    SLOT=\$(kubectl get deploy -n $K8S_NAMESPACE --context $K8S_CONTEXT -l app=octogee-gateway,gateway-class=shared -o name | head -1)"
echo "    kubectl exec -n $K8S_NAMESPACE --context $K8S_CONTEXT \"\$SLOT\" -- curl -s http://127.0.0.1:9081/health"
echo "    kubectl exec -n $K8S_NAMESPACE --context $K8S_CONTEXT \"\$SLOT\" -- curl -s http://127.0.0.1:3001/api/site/health"
echo "    kubectl exec -n $K8S_NAMESPACE --context $K8S_CONTEXT \"\$SLOT\" -- curl -s http://127.0.0.1:9080/health"
echo "  Public smoke (Option C — MM must be reachable directly with PAT auth):"
echo "    curl -sk ${TARGET_MATTERMOST_ORIGIN}/api/v4/system/ping"
echo ""
if ! $FULL; then
  echo "  Note: --full was NOT used. Cloud SQL data, Firestore, Auth users,"
  echo "  and Cloud Functions were preserved. Skip step 7b, and the"
  echo "  pre-existing data may make some setup-* steps a no-op."
  echo ""
fi
echo ""
echo "  Monitoring:"
echo "    kubectl get pods -n $K8S_NAMESPACE -w              # watch pod status"
echo "    kubectl logs -n $K8S_NAMESPACE deploy/octogee-gateway -f  # tail gateway logs"
echo ""
echo "  Troubleshooting:"
echo ""
echo "    Pod stuck in Init:0/1?"
echo "      kubectl describe pod -n $K8S_NAMESPACE -l app=octogee-gateway"
echo "      → Usually missing gitea-ssh-key secret. First-install only:"
echo "      ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG   (bootstrap mode)"
echo ""
echo "    CreateContainerConfigError?"
echo "      → Missing required secret (first install). Run:"
echo "      ./scripts/setup-secrets.sh --env=$ENV$TARGET_ARG   (bootstrap mode)"
echo ""
echo "    Gateway 0/1 Running (not Ready)?"
echo "      → Startup is still in progress. Wait or check:"
echo "      kubectl logs -n $K8S_NAMESPACE deploy/octogee-gateway --tail=20"
echo ""
echo "    502 on preview URL?"
echo "      → Backend health check needs 3-5 min to propagate after first deploy."
echo "      kubectl get ingress -n $K8S_NAMESPACE"
echo "      kubectl get managedcertificate -n $K8S_NAMESPACE"
echo ""
echo "    Ingress has NO ADDRESS (stale NEGs after teardown)?"
echo "      # Restart alone may not fix it — old NEG names cached. Delete + recreate:"
echo "      kubectl delete ingress chat-proxy-ingress gateway-edge-ingress preview-ingress mattermost-ingress -n $K8S_NAMESPACE 2>/dev/null; true"
echo "      kubectl annotate svc chat-proxy -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      kubectl annotate svc gateway-edge -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      kubectl annotate svc mattermost -n $K8S_NAMESPACE cloud.google.com/neg-status- 2>/dev/null || true"
echo "      kubectl annotate svc octogee-gateway -n $K8S_NAMESPACE cloud.google.com/neg-status-"
echo "      # Then helm upgrade to recreate ingresses with fresh NEGs:"
echo "      UMBRELLA_CHART_DIR=\$(mktemp -d)"
echo "      UMBRELLA_CHART=\$(./scripts/package-umbrella-chart.sh --output-dir \"\$UMBRELLA_CHART_DIR\")"
echo "      helm upgrade octogee \"\$UMBRELLA_CHART\" --server-side=true --force-conflicts \\"
echo "        -f helm/octogee/values.${ENV}.yaml \\"
echo "        -f <(node core/dist/render-deployment-target-helm-values.js --target=$TARGET_ID) -n $K8S_NAMESPACE \\"
echo "        -f \"\$RELEASE_VALUES_FILE\" \\"
echo "        --set \"gitea.gitea.config.database.PASSWD=\$GITEA_DB_PASS\" --kube-context $K8S_CONTEXT"
echo ""
echo "    Gitea setup-gitea.sh returns 403?"
echo "      → Fresh install: must_change_password flag. Script handles this automatically."
echo "      → DB mismatch: ./scripts/teardown-env.sh --env=$ENV --full (resets DBs)"
echo ""
