#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
# Pre-deploy secret verification
# ═══════════════════════════════════════════════════════════════════════════
#
# Checks required K8s secrets, critical values, and platform signing keypairs.
# Run this in CI before deploy, or locally before manual helm commands.
#
# Required secrets include Helm startup dependencies and product integrations
# that must fail closed before a release is considered operational:
#   - gateway/templates/deployment.yaml  (secretKeyRef without optional: true)
#   - gateway-edge/values.yaml          (optional: false)
#   - gateway-edge/values.yaml           (optional: false)
#
# Usage:
#   ./scripts/verify-secrets.sh --env=prod [--deployment-target=prod-west]
#   ./scripts/verify-secrets.sh --env=test [--context=<kube-context>]
#   ./scripts/verify-secrets.sh --env=custom --namespace=feat-alice
#   ./scripts/verify-secrets.sh --env=test --phase=bootstrap   # before the first Helm install
#
# Exit codes:
#   0 — required secrets, values and signing keypairs verified
#   1 — missing secrets or invalid required values/keypairs
# ═══════════════════════════════════════════════════════════════════════════

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BOLD='\033[1m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/shell-env.sh
source "$SCRIPT_DIR/lib/shell-env.sh"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"
source "$SCRIPT_DIR/lib/signature-key-validation.sh"
# shellcheck source=scripts/lib/secret-extensions.sh
source "$SCRIPT_DIR/lib/secret-extensions.sh"
load_secret_extensions "$SCRIPT_DIR"

ENV=""
KUBE_CTX=""
CUSTOM_NS=""
DEPLOYMENT_TARGET=""
PHASE="launch"

for arg in "$@"; do
  case $arg in
    --env=*)       ENV="${arg#*=}" ;;
    --deployment-target=*) DEPLOYMENT_TARGET="${arg#*=}" ;;
    --namespace=*) CUSTOM_NS="${arg#*=}" ;;
    --context=*)   KUBE_CTX="${arg#*=}" ;;
    --phase=*)     PHASE="${arg#*=}" ;;
    --help|-h)     echo "Usage: $0 --env=prod|test|custom [--deployment-target=TARGET] [--namespace=NAME] [--context=<kube-context>] [--phase=bootstrap|launch]"; exit 0 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

[[ -z "$ENV" ]] && { echo "Usage: $0 --env=prod|test|custom [--namespace=NAME]"; exit 1; }
case "$PHASE" in
  bootstrap|launch) ;;
  *) echo "--phase must be bootstrap or launch"; exit 1 ;;
esac

TARGET_ENV="$ENV"
[[ "$TARGET_ENV" == "custom" ]] && TARGET_ENV="test"
if [[ -n "$DEPLOYMENT_TARGET" ]]; then
  [[ "$ENV" == "custom" ]] && { echo "--deployment-target cannot be used with --env=custom"; exit 1; }
  octogee_load_deployment_target "--target=$DEPLOYMENT_TARGET"
  [[ "$TARGET_ENVIRONMENT" != "$TARGET_ENV" ]] && {
    echo "Deployment target '$DEPLOYMENT_TARGET' does not belong to environment '$ENV'"
    exit 1
  }
else
  octogee_load_deployment_target "--environment=$TARGET_ENV"
fi
NS="$TARGET_NAMESPACE"
[[ -z "$KUBE_CTX" ]] && KUBE_CTX="$TARGET_KUBE_CONTEXT"

case "$ENV" in
  prod|test) ;;
  custom)
    [[ -z "$CUSTOM_NS" ]] && { echo "--env=custom requires --namespace=NAME"; exit 1; }
    [[ "$CUSTOM_NS" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "Invalid namespace '$CUSTOM_NS'"; exit 1; }
    NS="$CUSTOM_NS"
    ;;
  *) echo "Unknown environment: $ENV"; exit 1 ;;
esac

# ── Required secrets ────────────────────────────────────────────────────────
# These cause CreateContainerConfigError if missing (not marked optional).
# Keep in sync with:
#   charts/octogee/charts/gateway/templates/deployment.yaml
#   charts/octogee/charts/gateway-edge/values.yaml
REQUIRED_SECRETS=(
  "agent-store-postgres"
  "octogee-anthropic"       # setup/legacy only; gateway pods do not mount it
  "octogee-openrouter"      # llm-broker + dedicated Ops Agent
  "gateway-model-key-issuer" # glm-controller ↔ octogee-api model broker token issuer
  "ops-agent-bearer"        # octogee-api → octogee-ops-agent
  "social-notification-bearer"  # octogee-api /social + Cloud Functions social producer
  "mattermost-gateway"      # octogee-api + glm-controller; gateway pods do not mount admin_token
  "google-oauth"             # octogee-api: Google OAuth + Drive picker
  "connect-state-secret"     # octogee-api: OAuth state HMAC
  "gitea-token"             # octogee-api + glm-controller
  "agent-control-router"    # private Mattermost callback-router → gateway-edge Ed25519
  "byot-sync-internal"      # octogee-api → gateway-edge model sync Ed25519
)

# ── Critical keys within secrets ────────────────────────────────────────────
# These are the most common source of "secret exists but value is empty" drift.
# Format: "secret_name:key_name:fix_script"
# Suffix passed to fix-script hints — includes --namespace for custom env.
FIX_SUFFIX="--env=${ENV}"
[[ "$ENV" == "custom" ]] && FIX_SUFFIX="--env=custom --namespace=${CUSTOM_NS}"

REQUIRED_KEYS=(
  "agent-store-postgres:admin-dsn:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "agent-store-postgres:client-dsn:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "mattermost-gateway:admin_token:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "mattermost-gateway:admin_token_id:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "mattermost-gateway:admin_token_fingerprint:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "mattermost-gateway:team_id:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "mattermost-gateway:admin_user:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "mattermost-gateway:admin_pass:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "mattermost-gateway:admin_user_id:./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  "gateway-model-key-issuer:bearer_token:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "ops-agent-bearer:bearer_token:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "social-notification-bearer:bearer-token:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "octogee-anthropic:api_key:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "octogee-openrouter:api_key:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "agent-control-router:secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "agent-control-router:public-key:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "byot-sync-internal:secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "byot-sync-internal:public-key:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "google-oauth:client_id:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "google-oauth:client_secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "google-oauth:picker_client_id:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "google-oauth:picker_api_key:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "google-oauth:picker_app_id:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
  "connect-state-secret:secret:./scripts/setup-secrets.sh ${FIX_SUFFIX}"
)

# ── Optional-but-important secrets (warn only) ──────────────────────────────
OPTIONAL_SECRETS=(
  "mattermost-cloud-sql"
  "octogee-brave"
  "octogee-tavily"
  "octogee-github"
  "gitea-admin"
  "gitea-credentials"
)

run_secret_steps ${SECRET_VERIFY_REGISTRATIONS[@]+"${SECRET_VERIFY_REGISTRATIONS[@]}"}

if [[ "$ENV" != custom ]]; then
  REQUIRED_SECRETS+=("platform-state-postgres")
  for platform_state_key in host database sslmode migration-user migration-password runtime-user runtime-password; do
    REQUIRED_KEYS+=("platform-state-postgres:${platform_state_key}:./scripts/setup-secrets.sh ${FIX_SUFFIX}")
  done
fi

echo ""
echo -e "${BOLD}Pre-deploy secret check — ${ENV} (${PHASE})${NC}"
echo -e "Namespace: ${NS} | Context: ${KUBE_CTX}"
echo ""

FAILURES=0

# ── Check secret existence ──────────────────────────────────────────────────
echo -e "${BOLD}Required secrets:${NC}"
for secret in "${REQUIRED_SECRETS[@]}"; do
  if kubectl get secret "$secret" -n "$NS" --context "$KUBE_CTX" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $secret"
  else
    echo -e "  ${RED}✗${NC} $secret — ${RED}MISSING${NC}"
    FAILURES=$((FAILURES + 1))
  fi
done

# ── Check critical key values ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}Required keys (non-empty):${NC}"
for entry in "${REQUIRED_KEYS[@]}"; do
  IFS=':' read -r secret key fix <<< "$entry"

  if [[ "$PHASE" == "bootstrap" && "$secret" == "mattermost-gateway" ]]; then
    echo -e "  ${YELLOW}↷${NC} ${secret}/${key} — skipped (set by setup-mattermost.sh after Helm)"
    continue
  fi

  # Skip key check if the secret itself is missing (already reported above)
  if ! kubectl get secret "$secret" -n "$NS" --context "$KUBE_CTX" >/dev/null 2>&1; then
    continue
  fi

  VAL_B64=$(kubectl get secret "$secret" -n "$NS" --context "$KUBE_CTX" \
    -o jsonpath="{.data.${key}}" 2>/dev/null || echo "")

  VALUE=""
  [[ -n "$VAL_B64" ]] && VALUE="$(printf '%s' "$VAL_B64" | base64 -d 2>/dev/null || true)"

  if [[ -z "$(configured_secret_value "$VALUE")" ]]; then
    echo -e "  ${RED}✗${NC} ${secret}/${key} — ${RED}EMPTY${NC}"
    echo -e "    Fix: ${fix}"
    FAILURES=$((FAILURES + 1))
  elif INVALID_REASON="$(secret_key_invalid_reason "$secret" "$key" "$VALUE")" && [[ -n "$INVALID_REASON" ]]; then
    echo -e "  ${RED}✗${NC} ${secret}/${key} — ${RED}${INVALID_REASON}${NC}"
    echo -e "    Fix: ${fix}"
    FAILURES=$((FAILURES + 1))
  else
    echo -e "  ${GREEN}✓${NC} ${secret}/${key}"
  fi
done

for secret in agent-control-router byot-sync-internal; do
  if ! SIGNING_PRIVATE_KEY="$(kubectl get secret "$secret" -n "$NS" --context "$KUBE_CTX" \
      -o jsonpath='{.data.secret}' 2>/dev/null | base64 -d 2>/dev/null)" \
    || ! SIGNING_PUBLIC_KEY="$(kubectl get secret "$secret" -n "$NS" --context "$KUBE_CTX" \
      -o jsonpath='{.data.public-key}' 2>/dev/null | base64 -d 2>/dev/null)" \
    || ! validate_ed25519_keypair "$SIGNING_PRIVATE_KEY" "$SIGNING_PUBLIC_KEY"; then
    echo -e "  ${RED}✗${NC} ${secret} — INVALID Ed25519 keypair (missing, unreadable, mismatched or wrong algorithm)"
    echo -e "    Fix: ./scripts/setup-secrets.sh ${FIX_SUFFIX}"
    FAILURES=$((FAILURES + 1))
  else
    echo -e "  ${GREEN}✓${NC} ${secret} — matching Ed25519 keypair"
  fi
done
unset SIGNING_PRIVATE_KEY SIGNING_PUBLIC_KEY

MM_K8S_PASSWORD_FILE=$(mktemp)
MM_SM_PASSWORD_FILE=$(mktemp)
kubectl get secret mattermost-cloud-sql -n "$NS" --context "$KUBE_CTX" \
  -o jsonpath='{.data.password}' 2>/dev/null | base64 -d > "$MM_K8S_PASSWORD_FILE" 2>/dev/null || true
gcloud secrets versions access latest \
  --secret="$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET" \
  --project="$TARGET_CLOUD_SQL_PROJECT" > "$MM_SM_PASSWORD_FILE" 2>/dev/null || true

if [[ ! -s "$MM_K8S_PASSWORD_FILE" ]]; then
  echo -e "  ${RED}✗${NC} mattermost-cloud-sql/password — ${RED}MISSING OR EMPTY${NC}"
  echo -e "    Fix: ./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  FAILURES=$((FAILURES + 1))
elif [[ ! -s "$MM_SM_PASSWORD_FILE" ]]; then
  echo -e "  ${RED}✗${NC} ${TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET} — ${RED}MISSING OR EMPTY${NC}"
  FAILURES=$((FAILURES + 1))
elif ! cmp -s "$MM_K8S_PASSWORD_FILE" "$MM_SM_PASSWORD_FILE"; then
  echo -e "  ${RED}✗${NC} mattermost-cloud-sql/password differs from Secret Manager"
  echo -e "    Fix: ./scripts/setup-mattermost.sh ${FIX_SUFFIX}"
  FAILURES=$((FAILURES + 1))
else
  echo -e "  ${GREEN}✓${NC} mattermost-cloud-sql/password matches Secret Manager"
fi
rm -f "$MM_K8S_PASSWORD_FILE" "$MM_SM_PASSWORD_FILE"

run_secret_steps ${SECRET_VERIFY_CHECKS[@]+"${SECRET_VERIFY_CHECKS[@]}"}


echo ""
echo -e "${BOLD}Optional secrets:${NC}"
for secret in "${OPTIONAL_SECRETS[@]}"; do
  if kubectl get secret "$secret" -n "$NS" --context "$KUBE_CTX" >/dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} $secret"
  else
    echo -e "  ${YELLOW}⚠${NC} $secret — missing (optional, won't block deploy)"
  fi
done

echo ""

if [[ "$FAILURES" -gt 0 ]]; then
  echo -e "${RED}${BOLD}❌ ${FAILURES} issue(s) found — deploy will fail!${NC}"
  echo ""
  if [[ "$ENV" == "custom" ]]; then
    echo "  Quick fix: ./scripts/provision-namespace.sh ${CUSTOM_NS} --yes"
  else
    echo "  Quick fix: ./scripts/setup-secrets.sh --env=${ENV}"
  fi
  echo ""
  exit 1
else
  echo -e "${GREEN}${BOLD}✅ Required secrets, values and signing keypairs verified${NC}"
  echo ""
  exit 0
fi
