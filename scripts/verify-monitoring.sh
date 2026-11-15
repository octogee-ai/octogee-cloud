#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
source "$SCRIPT_DIR/lib/deployment-target.sh"
source "$SCRIPT_DIR/lib/iap-endpoint-health.sh"
source "$SCRIPT_DIR/lib/grafana-health.sh"

SELECTOR="--environment=prod"
IAP_ENABLED=false
for arg in "$@"; do
  case "$arg" in
    --env=*) SELECTOR="--environment=${arg#*=}" ;;
    --target=*) SELECTOR="$arg" ;;
    --iap) IAP_ENABLED=true ;;
    --help|-h)
      echo "Usage: $0 [--env=prod|test|--target=TARGET] [--iap]"
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

for command in curl gcloud kubectl helm node; do
  command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }
done

gcloud container clusters get-credentials "$TARGET_CLUSTER_NAME" \
  --region "$TARGET_REGION" --project "$TARGET_CLUSTER_PROJECT" >/dev/null
kubectl config use-context "$TARGET_KUBE_CONTEXT" >/dev/null
[[ "$(kubectl config current-context)" == "$TARGET_KUBE_CONTEXT" ]] || {
  echo "Wrong kubectl context" >&2
  exit 1
}

assert_release_ownership() {
  local resource="$1"
  local name="$2"
  local namespace="${3:-}"
  local args=(get "$resource" "$name" --context "$TARGET_KUBE_CONTEXT")
  [[ -n "$namespace" ]] && args+=(--namespace "$namespace")
  local release release_namespace managed_by
  release="$(kubectl "${args[@]}" -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-name}')"
  release_namespace="$(kubectl "${args[@]}" -o jsonpath='{.metadata.annotations.meta\.helm\.sh/release-namespace}')"
  managed_by="$(kubectl "${args[@]}" -o jsonpath='{.metadata.labels.app\.kubernetes\.io/managed-by}')"
  [[ "$release" == "grafana" && "$release_namespace" == "monitoring" && "$managed_by" == "Helm" ]] || {
    echo "Unowned first-party monitoring resource: $resource/$name" >&2
    exit 1
  }
}

helm status grafana --namespace monitoring --kube-context "$TARGET_KUBE_CONTEXT" >/dev/null
assert_release_ownership namespace monitoring
kubectl rollout status deployment/rule-evaluator --namespace gke-gmp-system --context "$TARGET_KUBE_CONTEXT" --timeout=5m >/dev/null

for deployment in grafana gmp-frontend gmp-kube-state-metrics; do
  kubectl rollout status "deployment/$deployment" --namespace monitoring --context "$TARGET_KUBE_CONTEXT" --timeout=5m >/dev/null
  assert_release_ownership deployment "$deployment" monitoring
done
octogee_verify_grafana_health "$TARGET_KUBE_CONTEXT"

for service in grafana gmp-frontend gmp-kube-state-metrics; do
  assert_release_ownership service "$service" monitoring
done
for account in grafana gmp-kube-state-metrics; do
  assert_release_ownership serviceaccount "$account" monitoring
done
for resource in clusterrole clusterrolebinding; do
  assert_release_ownership "$resource" gmp-kube-state-metrics
done
for resource_and_name in \
  "role octogee-monitoring-grafana-dashboard-reader" \
  "rolebinding grafana"; do
  read -r resource name <<<"$resource_and_name"
  assert_release_ownership "$resource" "$name" monitoring
done
for monitor in gmp-kube-state-metrics octogee-api octogee-gateway gateway-edge gitea glm-controller; do
  assert_release_ownership clusterpodmonitoring "$monitor"
done
rules_count=0
while IFS= read -r rules_file; do
  rules_name="$(awk '/^metadata:/ { in_metadata = 1; next } in_metadata && /^  name:/ { print $2; exit }' "$rules_file")"
  [[ -n "$rules_name" ]] || { echo "No ClusterRules name in $rules_file" >&2; exit 1; }
  assert_release_ownership clusterrules "$rules_name"
  rules_count=$((rules_count + 1))
done < <(find "$REPO_DIR/charts/monitoring" -path "$REPO_DIR/charts/monitoring/templates" -prune -o -type f -name gmp-rules.yaml -print | sort)
[[ "$rules_count" -gt 0 ]] || { echo "No alert rule sources found" >&2; exit 1; }
prod_namespace="$(octogee_deployment_target_field --environment=prod namespace)"
test_namespace="$(octogee_deployment_target_field --environment=test namespace)"
for namespace in "$prod_namespace" "$test_namespace"; do
  assert_release_ownership networkpolicy allow-gateway-edge-monitoring-scrape "$namespace"
done

if $IAP_ENABLED; then
  for resource_and_name in \
    "backendconfig grafana-iap" \
    "service grafana-nodeport" \
    "managedcertificate grafana-cert" \
    "ingress grafana"; do
    read -r resource name <<<"$resource_and_name"
    assert_release_ownership "$resource" "$name" monitoring
  done
  kubectl wait managedcertificate/grafana-cert --namespace monitoring --context "$TARGET_KUBE_CONTEXT" \
    --for=jsonpath='{.status.certificateStatus}'=Active --timeout=30m >/dev/null
  kubectl wait ingress/grafana --namespace monitoring --context "$TARGET_KUBE_CONTEXT" \
    --for=jsonpath='{.status.loadBalancer.ingress[0].ip}' --timeout=10m >/dev/null
  [[ "$(kubectl get ingress grafana --namespace monitoring --context "$TARGET_KUBE_CONTEXT" -o jsonpath='{.metadata.annotations.networking\.gke\.io/managed-certificates}')" == "grafana-cert" ]] || {
    echo "Grafana ingress is not bound to grafana-cert" >&2
    exit 1
  }
  backend_annotation="$(kubectl get ingress grafana --namespace monitoring --context "$TARGET_KUBE_CONTEXT" \
    -o jsonpath='{.metadata.annotations.ingress\.kubernetes\.io/backends}')"
  backend_service="$(iap_backend_from_ingress_annotation "$backend_annotation")" || {
    echo "Grafana ingress does not have exactly one healthy GKE backend" >&2
    exit 1
  }
  backend_json="$(gcloud compute backend-services describe "$backend_service" \
    --global --project="$TARGET_CLUSTER_PROJECT" --format=json)" || {
    echo "Could not read Grafana backend service $backend_service" >&2
    exit 1
  }
  is_iap_enabled_backend_json "$backend_json" || {
    echo "IAP is not enabled on Grafana backend service $backend_service" >&2
    exit 1
  }
  iap_principal="$(node -e '
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[1], "utf8");
const declaration = source.match(/variable\s+"monitoring_iap_operator_principal"\s*\{([\s\S]*?)\n\}/);
if (!declaration) process.exit(1);
const matches = [...declaration[1].matchAll(/^\s*default\s*=\s*"([^"]+)"\s*$/gm)];
if (matches.length !== 1) process.exit(1);
process.stdout.write(matches[0][1]);
' "$REPO_DIR/terraform/environments/control-plane/variables.tf")" || {
    echo "Could not resolve the declared monitoring IAP principal" >&2
    exit 1
  }
  iam_policy="$(gcloud projects get-iam-policy "$TARGET_CLUSTER_PROJECT" --format=json)" || {
    echo "Could not read IAP access policy" >&2
    exit 1
  }
  iap_policy_grants_principal "$iam_policy" "$iap_principal" || {
    echo "Declared monitoring IAP principal is missing roles/iap.httpsResourceAccessor" >&2
    exit 1
  }
  iap_host="$(kubectl get ingress grafana --namespace monitoring --context "$TARGET_KUBE_CONTEXT" \
    -o jsonpath='{.spec.rules[0].host}')"
  is_iap_protected_admin_host "$iap_host" || {
    echo "Grafana host is not declared as IAP-protected" >&2
    exit 1
  }
  if ! iap_probe="$(curl --silent --show-error --output /dev/null \
    --write-out '%{http_code} %{redirect_url}' --max-time 10 "https://${iap_host}/")"; then
    echo "Grafana IAP endpoint probe failed" >&2
    exit 1
  fi
  iap_status="${iap_probe%% *}"
  iap_redirect="${iap_probe#* }"
  is_expected_iap_redirect "$iap_status" "$iap_redirect" || {
    echo "Grafana endpoint did not enforce the Google IAP login redirect" >&2
    exit 1
  }
fi

dashboard_count=0
while IFS= read -r json; do
  name="grafana-dash-$(basename "$json" .json | tr '[:upper:]_' '[:lower:]-')"
  assert_release_ownership configmap "$name" monitoring
  dashboard_count=$((dashboard_count + 1))
done < <(find "$REPO_DIR/charts/monitoring/dashboards" -type f -name '*.json' -print | sort)
[[ "$dashboard_count" -gt 0 ]] || { echo "No Grafana dashboard sources found" >&2; exit 1; }

all_configmaps="$(kubectl get configmap --namespace monitoring --context "$TARGET_KUBE_CONTEXT" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')" || {
  echo "Could not list monitoring ConfigMaps" >&2
  exit 1
}
while IFS= read -r dashboard; do
  [[ "$dashboard" == grafana-dash-* ]] || continue
  assert_release_ownership configmap "$dashboard" monitoring
done <<<"$all_configmaps"

actual_filter="$(kubectl get operatorconfig config --namespace gmp-public --context "$TARGET_KUBE_CONTEXT" -o json)"
if ! printf '%s' "$actual_filter" | node -e '
const fs = require("node:fs");
const desired = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let actual;
try {
  actual = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {
  process.exit(1);
}
if (JSON.stringify(actual.collection?.filter?.matchOneOf) !== JSON.stringify(desired.collection.filter.matchOneOf)) {
  process.exit(1);
}
' "$REPO_DIR/charts/monitoring/gmp-collection-filter.json"; then
  echo "gmp-public/config collection filter drifted" >&2
  exit 1
fi

echo "Monitoring release and gmp-public/config collection filter are healthy for $TARGET_ID"
