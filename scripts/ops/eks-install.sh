#!/usr/bin/env bash
# Install the platform on EKS in one AWS account and region: eks-install.sh up|down|status
# See docs/eks.md.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="octogee"
NAMESPACE="octogee"
SHA=""
MANIFEST=""

log() { printf '\n== %s\n' "$*"; }
die() { printf 'eks-install: %s\n' "$*" >&2; exit 1; }

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

AWS_REGION="${AWS_REGION:-}"
INSTANCE_TYPE="${INSTANCE_TYPE:-m6i.xlarge}"
GATEWAY_INSTANCE_TYPE="${GATEWAY_INSTANCE_TYPE:-m6i.xlarge}"
SYSTEM_NODES="${SYSTEM_NODES:-2}"
GATEWAY_NODES="${GATEWAY_NODES:-2}"
DB_CLASS="${DB_CLASS:-db.t4g.medium}"
GVISOR_RELEASE="${GVISOR_RELEASE:-latest}"
SHARED_GATEWAY_TIER="${SHARED_GATEWAY_TIER:-m}"
[[ -n "$AWS_REGION" ]] || die "Set AWS_REGION to the AWS region to install into"
[[ "$SYSTEM_NODES" =~ ^[1-9][0-9]*$ ]] || die "SYSTEM_NODES must be a whole number of nodes"
[[ "$GATEWAY_NODES" =~ ^[1-9][0-9]*$ ]] || die "GATEWAY_NODES must be a whole number of nodes"
[[ "$SHARED_GATEWAY_TIER" =~ ^(s|m|l)$ ]] || die "SHARED_GATEWAY_TIER must be s, m or l"
[[ "$GVISOR_RELEASE" =~ ^(latest|[0-9]{8}(\.[0-9]+)?)$ ]] || die "GVISOR_RELEASE must be latest or a gVisor release such as 20251110.0"

KUBE_CONTEXT="eks_${AWS_REGION}_${NAME}"
PUBLISHED="ghcr.io/octogee-ai/octogee-cloud"
ADMIN_PORT=18080
DB_INSTANCE="$NAME"
DB_SECURITY_GROUP_NAME="$NAME-database"
BLOB_USER="$NAME-blob-store"
LAUNCH_TEMPLATE="$NAME-gateways"
SANDBOX_LABEL="octogee.io/sandbox"
SHA="${SHA:-$(git -C "$ROOT" rev-parse HEAD)}"
SHORT="${SHA:0:7}"
IMAGES=(glm-controller octogee-api gateway-edge octogee-gateway octogee-gateway-builder)
POSTGRES_CLIENT_IMAGE="pgvector/pgvector:0.8.7-pg16@sha256:484e838076e04939d27d3e176e91c86eea96236126023be8d3059761122e579f"

a() { aws --region "$AWS_REGION" "$@"; }
kc() { kubectl --kubeconfig="$KUBECONFIG_FILE" --context="$KUBE_CONTEXT" "$@"; }
k() { kc -n "$NAMESPACE" "$@"; }
h() { helm --kubeconfig="$KUBECONFIG_FILE" --kube-context="$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }
random_hex() { openssl rand -hex "$1"; }

require_tools() {
  local tool
  for tool in aws eksctl kubectl helm docker node openssl ssh-keygen git; do
    command -v "$tool" >/dev/null || die "$tool is required"
  done
}

load_account() {
  ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" \
    || die "Sign in to AWS first, for example with aws sso login"
  [[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || die "AWS reported no account ID for the signed-in identity"
  STATE="${OCTOGEE_EKS_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/octogee-eks}/$ACCOUNT-$AWS_REGION"
  KUBECONFIG_FILE="$STATE/kubeconfig"
  ASSETS_BUCKET="$NAME-$ACCOUNT-$AWS_REGION-assets"
  WORKSPACES_BUCKET="$NAME-$ACCOUNT-$AWS_REGION-workspaces"
}

check_vcpu_quota() {
  local types=("$INSTANCE_TYPE") type vcpus quota needed=0
  [[ "$GATEWAY_INSTANCE_TYPE" == "$INSTANCE_TYPE" ]] || types+=("$GATEWAY_INSTANCE_TYPE")
  for type in "${types[@]}"; do
    [[ "$type" =~ ^[acdhimrtz][0-9] ]] || return 0
  done
  quota="$(a service-quotas get-service-quota --service-code ec2 --quota-code L-1216C47A --query Quota.Value --output text)"
  [[ "$quota" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "Service Quotas did not report this account's vCPU quota for standard instances"
  while read -r type vcpus; do
    [[ "$type" == "$INSTANCE_TYPE" ]] && needed=$((needed + SYSTEM_NODES * vcpus))
    [[ "$type" == "$GATEWAY_INSTANCE_TYPE" ]] && needed=$((needed + GATEWAY_NODES * vcpus))
  done < <(a ec2 describe-instance-types --instance-types "${types[@]}" \
    --query 'InstanceTypes[].[InstanceType,VCpuInfo.DefaultVCpus]' --output text)
  [[ "$needed" -gt 0 ]] || die "EC2 did not report the vCPUs of ${types[*]}"
  if [[ "${quota%.*}" -lt "$needed" ]]; then
    die "The nodes need $needed vCPUs of standard instances, and this account may run ${quota%.*} in $AWS_REGION. Request an increase of quota L-1216C47A, Running On-Demand Standard instances, in Service Quotas; docs/eks.md#what-you-need shows how."
  fi
}

secret_value() {
  local file="$STATE/secrets/$1"
  if [[ ! -s "$file" ]]; then
    mkdir -p "$STATE/secrets"
    (umask 077; "${@:2}" > "$file")
  fi
  cat "$file"
}

gateway_user_data() {
  cat <<EOF
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="//"

--//
Content-Type: text/x-shellscript; charset="us-ascii"

#!/bin/bash
set -euo pipefail
url=https://storage.googleapis.com/gvisor/releases/release/$GVISOR_RELEASE/\$(uname -m)
cd "\$(mktemp -d)"
curl -fsSL --remote-name-all "\$url/runsc" "\$url/runsc.sha512" \\
  "\$url/containerd-shim-runsc-v1" "\$url/containerd-shim-runsc-v1.sha512"
sha512sum -c runsc.sha512 containerd-shim-runsc-v1.sha512
install -m 0755 runsc containerd-shim-runsc-v1 /usr/local/bin/
plugin=io.containerd.grpc.v1.cri
if grep -Eq '^version *= *3' /etc/containerd/config.toml; then plugin=io.containerd.cri.v1.runtime; fi
cat >> /etc/containerd/config.toml <<RUNSC

[plugins."\$plugin".containerd.runtimes.runsc]
runtime_type = "io.containerd.runsc.v1"
RUNSC

--//--
EOF
}

launch_template_id() {
  a ec2 describe-launch-templates --launch-template-names "$LAUNCH_TEMPLATE" \
    --query 'LaunchTemplates[0].LaunchTemplateId' --output text 2>/dev/null
}

ensure_launch_template() {
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  if ! launch_template_id >/dev/null; then
    gateway_user_data > "$STATE/gateway-user-data.mime"
    node -e '
      const { readFileSync, writeFileSync } = require("node:fs");
      const [userData, instanceType, file] = process.argv.slice(1);
      writeFileSync(file, JSON.stringify({
        InstanceType: instanceType,
        BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: 100, VolumeType: "gp3", Encrypted: true } }],
        MetadataOptions: { HttpEndpoint: "enabled", HttpTokens: "required", HttpPutResponseHopLimit: 1 },
        UserData: readFileSync(userData).toString("base64"),
      }, null, 2) + "\n");
    ' "$STATE/gateway-user-data.mime" "$GATEWAY_INSTANCE_TYPE" "$STATE/gateway-launch-template.json"
    a ec2 create-launch-template --launch-template-name "$LAUNCH_TEMPLATE" \
      --launch-template-data "file://$STATE/gateway-launch-template.json" >/dev/null
  fi
  LAUNCH_TEMPLATE_ID="$(launch_template_id)"
  [[ "$LAUNCH_TEMPLATE_ID" =~ ^lt-[0-9a-f]+$ ]] || die "EC2 did not report an ID for launch template $LAUNCH_TEMPLATE"
}

cluster_config() {
  cat <<EOF
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: $NAME
  region: $AWS_REGION
iam:
  withOIDC: true
vpc:
  nat:
    gateway: Single
  clusterEndpoints:
    publicAccess: true
    privateAccess: true
addons:
  - name: vpc-cni
    configurationValues: '{"enableNetworkPolicy":"true"}'
  - name: coredns
  - name: kube-proxy
  - name: aws-ebs-csi-driver
    wellKnownPolicies:
      ebsCSIController: true
managedNodeGroups:
  - name: system
    amiFamily: AmazonLinux2023
    instanceType: $INSTANCE_TYPE
    minSize: $SYSTEM_NODES
    desiredCapacity: $SYSTEM_NODES
    maxSize: $SYSTEM_NODES
    volumeSize: 100
    privateNetworking: true
  - name: gateways
    amiFamily: AmazonLinux2023
    launchTemplate:
      id: $LAUNCH_TEMPLATE_ID
      version: "1"
    minSize: $GATEWAY_NODES
    desiredCapacity: $GATEWAY_NODES
    maxSize: $GATEWAY_NODES
    privateNetworking: true
    labels:
      $SANDBOX_LABEL: gvisor
    taints:
      - key: $SANDBOX_LABEL
        value: gvisor
        effect: NoSchedule
EOF
}

ensure_cluster() {
  cluster_config > "$STATE/eksctl.yaml"
  if ! a eks describe-cluster --name "$NAME" >/dev/null 2>&1; then
    log "EKS cluster $NAME in $AWS_REGION (about 20 minutes)"
    eksctl create cluster -f "$STATE/eksctl.yaml" --write-kubeconfig=false
  else
    eksctl create nodegroup -f "$STATE/eksctl.yaml"
    eksctl scale nodegroup --cluster "$NAME" --region "$AWS_REGION" --name system \
      --nodes "$SYSTEM_NODES" --nodes-min "$SYSTEM_NODES" --nodes-max "$SYSTEM_NODES"
    eksctl scale nodegroup --cluster "$NAME" --region "$AWS_REGION" --name gateways \
      --nodes "$GATEWAY_NODES" --nodes-min "$GATEWAY_NODES" --nodes-max "$GATEWAY_NODES"
  fi
  a eks update-kubeconfig --name "$NAME" --kubeconfig "$KUBECONFIG_FILE" --alias "$KUBE_CONTEXT" >/dev/null
  kc create namespace "$NAMESPACE" --dry-run=client -o yaml | kc apply -f - >/dev/null
  kc apply -f - >/dev/null <<EOF
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
  encrypted: "true"
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
scheduling:
  nodeSelector:
    $SANDBOX_LABEL: gvisor
  tolerations:
    - key: $SANDBOX_LABEL
      operator: Equal
      value: gvisor
      effect: NoSchedule
EOF
}

check_sandbox() {
  local output
  output="$(k run "sandbox-check-$(random_hex 4)" --rm -i --quiet --restart=Never --pod-running-timeout=5m \
    --image="$POSTGRES_CLIENT_IMAGE" --overrides="$(node -e '
      const image = process.argv[1];
      console.log(JSON.stringify({ spec: { runtimeClassName: "gvisor", containers: [{
        name: "check", image, stdin: true, stdinOnce: true, command: ["dmesg"],
      }] } }));
    ' "$POSTGRES_CLIENT_IMAGE")" < /dev/null)" || die "A pod with runtime class gvisor did not run on the gateway nodes"
  [[ "$output" == *gVisor* ]] \
    || die "A pod with runtime class gvisor did not report the gVisor kernel; the gateway nodes do not sandbox gateways"
  echo "Gateway nodes run pods under gVisor"
}

cluster_field() {
  a eks describe-cluster --name "$NAME" --query "cluster.resourcesVpcConfig.$1" --output text
}

database_security_group() {
  a ec2 describe-security-groups --filters "Name=group-name,Values=$DB_SECURITY_GROUP_NAME" \
    --query 'SecurityGroups[0].GroupId' --output text
}

ensure_database_network() {
  local vpc subnets=()
  vpc="$(cluster_field vpcId)"
  VPC_CIDR="$(a ec2 describe-vpcs --vpc-ids "$vpc" --query 'Vpcs[0].CidrBlock' --output text)"
  [[ "$VPC_CIDR" =~ ^[0-9.]+/[0-9]+$ ]] || die "EC2 did not report the CIDR of VPC $vpc"
  DB_SECURITY_GROUP="$(database_security_group)"
  if [[ -z "$DB_SECURITY_GROUP" || "$DB_SECURITY_GROUP" == None ]]; then
    DB_SECURITY_GROUP="$(a ec2 create-security-group --group-name "$DB_SECURITY_GROUP_NAME" \
      --description "PostgreSQL from the $NAME cluster" --vpc-id "$vpc" --query GroupId --output text)"
    a ec2 authorize-security-group-ingress --group-id "$DB_SECURITY_GROUP" --protocol tcp --port 5432 \
      --source-group "$(cluster_field clusterSecurityGroupId)" >/dev/null
  fi
  if ! a rds describe-db-subnet-groups --db-subnet-group-name "$NAME" >/dev/null 2>&1; then
    read -ra subnets <<<"$(a ec2 describe-subnets \
      --filters "Name=vpc-id,Values=$vpc" "Name=tag:kubernetes.io/role/internal-elb,Values=1" \
      --query 'Subnets[].SubnetId' --output text)"
    [[ ${#subnets[@]} -ge 2 ]] || die "Found fewer than two private subnets in VPC $vpc"
    a rds create-db-subnet-group --db-subnet-group-name "$NAME" \
      --db-subnet-group-description "PostgreSQL for $NAME" --subnet-ids "${subnets[@]}" >/dev/null
  fi
}

ensure_database() {
  if ! a rds describe-db-instances --db-instance-identifier "$DB_INSTANCE" >/dev/null 2>&1; then
    log "RDS for PostgreSQL 16 (about 15 minutes)"
    a rds create-db-instance --db-instance-identifier "$DB_INSTANCE" --engine postgres --engine-version 16 \
      --db-instance-class "$DB_CLASS" --storage-type gp3 --allocated-storage 20 --max-allocated-storage 100 \
      --master-username postgres --master-user-password "$(secret_value postgres-password random_hex 16)" \
      --db-subnet-group-name "$NAME" --vpc-security-group-ids "$DB_SECURITY_GROUP" \
      --no-multi-az --no-publicly-accessible --storage-encrypted \
      --backup-retention-period 7 --preferred-backup-window 03:00-03:30 >/dev/null
  fi
  a rds wait db-instance-available --db-instance-identifier "$DB_INSTANCE"
  DB_HOST="$(a rds describe-db-instances --db-instance-identifier "$DB_INSTANCE" \
    --query 'DBInstances[0].Endpoint.Address' --output text)"
  [[ "$DB_HOST" == *.rds.amazonaws.com ]] || die "RDS did not report an address for $DB_INSTANCE"
}

blob_policy() {
  node -e '
    const buckets = process.argv.slice(1).map(bucket => `arn:aws:s3:::${bucket}`);
    console.log(JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:ListBucket", "s3:ListBucketVersions", "s3:ListBucketMultipartUploads", "s3:GetBucketLocation", "s3:GetBucketVersioning"],
          Resource: buckets,
        },
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
          Resource: buckets.map(bucket => `${bucket}/*`),
        },
      ],
    }));
  ' "$ASSETS_BUCKET" "$WORKSPACES_BUCKET"
}

create_bucket() {
  if [[ "$AWS_REGION" == us-east-1 ]]; then
    a s3api create-bucket --bucket "$1" >/dev/null
  else
    a s3api create-bucket --bucket "$1" --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
}

ensure_buckets() {
  local bucket keys
  for bucket in "$ASSETS_BUCKET" "$WORKSPACES_BUCKET"; do
    a s3api head-bucket --bucket "$bucket" >/dev/null 2>&1 || create_bucket "$bucket"
    a s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  done
  a iam get-user --user-name "$BLOB_USER" >/dev/null 2>&1 || a iam create-user --user-name "$BLOB_USER" >/dev/null
  a iam put-user-policy --user-name "$BLOB_USER" --policy-name blob-store --policy-document "$(blob_policy)"
  if [[ ! -s "$STATE/secrets/s3-secret-key" ]]; then
    keys="$(a iam create-access-key --user-name "$BLOB_USER" \
      --query '[AccessKey.AccessKeyId,AccessKey.SecretAccessKey]' --output text)"
    [[ "$keys" == *$'\t'* ]] || die "IAM did not return an access key for $BLOB_USER"
    mkdir -p "$STATE/secrets"
    (umask 077; printf '%s' "${keys%%$'\t'*}" > "$STATE/secrets/s3-access-key"; printf '%s' "${keys#*$'\t'}" > "$STATE/secrets/s3-secret-key")
  fi
}

resolve_images() {
  local options=(--registry="$PUBLISHED" --sha="$SHA" --platform=linux/amd64 --images="$(IFS=,; echo "${IMAGES[*]}")")
  [[ -n "$MANIFEST" ]] && options+=(--manifest="$MANIFEST")
  mkdir -p "$STATE"
  node "$ROOT/scripts/ci/cloud-build.mjs" resolve "${options[@]}" > "$STATE/digests.json"
}

api_server_cidrs() {
  kc -n default get endpointslice -l kubernetes.io/service-name=kubernetes \
    -o jsonpath='{range .items[*].endpoints[*]}{.addresses[0]}{"\n"}{end}' | sort -u
}

environment_values() {
  local cidrs
  cidrs="$(api_server_cidrs | sed 's|$|/32|' | paste -sd, -)"
  [[ -n "$cidrs" ]] || die "Found no Kubernetes API server endpoint in the cluster"
  node --input-type=module - "$STATE/digests.json" "$PUBLISHED/" \
    "$(node -p "require('$ROOT/infra/gateway/openclaw-tarball/current.json').sourceSha")" \
    "$AWS_REGION" "$DB_HOST" "$VPC_CIDR" "$ASSETS_BUCKET" "$WORKSPACES_BUCKET" "$cidrs" "$SHARED_GATEWAY_TIER" > "$STATE/environment.yaml" <<'JS'
import { readFileSync } from "node:fs";
const [file, prefix, openclaw, region, databaseHost, vpcCidr, assets, workspaces, cidrs, sharedTier] = process.argv.slice(2);
const { sha, images } = JSON.parse(readFileSync(file, "utf8"));
const tag = sha.slice(0, 7);
const image = name => ({ repository: `${prefix}${name}`, tag, digest: images[name] });
console.log(JSON.stringify({
  global: {
    blobStore: { endpoint: `https://s3.${region}.amazonaws.com`, region, bucket: assets, workspaceBucket: workspaces },
  },
  mattermost: { db: { host: databaseHost } },
  gitea: { gitea: { config: { database: { HOST: `${databaseHost}:5432` } } } },
  networkPolicy: { agentStorePostgresCidr: vpcCidr },
  projectRunner: { apiServerEgressCidrs: cidrs.split(",") },
  "octogee-api": { image: image("octogee-api") },
  llmBroker: { image: image("octogee-api") },
  "gateway-edge": { image: image("gateway-edge") },
  "glm-controller": {
    image: image("glm-controller"),
    gatewayValues: { classDefaults: { shared: sharedTier } },
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
    "eks-install: agents need a model provider key, and none is exported or stored in the cluster." \
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
  psql_pod postgres < "$ROOT/scripts/ops/postgres-databases.sql" >/dev/null
  psql_pod octogee_agents < "$ROOT/scripts/ops/postgres-agent-store.sql" >/dev/null
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
  if [[ -n "$owner" && "$owner" != eks-install ]]; then
    printf 'Keeping the agent models that %s set\n' "$owner"
    return
  fi
  platform_sql -v value="{\"builderAgentModelRef\":\"$primary\",\"builderAgentFallbackModelRef\":\"$fallback\",\"freeTierModelRef\":\"$house\"}" >/dev/null <<'SQL'
INSERT INTO platform.platform_config (key, value, updated_at, updated_by)
VALUES ('models', :'value'::jsonb, (extract(epoch FROM clock_timestamp()) * 1000)::bigint, 'eks-install')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
SQL
  printf 'Agents use %s, falling back to %s; the house model is %s\n' "$primary" "$fallback" "$house"
}

install_chart() {
  h upgrade --install octogee "$ROOT/helm/octogee" \
    -f "$ROOT/scripts/ops/eks/values.yaml" -f "$STATE/environment.yaml" \
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
      environments: { eks: { adminApiOrigin: origin, tokenCommand: ["node", script, key] } },
    }, null, 2) + "\n");
  ' "$STATE/fleet-config.json" "http://127.0.0.1:$ADMIN_PORT" "$ROOT/scripts/ops/operator-token.mjs" "$STATE/secrets/operator.pem"
}

up() {
  require_tools
  load_account
  require_provider_key
  check_vcpu_quota
  log "Images published at $SHORT"
  resolve_images
  log "Launch template for gateway nodes, with gVisor"
  ensure_launch_template
  ensure_cluster
  log "Sandbox check on the gateway nodes"
  check_sandbox
  log "RDS"
  ensure_database_network
  ensure_database
  log "S3"
  ensure_buckets
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

Then: octogee-fleet --env=eks gateway ls
EOF
}

wait_for_released_volumes() {
  local attempt
  for ((attempt = 0; attempt < 30; attempt++)); do
    [[ -n "$(kc get pv -o name)" ]] || return 0
    sleep 10
  done
  echo "eks-install: some persistent volumes were not released; check EC2 for leftover EBS volumes" >&2
}

down() {
  log "Deleting the platform in account $ACCOUNT, $AWS_REGION"
  if [[ -s "$KUBECONFIG_FILE" ]] && k get namespace "$NAMESPACE" >/dev/null 2>&1; then
    if k delete namespace "$NAMESPACE" --wait=true --timeout=10m; then
      wait_for_released_volumes
    else
      echo "eks-install: namespace $NAMESPACE did not finish deleting; the database and cluster go next" >&2
    fi
  fi
  if a rds describe-db-instances --db-instance-identifier "$DB_INSTANCE" >/dev/null 2>&1; then
    a rds delete-db-instance --db-instance-identifier "$DB_INSTANCE" --skip-final-snapshot --delete-automated-backups >/dev/null
    a rds wait db-instance-deleted --db-instance-identifier "$DB_INSTANCE"
  fi
  if a rds describe-db-subnet-groups --db-subnet-group-name "$NAME" >/dev/null 2>&1; then
    a rds delete-db-subnet-group --db-subnet-group-name "$NAME"
  fi
  local group bucket id
  group="$(database_security_group)"
  if [[ -n "$group" && "$group" != None ]]; then
    a ec2 delete-security-group --group-id "$group"
  fi
  if a eks describe-cluster --name "$NAME" >/dev/null 2>&1; then
    eksctl delete cluster --name "$NAME" --region "$AWS_REGION" --wait
  fi
  if launch_template_id >/dev/null; then
    a ec2 delete-launch-template --launch-template-name "$LAUNCH_TEMPLATE" >/dev/null
  fi
  for bucket in "$ASSETS_BUCKET" "$WORKSPACES_BUCKET"; do
    if a s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
      a s3 rb "s3://$bucket" --force
    fi
  done
  if a iam get-user --user-name "$BLOB_USER" >/dev/null 2>&1; then
    for id in $(a iam list-access-keys --user-name "$BLOB_USER" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
      a iam delete-access-key --user-name "$BLOB_USER" --access-key-id "$id"
    done
    if a iam get-user-policy --user-name "$BLOB_USER" --policy-name blob-store >/dev/null 2>&1; then
      a iam delete-user-policy --user-name "$BLOB_USER" --policy-name blob-store
    fi
    a iam delete-user --user-name "$BLOB_USER"
  fi
  rm -rf "$STATE"
}

case "$COMMAND" in
  up) up ;;
  down) require_tools; load_account; down ;;
  status) load_account; status ;;
  *) echo "Usage: AWS_REGION=<region> $0 {up|down|status} [--sha=SHA] [--manifest=FILE]" >&2; exit 2 ;;
esac
