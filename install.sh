#!/bin/bash
set -euo pipefail

REPOSITORY="${OCTOGEE_CLOUD_REPOSITORY:-https://github.com/octogee-ai/octogee-cloud.git}"
REF="${OCTOGEE_CLOUD_REF:-main}"
INSTALL_DIR="${OCTOGEE_CLOUD_DIR:-${HOME}/octogee-cloud}"
MIN_DOCKER_GIB=8

TARGET=""
ASSUME_YES=0
CHECK_ONLY=0
NO_PROMPT="${OCTOGEE_CLOUD_NO_PROMPT:-0}"
PLATFORM=""
PACKAGES=""
FAILURES=0
CHECKOUT=""

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  say "Install Octogee Cloud."
  say ""
  say "Usage: install.sh [--target=local|gcp|aws] [--check-only] [--yes] [--no-prompt]"
  say ""
  say "  --target=local   the foundation in Docker on this machine, for trying it out"
  say "  --target=gcp     the foundation on GKE, Cloud SQL and Cloud Storage"
  say "  --target=aws     the foundation on EKS, RDS and S3"
  say "  --check-only     verify this machine and stop"
  say "  --yes            install without asking for confirmation"
  say "  --no-prompt      never ask; fail when something is missing"
  say ""
  say "Cloud targets read DOMAIN and ACME_EMAIL, plus GCP_PROJECT and GCP_REGION"
  say "or AWS_REGION, from the environment and ask for any that are not set."
}

parse_arguments() {
  while [ "$#" -gt 0 ]; do
    case "${1}" in
      --target=*) TARGET="${1#--target=}" ;;
      --check-only) CHECK_ONLY=1 ;;
      --yes | -y) ASSUME_YES=1 ;;
      --no-prompt) NO_PROMPT=1 ;;
      --help | -h)
        usage
        exit 0
        ;;
      *) fail "unknown option ${1}; see --help" ;;
    esac
    shift
  done
}

stop_on_native_windows() {
  say "On Windows, run this installer inside WSL2, not in PowerShell or Git Bash."
  say "  1. In PowerShell as Administrator, run: wsl --install"
  say "  2. Restart, open Ubuntu, and install Docker Desktop with WSL integration on."
  say "  3. Run the same install command inside Ubuntu."
  exit 1
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) PLATFORM="macos" ;;
    Linux)
      if uname -r | grep -qi microsoft; then
        PLATFORM="wsl"
      else
        PLATFORM="linux"
      fi
      ;;
    MINGW* | MSYS* | CYGWIN*) stop_on_native_windows ;;
    *) fail "unsupported system $(uname -s); use macOS, Linux, or Windows with WSL2" ;;
  esac
  if [ "${PLATFORM}" = "macos" ]; then
    PACKAGES="brew"
  elif command -v pacman >/dev/null 2>&1; then
    PACKAGES="pacman"
  elif command -v apt-get >/dev/null 2>&1; then
    PACKAGES="apt"
  else
    PACKAGES="other"
  fi
}

can_prompt() {
  [ "${NO_PROMPT}" != "1" ] && (exec </dev/tty) 2>/dev/null
}

report_ok() {
  printf '  ok    %s\n' "${1}"
}

report_warning() {
  printf '  warn  %s\n' "${1}"
  printf '        %s\n' "${2}"
}

report_problem() {
  printf '  FIX   %s\n' "${1}"
  printf '        %s\n' "${2}"
  FAILURES=$((FAILURES + 1))
}

tool_hint() {
  case "${PACKAGES}:${1}" in
    brew:docker) say "Install Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/" ;;
    brew:kubectl) say "brew install kubernetes-cli" ;;
    brew:gcloud) say "brew install --cask gcloud-cli" ;;
    brew:aws) say "brew install awscli" ;;
    brew:*) say "brew install ${1}" ;;
    *:gke-gcloud-auth-plugin) gcloud_plugin_hint ;;
    pacman:docker) say "sudo pacman -S --needed docker" ;;
    pacman:gcloud) say "yay -S google-cloud-cli" ;;
    pacman:aws) say "sudo pacman -S --needed aws-cli-v2" ;;
    pacman:*) say "sudo pacman -S --needed ${1}" ;;
    *:docker) say "Install Docker Desktop with WSL integration, or Docker Engine: https://docs.docker.com/engine/install/" ;;
    *:kind) say "Install kind: https://kind.sigs.k8s.io/docs/user/quick-start/#installation" ;;
    *:kubectl) say "Install kubectl: https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/" ;;
    *:helm) say "Install Helm: https://helm.sh/docs/intro/install/" ;;
    *:gcloud) say "Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install" ;;
    *:aws) say "Install the AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" ;;
    *:eksctl) say "Install eksctl: https://eksctl.io/installation/" ;;
    apt:*) say "sudo apt-get install -y ${1}" ;;
    *) say "Install ${1} with your package manager" ;;
  esac
}

gcloud_plugin_hint() {
  if [ "${PACKAGES}" = "pacman" ]; then
    say "yay -S google-cloud-cli-component-gke-gcloud-auth-plugin"
  else
    say "gcloud components install gke-gcloud-auth-plugin"
  fi
}

docker_hint() {
  case "${PLATFORM}" in
    macos) say "Start Docker Desktop and wait for it to finish starting" ;;
    wsl) say "Start Docker Desktop, then turn on this distribution under Settings, Resources, WSL integration" ;;
    *) say "sudo systemctl enable --now docker; sudo usermod -aG docker \"\${USER}\"; then sign out and back in" ;;
  esac
}

check_tool() {
  if command -v "${1}" >/dev/null 2>&1; then
    report_ok "${1}"
    return 0
  fi
  report_problem "${1} is not installed" "$(tool_hint "${1}")"
  return 1
}

check_docker() {
  check_tool docker || return 0
  if ! docker info >/dev/null 2>&1; then
    report_problem "Docker is not running, or this user cannot reach it" "$(docker_hint)"
    return 0
  fi
  report_ok "Docker is running"
  local memory
  memory="$(docker info --format '{{.MemTotal}}' 2>/dev/null || true)"
  case "${memory}" in
    '' | *[!0-9]*) return 0 ;;
  esac
  if [ "${memory}" -lt $((MIN_DOCKER_GIB * 1073741824)) ]; then
    report_warning "Docker has less than ${MIN_DOCKER_GIB} GB of memory" "Give Docker more memory, or Mattermost may fail to start"
  fi
}

check_file_watches() {
  [ "${PLATFORM}" != "macos" ] || return 0
  local instances
  instances="$(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null || echo 0)"
  if [ "${instances}" -lt 512 ]; then
    report_warning "File watch limits are low for Kubernetes in Docker" "sudo sysctl fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=512"
  fi
}

ask_setting() {
  local name="${1}" question="${2}" fallback="${3:-}" answer=""
  if [ -n "$(printenv "${name}" || true)" ]; then
    report_ok "${name} is set"
    return 0
  fi
  if can_prompt; then
    printf '%s%s: ' "${question}" "${fallback:+ [${fallback}]}" >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
  fi
  answer="${answer:-${fallback}}"
  if [ -z "${answer}" ]; then
    report_problem "${name} is not set" "export ${name}=<value>, then run this again"
    return 0
  fi
  export "${name}=${answer}"
  report_ok "${name} is ${answer}"
}

check_public_settings() {
  ask_setting DOMAIN "Domain for chat and git, for example platform.your-company.com"
  ask_setting ACME_EMAIL "Email address for certificate notices"
  case "${DOMAIN:-}" in
    '') ;;
    *[!a-zA-Z0-9.-]* | *.) report_problem "DOMAIN '${DOMAIN}' is not a valid domain" "Use a bare name such as platform.your-company.com" ;;
    *.*) ;;
    *) report_problem "DOMAIN '${DOMAIN}' is not a valid domain" "Use a bare name such as platform.your-company.com" ;;
  esac
  case "${ACME_EMAIL:-}" in
    '' | *@*.*) ;;
    *) report_problem "ACME_EMAIL '${ACME_EMAIL}' is not an email address" "Let's Encrypt rejects certificate requests without a valid address" ;;
  esac
}

verify_common() {
  check_tool kubectl || true
  check_tool helm || true
  check_tool openssl || true
  check_tool curl || true
  check_tool git || true
}

verify_local() {
  check_docker
  check_tool kind || true
  check_file_watches
  verify_common
}

default_gcp_project() {
  if command -v gcloud >/dev/null 2>&1; then
    gcloud config get-value project 2>/dev/null || true
  fi
}

verify_gcp() {
  verify_common
  if check_tool gcloud; then
    if gcloud auth print-access-token >/dev/null 2>&1; then
      report_ok "gcloud is signed in"
    else
      report_problem "gcloud is not signed in" "gcloud auth login"
    fi
  fi
  check_tool gke-gcloud-auth-plugin || true
  ask_setting GCP_PROJECT "Google Cloud project id" "$(default_gcp_project)"
  ask_setting GCP_REGION "Google Cloud region" "us-central1"
  check_public_settings
}

verify_aws() {
  verify_common
  if check_tool aws; then
    if aws sts get-caller-identity >/dev/null 2>&1; then
      report_ok "AWS credentials work"
    else
      report_problem "AWS credentials are missing or expired" "aws configure sso, or export AWS_PROFILE"
    fi
  fi
  check_tool eksctl || true
  ask_setting AWS_REGION "AWS region" "us-east-1"
  check_public_settings
}

choose_target() {
  if [ -z "${TARGET}" ]; then
    can_prompt || fail "choose a target with --target=local, --target=gcp or --target=aws"
    printf '%s\n' "Where should Octogee Cloud run?" \
      "  1) This machine, in Docker (for trying it out)" \
      "  2) Google Cloud: GKE, Cloud SQL, Cloud Storage" \
      "  3) AWS: EKS, RDS, S3" >/dev/tty
    printf 'Choose 1, 2 or 3: ' >/dev/tty
    local choice=""
    IFS= read -r choice </dev/tty || choice=""
    case "${choice}" in
      1) TARGET="local" ;;
      2) TARGET="gcp" ;;
      3) TARGET="aws" ;;
      *) fail "no target chosen; nothing was installed" ;;
    esac
  fi
  case "${TARGET}" in
    local | gcp | aws) ;;
    *) fail "unknown target '${TARGET}'; use local, gcp or aws" ;;
  esac
}

verify_target() {
  say "Checking this machine for the ${TARGET} target (${PLATFORM})"
  "verify_${TARGET}"
  if [ "${FAILURES}" -gt 0 ]; then
    say ""
    fail "${FAILURES} items need fixing; fix them and run this again"
  fi
  say "This machine is ready."
}

model_keys_in_shell() {
  local name found=""
  for name in ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY OPENROUTER_API_KEY; do
    [ -z "$(printenv "${name}" || true)" ] || found="${found} ${name}"
  done
  printf '%s' "${found# }"
}

describe_model_keys() {
  local keys
  keys="$(model_keys_in_shell)"
  if [ -n "${keys}" ]; then
    say "It copies these model keys from your shell into the cluster: ${keys}"
  else
    say "No model keys are set in your shell, so the agent cannot answer until you add one."
  fi
}

describe_plan() {
  say ""
  case "${TARGET}" in
    local)
      say "This creates a Kubernetes cluster in Docker with PostgreSQL, an S3 store,"
      say "Traefik, Gitea, Mattermost and one OpenClaw gateway."
      say "Chat and git open on localhost, port ${LOCAL_PORT:-8088}."
      ;;
    gcp)
      say "This creates billable resources in Google Cloud project ${GCP_PROJECT}, region ${GCP_REGION}:"
      if [ -n "${GCP_ZONE:-}" ]; then
        say "a GKE cluster in zone ${GCP_ZONE},"
      else
        say "a GKE cluster in region ${GCP_REGION},"
      fi
      say "Cloud SQL for PostgreSQL 16 (${SQL_AVAILABILITY:-REGIONAL}),"
      say "a Cloud Storage bucket, Cloud NAT and a load balancer."
      say "Chat: https://chat.${DOMAIN}  Git: https://git.${DOMAIN}"
      ;;
    aws)
      say "This creates billable resources in AWS region ${AWS_REGION}:"
      say "an EKS cluster, Multi-AZ RDS for PostgreSQL 16, an S3 bucket,"
      say "a NAT gateway and a load balancer."
      say "Chat: https://chat.${DOMAIN}  Git: https://git.${DOMAIN}"
      ;;
  esac
  describe_model_keys
  say ""
}

confirm() {
  [ "${ASSUME_YES}" != "1" ] || return 0
  can_prompt || fail "nothing was installed; pass --yes to install without asking"
  printf 'Install now? [y/N] ' >/dev/tty
  local answer=""
  IFS= read -r answer </dev/tty || answer=""
  case "${answer}" in
    y | Y | yes | YES) ;;
    *)
      say "Nothing was installed."
      exit 0
      ;;
  esac
}

locate_checkout() {
  local source="${BASH_SOURCE[0]:-}" directory
  if [ -n "${source}" ] && [ -f "${source}" ]; then
    directory="$(cd "$(dirname "${source}")" && pwd)"
    if [ -f "${directory}/deploy/lib.sh" ]; then
      CHECKOUT="${directory}"
      return 0
    fi
  fi
  if [ -d "${INSTALL_DIR}/.git" ]; then
    say "Updating ${INSTALL_DIR}"
    git -C "${INSTALL_DIR}" pull --ff-only --quiet </dev/null
  elif [ -e "${INSTALL_DIR}" ]; then
    fail "${INSTALL_DIR} exists and is not a git checkout; set OCTOGEE_CLOUD_DIR to another folder"
  else
    say "Cloning into ${INSTALL_DIR}"
    git clone --quiet --depth 1 --branch "${REF}" "${REPOSITORY}" "${INSTALL_DIR}" </dev/null
  fi
  CHECKOUT="${INSTALL_DIR}"
}

run_target() {
  case "${TARGET}" in
    local)
      /bin/bash "${CHECKOUT}/deploy/local/up.sh" </dev/null
      /bin/bash "${CHECKOUT}/deploy/local/check.sh" </dev/null
      ;;
    gcp | aws)
      /bin/bash "${CHECKOUT}/deploy/cloud/${TARGET}.sh" </dev/null
      ;;
  esac
  say ""
  say "Your checkout is at ${CHECKOUT}."
  say "Next steps: ${CHECKOUT}/docs/getting-started.md"
}

main() {
  parse_arguments "$@"
  detect_platform
  choose_target
  verify_target
  [ "${CHECK_ONLY}" != "1" ] || exit 0
  describe_plan
  confirm
  locate_checkout
  run_target
}

main "$@"
