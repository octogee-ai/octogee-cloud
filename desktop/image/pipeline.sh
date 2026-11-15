#!/usr/bin/env bash
set -euo pipefail

OMARCHY_VERSION="${OMARCHY_VERSION:?}"
OMARCHY_ISO_SHA256="${OMARCHY_ISO_SHA256:?}"
IMAGE_NAME="${IMAGE_NAME:?}"
IMAGE_BUCKET="${IMAGE_BUCKET:?}"
IMAGE_DEVICE="${IMAGE_DEVICE:?}"
DISK_GB="${DISK_GB:?}"
VM_MEM_MB="${VM_MEM_MB:-8192}"
VM_CPUS="${VM_CPUS:-4}"
SSH_PORT=2222

WORK="$HOME/image-build"
PAYLOAD="$HOME/image-payload"
ISO="$WORK/omarchy-${OMARCHY_VERSION}.iso"
OVMF_CODE=/usr/share/OVMF/OVMF_CODE_4M.fd
OVMF_VARS_SRC=/usr/share/OVMF/OVMF_VARS_4M.fd
OVMF_VARS="$WORK/OVMF_VARS.fd"
PIDFILE="$WORK/qemu.pid"
BUILD_KEY="$WORK/build_key"
MONITOR="$WORK/monitor.sock"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ) [pipeline]" "$*"; }
die() { log "ERROR: $*"; capture_failure_evidence; exit 1; }
capture_failure_evidence() {
  [[ "$guest_started" == 1 ]] || return 0
  if qemu_running && [[ -S "$MONITOR" ]]; then
    rm -f "$WORK/screen.ppm"
    printf 'screendump %s\n' "$WORK/screen.ppm" | socat -t 5 - "UNIX-CONNECT:$MONITOR" >/dev/null 2>&1 || log "screendump failed"
  fi
  local file
  for file in screen.ppm serial.log; do
    [[ -s "$WORK/$file" ]] || continue
    if gcloud -q storage cp "$WORK/$file" "${IMAGE_BUCKET}/images/${IMAGE_NAME}.failed.${file}" >/dev/null 2>&1; then
      log "failure evidence: ${IMAGE_BUCKET}/images/${IMAGE_NAME}.failed.${file}"
    else
      log "could not upload failure evidence $WORK/$file"
    fi
  done
}
is_block_device() { [[ -b "$1" ]]; }
prepare_image_disk() {
  is_block_device "$IMAGE_DEVICE" || die "image disk $IMAGE_DEVICE is not attached"
  DISK="$(readlink -f "$IMAGE_DEVICE")"
  local bytes
  bytes="$(sudo blockdev --getsize64 "$DISK")"
  (( bytes == DISK_GB * 1024 * 1024 * 1024 )) || die "image disk $DISK is $bytes bytes; expected $DISK_GB GiB"
  sudo chown "$(id -u)" "$DISK"
}
guest_ssh() {
  ssh -i "$BUILD_KEY" -p "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ConnectTimeout=5 "octo@127.0.0.1" "$@"
}
guest_scp() {
  scp -i "$BUILD_KEY" -P "$SSH_PORT" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR "$@"
}
qemu_pid() { [[ -f "$PIDFILE" ]] && cat "$PIDFILE" 2>/dev/null; }
qemu_running() { local pid; pid="$(qemu_pid)"; [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; }
qemu_stop() {
  if qemu_running; then
    kill "$(qemu_pid)" 2>/dev/null || true
    for _ in $(seq 1 30); do qemu_running || break; sleep 1; done
    qemu_running && kill -9 "$(qemu_pid)" 2>/dev/null
  fi
  rm -f "$PIDFILE"
}
wait_installed_guest() {
  local deadline=$(( $(date +%s) + $1 )) phase="" seen_live=0
  while (( $(date +%s) < deadline )); do
    phase="$(guest_ssh 'grep -q archisobasedir /proc/cmdline && echo live || echo installed' 2>/dev/null || true)"
    if [[ "$phase" == installed ]]; then return 0; fi
    if [[ "$phase" == live && "$seen_live" == 0 ]]; then seen_live=1; log "live installer answering ssh; waiting for the installed system"; fi
    if ! qemu_running; then
      die "qemu exited before the installed guest answered ssh; serial tail: $(tail -c 600 "$WORK/serial.log" | tr -d '\033' | tail -5)"
    fi
    sleep 10
  done
  die "installed guest did not answer ssh within $1 s"
}
wait_guest_down() {
  for _ in $(seq 1 120); do
    if ! qemu_running; then rm -f "$PIDFILE"; return 0; fi
    sleep 2
  done
  return 1
}

preload_gateway_image() {
  local image="${OCTOGEE_DESKTOP_GATEWAY_IMAGE:?immutable Builder gateway image is required}"
  [[ "$image" =~ ^us-central1-docker\.pkg\.dev/octogee/octogee/octogee-gateway-builder@sha256:[a-f0-9]{64}$ ]] || die "invalid immutable Builder gateway image"
  local edge="${OCTOGEE_DESKTOP_EDGE_IMAGE:?immutable gateway-edge image is required}"
  [[ "$edge" =~ ^us-central1-docker\.pkg\.dev/octogee/octogee/gateway-edge@sha256:[a-f0-9]{64}$ ]] || die "invalid immutable gateway-edge image"
  guest_ssh 'sudo -n systemctl stop docker.service docker.socket' || die "gateway preload could not stop factory Docker"
  guest_ssh 'sudo -n bash -s -- --initialize-factory' < "$PAYLOAD/rootfs/usr/local/bin/octo-scratch-storage" || die "gateway preload could not bound disposable scratch"
  guest_ssh 'sudo -n systemctl start docker.service' || die "gateway preload could not start Docker"
  guest_ssh 'sudo -n install -D -m 0755 /dev/stdin /usr/local/bin/docker-credential-octogee' < "$PAYLOAD/rootfs/usr/local/bin/docker-credential-octogee" || die "gateway preload could not install the registry credential helper"
  guest_ssh 'sudo -n install -D -m 0644 /dev/stdin /root/.docker/config.json' < "$PAYLOAD/rootfs/root/.docker/config.json" || die "gateway preload could not route the registry to its credential helper"
  if ! gcloud auth print-access-token | guest_ssh "sudo -n sh -c 'set -eu; export OCTOGEE_REGISTRY_TOKEN=\"\$(cat)\"; docker pull --quiet $image >/dev/null; docker pull --quiet $edge >/dev/null; docker image inspect $image $edge >/dev/null; printf \"%s\\n\" $image > /etc/octogee-gateway-image; printf \"%s\\n\" $edge > /etc/octogee-gateway-edge-image'"; then
    die "gateway preload failed"
  fi
}

customize_guest() {
  log "gateway image"
  preload_gateway_image
  tar -C "$PAYLOAD" -czf "$WORK/customize-payload.tgz" customize.sh rootfs desktop-rootfs
  guest_scp "$WORK/customize-payload.tgz" "octo@127.0.0.1:/tmp/customize-payload.tgz"
  guest_ssh 'rm -rf /tmp/customize && mkdir -p /tmp/customize && tar -C /tmp/customize -xzf /tmp/customize-payload.tgz && sudo -n env OMARCHY_VERSION='"$OMARCHY_VERSION"' IMAGE_NAME='"$IMAGE_NAME"' bash /tmp/customize/customize.sh' 2>&1 | sed 's/^/  [guest] /'
}

guest_started=0
mkdir -p "$WORK"
trap qemu_stop EXIT

log "deps"
sudo apt-get -o DPkg::Lock::Timeout=600 update -qq >/dev/null
sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -qq qemu-system-x86 ovmf genisoimage jq socat >/dev/null
[[ -c /dev/kvm ]] || die "/dev/kvm missing; the builder must have nested virtualization enabled"
[[ -r /dev/kvm && -w /dev/kvm ]] || sudo chmod 0666 /dev/kvm

prepare_image_disk

log "iso ${OMARCHY_VERSION}"
if [[ ! -f "$ISO" ]] || ! printf '%s  %s\n' "$OMARCHY_ISO_SHA256" "$ISO" | sha256sum -c --quiet - 2>/dev/null; then
  curl -fsSL -o "$ISO" "https://iso.omarchy.org/omarchy-${OMARCHY_VERSION}-x86.iso"
  printf '%s  %s\n' "$OMARCHY_ISO_SHA256" "$ISO" | sha256sum -c --quiet - || die "iso checksum mismatch"
fi

log "cidata"
rm -f "$BUILD_KEY" "$BUILD_KEY.pub"
ssh-keygen -q -t ed25519 -N "" -C "octogee-computer-image-build" -f "$BUILD_KEY"
build_password="$(openssl rand -hex 16)"
password_hash="$(openssl passwd -6 "$build_password")"
(umask 077; printf '%s\n' "$build_password" > "$WORK/build_password")
cidata="$WORK/cidata"
rm -rf "$cidata" && mkdir -p "$cidata"
DISK_GB="$DISK_GB" python3 "$PAYLOAD/cidata/render.py" "$PAYLOAD/cidata/user_configuration.template.json" > "$cidata/user_configuration.json"
jq -n --arg h "$password_hash" '{root_enc_password: $h, users: [{enc_password: $h, groups: [], sudo: true, username: "octo"}]}' > "$cidata/user_credentials.json"
cp "$BUILD_KEY.pub" "$cidata/authorized_keys"
printf 'false\n' > "$cidata/user_encrypt_installation.txt"
printf 'Octogee Computer\n' > "$cidata/user_full_name.txt"
printf 'computer@octogee.com\n' > "$cidata/user_email_address.txt"
genisoimage -quiet -output "$WORK/cidata.iso" -volid cidata -joliet -rock "$cidata/"

log "unattended install"
rm -f "$OVMF_VARS" "$WORK/serial.log" "$WORK/screen.ppm" "$MONITOR"
cp "$OVMF_VARS_SRC" "$OVMF_VARS"
guest_started=1
qemu-system-x86_64 \
  -cpu host -enable-kvm -machine q35,accel=kvm -smp "$VM_CPUS" -m "$VM_MEM_MB" \
  -drive "if=pflash,format=raw,readonly=on,file=$OVMF_CODE" \
  -drive "if=pflash,format=raw,file=$OVMF_VARS" \
  -drive "file=$DISK,format=raw,cache=none,if=none,id=drive0" -device virtio-blk-pci,drive=drive0,bootindex=1 \
  -drive "file=$ISO,media=cdrom,if=none,format=raw,id=cdrom0" -device ide-cd,drive=cdrom0,bus=ide.0,bootindex=2 \
  -drive "file=$WORK/cidata.iso,media=cdrom,if=none,format=raw,id=cdrom1" -device ide-cd,drive=cdrom1,bus=ide.1 \
  -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" -device virtio-net-pci,netdev=net0 \
  -device virtio-vga -display none -serial "file:$WORK/serial.log" \
  -monitor "unix:$MONITOR,server,nowait" \
  -pidfile "$PIDFILE" -daemonize -boot menu=off
wait_installed_guest 2400
log "guest up: $(guest_ssh 'cat /etc/os-release | grep PRETTY_NAME; uname -r' | tr '\n' ' ')"

log "customize"
sudo_attempt=0
until guest_ssh 'sudo -n true' 2>/dev/null; do
  sudo_attempt=$((sudo_attempt + 1))
  (( sudo_attempt <= 8 )) || die "passwordless sudo not established in the guest: $(printf '%s\n' "$build_password" | guest_ssh 'sudo -S -k true' 2>&1 | tail -3)"
  printf '%s\n' "$build_password" | guest_ssh 'sudo -S -k bash -c "echo \"octo ALL=(ALL) NOPASSWD: ALL\" > /etc/sudoers.d/zz-octo-nopasswd && chmod 0440 /etc/sudoers.d/zz-octo-nopasswd"' >/dev/null 2>&1 || true
  sleep 20
done
customize_guest
guest_ssh 'omarchy version' > "$WORK/omarchy-version"

log "seal"
guest_ssh 'sudo -n bash -c "rm -f /home/octo/.ssh/authorized_keys /root/.ssh/authorized_keys; rm -rf /tmp/customize /tmp/customize-payload.tgz; sync; systemctl --no-block poweroff"' >/dev/null 2>&1 || true
wait_guest_down || die "guest did not power off"
rm -f "$PIDFILE"
sudo blockdev --flushbufs "$DISK"

gcloud -q storage cp "$WORK/serial.log" "${IMAGE_BUCKET}/images/${IMAGE_NAME}.serial.log"
log "PIPELINE_DONE ${IMAGE_NAME} on ${IMAGE_DEVICE}"
