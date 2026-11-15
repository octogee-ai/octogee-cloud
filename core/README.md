# @octogee/core

```bash
npm install @octogee/core@X.Y.Z @octogee/shared@X.Y.Z
```

Each octogee-cloud release `vX.Y.Z` publishes this package at `X.Y.Z`; install
`@octogee/shared` at the same version. Its test helpers are
published separately as `@octogee/core-testing`.

The runtime library the platform's services share. The fleet controller, the
platform API, the edge, and the gateway's boot steps and provisioner in
`scripts/` import it as `@octogee/core/<module>`, never by relative path. It
runs no process of its own and has no image: it is code that runs inside those
services.

It holds:

| Area | Modules | What it is |
| --- | --- | --- |
| Platform state | `platform-state/`, `platform-state/postgres/` | `PlatformStateStore`: users, gateways, assignments, operations, the operations journal and platform configuration in PostgreSQL, with the schema migrations |
| Secrets | `secret-store`, `postgres-secret-store`, `secret-manager`, `encryptor`, `cloud-kms-encryptor` | The `SecretStore` the platform writes the secrets it creates to: encrypted rows in PostgreSQL under a root key, or Google Secret Manager |
| Chat and git hosts | `channel-host/`, `mattermost/`, `git-host/` | The `ChannelHost` and `GitHost` interfaces, with their Mattermost and Gitea adapters |
| Identity | `identity-provider`, `operator-token`, `user-identity-provider` | Operator sign-in with Google ID tokens or operator-key tokens, and the interface a product implements for user sign-in |
| Admin API | `admin-fleet-router`, `admin-user-router`, `admin-user-directory-router`, `admin-sizing-profile-router`, `admin-shared-pool-router`, `admin-vm-router`, `admin-logs-router` | The Express routers behind the fleet controller's `/api/admin` |
| Agent stores | `agent-store-*`, `agent-postgres` | Each agent's own PostgreSQL store: credentials, inventory, recovery and reset |
| Fleet operations | `fleet-migration*`, `fleet-state`, `fleet-signature`, `gateway-rpc`, `gateway-*`, `scheduler-custody` | Moving users between gateways, signed calls between the fleet controller and gateways, gateway releases and restarts |
| Deployment targets | `deployment-targets.json`, `resolve-deployment-target`, `render-deployment-target-helm-values` | The registry of installs the platform can target, and the Helm values each renders |

It decides nothing about the fleet; it holds the records and the mechanisms
the services act through. Types and constants with no runtime dependencies
belong in `@octogee/shared`.

The `exports` map in `package.json` lists every public module.
`src/<module>.ts` is the source of `@octogee/core/<module>`.

## What it talks to

From inside whichever service calls it, code in core reaches:

- PostgreSQL, with `pg`: platform state, the PostgreSQL secret store and the
  agent stores;
- Google Secret Manager and Cloud KMS, when the secret store or the encryptor
  is configured for them;
- the Mattermost and Gitea APIs, through the host adapters;
- gateways, through the signed RPC helpers.

## Configuration

Core reads its configuration from the calling service's environment.

| Variable | What it is |
| --- | --- |
| `PLATFORM_DB_HOST`, `PLATFORM_DB_PORT`, `PLATFORM_DB_NAME`, `PLATFORM_DB_USER`, `PLATFORM_DB_PASSWORD` | The platform state database |
| `PLATFORM_DB_SSLMODE`, `PLATFORM_DB_CA_CERT`, `PLATFORM_DB_TLS_SERVER_IDENTITY` | TLS to that database |
| `PLATFORM_DB_POOL_MAX` | The connection pool size |
| `SECRET_STORE_BACKEND` | `postgres`, the default, or `secret-manager` |
| `SECRET_STORE_ROOT_KEY`, `SECRET_STORE_PREVIOUS_ROOT_KEY` | The root key the PostgreSQL secret store encrypts under, and the one a rotation moves from |

`src/platform-state/postgres/connection.ts` and `src/secret-store.ts` read
them. The platform chart sets them for each service from the
`platform-state-postgres` Secret and the root key Secret; see
`charts/octogee/charts/glm-controller/templates/_platform-state.tpl`.

## Consumer contract

```jsonc
// <consumer>/package.json
"dependencies": { "@octogee/core": "file:../core" }
```

```ini
# <consumer>/.npmrc
install-links=true
```

`install-links=true` makes npm pack the committed directory interface into a real
installed package rather than a symlink. `npm ci` installs the current committed
`dist/` without an install-time build, while the lock records only the directory
path. Core's own dependencies install normally, so runtime modules work from a
standalone consumer.

```ts
import { primaryWorkspaceSlug } from "@octogee/core/workspace-slugs";
```

Resolution uses the `exports` map for NodeNext consumers and `typesVersions` for
node10 consumers. `@octogee/shared` is a peer dependency, so each consumer
installs it beside core.

## Build and test

```bash
cd core
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` runs the specs against `src/`: `vitest.config.ts` resolves
`@octogee/core/<module>` to source, so the helpers from `@octogee/core-testing`
and the specs share one copy of core. Specs named `*.integration.spec.ts` need
PostgreSQL. `node ../scripts/ci/core-postgres.mjs` starts a throwaway
PostgreSQL 16 server and runs them; it expects PostgreSQL 16 and pgvector
under `/usr/lib/postgresql/16`, as on the CI runner.

`qualify-agent-store-routines.mjs` checks the agent store routines against an
OpenClaw checkout and a disposable database.

## Changing core

Build and commit `dist/` with the source change. CI rebuilds it, and
`scripts/ops/verify-committed-dist.mjs` fails when the committed output
differs. Consumer locks remain byte-stable for a `dist/`-only change.
`scripts/ops/sync-local-file-deps.mjs`, which every consumer runs before it
builds or tests, refreshes a stale installed copy from this directory without
modifying the consumer's lock.

Modules with runtime dependencies declare them in `package.json`.
Dependencies whose consumers pin different majors use an OR range so npm can
dedupe to each consumer's existing major.

## Layout

- `src/<module>.ts`: one file per public package subpath.
- `src/<module>.spec.ts`: Vitest specs against source.
- `dist/`: the committed, deterministic `.js` and `.d.ts` interface.
