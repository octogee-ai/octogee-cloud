#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

PROVIDER="gcp"
GCP_REGION="${GCP_REGION:-us-central1}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-4}"
SQL_TIER="${SQL_TIER:-db-custom-2-7680}"
SQL_AVAILABILITY="${SQL_AVAILABILITY:-REGIONAL}"
NETWORK_NAME="${CLUSTER_NAME}"
SQL_INSTANCE="${CLUSTER_NAME}"
FILES_ACCOUNT="${CLUSTER_NAME}-files"
if [ -n "${GCP_ZONE:-}" ]; then
  CLUSTER_LOCATION=(--zone "${GCP_ZONE}")
else
  CLUSTER_LOCATION=(--region "${GCP_REGION}")
fi

g() {
  gcloud --project "${GCP_PROJECT}" --quiet "$@"
}

enable_apis() {
  step "Google Cloud APIs"
  g services enable compute.googleapis.com container.googleapis.com sqladmin.googleapis.com \
    servicenetworking.googleapis.com storage.googleapis.com iam.googleapis.com >/dev/null
}

ensure_network() {
  step "Network and Cloud NAT"
  g compute networks describe "${NETWORK_NAME}" >/dev/null 2>&1 \
    || g compute networks create "${NETWORK_NAME}" --subnet-mode=auto >/dev/null
  g compute routers describe "${NETWORK_NAME}" --region "${GCP_REGION}" >/dev/null 2>&1 \
    || g compute routers create "${NETWORK_NAME}" --network "${NETWORK_NAME}" --region "${GCP_REGION}" >/dev/null
  g compute routers nats describe "${NETWORK_NAME}" --router "${NETWORK_NAME}" --region "${GCP_REGION}" >/dev/null 2>&1 \
    || g compute routers nats create "${NETWORK_NAME}" --router "${NETWORK_NAME}" --region "${GCP_REGION}" \
      --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges >/dev/null
  g compute addresses describe "${NETWORK_NAME}-sql" --global >/dev/null 2>&1 \
    || g compute addresses create "${NETWORK_NAME}-sql" --global --purpose=VPC_PEERING \
      --prefix-length=20 --network="${NETWORK_NAME}" >/dev/null
  if [ -z "$(g services vpc-peerings list --network="${NETWORK_NAME}" --format='value(peering)')" ]; then
    g services vpc-peerings connect --service=servicenetworking.googleapis.com \
      --ranges="${NETWORK_NAME}-sql" --network="${NETWORK_NAME}" >/dev/null
  fi
}

ensure_cluster() {
  if ! g container clusters describe "${CLUSTER_NAME}" "${CLUSTER_LOCATION[@]}" >/dev/null 2>&1; then
    step "GKE cluster (about 10 minutes)"
    g container clusters create "${CLUSTER_NAME}" "${CLUSTER_LOCATION[@]}" \
      --network "${NETWORK_NAME}" --subnetwork "${NETWORK_NAME}" \
      --enable-ip-alias --enable-private-nodes --release-channel regular \
      --enable-dns-access --no-enable-ip-access \
      --machine-type "${MACHINE_TYPE}" --num-nodes 1 \
      --enable-autoscaling --min-nodes 1 --max-nodes 3 \
      --workload-pool "${GCP_PROJECT}.svc.id.goog" --enable-shielded-nodes >/dev/null
  elif [ "$(g container clusters describe "${CLUSTER_NAME}" "${CLUSTER_LOCATION[@]}" \
    --format='value(controlPlaneEndpointsConfig.dnsEndpointConfig.allowExternalTraffic)')" != True ]; then
    step "DNS access to the GKE control plane"
    g container clusters update "${CLUSTER_NAME}" "${CLUSTER_LOCATION[@]}" --enable-dns-access >/dev/null
  fi
  g container clusters get-credentials "${CLUSTER_NAME}" "${CLUSTER_LOCATION[@]}" --dns-endpoint >/dev/null
  KUBE_CONTEXT="$(kubectl config current-context)"
}

ensure_database() {
  if ! g sql instances describe "${SQL_INSTANCE}" >/dev/null 2>&1; then
    step "Cloud SQL for PostgreSQL 16 (about 15 minutes)"
    g sql instances create "${SQL_INSTANCE}" --database-version=POSTGRES_16 --edition=ENTERPRISE \
      --tier="${SQL_TIER}" --region="${GCP_REGION}" \
      --network="projects/${GCP_PROJECT}/global/networks/${NETWORK_NAME}" --no-assign-ip \
      --availability-type="${SQL_AVAILABILITY}" --storage-size=20 --storage-auto-increase \
      --backup-start-time=03:00 --enable-point-in-time-recovery \
      --ssl-mode=ENCRYPTED_ONLY --deletion-protection >/dev/null
  fi
  g sql users set-password postgres --instance="${SQL_INSTANCE}" \
    --password="$(secret_value platform-credentials postgres-password)" >/dev/null
  DB_HOST="$(g sql instances describe "${SQL_INSTANCE}" --format='value(ipAddresses[0].ipAddress)')"
  [ -n "${DB_HOST}" ] || die "Cloud SQL did not report a private address for ${SQL_INSTANCE}"
}

files_account_email() {
  g iam service-accounts list --filter="name:${FILES_ACCOUNT}" --format='value(email)'
}

ensure_bucket() {
  step "Cloud Storage bucket"
  BUCKET_NAME="${GCP_PROJECT}-${CLUSTER_NAME}"
  g storage buckets describe "gs://${BUCKET_NAME}" >/dev/null 2>&1 \
    || g storage buckets create "gs://${BUCKET_NAME}" --location="${GCP_REGION}" \
      --uniform-bucket-level-access --public-access-prevention >/dev/null
  k get secret object-store >/dev/null 2>&1 && return 0
  local email keys
  email="$(files_account_email)"
  if [ -z "${email}" ]; then
    g iam service-accounts create "${FILES_ACCOUNT}" --display-name="Platform file storage" >/dev/null
    email="$(files_account_email)"
  fi
  [ -n "${email}" ] || die "could not create the ${FILES_ACCOUNT} service account"
  g storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
    --member="serviceAccount:${email}" --role=roles/storage.objectAdmin >/dev/null
  keys="$(g storage hmac create "${email}" --format='value(metadata.accessId,secret)')"
  [ -n "${keys}" ] || die "Cloud Storage did not return an HMAC key"
  write_object_store "https://storage.googleapis.com" "${BUCKET_NAME}" "auto" \
    "$(printf '%s' "${keys}" | cut -f1)" "$(printf '%s' "${keys}" | cut -f2)"
}

main() {
  require_tools gcloud gke-gcloud-auth-plugin kubectl helm openssl curl base64
  require_settings GCP_PROJECT DOMAIN ACME_EMAIL
  use_dedicated_kubeconfig "${PROVIDER}"
  load_public_hosts
  enable_apis
  ensure_network
  ensure_cluster
  ensure_namespace
  ensure_credentials
  ensure_database
  ensure_bucket
  apply_settings
  apply_model_keys
  prepare_databases
  install_on_cluster
}

main "$@"
