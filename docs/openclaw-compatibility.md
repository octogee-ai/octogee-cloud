# OpenClaw compatibility

## Where things stand

`install.sh` starts one gateway, with chat and git, from the stock OpenClaw
release image and the stock Mattermost Team Edition image. Stock images are
enough for that.

The fleet image supports many users on shared gateways, isolated gateways and
moves between them. It builds from a selected OpenClaw main snapshot with a
public overlay in `ceckert/openclaw`. The [overlay assessment](../gateway/openclaw-tarball/README.md)
records the current upstream and overlay commits. The
[package pin](../gateway/openclaw-tarball/current.json) names the release that
supplies the packages. The goal is to carry no patches.

Every recut starts from the question "does upstream already do this?". A patch
stays only for a reproduced bug or a behavior the platform depends on, and each
one has a written removal condition. Fixes that upstream accepted are dropped
from the overlay once the selected base contains them. So far 22 of our
pull requests have been merged upstream and many former patches are gone.

For an operator this means two things. You can read every patch, because the
overlay is public and each family is listed below. And you should expect the
fleet features to fail in the ways the tables describe on a stock gateway
image, most visibly when users move between gateways.

## What octogee-cloud needs from OpenClaw

These families support features the platform depends on. The table reflects
the November 16, 2026 refresh. "No pull request" means the fix exists only in
the overlay.

| Capability | octogee-cloud feature | On stock OpenClaw | Upstream | The patch can go when |
| --- | --- | --- | --- | --- |
| Detach an agent and reattach it on another gateway, keeping its PostgreSQL store, identity and history | Moving a user between a shared and an isolated gateway | No public transfer that keeps store identity and history; a move would recreate the agent | [#178755](https://github.com/openclaw/openclaw/pull/178755), open, needs PostgreSQL reattachment work and review. Empty recreation of retained stores ([#188350](https://github.com/openclaw/openclaw/pull/188350)) and keeping a held store apart until it is restored ([#198180](https://github.com/openclaw/openclaw/pull/198180)) are now native, both merged | Native transfer keeps namespace, history and rollback custody |
| Keep no descriptor on a detached agent's database | Moving a user back to a shared gateway they left | Session maintenance reopens the departed agent's database and holds it until restart, so the return can fail as "still held open" | Issue [#195523](https://github.com/openclaw/openclaw/issues/195523) (config-reload variant), open; [#196215](https://github.com/openclaw/openclaw/pull/196215), open, refuses every retention and would also refuse re-creating a returning PostgreSQL agent | The selected base keeps no descriptor for a detached agent and still re-admits a returning one |
| Recreate an agent during a live import onto a reused home | Moving a user back to an isolated gateway | `agents.create` fails in config preflight when the retained store is replaced | No pull request | The selected base carries an equivalent fix |
| Refuse to retire an agent while it has unfinished outbound deliveries | Pending deliveries survive a move | Queued replies can be lost or sent from the wrong gateway | No dedicated pull request; related fix [#163685](https://github.com/openclaw/openclaw/pull/163685) merged | Native detach and deletion fence the same queue |
| Hand over scheduled jobs with hold, export, activation, rollback and drain | Schedules move once and only once | Plain cron create and delete; no two-gateway handoff | No pull request | Native migration offers equivalent activation, rollback and drain |
| Admit only recognized older schedule and state formats when restoring | Moving users whose data predates the current schema | Unknown partial schemas could be admitted | No pull request | Those retained input formats are retired |
| Reload only the account that changed; leave siblings running | Adding or removing a user on a shared gateway | Unrelated accounts drain and reconnect | [#167431](https://github.com/openclaw/openclaw/pull/167431), open, needs maintainer security approval | Native scoped reload passes the same controls |
| Strict channel stop that joins startup and cleanup and retires only removed accounts | Removing a user from a shared gateway | A hung startup or late stop can leave work running or stop a sibling | No dedicated pull request; part of the [#167431](https://github.com/openclaw/openclaw/pull/167431) area | Native proves hung-startup joins and sibling preservation |
| Shared worker and lifecycle lease retirement with one visible deadline | Many agents on one gateway; agent removal | A failed concurrent admission can strand a shared worker and block secret reloads | No pull request | Native keeps serving leases through failed admission and refuses late authorization |
| Channel membership as an authoritative, revocable grant | Chat-channel access on a shared gateway | Native filters invite-only and linked sessions but has no authoritative empty-set sync or revocation for this policy | No pull request; native [#194791](https://github.com/openclaw/openclaw/pull/194791) (merged) covers part | Native membership methods give equivalent revocation |
| One session per Mattermost channel that keeps reply threads | Chat-channel semantics on a shared gateway | Thread-scoped sessions only | No pull request | Native supports the option, or the platform adopts thread sessions |
| Requester identity carried through queued work, one approval reviewer, and a separate verified creator for scheduled runs | Knowing who asked for an action when approvals are involved | Requester facts can be lost across queued or held continuations | No pull request; earlier fix [#159396](https://github.com/openclaw/openclaw/pull/159396) merged | Native propagation passes delayed-continuation controls and exposes a verified job creator |
| PostgreSQL startup during backup recovery | PostgreSQL agent stores; isolated gateways booting on a retained home | Startup fails during recovery | [#193596](https://github.com/openclaw/openclaw/pull/193596), open, awaiting maintainer CI approval | Merged into the selected base |
| Offline config reduction kept across restart (`config patch --allow-size-drop`) and a first-write health baseline | Preparing an isolated gateway before it serves | Recovery restores the larger backup config | [#193636](https://github.com/openclaw/openclaw/pull/193636), open, draft | Merged, or the public option is decided another way |
| Reconnect idle PostgreSQL connections after a host suspension | Suspending and resuming an isolated gateway's VM | The first request after resume fails | [#193875](https://github.com/openclaw/openclaw/pull/193875), open | Merged into the selected base |
| Upgrade a PostgreSQL state store created before upstream added a column to schema 39 without a migration | Moving a gateway to a newer OpenClaw build while keeping its PostgreSQL state | The native schema 40 migration still expects the column. The overlay repairs the exact predecessor before native admission | [#197425](https://github.com/openclaw/openclaw/pull/197425), open | The selected base upgrades both schema 39 shapes and the installed pin-roll passes |
| Read the web-secret index through the async PostgreSQL reader | PostgreSQL agent stores | `secrets.reload` fails on a cold store | No pull request | Native awaits the worker-backed reader |
| Republish a deferred agent's model after a concurrent refresh | Creating agents while the gateway reloads | The agent stays connected but cannot reply | No pull request | The selected base carries an equivalent fix |

## Patches that are not platform requirements

| Family | Why it exists | Upstream |
| --- | --- | --- |
| Voice relay and desktop control limits | Hosted voice and desktop features | Steering fixes [#189036](https://github.com/openclaw/openclaw/pull/189036) and [#189418](https://github.com/openclaw/openclaw/pull/189418), open |
| Mattermost message actions, multi-file sends, acknowledgement reactions, channel events, compact tool progress | Richer chat in the hosted product | [#186893](https://github.com/openclaw/openclaw/pull/186893) and [#186891](https://github.com/openclaw/openclaw/pull/186891), open |
| Final-reply notification flag | Activity view in the hosted app | No pull request |
| Dashboard participant labels | Shows who said what in the embedded dashboard | No pull request |
| `doctor --skip-recovery-backups` | Store import and upgrade paths that already keep their own backups | No pull request |
| SQLite worker path and config reload failure diagnostics | Name the path behind a non-regular database file, and log a failed reload's stack and cause | No pull request |
| npm 12.2.1 distribution patch | Packaging: dependency fixes that upstream npm does not ship yet | Not an OpenClaw change |
| Generated schemas and test support | Describe the retained APIs above | Go with their features |

[#191463](https://github.com/openclaw/openclaw/pull/191463) (agent removal
latency, open) is a contribution, not a carried patch.

## Mattermost

octogee-cloud installs the stock Mattermost Team Edition image. A stock install
lives with two limits.

- **Concurrent thread replies.** Replies sent to the same root post at the same
  moment can fail or leave reply counts and participants wrong. Upstream issue
  [mattermost/mattermost#31650](https://github.com/mattermost/mattermost/issues/31650)
  is open, and the proposed fix
  [mattermost/mattermost#33825](https://github.com/mattermost/mattermost/pull/33825)
  is open. Agents reply often, so this shows up more than in human chat.
- **User limit without a license.** Mattermost's
  [editions page](https://docs.mattermost.com/product-overview/editions-and-offerings)
  says Team Edition is for use under 250 activated users, and its
  [error codes page](https://docs.mattermost.com/administration-guide/manage/admin/error-codes.html)
  describes the safety-limit error. In the
  [v12.0.1 source](https://github.com/mattermost/mattermost/blob/v12.0.1/server/channels/app/limits.go),
  an unlicensed server has a hard limit of 250 and counts active users with
  default options, which exclude bots and deactivated accounts. The limit is
  server-wide. Each agent is a bot, so the limit counts people. At the limit, the
  same source refuses to create or reactivate user accounts. octogee-cloud does not work
  around it: an operator expecting more people needs a Mattermost license.

## How to check this yourself

Read the frozen upstream and overlay commits in the
[overlay assessment](../gateway/openclaw-tarball/README.md) and diff them to
inspect the changes. The
[package pin](../gateway/openclaw-tarball/current.json) records the fork,
release tag and full SHA-256 hashes. The assessment lists the retained
patches, their removal conditions, and the state of open contributions.
The table above classifies each family by the platform feature it serves.

## What we have not done

- No end-to-end run of the fleet features on a stock OpenClaw release, so we
  cannot say exactly what breaks first.
- Some classifications are judgment calls: the legacy-format restore row, the
  deferred model republish row, the delivery-custody and strict-stop rows (whose
  upstream links are related work, not the same change), and the scheduled-run
  creator, which mainly serves a product connector.
- Several removal conditions need upstream to adopt a behavior it may not want,
  such as one session per channel or authoritative membership sync. Where that
  happens, we expect to change octogee-cloud rather than keep the patch.
