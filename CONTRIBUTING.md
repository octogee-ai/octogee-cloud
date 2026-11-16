# Contributing

Help improve Octogee Cloud through documentation, bug reports, tests, or code.
You can start with one package; running the platform is a separate step.

## Find a first contribution

- Clarify a confusing instruction or explain a term where it first appears.
- Try an installation guide and report the command, expected result, and what
  happened, with credentials and personal details removed.
- Fix a bug with a test that reproduces it.

Use [issues](https://github.com/octogee-ai/octogee-cloud/issues) for reproducible
bugs and proposed changes, and
[discussions](https://github.com/octogee-ai/octogee-cloud/discussions) for
questions. Report vulnerabilities through the [security policy](SECURITY.md).
Follow the [code of conduct](CODE_OF_CONDUCT.md) in all project spaces.

## Set up a checkout

Install Node.js 24, npm, and Git. Fork the repository on GitHub, clone your
fork, and create a branch for your change:

```bash
git clone https://github.com/YOUR-USERNAME/octogee-cloud.git
cd octogee-cloud
git switch -c docs/clarify-getting-started
```

Read [AGENTS.md](AGENTS.md) for the package map and engineering conventions.
The [handbook](docs/handbook/00-index.md) explains individual topics in depth.

## Run the relevant checks

Each package has its own dependencies and commands. For example, from the
repository root, you can check the shared library without cloud credentials
or a model provider key:

```bash
npm ci --prefix shared
npm test --prefix shared
npm run typecheck --prefix shared
```

For your change, use the owning package's `package.json` and the installation
order in [Checks](.github/workflows/checks.yml). The
[testing guide](docs/handbook/11-testing.md) covers focused tests, sibling
package dependencies, and troubleshooting.

For documentation changes, check links, command accuracy, and the diff. Add
behavioral tests when changing code behavior. When changing source in `core`
or `shared`, rebuild and include its committed `dist/` output.

## Open a pull request

Keep each pull request focused on one purpose. Describe the problem, the
resulting change, and how you checked it. For a bug fix, start with a failing
test that reproduces the bug and show that it passes with the fix.

Sign off every commit with `git commit -s`. This adds a `Signed-off-by` line
with the name and email configured in Git and certifies the
[Developer Certificate of Origin](https://developercertificate.org).
Check that these are the details you intend to publish before committing.
The `dco` check requires a sign-off on every commit.

Maintainers review and merge pull requests after the required checks pass.
Use example identities such as `user@example.com` in docs and fixtures, and
remove tokens, account identifiers, and personal data from logs and screenshots.
Keep working source links and required attribution intact.
