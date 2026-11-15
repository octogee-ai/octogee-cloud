# Releasing

A release is an annotated `vX.Y.Z` tag on a `main` commit whose Build main run
succeeded and on which the [GKE install guide](gke.md) was followed end to end.
The [Release workflow](../.github/workflows/release.yml) turns the tag into a
GitHub Release. Only a maintainer pushes release tags.

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
     attached.

Build main keeps that manifest for 90 days, so release a commit within 90 days
of its build. If the workflow stops, delete the tag, fix the cause and push the
tag again. The workflow checks everything before it tags an image.
