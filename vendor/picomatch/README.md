# Picomatch security backports

These npm tarballs patch CVE-2026-112366. Each preserves its upstream
release version, license, and import surface and identifies itself as
`@octogee/picomatch`. npm installs the package in the original
`node_modules/picomatch` location. Each lock entry pins the archive's
commit-addressed download URL and SHA-512 integrity.

The v2 patch comes from [upstream #246](https://github.com/micromatch/picomatch/pull/246)
at `f03bec2c02e46f063fbfdc161aae1d0f854b2565`. The v4 patch comes from
[upstream #254](https://github.com/micromatch/picomatch/pull/254) at
`c63a5bf4e61dbdb81bc41e97dc2616c30acce337`.

To reproduce an archive, apply the corresponding patch to the upstream tag,
run the upstream behavior suite, set `name=@octogee/picomatch` with
`npm pkg set`, and run `npm pack --ignore-scripts` with npm 11.20.0.
The 2.3.2 behavior suite and changed-file lint pass. Its unmodified fixtures
have three lint violations. Both complete v4 suites pass.

| Archive | SHA-256 |
| --- | --- |
| `picomatch-2.3.2-d0d23092.tgz` | `d0d230925d20db75632e050137726f200e2fb3eaf0fcf996a63778be1283ce39` |
| `picomatch-4.0.4-78ee9822.tgz` | `78ee9822fc664756dda2f7a51f51e53fba01d790673ef90d17a88d66bff5652b` |
| `picomatch-4.0.7-e1f8b86c.tgz` | `e1f8b86c749d0c7c8368c98af10df2d69d1bda1a4a6c2952f54f1e6a77f5e185` |
