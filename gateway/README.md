# Gateway image

The container image every gateway runs: OpenClaw, the provisioner that sets up
the users assigned to the gateway, and the platform's OpenClaw extensions. A
shared gateway and an isolated gateway run different builds of it.
[Architecture](../docs/architecture.md) shows where a gateway sits, and
[OpenClaw compatibility](../docs/openclaw-compatibility.md) lists the
patches the OpenClaw build carries.

## Default configuration

Shared and isolated seeds, class policy, and generated agent entries must use the
current native OpenClaw config schema. During a runtime recut, validate the
materialized defaults against that exact built source; update their writers
instead of relying on Doctor to translate them at every boot. Pre-boot supplies
runtime bindings and reconciles platform-owned policy. Native startup validation,
the bounded isolated-gateway failed-boot Doctor recovery, and CUA driver-artifact lint
remain enabled.
Older or hand-edited isolated gateway configuration may still need native Doctor repair;
the no-transformation requirement applies to freshly authored platform defaults.

## Isolated toolchain dependency audit

GHSA-g3hv-75wg-m249 covers minimatch `>=7.0.0 <11.0.1`. The legacy minimatch
3.1.5, 5.1.9, and 6.2.3 copies that native consumers still require sit outside
that range. The isolated toolchain dependency graph uses glob 14.0.3 and
minimatch 11.0.4, and `npm audit` reports no advisories against its lock.

## Build

Build main (`.github/workflows/build-main.yml`, running `scripts/ci/cloud-build.mjs`)
builds the gateway image with its immutable input-keyed OpenClaw base, reusing
the base when its artifacts are unchanged.

## Run it

The fleet controller installs a gateway from the `charts/octogee-gateway` chart
when an operator adds one; nobody installs that chart by hand.
[The full platform on kind](../docs/kind.md) builds this image from your
checkout, or copies the published one, and adds a gateway with it.

## Key files

| File | Purpose |
|------|---------|
| `Dockerfile` | The gateway image, layered on the OpenClaw base |
| `Dockerfile.base` | The OpenClaw base image |
| `Dockerfile.isolated-base` | The base of the isolated gateway image, with its toolchain |
| `openclaw-tarball/current.json` | The pinned OpenClaw build |
| `entrypoint.sh` | Container entrypoint: boot steps, the provisioner, then the gateway |
| `openclaw.template.json`, `openclaw.isolated.template.json` | Gateway configuration seeds for the two kinds of gateway |
| `apply-gateway-class-policy.mjs` | Re-applies the policy of the gateway's kind at boot |
| `extensions/platform/` | The platform's OpenClaw extensions |

`setup.sh`, `docker-compose.yml` and `.env.example` are a single-gateway Docker
setup from before the platform existed. They are not maintained; see
[Known rough edges](../docs/rough-edges.md).
