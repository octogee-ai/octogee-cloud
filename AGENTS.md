# Agents: octogee-cloud

Every agent working here loads this file at the start of a session, whether it
is Claude, Codex or another. It gives just enough orientation; the docs and
handbook chapters it links to hold the depth.

## What this repository is

octogee-cloud runs OpenClaw agents for many users. The fleet controller places
each user on a shared gateway, where many users share one OpenClaw gateway and
host code is denied, or on an isolated gateway of their own, and moves users
between the two. Each user gets a Mattermost account and team for chat and a
Gitea organization for git. Users on a shared gateway reach their agent through
those two; the OpenClaw Control UI is for users on an isolated gateway only.
Operators drive the fleet with the
[`octogee-fleet`](https://github.com/octogee-ai/octogee-fleet) command line,
which talks to the fleet controller's Admin API.
[Why octogee-cloud](docs/why-octogee-cloud.md) explains the trust model.

The Octogee product pins a commit of this repository and builds on top of it.
Its features and names stay out of here, and `npm run gate` in `scripts/`
refuses private identifiers and commercial terms.

## Layout

There are no npm workspaces. Each package has its own `package.json` and
lockfile, and installs, typechecks and tests on its own.

```
core/            @octogee/core: shared runtime (platform state, secret store, chat and git hosts)
shared/          @octogee/shared: types and small server helpers
glm-controller/  the fleet controller and its Admin API: placement, migration, gateway rollout
octogee-api/     the platform API, plus the LLM broker and npm cache proxy apps
gateway-edge/    sidecar in each gateway pod; also runs as the gateway router and the Mattermost callback router
scripts/         gateway pod boot steps and provisioner (entrypoints/), operator tools (ops/), CI (ci/), specs (__tests__/)
infra/           the gateway image (infra/gateway/), the isolated gateway VM image (infra/desktop/), vm-bridge
helm/            octogee (the platform), octogee-gateway (one gateway), monitoring
terraform/       Google Cloud modules
templates/       starter files for new agents and their workspaces
tests/           cross-package specs, such as the Helm chart specs
install.sh, deploy/  the foundation installer: one stock OpenClaw gateway with chat and git
docs/            start at docs/getting-started.md
```

`core` and `shared` commit their built `dist/`. Other packages
install them as `file:` dependencies, so build and commit `dist/` with any
change to their source. The OpenClaw build the gateway image uses is pinned in
`infra/gateway/openclaw-tarball/current.json`.

## Build and test

Use Node.js 24, the version CI uses. Install the package you work on and run
its checks. For `scripts`:

```bash
npm ci --prefix scripts
cd scripts && npx tsc --noEmit && npm run gate
```

`.github/workflows/checks.yml` has the typecheck and test commands each pull
request runs. [The full platform on kind](docs/kind.md) installs everything on
a local cluster; `scripts/ops/kind-install.sh` builds the images from your
checkout or copies the published ones.

## Engineering principles

- **Test changed behavior, not files.** Start red for bugs, logic branches,
  state transitions, auth boundaries, handlers, and user interactions. Do not
  invent tests for prose, pure deletion, formatting, mechanical renames,
  generated output, or declarative files already checked by their parser.
- **No silent failures.** Every error path logs, returns a code, or throws.
- **Do not mask upstream bugs.** Validate trust boundaries; inside owned code,
  fix malformed state or duplicate work at its source instead of adding fallbacks.
- **Greenfield.** Breaking changes are fine: no migrations, compat shims, or `_var` renames.
- **No narrative comments on main.** Names express intent, test names pin behavior,
  and the pull request records *why*. Comment freely while you work with the
  operator, then strip the comments before the pull request. The code speaks the
  truth; we don't commit the narrative.

## Testing

- **Vitest only.** Specs sit beside their module or in the package's `__tests__/`.
  Specs for `scripts/` live under `scripts/__tests__/`. Shell scripts are tested
  against stubbed commands; see `scripts/__tests__/deploy/stub-host.ts`.
- **PostgreSQL.** `node scripts/ci/core-postgres.mjs` starts a throwaway
  PostgreSQL 16 server and runs core's integration suite against it. It expects
  PostgreSQL 16 and pgvector under `/usr/lib/postgresql/16`, as on the CI runner.
- **Emulator specs.** The platform has none. `npm test` excludes
  `*.emulator.spec.ts`, so a product that overlays a package can add its own.
  CI runs them only for an overlay that supplies a `test-emulator.mjs`.
- **Coverage gaps.** `npm run --prefix scripts audit-coverage` follows the
  import graph, counting `.spec.ts` and `.test.ts` files and resolving the `@/`
  and `@shared` aliases. Never use a `*.spec.ts` glob, which flags false gaps.
- **`scripts/` test gate.** Throwaway operator tooling is exempt, but shared
  runtime code under `scripts/lib/` (for example `user-lifecycle`,
  `provision-reconcile`, `git`, `config`) needs behavioral coverage. Blast radius
  decides, not the directory.

## Workflow: keep it small

Open one small pull request with one purpose and the narrowest relevant test
and typecheck. Write a spec only when the operator has to choose among
materially different designs across subsystems. Do not add review agents,
receipts, baselines, rehearsals, approval layers, or multi-PR sequencing unless
the operator asks for them or a current risk to users requires them.

- Sign off every commit with `git commit -s`. The `dco` check fails a pull
  request with an unsigned commit.
- `checks`, `dco` and `CodeQL` are the required checks on `main`. Pull
  requests merge with a merge commit.
- **Specs are disposable.** Delete a spec when its work lands; code and tests
  are the record. See [Handbook 14](docs/handbook/14-docs-and-curation.md).

## CI and images

- **Checks** (`.github/workflows/checks.yml`) runs on every pull request and on
  pushes to `main`. Pull request jobs have read-only repository access and no
  cloud credentials.
- **Build main** (`.github/workflows/build-main.yml`) builds the platform images
  for `linux/amd64` and `linux/arm64` on every push to `main`. The isolated
  gateway image (`octogee-gateway-builder`) is `linux/amd64` only; arm64
  clusters schedule it on amd64 nodes. It pushes them
  to `ghcr.io/octogee-ai/octogee-cloud/<image>`, tagged with the full and short
  commit SHA, and keeps a manifest of every digest as a workflow artifact.
  Building never deploys.
- Deploying a build is an operator step. [docs/running-in-the-cloud.md](docs/running-in-the-cloud.md)
  installs the charts, `octogee-fleet gateway deploy` moves one isolated gateway
  to a build, and every fleet change the controller makes writes an
  operations-journal entry.

## Architecture

- **HTTP.** The platform API (`octogee-api`) serves most routes. The gateway
  router, `gateway-edge` in router mode, sends `/g/<gatewayId>/*` to that
  gateway's edge sidecar, which serves the user's workspace files and proxies
  the Mattermost WebSocket.
- **Auth.** The Admin API accepts a Google sign-in or a token signed
  with the operator key; kind uses the key (`scripts/ops/operator-token.mjs`).
  Services authenticate to each other with Kubernetes service account tokens
  bound to the calling gateway, plus dedicated bearers and HMAC signatures.
- **State.** Platform state lives in PostgreSQL (`core/src/platform-state/`).
  Secrets the platform creates are encrypted rows there under the root key, or
  Google Secret Manager. Each agent has its own PostgreSQL store.
- **Users.** `octogee-fleet user add` records a user and `user assign` places
  them on a gateway. The provisioner in the gateway pod,
  `scripts/entrypoints/fleet-controller.ts` despite its name, then sets the user
  up through the platform API's fleet broker, which holds the admin credentials:
  their Mattermost account, team, channels and agent bot, and their Gitea
  organization with a `workspace` repository.
- **Gateways.** Shared gateways are Kubernetes pods from `helm/octogee-gateway`,
  under gVisor on a cloud cluster. Isolated gateways run only as Google Cloud
  virtual machines today. The controller adds no gateway and moves no user on
  its own; automation such as autoscaling or returning idle users belongs to a
  product built on top.
- **Firebase and Firestore** remain in a few paths that have not moved behind a
  platform port yet: `gateway-edge/src/lib/db.ts` and its auth middleware. The
  controller moves, suspends and erases users from platform state alone; a
  product adds its own steps through `ProductUserLifecycle`. Do not add new ones.

## Where to look

- [Getting started](docs/getting-started.md), [the full platform on kind](docs/kind.md),
  [running in the cloud](docs/running-in-the-cloud.md) and
  [requirements](docs/requirements.md).
- [Why octogee-cloud](docs/why-octogee-cloud.md) and
  [OpenClaw compatibility](docs/openclaw-compatibility.md).
- The [handbook](docs/handbook/00-index.md) chapters on principles, testing,
  pull requests, repository conventions and docs.
- Code anchors: `octogee-api/src/app.ts`, `gateway-edge/src/index.ts`,
  `glm-controller/src/index.ts`, `glm-controller/src/http-server.ts` (the Admin
  API), `scripts/entrypoints/fleet-controller.ts` (the provisioner).
