# Octogee Agent VM spike: Omarchy userspace, headless Hyprland, software
# rendering, VNC capture, and an HTTP control surface for the agent.
# x86_64 only: Omarchy's package mirrors do not publish arm64.

ARG OMARCHY_CHANNEL=stable

FROM --platform=linux/amd64 archlinux:base-devel AS stubs
ARG OMARCHY_CHANNEL
RUN set -eux; \
    printf 'Server = https://%s-mirror.omarchy.org/$repo/os/$arch\n' \
      "$([ "$OMARCHY_CHANNEL" = stable ] && echo stable || echo '')" \
      | sed 's#https://-mirror#https://mirror#' > /etc/pacman.d/mirrorlist; \
    sed -i 's/^#DisableSandbox/DisableSandbox/' /etc/pacman.conf; \
    grep -q '^DisableSandbox' /etc/pacman.conf || sed -i '/^\[options\]/a DisableSandbox' /etc/pacman.conf; \
    useradd -m -s /bin/bash packagebuilder; \
    install -d -o packagebuilder -g packagebuilder /tmp/stubs; \
    printf '%s\n' \
      'pkgname=omarchy-container-stubs' \
      'pkgver=1' \
      'pkgrel=1' \
      'pkgdesc="Container-only virtual providers for Omarchy machine dependencies"' \
      'arch=("any")' \
      'provides=("limine" "limine-mkinitcpio-hook" "limine-snapper-sync" "snapper" "sddm")' \
      'package() { mkdir -p "$pkgdir/usr/share/omarchy-container"; printf "container stub\\n" > "$pkgdir/usr/share/omarchy-container/stubs"; }' \
      > /tmp/stubs/PKGBUILD; \
    runuser -u packagebuilder -- bash -lc 'cd /tmp/stubs && makepkg --noconfirm'

ARG WLRCTL_REF=v0.2.2
RUN set -eux; \
    pacman -Sy --noconfirm --needed git meson ninja wayland wayland-protocols libxkbcommon; \
    git clone --depth 1 --branch "${WLRCTL_REF}" https://git.sr.ht/~brocellous/wlrctl /tmp/wlrctl; \
    meson setup /tmp/wlrctl/build /tmp/wlrctl -Dman-pages=disabled --buildtype=release; \
    ninja -C /tmp/wlrctl/build

COPY rootfs/usr/share/omarchy/octo-desktop /tmp/octo-desktop
RUN bash /tmp/octo-desktop/build-seat-input.sh \
      /tmp/wlrctl/protocol/virtual-keyboard-unstable-v1.xml /tmp/octo-seat-input

ARG NOVNC_VERSION=1.7.0
ARG NOVNC_SHA256=b1003a11b6e6e8d8f7f5e5586daae7f8ca651d8aee0aa155ff9ac841c48f52c6
RUN set -eux; \
    curl -fsSL "https://github.com/novnc/noVNC/archive/refs/tags/v${NOVNC_VERSION}.tar.gz" -o /tmp/novnc.tgz; \
    printf '%s  %s\n' "${NOVNC_SHA256}" /tmp/novnc.tgz | sha256sum -c -; \
    mkdir -p /tmp/novnc; \
    tar -xzf /tmp/novnc.tgz -C /tmp/novnc --strip-components=1

FROM --platform=linux/amd64 archlinux:base
ARG OMARCHY_CHANNEL

ENV container=docker \
    OMARCHY_PATH=/usr/share/omarchy

RUN echo 'en_US.UTF-8 UTF-8' > /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

RUN set -eux; \
    case "${OMARCHY_CHANNEL}" in \
      stable) ARCH_MIRROR='https://stable-mirror.omarchy.org/$repo/os/$arch'; OMARCHY_REPO='https://pkgs.omarchy.org/stable/$arch' ;; \
      edge)   ARCH_MIRROR='https://mirror.omarchy.org/$repo/os/$arch';        OMARCHY_REPO='https://pkgs.omarchy.org/edge/$arch' ;; \
      *) echo "Unsupported OMARCHY_CHANNEL=${OMARCHY_CHANNEL}" >&2; exit 2 ;; \
    esac; \
    printf 'Server = %s\n' "${ARCH_MIRROR}" > /etc/pacman.d/mirrorlist; \
    sed -i 's/^#DisableSandbox/DisableSandbox/' /etc/pacman.conf; \
    grep -q '^DisableSandbox' /etc/pacman.conf || sed -i '/^\[options\]/a DisableSandbox' /etc/pacman.conf; \
    printf '\n[omarchy]\nSigLevel = Optional TrustAll\nServer = %s\n' "${OMARCHY_REPO}" >> /etc/pacman.conf; \
    pacman -Syy --noconfirm; \
    pacman -S --noconfirm --needed archlinux-keyring; \
    pacman-key --init; \
    pacman-key --populate archlinux; \
    install -d /tmp/shims; \
    printf '#!/bin/sh\nexit 0\n' > /tmp/shims/modprobe; \
    printf '#!/bin/sh\nexit 0\n' > /tmp/shims/udevadm; \
    chmod 0755 /tmp/shims/modprobe /tmp/shims/udevadm; \
    PATH="/tmp/shims:${PATH}" pacman -Syu --noconfirm --needed \
      at-spi2-core bash ca-certificates curl dbus git glib2 sudo shadow util-linux procps-ng \
      iproute2 jq python systemd polkit pambase libinput xdg-desktop-portal \
      libglvnd mesa mesa-utils vulkan-icd-loader; \
    rm -rf /tmp/shims

COPY --from=stubs /tmp/stubs/omarchy-container-stubs-1-1-any.pkg.tar.zst /tmp/stubs.pkg.tar.zst

RUN set -eux; \
    pacman -U --noconfirm /tmp/stubs.pkg.tar.zst; \
    sed -i '/^[[:space:]]*SigLevel[[:space:]]*=/s/.*/SigLevel = Optional TrustAll/' /etc/pacman.conf; \
    pacman -S --noconfirm --needed omarchy-settings omarchy; \
    sed -i 's/^SigLevel = Optional TrustAll$/SigLevel = Required DatabaseOptional/' /etc/pacman.conf; \
    pacman -Syy --noconfirm; \
    pacman -S --noconfirm --needed \
      wayvnc x11vnc grim wtype wl-clipboard slurp \
      labwc wlr-randr \
      chromium xorg-xwayland \
      foot noto-fonts noto-fonts-cjk noto-fonts-emoji ttf-jetbrains-mono; \
    rm -f /tmp/stubs.pkg.tar.zst; \
    pacman -Scc --noconfirm

ARG WEBSOCKIFY_VERSION=0.13.0
RUN set -eux; \
    pacman -S --noconfirm --needed python-pip python-websocket-client; \
    pip install --break-system-packages --no-cache-dir "websockify==${WEBSOCKIFY_VERSION}"; \
    pacman -Scc --noconfirm

RUN set -eux; \
    useradd -m -u 1000 -G wheel,audio,video,input -s /bin/bash octo; \
    cp -aT /etc/skel /home/octo; \
    chown -R 1000:1000 /home/octo; \
    mkdir -p /opt/octo-home-seed; \
    cp -aT /home/octo /opt/octo-home-seed; \
    chown -R 1000:1000 /opt/octo-home-seed

COPY --from=stubs /tmp/wlrctl/build/wlrctl /usr/local/bin/wlrctl
COPY --from=stubs /tmp/octo-seat-input /usr/local/bin/octo-seat-input
COPY --from=stubs /tmp/novnc /opt/novnc
COPY rootfs/ /
RUN chmod 0755 /usr/local/bin/octo-desktop-* /usr/local/bin/octo-shims/*

ENV OCTO_COMPOSITOR=hyprland \
    OCTO_OUTPUT_NAME=OCTOGEE \
    OCTO_RESOLUTION=1440x900 \
    OCTO_REFRESH=30 \
    OCTO_VNC_PORT=5900 \
    OCTO_NOVNC_PORT=6080 \
    OCTO_CONTROL_PORT=7777

EXPOSE 5900 6080 7777
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/octo-desktop-entrypoint"]
