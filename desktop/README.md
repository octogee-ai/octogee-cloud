# Isolated gateway VM image

The Google Compute Engine image an isolated gateway boots when its sizing
profile puts it on a virtual machine instead of a Kubernetes pod. It is stock
[Omarchy](https://omarchy.org/), an Arch Linux desktop, installed unattended,
plus a headless desktop session, Docker, and the services that start the
gateway. The user's agent can see and drive the desktop, and the user can
watch it through the OpenClaw Control UI.

It is not a container image and Build main does not build it. It holds no
platform code of its own beyond the desktop session: the gateway that runs on
the VM is the isolated gateway image from [`gateway/`](../gateway/README.md),
pulled and started by an agent that ships inside that image. Only Google Cloud
can run it today; see [Known rough edges](../docs/rough-edges.md#google-cloud-first).

## What is here

| Path | What it is |
| --- | --- |
| [`image/`](image/README.md) | The reproducible VM image build: `build.sh`, the in-guest `pipeline.sh` and `customize.sh`, the boot test `test.sh`, the guest overlay in `image/rootfs/` (systemd units, Chromium policy, SSH key installer), and Python tests for the overlay's scripts |
| `rootfs/` | The desktop session scripts and assets the VM image and the container recipe share: `octo-desktop-session`, `octo-desktop-control` (the control API), `octo-desktop-browser`, `octo-desktop-style`, and the session's themes and plugins under `rootfs/usr/share/omarchy/octo-desktop/` |
| `acceptance/` | Acceptance scripts run against a booted desktop: accessibility, browser, native computer use, resize |
| `Dockerfile`, `docker-compose*.yml`, `measure.sh` | A container recipe that runs the same session in Docker, for development and measurement |
| `hobby/` | A separate experiment: an X11 desktop inside the isolated gateway image under gVisor, with its benchmark |
| [`docs/container-recipe.md`](docs/container-recipe.md) | Working notes from the spike that led to the image: the container recipe, the Control UI panels, the browser and computer acceptance, the control API and measurements |

## How it runs

The fleet controller creates the virtual machine from an image in the family
named by the platform chart's `global.computer.vmSpec` (`imageFamily`),
with an attached home disk, and writes the gateway's identity and image into
the instance metadata. At boot, systemd units from `image/rootfs/` mount the
home disk at `/srv/octogee`, start Docker and the desktop, and start
`octo-gateway-agent.service`. That service waits for the `gateway-id`,
`gateway-image` and `octogee-api-url` metadata, pulls the gateway image with
the VM's service account, and runs the VM gateway agent
([`scripts/entrypoints/vm-gateway-agent.ts`](../scripts/entrypoints/vm-gateway-agent.ts),
[`scripts/lib/vm-gateway-agent/`](../scripts/lib/vm-gateway-agent/)) from that
image against the host Docker socket. The agent runs the gateway and
gateway-edge containers. [`image/README.md`](image/README.md#what-runs-on-the-vm-at-boot)
lists every unit.

The desktop session runs as the user `octo`: Hyprland on a virtual display,
wayvnc, noVNC, Chromium and a control API on `127.0.0.1:7777`. Everything it
serves is bound to loopback. The gateway's desktop node drives the session for
the agent's computer and browser tools.

## What it talks to

| Peer | Over | For |
| --- | --- | --- |
| The Compute Engine metadata server | HTTP | Gateway identity, image and API address, SSH keys, the restore gate |
| The container registry | Docker, with the VM's service account | The gateway and gateway-edge images |
| The platform services | The [VM bridge](../vm-bridge/README.md)'s internal load balancer | The platform API, the LLM broker, the npm cache proxy, Mattermost and Gitea, reached by the gateway containers |
| Object storage | Signed URLs from the platform API's fleet broker | Home checkpoints, so a replaced VM restores the user's home |

## Configuration

The VM takes its configuration from instance metadata the fleet controller
writes, not from environment variables. The values an install sets are in the
platform chart under `global.computer`: `enabled`, `projectId`,
`serviceAccountEmail`, `cidr`, `kubernetesApiHost` and `vmSpec` (machine type,
image family, service account and subnetwork). The fleet controller reads them
as `GATEWAY_VM_*` variables; see the
[fleet controller's configuration](../fleet-controller/README.md#configuration).

## Build and test

The image builds on Google Cloud, on a builder VM with nested virtualization:

```bash
desktop/image/build.sh --project <project> --candidate
desktop/image/test.sh --project <project> --image <candidate-name> --stop-start
```

`build.sh` needs the isolated gateway and gateway-edge images by digest in
`OCTOGEE_DESKTOP_GATEWAY_IMAGE` and `OCTOGEE_DESKTOP_EDGE_IMAGE`, and preloads
them onto the boot disk. It accepts only references to one hard-coded Artifact
Registry repository, the hosted service's, so building for another registry
means changing the check at the top of `build.sh`.
[`image/README.md`](image/README.md) covers the build
steps, the pins, acceptance and publication to the image family.

The tests that need no VM run in the `scripts` package:

```bash
cd scripts
npm ci
npx vitest run __tests__/desktop-*.spec.ts __tests__/vm-gateway-agent
```

Those specs run the Python tests under `image/` with `python3` and check the
session scripts and image build scripts.

To run the session in Docker on an x86_64 Linux host:

```bash
cd desktop
OCTO_COMPOSITOR=labwc docker compose up --build
```

[`docs/container-recipe.md`](docs/container-recipe.md#run) explains the
compositor choice and the ports.
