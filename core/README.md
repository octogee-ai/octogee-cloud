# @octogee/core

Octogee's shared runtime library. Platform packages (`gateway-edge`,
`platform-api`, `fleet-controller`, `scripts`) consume its built interface through
`@octogee/core/<module>`, never its source. That boundary keeps each package's
install, typecheck, and test standalone.

`shared/` remains the type substrate; `core/` holds shared runtime code. Modules
with runtime dependencies declare them in `core/package.json`. Dependencies whose
consumers pin different majors use an OR range so npm can dedupe to each
consumer's existing major.

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
node10 consumers.

## Changing core

Build and commit `dist/` with the source change. The source-package CI job rebuilds
and verifies that committed output exactly matches; it fails with drifting paths.
Consumer locks remain byte-stable for a `dist/`-only change. The local directory
dependency synchronizer refreshes a stale installed package from its source
directory without modifying the lock.

## Layout

- `src/<module>.ts` — one file per public package subpath.
- `dist/` — committed deterministic `.js` and `.d.ts` interface.
- `src/<module>.spec.ts` — Vitest tests against source.
