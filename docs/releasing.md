# Releasing

A release is a `vX.Y.Z` tag on a `main` commit whose Build main run succeeded.
The [Release workflow](../.github/workflows/release.yml) turns the tag into a
GitHub Release. Only a maintainer pushes release tags.

## Versions

octogee-cloud is pre-1.0. A minor release (`v0.2.0`) can change Helm values,
the Admin API and stored state, with no migrations between releases. A patch
release (`v0.1.1`) only fixes. Every release names the
[octogee-fleet](https://github.com/octogee-ai/octogee-fleet) release that Build
main tested it with, `OCTOGEE_FLEET_VERSION` in
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

2. Tag it and push the tag:

   ```bash
   git tag -a v0.1.0 -m v0.1.0 <commit>
   git push origin v0.1.0
   ```

3. The Release workflow then:
   - stops unless the commit is on `main` and has a successful Build main run;
   - stops unless `OCTOGEE_FLEET_COMMIT` is the commit of `OCTOGEE_FLEET_VERSION`;
   - adds the release tag to each image, beside its commit tags;
   - creates the release, with how to start from it, the octogee-fleet version,
     each image by index digest, what upgrading can promise, the changes since
     the last release, and Build main's `image-manifest.json` attached.

Build main keeps that manifest for 90 days, so release a commit within 90 days
of its build. If the workflow stops, delete the tag, fix the cause and push the
tag again.
