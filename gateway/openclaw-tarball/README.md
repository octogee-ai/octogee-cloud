# OpenClaw current build

Octogee uses a released OpenClaw tag or an explicitly selected main snapshot,
plus the smallest overlay justified by demonstrated product gaps. `current.json` selects
two write-once GCS artifacts. Build main resolves their generations and produces
an immutable, digest-addressed image family. Building never deploys TEST or PROD.

## Refresh a tag or selected main snapshot

Reassess the overlay on every recut. Use the selected upstream's unpatched
Control UI/Dashboard as the functional reference, comparing the same agent,
identity, permissions and provider configuration. Prefer native behavior,
configuration and public plugin APIs; adapt Octogee consumers before extending
OpenClaw core. An existing consumer's dependency on a fork-only API is not proof
that the patch is needed.

For each retained patch, the assessment below must answer: what concrete
failure or approved incremental behavior remains after trying the native path;
why it belongs here rather than in an Octogee adapter; and what removes it.
Distinguish reproduced upstream bugs from optional product features and obsolete
integration assumptions. Features we previously built are not automatically
retained. Record upstream contribution status separately from that decision.
Adopt OpenClaw's canonical schemas and migration owners rather than maintaining
an Octogee schema fork. Keep these decisions and consumer adaptations in the
canonical recut, not a parallel runtime update path.

1. Fetch upstream in a clean OpenClaw checkout (`origin`: `openclaw/openclaw`,
   `ceckert`: the fork). For a tag, record the annotated tag object and peeled
   commit. For main, inspect the jobs of the most recent successful **full** CI
   run, not just a green fast/security-only push run. Record its exact head SHA,
   run URL and skipped jobs. A newer tip is not automatically a better candidate.
   An operator may instead select a newer main for independent qualification;
   record that exception and its CI limitations explicitly.
2. Lock that full SHA before starting. Rebase only the justified overlay onto it,
   checking each changed boundary. Do not chase a moving tip during the build. Drop
   adopted behavior, unused capabilities and optimizations that change upstream
   correctness. Use native owners when files or APIs move.
3. Test affected behavior, with a failing control for new bugs; run applicable
   native type, lint, generated-output and package checks. Reuse upstream
   coverage instead of copying whole suites. Keep real resource/authorization
   boundary tests even when trimming fixtures.
   Materialize both gateway classes through their real policy/pre-boot writers,
   including generated agents, and validate them against the exact built gateway.
   An isolated Doctor comparison must not need to translate default config keys;
   correct their writers during this recut instead. Keep Doctor off every boot:
   Octogee runs no automatic failed-boot repair. Explicit source repair and
   driver-artifact checks stay.
4. Commit the final source and run the full build. `pnpm build package` adds
   `clean:dist` before the same full-build steps, removing E2E/QA artifact residue. Verify
   `dist/build-info.json.commit` equals the clean checkout's HEAD. Use the
   repository-pinned package manager and frozen lockfile. `build:docker` is not
   a substitute: the full build creates the files required by `npm pack`.
5. Check open upstream contributions separately against current main. Remove
   an overlay fix once the selected base contains equivalent behavior and its
   consumer tests pass. An open PR, a merge outside the selected base, or a
   matching package version is not enough.

```bash
git fetch origin main
# Set this to the selected and qualified 40-character SHA, not FETCH_HEAD.
UPSTREAM_SHA=<selected-and-qualified-sha>
git rebase --onto "$UPSTREAM_SHA" <previous-upstream-base> <overlay-branch>
pnpm install --frozen-lockfile
pnpm tsgo:prod
pnpm check
pnpm config:channels:check
pnpm build package
git status --short
cat dist/build-info.json
```

Record incomplete or inherited failing checks precisely; never describe a
partial run as aggregate `pnpm check` success. Keep single-purpose patches
and concise evidence in the PR, not historical benchmark diaries here.

## Package and publish

Run both maintained packers **sequentially** from a clean Octogee checkout into
a fresh directory. `OPENCLAW_SKIP_BUILD=1` is only for exact source already
built in this cycle. Both packers use the same OpenClaw artifact tree. The root
packer checks every `gateway/verify-*-plugin-contract.mjs` in the tree it
runs from, so a deployment that adds plugins runs it from its overlay tree.
The SDK checks use the test package and the broker runtime check uses the
scripts package. Install their locked dependencies in the packing checkout.

```bash
npm ci --prefix tests
npm ci --prefix scripts
ARTIFACT_DIR=$(mktemp -d -t openclaw-current-artifacts-XXXXXX)
ROOT_TGZ=$(OPENCLAW_SKIP_BUILD=1 \
  bash gateway/openclaw-tarball/pack-fork-tarball.sh \
  /path/to/openclaw "$ARTIFACT_DIR")
MATTERMOST_TGZ=$(bash gateway/openclaw-tarball/pack-mattermost-tarball.sh \
  /path/to/openclaw "$ARTIFACT_DIR")
```

Before publication:

- Run upstream's `scripts/check-openclaw-package-tarball.mjs` on the root archive.
- Verify `vendor/npm.tgz` in the root archive and the independent global npm
  installation contain the qualified runtime bytes. The packer stages stock npm
  12.2.1 and applies [its distribution patch](npm-12.2.1.patch) to that temporary
  copy before packing. The root keeps its exact npm 12.2.1 dependency and bundles
  that patched closure in a disposable package stage; a relative tarball
  dependency cannot be resolved before global install extracts the root. The
  normal npm package inventory supplies stage files and modes, with escaping
  paths refused. Installed source dependencies remain unchanged. Selected main pins npm 12.2.1; no fork-only npm version change remains. Octogee owns the nested Undici 6.29.1 and
  ip-address 10.7.4 fixes because pnpm 12.15 loses these bundled-file patches on
  a cached import. The glob 13.0.6 cancellation backport follows upstream commit
  `4682e8c9babee1b385202ede36389634e12076d7`; minimatch 10.2.5 preprocessing limits
  follow `77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8`. The picomatch 4.0.5
  backport in npm's tinyglobby dependency follows upstream commit
  `c63a5bf4e61dbdb81bc41e97dc2616c30acce337` for CVE-2026-112366.
  Versions remain unchanged
  for these backports, so version-only advisory scans still report them.
  Both glob public `index.min.js` bundles are regenerated from the patched closure
  with esbuild 0.27.3 using upstream `scripts/build.sh` options (`--minify
  --platform=node --bundle`, each format's `index.js`, matching `--format=cjs`
  or `--format=esm`), omitting source maps absent from npm's distribution.
  Run `node npm-distribution.test.mjs <npm-root>` against the staged and installed
  copies. The 24 raw/public CJS/ESM controls and the tinyglobby matcher control
  must pass. Reassess this patch against
  each selected npm release; retire each backport when the stock installed closure
  supplies the equivalent fix.
  Platform Dockerfiles stage npm 12.2.1 with this same distribution patch and
  run the same 25 controls before copying only the patched npm tree into runtimes;
  the patch and test bytes are platform/site release and per-image fingerprint inputs.
- Install the exact root and Mattermost pair in an isolated npm prefix and
  verify installed build-info. Core, Codex, Parallel and Mattermost must come
  from the same checkout, not merely share a version.
- Stage the vendored npm archive before building the actual Linux
  `openclaw-full-plugin-installer` target in `gateway/Dockerfile.base`.

  ```bash
  bash gateway/openclaw-tarball/extract-npm.sh gateway/openclaw-tarball/openclaw-fork.tgz
  ```

  Its native registry refresh, bundled-trust
  check, source-match verification and three native-hook imports must pass.
  Recipe fixtures alone are not installed-image proof.
- Confirm the native prepack/postpack lifecycle leaves the source clean.

```bash
ROOT_SHA256=$(shasum -a 256 "$ROOT_TGZ" | awk '{print $1}')
ROOT_OBJECT="openclaw-fork-${ROOT_SHA256:0:8}.tgz"
MATTERMOST_SHA256=$(shasum -a 256 "$MATTERMOST_TGZ" | awk '{print $1}')
MATTERMOST_OBJECT="openclaw-mattermost-${MATTERMOST_SHA256:0:8}.tgz"

gcloud storage cp --if-generation-match=0 "$ROOT_TGZ" \
  "gs://octogee-openclaw-fork/${ROOT_OBJECT}"
gcloud storage cp --if-generation-match=0 "$MATTERMOST_TGZ" \
  "gs://octogee-openclaw-fork/${MATTERMOST_OBJECT}"
```

Never overwrite an object or use retired `*-main.tgz` names. If an object
already exists, verify its complete hash before reuse; an eight-character
name is not proof. Read back published generations and hashes. Set
`upstreamRef`, `sourceSha`, `openclawObject` and `mattermostObject` in
`current.json`. Push the
exact overlay branch; use `--force-with-lease` only when rewriting a previously
published branch.

After changing the source pin, regenerate `core/src/agent-store-routines.json`
with `core/qualify-agent-store-routines.mjs` against disposable PostgreSQL
16 with pgvector 0.8.7, then rebuild `core/`.

gateway-edge's Browser resource projection ships from the same source.
Regenerate it from the same clean checkout before publishing, so `sourceSha`
pins the gateway objects and the committed bundle together:

```bash
node gateway-edge/openclaw-browser-resources/build.mjs /path/to/openclaw "$(git -C /path/to/openclaw rev-parse HEAD)"
```

Its `provenance.json` records that source and a digest of the generator and
adapter files in `gateway-edge/openclaw-browser-resources/`.
`scripts/__tests__/openclaw-browser-resources-provenance.spec.ts` fails when the
bundle names a source other than `sourceSha`, or when those files changed
without a rebuild.

Once `current.json` names the new build, run the state pin-roll ceremony.

- **Who runs it.** It is a manual step: whoever prepares the roll PR runs it before
  opening that PR. PR CI cannot run it, because it needs the fork objects from the
  bucket, and PR jobs have no cloud credentials.
- **Install.** Install two root objects, each in its own npm prefix:
  - the root object of the oldest pin that created any state store still retained
    in the fleet (for the roll to `92373b3c`, that is `e9c9cd30`)
  - the new root object
- **Run.** Run `tests/specs/openclaw-state-pin-roll.spec.ts` with:
  - `OCTOGEE_TEST_OPENCLAW_PREVIOUS_BIN` and `OCTOGEE_TEST_OPENCLAW_PREVIOUS_SHA`:
    the older pin's binary and its full source SHA
  - `OCTOGEE_TEST_OPENCLAW_BIN`: the new build
  - `OCTOGEE_TEST_POSTGRES_DSN`: a disposable database, reached the way gateways
    connect. That is a non-superuser role holding only `CONNECT, CREATE` on the
    database, like the roles `core/src/agent-store-credentials.ts` provisions.

The spec creates state with the older pin, then writes an isolated agent entry with
the new build twice. It checks that:

- the setup rows survive
- `workspace_setup_state.bootstrap_deferred` is a nullable `bigint` with no default
- the seal changes when the column was missing or the schema version advanced, and stays stable on the second write

Its `pin_roll_*` schemas are dropped afterwards.

Update the Current overlay assessment below in the same Octogee PR. This README
is deliberately a gateway build input, including for artifact-only recuts.
Run focused artifact/base-image tests, evaluate feedback and wait for final-head
CI. After merge, Build main produces images, not a deployment. Environment
selection and rollout are a separate operator step.

## Current Gateway overlay

The November 20 overlay is `0e76ab99c8f23245c126b8ab1713396d088a8ad1` on
`ceckert/openclaw:codex/gateway-refresh-20261120`. It carries the retained
Octogee boundaries below on the frozen upstream tip.

The Mattermost connector verifies the sender through the Gateway before applying
the requested follow-up or steer mode. The reply runner checks the selected run
and keeps native steering authority. Remove this overlay when the channel SDK
supports authorized per-message queue selection and exact-run steering.

A Builder return moves scheduled jobs with `cron.migration`. A job created from
a browser or device session stores a Gateway operator source bound to the
exporting Gateway's device. Restored on the target, that source failed device
revalidation, the error was classified permanent, and the scheduler disabled the
job after its first run. New users saw their default automation fail after the
move. Staging now rebinds each Gateway-sourced job to the staging caller's live
operator authority. The caller must hold `operator.cron` and be the same
requester profile. The fresh source is narrowed to the stored grant's scopes and
admin flags, and the caller's authority guards the staged commit. Projected
declarations with a Gateway source, and any Gateway-sourced job the caller
cannot rebind, refuse the stage. The rebinding is never accepted from the wire.
Session-kind sources that record a device, conversation locality and inference
bindings are not rebound; they remain an open risk for moved jobs. A stage retry
from a caller that cannot capture authority fails even after an earlier attempt
succeeded. Remove this overlay when native migration restores operator sources
on the receiving Gateway.

OpenClaw main was frozen at `238160cf99b254aebd96a8ed34b9148b3e56903b`. Its
[push CI](https://github.com/openclaw/openclaw/actions/runs/44742014136) ran
`security-fast` successfully and skipped 42 jobs, including artifact build, core
type and lint lanes, Control UI unit and real-Gateway E2E, Docker seed E2E,
PostgreSQL conformance, Skills Python, platform-native lanes and the final
`openclaw/ci-gate` job.

The most recent successful scheduled full
[CI run](https://github.com/openclaw/openclaw/actions/runs/43129347832) was on
`cda0b61ac4d23fb0a5fa5530e37f9e74ce3face5`. It passed 151 jobs, including the
artifact build and all three PostgreSQL shards. Its 11 skips covered conditional
additional-extension declarations, Node 24 compatibility, plan, i18n, mobile
screenshots and release E2E, PR failure reporting, and the release evidence seal.
The nearer [scheduled run](https://github.com/openclaw/openclaw/actions/runs/44736390881)
at `35d714e7f099ee0bf044eb7e4647497b03bf9d15` passed its artifact build and all four
PostgreSQL shards. It had 147 passes, 12 skips and nine failures across
Control UI E2E (6/10), Docker seed E2E, Android access, five Node shards and the
final gate. The refresh qualifies the frozen tip independently.

The unchanged upstream checkout passed production core, Control UI and extension
typechecks, 130 focused tests, six PostgreSQL conformance tests and the
SQLite/PostgreSQL catalog comparison. The focused scope included device retirement
and restored authority, sharing, config planning, delivered Skills worker bundles
and Mattermost sends.

This cut drops the test-only timing weight for PostgreSQL bootstrap-deferral.
The native test remains in conformance through suffix discovery. Native
[#202318](https://github.com/openclaw/openclaw/pull/202318) checks revoked devices
when restoring a retained run. The receiving Gateway still has to rebind migrated
cron authority. Native [#202442](https://github.com/openclaw/openclaw/pull/202442)
retires in-run watchers. The overlay keeps live approval and resource-owner
checks at effect admission. Native
[#202453](https://github.com/openclaw/openclaw/pull/202453) owns loading delivered
Skills worker bundles, and [#201973](https://github.com/openclaw/openclaw/pull/201973)
owns Mattermost callback deduplication. Mattermost's channel-scoped sessions,
verified queue and steer requests, and action gates still serve Octogee callers.

The worker's typed detach refusal now comes from a dependency-free module.
The registry, runtime callers and performance probe share that constructor.
This preserves rollback of an uncommitted detach journal and prevents a refused
enqueue from falling through to a best-effort send. The Doctor capture hook
receives the existing repair options and still requires maintenance admission
to restore private file modes before honoring an explicit backup skip.

Native [#201812](https://github.com/openclaw/openclaw/pull/201812) and
[#201998](https://github.com/openclaw/openclaw/pull/201998) check approval run
authority once at request start and delete `forceDenyIfRuntimeAuthorityClosed`.
The overlay's shared closure scheduler is removed; its reviewer guard on
resolution is retained. Native [#201887](https://github.com/openclaw/openclaw/pull/201887)
drops the per-dispatch run authority check from node invocation; the overlay
keeps only its live computer-control assertion there. Native
[#201063](https://github.com/openclaw/openclaw/pull/201063) passes plugin install
records into web secret resolution, replacing the overlay's asynchronous read.
Doctor keeps the overlay's maintenance-admitted recovery-backup skip ahead of the
native shared-image retention from [#201914](https://github.com/openclaw/openclaw/pull/201914).
New automations keep their restored fields alongside native prompt naming from
[#201184](https://github.com/openclaw/openclaw/pull/201184). The sections below
describe boundaries retained from earlier cuts.

The frozen tip includes native [#193596](https://github.com/openclaw/openclaw/pull/193596),
which prepares the backup and acquires its PostgreSQL lease through the config
recovery owner, and [#191463](https://github.com/openclaw/openclaw/pull/191463),
which validates delayed deletion-authority replies. Drop the corresponding
overlay code. Octogee retains outbound delivery drain and the detach-specific
journal phase through retirement.

Native [#184515](https://github.com/openclaw/openclaw/pull/184515) now carries
membership through mention lookup, recording and commit validation. The
overlay removes its parallel mention facts and retains recorded channel
provenance and directory invalidation for Octogee's restricted-channel policy.
Native [#193487](https://github.com/openclaw/openclaw/pull/193487) performs
VncAuth during readiness probing. External credential rotation still needs a
fresh password on reconnect to an already acquired desktop. The overlay uses
the native password reader and retains the stopped-session and revoked-observer
checks before issuing a token. Remove this adaptation when native reconnects
refresh the credential and preserve the same authority.

Native #197510 owns database admission descriptors. The overlay places its
detached-store probe guard at that owner. A queued asynchronous probe could
recreate a descriptor after an accepted detach. The matching live creation
claim can admit the preserved store for reattachment. Native #200066 defers
PostgreSQL schema initialization. Native #197425 owns the pre-deferral upgrade.
Native #199591 owns the tool-repeat guard. The overlay retains the live
execution check across its approval handoff. Native #198428 owns Mattermost
media admission. The overlay keeps grouped sends using that boundary.
Cron migration already rejects jobs that carry runtime or host authority.
The overlay removes the redundant authority reconciliation from portable-job
restore and relies on native cascading cleanup when replacing a declaration.
The overlay keeps Gateway broker startup lazy on constrained hosts through
its own startup module. The frozen tip's mixed static and dynamic import of
the shared broker host failed the package build in the previous refresh.
The frozen tip still imports that host statically for retained native workers.

Native [#197510](https://github.com/openclaw/openclaw/pull/197510) no longer
creates plugin migration readiness receipts during reads. A cold workspace
registry could fall through to a synchronous PostgreSQL read on the Gateway
main thread and abort startup. The overlay awaits the existing worker-backed
loader in prepared workspace and cron callers. It retains migration holds,
registry ownership and cancellation. Remove the overlay once the native
caller acquires the cold workspace registry through the same worker path.

Native [#198180](https://github.com/openclaw/openclaw/pull/198180) owns held-store
path selection and offline schema migration. The duplicate path selector is
removed. Configured reattachment retains its original workspace, agent
directory and database set, verifies each logical store, and admits existing
stores before settling the deletion tombstone. The creation claim still
covers config preflight and releases native handles before publication.
Native hot reload uses the canonical published runtime config. The overlay
keeps strict channel teardown, supersession and waiting-root custody.
Native [#198547](https://github.com/openclaw/openclaw/pull/198547) closes retired
agent readers independently of unrelated worker tasks. Deletion-authority
checks retain their read-only path. Native PostgreSQL conformance discovers
suffix suites, so the overlay registers only its additional non-suffix tests.

The refresh keeps native agent config publication authority from
[`73f9a890441`](https://github.com/openclaw/openclaw/commit/73f9a89044119763b0576004d8009b1428b58d28)
through the overlay’s retained-store creation claim. Native
[#197856](https://github.com/openclaw/openclaw/pull/197856) supplies steering
refusal reasons, replacing the overlay’s Boolean probe. Channel membership
continues to check the session’s recorded channel provenance through the
native sharing authority. Native
[#198206](https://github.com/openclaw/openclaw/pull/198206) owns Mattermost
preview placement. The following sections describe retained boundaries and evidence from earlier cuts.

Native [#197230](https://github.com/openclaw/openclaw/pull/197230) retires the
Memory shadow database’s admission descriptor before deleting the completed
reindex files. The duplicate overlay code is removed. The regression also
checks that cleanup leaves the canonical database descriptor and data intact.
The native worker-owned database close and published model-catalog paths are
preserved. The first-config baseline repair in #193636 and the delegated
Mattermost download scope repair in #186893 are carried in this overlay.

Mattermost uses the native fence-aware Markdown chunker from
[#196331](https://github.com/openclaw/openclaw/pull/196331). The grouped-media
adapter still keeps multiple attachments in one post. Native Doctor repairs
remount-broadened private store modes under maintenance authority before
capture. The explicit backup-skip option preserves that repair and still
requires the same authority. Native config reload owns saved-but-deferred
plugin application. The overlay retains strict channel teardown, supersession
and waiting-root custody for accepted writes.

Native #194791 skips membership reads outside the invited policy. Octogee
grants synchronized channel members access under its restricted policy, so
channel reads and list projections still query membership under `none` and
invalidate visibility on grants and revocations. Incognito and draft sessions
remain excluded. Remove the adaptation when the native policy provides those
semantics or the Octogee policy changes. The sections below describe retained
behaviors and their removal conditions. Historical proofs apply to their own
source and image.

### Deferred agent model preparation

A deferred project agent can finish database admission after its early model
publication is withdrawn by a concurrent Gateway refresh. The agent remains
connected while model-auth status and reply dispatch are unavailable. The
native startup owner now checks its prepared model after migration and republishes
only when missing, joining any affecting publication and honoring cancellation.
The existing config, deletion, secret and database admission checks remain in
force. Remove this overlay when the selected OpenClaw source contains an
equivalent fix.

A Gateway regression withdraws the early publication while migration is held.
It fails on the previous source and passes with this change, including native
model-auth status and chat admission. Focused startup tests cover an unrelated
publication and shutdown during the replacement wait.

### Retained-home boot and prelaunch authoring

[OpenClaw #193596](https://github.com/openclaw/openclaw/pull/193596) repairs two
PostgreSQL startup paths: prepared config recovery passes its existing async
backup validator, and the synchronous final lease guard uses the existing
narrow engine-admission scope to read current durable lease ownership. Expired,
revoked or replaced leases still refuse publication. Backup selection, source
identity checks and normal serving recovery remain native-owned.

Normal recovery correctly restores the backup roster, including its coach.
Octogee must therefore author intentional prelaunch reductions through the
native config writer instead of raw file replacement. A narrow offline-only
`config patch --allow-size-drop` option forwards the writer's existing explicit
size-drop intent; omitted agents still require explicit null removals. The
Gateway must be stopped. Octogee keeps the accepted system-config commit and
existing watcher isolation, disables customer channels/cron/bindings, and boots
only `octogee-unmatched-route`. It adds no system coach, repair loop or recovery
owner. Fresh-home proof also exposed a missing first-write health baseline;
retained-home proof exposed recovery preview running before database selection.
The native health owner now establishes a baseline for a first accepted write,
retains inherited-anomaly refusal, and restores true absence on rollback. The
existing early recovery preview uses a scoped configured engine so it reads the
same health state as admission. These fixes and the CLI option are tracked in
[OpenClaw #193636](https://github.com/openclaw/openclaw/pull/193636); final compiled
lifecycle proof covers fresh and retained PostgreSQL-state homes, two cold starts,
byte-exact original backups, live-owner refusal, retained session/history after
coach reattachment, and ordinary corruption recovery. The installed Octogee writer
is additionally exercised in complete-image qualification.

### Retained-agent live import repair

A reused Builder home can boot with a completed detach record and no configured
agent. Replacing its retained PostgreSQL anchor during a live import then made
`agents.create` fail during config preflight: the creation claim had already
closed even though publication still needed the recreated identity. The overlay
keeps that existing claim through preflight and settles its handles at the native
config writer’s precommit hook. Cleanup failures still prevent publication and
roll back staged auth. It adds no Doctor run, deletion-journal bypass, or recovery
owner. Remove this patch when the selected OpenClaw source carries the same fix.

The real PostgreSQL RPC regression is red on the previous source and green on
this source, preserving store identity, full history, live reads and session
creation before restart, and writes after restart. Existing staged-auth commit,
rollback, close-failure and post-publication bookkeeping tests also pass.
Core typecheck, scoped lint and independent review cover the source change.

### PostgreSQL idle recovery after suspension

Native [#193875](https://github.com/openclaw/openclaw/pull/193875) now validates
idle retained PostgreSQL connections before their next query. The transport
reconnects before dispatch when needed and preserves the transaction and
uncertain-outcome rules. The overlay drops its duplicate transport change.
The regression covers the first operation after losing a retained socket while
the Gateway was suspended.

### PostgreSQL state created before bootstrap deferral

State from the oldest retained pin, `e9c9cd30`, can predate the nullable bigint
`workspace_setup_state.bootstrap_deferred` column. Native
[#197425](https://github.com/openclaw/openclaw/pull/197425) recognizes the
supported predecessors and finishes the column during writable admission.
Inspection preserves the existing schema and unrelated drift still fails.
The overlay drops its generic additive-column path and uses the native
migration and regression fixtures.

### Native adoption and retained product boundaries

The source is rebased onto that exact tip. Previously adopted session-list,
retained-PG creation, Talk initialization/consult and Doctor auth-alias fixes
remain native. Native schemas remain canonical (GLOBAL 40 and AGENT 43).
Native #193682 owns the AGENT 40 to 41 upgrade and its active transcript facts.
Native #200533 owns the AGENT 43 queued-input ending migration.
Native inbound-context composition,
bot-loop protection, worker ownership and backup source-artifact preservation
remain.

Native [#189036](https://github.com/openclaw/openclaw/pull/189036) owns the
worker-backed Talk steering read. The overlay retains
[#189418](https://github.com/openclaw/openclaw/pull/189418)'s direct-attempt
authority source and live owner/backend checks through steering insertion.
The native project-icon route stays intact. Existing workspace icons use
the prepared session-sharing owner to honor Octogee channel-member access and
revalidate membership before publishing bytes. List selection consults the same
membership policy when deciding whether a visibility decision can be reused.

Mattermost inbound parity (#186891) and message actions/multi-file sends
(#186893) remain approved channel behavior. Current action gates must retain
opt-in writes/downloads/pins/search/member information and final live-authority
checks; channel-scoped sessions retain reply roots. Their upstream contribution
readiness is tracked separately from installed artifact proof.

The scoped reload-account repair remains: only resolved new/removal-only account
targets skip unrelated global drain; affected existing accounts and widening
fallbacks retain it. Requester propagation, one approval reviewer, authoritative
membership revocation, strict stop joining physical startup/cleanup, worker
reclamation deadlines, retained-store detach/reattach and outbound delivery
custody remain under their existing owners.

Scheduled plugin tools receive a separate verified `scheduledRequester` only
for account-policy jobs delivered through their creator's channel account. It
never becomes ordinary invoking requester authority. Operator cron restore
retains closed `scheduledToolPolicy`/`toolsAllowProvenance` schemas, account/owner
matching and operator-only reads; native human-owner transfer changes a different
contract. Remove these extensions when native supplies the equivalent creator
fact or Octogee stops recreating jobs through operator `cron.add`.

The Octogee-only `doctor --skip-recovery-backups` option remains limited to
existing externally protected private-import/upgrade paths. It does not replace
the ordinary source Doctor required before a native SQLite-to-PG port. Native
maintenance admission, migrations, leases and commit authority remain intact.

### PostgreSQL-only Octogee policy and checkpoint retirement

Both Gateway classes now author `database.engine: postgres` for every configurable
portable family: state, agent, Workboard, Logbook and Team Reports. There is no
older-Builder or older-account SQLite runtime mode. Native-required local
credentials, PG anchors and safety/recovery journals remain native SQLite files;
they are not user data engine fallbacks.

The old periodic/preStop SQLite-state checkpoint and download/restore consumer
is removed. It already skipped PG GLOBAL anchors. Its fork-only `backup local`
CLI and paired mixed-engine snapshot owner are therefore removed too, restoring
native backup/restore and credential handling exactly. Native's all-PG
`backup create --local-companion` remains available; it is not claimed to be the
same API. Upstream #178973 was closed unmerged at the user's request because
Octogee no longer uses that proposal. PG GLOBAL recovery retains verified
recorded anchors and never falls back to an old SQLite checkpoint. Detach,
delivery-queue retirement and no-replace physical publication are preserved.

Retained SQLite data or explicit non-PG family selection refuses before the
writer changes config. GLOBAL absence alone cannot prove other stores are
fresh. With the Gateway and embedded writers stopped under their existing
service/hold authority, preserve source config/stores, run ordinary native
`doctor --fix --non-interactive`, and use native `database port --family <family>
--to postgres --dry-run` followed by the actual port for each SQLite family.
Native owns capture, verification, recovery manifests and config publication.
An empty-family port currently reports a verified no-op without rewriting its
selector: after inventory proves every populated store is PG and remaining
families are empty, use native's config writer to select PG for those empty
families. Never flip engine keys over retained SQLite files. Interrupted ports
must resume or roll back through the native manifest owner.

No deployed old-format/store inventory or live migration is claimed by this
isolated refresh. Build main publishes images; it does not deploy or migrate a
running Gateway. Any operational cutover still needs its stopped-source port and
post-port data/Memory/Skills verification.

### Migrating retained Builder stores

The Builder supervisor exposes an operator-only local-socket migration for all
five database families: state, agent, Workboard, Logbook, and Team Reports. On the
retained source allocation that has served traffic, with no active handoff, run:

```bash
/octogee/scripts/node_modules/.bin/tsx /octogee/scripts/ops/migrate-builder-stores.ts \
  --expected-pod-uid=<retained-source-pod-uid> --apply
```

The supervisor refuses standby boots, verifies the source pod UID and released
readiness marker, stops OpenClaw, and serializes migration against start/resume. It runs native
`openclaw doctor --fix --non-interactive` with recovery backups, inventories every
SQLite family, and invokes `openclaw database port --family <family> --to postgres`
for each populated family. Native ports own schema upgrades, data verification,
local credential companions, and recovery manifests. Only a native inventory
proving zero stores permits an expected-value config write for an absent family;
file size is never evidence of absence. Unsupported/custom store paths fail
before any port because Octogee cannot durably restore their anchors.

Before startup is unblocked, the command verifies each PostgreSQL store identity,
records and reads back state, agent, and auxiliary anchors through the fleet
broker, applies pre-boot config patches, and checkpoints system_config to Gitea.
The matching API must be deployed first: a broker that drops auxiliary anchors
fails read-back verification. A durable-record or config-checkpoint failure leaves
a local pending marker and the source held; rerunning retries the unfinished
work without re-porting completed PostgreSQL families. An active native recovery
manifest requires explicit native `database port --resume <manifest>` or
`--rollback <manifest>` while still held, followed by rerunning this command.
Success leaves the Builder held. Add `--resume` to explicitly permit startup only
after all steps succeed.

The provisioner also records newly created auxiliary anchors. Replacement pods
in the same Builder allocation restore those identities at native paths, verify
the PostgreSQL family/store ID, and refuse conflicting local stores or missing
namespaces. Records are bound to the Builder owner, gateway, and allocation
generation; Shared gateways cannot report or attach these global stores. This
does not move auxiliary stores between Builder and Shared placements. Logbook
frame images and other non-database files remain outside the anchor protocol.

Builder boot can preserve SQLite state/config and defer migration to the held
supervisor, but ordinary startup still requires PostgreSQL for every family.
No Doctor or port runs automatically at boot. Retain the source pod and its native
recovery artifacts until verification and durable checkpointing succeed; deleting
it mid-migration can lose the unpublished anchors and local recovery material.
An empty replacement pod cannot establish whether its predecessor had data. This
command requires an image containing the supervisor action and cannot retrofit
older running images. It does not change desired/live releases or reconcile a
failed rollout.

### Retained boundaries and removal conditions

Retention decisions distinguish reproduced bugs from approved optional product
behavior. An open contribution or an existing fork-only consumer is not itself
proof of necessity. A merged upstream PR removes an overlay only when equivalent
behavior is present in the selected base and the affected consumer controls pass.

| Family | Native gap or approved behavior; why the owner is here | Remove when |
| --- | --- | --- |
| Requester identity and single approval reviewer | Public requester facts must survive queued/follow-up execution; one reviewer and live client authority must remain valid through the final native/Codex continuation. Scheduled runs expose the verified job creator as a separate `scheduledRequester` only when delivery uses the creator's own channel account. An adapter cannot own core effect admission or reconstruct the job creator. | Native public propagation, single capture and revocation semantics pass delayed/held continuation controls, and native exposes an equivalent verified scheduled-creator fact. |
| Channel membership sync and disclosure | Native now owns invitation-only and linked-session membership filtering. Octogee retains its approved `none`-policy channel-member access, authoritative empty-set sync, explicit-grant precedence and publication invalidation; invitation-only visibility does not replace that mutation contract. Native prepared membership facts replace the overlay target lookup callbacks. | Native authoritative membership methods and read/projection owners provide equivalent revocation and incarnation checks. |
| Mattermost channel session scope | Approved `threadSessionScope: channel` keeps one session per channel while preserving reply roots in both directions. Current writers deliberately select this product behavior. | Native supports that option, or the product explicitly adopts thread sessions and adapts membership/consumers. |
| Channel startup and strict stop | Channel startup must not borrow invoking identity; strict stop joins startup and running work, retains physical cleanup ownership, and retires only removed accounts. | Native proves hung-startup joins, late-stop retry and active-sibling preservation. |
| Reload admission, supersession and settlement | Scoped reference-counted waiting roots, supersession wakeups and model/service debt prevent dropped work or a falsely settled baseline. New/removal-only account changes avoid unrelated global drain after successful resolution; affected existing accounts and widening fallbacks retain it. Native subscription exclusions, synchronous and post-wait checkpoints remain. The separate session-list provider-reload fix is entirely native. | Native owns equivalent scoped-account, held-root, late-join, superseded-tail and post-commit settlement behavior. |
| Shared worker retirement | A failed concurrent admission could retire a shared entry while another lease retained it, permanently blocking later opens and secret reload. Ordinary retirement now waits for the final active release while serving existing leases; canonical close invalidates retained leases before joining client closure. The exact retiring-with-live-actor error is reproduced by removing the guard. | Native preserves serving leases through failed concurrent admission and closes or aborts retirement without stranding them. |
| Lifecycle lease and reclamation deadline | One monotonic worker-visible budget prevents late commits. Native's five-second cap is preserved; the overlay carries one worker-visible monotonic deadline and refuses late authorization. | Native carries the same worker-visible absolute deadline and refuses cancelled, expired and late authorization, or the relevant lifecycle consumer is retired. |
| Detach, reattach and retained PostgreSQL | Approved configured-agent transfer retains original logical/physical identity under native creation/deletion custody; missing PG anchors must refuse rather than create. Native #188350 owns unconfigured retained-store creation admission; its duplicate overlay is removed. | Native public transfer preserves namespace/history and rollback/recovery custody, or a supported migration owner replaces it. |
| Outbound delivery custody | Retirement refuses unfinished authoritative delivery state and fences racing enqueue across all affected agent identities; empty caches are insufficient. | Native detach/deletion fences the same queue and retains idempotent receipts. |
| Cron migration custody | Held/exported/staged/activated ownership, retired fences, hash-bound chunks and drain are beyond ordinary native CRUD. Projection identity includes effective agent plus declaration. | Native migration provides equivalent activation, rollback, drain and two-engine round trip. |
| Retained legacy cron/state inputs | Fingerprints/order/schema checks admit only recognized retained formats and refuse unknown partial schemas; native canonical schemas remain authoritative. | The supported retained restore/move inputs are retired, or native adopts their exact migration. Historical fixtures alone do not prove a deployed inventory; no deployed old-format inventory was inspected in this recut. |
| Voice relay and computer authority | Approved public broker transport retains native session/media ownership; desktop control release, observation/token lifetime and node execution remain bounded. | Native public contracts preserve transport validation, cancellation, fresh observation and late-dispatch refusal. |
| Final-reply notification | Activity tools require terminal final-content classification, not agent-completion inference. Only the public observer flag is retained; delivery custody is native. | Native supplies equivalent classification or the observer is removed. |
| Dashboard participant labels | Current same-session history supplies a human label missing from native observation projection. This optional presentation is used by the embedded full native Dashboard, with no access/identity mutation; the current browser/computer/workbench islands do not own its header. | Native projects equivalent labels or the embedded native chat consumer is removed. |
| Dependency and npm packaging | The exact npm 12.2.1 pin and disposable npm distribution patch need installed-byte verification; version equality does not qualify nested dependencies. Native already owns the fast-uri pin, with no fork-only version change. | Native installed closures contain the fixes and the dependency gate passes. |
| Generated schemas, inventories and test support | Describe retained APIs and canonical native owners, not independent features. | Regeneration after the owning feature's removal eliminates them. |


### Retained rollout handoff behavior

The November 1 rollout handoff identified Octogee migration/rollout issues, not
another native cron schema owner. The already-merged #4968 carries coach monitor
declarations with their original key and idempotent restore, while plugin-owned
declarations remain native. A failed source schedule snapshot (including an old
provisioner's 404), or failed durable snapshot publication, now stops the move
before cutover/removal; rollback attempts to restore known fenced jobs on the source before ingress
resumes; failed restoration remains a recovery limitation. Existing retained schedule snapshots remain available to recovery.
Builder recovery now classifies malformed retained local state as fatal, keeping
transient broker failures retryable; real CLI controls prove both classifications
without modifying retained bytes. The operational PostgreSQL runbook matches
this cut's five-family policy and checkpoint retirement.
Old builds that cannot export authenticated creator provenance still need an
explicit rescue/recreation through their rightful owner; this cut never invents
creator identity or runs the live rescue scripts.

A held computer VM can no longer give a release roll priority over its pending
source recovery. An already-running roll of that exact unadmitted VM target ends
its own claim after current recovery/claim checks, leaving cleanup with the
source recovery owner. Cluster/Helm rollback behavior stays with its existing
owner. Live workspace wire tests refresh canonical fixture placement before each
request while reusing the authenticated token. This removes suite-long stale
routing; it does not eliminate a move between a lookup and its HTTP request.
Native Proactive check jobs with empty scratch are preserved as requested.

### Default config writers

Fresh shared and isolated gateway templates record the native migration decisions for
model policy, utility models, Skill Library and webhook listeners. The isolated
Doctor comparison uses native update-repair mode, which preserves optional skill
choices when a test environment lacks their prerequisites.
The isolated gateway writers remove the channel-level Mattermost endpoint and
fill missing account endpoints with the platform URL. Explicit account endpoints
are preserved. A root bot token keeps the platform URL and empty account maps
stay empty.

### Retained PostgreSQL transcript readers

A running transcript worker can retain a reader while the agent store writer
publishes a newer admission revision. Opening its repeatable-read transaction
first left the stale facts unusable and raised `Agent database has no PostgreSQL
schema admission` before the turn reached the model. The native PostgreSQL
snapshot helpers refresh admission while the connection is idle, then open the
same read-only transaction and enforce the existing revision and identity checks.
A two-thread PostgreSQL regression failed with the exact error before the fix and
passed afterward, alongside the agent store, history snapshot, and read-facts tests.
Remove the overlay when native has equivalent pre-transaction admission and the
retained-worker regression passes. Open PRs
[#190129](https://github.com/openclaw/openclaw/pull/190129),
[#193875](https://github.com/openclaw/openclaw/pull/193875),
[#197425](https://github.com/openclaw/openclaw/pull/197425), and
[#197010](https://github.com/openclaw/openclaw/pull/197010) address pool sizing,
idle connections, and separate migration behavior.

### Detached agent admission descriptors

Detach keeps the agent's database registered, and session registry maintenance
still reads registered stores. After detach fenced the database and retired its
admission descriptor, the maintenance turn's admission probe opened a new
process-lifetime identity descriptor on it. The departed agent's deleted
database then stayed open until the Gateway restarted, and a user's move back
to that shared gateway failed with "agent database files are still held open".
The overlay's probe no longer opens an identity descriptor for a path the
reader registry has fenced as deleted. Worker operation admission still does:
re-creating a returning PostgreSQL agent admits its engine anchor before the
roster revives the fence, and refusing that admission fails the return. A
gateway regression detaches an agent, runs session maintenance, lists the
process's open descriptors, then re-creates the agent and reads its history. It
found one descriptor on the detached database before the fix and none after.
Open issue [#195523](https://github.com/openclaw/openclaw/issues/195523)
reports the config-reload variant. Open PR
[#196215](https://github.com/openclaw/openclaw/pull/196215) refuses every
retention of a fenced path, which would also refuse that re-creation. Remove
the overlay when the selected base keeps no descriptor for a detached agent,
still re-admits a returning PostgreSQL agent, and the regression passes without
the overlay.

### Detach and activation-abort integration

Read-only deletion authority checks avoid write transactions while preserving live
lease admission, journal/template ownership, the final host journal fence and all
mutation transactions. Earlier integration qualification exercised authority,
cleanup and outbound custody, including the installed PostgreSQL detach CLI in
an activation-abort replay.

At this pin, Skill Workshop is a bundled plugin. Native ignores unmarked
`plugins.entries.skill-workshop` policy as stale built-in-era configuration and
refuses offline-detach writes against it. Both templates and final config writers
now declare `meta.migrations.skillWorkshopPlugin: true`. Shared retains autonomous
mode off; Builder choices survive. The retired `skills.workshop` key remains absent.
The image gate rejects the ignored-policy warning even when Native reports
`valid: true`.

The native regression `tests/specs/openclaw-workshop-native.spec.ts` checks the
pinned CLI version, validates both classes through their actual writers, reproduces
the unmarked write refusal and verifies Workshop survives Doctor plus reconciliation.
It uses `OCTOGEE_TEST_OPENCLAW_BIN`, `OCTOGEE_TEST_OPENCLAW_NPM`,
`OCTOGEE_TEST_OPENCLAW_EXTENSIONS` and a disposable `OCTOGEE_TEST_POSTGRES_DSN`.
The installed-runtime comparison and active-chat abort replay use
`gateway-supervisor/ops/prove-agent-detach.ts` and `gateway-supervisor/ops/prove-activation-abort.ts`.
These tools exercise detach and abort behavior against a disposable PostgreSQL
store and Mattermost installation. Use their output to compare runtimes and
verify preserved agent identity, history, and source write refusal.

### Qualification and publication

The clean full package build used Node 24.22.2 and pinned pnpm 12.15.0 with the
frozen lockfile. Its build-info commit matches the overlay. The build emitted
163 SDK export declarations and passed its unchanged byte budget
(5,342,779 of 5,385,536 bytes) after the worker projection reused the existing
public record types. The unchanged native checkout also passed the full build.

Overlay tests covered rebase conflicts, Gateway and Mattermost authority,
channel membership, scoped reload and strict stop, cron transfer, and Doctor
capture. The outbound custody regression reproduced a worker decoding failure
before the fix and passed afterward. Twelve PostgreSQL tests covered cold
web-secret reload and reattachment of an unchanged store through the actual CLI.
The same source produced the hosted UI islands and the platform Browser bundle.
The PostgreSQL 16.16 and pgvector 0.8.7 routine catalog was regenerated from
that source with unchanged definitions.

The frozen native tip passed the check graph's preflight, production, script
and root test typechecks. Its full-tree lint reported 24 inherited
`max-lines` diagnostics in files the overlay leaves untouched. The exact
overlay passed preflight and the production, script and root test typechecks,
as well as the native channel config and generated validator checks.
The full-tree lint then reproduced the same 24 diagnostics, with the same paths
and messages. All 418 changed source files passed scoped lint. The default
check graph stops after that lint failure. Formatting and policy passed in
separate native runs.

The retained-state pin-roll passed from `e9c9cd30` on disposable PostgreSQL
using the installed old and new CLIs and a non-superuser role. The platform
artifact, image and provenance specifications passed.

Both archives were packed sequentially from the clean build. The root integrity
check, source-matched installed Mattermost, Codex and Parallel payloads, and all
25 patched npm distribution controls on staged, independent global and nested
installed npm passed. The Linux AMD64
[full plugin installer](https://console.cloud.google.com/cloud-build/builds/e3a0267c-2e55-4593-bd4c-54fed9e24390)
passed CUA artifact validation, native registry refresh, bundled trust and
source matching, and the three native hook imports.

Both GCS objects use generation-zero creation. Readback verified each exact
generation and full SHA-256. The
[GitHub release mirror](https://github.com/ceckert/openclaw/releases/tag/gateway-0e76ab9-20261120)
uses the same names and verified hashes.

| Object | Generation | SHA-256 |
| --- | --- | --- |
| `openclaw-fork-1a6e9fb7.tgz` | `1795185515169334` | `1a6e9fb7183c9648c97cd54652f2d067a6f2206d75c4dfcdceca541681330fcb` |
| `openclaw-mattermost-0345afcf.tgz` | `1795185528492879` | `0345afcf3b952cffb22c5f8c370cb191ea5972c9bfe81eb9bb68187a60d56894` |

### Upstream contributions

#189036, #191463, #193596, #193875 and #197425 are merged into the frozen
upstream tip. Remaining contributions include #189418 for native direct-attempt
steering, #186891 and #186893 for Mattermost parity, #193636 for the first
accepted config baseline, #167431 for reload custody and #178755 for retained
agent reattachment. #197010 was closed without merge.

## Native CUA desktop discovery

The official [CUA 0.38.0 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.38.0)
at `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19` includes
[the desktop-discovery contribution](https://github.com/trycua/cua/pull/5368).
Its native owner dispatches Wayland/X11 discovery, excludes off-screen windows
and known dead owners, remembers observed Wayland origins, and emits canonical
window records. Unknown-owner visible windows remain discoverable without
inventing process identity. The upstream regression covers these same boundaries.

Octogee therefore removes its Rust builder, discovery patch, SDK replacement,
and artifact-manifest rewriting. OpenClaw installs the official matched JavaScript
and native packages and owns their exact artifact hashes. The base image still
runs `openclaw doctor --lint --only cua-computer/driver-artifacts` before either
Gateway class is assembled. A version match alone does not qualify the library.
The JavaScript SDK and declarations are byte-identical to 0.37.0; its package
manifest advances the SDK and all six platform companions together.

Source adoption and installer fixtures do not prove a working desktop session.
This cut verifies dynamic loading from the actual installed 0.38.0 package on
the pinned Debian/Node runtime as recorded above. Real desktop acceptance remains
a deployment check; prior patched 0.37.0 results do not qualify the new library.

## Vendored computer-use skills

`gateway/cua-skills/` holds the `cua-driver` skill adapted from CUA's
0.38.0 skill pack
([`85e2b131`](https://github.com/trycua/cua/tree/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/Skills/cua-driver))
and the `cua-omarchy` companion from Omarchy
[PR #11342](https://github.com/omacom/omarchy/pull/11342) at `94e97055`.
`provenance.json` records each repository, commit, and the SHA-256 of every
upstream file used for the adaptation. The runtime image installs them to
`/opt/octogee/skills/computer` with `install-cua-skills.mjs`, which requires
matching installed JavaScript, native-package and OpenClaw plugin versions,
the official release's source identity, pinned skill sources and listed files.
Native artifact verification remains with OpenClaw; there is no locally invented
patch receipt. No skill source is fetched at build or run time.

The adaptation keeps the loop, targeting, delivery, verification, and refusal
guidance and maps it onto the `computer` tool. It omits standalone CLI/MCP
transport, installation, self-update, permission profiles, approval-bypass flags,
cursor overlay, recording, embedding, macOS, Windows, and Omarchy package/plugin
management. CUA's browser guide is replaced by the `browser` tool. The 0.38.0
upstream skill differs from 0.37.0 only in its version; `LINUX.md` is unchanged.
The Hobby X11 skill carries the same driver version.

When the driver version changes, diff its official skills against the recorded
digests, carry forward the applicable guidance, and update the release/source
mapping and `provenance.json` together.

## What the packers do

`pack-fork-tarball.sh` produces an installable root package. It runs upstream's
prepared-artifact lifecycle before vendoring, including install inventories,
the pending-install marker, and manifest sanitation. It restores temporary
manifest, changelog, and docs-map changes after packing, including pack failures.
It vendors root
`workspace:*` dependencies and always compiles Codex/Parallel companions from
the same checkout, independently of npm publication status.

Image assembly installs Parallel into the host's bundled plugin tree and sets
its native `openclaw.build.bundledDist` declaration to `true`. Source-match
verification permits only that distribution-ownership metadata change; all
other package fields, runtime files and the plugin manifest must match the
packed companion. OpenClaw's Doctor then owns retiring an obsolete exact-package
npm install record and certifying any retained upgrade obligation. Discovery
as `origin=bundled` alone does not transfer that repair ownership.

`pack-mattermost-tarball.sh` runs OpenClaw's plugin packer and verifies compiled
runtime output. Mattermost stays separate so its exact native channel runtime
is content-addressed independently from the root package.

Use `pnpm build`, not `pnpm run build:docker`: the full build creates every
compiled file needed by `npm pack`.
