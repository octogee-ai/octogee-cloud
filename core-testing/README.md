# @octogee/core-testing

```bash
npm install --save-dev @octogee/core-testing@X.Y.Z
```

Each octogee-cloud release `vX.Y.Z` publishes this package at `X.Y.Z`. It
takes `@octogee/core` and `@octogee/shared` at the same version as peers.

Test helpers for code built on `@octogee/core`. Platform packages
(`gateway-edge`, `platform-api`, `fleet-controller`, `scripts`) and core's own
specs import them as `@octogee/core-testing/<module>`. None of it is runtime
code: it is a development dependency only, no image copies it, and
`@octogee/core` declares no test framework because of it.

| Module | What it gives a spec | Optional peers it needs |
| --- | --- | --- |
| `journal-store` | an in-memory `PlatformStateStore` with journaled rows | none |
| `cron-custody` | gateways that hold and transfer scheduled jobs | none |
| `admin-dry-run-app` | an Admin API app for dry-run requests | `supertest`, `vitest`, `firebase-admin` (types) |
| `admin-fleet-route-app` | an Admin API app over in-memory fleet documents | `vitest`, `firebase-admin` (types) |
| `admin-fleet-releases-app` | an Admin API app for gateway release routes | `vitest`, `firebase-admin` |
| `firestore-user-accounts` | a `UserAccountReader` over a Firestore-shaped client | `firebase-admin` (types) |

## Consumer contract

Platform packages install it beside `@octogee/core`, the same way:

```jsonc
// <consumer>/package.json
"dependencies": { "@octogee/core": "file:../core" },
"devDependencies": { "@octogee/core-testing": "file:../core-testing" }
```

`@octogee/core` is an optional peer only because core's own specs install
this package, and npm cannot satisfy a peer with the project being installed.
Every other consumer installs `@octogee/core` itself.

Core's specs run against core's source: `core/vitest.config.ts` and
`core/tsconfig.spec.json` resolve `@octogee/core/<module>` inside this
package to `core/src`, so the helpers and the specs share one copy of core.

## Build and test

```bash
cd core-testing
npm ci
npm run typecheck
npm test
npm run build
```

The modules are in `src/`, one per `exports` entry in `package.json`.

## Changing it

Build and commit `dist/` with the source change, as for `core`. A change to a
core module the helpers import needs core's `dist/` rebuilt first. CI rebuilds
`dist/`, and `scripts/ops/verify-committed-dist.mjs` fails when the committed
output differs.
