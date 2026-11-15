# scripts

The `@octogee/scripts` package. It is not one component. It holds three
kinds of code that share one `package.json`, one lockfile and one test suite:

- **Code that runs inside every gateway**: the boot steps, the provisioner,
  and the VM gateway agent. The gateway image copies it to `/octogee/scripts`.
  The provisioner is to move to a component of its own, the way the other
  services have; until then it lives here.
- **Operator tools**: the installers, the build overlay, and scripts that set
  up, check and maintain an install.
- **CI**: image build plans, release packaging, the deny-list gate and the
  PostgreSQL integration run for `core`.

`__tests__/` holds the specs for all three, and for shell scripts and Python
tests elsewhere in the repository, such as `gateway/entrypoint.sh` and the
tests under `desktop/image/`.

## What is here

| Path | Kind | What it holds |
| --- | --- | --- |
| `entrypoints/` | Gateway | One file per process or boot step the gateway starts. [`provisioner.ts`](entrypoints/provisioner.ts) is the provisioner; [`vm-gateway-agent.ts`](entrypoints/vm-gateway-agent.ts) runs on an isolated gateway's virtual machine. |
| `lib/` | Gateway, operator and CI | The code behind the entrypoints and tools, for example `fleet-provisioner.ts`, `fleet-http-migration.ts`, `user-lifecycle.ts`, `provision-reconcile.ts`, `git.ts`, `config.ts`, and `vm-gateway-agent/` |
| `libexec/` | Gateway | `source-transfer-launcher.py`, used during a migration |
| `src/main.ts` | Gateway | The composition root the entrypoints import; a product build replaces it |
| `secret-resolver.mjs`, `publish-gateway-token.mjs` | Gateway | The resolver OpenClaw calls for a secret reference, and the boot step that stores the gateway's token in Secret Manager |
| `ops/` | Operator | The installers `kind-install.sh`, `gke-install.sh` and `eks-install.sh` with their values; `overlay.mjs`, which assembles a product build; `operator-token.mjs`; `with-platform-state.mjs`; `audit-coverage.ts`; `verify-committed-dist.mjs`; `sync-local-file-deps.mjs` |
| `*.sh` at the top level | Operator | Setting up, verifying and tearing down an install's namespace, secrets, Mattermost, Gitea, Cloud SQL and monitoring, and shells into a gateway |
| `ci/` | CI | `cloud-build.mjs` and `image-build.mjs` (what each image builds from), `release-packages.mjs` and `release-charts.mjs`, `factory-deny-list-scan.ts`, `core-postgres.mjs` |
| `__tests__/` | Specs | Vitest specs; shell scripts are tested against stubbed commands, see `__tests__/deploy/stub-host.ts` |

## The provisioner

The provisioner runs in every gateway, started by
[`gateway/entrypoint.sh`](../gateway/entrypoint.sh) under the runner
supervisor (`entrypoints/supervise-runner.ts`). It reads which users are
assigned to its gateway and sets each one up through the platform API's fleet
broker: their Mattermost account, team, channels and agent bot, their Gitea
organization and `workspace` repository, and their agent in OpenClaw. When the
fleet controller tells it a user has left, it removes that user's local
footprint.

It holds no admin credentials and no database login. It calls the fleet
broker at `FLEET_BROKER_URL`, by default the platform API's in-cluster
Service, with the gateway's projected Kubernetes service account token, and the broker checks which gateway is asking and which users that
gateway serves.

It serves the gateway's fleet port, `FLEET_CONTROLLER_PORT` (3003 by default):
health and readiness, the signed report of the users it serves that the fleet
controller polls, and the routes the fleet controller drives a migration
through (`registerMigrationRoutes` in
[`lib/fleet-provisioner.ts`](lib/fleet-provisioner.ts)).

`gateway/entrypoint.sh` supervises it under the runner name `fleet-controller`,
and some log lines use that name, from before the provisioner and the fleet
controller were separate. Other names that keep an earlier spelling are in
[Legacy names](../docs/legacy-names.md).

## Build and test

```bash
cd scripts
npm ci
npx tsc --noEmit
npm test
npm run gate
```

`npm test` runs every spec under `__tests__/`. Some specs need `helm`, and the
ones that run Python tests need `python3`. `npm run gate` is the deny-list
gate: it scans the whole repository and refuses private identifiers and
commercial terms. `npm run audit-coverage` lists source files no spec reaches,
following the import graph.

Runtime code under `lib/` needs behavioral coverage; throwaway operator tools
do not. See the testing notes in [AGENTS.md](../AGENTS.md#testing).
