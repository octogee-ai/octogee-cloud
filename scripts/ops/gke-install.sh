#!/usr/bin/env bash
# Install the platform on GKE in one Google Cloud project: gke-install.sh up|down|status
# See docs/gke.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="octogee"
NAMESPACE="octogee"
SHA=""
MANIFEST=""

log() { printf '\n== %s\n' "$*"; }
die() { printf 'gke-install: %s\n' "$*" >&2; exit 1; }

COMMAND="${1:-}"
[[ $# -gt 0 ]] && shift
for arg in "$@"; do
  case "$arg" in
    --sha=*) SHA="${arg#*=}" ;;
    --manifest=*)
      MANIFEST="${arg#*=}"
      [[ -n "$MANIFEST" ]] || die "--manifest needs a path"
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done
if [[ -n "$SHA" && ! "$SHA" =~ ^[0-9a-f]{40}$ ]]; then die "--sha needs a full commit SHA"; fi

GCP_PROJECT="${GCP_PROJECT:-}"
GCP_REGION="${GCP_REGION:-us-central1}"
GCP_ZONE="${GCP_ZONE:-${GCP_REGION}-a}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-4}"
GATEWAY_MACHINE_TYPE="${GATEWAY_MACHINE_TYPE:-e2-standard-4}"
SQL_TIER="${SQL_TIER:-db-custom-1-3840}"
[[ -n "$GCP_PROJECT" ]] || die "Set GCP_PROJECT to the Google Cloud project to install into"

STATE="${OCTOGEE_GKE_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/octogee-gke}/$GCP_PROJECT"
KUBECONFIG_FILE="$STATE/kubeconfig"
KUBE_CONTEXT="gke_${GCP_PROJECT}_${GCP_ZONE}_${NAME}"
PUBLISHED="ghcr.io/octogee-ai/octogee-cloud"
ADMIN_PORT=18080
SQL_INSTANCE="$NAME"
BLOB_ACCOUNT="$NAME-blob-store"
BLOB_EMAIL="$BLOB_ACCOUNT@$GCP_PROJECT.iam.gserviceaccount.com"
ASSETS_BUCKET="$GCP_PROJECT-$NAME-assets"
WORKSPACES_BUCKET="$GCP_PROJECT-$NAME-workspaces"
SHA="${SHA:-$(git -C "$ROOT" rev-parse HEAD)}"
SHORT="${SHA:0:7}"
IMAGES=(glm-controller octogee-api gateway-edge octogee-gateway octogee-gateway-builder)
POSTGRES_CLIENT_IMAGE="pgvector/pgvector:0.8.7-pg16@sha256:484e838076e04939d27d3e176e91c86eea96236126023be8d3059761122e579f"

g() { gcloud --project "$GCP_PROJECT" --quiet "$@"; }
k() { kubectl --kubeconfig="$KUBECONFIG_FILE" --context="$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }
h() { helm --kubeconfig="$KUBECONFIG_FILE" --kube-context="$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }
random_hex() { openssl rand -hex "$1"; }

require_tools() {
  local tool
  for tool in gcloud gke-gcloud-auth-plugin kubectl helm docker node openssl ssh-keygen git; do
    command -v "$tool" >/dev/null || die "$tool is required"
  done
}

secret_value() {
  local file="$STATE/secrets/$1"
  if [[ ! -s "$file" ]]; then
    mkdir -p "$STATE/secrets"
    (umask 077; "${@:2}" > "$file")
  fi
  cat "$file"
}

enable_apis() {
  g services enable compute.googleapis.com container.googleapis.com sqladmin.googleapis.com \
    servicenetworking.googleapis.com storage.googleapis.com iam.googleapis.com >/dev/null
}

ensure_network() {
  g compute networks describe "$NAME" >/dev/null 2>&1 \
    || g compute networks create "$NAME" --subnet-mode=auto >/dev/null
  g compute routers describe "$NAME" --region "$GCP_REGION" >/dev/null 2>&1 \
    || g compute routers create "$NAME" --network "$NAME" --region "$GCP_REGION" >/dev/null
  g compute routers nats describe "$NAME" --router "$NAME" --region "$GCP_REGION" >/dev/null 2>&1 \
    || g compute routers nats create "$NAME" --router "$NAME" --region "$GCP_REGION" \
      --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges >/dev/null
  g compute addresses describe "$NAME-sql" --global >/dev/null 2>&1 \
    || g compute addresses create "$NAME-sql" --global --purpose=VPC_PEERING \
      --prefix-length=20 --network="$NAME" >/dev/null
  if [[ -z "$(g services vpc-peerings list --network="$NAME" --format='value(peering)')" ]]; then
    g services vpc-peerings connect --service=servicenetworking.googleapis.com \
      --ranges="$NAME-sql" --network="$NAME" >/dev/null
  fi
}

ensure_cluster() {
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  if ! g container clusters describe "$NAME" --zone "$GCP_ZONE" >/dev/null 2>&1; then
    log "GKE cluster $NAME in $GCP_ZONE (about 10 minutes)"
    g container clusters create "$NAME" --zone "$GCP_ZONE" \
      --network "$NAME" --subnetwork "$NAME" --enable-ip-alias --enable-private-nodes \
      --enable-dns-access --enable-dataplane-v2 --release-channel regular --workload-pool "$GCP_PROJECT.svc.id.goog" \
      --enable-shielded-nodes --machine-type "$MACHINE_TYPE" --num-nodes 1 \
      --enable-autoscaling --min-nodes 1 --max-nodes 2 >/dev/null
  fi
  if ! g container node-pools describe gateways --cluster "$NAME" --zone "$GCP_ZONE" >/dev/null 2>&1; then
    log "gVisor node pool for gateways"
    g container node-pools create gateways --cluster "$NAME" --zone "$GCP_ZONE" \
      --sandbox type=gvisor --image-type cos_containerd --machine-type "$GATEWAY_MACHINE_TYPE" \
      --num-nodes 1 --enable-autoscaling --min-nodes 1 --max-nodes 3 >/dev/null
  fi
  if [[ "$(g container clusters describe "$NAME" --zone "$GCP_ZONE" \
    --format='value(controlPlaneEndpointsConfig.dnsEndpointConfig.allowExternalTraffic)')" != True ]]; then
    g container clusters update "$NAME" --zone "$GCP_ZONE" --enable-dns-access >/dev/null
  fi
  KUBECONFIG="$KUBECONFIG_FILE" g container clusters get-credentials "$NAME" --zone "$GCP_ZONE" --dns-endpoint >/dev/null
  kubectl --kubeconfig="$KUBECONFIG_FILE" --context="$KUBE_CONTEXT" create namespace "$NAMESPACE" --dry-run=client -o yaml \
    | kubectl --kubeconfig="$KUBECONFIG_FILE" --context="$KUBE_CONTEXT" apply -f - >/dev/null
}

ensure_database() {
  if ! g sql instances describe "$SQL_INSTANCE" >/dev/null 2>&1; then
    log "Cloud SQL for PostgreSQL 16 (about 15 minutes)"
    g sql instances create "$SQL_INSTANCE" --database-version=POSTGRES_16 --edition=ENTERPRISE \
      --tier="$SQL_TIER" --zone="$GCP_ZONE" \
      --network="projects/$GCP_PROJECT/global/networks/$NAME" --no-assign-ip \
      --availability-type=ZONAL --storage-size=20 --storage-auto-increase \
      --database-flags=max_connections=300 --backup-start-time=03:00 \
      --ssl-mode=ENCRYPTED_ONLY >/dev/null
  fi
  g sql users set-password postgres --instance="$SQL_INSTANCE" \
    --password="$(secret_value postgres-password random_hex 16)" >/dev/null
  DB_HOST="$(g sql instances describe "$SQL_INSTANCE" --format='value(ipAddresses.filter("type:PRIVATE").extract(ipAddress).flatten())')"
  [[ "$DB_HOST" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "Cloud SQL did not report one private address for $SQL_INSTANCE"
}

blob_account_exists() { g iam service-accounts describe "$BLOB_EMAIL" >/dev/null 2>&1; }

bind_bucket_role() {
  local bucket="$1" role="$2" attempt
  for attempt in 1 2 3 4 5 6; do
    g storage buckets add-iam-policy-binding "gs://$bucket" \
      --member="serviceAccount:$BLOB_EMAIL" --role="$role" >/dev/null && return 0
    echo "  $BLOB_EMAIL is not visible to Cloud Storage yet; retrying"
    sleep $((attempt * 5))
  done
  die "could not grant $BLOB_EMAIL $role on gs://$bucket"
}

ensure_buckets() {
  local bucket keys
  for bucket in "$ASSETS_BUCKET" "$WORKSPACES_BUCKET"; do
    g storage buckets describe "gs://$bucket" >/dev/null 2>&1 \
      || g storage buckets create "gs://$bucket" --location="$GCP_REGION" \
        --uniform-bucket-level-access --public-access-prevention >/dev/null
  done
  blob_account_exists \
    || g iam service-accounts create "$BLOB_ACCOUNT" --display-name="Platform blob store" >/dev/null
  for bucket in "$ASSETS_BUCKET" "$WORKSPACES_BUCKET"; do
    bind_bucket_role "$bucket" roles/storage.objectAdmin
    bind_bucket_role "$bucket" roles/storage.legacyBucketReader
  done
  if [[ ! -s "$STATE/secrets/s3-secret-key" ]]; then
    keys="$(g storage hmac create "$BLOB_EMAIL" --format='value(metadata.accessId,secret)')"
    [[ -n "$keys" ]] || die "Cloud Storage did not return an HMAC key"
    mkdir -p "$STATE/secrets"
    (umask 077; printf '%s' "${keys%%$'\t'*}" > "$STATE/secrets/s3-access-key"; printf '%s' "${keys#*$'\t'}" > "$STATE/secrets/s3-secret-key")
  fi
}

published_digest() {
  local name="$1"
  if [[ -n "$MANIFEST" ]]; then
    node -e '
      const [file, name, sha] = process.argv.slice(1);
      const build = JSON.parse(require("node:fs").readFileSync(file, "utf8"));
      if (build.sha !== sha) throw new Error(`${file} is the manifest of ${build.sha}, not ${sha}`);
      const digest = build.images?.[name]?.platforms?.["linux/amd64"];
      if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? "")) throw new Error(`${file} has no linux/amd64 digest for ${name}`);
      console.log(digest);
    ' "$MANIFEST" "$name" "$SHA"
  else
    node -e '
      const index = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const manifest = (index.manifests ?? []).find(entry => entry.platform?.os === "linux" && entry.platform?.architecture === "amd64");
      if (!/^sha256:[a-f0-9]{64}$/.test(manifest?.digest ?? "")) throw new Error(`${process.argv[1]} has no linux/amd64 image`);
      console.log(manifest.digest);
    ' "$PUBLISHED/$name:$SHA" < <(docker buildx imagetools inspect "$PUBLISHED/$name:$SHA" --raw)
  fi
}

resolve_images() {
  local name digests=()
  for name in "${IMAGES[@]}"; do
    digests+=("$name=$(published_digest "$name")")
  done
  node -e '
    const [file, sha, ...pairs] = process.argv.slice(1);
    const images = Object.fromEntries(pairs.map(pair => pair.split("=")));
    require("node:fs").writeFileSync(file, JSON.stringify({ platform: "linux/amd64", sha, images }, null, 2) + "\n");
  ' "$STATE/digests.json" "$SHA" "${digests[@]}"
}

api_server_cidrs() {
  kubectl --kubeconfig="$KUBECONFIG_FILE" --context="$KUBE_CONTEXT" -n default get endpointslice \
    -l kubernetes.io/service-name=kubernetes -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{"\n"}{end}' | sort -u
}

environment_values() {
  local cidrs
  cidrs="$(api_server_cidrs | sed 's|$|/32|' | paste -sd, -)"
  [[ -n "$cidrs" ]] || die "Found no Kubernetes API server endpoint in the cluster"
  node --input-type=module - "$STATE/digests.json" "$PUBLISHED/" \
    "$(node -p "require('$ROOT/infra/gateway/openclaw-tarball/current.json').sourceSha")" \
    "$GCP_PROJECT" "$DB_HOST" "$ASSETS_BUCKET" "$WORKSPACES_BUCKET" "$cidrs" > "$STATE/environment.yaml" <<'JS'
import { readFileSync } from "node:fs";
const [file, prefix, openclaw, project, databaseHost, assets, workspaces, cidrs] = process.argv.slice(2);
const { sha, images } = JSON.parse(readFileSync(file, "utf8"));
const tag = sha.slice(0, 7);
const image = name => ({ repository: `${prefix}${name}`, tag, digest: images[name] });
console.log(JSON.stringify({
  global: {
    deploymentProjectId: project,
    customerHostingProjectId: project,
    blobStore: { bucket: assets, workspaceBucket: workspaces },
  },
  mattermost: { db: { host: databaseHost } },
  gitea: { gitea: { config: { database: { HOST: `${databaseHost}:5432` } } } },
  networkPolicy: { agentStorePostgresCidr: `${databaseHost}/32` },
  projectRunner: { apiServerEgressCidrs: cidrs.split(",") },
  "octogee-api": { image: image("octogee-api") },
  llmBroker: { image: image("octogee-api") },
  "gateway-edge": { image: image("gateway-edge") },
  "glm-controller": {
    image: image("glm-controller"),
    gatewayValues: {
      env: { gcloudProject: project, firebaseProjectId: project },
      gatewayEdge: { env: { FIREBASE_PROJECT_ID: project, GCLOUD_PROJECT: project, GCP_PROJECT_ID: project } },
    },
    platformRelease: {
      sourceSha: sha,
      gatewayImageRepository: `${prefix}octogee-gateway`,
      gatewayImageTag: `${tag}@${images["octogee-gateway"]}`,
      builderImageTag: `${tag}@${images["octogee-gateway-builder"]}`,
      gatewayEdgeImageRepository: `${prefix}gateway-edge`,
      gatewayEdgeImageTag: `${tag}@${images["gateway-edge"]}`,
      openclawSourceSha: openclaw,
    },
  },
}, null, 2));
JS
}

apply_secret() {
  local name="$1"
  shift
  k create secret generic "$name" "$@" --dry-run=client -o yaml | k apply -f - >/dev/null
}

ensure_keypair() {
  local name="$1"
  if [[ ! -s "$STATE/secrets/$name.pem" ]]; then
    mkdir -p "$STATE/secrets"
    (umask 077; node -e '
      const { generateKeyPairSync } = require("node:crypto");
      const { writeFileSync } = require("node:fs");
      const pair = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      writeFileSync(process.argv[1] + ".pem", pair.privateKey);
      writeFileSync(process.argv[1] + ".pub.pem", pair.publicKey);
    ' "$STATE/secrets/$name")
  fi
}

write_secrets() {
  local postgres mattermost gitea migration runtime agent root
  postgres="$(secret_value postgres-password random_hex 16)"
  mattermost="$(secret_value mattermost-password random_hex 16)"
  gitea="$(secret_value gitea-password random_hex 16)"
  migration="$(secret_value platform-migration-password random_hex 16)"
  runtime="$(secret_value platform-runtime-password random_hex 16)"
  agent="$(secret_value agent-admin-password random_hex 16)"
  root="$(secret_value root-key openssl rand -base64 32)"
  apply_secret postgres-credentials --from-literal=postgres-password="$postgres" \
    --from-literal=mattermost-password="$mattermost" --from-literal=gitea-password="$gitea" \
    --from-literal=platform-migration-password="$migration" --from-literal=platform-runtime-password="$runtime" \
    --from-literal=agent-admin-password="$agent"
  apply_secret platform-state-postgres --from-literal=host="$DB_HOST" --from-literal=port=5432 \
    --from-literal=database=octogee_platform --from-literal=sslmode=require \
    --from-literal=migration-user=platform_migration --from-literal=migration-password="$migration" \
    --from-literal=runtime-user=platform_runtime --from-literal=runtime-password="$runtime"
  apply_secret agent-store-postgres \
    --from-literal=admin-dsn="postgres://agent_admin:$agent@$DB_HOST:5432/octogee_agents?sslmode=no-verify" \
    --from-literal=client-dsn="postgres://agent_client@$DB_HOST:5432/octogee_agents?sslmode=no-verify"
  apply_secret platform-root-key --from-literal=root-key="$root"
  apply_secret blob-store-s3 --from-file=access-key-id="$STATE/secrets/s3-access-key" \
    --from-file=secret-access-key="$STATE/secrets/s3-secret-key"
  apply_secret mattermost-cloud-sql --from-literal=password="$mattermost"
  apply_secret gitea-admin --from-literal=username=octogee-admin \
    --from-literal=password="$(secret_value gitea-admin-password random_hex 16)"
  ensure_keypair fleet-controller
  apply_secret octogee-fleet-controller --from-file=private-key="$STATE/secrets/fleet-controller.pem" \
    --from-file=public-key="$STATE/secrets/fleet-controller.pub.pem"
  ensure_keypair agent-control-router
  apply_secret agent-control-router --from-file=secret="$STATE/secrets/agent-control-router.pem" \
    --from-file=public-key="$STATE/secrets/agent-control-router.pub.pem"
  ensure_keypair byot-sync-internal
  apply_secret byot-sync-internal --from-file=secret="$STATE/secrets/byot-sync-internal.pem" \
    --from-file=public-key="$STATE/secrets/byot-sync-internal.pub.pem"
  if [[ ! -s "$STATE/secrets/gitea-ssh" ]]; then
    ssh-keygen -q -t ed25519 -N "" -C "octogee-gateway@users.invalid" -f "$STATE/secrets/gitea-ssh"
  fi
  apply_secret gitea-ssh-key --from-file=id_ed25519="$STATE/secrets/gitea-ssh" --from-file=id_ed25519.pub="$STATE/secrets/gitea-ssh.pub"
  apply_secret gateway-model-key-issuer --from-literal=bearer_token="$(secret_value model-key-issuer random_hex 32)"
  apply_secret social-notification-bearer --from-literal=bearer-token="$(secret_value social-notification random_hex 20)"
  ensure_keypair operator
  apply_secret fleet-operator-key --from-file=public-key="$STATE/secrets/operator.pub.pem"
  for name in mattermost-gateway gitea-token; do
    k get secret "$name" >/dev/null 2>&1 || apply_secret "$name"
  done
  apply_provider_keys
}

PROVIDER_KEYS=(openrouter:OPENROUTER_API_KEY openai:OPENAI_API_KEY anthropic:ANTHROPIC_API_KEY)
STORED_PROVIDERS=()

require_provider_key() {
  local pair variable
  for pair in "${PROVIDER_KEYS[@]}"; do
    variable="${pair#*:}"
    [[ -z "${!variable:-}" ]] || return 0
  done
  if [[ -s "$KUBECONFIG_FILE" ]]; then
    for pair in "${PROVIDER_KEYS[@]}"; do
      k get secret "octogee-${pair%%:*}" >/dev/null 2>&1 && return 0
    done
  fi
  printf '%s\n' \
    "gke-install: agents need a model provider key, and none is exported or stored in the cluster." \
    "Export one of OPENROUTER_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY and run up again." \
    "docs/kind.md#model-provider-keys says where to get each one." >&2
  exit 1
}

apply_provider_keys() {
  local pair provider variable
  STORED_PROVIDERS=()
  for pair in "${PROVIDER_KEYS[@]}"; do
    provider="${pair%%:*}"
    variable="${pair#*:}"
    if [[ -n "${!variable:-}" ]]; then
      apply_secret "octogee-$provider" --from-file=api_key=<(printf '%s' "${!variable}")
      printf 'Stored %s in Secret octogee-%s\n' "$variable" "$provider"
      STORED_PROVIDERS+=("$provider")
    elif k get secret "octogee-$provider" >/dev/null 2>&1; then
      STORED_PROVIDERS+=("$provider")
    fi
  done
}

psql_pod() {
  local database="$1"
  shift
  k run "psql-$(random_hex 4)" --rm -i --quiet --restart=Never --image="$POSTGRES_CLIENT_IMAGE" \
    --overrides="$(node -e '
      const [image, host, database] = process.argv.slice(1);
      console.log(JSON.stringify({ spec: { containers: [{
        name: "psql", image, stdin: true, stdinOnce: true,
        command: ["psql", "-h", host, "-U", "postgres", "-d", database, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", ...process.argv.slice(4)],
        env: [
          { name: "PGSSLMODE", value: "require" },
          ...["postgres", "mattermost", "gitea", "platform-migration", "platform-runtime", "agent-admin"].map(account => ({
            name: account === "postgres" ? "PGPASSWORD" : `${account.toUpperCase().replace("-", "_")}_PASSWORD`,
            valueFrom: { secretKeyRef: { name: "postgres-credentials", key: `${account}-password` } },
          })),
        ],
      }] } }));
    ' "$POSTGRES_CLIENT_IMAGE" "$DB_HOST" "$database" "$@")"
}

prepare_databases() {
  psql_pod postgres < "$ROOT/scripts/ops/gke/databases.sql" >/dev/null
  psql_pod octogee_agents < "$ROOT/scripts/ops/gke/agent-store.sql" >/dev/null
}

platform_sql() {
  local file="$STATE/sql.$$"
  cat > "$file"
  psql_pod octogee_platform "$@" < "$file"
  rm -f "$file"
}

apply_agent_models() {
  local provider="" candidate primary fallback house owner
  for candidate in openrouter anthropic openai; do
    if [[ " ${STORED_PROVIDERS[*]-} " == *" $candidate "* ]]; then
      provider="$candidate"
      break
    fi
  done
  [[ -n "$provider" ]] || die "No model provider key is stored"
  case "$provider" in
    openrouter) primary=platform-openrouter/meta/muse-ember fallback=platform-openrouter/openai/gpt-6-luna house=platform-openrouter/openai/gpt-6-luna ;;
    anthropic) primary=anthropic/claude-sonnet-5 fallback=anthropic/claude-haiku-4-5 house=anthropic/claude-haiku-4-5 ;;
    openai) primary=platform-openai/gpt-6.1-terra fallback=platform-openai/gpt-6-luna house=platform-openai/gpt-6-luna ;;
  esac
  owner="$(platform_sql <<<"SELECT updated_by FROM platform.platform_config WHERE key = 'models';")"
  if [[ -n "$owner" && "$owner" != gke-install ]]; then
    printf 'Keeping the agent models that %s set\n' "$owner"
    return
  fi
  platform_sql -v value="{\"builderAgentModelRef\":\"$primary\",\"builderAgentFallbackModelRef\":\"$fallback\",\"freeTierModelRef\":\"$house\"}" >/dev/null <<'SQL'
INSERT INTO platform.platform_config (key, value, updated_at, updated_by)
VALUES ('models', :'value'::jsonb, (extract(epoch FROM clock_timestamp()) * 1000)::bigint, 'gke-install')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
SQL
  printf 'Agents use %s, falling back to %s; the house model is %s\n' "$primary" "$fallback" "$house"
}

install_chart() {
  h upgrade --install octogee "$ROOT/helm/octogee" \
    -f "$ROOT/scripts/ops/gke/values.yaml" -f "$STATE/environment.yaml" \
    --set "gitea.gitea.config.database.PASSWD=$(cat "$STATE/secrets/gitea-password")" \
    --timeout=15m
}

mattermost_bootstrap() {
  k rollout status deployment/mattermost --timeout=10m
  local user=octogee-admin password
  password="$(secret_value mattermost-admin-password random_hex 16)"
  mmctl() { k exec deploy/mattermost -c mattermost -- /mattermost/bin/mmctl --local --json "$@"; }
  mmctl config set ServiceSettings.EnableBotAccountCreation true >/dev/null
  mmctl config set ServiceSettings.EnableUserAccessTokens true >/dev/null
  if ! mmctl user search "$user" >/dev/null 2>&1; then
    mmctl user create --username "$user" --password "$password" --email admin@users.invalid --system-admin --email-verified >/dev/null
  fi
  mmctl team search octogee 2>/dev/null | grep -q '"name": "octogee"' \
    || mmctl team create --name octogee --display-name Octogee --private >/dev/null
  mmctl team users add octogee "$user" >/dev/null
  local current
  current="$(k get secret mattermost-gateway -o jsonpath='{.data.admin_token}' | base64 -d)"
  if [[ -n "$current" ]]; then return; fi
  local token_json user_json team_json
  token_json="$(mmctl token generate "$user" "octogee platform admin PAT")"
  user_json="$(mmctl user search "$user")"
  team_json="$(mmctl team search octogee)"
  (umask 077; node --input-type=module - "$token_json" "$user_json" "$team_json" "$user" "$password" > "$STATE/secrets/mattermost-gateway.env") <<'JS'
import { createHash } from "node:crypto";
const [token, user, team, name, password] = process.argv.slice(2);
const first = text => { const value = JSON.parse(text); return Array.isArray(value) ? value[0] : value; };
const pat = first(token);
const values = {
  admin_user: name, admin_pass: password, admin_token: pat.token, admin_token_id: pat.id,
  admin_token_fingerprint: createHash("sha256").update(pat.token).digest("hex"),
  admin_user_id: first(user).id, team_id: first(team).id,
};
for (const [key, value] of Object.entries(values)) {
  if (!value) throw new Error(`Mattermost returned no ${key}`);
  console.log(`${key}=${value}`);
}
JS
  apply_secret mattermost-gateway --from-env-file="$STATE/secrets/mattermost-gateway.env"
}

gitea_curl() { k exec deploy/octogee-gitea -c gitea -- curl -sS "$@"; }

gitea_bootstrap() {
  k rollout status deployment/octogee-gitea --timeout=10m
  local password current token api=http://localhost:3000/api/v1
  password="$(cat "$STATE/secrets/gitea-admin-password")"
  k exec deploy/octogee-gitea -c gitea -- gitea admin user change-password \
    --username octogee-admin --password "$password" --must-change-password=false >/dev/null
  if [[ "$(gitea_curl -o /dev/null -w '%{http_code}' -u "octogee-admin:$password" "$api/orgs/octogee")" != 200 ]]; then
    gitea_curl -f -o /dev/null -u "octogee-admin:$password" -H 'Content-Type: application/json' \
      -d '{"username":"octogee","visibility":"private","repo_admin_change_team_access":true}' "$api/orgs"
  fi
  current="$(k get secret gitea-token -o jsonpath='{.data.token}' | base64 -d)"
  if [[ -n "$current" && "$(gitea_curl -o /dev/null -w '%{http_code}' -H "Authorization: token $current" "$api/user")" == 200 ]]; then
    return
  fi
  gitea_curl -o /dev/null -X DELETE -u "octogee-admin:$password" "$api/users/octogee-admin/tokens/octogee-gateway-token"
  token="$(k exec deploy/octogee-gitea -c gitea -- gitea admin user generate-access-token --raw \
    --username octogee-admin --token-name octogee-gateway-token \
    --scopes write:repository,write:issue,write:organization,write:user,write:admin)"
  [[ -n "$token" ]] || die "Gitea returned no API token"
  apply_secret gitea-token --from-literal=token="$token"
}

restart_platform() {
  k rollout restart deployment/glm-controller deployment/octogee-api deployment/gateway-router deployment/llm-broker >/dev/null
  k rollout status deployment/glm-controller --timeout=10m
  k rollout status deployment/octogee-api --timeout=10m
  k rollout status deployment/llm-broker --timeout=5m
}

fleet_config() {
  node -e '
    const [config, origin, script, key] = process.argv.slice(1);
    require("node:fs").writeFileSync(config, JSON.stringify({
      environments: { gke: { adminApiOrigin: origin, tokenCommand: ["node", script, key] } },
    }, null, 2) + "\n");
  ' "$STATE/fleet-config.json" "http://127.0.0.1:$ADMIN_PORT" "$ROOT/scripts/ops/operator-token.mjs" "$STATE/secrets/operator.pem"
}

up() {
  require_tools
  require_provider_key
  log "Google Cloud APIs, network and Cloud NAT in $GCP_PROJECT"
  enable_apis
  ensure_network
  ensure_cluster
  log "Cloud SQL"
  ensure_database
  log "Cloud Storage"
  ensure_buckets
  log "Images published at $SHORT"
  resolve_images
  environment_values
  log "Secrets"
  write_secrets
  log "Databases"
  prepare_databases
  log "Helm release"
  install_chart
  log "Agent models"
  apply_agent_models
  log "Mattermost"
  mattermost_bootstrap
  log "Gitea"
  gitea_bootstrap
  log "Platform"
  restart_platform
  fleet_config
  status
}

status() {
  k get pods -o wide
  cat <<EOF

Set these in every terminal you use for the cluster:
  export STATE=$STATE
  export OCTOGEE_FLEET_CONFIG=\$STATE/fleet-config.json

Keep the Admin API forwarded in a second terminal:
  kubectl --kubeconfig=\$STATE/kubeconfig --context=$KUBE_CONTEXT -n $NAMESPACE port-forward svc/glm-controller $ADMIN_PORT:8080

Then: octogee-fleet --env=gke gateway ls
EOF
}

down() {
  log "Deleting the platform in $GCP_PROJECT"
  if [[ -s "$KUBECONFIG_FILE" ]] && k get namespace "$NAMESPACE" >/dev/null 2>&1; then
    k delete namespace "$NAMESPACE" --wait=true --timeout=10m || true
  fi
  g container clusters delete "$NAME" --zone "$GCP_ZONE" 2>/dev/null || true
  g sql instances delete "$SQL_INSTANCE" 2>/dev/null || true
  local bucket id
  for bucket in "$ASSETS_BUCKET" "$WORKSPACES_BUCKET"; do
    g storage rm -r "gs://$bucket" 2>/dev/null || true
  done
  if blob_account_exists; then
    for id in $(g storage hmac list --service-account="$BLOB_EMAIL" --format='value(accessId)'); do
      g storage hmac update "$id" --deactivate >/dev/null && g storage hmac delete "$id" >/dev/null
    done
    g iam service-accounts delete "$BLOB_EMAIL" >/dev/null
  fi
  g services vpc-peerings delete --service=servicenetworking.googleapis.com --network="$NAME" 2>/dev/null || true
  g compute addresses delete "$NAME-sql" --global 2>/dev/null || true
  g compute routers delete "$NAME" --region "$GCP_REGION" 2>/dev/null || true
  g compute networks delete "$NAME" 2>/dev/null || true
  rm -rf "$STATE"
}

case "$COMMAND" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "Usage: GCP_PROJECT=<project> $0 {up|down|status} [--sha=SHA] [--manifest=FILE]" >&2; exit 2 ;;
esac
