# Octogee Gateway

Container image for the OpenClaw gateway + Firestore provisioner. Deployed to GKE Autopilot via Helm.

> **Architecture docs:** [docs/architecture/GATEWAY-PLATFORM-SPEC.md](../../../docs/architecture/GATEWAY-PLATFORM-SPEC.md) · [docs/operations/RUNBOOK.md](../../../docs/operations/RUNBOOK.md)

---

## What it does

- Runs the OpenClaw gateway hosting all user AI agents
- Connects to Mattermost for user chat through gateway-edge
- Watches Firestore — auto-provisions workspaces when users sign up
- No manual steps, no container restart needed for new users

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

## Deploy

Deployed as part of the Helm umbrella chart:

```bash
# Test
helm upgrade --install octogee helm/octogee \
  --server-side=true --force-conflicts \
  -f helm/octogee/values.test.yaml \
  -n <test-namespace> --create-namespace

# Prod
helm upgrade --install octogee helm/octogee \
  --server-side=true --force-conflicts \
  -f helm/octogee/values.prod.yaml \
  -n octogee
```

## Local development

For local Docker testing (not typical — prefer GKE):

```bash
cp .env.example .env
# Edit: fill in ANTHROPIC_API_KEY and required vars
cd infra/gateway && ./setup.sh
```

## Key files

| File | Purpose |
|------|---------|
| `Dockerfile` | Gateway image (layers on OpenClaw base) |
| `Dockerfile.base` | OpenClaw base image |
| `entrypoint.sh` | Container entrypoint (provisioner + gateway) |
| `openclaw.template.json` | Template for gateway config |
| `.env.example` | Local dev env vars |
| `docker-compose.yml` | Local dev compose (not used in prod) |

## See also

- [docs/architecture/GATEWAY-PLATFORM-SPEC.md](../../../docs/architecture/GATEWAY-PLATFORM-SPEC.md) — gateway platform model
- [docs/operations/RUNBOOK.md](../../../docs/operations/RUNBOOK.md) — operations runbook (cluster map, deploy, troubleshooting)
- [docs/operations/MATTERMOST.md](../../../docs/operations/MATTERMOST.md) — gateway-edge + Mattermost architecture
