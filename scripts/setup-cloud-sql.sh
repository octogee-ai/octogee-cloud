#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/lib/deployment-target.sh
source "$SCRIPT_DIR/lib/deployment-target.sh"
source "$SCRIPT_DIR/lib/cloud-sql-backup-policy.sh"

SELECTOR=""
FORCE_ROTATE=false
for arg in "$@"; do
  case "$arg" in
    --env=*)
      [[ -n "$SELECTOR" ]] && { echo "Exactly one --env or --target is required" >&2; exit 1; }
      SELECTOR="--environment=${arg#*=}"
      ;;
    --target=*)
      [[ -n "$SELECTOR" ]] && { echo "Exactly one --env or --target is required" >&2; exit 1; }
      SELECTOR="$arg"
      ;;
    --rotate) FORCE_ROTATE=true ;;
    --help|-h)
      echo "Usage: $0 --env=prod|test | --target=TARGET_ID [--rotate]"
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done
[[ -z "$SELECTOR" ]] && { echo "Exactly one --env or --target is required" >&2; exit 1; }

octogee_load_deployment_target "$SELECTOR"
PROJECT="$TARGET_CLOUD_SQL_PROJECT"
INSTANCE="$TARGET_CLOUD_SQL_INSTANCE"
REGION="$TARGET_CLOUD_SQL_REGION"
DESIRED_PITR="$TARGET_CLOUD_SQL_PITR_ENABLED"
MATTERMOST_PASSWORD_SECRET="$TARGET_CLOUD_SQL_MATTERMOST_PASSWORD_SECRET"
GITEA_PASSWORD_SECRET="$TARGET_CLOUD_SQL_GITEA_PASSWORD_SECRET"
CONNECTION_NAME_SECRET="$TARGET_CLOUD_SQL_CONNECTION_NAME_SECRET"
[[ "$DESIRED_PITR" == "true" || "$DESIRED_PITR" == "false" ]] || {
  echo "Invalid Cloud SQL PITR setting for deployment target $TARGET_ID: $DESIRED_PITR" >&2
  exit 1
}

for command in gcloud jq openssl; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is unavailable: $command" >&2
    exit 1
  }
done

GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
log() { echo -e "${BLUE}[cloud-sql]${NC} $*" >&2; }
ok() { echo -e "${GREEN}[cloud-sql]${NC} ✅ $*" >&2; }
fail_prerequisites() {
  echo "WEST Terraform prerequisites are not converged for $TARGET_ID: $*" >&2
  echo "Run the exact-target Terraform bootstrap, confirm zero drift, then rerun setup-cloud-sql.sh." >&2
  exit 1
}

CLOUD_SQL_READY_MAX_ATTEMPTS=80
TEMP_DIR="$(mktemp -d -t octogee-cloud-sql-setup.XXXXXX)"
INSTANCE_JSON="$TEMP_DIR/instance.json"
cleanup() {
  find "$TEMP_DIR" -type f -delete
  rmdir "$TEMP_DIR"
}
trap cleanup EXIT

wait_for_cloud_sql() {
  local attempt state
  for ((attempt = 1; attempt <= CLOUD_SQL_READY_MAX_ATTEMPTS; attempt += 1)); do
    if gcloud sql instances describe "$INSTANCE" --project="$PROJECT" --format=json >"$INSTANCE_JSON"; then
      state="$(jq -r '.state // ""' "$INSTANCE_JSON")"
    else
      state="unavailable"
    fi
    if [[ "$state" == "RUNNABLE" ]]; then
      ok "Instance is RUNNABLE"
      return 0
    fi
    if [[ "$attempt" -eq "$CLOUD_SQL_READY_MAX_ATTEMPTS" ]]; then
      echo "Cloud SQL instance did not become RUNNABLE after $CLOUD_SQL_READY_MAX_ATTEMPTS attempts: $state" >&2
      return 1
    fi
    echo "  State: $state — waiting 15s..."
    sleep 15
  done
}

verify_terraform_prerequisites() {
  local database secret iam_member

  octogee_cloud_sql_backup_policy_matches "$REGION" "$DESIRED_PITR" < "$INSTANCE_JSON" \
    || fail_prerequisites "Cloud SQL settings, PITR, or backup policy drifted"

  for database in "mattermost_${TARGET_ENVIRONMENT}" "gitea_${TARGET_ENVIRONMENT}"; do
    gcloud sql databases describe "$database" \
      --instance="$INSTANCE" --project="$PROJECT" >/dev/null 2>&1 \
      || fail_prerequisites "database '$database' is absent"
  done

  for secret in "$MATTERMOST_PASSWORD_SECRET" "$GITEA_PASSWORD_SECRET" "$CONNECTION_NAME_SECRET"; do
    gcloud secrets describe "$secret" --project="$PROJECT" >/dev/null 2>&1 \
      || fail_prerequisites "Secret Manager container '$secret' is absent"
  done

  control_plane_project="$(node "$SCRIPT_DIR/lib/control-plane-config.mjs" project_id)" \
    || fail_prerequisites "control-plane project is not declared"
  release_identity="octogee-release-${TARGET_ENVIRONMENT}@${control_plane_project}.iam.gserviceaccount.com"
  iam_member="$(gcloud secrets get-iam-policy "$GITEA_PASSWORD_SECRET" \
    --project="$PROJECT" \
    --flatten='bindings[].members' \
    --filter="bindings.role=roles/secretmanager.secretAccessor AND bindings.members=serviceAccount:${release_identity}" \
    --format='value(bindings.members)' 2>/dev/null || true)"
  [[ "$iam_member" == *"$release_identity"* ]] \
    || fail_prerequisites "release identity secretAccessor IAM binding is absent"
}

sql_user_exists() {
  local user="$1" users
  users="$(gcloud sql users list --instance="$INSTANCE" --project="$PROJECT" --format='value(name)' 2>/dev/null)" \
    || return 1
  grep -qx "$user" <<<"$users"
}

secret_has_enabled_latest() {
  local secret="$1" state
  state="$(gcloud secrets versions describe latest --secret="$secret" \
    --project="$PROJECT" --format='value(state)' 2>/dev/null || true)"
  [[ "$state" == "ENABLED" ]]
}

access_secret() {
  gcloud secrets versions access latest --secret="$1" --project="$PROJECT"
}

add_secret_version() {
  local secret="$1" value="$2"
  printf '%s' "$value" | gcloud secrets versions add "$secret" \
    --data-file=- --project="$PROJECT" --format='value(name)'
}

disable_secret_version() {
  local secret="$1" version="$2"
  gcloud secrets versions disable "$version" --secret="$secret" --project="$PROJECT" --quiet >/dev/null
}

rollback_candidate_secret_version() {
  local secret="$1" version="$2" failure="$3"
  if disable_secret_version "$secret" "$version"; then
    return 0
  fi
  echo "CRITICAL: $failure and candidate version $version of '$secret' remains enabled" >&2
  echo "Disable that exact Secret Manager version, then rerun setup-cloud-sql.sh for $TARGET_ID." >&2
  return 1
}

reconcile_user_pair() {
  local user="$1" secret="$2" user_exists=false secret_exists=false password old_password candidate_name candidate_version action
  sql_user_exists "$user" && user_exists=true
  secret_has_enabled_latest "$secret" && secret_exists=true

  if ! $FORCE_ROTATE && $user_exists && $secret_exists; then
    ok "User '$user' and enabled secret '$secret' verified; preserving"
    printf '%s' "preserved"
    return 0
  fi

  if ! $FORCE_ROTATE && ! $user_exists && $secret_exists; then
    password="$(access_secret "$secret")"
    log "Creating missing SQL user '$user' from retained secret material"
    gcloud sql users create "$user" --instance="$INSTANCE" --project="$PROJECT" --password="$password"
    ok "Repaired SQL user '$user'"
    printf '%s' "repaired-user"
    return 0
  fi

  if $user_exists && $secret_exists; then
    action="rotated"
    old_password="$(access_secret "$secret")"
    password="$(openssl rand -hex 16)"
    log "Rotating SQL user '$user'"
    if ! gcloud sql users set-password "$user" \
      --instance="$INSTANCE" --project="$PROJECT" --password="$password"; then
      echo "SQL password update failed; retained the prior secret version for '$secret'" >&2
      return 1
    fi
    if ! add_secret_version "$secret" "$password" >/dev/null; then
      if ! gcloud sql users set-password "$user" \
        --instance="$INSTANCE" --project="$PROJECT" --password="$old_password"; then
        echo "CRITICAL: secret update failed and the prior SQL password could not be restored for '$user'" >&2
        return 1
      fi
      echo "Secret update failed; restored the prior SQL password for '$user'" >&2
      return 1
    fi
  else
    password="$(openssl rand -hex 16)"
    candidate_name="$(add_secret_version "$secret" "$password")"
    candidate_version="${candidate_name##*/}"
    [[ -n "$candidate_version" && "$candidate_version" != "$candidate_name" ]] || {
      echo "Secret Manager did not return a version name for '$secret'" >&2
      return 1
    }

    if $user_exists; then
      action="rotated"
      log "Rotating SQL user '$user'"
      if ! gcloud sql users set-password "$user" \
        --instance="$INSTANCE" --project="$PROJECT" --password="$password"; then
        rollback_candidate_secret_version "$secret" "$candidate_version" "SQL password update failed" || return 1
        echo "SQL password update failed; disabled candidate version $candidate_version for '$secret'" >&2
        return 1
      fi
    else
      action="created"
      log "Creating SQL user '$user'"
      if ! gcloud sql users create "$user" \
        --instance="$INSTANCE" --project="$PROJECT" --password="$password"; then
        rollback_candidate_secret_version "$secret" "$candidate_version" "SQL user creation failed" || return 1
        echo "SQL user creation failed; disabled candidate version $candidate_version for '$secret'" >&2
        return 1
      fi
    fi
  fi

  ok "Credential pair for '$user' is $action"
  printf '%s' "$action"
}

reconcile_connection_name() {
  local expected="$1" current=""
  if secret_has_enabled_latest "$CONNECTION_NAME_SECRET"; then
    current="$(access_secret "$CONNECTION_NAME_SECRET")"
  fi
  if [[ "$current" == "$expected" ]]; then
    ok "Cloud SQL connection-name secret verified; preserving"
    printf '%s' "preserved"
    return 0
  fi
  add_secret_version "$CONNECTION_NAME_SECRET" "$expected" >/dev/null
  ok "Cloud SQL connection-name secret updated"
  printf '%s' "updated"
}

log "Waiting for $INSTANCE to be RUNNABLE"
wait_for_cloud_sql
verify_terraform_prerequisites
ok "Terraform-owned Cloud SQL infrastructure verified"

MATTERMOST_RESULT="$(reconcile_user_pair mattermost "$MATTERMOST_PASSWORD_SECRET")"
GITEA_RESULT="$(reconcile_user_pair gitea "$GITEA_PASSWORD_SECRET")"
CONNECTION_NAME="$(jq -r '.connectionName // ""' "$INSTANCE_JSON")"
[[ -n "$CONNECTION_NAME" ]] || fail_prerequisites "Cloud SQL connection name is absent"
CONNECTION_RESULT="$(reconcile_connection_name "$CONNECTION_NAME")"

sql_user_exists mattermost || { echo "Mattermost SQL user verification failed" >&2; exit 1; }
sql_user_exists gitea || { echo "Gitea SQL user verification failed" >&2; exit 1; }
secret_has_enabled_latest "$MATTERMOST_PASSWORD_SECRET" || { echo "Mattermost password secret verification failed" >&2; exit 1; }
secret_has_enabled_latest "$GITEA_PASSWORD_SECRET" || { echo "Gitea password secret verification failed" >&2; exit 1; }
secret_has_enabled_latest "$CONNECTION_NAME_SECRET" || { echo "Connection-name secret verification failed" >&2; exit 1; }

jq -cn \
  --arg target "$TARGET_ID" \
  --arg project "$PROJECT" \
  --arg instance "$INSTANCE" \
  --arg mattermost "$MATTERMOST_RESULT" \
  --arg gitea "$GITEA_RESULT" \
  --arg connection "$CONNECTION_RESULT" \
  '{target:$target,project:$project,instance:$instance,infrastructureVerified:true,credentialMaterialVerified:false,credentialMaterialStatus:"reconciled-not-authenticated",users:{mattermost:$mattermost,gitea:$gitea},connectionNameSecret:$connection}'
