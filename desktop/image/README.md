# Octogee VM image

Managed desktop sessions enable Omarchy's persistent stay-awake indicator
before starting the compositor. The fleet controller owns parking; the passwordless desktop
must remain available to the Agent and authenticated viewers while running.

Reproducible build of the Builder gateway VM image: stock Omarchy from the
pinned ISO, installed unattended, plus the desktop session, `vkms` + `vgem`
for a display-less GCE guest, Docker for the gateway container, and a
metadata-driven SSH key installer.

## Build

```bash
export OCTOGEE_DESKTOP_REGISTRY=<your registry>   # default ghcr.io/octogee-ai/octogee-cloud
export OCTOGEE_DESKTOP_GATEWAY_IMAGE="$OCTOGEE_DESKTOP_REGISTRY/octogee-gateway-builder@sha256:<digest>"
export OCTOGEE_DESKTOP_EDGE_IMAGE="$OCTOGEE_DESKTOP_REGISTRY/gateway-edge@sha256:<digest>"
desktop/image/build.sh --project <test-project>
```

`OCTOGEE_DESKTOP_REGISTRY` names the one registry the image may preload
from, as `host[:port]/repository`. It defaults to the public release registry.
`build.sh`, `pipeline.sh` and `test.sh` accept only the two images above,
pinned by digest, in exactly that registry. Any other image stops the build
before a VM starts, and the error names both the image and the registry.

The factory writes `/root/.docker/config.json` for that registry's host. A
Google registry host (`<region>-docker.pkg.dev` or `gcr.io`) is routed to
`docker-credential-octogee`, which hands Docker the builder's Google access
token at build time and the VM's on the booted VM. Every other host gets no
credential helper and pulls anonymously, so a private registry that is not a
Google registry cannot be used.

1. Creates a nested-virt builder VM (`n2-standard-8`, Debian 12) with a second
   40 GB pd-ssd (`<builder>-image`, auto-deleted with the builder) that will
   become the image, and uploads the payload: `pipeline.sh`, `customize.sh`, `registry.sh`, the `cidata` template, the
   guest overlay in `rootfs/`, and the shared session scripts from
   `../rootfs`.
2. `pipeline.sh` (on the builder) downloads the ISO, verifies it against the
   checksum pinned in `build.sh`, renders the `cidata` drive (native installer
   layout for `/dev/vda`, a throwaway build password, a one-build SSH key),
   and runs Omarchy's unattended install in QEMU/KVM directly onto the
   attached image disk.
3. The factory preloads the release's digest-addressed Gateway Builder and gateway-edge
   images into Docker on the boot disk, then verifies both are present.
   `customize.sh` (inside the guest, as root) installs the session packages,
   builds `wlrctl`, installs pinned noVNC and websockify, copies the overlay
   and session scripts, enables the units, sets Limine's timeout to zero,
   cleans the kernel command line, resets the machine identity and SSH host
   keys, and records the image name in `/etc/octogee-computer-image`.
   `/etc/octogee-computer.env` records both the ISO version and installed Omarchy
   package version; the build refuses a different installed release.
4. The build key is removed and the guest powers off. The serial log goes to
   `gs://<project>-octogee-computer-images/images/`, as does failure evidence
   (serial log, screen) when the install fails.
5. `build.sh` stops the builder and `gcloud compute images create
   --source-disk` registers the image disk as
   `octogee-computer-<omarchy>-<stamp>` in family `octogee-computer` with
   `UEFI_COMPATIBLE`. Deleting the builder deletes the image disk, on success
   and on failure.

The image carries no credentials: no password login, no authorized keys, no
SSH host keys. `octo-metadata-ssh-keys.service` reconciles keys for `octo` from
the instance or project `ssh-keys` metadata at boot, which is how `test.sh`
gets in and how an operator gets in until the registration agent exists.
The timer removes revoked keys, honors `block-project-ssh-keys`, and filters
expired [Google SSH metadata entries](https://docs.cloud.google.com/compute/docs/connect/add-ssh-keys).
Active expiring keys also receive OpenSSH's `expiry-time` option, so expiration
continues to apply during a metadata outage. Failed or malformed metadata
leaves the current file intact and logs a failure for retry.

## Test

```bash
desktop/image/test.sh --project <test-project> --stop-start
python3 -m unittest desktop/image/test_acceptance.py
```

Boots the newest image in the family (or `--image <name>`), waits for SSH,
verifies every installed Octogee service executable with `systemd-analyze`,
checks the modules, all five services (including the registration agent), and
the root-growth oneshot's result,
waits for the desktop to report a Chromium
client on the loopback control API, requires Chromium on the AT-SPI registry
(`acceptance/accessibility-bus.sh`), takes a screenshot, drives a navigation
and verifies it through the window title, optionally stops and starts the VM
to prove the home persists, prints a results block, and deletes the VM.
Missing modules, non-executable service commands, inactive services, a compositor that needed a service restart,
and missing browser-profile persistence all fail acceptance.
With `--keep` the VM stays, the key lands next to the screenshot, and the
script prints the SSH tunnel to open noVNC at `http://localhost:6080/vnc.html`
and take over the desktop.

## Familiar desktop

Every Builder's desktop starts in the **Familiar** style: windows float and
overlap with traffic-light title bars (hyprbars, built in `customize.sh`
against the image's Hyprland), a bottom dock, Super+Tab window switching, and
the light `octogee` theme on the Quattro wallpaper (`*-quattro.*` from Tokyo Night; Omarchy renumbers its bundled backgrounds between releases). The stock Omarchy desktop
is one command away and both styles are stock Omarchy underneath:

```bash
octo-desktop-style familiar   # dock, title bars, floating windows, light theme
octo-desktop-style omarchy    # stock Omarchy: tiling, Tokyo Night
octo-desktop-style status
```

`octo-desktop-session` runs `octo-desktop-style apply` before the compositor:
a home with no recorded choice becomes Familiar; a recorded choice is kept,
and only its structural pieces (plugin links, `shell.json` entries, the
`require("octo-desktop.familiar")` line) are re-ensured, so a theme the
user or agent picked later survives restarts and home restores. The choice
and everything it writes live under `.config/hypr` and `.config/omarchy`,
which the home checkpoint already carries.

The dock and the window switcher are vendored Omarchy shell plugins under
`rootfs/usr/share/omarchy/octo-desktop/plugins/` at the commits recorded in
`provenance.json`; Familiar links them into `~/.config/omarchy/plugins/`.
Acceptance (`acceptance/familiar-desktop.sh`) checks the loaded hyprbars,
theme, wallpaper, plugin links, pinned desktop entries, a floating Chromium,
and a clean `omarchy` → `familiar` round trip with no Hyprland config errors.

### The Desk

At session start `octo-desktop-browser` launches Chromium with
`--app=http://127.0.0.1:7777/desk` (`OCTO_HOME_URL`): the Desk is a
frameless app window, class `chrome-127.0.0.1__desk-Default` (the same
shape Omarchy's web apps take), which `familiar.lua` floats centred at 80%
of the screen with `hyprbars:no_bar`; the stock `omarchy` style simply tiles
it. Session restore is not requested at start, so old browser windows never
reopen over the Desk; a later `chromium`/`omarchy launch browser` joins the
same profile and opens a normal browser window on top, where the managed
policy makes the homepage and new tab
(`rootfs/etc/chromium/policies/managed/octogee-desk.json`) the Desk at
`http://127.0.0.1:7777/desk`,
a static page (`rootfs/usr/share/omarchy/octo-desktop/desk/`) served by the
control API: the agent character, a speech bubble with the agent's note, the
clock, "Welcome back, {first name}" and an app grid built from the installed
desktop entries (`GET /apps`, launched through `POST /launch` the way the dock
does, `uwsm-app -- gtk-launch`). The desktop renders through llvmpipe, so the
page is static at rest: no continuous animation, a 240 ms blink every few
seconds (none under `prefers-reduced-motion`), a clock that updates once a
minute, and polling that compares state before touching the DOM; `desk.sh`
fails when the VM is under 85% idle with the Desk in front. `GET /apps` curates
the grid with desktop-entry metadata (NoDisplay/Hidden, `Terminal=true`,
`OnlyShowIn`/`NotShowIn` against Hyprland, and entries whose categories are
only System/Settings/ConsoleOnly or absent are dropped; Omarchy web apps
stay) and lists the dock's pinned apps first, then alphabetical. The page polls
`GET /desk/state`, which reads `~/.config/octogee/desk.json` and `desk.svg`;
the VM gateway agent writes both from the Builder's bootstrap payload (name,
agent name, `agents/{uid}.look`), rendering the shared character drawing, and
keeps the stored `note`. Until the agent has written them the control API
serves the shipped default drawing (`desk/character.svg`, pinned to the shared
drawing by `scripts/__tests__/desktop-desk-page.spec.ts`) and the default note.
The agent changes the note with `octo-desk note "<text>"` and the style with
`octo-desktop-style familiar|omarchy` from its gateway container; both reach
`POST /desk/note` and `POST /style` through gateway-edge's internal VM
route with the gateway's own credential. `.config/octogee` rides the home
checkpoint, so the note survives VM replacement.

`octo-desktop-style familiar --accent <#rrggbb>` recolours the `octogee`
theme's `accent`, `blue` and `selection` from the agent look colour (the
seven mascot colours have hand-tuned selection tints; any other colour is
mixed with white). The gateway agent re-runs it on a look change only while the
recorded style is Familiar and the current theme is still `octogee`; a plain
`familiar` keeps the accent already installed.

The Builder's time zone comes from their browser: the PWA sends
`Intl.DateTimeFormat().resolvedOptions().timeZone` with the signup claim and
backfills `users/{uid}.preferences.timeZone` on app load for existing
users (Firestore rules keep it IANA-shaped; every consumer re-parses it).
It rides the bootstrap `desk` field into `desk.json`, and the gateway agent
sets the VM's system zone through `POST /timezone` on the control API
(`timedatectl set-timezone`, validated against `/usr/share/zoneinfo`), only
when `GET /timezone` disagrees. The Desk clock formats in that zone and falls
back to the browser's only when `desk.json` has none. The same zone is seeded
into the agent's USER.md (`- **Timezone:**`) and that one line is re-synced
on change.

Acceptance (`acceptance/desk.sh`, run before the style round trip so the
boot-time window state is what it sees) checks the Desk app window is present
and floating with no normal browser window open, the served page, the default note and
SVG in `/desk/state`, `chromium` and `org.gnome.Nautilus` in `/apps` with a
resolvable icon, a `POST /desk/note` round trip into `desk.json`, launch input
validation, a `POST /timezone` round trip against `timedatectl` (and that the
system zone matches `desk.json` once the agent has written one), at least 85%
idle CPU after a 5 s settle with the Desk in front, the Chromium policy file,
and Chromium actually showing the Desk.

## What runs on the VM at boot

| Unit | Role |
| --- | --- |
| `octo-home-disk.service` | oneshot before Docker, the agent, and the desktop: mounts the attached `octogee-home` pd-ssd (formatting it btrfs only when blank) at `/srv/octogee` and binds `/home/octo` from its `desktop-home`, so the user home (gateway data, desktop profile, Documents, checkpoint staging) lives on its own quota-sized disk and image churn on the boot disk cannot fill it; refuses to start the agent or desktop when the disk is missing or holds another filesystem; before seeding a fresh home whose `octogee-home-restore` instance attribute is `checkpoint` it writes the restore gate `/srv/octogee/home-restore.gate`; it retries a metadata server that is unreachable or answers 5xx or 429, and fails closed when it still cannot tell or answers an unexpected value; on an `x11` VM (`octo-desktop-wanted` exits 1) it skips the `/home/octo` bind, so the login home stays on the boot disk and only the X11 gateway container mounts `desktop-home` |
| `octo-grow-root.service` | oneshot before Docker and the agent: grows the root partition (`sfdisk` + `partx`) and the btrfs filesystem to fill the boot disk, so `gcloud compute disks resize` plus a reboot recovers a full VM; a no-op when the partition already fills the disk |
| `systemd-zram-setup@zram0.service` | zstd-compressed swap in RAM sized to the machine's memory (`/etc/systemd/zram-generator.conf`), with Omarchy's zram reclaim tuning (`/etc/sysctl.d/99-omarchy-sysctl.conf`: `vm.swappiness=150`, `vm.page-cluster=0`), so a memory spike slows the desktop instead of OOM-killing it; acceptance requires it active with swappiness above 100 |
| `octo-seatd.service` | seatd unbound from a VT, so the compositor gets a seat with no console |
| `octo-desktop-wanted` | `ExecCondition` (run as root) of `octo-seatd` and `octo-desktop`: reads the `octogee-computer-desktop` instance attribute and skips both units when it is `x11`, because that VM runs the Hobby X11 desktop inside its gateway container; a missing attribute or `omarchy` starts them, and an unreachable metadata server or any other value fails the units |
| `user-runtime-dir@1000.service` | creates the desktop user's runtime mount before compositor sockets; user linger keeps it alive without an SSH session |
| `octo-desktop.service` | as `octo`, on the user manager's session bus `/run/user/1000/bus` with AT-SPI running: Hyprland on the `vkms` output at 1440x900, wayvnc, noVNC over websockify, the control API, Chromium with its accessibility tree exposed; everything bound to 127.0.0.1 |
| `octo-desktop-lifecycle.service` | root-only Unix socket for checkpoint freeze/thaw and restore stop/start of the desktop plus applications in `user@1000.service`; `stop-home` allows a full-home restore only behind a closed restore gate with the desktop, user manager and sshd inactive and no `octo` processes, and `start` refuses while the gate exists, then starts the user manager, `octo-home-migrate` and the desktop in that order, and sshd whether or not they started |
| `octo-metadata-ssh-keys.service` | installs `octo:` keys from GCE metadata before sshd |
| `octo-gateway-agent.service` | blocks the metadata server for uid 1000, polls instance metadata until `gateway-id`, `gateway-image`, and `octogee-api-url` are set, then pulls the gateway image with the VM's service account and runs the registration agent (`scripts/lib/vm-gateway-agent`) from that image against the host Docker socket, with the home disk mounted at `/srv/octogee` and no view of the boot disk's `/home/octo`. It wants `octo-home-migrate` without requiring it, so it still restarts after a failed migration; Docker keeps requiring the migration. A new image pull requires at least 16 GiB free on the Docker boot filesystem; an already-cached image can start below that threshold |
| `docker.service` | hosts the gateway and gateway-edge containers the agent manages |

Power: `HandlePowerKey=poweroff`, so a GCE stop completes on the ACPI signal
instead of waiting for the timeout. `octo` has passwordless sudo and a polkit rule
(`/etc/polkit-1/rules.d/49-octogee-builder.rules`) that answers every polkit
request for `octo` without a password, so Omarchy's own update, power and
disk actions never raise a password prompt: this is the user's own
VM and the isolated class is full power.
SDDM is masked because this image's desktop service owns the display. The
runtime-directory dependency prevents logind from mounting over live Wayland
sockets when the first SSH session opens.

Checkpoint freeze covers desktop processes and Omarchy applications launched
through the user's systemd manager. The gateway agent separately pauses its
runtime containers. Arbitrary operator processes started in SSH sessions are
outside these scopes. During a restore of an older, partial checkpoint, the
user manager is stopped and masked in `/run` so an SSH reconnect cannot restart
native applications against the home being replaced; the lifecycle start action
removes that hold.

A full-home restore never replaces a live home. It runs only on a new computer
whose fresh home booted behind the restore gate: `user@1000.service`,
`octo-home-migrate.service`, `octo-desktop.service` and `sshd.service` carry
`ConditionPathExists=!/srv/octogee/home-restore.gate`, so they are skipped while
it exists. The network, the metadata SSH key reconciler, Docker, the lifecycle
socket and the agent still start, because a skipped unit does not fail the units
that require it. The agent downloads and verifies the exact checkpoint, installs
and flushes it, then removes the gate, flushes again and asks the lifecycle to
start the writers, so migration runs against the restored files. If the
migration or the desktop fails, sshd still starts. A failed restore keeps the
gate across retries and reboots. While the gate is closed, each attempt first
sweeps the staging an interrupted attempt left on the home disk, and refuses a
checkpoint the disk cannot hold twice, at error with reason
`insufficient-space`, before downloading it; the archive is deleted as soon as
it is extracted, and the agent retries a failed restore after one minute,
doubling to thirty. Cowboy creates a checkpoint-restoring computer only from an
image labeled `home-restore=gated-v1`. A retained home never has the gate and
boots as before.

## Pins

| Input | Where |
| --- | --- |
| Omarchy 4.5.0 x86 ISO + sha256 | `build.sh` (`ISO_SHA256`); [official download](https://omarchy.org/) |
| Package set | Omarchy's stable mirror at build time; the image name carries the build stamp |
| wlrctl, noVNC, websockify | `customize.sh` |
| hyprbars (hyprwm/hyprland-plugins commit) | `customize.sh` (`HYPRBARS_COMMIT`) |
| Dock + window switcher shell plugins | `rootfs/usr/share/omarchy/octo-desktop/plugins/provenance.json` |
| Session scripts | `../rootfs` (shared with the container spike) |

## Results

`build.sh` end to end (builder create → registered image): about 11 minutes on
an n2-standard-8 builder; the unattended install itself takes 3 minutes from
the ISO's offline mirror, customization 30 seconds, packaging and upload 3.5
minutes.

`test.sh --stop-start` on `octogee-computer-4-0-2-20260905-0555`,
n2-standard-4, 2026-09-05:

| Metric | Value |
| --- | --- |
| Create to SSH | 42 s |
| Create to desktop healthy (Chromium mapped) | 50 s |
| Guest boot (systemd-analyze) | 2.1 s firmware + 8.3 s loader + 1.1 s kernel + 8.1 s userspace = 19.6 s |
| vkms + vgem loaded | yes |
| Input verified (typed URL changed window title) | yes |
| Home survives stop/start | yes, 29 s from start to SSH |

Findings baked into the pipeline, each cost one build: Omarchy's ISO answers
SSH from the live installer (wait for the installed kernel cmdline); the
installer writes `/etc/sudoers.d/04_octo` with a password rule and sudoers
is last-match-wins (the bootstrap entry sorts after it); Omarchy masks
`NetworkManager-wait-online` (unmask before enabling); the overlay copy must
not carry the payload's ownership onto `/etc`; QEMU unlinks its pidfile on a
clean exit; the seal removes the build key so the poweroff rides the same SSH
session; the builder needs `/dev/kvm` opened; `gcloud compute ssh` with the
default RSA key was refused by fresh VMs on 2026-09-05 while an ed25519 key
delivered the same way worked, so the orchestrator uses its own ed25519 key.

## Candidate acceptance and publication

Build with `--candidate` to register an image without advancing the family:

```bash
desktop/image/build.sh --project <test-project> --candidate
desktop/image/test.sh --project <test-project> --image <candidate-name> --stop-start
```

Acceptance checks the native resize API, screenshot dimensions, and XWayland
geometry at 800×600 and 1024×768, restores 1440×900, and repeats after stop/start.
Missing resize support fails acceptance. The Python acceptance fixtures and
candidate-family behavior run in the scripts CI suite.

After acceptance, publication assigns that exact image to the environment's
`octogee-computer` family. Record publication in the
operations journal. Existing boot disks do not change when a family advances;
The fleet controller moves a parked VM to the current image on its next boot. Replace
a VM immediately with `fleet --env=test gw replace-computer <gateway-id> --apply` when requested. This checkpoints and restores home.
New gateway VMs have 80 GiB boot disks. Enlarge an existing smaller boot disk
and cold-start the VM to apply that capacity; a suspended VM does not
run `octo-grow-root` until a cold boot.
Check `fleet --help` before running an operator command.

## CI/CD

The `desktop-image` job in `build-main.yml` calls these same build and acceptance
scripts. A fingerprint covers the rootfs, ISO and tool pins, installer,
acceptance scripts, build driver, and both runtime image digests. Unchanged inputs reuse the accepted GCE
image; a cache miss builds a candidate without changing the image family,
then runs a boot smoke check on a disposable VM: installed-version verification,
both preloaded image digests, required services, home storage, and desktop health.
UI, resize, and stop/start tests remain explicit operator qualification through
`test.sh --stop-start`; they do not run in normal builds. The VM agent starts matching
local immutable images without a registry request; an explicit later runtime
update can fetch a missing image through the existing owner.
Only successful acceptance creates an immutable descriptor in
`gs://<test-project>-octogee-computer-images/accepted/`.

The existing release manifest records `desktopImage`: project, image name,
numeric GCE image ID, source SHA, input fingerprint, and acceptance version.
Both cache reuse and publication verify the live image identity. Recreating an
image under the same name fails that check. A retry can accept an existing
candidate with matching inputs without rebuilding it.

**Deploy platform build** (`release-environment.yml`) publishes the selected
SHA's desktop image after its platform deploy succeeds; a release whose image
is already the family image changes nothing. Publish
the family alone (rollback or retry) with the Fleet CLI:

```bash
npm run --prefix scripts fleet -- --env=test desktop-image publish --sha=<full-main-sha>
npm run --prefix scripts fleet -- --env=test desktop-image publish --sha=<full-main-sha> --apply
```

The first command previews the artifact and the planned change. The second
journals publication and advances the TEST family. VMs retain their
current disks until the fleet controller's next boot upgrade. Use the existing per-gateway
`gw replace-computer` command for an explicitly selected VM.

For PROD, select `--env=prod`: Fleet copies the tested image from TEST into the
PROD image project, verifies the copy's source image ID, then publishes it.
It does not rebuild. An older manifest can be selected to roll back the family.
Manifests predating desktop artifacts cannot publish a desktop image, so a
platform release of such a SHA fails at its desktop-image job.

CI uses the existing GitHub WIF authentication. The TEST Terraform environment
owns its temporary-compute permissions, dedicated builder service account, and
image-bucket access. Release publication additionally needs image-family
update and PROD image-copy permissions.
The builder has a 60-minute deadline and acceptance a 15-minute deadline.
CI VMs also have a two-hour GCE automatic deletion limit, independent of the
runner. An always-running cleanup step deletes this run's temporary VMs; the next
image job also removes abandoned CI VMs older than two hours. Operator builds
are excluded from that cleanup.

Image acceptance verifies the host desktop, browser input, resize, XWayland
geometry, and reboot persistence. It does not start a paired OpenClaw agent;
gateway container and node wiring remain covered by their existing tests.

The accepted image `octogee-computer-4-0-2-20260907-1302` was published to TEST
on 2026-09-07. Fresh-VM acceptance passed before and after stop/start.
