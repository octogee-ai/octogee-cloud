# @octogee/shared

```bash
npm install @octogee/shared@X.Y.Z
```

Each octogee-cloud release `vX.Y.Z` publishes this package at `X.Y.Z`.

The types, constants and small helpers the platform's packages share: the
shapes of platform records (users, gateways, releases, sizing, placement),
the wire shapes between the fleet controller, the gateways and the platform
API, the model catalog, feature flag keys, and validators for them. The fleet
controller, the platform API, the edge and `scripts/` install it, and
`@octogee/core` takes it as a peer.

It runs no process and keeps no state. Code that talks to a database, a host
or a cloud API belongs in `@octogee/core`.

| Directory | What it holds |
| --- | --- |
| `types/` | One module per subject, for example `types/fleet-controller.ts`, `types/gateway-releases.ts`, `types/sizing.ts`, `types/model-catalog.ts` and `types/feature-flags.ts`. `types/index.ts` is the package root. |
| `server/` | Three helpers for services: `service-logger` (structured logs with `pino`), `repeat-squelch` and `user-claim` |

The `exports` map in `package.json` lists every public module, imported as
`@octogee/shared/types/<module>` or `@octogee/shared/server/<module>`.

`types/feature-flags.ts` holds the keys an install can list in the chart value
`octogee-api.featureFlags.enabled`. `refresh-model-catalog.mjs` regenerates
`types/openrouter-model-catalog.generated.ts` from OpenRouter's public model
list.

## Consumer contract

```jsonc
// core/package.json
"peerDependencies": { "@octogee/shared": "^1.0.0" }

// <consumer>/package.json
"dependencies": { "@octogee/shared": "file:../shared" }
```

Every consumer of the directory dependency has `install-links=true` in its local
`.npmrc`. npm packs committed `dist/` into a real installed package, so consumers
remain standalone without source links or install-time builds.

Code imports it by package name. The `scripts/` and `tests/` packages also map
an `@shared/*` alias to this directory's source in their TypeScript and Vitest
configuration.

## Build and test

```bash
cd shared
npm ci
npm run typecheck
npm test
npm run build
```

`build` compiles `types/` and `server/` into `dist/`. Specs sit beside their
modules as `*.spec.ts`.

## Changing shared

Build and commit `dist/` with the source change. CI rebuilds it, and
`scripts/ops/verify-committed-dist.mjs` fails when the committed output
differs.

## Layout

- `types/<module>.ts`, `server/<module>.ts`: the source of each package subpath.
- `dist/`: the committed, deterministic package interface.
- `tsconfig.json`: builds the exported interface.
