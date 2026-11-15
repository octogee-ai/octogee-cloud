#!/usr/bin/env bash
# Install the platform on a local kind cluster: kind-install.sh up|down|status
# See docs/kind.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="octogee"
NAMESPACE="octogee-local"
BUILD=true
PULL=false
SHA=""
MANIFEST=""
CONTEXT_DIR="$ROOT"
OPENCLAW_DIR=""
IMAGES=""

log() { printf '\n== %s\n' "$*"; }
die() { printf 'kind-install: %s\n' "$*" >&2; exit 1; }

COMMAND="${1:-}"
[[ $# -gt 0 ]] && shift
for arg in "$@"; do
  case "$arg" in
    --name=*) NAME="${arg#*=}" ;;
    --skip-build) BUILD=false ;;
    --pull) PULL=true ;;
    --sha=*) SHA="${arg#*=}" ;;
    --manifest=*)
      MANIFEST="${arg#*=}"
      [[ -n "$MANIFEST" ]] || die "--manifest needs a path"
      ;;
    --context-dir=*) CONTEXT_DIR="$(cd "${arg#*=}" && pwd)" ;;
    --openclaw-dir=*) OPENCLAW_DIR="$(cd "${arg#*=}" && pwd)" ;;
    --images=*) IMAGES="${arg#*=}" ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done
if $PULL && ! $BUILD; then die "Choose either --pull or --skip-build"; fi
if [[ -n "$MANIFEST" ]] && ! $PULL; then die "--manifest needs --pull"; fi
if [[ -n "$SHA" ]]; then
  $PULL || die "--sha needs --pull"
  [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "--sha needs a full commit SHA"
fi

STATE="${OCTOGEE_KIND_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/octogee-kind}/$NAME"
KUBECONFIG_FILE="$STATE/kubeconfig"
KUBE_CONTEXT="kind-$NAME"
REGISTRY="octogee-kind-registry"
REGISTRY_PORT=5001
REGISTRY_IMAGE="registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e"
IMAGE_PREFIX="localhost:$REGISTRY_PORT/octogee/"
PUSH_PREFIX="$REGISTRY:5000/octogee/"
PUBLISHED="ghcr.io/octogee-ai/octogee-cloud"
BUILDER="octogee-cloud-kind"
ADMIN_PORT=18080
SHA="${SHA:-$(git -C "$ROOT" rev-parse HEAD)}"
SHORT="${SHA:0:7}"
case "$(uname -m)" in
  arm64|aarch64) PLATFORM=linux/arm64 ;;
  *) PLATFORM=linux/amd64 ;;
esac
ISOLATED_SKIPPED=false
if [[ -z "$IMAGES" ]]; then
  IMAGES="glm-controller,octogee-api,llm-broker,gateway-edge,octogee-gateway"
  if [[ "$PLATFORM" == linux/amd64 ]]; then IMAGES+=",octogee-gateway-builder"; else ISOLATED_SKIPPED=true; fi
fi

k() { kubectl --kubeconfig="$KUBECONFIG_FILE" --context="$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }
h() { helm --kubeconfig="$KUBECONFIG_FILE" --kube-context="$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }
random_hex() { openssl rand -hex "$1"; }

require_tools() {
  local tool
  for tool in docker kind kubectl helm node openssl ssh-keygen git; do
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

ensure_registry() {
  if [[ "$(docker inspect -f '{{.State.Running}}' "$REGISTRY" 2>/dev/null)" != true ]]; then
    docker rm -f "$REGISTRY" >/dev/null 2>&1 || true
    docker run -d --restart=always --name "$REGISTRY" -p "127.0.0.1:$REGISTRY_PORT:5000" "$REGISTRY_IMAGE" >/dev/null
  fi
}

ensure_cluster() {
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  if ! kind get clusters | grep -qx "$NAME"; then
    kind create cluster --name "$NAME" --kubeconfig "$KUBECONFIG_FILE" --config - <<EOF
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    labels:
      topology.kubernetes.io/region: kind
      topology.kubernetes.io/zone: kind-a
containerdConfigPatches:
  - |-
    [plugins."io.containerd.grpc.v1.cri".registry]
      config_path = "/etc/containerd/certs.d"
EOF
  else
    kind export kubeconfig --name "$NAME" --kubeconfig "$KUBECONFIG_FILE" >/dev/null
  fi
  local node
  for node in $(kind get nodes --name "$NAME"); do
    docker exec "$node" mkdir -p "/etc/containerd/certs.d/localhost:$REGISTRY_PORT"
    printf '[host."http://%s:5000"]\n' "$REGISTRY" | docker exec -i "$node" tee "/etc/containerd/certs.d/localhost:$REGISTRY_PORT/hosts.toml" >/dev/null
  done
  if [[ "$(docker inspect -f '{{json .NetworkSettings.Networks.kind}}' "$REGISTRY")" == null ]]; then
    docker network connect kind "$REGISTRY"
  fi
  kubectl --kubeconfig="$KUBECONFIG_FILE" --context="$KUBE_CONTEXT" create namespace "$NAMESPACE" --dry-run=client -o yaml \
    | kubectl --kubeconfig="$KUBECONFIG_FILE" --context="$KUBE_CONTEXT" apply -f - >/dev/null
}

stage_openclaw() {
  local tarballs="$CONTEXT_DIR/gateway/openclaw-tarball"
  if [[ -n "$OPENCLAW_DIR" ]]; then
    node "$ROOT/gateway/openclaw-tarball/fetch-release.mjs" --from="$OPENCLAW_DIR" --to="$tarballs"
  else
    node "$ROOT/gateway/openclaw-tarball/fetch-release.mjs" --to="$tarballs"
  fi
  bash "$ROOT/gateway/openclaw-tarball/extract-npm.sh" "$tarballs/openclaw-fork.tgz"
}

ensure_builder() {
  docker buildx inspect "$BUILDER" >/dev/null 2>&1 && return
  printf '[registry."%s:5000"]\n  http = true\n  insecure = true\n' "$REGISTRY" > "$STATE/buildkitd.toml"
  docker buildx create --name "$BUILDER" --driver docker-container --driver-opt network=kind \
    --buildkitd-config "$STATE/buildkitd.toml" --bootstrap >/dev/null
}

build_images() {
  local plan="$STATE/bake.json" metadata="$STATE/bake-metadata.json"
  stage_openclaw
  ensure_builder
  node "$ROOT/scripts/ci/cloud-build.mjs" plan --registry="$PUBLISHED" --sha="$SHA" \
    --platform="$PLATFORM" --root="$CONTEXT_DIR" --push --tag-prefix="$PUSH_PREFIX" --images="$IMAGES" > "$plan"
  docker buildx bake --builder="$BUILDER" --allow=fs.read="$CONTEXT_DIR" --file="$plan" --metadata-file="$metadata"
  node "$ROOT/scripts/ci/cloud-build.mjs" digests --platform="$PLATFORM" --metadata="$metadata" --images="$IMAGES" > "$STATE/digests.built.json"
  record_digests "$STATE/digests.built.json"
}

pull_images() {
  local options=(--images="$IMAGES")
  [[ -n "$MANIFEST" ]] && options+=(--manifest="$MANIFEST")
  node "$ROOT/scripts/ci/cloud-build.mjs" copy --registry="$PUBLISHED" --sha="$SHA" --platform="$PLATFORM" \
    --tag-prefix="$IMAGE_PREFIX" ${options[@]+"${options[@]}"} > "$STATE/digests.pulled.json"
  record_digests "$STATE/digests.pulled.json"
}

record_digests() {
  node -e '
    const fs = require("node:fs");
    const [all, latest, sha] = process.argv.slice(1);
    const fresh = JSON.parse(fs.readFileSync(latest, "utf8"));
    const previous = fs.existsSync(all) ? JSON.parse(fs.readFileSync(all, "utf8")) : { images: {} };
    const kept = previous.platform === fresh.platform ? previous.images : {};
    fs.writeFileSync(all, JSON.stringify({ platform: fresh.platform, sha, images: { ...kept, ...fresh.images } }, null, 2) + "\n");
  ' "$STATE/digests.json" "$1" "$SHA"
}

image_values() {
  node --input-type=module - "$STATE/digests.json" "$IMAGE_PREFIX" \
    "$(node -p "require('$ROOT/gateway/openclaw-tarball/current.json').sourceSha")" > "$STATE/images.yaml" <<'JS'
import { readFileSync } from "node:fs";
const [file, prefix, openclaw] = process.argv.slice(2);
const { sha, images } = JSON.parse(readFileSync(file, "utf8"));
if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error(`${file} names no source SHA; run up again without --skip-build`);
const tag = sha.slice(0, 7);
const required = ["glm-controller", "gateway-edge", "octogee-gateway"];
const missing = required.filter(name => !images[name]);
if (missing.length) throw new Error(`No image was built or copied for ${missing.join(", ")}`);
const image = name => ({ repository: `${prefix}${name}`, tag, digest: images[name] ?? `sha256:${"0".repeat(64)}` });
const isolatedImage = images["octogee-gateway-builder"] ? "octogee-gateway-builder" : "octogee-gateway";
console.log(JSON.stringify({
  ...(images["vm-bridge"] ? { global: { computer: { bridge: { image: image("vm-bridge") } } } } : {}),
  "octogee-api": { image: image("octogee-api"), ...(images["octogee-api"] ? {} : { replicas: 0 }) },
  llmBroker: images["llm-broker"] ? { image: image("llm-broker") } : { enabled: false },
  "gateway-edge": { image: image("gateway-edge") },
  "glm-controller": {
    image: image("glm-controller"),
    platformRelease: {
      sourceSha: sha,
      gatewayImageRepository: `${prefix}octogee-gateway`,
      gatewayImageTag: `${tag}@${images["octogee-gateway"]}`,
      builderImageTag: `${tag}@${images[isolatedImage]}`,
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
  local postgres mattermost gitea migration runtime agent root access secret
  postgres="$(secret_value postgres-password random_hex 16)"
  mattermost="$(secret_value mattermost-password random_hex 16)"
  gitea="$(secret_value gitea-password random_hex 16)"
  migration="$(secret_value platform-migration-password random_hex 16)"
  runtime="$(secret_value platform-runtime-password random_hex 16)"
  agent="$(secret_value agent-admin-password random_hex 16)"
  root="$(secret_value root-key openssl rand -base64 32)"
  access="$(secret_value s3-access-key random_hex 10)"
  secret="$(secret_value s3-secret-key random_hex 20)"
  apply_secret postgres-credentials --from-literal=postgres-password="$postgres" \
    --from-literal=mattermost-password="$mattermost" --from-literal=gitea-password="$gitea" \
    --from-literal=platform-migration-password="$migration" --from-literal=platform-runtime-password="$runtime" \
    --from-literal=agent-admin-password="$agent"
  apply_secret platform-state-postgres --from-literal=host=postgres --from-literal=port=5432 \
    --from-literal=database=octogee_platform --from-literal=sslmode=disable \
    --from-literal=migration-user=platform_migration --from-literal=migration-password="$migration" \
    --from-literal=runtime-user=platform_runtime --from-literal=runtime-password="$runtime"
  apply_secret agent-store-postgres \
    --from-literal=admin-dsn="postgres://agent_admin:$agent@postgres.$NAMESPACE.svc.cluster.local:5432/octogee_agents?sslmode=disable" \
    --from-literal=client-dsn="postgres://agent_client@postgres.$NAMESPACE.svc.cluster.local:5432/octogee_agents?sslmode=disable"
  apply_secret platform-root-key --from-literal=root-key="$root"
  apply_secret blob-store-s3 --from-literal=access-key-id="$access" --from-literal=secret-access-key="$secret" \
    --from-literal=s3.json="{\"identities\":[{\"name\":\"octogee\",\"credentials\":[{\"accessKey\":\"$access\",\"secretKey\":\"$secret\"}],\"actions\":[\"Admin\",\"Read\",\"Write\",\"List\",\"Tagging\"]}]}"
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
  if kind get clusters 2>/dev/null | grep -qx "$NAME"; then
    for pair in "${PROVIDER_KEYS[@]}"; do
      k get secret "octogee-${pair%%:*}" >/dev/null 2>&1 && return 0
    done
  fi
  printf '%s\n' \
    "kind-install: agents need a model provider key, and none is exported or stored in cluster $NAME." \
    "Export one of these and run up again. OpenRouter is recommended:" \
    "  OPENROUTER_API_KEY  https://openrouter.ai/keys" \
    "  OPENAI_API_KEY      https://platform.openai.com/api-keys" \
    "  ANTHROPIC_API_KEY   https://platform.claude.com/settings/keys" \
    "docs/kind.md lists the models each key gives agents." >&2
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

platform_sql() {
  k exec -i statefulset/postgres -- psql -U postgres -d octogee_platform -X -A -t -v ON_ERROR_STOP=1 "$@"
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
  if [[ -n "$owner" && "$owner" != kind-install ]]; then
    printf 'Keeping the agent models that %s set\n' "$owner"
    return
  fi
  platform_sql -v value="{\"builderAgentModelRef\":\"$primary\",\"builderAgentFallbackModelRef\":\"$fallback\",\"freeTierModelRef\":\"$house\"}" >/dev/null <<'SQL'
INSERT INTO platform.platform_config (key, value, updated_at, updated_by)
VALUES ('models', :'value'::jsonb, (extract(epoch FROM clock_timestamp()) * 1000)::bigint, 'kind-install')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
SQL
  printf 'Agents use %s, falling back to %s; the house model is %s\n' "$primary" "$fallback" "$house"
}

install_infrastructure() {
  k apply -f "$ROOT/scripts/ops/kind/infrastructure.yaml" >/dev/null
  k rollout status statefulset/postgres --timeout=5m
  k rollout status statefulset/seaweedfs --timeout=5m
  local bucket
  for bucket in octogee-assets octogee-workspaces; do
    echo "s3.bucket.create -name $bucket" | k exec -i statefulset/seaweedfs -- weed shell >/dev/null
  done
}

install_chart() {
  h upgrade --install octogee "$ROOT/charts/octogee" \
    -f "$ROOT/scripts/ops/kind/values.yaml" -f "$STATE/images.yaml" \
    --set "gitea.gitea.config.database.PASSWD=$(cat "$STATE/secrets/gitea-password")" \
    --timeout=10m
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
  k rollout restart deployment/glm-controller deployment/octogee-api deployment/gateway-router >/dev/null
  k rollout status deployment/glm-controller --timeout=10m
  k rollout status deployment/octogee-api --timeout=10m
  if k get deployment llm-broker >/dev/null 2>&1; then
    k rollout restart deployment/llm-broker >/dev/null
    k rollout status deployment/llm-broker --timeout=5m
  fi
}

up() {
  require_tools
  require_provider_key
  log "Cluster $KUBE_CONTEXT (kubeconfig $KUBECONFIG_FILE)"
  ensure_registry
  ensure_cluster
  if ($PULL || $BUILD) && $ISOLATED_SKIPPED; then
    printf 'Skipping octogee-gateway-builder: the isolated gateway image is published only for linux/amd64, so isolated gateways will not run on this %s host\n' "$PLATFORM"
  fi
  if $PULL; then
    log "Copying the $PLATFORM images published at $SHORT"
    pull_images
  elif $BUILD; then
    log "Building $PLATFORM images at $SHORT"
    build_images
  fi
  [[ -s "$STATE/digests.json" ]] || die "No images yet; run up without --skip-build, or with --pull"
  image_values
  log "Secrets"
  write_secrets
  log "PostgreSQL and SeaweedFS"
  install_infrastructure
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

fleet_config() {
  node -e '
    const [config, origin, script, key] = process.argv.slice(1);
    require("node:fs").writeFileSync(config, JSON.stringify({
      environments: { kind: { adminApiOrigin: origin, tokenCommand: ["node", script, key] } },
    }, null, 2) + "\n");
  ' "$STATE/fleet-config.json" "http://127.0.0.1:$ADMIN_PORT" "$ROOT/scripts/ops/operator-token.mjs" "$STATE/secrets/operator.pem"
}

status() {
  k get pods
  cat <<EOF

Set these in every terminal you use for the cluster:
  export STATE=$STATE
  export OCTOGEE_FLEET_CONFIG=\$STATE/fleet-config.json

Keep the Admin API forwarded in a second terminal:
  kubectl --kubeconfig=\$STATE/kubeconfig --context=$KUBE_CONTEXT -n $NAMESPACE port-forward svc/glm-controller $ADMIN_PORT:8080

Then: octogee-fleet --env=kind gateway ls
EOF
}

registry_in_use() {
  local node
  for node in $(kind get nodes --all-clusters 2>/dev/null); do
    if docker exec "$node" grep -qsF "http://$REGISTRY:5000" "/etc/containerd/certs.d/localhost:$REGISTRY_PORT/hosts.toml"; then
      return 0
    fi
  done
  return 1
}

down() {
  log "Deleting cluster $NAME and $STATE"
  kind delete cluster --name "$NAME" --kubeconfig "$KUBECONFIG_FILE"
  if registry_in_use; then
    printf 'Keeping registry %s: another kind cluster still pulls from it\n' "$REGISTRY"
  elif docker inspect "$REGISTRY" >/dev/null 2>&1; then
    docker rm -f "$REGISTRY" >/dev/null
  fi
  rm -rf "$STATE"
}

case "$COMMAND" in
  up) up ;;
  down) down ;;
  status) status ;;
  *) echo "Usage: $0 {up|down|status} [--name=NAME] [--skip-build | --pull [--sha=SHA] [--manifest=FILE]] [--images=A,B] [--context-dir=DIR] [--openclaw-dir=DIR]" >&2; exit 2 ;;
esac
