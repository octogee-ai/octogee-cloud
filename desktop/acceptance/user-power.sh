#!/usr/bin/env bash
set -euo pipefail

fail() { echo "user power: $*" >&2; exit 1; }
export OMARCHY_PATH="${OMARCHY_PATH:-/usr/share/omarchy}"

sudo -n true 2>/dev/null || fail "sudo asks octo for a password"
timeout 20 pkexec --disable-internal-agent true 2>/dev/null || fail "polkit still asks octo for a password (pkexec exit $?)"

[[ ! -e /etc/limine-entry-tool.d/resume.conf ]] || fail "Omarchy's resume drop-in is still installed"
[[ "$(systemctl show octo-limine-enroll.service --property=Result --value)" == success ]] || fail "octo-limine-enroll did not succeed: $(systemctl show octo-limine-enroll.service --property=Result --value)"
sudo limine-update >/dev/null 2>&1 || fail "limine-update failed"
machine_ids="$(sudo grep -o 'machine-id=[0-9a-f]*' /boot/limine.conf | cut -d= -f2 | sort -u | tr '\n' ' ')"
[[ "$machine_ids" == "$(cat /etc/machine-id) " ]] || fail "boot entries are not enrolled under this machine id alone: $machine_ids"
recorded="$(sudo grep -o 'omarchy_linux-omarchy.efi#[0-9a-f]*' /boot/limine.conf | cut -d# -f2 | sort -u)"
actual="$(sudo b2sum /boot/EFI/Linux/omarchy_linux-omarchy.efi | cut -d' ' -f1)"
[[ "$recorded" == "$actual" ]] || fail "limine.conf hash for the kernel image does not match the file after limine-update"
cmdlines="$(sudo grep -E '^[[:space:]]*cmdline:' /boot/limine.conf)"
grep -q 'console=ttyS0' <<< "$cmdlines" || fail "regenerated boot entries lost the serial console: $cmdlines"
! grep -q 'resume=' <<< "$cmdlines" || fail "regenerated boot entries carry a resume device: $cmdlines"

tips="$(grep -l -E '"summary":"(Update System|Setup Wi-Fi|Learn Keybindings)"' "$HOME"/.local/state/omarchy/notifications/*.json 2>/dev/null || true)"
[[ -z "$tips" ]] || fail "Omarchy first-run tips reached the user: $tips"

updates="$(omarchy-update-available 2>&1 || true)"
printf 'user power: sudo and polkit passwordless, boot entry enrolled under this machine id, keeps console and drops resume after regen, no first-run tips, %s\n' "$(head -n1 <<< "$updates")"
