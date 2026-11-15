#!/usr/bin/bash
set -euo pipefail

OMARCHY_VERSION="${OMARCHY_VERSION:?}"
IMAGE_NAME="${IMAGE_NAME:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WLRCTL_REF="${WLRCTL_REF:-v0.2.2}"
NOVNC_VERSION="${NOVNC_VERSION:-1.7.0}"
NOVNC_SHA256="${NOVNC_SHA256:-b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6}"
WEBSOCKIFY_VERSION="${WEBSOCKIFY_VERSION:-0.13.0}"
HYPRBARS_COMMIT="${HYPRBARS_COMMIT:-7644cecdb947060682891a0db2a0cdc5c0b9e704}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S) [customize]" "$*"; }

record_image_identity() {
  local installed
  installed="$(omarchy version)" || return 1
  [[ "${installed%-*}" == "$OMARCHY_VERSION" && "$installed" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$ ]] || { echo "installed Omarchy $installed does not match ISO $OMARCHY_VERSION" >&2; return 1; }
  printf 'OMARCHY_ISO_VERSION=%s\nOMARCHY_VERSION=%s\nIMAGE_NAME=%s\n' "$OMARCHY_VERSION" "$installed" "$IMAGE_NAME" > /etc/octogee-computer.env
}

log "packages"
OMARCHY_ALLOW_DIRECT_PACMAN=1 pacman -Syu --noconfirm --needed \
  at-spi2-core wayvnc x11vnc grim wtype wl-clipboard slurp jq python python-pip python-websocket-client bc \
  meson ninja wayland wayland-protocols libxkbcommon git \
  chromium xorg-xwayland noto-fonts noto-fonts-cjk noto-fonts-emoji ttf-jetbrains-mono zram-generator >/tmp/pacman.log 2>&1 \
  || { tail -20 /tmp/pacman.log; exit 1; }

log "Omarchy migrations"
octo_uid="$(id -u octo)"
loginctl enable-linger octo
systemctl start "user@${octo_uid}.service"
runtime_dir="$(loginctl show-user octo --property=RuntimePath --value)"
for _ in $(seq 1 30); do [[ -S "${runtime_dir}/bus" ]] && break; sleep 1; done
[[ -S "${runtime_dir}/bus" ]] || { echo "octo's user session bus never appeared at ${runtime_dir}/bus; migrations that reach systemctl --user would abort" >&2; exit 1; }
install -m 0440 /dev/stdin /etc/sudoers.d/zz-octo-build <<< 'Defaults:octo !authenticate'
visudo -cf /etc/sudoers.d/zz-octo-build >/dev/null
sudo -H -u octo env "XDG_RUNTIME_DIR=${runtime_dir}" "DBUS_SESSION_BUS_ADDRESS=unix:path=${runtime_dir}/bus" bash -lc 'omarchy migrate'

log "wlrctl ${WLRCTL_REF}"
rm -rf /tmp/wlrctl
git -c advice.detachedHead=false clone -q --depth 1 --branch "$WLRCTL_REF" https://git.sr.ht/~brocellous/wlrctl /tmp/wlrctl
meson setup /tmp/wlrctl/build /tmp/wlrctl -Dman-pages=disabled --buildtype=release >/dev/null
ninja -C /tmp/wlrctl/build >/dev/null
install -m 0755 /tmp/wlrctl/build/wlrctl /usr/local/bin/wlrctl
bash "$HERE/desktop-rootfs/usr/share/omarchy/octo-desktop/build-seat-input.sh" \
  /tmp/wlrctl/protocol/virtual-keyboard-unstable-v1.xml /usr/local/bin/octo-seat-input
rm -rf /tmp/wlrctl

log "novnc ${NOVNC_VERSION} + websockify ${WEBSOCKIFY_VERSION}"
curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" -o /tmp/novnc.tgz
printf '%s  %s\n' "$NOVNC_SHA256" /tmp/novnc.tgz | sha256sum -c --quiet -
rm -rf /opt/novnc && mkdir -p /opt/novnc
tar -xzf /tmp/novnc.tgz -C /opt/novnc --strip-components=1
rm -f /tmp/novnc.tgz
pip install --quiet --break-system-packages --no-cache-dir "websockify==${WEBSOCKIFY_VERSION}"

log "desktop session files"
cp -R --no-preserve=all "$HERE/desktop-rootfs/." /
cp -R --no-preserve=all "$HERE/rootfs/." /
chown -R root:root /usr/local/bin/octo-shims /usr/share/omarchy/octo-desktop /etc/systemd/system/octo-*.service /etc/systemd/system/octo-*.timer /etc/systemd/logind.conf.d/octo-desktop.conf /etc/modules-load.d/octo-desktop.conf /etc/sudoers.d/octo-desktop /usr/local/bin/octo-desktop-* /usr/local/bin/octo-metadata-ssh-keys
chmod 0755 /usr/local/bin/octo-desktop-* /usr/local/bin/octo-shims/* /usr/local/bin/octo-metadata-ssh-keys /usr/local/bin/octo-gateway-agent /usr/local/bin/octo-gateway-firewall /usr/local/bin/octo-grow-root /usr/local/bin/octo-home-disk /usr/local/bin/octo-home-migrate /usr/local/bin/octo-home-recovery /usr/local/bin/octo-scratch-storage /usr/local/bin/octo-limine-enroll /usr/local/bin/octo-desktop-tool-storage /usr/local/bin/docker-credential-octogee
chmod 0440 /etc/sudoers.d/octo-desktop
rm -f /etc/sudoers.d/zz-octo-nopasswd /etc/sudoers.d/zz-octo-build
visudo -cf /etc/sudoers.d/octo-desktop >/dev/null

log "SSH authentication"
usermod --password '!' root
usermod --password '!' octo
sshd -t
systemctl reload sshd.service

log "first-run tips that do not apply to a managed VM"
for tip in welcome wifi; do
  printf '#!/bin/bash\n' > "/usr/share/omarchy/install/user/first-run/${tip}.sh"
done

log "hyprbars ${HYPRBARS_COMMIT} for $(pacman -Q hyprland)"
rm -rf /tmp/hyprland-plugins
git -C /tmp init -q hyprland-plugins
git -C /tmp/hyprland-plugins remote add origin https://github.com/hyprwm/hyprland-plugins
git -C /tmp/hyprland-plugins fetch -q --depth 1 origin "$HYPRBARS_COMMIT"
git -C /tmp/hyprland-plugins checkout -q --detach FETCH_HEAD
[[ "$(git -C /tmp/hyprland-plugins rev-parse HEAD)" == "$HYPRBARS_COMMIT" ]] || { echo "hyprland-plugins checkout is not ${HYPRBARS_COMMIT}" >&2; exit 1; }
make -C /tmp/hyprland-plugins/hyprbars >/tmp/hyprbars.log 2>&1 || { tail -30 /tmp/hyprbars.log; exit 1; }
install -m 0644 /tmp/hyprland-plugins/hyprbars/hyprbars.so /usr/share/omarchy/octo-desktop/hyprbars.so
printf 'hyprbars=%s\nhyprland=%s\n' "$HYPRBARS_COMMIT" "$(pacman -Q hyprland | cut -d' ' -f2)" > /usr/share/omarchy/octo-desktop/hyprbars.built-for
rm -rf /tmp/hyprland-plugins /tmp/hyprbars.log

log "Familiar theme background"
quattro="$(find /usr/share/omarchy/themes/tokyo-night/backgrounds -maxdepth 1 -name '*-quattro.*' | head -n1)"
[[ -n "$quattro" ]] || { echo "Omarchy ${OMARCHY_VERSION} ships no *-quattro.* wallpaper in /usr/share/omarchy/themes/tokyo-night/backgrounds" >&2; exit 1; }
install -D -m 0644 "$quattro" "/usr/share/omarchy/octo-desktop/theme/backgrounds/${quattro##*/}"

log "boot: limine timeout, machine identity, services"
rm -f /etc/limine-entry-tool.d/resume.conf
limine-update >/tmp/limine-update.log 2>&1 || { tail -20 /tmp/limine-update.log; exit 1; }
rm -f /tmp/limine-update.log
sed -i -E 's/^#?timeout:.*/timeout: 0/' /boot/limine.conf
grep -q '^timeout: 0' /boot/limine.conf || printf 'timeout: 0\n' >> /boot/limine.conf
systemctl unmask NetworkManager-wait-online.service
systemctl enable octo-grow-root.service octo-limine-enroll.service octo-home-disk.service octo-home-migrate.service octo-seatd.service octo-desktop.service octo-desktop-lifecycle.service octo-metadata-ssh-keys.timer octo-gateway-agent.service sshd.service NetworkManager.service NetworkManager-wait-online.service docker.service
systemctl disable sddm.service
systemctl mask sddm.service
systemctl disable --now cups.service cups.path avahi-daemon.service bluetooth.service >/dev/null 2>&1 || true

log "desktop tool storage outside the Builder home"
/usr/local/bin/octo-desktop-tool-storage

log "identity reset + cleanup"
printf '%s\n' "$IMAGE_NAME" > /etc/octogee-computer-image
record_image_identity
: > /etc/machine-id
rm -f /var/lib/dbus/machine-id
rm -f /etc/ssh/ssh_host_*
pacman -Scc --noconfirm >/dev/null 2>&1 || true
rm -rf /var/log/journal/* /home/octo/.cache/hyprland /home/octo/.local/state/octo-desktop /tmp/pacman.log
log "done: $(cat /etc/octogee-computer-image)"
