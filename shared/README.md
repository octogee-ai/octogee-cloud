# @octogee/shared

```bash
npm install @octogee/shared@X.Y.Z
```

Each octogee-cloud release `vX.Y.Z` publishes this package at `X.Y.Z`.

Octogee's shared type and runtime substrate (`types/` constants, tier and
throttle helpers, wire protocol, and related values). It has two intentional
consumption modes:

- `@shared/*` is the tsconfig source alias used by app, site, functions, and
  backend source.
- `@octogee/shared` is the packed directory package consumed by core and the
  platform packages that provide core's peer.

```jsonc
// core/package.json
"peerDependencies": { "@octogee/shared": "^1.0.0" }

// <consumer>/package.json
"dependencies": { "@octogee/shared": "file:../shared" }
```

Every consumer of the directory dependency has `install-links=true` in its local
`.npmrc`. npm packs committed `dist/` into a real installed package, so consumers
remain standalone without source links or install-time builds.

## Dual consumption

A package can use shared code through core and through its own `@shared/*` alias.
The built and source interfaces remain structurally identical; the committed-dist
CI gate keeps the package boundary honest.

## Layout

- `types/<module>.ts` — source alias target and package subpath source.
- `dist/` — committed deterministic package interface.
- `tsconfig.json` — builds the exported interface.
