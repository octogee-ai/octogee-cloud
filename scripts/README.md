# scripts

The `@octogee/scripts` package. It is not one component. It holds two kinds
of code that share one `package.json`, one lockfile and one test suite:

- **Operator tools**: the installers, the build overlay, and scripts that set
  up, check and maintain an install.
- **CI**: image build plans, release packaging, the deny-list gate and the
  PostgreSQL integration run for `core`.

The code that runs inside every gateway (the boot steps, the provisioner and
the VM gateway agent) lives in [`gateway-supervisor/`](../gateway-supervisor/README.md).

`__tests__/` holds the specs for both, and for shell scripts and Python
tests elsewhere in the repository, such as `gateway/entrypoint.sh` and the
tests under `desktop/image/`.

## What is here

| Path | Kind | What it holds |
| --- | --- | --- |
| `lib/` | Operator and CI | The code behind the tools, for example the image build plans, the component import boundary and the Dockerfile local file dependency check |
| `ops/` | Operator | The installers `kind-install.sh`, `gke-install.sh` and `eks-install.sh` with their values; `overlay.mjs`, which assembles a product build; `operator-token.mjs`; `with-platform-state.mjs`; `audit-coverage.ts`; `verify-committed-dist.mjs`; `sync-local-file-deps.mjs` |
| `*.sh` at the top level | Operator | Setting up, verifying and tearing down an install's namespace, secrets, Mattermost, Gitea, Cloud SQL and monitoring, and shells into a gateway |
| `ci/` | CI | `cloud-build.mjs` and `image-build.mjs` (what each image builds from), `release-packages.mjs` and `release-charts.mjs`, `factory-deny-list-scan.ts`, `core-postgres.mjs` |
| `__tests__/` | Specs | Vitest specs; shell scripts are tested against stubbed commands, see `__tests__/deploy/stub-host.ts` |

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

Shared code under `lib/` needs behavioral coverage; throwaway operator tools
do not. See the testing notes in [AGENTS.md](../AGENTS.md#testing).
