# Fleet controller

The fleet controller owns the fleet: which gateways exist, which user is
assigned to which gateway, and every change between those states. It serves the
Admin API that [`octogee-fleet`](https://github.com/octogee-ai/octogee-fleet)
and other operator programs call, installs and upgrades each gateway as a Helm
release, creates the virtual machine when an isolated gateway runs on one, and
moves users between gateways. Every change it makes writes an
operations-journal entry.

It acts only on what an operator or a product asks for. It adds no gateway,
places no user and moves no user by itself. It does keep each gateway at its
desired state, for example by recreating a virtual machine after a
preemption.

It is not responsible for:

- setting a user up in Mattermost and Gitea; the provisioner in the gateway
  does that through the platform API's fleet broker;
- deciding when to add, drain or retire a shared gateway; a product or an
  Admin API client decides, see [Admin API routes for automation](../docs/admin-api-automation.md);
- serving users, agents or model calls.

[Architecture](../docs/architecture.md) shows where it sits.

## How it runs

| What | Where |
| --- | --- |
| Image | `ghcr.io/octogee-ai/octogee-cloud/glm-controller`, built from [`Dockerfile`](Dockerfile) with the repository root as the build context |
| Workload | Deployment `glm-controller`, one replica with the `Recreate` strategy, service account `glm-controller`, Service `glm-controller` on port 8080 |
| Chart | the `glm-controller` subchart of the platform chart, [`charts/octogee/charts/glm-controller/`](../charts/octogee/charts/glm-controller/) |
| Entrypoint | `node dist/fleet-controller/src/main.js` under `tini` |

The deployed names are from before the directory was renamed;
[Legacy names](../docs/legacy-names.md) lists them.

[`src/main.ts`](src/main.ts) is the composition root. It calls
`main(product)` in [`src/index.ts`](src/index.ts) with no product. A product
supplies its own `main.ts` and passes a `ControllerProduct`, see
[How a product builds on top](../docs/architecture.md#how-a-product-builds-on-top).

At start it loads platform state, records the gateway build it was deployed
with, resumes operations a previous instance left running, and starts its
background loops: the reconciler that converges each gateway's Helm release
or virtual machine to its desired state, the operation worker that runs queued
operations, a poller that reads each gateway's signed fleet report, the reaper
for stuck operations, and the sweep that removes Gitea SSH keys of gateways
that no longer exist.

The same image runs two more workloads from the subchart:

- a Helm `pre-install` and `pre-upgrade` hook Job that runs
  `dist/fleet-controller/src/platform-state-migrate.js` and brings the
  platform state schema up to date;
- a CronJob every ten minutes that deletes expired platform state rows.

The image carries pinned `helm` and `kubectl` binaries, and bakes the
`charts/octogee` and `charts/octogee-gateway` charts in at `/charts`, so a
controller always installs gateways from the chart of its own build.

## What it serves

All routes are in [`src/http-server.ts`](src/http-server.ts).

| Route | What it is |
| --- | --- |
| `GET /healthz` | Liveness |
| `GET /metrics` | Prometheus metrics: reconciler ticks and failures, gateway health, VM disk use |
| `/api/admin/*` | The Admin API. Every request needs an operator identity. |

The Admin API routes themselves live in `@octogee/core`:
`core/src/admin-fleet-router.ts` (gateways, users, migrations, releases),
`core/src/admin-user-directory-router.ts`,
`core/src/admin-sizing-profile-router.ts` and `core/src/admin-logs-router.ts`.
`GET /api/admin/fleet-events` is a server-sent event stream that says when
fleet records change. The
[`octogee-fleet` Admin API contract](https://github.com/octogee-ai/octogee-fleet/blob/main/docs/admin-api.md)
covers identity, errors, idempotency and dry runs.

An operator identity is one of:

- a Google ID token whose verified email is in `fleetIdentity.operatorEmails`;
- a short-lived token signed with the operator key, whose public half is in
  the Secret named by `fleetIdentity.operatorKeySecretName`;
- whatever identity a product adds.

## What it talks to

| Peer | Over | For |
| --- | --- | --- |
| PostgreSQL | `@octogee/core/platform-state` | Users, gateways, assignments, operations and the journal. Agent store databases, through `OPENCLAW_AGENT_STORE_ADMIN_DSN`. |
| Kubernetes API | `helm` and `kubectl` with its own service account | Gateway releases, Secrets, Services, NetworkPolicies and Ingress paths in its namespace ([`role.yaml`](../charts/octogee/charts/glm-controller/templates/role.yaml)) |
| Each gateway | HTTP to the gateway pod's fleet port (3003 by default), signed with the controller's key | The gateway's report of the users it serves, unmounting a user who left, and the steps of a migration |
| Google Compute Engine | REST | Virtual machines and home disks of isolated gateways that run on a VM |
| Platform API | HTTP to `/internal/model-keys/issue` and `/internal/model-keys/revoke` | A model credential for each gateway |
| Mattermost and Gitea | Their admin APIs | Cleanup when a user is erased, and the Gitea SSH key sweep |
| Secret Manager or the PostgreSQL secret store | `@octogee/core` | Secrets the controller creates for gateways |
| Cloud KMS | `@google-cloud/kms`, when `OCTOGEE_KMS_KEY_NAME` is set | Decrypting stored connector secrets |
| Object storage | S3 API | Deleting a user's files when the user is erased |

## Configuration

The subchart's [`values.yaml`](../charts/octogee/charts/glm-controller/values.yaml)
documents each value, and [`deployment.yaml`](../charts/octogee/charts/glm-controller/templates/deployment.yaml)
maps them to environment variables. The ones an install sets:

| Value | Environment variable | What it is |
| --- | --- | --- |
| `image.repository`, `image.tag`, `image.digest` | | The controller image; all three are required |
| `platformRelease.*` | `PLATFORM_GATEWAY_*`, `BUILD_SHA` | The gateway and edge images every shared gateway converges to. `sourceSha` must be a full commit SHA. |
| `fleetIdentity.googleClientId`, `fleetIdentity.operatorEmails` | `FLEET_GOOGLE_CLIENT_ID`, `FLEET_OPERATOR_EMAILS` | Google sign-in for operators |
| `fleetIdentity.operatorKeySecretName` | `FLEET_OPERATOR_PUBLIC_KEY` | The operator key's public half |
| `deploymentTargets`, `gatewayValues` | `OCTOGEE_DEPLOYMENT_TARGETS`, `GATEWAY_VALUES_FILE` | The deployment target registry and the values every gateway release gets; empty uses the ones baked into the image |
| `modelKeyIssuer.*` | `GATEWAY_MODEL_KEY_ISSUER_*` | Where the platform API issues and revokes gateway model credentials |
| `env.gitApiUrl`, `env.mmUrl` | `GIT_API_URL`, `MM_URL` | Gitea and Mattermost; empty uses the in-cluster Services |
| `giteaGatewayKeyGc.mode` | `GITEA_GATEWAY_KEY_GC_MODE` | `enforce` deletes stale gateway SSH keys, `dry-run` only logs them |
| `ingress.*` | `GATEWAY_EDGE_INGRESS_*`, `PREVIEW_INGRESS_HOST` | The Ingress objects whose per-gateway paths the controller writes |
| `global.computer.*` (platform chart) | `GATEWAY_VM_*`, `GATEWAY_COMPUTE_PROJECT_ID` | Isolated gateways on Google Cloud virtual machines; off unless `global.computer.enabled` is set |

Platform state connects with the `PLATFORM_DB_*` variables from the
`platform-state-postgres` Secret, and the secret store with
`SECRET_STORE_BACKEND` and its root key; both are described in
[`core/README.md`](../core/README.md).

## Build and test

The package builds from this directory plus `core`, `core-testing` and
`shared`, which it installs as `file:` dependencies.

```bash
cd fleet-controller
npm ci
npm run typecheck
npm test
npm run build
```

Before `build`, `typecheck` and `test`, npm runs
`scripts/ops/sync-local-file-deps.mjs`, which refreshes the installed copies of
those libraries from their directories. It uses only Node built-ins, so
`scripts/` needs no install for it. `npm run dev` starts the controller from
source with `tsx`.

To build the image, from the repository root:

```bash
docker build -f fleet-controller/Dockerfile .
```

Specs sit beside their modules and under `src/__tests__/`. The chart is tested
by the Helm specs under `tests/specs/`.

## Where to start reading

| File | What it holds |
| --- | --- |
| `src/index.ts` | `main(product)`, the runtime wiring and the background loops |
| `src/http-server.ts` | The HTTP server and the Admin API mount |
| `src/handlers/` | One handler per operation: add, restart, recycle, roll out and retire a gateway; migrate, suspend, deprovision and erase a user |
| `src/converge-gateway.ts`, `src/reconcile-plan.ts`, `src/helm-runner.ts` | Converging a gateway's Helm release to its desired state |
| `src/vm-lifecycle.ts`, `src/lib/compute-vm.ts` | Isolated gateways on virtual machines |
| `src/gateway-heartbeat-poller.ts` | Reading each gateway's fleet report |
| `src/middleware/auth.ts` | Operator authentication |

`src/index.ts` is one of the large files [Known rough edges](../docs/rough-edges.md#large-files)
lists.
