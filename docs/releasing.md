# Releasing

A release is an annotated `vX.Y.Z` tag on a `main` commit whose Build main run
succeeded and on which the [GKE install guide](gke.md) was followed end to end.
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
release that Build main tested it with, `OCTOGEE_FLEET_VERSION` in
[build-main.yml](../.github/workflows/build-main.yml). To move to a newer
octogee-fleet, set both `OCTOGEE_FLEET_VERSION` and `OCTOGEE_FLEET_COMMIT`
there, merge, and release a commit whose Build main ran with it.

## Cut a release

1. Pick the commit. It must be on `main`, and its Build main run must have
   succeeded, which means its images are published and both kind smokes
   passed with the pinned octogee-fleet. This prints the newest one:

   ```bash
   gh run list -R octogee-ai/octogee-cloud --workflow=build-main.yml --branch=main \
     --event=push --status=success --limit=1 --json headSha --jq '.[0].headSha'
   ```

2. Follow [docs/gke.md](gke.md) end to end at that commit, on a fresh Google
   Cloud project: `up`, a shared gateway, a user whose agent answers in
   Mattermost, a project for that user with work saved in it, a move to an
   isolated gateway, more work saved in the project there, the move back, a
   check that both saves reached the project's Gitea repository, the isolated
   gateway's retirement, and `down`. Whoever runs it reports the date and the
   commit to the maintainer. If any step fails, fix it on `main` and start
   again from step 1.
3. Tag the commit with that run in the tag message, and push the tag:

   ```bash
   git tag -a v0.1.0 <commit> -m v0.1.0 -m "GKE install guide: 2026-11-15 <commit>"
   git push origin v0.1.0
   ```

   The maintainer who pushes the tag records the GKE run in its message, and
   that message is the only record. The release notes print it,
   and the workflow refuses a tag whose message names no run, or names a run at
   another commit.

4. The Release workflow then:
   - stops unless the commit is on `main` and has a successful Build main run;
   - stops unless `OCTOGEE_FLEET_COMMIT` is the commit of `OCTOGEE_FLEET_VERSION`;
   - stops unless the tag is annotated and its message names a GKE install
     guide run at the tagged commit;
   - adds the release tag to each image, beside its commit tags;
   - creates the release, with what the platform does and does not do yet, the
     date and commit of the GKE run, how to start from it, the octogee-fleet
     version, each image by index digest, what upgrading can promise, the
     changes since the last release, and Build main's `image-manifest.json`
     attached;
   - then, in two jobs of their own, publishes the npm packages and pushes the
     charts.

Build main keeps that manifest for 90 days, so release a commit within 90 days
of its build. If the release job stops, delete the tag, fix the cause and push
the tag again. The workflow checks everything before it tags an image.

The npm and chart jobs start only after the release exists, and a failure in
either leaves the images and the release as they are. Without working npm
credentials the npm job fails and says so. Fix the cause, then rerun the
failed jobs from the workflow run: each job publishes only what is not
published yet and skips the rest, and a rerun of the release job keeps the
existing release.
