#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/lib/deployment-target.sh"

SELECTOR="--environment=prod"
SECRET_MODE=""
UNINSTALL=false
IAP_ENABLED=false

for arg in "$@"; do
  case "$arg" in
    --env=*) SELECTOR="--environment=${arg#*=}" ;;
    --target=*) SELECTOR="$arg" ;;
    --bootstrap-secret|--adopt-existing-secret)
      [[ -z "$SECRET_MODE" ]] || { echo "Choose only one secret bootstrap mode" >&2; exit 2; }
      SECRET_MODE="$arg"
      ;;
    --uninstall) UNINSTALL=true ;;
    --iap) IAP_ENABLED=true ;;
    --help|-h)
      echo "Usage: $0 [--env=prod|test|--target=TARGET] [--bootstrap-secret|--adopt-existing-secret] [--iap] [--uninstall]"
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

octogee_load_deployment_target "$SELECTOR"
[[ "$TARGET_LIFECYCLE" == "active" ]] || {
  echo "Monitoring only supports active deployment targets; $TARGET_ID is $TARGET_LIFECYCLE" >&2
  exit 1
}
for command in gcloud kubectl helm node; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

gcloud container clusters get-credentials "$TARGET_CLUSTER_NAME" \
  --region "$TARGET_REGION" --project "$TARGET_CLUSTER_PROJECT" >/dev/null
kubectl config use-context "$TARGET_KUBE_CONTEXT" >/dev/null
[[ "$(kubectl config current-context)" == "$TARGET_KUBE_CONTEXT" ]] || {
  echo "Wrong kubectl context" >&2
  exit 1
}

if $UNINSTALL; then
  helm uninstall grafana --namespace monitoring --kube-context "$TARGET_KUBE_CONTEXT" --ignore-not-found
  exit 0
fi

COLLECTION_FILTER="$(node "$SCRIPT_DIR/lib/monitoring-collection-filter.mjs" "$REPO_DIR/charts/monitoring")"

secret_args=(--target="$TARGET_ID")
[[ -n "$SECRET_MODE" ]] && secret_args+=("$SECRET_MODE")
"$SCRIPT_DIR/setup-monitoring-secrets.sh" "${secret_args[@]}"

DASHBOARD_CHECKSUM="$(node - "$REPO_DIR/charts/monitoring/dashboards" <<'NODE'
const { createHash } = require("node:crypto");
const { readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
const files = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(fullPath);
    else if (entry.name.endsWith(".json")) files.push(fullPath);
  }
}
collect(root);

const hash = createHash("sha256");
for (const file of files.sort()) {
  hash.update(path.relative(root, file));
  hash.update("\0");
  hash.update(readFileSync(file));
  hash.update("\0");
}
process.stdout.write(hash.digest("hex"));
NODE
)"

PROD_NAMESPACE="$(octogee_deployment_target_field --environment=prod namespace)"
TEST_NAMESPACE="$(octogee_deployment_target_field --environment=test namespace)"
CONTROL_PLANE_PROJECT="$(node "$SCRIPT_DIR/lib/control-plane-config.mjs" project_id)"

helm_values=(
  --set "gmp.projectId=$TARGET_CLUSTER_PROJECT"
  --set "monitoredNamespaces={$TARGET_NAMESPACE}"
  --set "environmentNamespaces={$PROD_NAMESPACE,$TEST_NAMESPACE}"
  --set-string "grafana.serviceAccount.annotations.iam\\.gke\\.io/gcp-service-account=monitoring-grafana@$CONTROL_PLANE_PROJECT.iam.gserviceaccount.com"
  --set-string "grafana.podAnnotations.octogee\\.ai/dashboard-checksum=$DASHBOARD_CHECKSUM"
)
if $IAP_ENABLED; then
  IAP_DOMAIN="$(node "$SCRIPT_DIR/lib/control-plane-config.mjs" monitoring_iap_domain)"
  helm_values+=(--set iap.enabled=true --set "iap.domain=$IAP_DOMAIN")
fi

helm upgrade --install grafana "$REPO_DIR/charts/monitoring" \
  --namespace monitoring \
  --create-namespace \
  --kube-context "$TARGET_KUBE_CONTEXT" \
  --take-ownership \
  --atomic \
  --wait \
  --timeout 8m \
  "${helm_values[@]}"

kubectl wait --context "$TARGET_KUBE_CONTEXT" --namespace gke-gmp-system \
  --for=condition=Available deployment/rule-evaluator --timeout=5m >/dev/null

kubectl patch operatorconfig config -n gmp-public --context "$TARGET_KUBE_CONTEXT" --type=merge \
  --patch "$COLLECTION_FILTER" >/dev/null

verify_args=(--target="$TARGET_ID")
$IAP_ENABLED && verify_args+=(--iap)
"$SCRIPT_DIR/verify-monitoring.sh" "${verify_args[@]}"
