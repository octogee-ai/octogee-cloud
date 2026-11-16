#!/bin/bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_USER="platformadmin"
TEAM_NAME="platform"
BOT_NAME="agent"
TRAEFIK_CHART_VERSION="42.3.1"
GITEA_CHART_VERSION="12.7.0"
CERT_MANAGER_VERSION="v1.21.3"
AWS_CLI_IMAGE="amazon/aws-cli:2.34.0"
POSTGRES_IMAGE="pgvector/pgvector:pg16"
CHAT_FORWARD_PORT="18065"
CHAT_API="http://127.0.0.1:${CHAT_FORWARD_PORT}/api/v4"

die() {
  echo "error: $*" >&2
  exit 1
}

step() {
  echo
  echo "==> $*"
}

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "${tool}" >/dev/null 2>&1 || die "'${tool}' is not installed; see docs/requirements.md"
  done
}

k() {
  kubectl --context "${KUBE_CONTEXT}" -n "${NAMESPACE}" "$@"
}

h() {
  helm --kube-context "${KUBE_CONTEXT}" -n "${NAMESPACE}" "$@"
}

random_hex() {
  openssl rand -hex 24
}

secret_value() {
  k get secret "${1}" -o "jsonpath={.data.${2}}" | base64 -d
}

wait_ready() {
  k rollout status "${1}" --timeout="${2:-300s}"
}

mmctl_local() {
  k exec deploy/mattermost -- /mattermost/bin/mmctl --local "$@"
}

ensure_namespace() {
  kubectl --context "${KUBE_CONTEXT}" get namespace "${NAMESPACE}" >/dev/null 2>&1 \
    || kubectl --context "${KUBE_CONTEXT}" create namespace "${NAMESPACE}" >/dev/null
}

ensure_credentials() {
  k get secret platform-credentials >/dev/null 2>&1 && return 0
  k create secret generic platform-credentials \
    --from-literal=username="${ADMIN_USER}" \
    --from-literal=password="$(random_hex)" \
    --from-literal=postgres-password="$(random_hex)" \
    --from-literal=mattermost-db-password="$(random_hex)" \
    --from-literal=gitea-db-password="$(random_hex)" \
    --from-literal=platform-db-password="$(random_hex)" \
    --from-literal=gateway-token="$(random_hex)" >/dev/null
}

apply_settings() {
  k create configmap platform-settings \
    --from-literal=chat-url="${PUBLIC_SCHEME}://${CHAT_HOST}${PUBLIC_PORT_SUFFIX}" \
    --from-literal=db-host="${DB_HOST}" \
    --from-literal=db-admin-user="${DB_ADMIN_USER}" \
    --from-literal=db-sslmode="${DB_SSLMODE}" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
}

model_for_key() {
  case "${1}" in
    ANTHROPIC_API_KEY) echo "anthropic/claude-opus-5-5" ;;
    OPENAI_API_KEY) echo "openai/gpt-6-astra" ;;
    GEMINI_API_KEY) echo "google/gemini-3.6-flash" ;;
    OPENROUTER_API_KEY) echo "openrouter/auto" ;;
  esac
}

apply_model_keys() {
  local name value model="${AGENT_MODEL:-}" names="" args=()
  for name in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY; do
    value="$(printenv "${name}" || true)"
    if [ -n "${value}" ]; then
      args+=("--from-literal=${name}=${value}")
      names="${names} ${name}"
      [ -n "${model}" ] || model="$(model_for_key "${name}")"
    fi
  done
  [ "${#args[@]}" -gt 0 ] || return 0
  args+=("--from-literal=AGENT_MODEL=${model}")
  if [ -n "${AGENT_THINKING:-}" ]; then
    args+=("--from-literal=AGENT_THINKING=${AGENT_THINKING}")
  fi
  step "Copying model keys into the cluster:${names}"
  k create secret generic platform-model-keys "${args[@]}" --dry-run=client -o yaml | k apply -f - >/dev/null
  if k get deploy/gateway >/dev/null 2>&1; then
    k rollout restart deploy/gateway >/dev/null
  fi
}

write_object_store() {
  k create secret generic object-store \
    --from-literal=endpoint-url="${1}" \
    --from-literal=bucket="${2}" \
    --from-literal=region="${3}" \
    --from-literal=access-key="${4}" \
    --from-literal=secret-key="${5}" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
}

object_store_env() {
  cat <<JSON
{"name":"AWS_ACCESS_KEY_ID","valueFrom":{"secretKeyRef":{"name":"object-store","key":"access-key"}}},
{"name":"AWS_SECRET_ACCESS_KEY","valueFrom":{"secretKeyRef":{"name":"object-store","key":"secret-key"}}},
{"name":"AWS_ENDPOINT_URL","valueFrom":{"secretKeyRef":{"name":"object-store","key":"endpoint-url"}}},
{"name":"AWS_DEFAULT_REGION","valueFrom":{"secretKeyRef":{"name":"object-store","key":"region"}}},
{"name":"BUCKET","valueFrom":{"secretKeyRef":{"name":"object-store","key":"bucket"}}},
{"name":"AWS_REQUEST_CHECKSUM_CALCULATION","value":"when_required"},
{"name":"AWS_RESPONSE_CHECKSUM_VALIDATION","value":"when_required"}
JSON
}

create_route() {
  local name="${1}" host="${2}" backend="${3}" rule args=()
  rule="${host}/*=${backend}"
  if [ "${PUBLIC_SCHEME}" = "https" ]; then
    rule="${rule},tls=${name}-tls"
    args+=("--annotation=cert-manager.io/cluster-issuer=letsencrypt")
    args+=("--annotation=traefik.ingress.kubernetes.io/router.entrypoints=websecure")
  fi
  k create ingress "${name}" --class=traefik --rule="${rule}" ${args[@]+"${args[@]}"} \
    --dry-run=client -o yaml | k apply -f - >/dev/null
}

prepare_databases() {
  step "Databases"
  local password
  password="$(secret_value platform-credentials mattermost-db-password)"
  k create secret generic mattermost-database \
    --from-literal=dsn="postgres://mattermost:${password}@${DB_HOST}:5432/mattermost?sslmode=${DB_SSLMODE}&connect_timeout=10" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  k delete job database-setup --ignore-not-found >/dev/null
  k apply -f "${DEPLOY_DIR}/manifests/database-setup.yaml" >/dev/null
  k wait --for=condition=complete job/database-setup --timeout=300s >/dev/null \
    || die "database setup failed; see: kubectl logs job/database-setup -n ${NAMESPACE}"
}

install_ingress() {
  step "Ingress (Traefik)"
  h upgrade --install traefik traefik \
    --repo https://traefik.github.io/charts --version "${TRAEFIK_CHART_VERSION}" \
    --values "${DEPLOY_DIR}/values/traefik.yaml" \
    --set "providers.kubernetesIngress.namespaces[0]=${NAMESPACE}" \
    "$@" --wait --timeout 8m >/dev/null
}

install_git() {
  step "Git host (Gitea)"
  h upgrade --install gitea gitea \
    --repo https://dl.gitea.com/charts/ --version "${GITEA_CHART_VERSION}" \
    --values "${DEPLOY_DIR}/values/gitea.yaml" \
    --set-string "gitea.config.server.DOMAIN=${GIT_HOST}" \
    --set-string "gitea.config.server.ROOT_URL=${PUBLIC_SCHEME}://${GIT_HOST}${PUBLIC_PORT_SUFFIX}/" \
    --set-string "gitea.config.database.HOST=${DB_HOST}:5432" \
    --set-string "gitea.config.database.SSL_MODE=${DB_SSLMODE}" \
    --wait --timeout 10m >/dev/null
  create_route gitea "${GIT_HOST}" gitea-http:3000
}

json_field() {
  sed -n "s/.*\"${1}\":\"\([^\"]*\)\".*/\1/p"
}

chat_api() {
  curl -fsS --max-time 30 -H "Content-Type: application/json" "$@"
}

open_chat_forward() {
  k port-forward svc/mattermost "${CHAT_FORWARD_PORT}:8065" >/dev/null 2>&1 &
  CHAT_FORWARD_PID="${!}"
  trap 'kill "${CHAT_FORWARD_PID}" 2>/dev/null || true' EXIT
  local attempt=0
  until curl -fsS --max-time 2 "${CHAT_API}/system/ping" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    [ "${attempt}" -lt 60 ] || die "could not reach Mattermost through a port-forward"
    sleep 1
  done
}

close_chat_forward() {
  kill "${CHAT_FORWARD_PID}" 2>/dev/null || true
  trap - EXIT
}

ensure_bot_token() {
  k get secret gateway-bot >/dev/null 2>&1 && return 0
  local session bot_id bot_token
  session="$(chat_api -i -d "{\"login_id\":\"${ADMIN_USER}\",\"password\":\"${1}\"}" \
    "${CHAT_API}/users/login" | tr -d '\r' | sed -n 's/^[Tt]oken: //p')"
  [ -n "${session}" ] || die "could not sign in to Mattermost as ${ADMIN_USER}"
  bot_id="$(chat_api -H "Authorization: Bearer ${session}" "${CHAT_API}/users/username/${BOT_NAME}" 2>/dev/null | json_field id || true)"
  if [ -z "${bot_id}" ]; then
    bot_id="$(chat_api -H "Authorization: Bearer ${session}" \
      -d "{\"username\":\"${BOT_NAME}\",\"display_name\":\"Agent\"}" "${CHAT_API}/bots" | json_field user_id)"
  fi
  [ -n "${bot_id}" ] || die "Mattermost did not return a bot id"
  bot_token="$(chat_api -H "Authorization: Bearer ${session}" \
    -d '{"description":"gateway"}' "${CHAT_API}/users/${bot_id}/tokens" | json_field token)"
  [ -n "${bot_token}" ] || die "Mattermost did not return a bot token"
  k create secret generic gateway-bot --from-literal=token="${bot_token}" >/dev/null
}

install_chat() {
  step "Chat (Mattermost)"
  k apply -f "${DEPLOY_DIR}/manifests/mattermost.yaml" >/dev/null
  k rollout restart deploy/mattermost >/dev/null
  wait_ready deploy/mattermost 900s
  create_route mattermost "${CHAT_HOST}" mattermost:8065
  local admin_password
  admin_password="$(secret_value platform-credentials password)"
  if ! mmctl_local user search "${ADMIN_USER}" 2>/dev/null | grep -qw "${ADMIN_USER}"; then
    mmctl_local user create --email "${ADMIN_EMAIL}" --username "${ADMIN_USER}" \
      --password "${admin_password}" --system-admin >/dev/null
  fi
  if ! mmctl_local team search "${TEAM_NAME}" 2>/dev/null | grep -qw "${TEAM_NAME}"; then
    mmctl_local team create --name "${TEAM_NAME}" --display-name "Platform" >/dev/null
  fi
  open_chat_forward
  ensure_bot_token "${admin_password}"
  close_chat_forward
  mmctl_local team users add "${TEAM_NAME}" "${ADMIN_USER}" "${BOT_NAME}" >/dev/null
}

install_gateway() {
  step "OpenClaw gateway"
  k create secret generic gateway-environment \
    --from-literal=OPENCLAW_GATEWAY_TOKEN="$(secret_value platform-credentials gateway-token)" \
    --from-literal=MATTERMOST_BOT_TOKEN="$(secret_value gateway-bot token)" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  k apply -f "${DEPLOY_DIR}/manifests/gateway.yaml" >/dev/null
  wait_ready deploy/gateway 600s
}

install_apps() {
  install_git
  install_chat
  install_gateway
}
