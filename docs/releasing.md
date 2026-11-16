# Releasing

A release is an annotated `vX.Y.Z` tag on a `main` commit whose Build main run
and Kind smoke run succeeded, and on which the [GKE install guide](gke.md) was followed end to end.
The [Release workflow](../.github/workflows/release.yml) turns the tag into a
GitHub Release, tags the images with the release version, and publishes the
npm packages and Helm charts at that version. Only a maintainer pushes release
tags.

## What a release publishes

A release `vX.Y.Z` publishes everything at one version:

| What | Where | Version |
| --- | --- | --- |
| Images | `ghcr.io/octogee-ai/octogee-cloud/<image>` | tag `vX.Y.Z`, beside the commit SHA tags |
| Charts | `oci://ghcr.io/octogee-ai/octogee-cloud/charts/<chart>` | chart version `X.Y.Z`, app version `vX.Y.Z` |
| npm packages | `@octogee/<package>` on npmjs.com, with provenance | `X.Y.Z` |

The charts are `octogee` (the platform), `octogee-gateway` (one gateway, which
the fleet controller installs) and `octogee-monitoring`. The packages are
`@octogee/shared`, `@octogee/core` and `@octogee/core-testing`.

The version comes from the tag when the workflow runs; nothing in the
repository records it. The workflow builds each package's `dist/` fresh from
source, ignoring the committed copy, and rewrites its `package.json` for npm:
the release version, every `@octogee/*` dependency pinned to that same
version, and no `private`, scripts, development dependencies or `file:`
dependencies. The `octogee` chart is stamped with the release's images: each
platform service at `vX.Y.Z` and its index digest from Build main's image
manifest, and the gateway images the fleet controller rolls out at the
commit's short SHA and digest, the tag form gateway images take. The
`octogee-gateway` chart defaults to the same gateway and gateway edge images.

`scripts/ci/release-packages.mjs` and `scripts/ci/release-charts.mjs` do this,
and each holds its published set as one list, `PUBLISHED_PACKAGES` and
`PUBLISHED_CHARTS`. To publish another package, give it an `exports` map in
which every entry names `types` and `default` under `./dist/`, `"files":
["dist"]` and a license, and add its directory to `PUBLISHED_PACKAGES`. The
`release-artifacts` check on every pull request packs each package as a
release would, installs the tarballs into a scratch project outside the
repository, imports every export and type-checks against them, runs `npm
publish --dry-run`, then packages each chart and lints and renders it from the
packaged archive.

## Install a release by version

```bash
helm upgrade --install octogee oci://ghcr.io/octogee-ai/octogee-cloud/charts/octogee \
  --version X.Y.Z -f your-values.yaml
npm install @octogee/core@X.Y.Z @octogee/shared@X.Y.Z
npm install --save-dev @octogee/core-testing@X.Y.Z
```

The chart needs no image values: it runs the release's images by digest. The
[GKE](gke.md) and [kind](kind.md) installers still run from a checkout, so for
them check out the tag. `@octogee/core` takes `@octogee/shared` as a peer at
the same version. `@octogee/core-testing` holds the test helpers and takes
`@octogee/core` and `@octogee/shared` at the same version; its route
harnesses also need its optional peers `supertest`, `vitest` and
`firebase-admin`.

## One-time setup

The packages publish from the `octogee` npm user account, which owns the
`@octogee` scope. A user scope has one owner: other maintainers are added to
each package one at a time, not to the scope.

1. Signed in as `octogee` on npmjs.com, create a granular access token with
   read and write access to the `@octogee` scope (packages and scopes, all
   packages in the scope), with "bypass two-factor authentication" on.
2. Store it as the `NPM_TOKEN` Actions secret of `octogee-ai/octogee-cloud`.
3. After the first release has published each package, open each package's
   settings on npmjs.com and add a trusted publisher: GitHub Actions,
   organization `octogee-ai`, repository `octogee-cloud`, workflow
   `release.yml`. Trusted publishing is set per package and only once the
   package exists, so the first publish needs the token. Once every package
   has a trusted publisher, delete the `NPM_TOKEN` secret and revoke the
   token; the workflow publishes through trusted publishing when the secret is
   absent. Packages carry provenance either way.
4. After the first release has pushed the charts, open each chart package
   under the organization's packages on GitHub (`octogee-cloud/charts/octogee`,
   `octogee-cloud/charts/octogee-gateway`, `octogee-cloud/charts/octogee-monitoring`)
   and change its visibility to public. GitHub creates a new container package
   private. Do the same for any image package that is not public yet.

## Versions

octogee-cloud is pre-1.0. The platform's PostgreSQL schema migrations run
forward automatically when it is installed or upgraded, and some of them change
or drop stored data. A minor release (`v0.2.0`) makes no promise that stored
data survives: it can change Helm values and the Admin API, drop stored data,
or need `down` and a fresh `up`. A patch release (`v0.1.1`) only fixes.

Every release names the [octogee-fleet](https://github.com/octogee-ai/octogee-fleet)
release that the kind smokes tested it with, `OCTOGEE_FLEET_VERSION` in
[kind-smoke.yml](../.github/workflows/kind-smoke.yml). To move to a newer
octogee-fleet, set both `OCTOGEE_FLEET_VERSION` and `OCTOGEE_FLEET_COMMIT`
there, merge, and release a commit whose kind smokes ran with it.

## Cut a release

1. Pick the commit. It must be on `main`, its Build main run must have
   succeeded, which means its images are published and scanned, and its Kind
   smoke run must have succeeded, which means both kind smokes passed on those
   images with the pinned octogee-fleet. This prints the newest one:

   ```bash
   gh run list -R octogee-ai/octogee-cloud --workflow=kind-smoke.yml --event=workflow_run \
     --status=success --limit=1 --json displayTitle --jq '.[0].displayTitle | ltrimstr("Kind smoke at ")'
   ```

2. Create and push an annotated tag at that commit:

   ```bash
   git tag -a v0.2.0 <commit> -m v0.2.0
   git push origin v0.2.0
   ```

   When [the GKE install guide](gke.md) has also run end to end at the tagged
   commit, include `GKE install guide: YYYY-MM-DD <full-commit>` on a
   separate line in the tag message. The release notes include that result
   when recorded.

3. The Release workflow then:
   - stops unless the commit is on `main` and has a successful Build main run;
   - stops unless the commit has a successful Kind smoke run, naming the
     workflow and the commit when it has none;
   - stops unless `OCTOGEE_FLEET_COMMIT` is the commit of `OCTOGEE_FLEET_VERSION`;
   - checks that the tag is annotated and that the published image manifest
     and any recorded GKE run refer to the tagged commit;
   - adds the release tag to each image, beside its commit tags;
   - creates the release with install and upgrade instructions, the fleet CLI
     version, each image's index digest, verification results, and the
     Build main `image-manifest.json` attachment;
   - then, in two jobs of their own, publishes the npm packages and pushes the
     charts.

Build main keeps the manifest for 90 days. After fixing a failed release
job, dispatch the current workflow against the existing tag:

```bash
gh workflow run release.yml -R octogee-ai/octogee-cloud --ref main -f tag=v0.2.0
```

The workflow validates the tag again and builds every package and chart from
the tagged commit.

The npm and chart jobs start only after the release exists, and a failure in
either leaves the images and the release as they are. Without working npm
credentials the npm job fails and says so. Fix the cause, then rerun the
failed jobs from the workflow run: each job publishes only what is not
published yet and skips the rest, and a rerun of the release job keeps the
existing release.
