---
title: Testing
slug: 11-testing
order: 11
part: Dev Workflow
audience: [ops, agent]
description: Where tests live and how to choose the smallest signal that catches the changed behavior.
updated: 2026-11-13
---

# Testing

Use the smallest suite that exercises the behavior you changed. Tests use
Vitest. Ordinary contributions need no cloud credentials or provider keys.

## Quick start without cloud credentials

Use Node 24, the version CI uses, and npm. There are no npm workspaces: install
each package on its own. `core` and `shared` commit their built `dist/`, so
other packages install them as `file:` dependencies without a registry.

From the repository root:

```bash
npm ci --prefix shared
npm test --prefix shared
npm run typecheck --prefix shared
```

The root `package.json` only lints:

```bash
npm ci
npm run lint
```

Do not copy another contributor's `node_modules` into your checkout.

## Run a focused package test

Use the owning package's test script so its setup and exclusions apply:

```bash
npm ci --prefix fleet-controller
npm test --prefix fleet-controller -- src/__tests__/converge-gateway.spec.ts
npm run typecheck --prefix fleet-controller
```

Not every package has the same scripts; read its `package.json`. The scripts
package typechecks with `cd scripts && npx tsc --noEmit`, and `npm run gate`
there scans for private identifiers.

A package that depends on a sibling by `file:` needs that sibling installed
too. The `installs` list for each job in
[`.github/workflows/checks.yml`](../../.github/workflows/checks.yml) names the
directories to install, in order.

## What CI runs

The **Checks** workflow runs on every pull request and push to `main`:

- **lint** reviews dependency changes, then runs `npm audit` and
  `npm run lint` at the root.
- **packages** runs one job per group:
  - `scripts`: `npm audit`, `npx tsc --noEmit`, `npm test`, `npm run gate`.
  - `core`: typecheck, build, the committed `dist/` check, `npm test`, then
    `node ../scripts/ci/core-postgres.mjs` against a throwaway PostgreSQL 16
    server with pgvector.
  - `gateway-edge`, `platform-api` and `tests`: typecheck and `npm test`.
  - `libraries`: `shared` (typecheck, build, the committed `dist/` check,
    test), `fleet-controller` (typecheck and test), and the plugins under
    `gateway/extensions/platform/`.
- **checks** passes only when both of the above pass.

Branch protection on `main` requires `checks`, `dco` (every commit signed off)
and `CodeQL`.

PR jobs have read-only repository access and no cloud credentials.

## Emulator suites

The platform packages have no emulator suites of their own. A product overlay
that adds `*.emulator.spec.ts` files to a package also supplies that package's
`test-emulator.mjs`; run it with `node test-emulator.mjs` from the package's
`.overlay/` directory. Those suites need Java 21 and start the Firebase
emulators themselves; never point them at real credentials. Plain `npm test`
excludes them, and Checks does not run them.

## Troubleshooting local runs

| Symptom | Check |
| --- | --- |
| Missing module or executable | Install the owning package with `npm ci --prefix <package>`; the root install only covers lint. |
| Type errors resolving a sibling package | Install the siblings the package's CI job lists; see [package conventions](13-repo-conventions.md#internal-package-directory-dependencies). |
| `core` integration suite fails to start | `scripts/ci/core-postgres.mjs` needs PostgreSQL 16 and pgvector on the host. |
| GNU tool or `/proc` failures on macOS | Some scripts specs exercise real Linux tools; CI's Linux runner is the reference. |
| Out-of-memory or worker exhaustion | Run a focused suite or pass `-- --maxWorkers=2` to its test script. |

Never solve a local failure by adding production credentials or deleting an
integration assertion. Report the exact command, Node version, operating system,
and redacted error when asking for help.

## Where tests live

| Package | Covers | Location |
|---|---|---|
| `core/` | platform state, secret store, chat and git hosts | `core/src/**/*.spec.ts` |
| `fleet-controller/` | placement, migration, gateway rollout, Admin API | `fleet-controller/src/**/*.spec.ts` |
| `gateway-edge/` | Express routes, middleware, chat and git integration | `gateway-edge/src/__tests__/*.spec.ts` (Vitest + supertest) |
| `platform-api/` | platform API, npm cache proxy | `platform-api/src/__tests__/*.spec.ts` |
| `llm-broker/` | LLM broker | `llm-broker/src/__tests__/*.spec.ts` |
| `gateway-supervisor/` | gateway pod boot steps, provisioner, VM agent | `gateway-supervisor/__tests__/*.spec.ts` |
| `scripts/` | operator tools, CI | `scripts/__tests__/*.spec.ts` |
| `tests/` | cross-package specs, such as the Helm chart specs | `tests/specs/**/*.spec.ts` |
| plugins | each plugin's tools | `gateway/extensions/platform/<plugin>/` |

**Specs live with the module they test.** A spec under `tests/` that imports from
a sibling package's `lib/` passes Vitest locally but breaks that package's `tsc`
in CI (separate `node_modules`). Put it in the owning package's `__tests__/`.
`tests/` is for cross-package specs only. See
[13 — Repo Conventions](13-repo-conventions.md).

## Choose tests by behavior and risk

Start with a failing test for bugs, new logic, state transitions, authorization,
parsers, handlers, and user interactions. One behavioral test may cover several
files. Skip new tests for prose, pure deletion, formatting, mechanical renames,
generated output, and declarative changes already checked by their owning
parser or linter.

Assert the behavior a dependency or image stage provides, not its current
version string or digest. Exact-literal tests that must be updated beside an
automated dependency bump duplicate the package manager or Docker parser and
turn routine currency into a false gate.

## Deciding what to test next — use the tool, never a filename glob

A `*.spec.ts` glob misses `*.test.ts` files, alias imports, and integration
suites. Run the import-graph audit instead:

```bash
npm run --prefix scripts audit-coverage                 # whole repo, 120d churn
npm run --prefix scripts audit-coverage -- --since=90d --top=30 fleet-controller
```

It ranks modules by churn × size and flags only those with **no test importing
them**. Route integration suites cover handlers transitively, so confirm the
top candidate has no transitive net before investing.

## Integration specs use the real backend, never a stub db

A test that claims integration fidelity for a database-backed path must run
against the real backend: PostgreSQL through `scripts/ci/core-postgres.mjs`, or
the Firestore and Auth emulators for an emulator suite. Never use an inline
`{ collection, doc, where, get }` stub. A stub encodes your *assumption* of the
query's behavior and stays green while the real store diverges. Pure-logic unit
tests that spy on a non-db collaborator are unaffected.

For a product's emulator suites, its `@octogee/test-helpers/firestore-emulator`
provides `getAdminDb()` to seed, `setupEmulatorTest()` (fails loudly without the
emulator and resets per test), and `useAuthToken(uid)` /
`getIdTokenForUid(uid)`, which mint a real emulator ID token for Auth-gated
routes.

## Tests that shell out to real git break on CI two ways local git config masks

A test that inits a temp repo and drives real `git` (init/commit/rebase/merge)
passes locally and breaks on the CI runner:

- **Default branch.** CI `git init` creates `master` (no `init.defaultBranch`
  set) — a fixture that later checks out `main` fails. Fix: `git init -b main`.
- **No committer identity.** CI runners have no global `user.name`/`user.email`.
  Passing `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env to your own setup commits isn't
  enough if the **code under test** runs its own `git commit`/`rebase
  --continue` against *ambient* config — it fails silently ("Committer
  identity unknown") and the operation just doesn't advance. Fix: `git config
  user.email`/`user.name` **repo-locally** in the fixture.

Verify locally the CI way before trusting green: `GIT_CONFIG_GLOBAL=/dev/null
GIT_CONFIG_SYSTEM=/dev/null npx vitest run <file>` strips your global identity
and `init.defaultBranch`, reproducing the bare runner. A bare `"git"`/`"npm"`
command name in `execFileSync` also trips `sonarjs/no-os-command-from-path`
under `--max-warnings=0` — use an absolute path or
`process.execPath`/`process.env.npm_execpath`, never a `$PATH`-resolved name.

## Verification discipline

Use the real command's exit status; a pipe can hide a failing suite. When a
shared default or shape changes, search for callers and assertions that encode
the old contract. Run the focused suite and affected package typecheck; let CI
cover the affected matrix once.

## The scripts/ test-gate carve-out is narrow

Judge by **blast radius, never the directory**:

- **No test gate** — genuinely throwaway one-off operator tooling: hand-run
  diagnostics, one-shot migrations, `audit-coverage`. The operator owns that
  risk.
- **Behavioral coverage required** — runtime code that merely *lives* under
  `scripts/lib/` and is imported by services or shared across packages
  (`admin-fleet-router.ts`, `config.ts`, `git.ts`, `user-lifecycle.ts`, …).
  The path grants zero exemption.

Before invoking the carve-out, ask: "is this imported by a running service /
shared across packages / does it mutate prod state?" If yes, cover the changed behavior.
