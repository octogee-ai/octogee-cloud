#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=zones.sh
source "$HERE/zones.sh"
PROJECT=""
ZONE="us-west1-b"
FALLBACK_ZONES=""
OMARCHY_VERSION="4.5.0"
BUCKET=""
BUILDER="octogee-computer-image-builder"
KEEP_BUILDER=0
CANDIDATE=0
REQUESTED_IMAGE_NAME=""
SERVICE_ACCOUNT=""
FAMILY="octogee-computer"
IMAGE_DISK_GB=40
IMAGE_DEVICE_NAME="octogee-image"

iso_sha256_for() {
  case "$1" in
    4.5.0) echo "5d6288bc57f96f6231719830457582c846a2291985201c36a9a7d1216978b00f" ;;
    *) echo "" ;;
  esac
}

usage() {
  cat <<EOF
usage: $0 --project <gcp-project> [--zone $ZONE] [--fallback-zones <zone,zone>] [--omarchy-version $OMARCHY_VERSION]
          [--bucket gs://...] [--builder-name $BUILDER] [--keep-builder] [--candidate] [--image-name <name>] [--service-account <email>]
       OCTOGEE_GCE_SSH_KEY=<ed25519 key> (default ~/.ssh/octogee_gce_ed25519, created if absent)

Builds the Octogee VM image (Omarchy + the desktop session + Docker) from
the pinned Omarchy ISO with an unattended install inside a nested-virt GCE
builder VM onto a persistent disk attached to the builder, and registers that
disk as a GCE image in family "$FAMILY". --candidate leaves the image outside
the family for acceptance testing before publication. Prints the image name on
success.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="$2"; shift 2 ;;
    --zone) ZONE="$2"; shift 2 ;;
    --fallback-zones) FALLBACK_ZONES="$2"; shift 2 ;;
    --omarchy-version) OMARCHY_VERSION="$2"; shift 2 ;;
    --bucket) BUCKET="$2"; shift 2 ;;
    --builder-name) BUILDER="$2"; shift 2 ;;
    --keep-builder) KEEP_BUILDER=1; shift ;;
    --candidate) CANDIDATE=1; shift ;;
    --image-name) REQUESTED_IMAGE_NAME="$2"; shift 2 ;;
    --service-account) SERVICE_ACCOUNT="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$PROJECT" ]] || { usage >&2; exit 2; }
GATEWAY_IMAGE="${OCTOGEE_DESKTOP_GATEWAY_IMAGE:?immutable Builder gateway image is required}"
[[ "$GATEWAY_IMAGE" =~ ^us-central1-docker\.pkg\.dev/octogee/octogee/octogee-gateway-builder@sha256:[a-f0-9]{64}$ ]] || { echo "invalid immutable Builder gateway image" >&2; exit 2; }
EDGE_IMAGE="${OCTOGEE_DESKTOP_EDGE_IMAGE:?immutable gateway-edge image is required}"
[[ "$EDGE_IMAGE" =~ ^us-central1-docker\.pkg\.dev/octogee/octogee/gateway-edge@sha256:[a-f0-9]{64}$ ]] || { echo "invalid immutable gateway-edge image" >&2; exit 2; }
ISO_SHA256="$(iso_sha256_for "$OMARCHY_VERSION")"
[[ -n "$ISO_SHA256" ]] || { echo "no pinned checksum for Omarchy $OMARCHY_VERSION; add it to iso_sha256_for" >&2; exit 2; }
BUCKET="${BUCKET:-gs://${PROJECT}-octogee-computer-images}"
IMAGE_DISK="${BUILDER}-image"
SOURCE_SHA="$(git -C "$HERE" rev-parse HEAD 2>/dev/null || echo unknown)"
IMAGE_NAME="${REQUESTED_IMAGE_NAME:-octogee-computer-${OMARCHY_VERSION//./-}-$(date -u +%Y%m%d-%H%M)}"
[[ "$IMAGE_NAME" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || { echo "invalid image name" >&2; exit 2; }
image_labels="omarchy-iso=${OMARCHY_VERSION//./-},source=${SOURCE_SHA},purpose=octogee-computer,home-admission=retained-v1,home-restore=gated-v1"
if [[ -n "${OCTOGEE_IMAGE_FINGERPRINT:-}" ]]; then
  [[ "$OCTOGEE_IMAGE_FINGERPRINT" =~ ^[a-f0-9]{64}$ ]] || { echo "invalid image fingerprint" >&2; exit 2; }
  image_labels+=",input-a=${OCTOGEE_IMAGE_FINGERPRINT:0:32},input-b=${OCTOGEE_IMAGE_FINGERPRINT:32:32}"
fi
service_account_args=()
[[ -z "$SERVICE_ACCOUNT" ]] || service_account_args=(--service-account "$SERVICE_ACCOUNT")
run_label="${OCTOGEE_IMAGE_RUN_ID:-manual}"
[[ "$run_label" =~ ^[a-z0-9-]{1,63}$ ]] || { echo "invalid image run ID" >&2; exit 2; }
ci_lifetime_args=()
if [[ "$run_label" =~ ^[0-9]+-[0-9]+$ ]]; then
  ci_lifetime_args=(--max-run-duration=2h --instance-termination-action=DELETE)
fi

SSH_KEY="${OCTOGEE_GCE_SSH_KEY:-$HOME/.ssh/octogee_gce_ed25519}"
[[ -f "$SSH_KEY" ]] || ssh-keygen -q -t ed25519 -N "" -C "octogee-gce" -f "$SSH_KEY"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) [build]" "$*"; }
gssh() { gcloud compute ssh "imagebuilder@$BUILDER" --zone "$ZONE" --project "$PROJECT" --quiet --ssh-key-file "$SSH_KEY" --command "$1" 2>/dev/null; }

cleanup() {
  if [[ "$KEEP_BUILDER" == 1 ]]; then
    log "keeping builder $BUILDER"
  else
    gcloud compute instances delete "$BUILDER" --zone "$ZONE" --project "$PROJECT" --quiet >/dev/null 2>&1 || true
    log "builder deleted"
  fi
}

log "image ${IMAGE_NAME} (omarchy ${OMARCHY_VERSION}, source ${SOURCE_SHA}) via ${IMAGE_DISK}"
if ! gcloud -q storage ls "$BUCKET" >/dev/null 2>&1; then
  gcloud -q storage buckets create "$BUCKET" --project "$PROJECT" --location "${ZONE%-*}" --uniform-bucket-level-access >/dev/null
  log "created ${BUCKET}"
fi

payload="$(mktemp -d)"
trap 'rm -rf "$payload"' EXIT
cp "$HERE/pipeline.sh" "$HERE/customize.sh" "$payload/"
cp -R "$HERE/cidata" "$HERE/rootfs" "$payload/"
cp -R "$HERE/../rootfs" "$payload/desktop-rootfs"
COPYFILE_DISABLE=1 tar -C "$payload" -czf "$payload.tgz" .

printf 'imagebuilder:%s\n' "$(cat "$SSH_KEY.pub")" > "$payload/ssh-keys"
log "builder ${BUILDER}"
if ! gcloud compute instances describe "$BUILDER" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
  create_instance_in_first_available_zone "$BUILDER" --project "$PROJECT" \
    --machine-type n2-standard-8 --enable-nested-virtualization \
    --image-family debian-12 --image-project debian-cloud \
    --boot-disk-size 150GB --boot-disk-type pd-ssd \
    --create-disk "name=${IMAGE_DISK},device-name=${IMAGE_DEVICE_NAME},size=${IMAGE_DISK_GB}GB,type=pd-ssd,auto-delete=yes" \
    --scopes storage-rw,logging-write \
    --labels "purpose=octogee-computer-image-build,octogee-image-run=${run_label}" \
    --metadata enable-oslogin=false --metadata-from-file "ssh-keys=$payload/ssh-keys" ${service_account_args[@]+"${service_account_args[@]}"} ${ci_lifetime_args[@]+"${ci_lifetime_args[@]}"}
else
  gcloud compute instances start "$BUILDER" --zone "$ZONE" --project "$PROJECT" --quiet
fi
trap 'cleanup; rm -rf "$payload" "$payload.tgz"' EXIT
for _ in $(seq 1 30); do gssh true && break; sleep 6; done
gssh true || { echo "builder never answered ssh" >&2; exit 1; }

gcloud compute scp --zone "$ZONE" --project "$PROJECT" --quiet --ssh-key-file "$SSH_KEY" "$payload.tgz" "imagebuilder@$BUILDER:~/image-payload.tgz" 2>/dev/null
gssh "rm -rf ~/image-payload && mkdir -p ~/image-payload && tar -C ~/image-payload -xzf ~/image-payload.tgz && chmod +x ~/image-payload/*.sh"
gssh "rm -f ~/pipeline.log; nohup env OCTOGEE_DESKTOP_GATEWAY_IMAGE='$GATEWAY_IMAGE' OCTOGEE_DESKTOP_EDGE_IMAGE='$EDGE_IMAGE' OMARCHY_VERSION='$OMARCHY_VERSION' OMARCHY_ISO_SHA256='$ISO_SHA256' IMAGE_NAME='$IMAGE_NAME' IMAGE_BUCKET='$BUCKET' IMAGE_DEVICE='/dev/disk/by-id/google-${IMAGE_DEVICE_NAME}' DISK_GB='$IMAGE_DISK_GB' ~/image-payload/pipeline.sh >~/pipeline.log 2>&1 </dev/null & echo \$! > ~/pipeline.pid; echo started"

log "pipeline running on ${BUILDER}; log follows"
seen=0
while :; do
  out="$(gssh "tail -n +$((seen + 1)) ~/pipeline.log" || true)"
  if [[ -n "$out" ]]; then
    printf '%s\n' "$out" | sed 's/^/  /'
    seen=$((seen + $(printf '%s\n' "$out" | wc -l)))
  fi
  if printf '%s' "$out" | grep -q "PIPELINE_DONE"; then break; fi
  liveness="$(gssh "if kill -0 \$(cat ~/pipeline.pid) 2>/dev/null; then echo alive; elif grep -q PIPELINE_DONE ~/pipeline.log; then echo done; else echo dead; fi" || true)"
  case "$liveness" in
    alive) ;;
    done) break ;;
    dead)
      echo "pipeline exited without PIPELINE_DONE; see ~/pipeline.log on $BUILDER (use --keep-builder to inspect)" >&2
      exit 1
      ;;
    *) log "builder ssh unavailable; retrying" ;;
  esac
  sleep 20
done

installed_omarchy="$(gssh 'cat ~/image-build/omarchy-version')"
[[ "${installed_omarchy%-*}" == "$OMARCHY_VERSION" && "$installed_omarchy" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$ ]] || { echo "unexpected installed Omarchy version: $installed_omarchy" >&2; exit 1; }
image_labels+=",omarchy=${installed_omarchy//./-}"
log "installed Omarchy ${installed_omarchy} from ISO ${OMARCHY_VERSION}"
family_args=()
if [[ "$CANDIDATE" == 0 ]]; then family_args=(--family "$FAMILY"); fi
log "stopping builder to release ${IMAGE_DISK}"
gcloud compute instances stop "$BUILDER" --zone "$ZONE" --project "$PROJECT" --quiet
log "registering image"
gcloud compute images create "$IMAGE_NAME" --project "$PROJECT" \
  --source-disk "$IMAGE_DISK" --source-disk-zone "$ZONE" \
  ${family_args[@]+"${family_args[@]}"} \
  --guest-os-features UEFI_COMPATIBLE,VIRTIO_SCSI_MULTIQUEUE \
  --labels "$image_labels" \
  --format='value(name,status,diskSizeGb)'
log "IMAGE ${IMAGE_NAME}"
printf '%s\n' "$IMAGE_NAME"
