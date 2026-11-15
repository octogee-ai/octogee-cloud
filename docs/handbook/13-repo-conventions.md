---
title: Repo Conventions
slug: 13-repo-conventions
order: 13
part: Dev Workflow
audience: [agent]
description: Standalone package builds, internal package links, lint, dependencies, and repository settings.
updated: 2026-11-13
---

# Repo Conventions

## No npm workspaces — per-package builds

Each package has its own `node_modules` and builds standalone via
`npm run --prefix <pkg>`. The root `package.json` only holds lint. Every
Dockerfile and CI job relies on the per-package `cd X && npm ci` pattern; moving
to workspaces would mean a single root install and workspace copies in every
Dockerfile.

Consequences to keep in mind:
- **Cross-package spec imports break per-package `tsc`** — keep specs in the
  owning package's `__tests__/` (see [11 — Testing](11-testing.md)).
- **A shared type leaf imported cross-package must stay dependency-free.**
  A lean-install package's isolated `tsc --noEmit` only has its own
  `node_modules` — adding one `import type` of a heavier third-party type
  (e.g. `@mattermost/client`'s `Client4`) to a file that `tests/` (or another
  cross-package consumer) imports breaks that package's typecheck in CI even
  though it passes locally (your worktree's sibling `node_modules` masks it).
  Fix pattern: split the dep-bearing type into its own file that the
  cross-package consumer never imports, keep the shared leaf at zero imports.
- **A fresh `git worktree` doesn't materialize `node_modules`** (gitignored),
  and a per-package `tsc --noEmit` can transitively pull in ANOTHER package's
  *source* via a real relative import (e.g. a `tests/` spec importing
  `../../scripts/lib/...`) — so typechecking the package
  you touched needs `npm ci` in whatever it transitively imports too, not just
  itself. Tell-tale: every `TS2307 Cannot find module` lands in
  `../scripts/...`/`../shared/...`, none in your own package's `src/` — that's
  a missing-install artifact, not a real type error. `npm ci` the imported
  packages (they have their own lockfiles) before trusting the failure.

Every package is named `@octogee/<name>` (one consistent scope).

## Internal package directory dependencies

`core/` and `shared/` commit deterministic `dist/` interfaces.
Consumers declare them as `file:../<package>` dependencies and own an
`install-links=true` `.npmrc`. npm then packs the directory into a real installed
package on `npm ci`; it does not create a source symlink or build on install.

Source-package CI rebuilds and verifies committed `dist/`. A source plus `dist/`
change leaves consumer locks byte-stable. Each consumer's `pretest` and
`pretypecheck` run `scripts/ops/sync-local-file-deps.mjs`, which refreshes only a
stale installed package and must not change a lock. Dockerfiles copy each required
internal package's `package.json` and `dist/`, plus the consumer `.npmrc`, before
installing dependencies.

## Dependencies

Use a current stable version when adding or intentionally upgrading a
dependency. Apply security updates promptly and batch routine currency work;
do not create a standing ceremony or bump unrelated packages on touch.
Stateful-service upgrades deserve a focused rollback check because their data
may not roll back with the image.

## Lint

Lint runs once at the root: `npm ci && npm run lint` (ESLint with
`--max-warnings=0`). Fix new warnings in the code;
do not weaken a rule or raise a threshold merely to make the count pass. A
targeted suppression is acceptable for a real false positive with a short
reason.

## Platform settings via the GitHub UI

For repo-level settings (GHAS code scanning, Code Quality, branch-protection
required checks, Actions permissions), present a short list of UI toggles
(Settings path + what to look for) — the operator flips them. Don't chase
half-documented repo-settings API workarounds. Code-owned config (workflow YAMLs,
`dependabot.yml`) is fair game to edit directly.

Related: [10 — Engineering Principles](10-engineering-principles.md), [11 — Testing](11-testing.md), [12 — PR & Effort Workflow](12-pr-and-effort-workflow.md).

## Platform boundary

Code built on top of this repository reaches it only through its entrypoints
and options, never the other way round. `scripts/lib/platform-boundary.json`
names the entrypoints, the modules outside them, and a ratchet of outside
modules still reached. `scripts/__tests__/platform-boundary.spec.ts` walks the
import graph from every entrypoint: a new outside import fails, and a ratchet
entry that is no longer reached must be removed. That spec needs the embedding
checkout, so it is skipped in this repository alone. Routes added by an
embedding app enter through `createPlatformApp(opts)` in
`platform-api/src/app.ts` and the `productRoutes` option of
`mountClusterRoutes` in `platform-api/src/routes/mount-cluster-routes.ts`; `platform-api/src/main.ts` serves the platform API with no
additions. `npm run gate` in `scripts/` keeps the embedding app's names out.
