# Octogee Cloud

[![Checks](https://github.com/octogee-ai/octogee-cloud/actions/workflows/checks.yml/badge.svg?branch=main&event=push)](https://github.com/octogee-ai/octogee-cloud/actions/workflows/checks.yml)
[![Build main](https://github.com/octogee-ai/octogee-cloud/actions/workflows/build-main.yml/badge.svg?branch=main&event=push)](https://github.com/octogee-ai/octogee-cloud/actions/workflows/build-main.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Octogee Cloud is the open platform under Octogee, the personal AI partner. It
is the software factory that builds Octogee: the files my agents load at the
start of every session, the checks they run before a change reaches `main`,
and the commands that ship a build. You can read the factory yourself instead
of taking my word for it.

[How this differs from OpenClaw Enterprise](docs/why-octogee-cloud.md).

## Run it

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/octogee-ai/octogee-cloud/main/install.sh
# Review install.sh before running it.
bash install.sh
```

`install.sh` sets up the foundation: Gitea, Mattermost and one stock OpenClaw
gateway, [on your machine](docs/getting-started.md) or [on GKE or EKS](docs/running-in-the-cloud.md).
It does not install the fleet controller, the platform API or the LLM broker.

The full platform, with the fleet controller, users and shared gateways, runs
on a local kind cluster from the images this repository publishes. See
[The full platform on kind](docs/kind.md). It has not yet run on a cloud
account, so there is no production install of it yet. Users on a shared
gateway work through Mattermost and Gitea; the OpenClaw Control UI is for
isolated gateways only. The platform API knows a user by their Mattermost
session or personal access token; see
[Call the platform API as a user](docs/kind.md#call-the-platform-api-as-a-user).

Some features start switched off, among them agent import and export, the
OpenClaw dashboard, project repository sources and voice. List the ones you
want in the chart value `octogee-api.featureFlags.enabled`, using the keys in
[`shared/types/feature-flags.ts`](shared/types/feature-flags.ts). An unknown
key stops the platform API at startup.

## What you need to sign up for

For `install.sh` on your own machine, one model key; Gemini's free tier works
there, but not on the full platform. On Google Cloud, also a billing account
and a domain. [See every account and tier](docs/getting-started.md#what-you-need-to-sign-up-for).

## What is here

- `AGENTS.md` is the contract every agent loads.
- `docs/handbook/` holds the Dev Workflow chapters of the handbook.
- The platform packages: `core`, `shared`, the fleet controller
  in `glm-controller`, `gateway-edge`, and `octogee-api`, with `infra`, `helm`,
  `terraform`, `templates` and `scripts` beside them. `tests/` holds the
  cross-package platform specs.
- [Legacy names](docs/legacy-names.md) lists the stored names that keep
  their spelling from before the platform was published.
- `SHIP.md` shows the shape of the four commands that move a build to TEST, to
  PROD, and to a single isolated gateway. Identities are placeholders.

The Octogee product keeps its own private repository and builds on top of this
one.

## Contributing and security

[Contributing](CONTRIBUTING.md) explains how to run checks and sign off commits.
Pull requests run dependency review, lint, typechecks, and package tests.
Use the [security policy](SECURITY.md) to report vulnerabilities privately.

Open [Build main](https://github.com/octogee-ai/octogee-cloud/actions/workflows/build-main.yml)
for the image manifest, Trivy reports, and CycloneDX SBOMs for both Linux
architectures. The [Image security workflow](https://github.com/octogee-ai/octogee-cloud/actions/workflows/image-security.yml)
rescans the latest published main build weekly. See [Verify published images](docs/kind.md#verify-published-images)
for provenance and [Source security](https://github.com/octogee-ai/octogee-cloud/actions/workflows/source-security.yml)
for lockfile, infrastructure, and workflow scans.

## License

MIT, the same license as the monorepo. See `LICENSE`.
