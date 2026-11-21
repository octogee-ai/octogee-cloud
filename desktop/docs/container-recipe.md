# Omarchy desktop container recipe

The [component README](../README.md) describes the isolated gateway desktop,
and the [VM image guide](../image/README.md) covers its reproducible build.
This guide explains the container recipe and its display requirements. Paths
that do not start with `desktop/` are relative to that directory.

x86_64 only: Omarchy's mirrors do not publish arm64. On Apple Silicon the image
builds under Rosetta emulation but cannot run the compositor (below); use an
x86_64 Linux host with `/dev/dri`.

## Finding: Hyprland needs a DRM render node

Hyprland 0.56 / aquamarine 0.14 refuses to create a backend without a DRM
device, even for a headless output:

```
ERR  from aquamarine ]: drm: No gpus in scanGPUs.
ERR  from aquamarine ]: DRM Backend failed
CRIT from aquamarine ]: Cannot open backend: no allocator available
```

Nesting Hyprland inside a software-rendered wlroots compositor (`cage` with
`WLR_BACKENDS=headless WLR_RENDERER=pixman`) fails the same way: aquamarine's
Wayland backend reports `Missing protocols` (no linux-dmabuf) and again has no
allocator. Docker Desktop's VM has no `/dev/dri` and no `vkms` module; COS
nodes and gVisor expose no DRM device either.

Consequence: a container on a GPU-less node cannot host Omarchy. A VM with
virtio-gpu can, which is the direction the VM image took. This recipe
stays useful on any host that has `/dev/dri`.

Everything else in the pipeline is compositor-agnostic (wlr-screencopy,
virtual pointer and keyboard, foreign-toplevel), so the image also carries
**labwc with the pixman renderer** as a software-rendered fallback:
`OCTO_COMPOSITOR=labwc` runs GPU-less anywhere and proves streaming, driving,
the control API, Chromium and the cost of everything except Hyprland itself.
It is not Omarchy; it exists to measure and to keep iterating without a GPU.

## Run

```bash
cd desktop
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

The GPU override passes `/dev/dri` through; without it Hyprland exits
immediately with the aquamarine error above. If the host has more than one
DRM device, set `AQ_DRM_DEVICES=/dev/dri/cardN` to pick one. Host port 5900 is
often taken by macOS Screen Sharing; override with `OCTO_VNC_PORT=15900`.

Chromium's sandbox is enabled by default in the launcher and on gateway VMs.
The Docker development recipe explicitly sets `OCTO_CHROMIUM_NO_SANDBOX=1`
because the container's default restrictions block Chromium's user namespaces
(`unshare --user --map-root-user true` fails with `Operation not permitted`).
This opt-out belongs only to the development container; it is absent from VM
configuration. Set `OCTO_CHROMIUM_NO_SANDBOX=0` when using a container runtime
that permits the sandbox. The launcher accepts only `0` or `1` and fails before
starting Chromium for any other value. Docker acceptance with the opt-out does
not verify Chromium sandbox isolation; native VM acceptance does.

Chromium connects directly unless the user routes the VM's web
traffic through their desktop shell. gateway-edge records the mode through the
control API (`POST /egress`) in `~/.config/octogee/egress-mode`, and
the supervisor restarts Chromium when it changes. Only in `desktop` mode does
the launcher put Chromium behind gateway-edge's loopback SOCKS5 listener
(`--proxy-server=socks5://127.0.0.1:1080`, names resolved at the proxy, and
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp` so WebRTC cannot
open direct UDP around it). A missing file means `cloud`; an unknown value
fails before Chromium starts. The Docker development recipe has no
gateway-edge, so it sets `OCTO_CHROMIUM_EGRESS_PROXY=0`, which keeps Chromium
direct whatever the file says; the VM image keeps the default `1`. A missing
file reads as `cloud` because gateway-edge releases before the egress tunnel
have no SOCKS listener at all; the cost is that a user already in desktop
mode on the first tunnel release (which never writes the file) browses
directly on an image with this launcher, so deploy a gateway-edge that writes
the mode before publishing that image to a gateway using desktop mode.

GPU-less (any host, including Apple Silicon under Rosetta):

```bash
OCTO_COMPOSITOR=labwc docker compose up --build
OCTO_COMPOSITOR=labwc ./measure.sh
```

| Port | What |
| --- | --- |
| 7777 | Control API (below) |
| 6080 | noVNC over websockify: `http://localhost:6080/vnc.html?autoconnect=true` |
| 5900 | wayvnc RFB listener (any VNC viewer) |

wayvnc runs with `--render-cursor` because the headless output has no hardware
cursor plane. The websockify/noVNC endpoint remains an operator diagnostic;
Users see the desktop through the OpenClaw Control UI Browser and Desktop panels.

wayvnc 0.10.1's own `--websocket` listener segfaults as soon as noVNC connects
(labwc + pixman, under Rosetta; not retested on x86_64), so websockify fronts
the RFB port instead.

`./measure.sh` boots the container, waits for the control API and the Chromium
window, samples CPU and memory idle and under a screenshot loop, drives one
navigation through the control API, and prints a results block for the table
below.

## OpenClaw Control UI panels

The Browser panel uses the gateway's attach-only `computer` CDP profile.
`gateway.nodes.browser.mode=off` prevents automatic delegation to the native
VM node, whose `nodeHost.browserProxy.enabled` is false.
Keep both settings: the attach-only profile reaches the Chromium the human
watches, without a second node browser profile or browser process.

The Desktop panel uses the paired desktop node's `desktop.stream` command.
Native pairing approval grants it, and the node sets `desktop.host.enabled=true`,
`managed=false`, and port `5901`. The existing local pairing loop approves the
node's expanded manifest on reconnection.

Gateway VMs use OpenClaw's `full` tool profile, without a platform node-command
deny list. The same loopback pairing approves shell, files, MCP and local
inference as well as the desktop. Native file-transfer commands are explicitly
opted in and their plugin is loaded; `octogee-desktop` asks on an unapproved
path. Exec approvals, file grants, workspace bindings and dangerous-command
checks still apply. No additional shell daemon, Ollama server, or broad file
grant is provisioned. Ollama's ambient model discovery defaults off. Native
Tool Search/harness defaults keep tools discoverable without putting every
schema upfront. The owner agent has access;
non-owner computer/browser/nodes requests still require owner approval, and project
agent restrictions remain. Shared gateways are unchanged and have no node.

`octo-desktop-openclaw-vnc` waits for WayVNC, then runs an
[x11vnc reflector](https://github.com/LibVNC/x11vnc/blob/master/doc/OPTIONS.md)
on `127.0.0.1:5901`. It serves the same desktop with VNC password authentication,
which OpenClaw requires; WayVNC's offered authentication order does not match
OpenClaw's adapter. Its per-start password lives in the private
`$XDG_RUNTIME_DIR/octogee-openclaw-vnc/password` file, readable by the desktop
node through its existing runtime-directory mount. The outer stream uses the
authenticated gateway WebSocket path, not a published VNC port.

Gateway-edge rewrites `desktop.observe` results into gateway-affine, one-use
observer tickets bound to the dashboard session and revision. The binary stream
uses the dashboard's origin, authorization, socket limits, and periodic access
checks. OpenClaw continues to enforce observation versus control at its RFB
boundary.

Rollout requires both the gateway build and a VM image containing the
reflector package/helper. A gateway-only rollout against an older VM image
cannot serve port 5901. Build the VM image and replace the parked VM
through the normal fleet lifecycle so its home checkpoint is restored.

## OpenClaw browser acceptance

The gateway VM uses OpenClaw's built-in `browser` tool with the `computer`
profile. That profile attaches to Chromium at `127.0.0.1:9222` and cannot launch
another browser. `/usr/local/bin/octo-desktop-browser` is the common launcher for the
session and desktop app opens. Its profile is
`/home/octo/.config/octogee-chromium`, uses `--password-store=basic`, and is
included in desktop-home checkpoints. CDP is not published by Docker or the
VM bridge. Only the owner agent receives the first-class browser tool; project
agents are denied it. This tool policy does not isolate processes or prevent
an agent with unrestricted exec from reaching the VM's loopback services.

`acceptance/openclaw-browser.mts` runs the real OpenClaw browser implementation,
opens a local fixture, types and clicks through snapshot references, evaluates
the result, and records both the tool screenshot and the desktop capture.
Run it in an isolated VM's network namespace with a checkout of this repository
and an installed OpenClaw source checkout available:

```bash
export OPENCLAW_SOURCE_DIR=/path/to/openclaw
export OCTOGEE_ACCEPT_ISOLATED_COMPUTER=1
export OCTOGEE_ACCEPT_OUTPUT=/tmp/computer-browser-acceptance
OCTOGEE_ACCEPT_PHASE=seed node --import "$OPENCLAW_SOURCE_DIR/node_modules/tsx/dist/loader.mjs" \
  desktop/acceptance/openclaw-browser.mts
```

The seed phase stores a persistent HttpOnly cookie and localStorage value in
the isolated profile. Stop/start the desktop or restore its checkpoint onto a
fresh VM, then run the same command with `OCTOGEE_ACCEPT_PHASE=verify`.
Verification refuses to reseed the cookie or storage; both must survive.
The output directory holds JSON tool results, native screenshots and a
throwaway OpenClaw state directory. The fixture's permission to navigate
loopback URLs applies only to this acceptance process.

To accept an immutable installed OpenClaw artifact, set `OPENCLAW_PACKAGE_DIR`
to its `node_modules/openclaw` directory and run the same harness with Node's
native TypeScript support:

```bash
OPENCLAW_PACKAGE_DIR=/path/to/installed/node_modules/openclaw \
  OCTOGEE_ACCEPT_PHASE=seed node desktop/acceptance/openclaw-browser.mts
```

Artifact mode imports the package's built plugin loader and tool resolver,
checks owner/project/custom-agent tool policy, and executes the tool returned
by actual plugin registration. Results record the package version and runtime
directory separately from source-checkout acceptance. Set
`OCTOGEE_ACCEPT_OPENCLAW_VERSION` to require an expected package version, or use
`OCTOGEE_ACCEPT_PHASE=discover` to validate registration and policy without
touching the desktop.

## Native computer acceptance

`acceptance/native-computer.sh` drives the desktop through OpenClaw's own path:
it authenticates to the co-located gateway as a local-direct operator, checks that
the `octogee-desktop` node is connected and paired with `computer.act` and
`screen.snapshot`, takes a snapshot, then types a URL into Chromium with
`computer.act` and waits for the window title to change. It then requires the
Chromium window in `get_accessibility_tree` and accessibility elements from
`get_window_state` before it drives the pointer. Run it inside the
Gateway VM's gateway container:

```bash
gcloud compute ssh <instance> --project <project> --zone <zone> --tunnel-through-iap \
  --command 'sudo docker exec -i octogee-gateway bash -s' < desktop/acceptance/native-computer.sh
```

The image acceptance in `image/test.sh` boots the desktop without a gateway, so it
verifies only the observation routes; this script is the input acceptance.

## Control API

Observation endpoints for gateway-edge and the desktop viewer. Agent input does not
pass through here: the `desktop-node` container (gateway image, OpenClaw
`cua-computer` node host) runs inside this Wayland session and fulfils the
agent's built-in `computer` tool.

| Route | Effect |
| --- | --- |
| `GET /health` | `{ok, compositor, output, monitors, clients}` |
| `GET /screenshot` | PNG of the output (grim, wlr-screencopy) |
| `GET /windows` | toplevels `{class, title, …}` (hyprctl or wlrctl) |

Every `POST` (resize, launch, note, style, time zone) is refused with 403
unless it is `Content-Type: application/json` and either carries no `Origin`
(gateway-edge and the vm-agent) or carries the API's own loopback origin (the
Desk page). Pages in the VM's own Chromium can reach 127.0.0.1:7777;
browsers always send `Origin` on a POST, and a cross-origin JSON POST needs a
CORS preflight the server never answers.

## Image shape

- `archlinux:base` on Omarchy's stable snapshot mirror plus the `omarchy` repo.
- `omarchy-container-stubs` provides `limine`, `snapper`, `sddm` so the real
  `omarchy` and `omarchy-settings` packages install without a boot stack.
- Hyprland 0.56 with its mandatory headless Aquamarine backend; no `/dev/dri`,
  rendering is llvmpipe with animations, blur and shadows off.
- No systemd. The entrypoint starts `seatd` unbound from a VT (aquamarine
  opens a libseat session even when only the headless backend will be used)
  and a session `dbus-daemon` at `/run/user/1000/bus`, standing in for the
  VM's user manager. The session then checks the accessibility bus and runs
  Hyprland → wayvnc, noVNC, control API, Chromium. A `uwsm` shim runs
  Omarchy's autostart apps directly.
- `wlrctl` is built from a checksum-pinned release archive (not packaged); noVNC is a pinned release.
- Home is seeded from `/opt/octo-home-seed` on first start into the `octo-home`
  named volume, so browser sessions survive `docker compose down`;
  `docker compose down -v` resets it (`measure.sh` always starts from a reset).

## Results

Fill from `./measure.sh`. Record the host, the runtime, and what did not work.

| Host / runtime | Image | Start → API healthy | Start → Chromium | Idle CPU / mem | Screenshot loop CPU / mem | Screenshot latency |
| --- | --- | --- | --- | --- | --- | --- |
| Apple M1 Max, Docker Desktop (Rosetta), no `/dev/dri`, `hyprland` | 2849 MiB | never: `no allocator available` | | | | |
| Apple M1 Max, Docker Desktop (Rosetta), no `/dev/dri`, `labwc` | 2849 MiB | 1.6 s | 5.8 s | 4.3% / 1.19 GiB | 4.5% / 1.19 GiB | 0.17 s |
| GCE n2-standard-8, Debian 12, Docker (runc), no `/dev/dri`, `labwc` | 2959 MiB | 1.5 s | 2.1 s | 0.4% / 514 MiB | 0.4% / 514 MiB | 0.15 s |

### Omarchy in a VM (QEMU/KVM on the GCE host, 4 vCPU / 8 GiB, unattended install)

| Guest shape | Hyprland up | Chromium mapped | Screenshot | Input verified | Settled CPU / guest mem |
| --- | --- | --- | --- | --- | --- |
| virtio-vga display device | 0.71 s | 2.5 s | 0.14 s | yes | 2.1 GiB used (Hyprland ~230% at 75 Hz before `vfr`) |
| **no display device**, `vkms` + `vgem` loaded | 0.43 s | 3.2 s | 0.09 s | yes | Hyprland 0%, Chromium 0%, 1.9 GiB used |
| **native GCE VM** (n2-standard-4) from the imported image | 0.46 s | 4.2 s | 0.10 s | yes | Hyprland 0%, Chromium 0%, 2.4 GiB used |

### Native GCE boot

The installed disk was converted to raw, patched while loop-mounted
(`modules-load.d` for `vkms` + `vgem`, serial console on the kernel cmdline,
`resume=` and quiet flags dropped), packaged as `disk.raw` in a tarball and
registered with `gcloud compute images create --guest-os-features=UEFI_COMPATIBLE`
as `omarchy-spike-v1` (family `omarchy-spike`) in a test project. It boots
Limine from the ESP fallback loader, gets DHCP from NetworkManager, and
answers SSH about 6 s after `instances create` returns. `systemd-analyze`:
2.0 s firmware + 12.5 s loader + 0.9 s kernel + 4.7 s userspace; the loader
stage is the tunable. Modules load at boot; no guest agent is installed.

Stop and start: the home (Chromium profile, files) survived two
`instances stop` / `instances start` cycles; start to SSH is 32 s (8 s API,
about 20 s guest boot). Stop takes 134 s, so the guest is not answering the
ACPI power button promptly; another tunable for the image.

The second row is the GCE shape: a GCE guest has no VGA or virtio-gpu device
(`lspci` shows none, no `/dev/dri`). `vkms` supplies the KMS display and
`vgem` supplies the render node that aquamarine's EGL renderer requires;
either alone fails (`vkms` only: "Can't create renderer, no matching
devices"; `vgem` only: "not a KMS device"). Both are stock modules in the
Arch kernel Omarchy ships, and are absent from Debian's cloud and full
kernels, which is why the container-on-Debian path stays closed. The Omarchy
guest was installed unattended from the ISO with a `cidata` drive.

The reproducible build that replaced this manual path lives in
[`image/`](../image/README.md). It preloads the isolated gateway and gateway-edge
images from the registry you name in `OCTOGEE_DESKTOP_REGISTRY` (default
`ghcr.io/octogee-ai/octogee-cloud`).

The Apple Silicon row is under x86_64 emulation; the GCE row is native and is
the number to plan with (a 4 CPU / 4 GiB container on an 8 vCPU host that was
also running a QEMU install at the time). Input verified: click, `ctrl+l`, typed URL, Return changed
the Chromium title to "Example Domain". A 150 ms settle before
the first key is required or the first keystroke after a focus change is lost
(`KEYBOARD_SETTLE_MS` in the control API).

### Acceptance checklist

- [x] Image builds; `omarchy` + `omarchy-settings` install with the stub package
- [x] GPU-less result recorded: Hyprland cannot start (finding above)
- [x] GPU-less fallback (`labwc`): `docker compose up` reaches control-API healthy and a mapped Chromium window
- [x] `GET /screenshot` returns the rendered 1440x900 desktop
- [x] `POST /click`, `/type`, `/key` change the next screenshot and the window title
- [x] noVNC renders the same output in a browser, and a click through noVNC navigates Chromium (human takeover path)
- [x] Omarchy VM with virtio-vga: Hyprland, screenshot shows the Omarchy desktop, input verified
- [x] Omarchy VM with no display device (`vkms` + `vgem`): the same, idle at 0% CPU
- [x] Boot the installed disk as a native GCE image (`omarchy-spike-v1`) and repeat: same result
- [ ] Same session scripts run inside a QEMU/KVM Omarchy VM with virtio-gpu and no host GPU
- [ ] CPU, memory, image size and time-to-ready recorded above
