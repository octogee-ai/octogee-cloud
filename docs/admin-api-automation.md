# Admin API routes for automation

The fleet controller makes no decision about when to add, drain or retire a
shared gateway. A program that does, such as a product's own controller, is an
Admin API client like `octogee-fleet`. It sends an OIDC ID token whose
verified email is in the fleet controller's `fleetIdentity.operatorEmails`.
The [`octogee-fleet` Admin API contract](https://github.com/octogee-ai/octogee-fleet/blob/main/docs/admin-api.md)
covers identity, errors, `Idempotency-Key` and `dryRun`, which apply here too.

Every route below that changes state writes an operations-journal audit under
the caller's identity. A route that finds its precondition no longer holds
writes nothing else and answers `409` with `"code": "precondition-failed"`.
The client reads the fleet again and decides afresh.

## Shared gateway automation state

The fleet controller keeps one record for shared gateway automation: an
`actionSequence`, the time of the last action, and the replacements in
progress, each `{sourceGatewayId, targetGatewayId, updatedAt}`. It stores the
record and never reads it to decide anything. A change carries
`automationState: {expectedSequence, replacements}`; the change applies only
while the stored sequence equals `expectedSequence` (`null` when no record
exists), and it writes the sequence plus one and the given replacements in the
same transaction.

Shared gateways that automation adds are recorded as added by automation, and
the routes below act only on those.

## `GET /fleet/state`

One consistent read of the fleet:

```json
{
  "generatedAt": 1794268800000,
  "fleetControllerStartedAt": 1794268000000,
  "platformArtifactHash": "<hash of the platform gateway build>",
  "config": {
    "sharedGatewayAutoscaling": { "enabled": true, "buildersPerGateway": 10, "minGateways": 1, "maxGateways": 32 },
    "sizingProfiles": {},
    "disposableGatewayIdleMs": null
  },
  "sharedPoolAutomation": { "actionSequence": 4, "lastActionAt": 1794268800000, "replacements": [] },
  "users": [],
  "gateways": [],
  "latestReleasePayloadHashes": { "shared-a": "<hash>" },
  "platformCurrentSharedGatewayIds": ["shared-a"],
  "assignments": [],
  "runtimes": [],
  "operations": []
}
```

`config.sharedGatewayAutoscaling` is `null` when the stored dial is malformed.
Its `minGateways` and `maxGateways` are the shared pool's floor and ceiling for
the automation that sizes the pool; the platform stores them and enforces no
pool size.
`operations` holds the operations in the statuses named by
`?operationStatus=` (default `pending,running`). `latestReleasePayloadHashes`
covers shared gateways only and is `null` for one whose latest release has no
readable payload. `platformCurrentSharedGatewayIds` contains gateways with the exact
platform release and those verified to run equivalent Shared software and configuration.
For a build-tag change, verification requires matching immutable gateway and edge
images, OpenClaw source, installed intent, override bytes and the complete rendered
manifest at the deployed Helm revision. Without that proof, rollout follows the normal
replacement path. The durable release hashes retain their original values.
Each user carries only `uid`, `slug`, `admitted`,
`accountLifecycle`, `provisioning.status`, `gateway.gatewayId`,
`openclaw.managedBy` and its restore and source-transfer fences.

### Selecting sections

`?sections=` names the sections to answer, comma-separated, from `config`,
`sharedPoolAutomation`, `users`, `gateways`, `releases`, `assignments`,
`runtimes`, `operations`, `migrations` and `placementAutomation`. Without it the answer is the one
above, unchanged. With it the answer always carries `generatedAt`,
`fleetControllerStartedAt` and `sections` (the selection in the order listed
here), then each selected section, all from one read-only transaction that
reads only the records those sections need. An unknown or empty name, or a
repeated `sections` parameter, answers `400`.

```json
{
  "generatedAt": 1794268800000,
  "fleetControllerStartedAt": 1794268000000,
  "sections": ["users", "gateways", "releases", "migrations"],
  "users": [],
  "gateways": [],
  "platformArtifactHash": "<hash>",
  "latestReleasePayloadHashes": { "shared-a": "<hash>" },
  "platformCurrentSharedGatewayIds": ["shared-a"],
  "migrations": []
}
```

- `config`, `sharedPoolAutomation`, `assignments`, `runtimes` and `operations`
  are the fields of the same name above; `operations` still follows
  `?operationStatus=`.
- `users`: each user carries the fields above, plus what placement reads:
  - `provisioning.startedAt`
  - `openclaw.status`
  - `gateway`: the full gateway mirror (`gatewayId`, `gatewayAssignedAt`,
    `gatewayProfile`, `controlUiEnabled`), or `null`
  - `activationLease`: the stored lease (`leaseId`, `generation`, `status`,
    `targetGatewayId`, `sourceGatewayId`, `sourceAssignmentEpoch`,
    `lastActiveAt`), or `null`
  - `fences`: every fence the user holds (`restoreFence`,
    `sourceTransferFence`, `computerRecovery`, `migration`,
    `pendingNativeSchedulerRetirement`, `runtimeReset`)
  - `home`: the user's home record (`computer`, `homeCheckpoint`, `homeDisk`,
    `homeStorage`, `homeMigration`, `homeErasure`, `homeCapacity`,
    `projectStorageNativeBoot`), each present only when stored
- `gateways`: each gateway root, plus its Kubernetes reading:
  ```json
  {
    "kubernetes": { "status": "ready", "totalPods": 1, "readyPods": 1, "ageMs": 30000 },
    "kubernetesObservedAt": 1794268770000
  }
  ```
  `status` is `ready`, `not-ready`, `missing` or `unknown`. The fleet
  controller observes every gateway's pods and stores the result on the
  runtime, rewriting it at least every two minutes. A stored observation older
  than four minutes is reported as `unknown` with its `ageMs` and
  `kubernetesObservedAt` kept, and its pod counts `null`. A gateway with no
  runtime, no observation, a malformed one or one stamped in the future is
  `unknown` with `ageMs` and `kubernetesObservedAt` `null`. The reading is never
  inferred from anything else.
- `releases` includes the three release fields described above. Without a platform
  artifact, `platformCurrentSharedGatewayIds` is empty.
- `migrations`: the `migrate-user` operations that are `pending` or
  `running`, whatever `?operationStatus=` says. Each carries
  `sourceRecoveryPending` (see [Source recovery](#source-recovery)).

### Source recovery

`sourceRecoveryPending` is `true` while the operation runner still owns the
source side of a `migrate-user` operation: it may yet resume, roll back or
recover the user on the source gateway, so the target must not be retired and
the lease must not be failed. It is derived from the stored operation alone,
by the same function the fleet controller's own placement pass reads. It is
`true` when either holds:

- the operation is the activation operation of an activation lease
  (`builder-activate-<gateway>-g<generation>`, source
  `builder-activation-lease`, from a shared gateway, scheduler handoff staged
  after cutover), with no cutover committed, not rolled back, and `pending`,
  `running`, or `failed` after an attempt that held, or may have held, the
  source (a source-only recovery, a forward recovery checkpoint, or attempt
  evidence that is missing or includes `quiesce-source`);
- or the operation is `pending`, `running` or `failed` with a complete
  scheduler handoff that has not been released (`schedulerHandoffReleased`
  is `false`).

The `migrations` section lists only `pending` and `running` operations. A
failed activation still recovering its source is read with
`GET /operations/<id>` or `GET /operations/lookup`, which carry the same
field on every `migrate-user` operation, in every status.

**For client authors:** an absent `sourceRecoveryPending` means unknown, and
the client withholds the cleanup it guards, exactly as for `true`. Only an
explicit `false` lets it proceed. An older server does not send the field.

The read can be stale, so the verbs check it again inside their own
transaction, against the activation operation
`builder-activate-<gateway>-g<generation>` of the lease or allocation they
act on. The check is deliberately stricter than the fleet controller's own
placement pass, which holds off only its cleanup of a failed activation: the
verbs refuse every reason.

- `activation-lease/fail` whose `operationId` is that activation operation is
  refused whenever its source recovery is pending.
- `retire-owned` with any reason (including the `parked-computer-replaced`
  retirement that `allocate` makes of an obsolete parked gateway) is refused
  while the activation is `failed` and its source recovery is pending. While
  the activation is `pending` or `running`, first attempt or re-armed
  recovery, `retire-owned` is refused earlier by the in-flight migration
  fence, with `reasonCode` `retirement-blocked` (`user migration is in
  flight for gateway <gateway>`).
- `activation-lease/fail` for another cause and `recover-unreachable` are
  refused while the activation's source recovery is pending and the
  activation is `failed`, or is a re-armed source-only recovery
  (`recoverSourceOnly`) that is `pending` or `running`: that recovery could
  still be paused under it. While a first attempt is `pending` or `running`
  they are admitted.

A refusal answers `409` `precondition-failed` with `reasonCode`
`source-recovery-pending`, dry runs included.

#### A failed activation that cannot recover

For a failed activation, `sourceRecoveryPending` clears only when the
operation is rolled back, commits its cutover, moves to the v2 migration
record, or is re-armed and that recovery finishes. The scheduler release loop
skips these operations, and the fleet controller re-arms one only while it
still owns the source and the target still matches the lease. A failed
activation that can no longer be re-armed keeps the verdict `true`, and every
verb above stays refused for that gateway and generation.

The fleet controller logs this once per operation revision, at warning
level:

```text
[migration-recovery] ⚠ <operation> failed while holding its source and its source recovery cannot be re-armed; sourceRecoveryPending stays true and isolated placement verbs for <gateway> answer source-recovery-pending
```

`GET /operations/<operation>` shows it as a `failed` `migrate-user`
operation with `sourceRecoveryPending: true`. The escape is an operator
retirement of the gateway, `DELETE /gateways/<gateway>`, which does not run
this check. The Admin API has no route that marks an operation rolled back.

## Operation reads

`GET /operations/<id>` answers `{operation}` or `404`. `GET /operations/lookup`
reads up to 200 operations in one request, named as a comma-separated `ids`:

```
GET /operations/lookup?ids=builder-activate-alice-xs-12345678-g3,builder-return-alice-xs-12345678-g3
```

It answers `{operations, missing, generatedAt}`: `operations` holds each
operation that exists, in the order asked, in the shape `GET /operations/<id>`
answers, with `actorEmail` resolved in one account lookup for the batch;
`missing` lists the ids with no operation. It reads operations only, not
audit records. `ids` must be given once and hold 1 to 200 distinct non-empty
ids. Otherwise the call answers `400` with an `error` naming the problem:
`ids` missing, given twice, empty or holding an empty id, repeating an id, or
holding more than 200. It counts as one request against the per-caller limit
of 300 requests a minute.

The request line and headers together must fit the server's 16 KiB header
limit (the Node.js default); a longer request is refused with `431` before
the route runs. The bound of 200 assumes ids of about 45 characters, the
length of the activation and return operation ids, about 9 KiB of query. A
client asking for longer ids sends fewer per request.

A refused precondition answers `409` and is logged as the warning
`fleet mutation refused`, with its failed audit entry kept.

## `POST /shared-gateways`

Adds a running shared gateway on the fleet controller's platform build and
enqueues its `add-gateway` operation.

```json
{ "gatewayId": "shared-0123456789ab", "reason": "platform-replacement", "replacesGatewayId": "shared-a", "automationState": {} }
```

`reason` is `minimum-replicas`, `scale-out` or `platform-replacement`;
`replacesGatewayId` goes with the last only, and must name a shared gateway
automation added. `gatewayId` is optional. Answers `202` with `gatewayId`,
`operationId` and `automationSequence`.

The add verb creates a shared gateway whenever its preconditions hold. The
platform enforces no pool size: a client is responsible for its own floor and
ceiling. Each add advances the automation sequence, so concurrent or replayed
adds from one read fail closed, but a client that keeps re-reading and adding
grows the pool until its own ceiling stops it.

## `POST /shared-gateways/<gateway>/desired-status`

```json
{ "decision": "begin-drain", "expectedUpdatedAt": 1794268800000, "expectedAssignmentCount": 3, "automationState": {} }
```

`begin-drain` moves a running gateway to draining, `resume-member` a draining
one back to running, and `supersede-replacement` a running or draining one to
running. The gateway's `updatedAt` must be unchanged and, when
`expectedAssignmentCount` is given, its assignment count must match. Journals
operation `shared-pool-scale-<sequence>`.

## `POST /shared-gateways/<gateway>/retire`

```json
{ "expectedAutomationSequence": 4, "expectedUpdatedAt": 1794268800000, "expectedAssignmentCount": 0 }
```

Claims the retirement as `DELETE /gateways/<gateway>` does, with operation
`shared-pool-retire-<gateway>`, after the same checks as `desired-status`.

## `POST /shared-gateways/replacements/<source>/finish`

```json
{ "departedGatewayId": "shared-a", "expectedAutomationSequence": 4 }
```

Drops the replacement of `<source>` once the departed gateway's record is
gone.

## `POST /shared-gateways/<gateway>/add-operations/<operation>/complete`

Marks a running `add-gateway` operation that automation started as succeeded,
when the gateway runs its desired release and its runtime serves it, ready, on
the image the operation added, and the operation was claimed before the
running fleet controller started. This finishes an add whose worker stopped
with a previous fleet controller; an add the running controller claimed stays
with its worker.

## Retired isolated gateways

An isolated gateway allocated to a user keeps its record after its
retirement until a client deletes it. The fleet controller never decides that
on its own.

### `GET /isolated-gateways/retired`

One read-only transaction over every retired isolated gateway that carries an
allocation:

```json
{
  "gateways": [{
    "gatewayId": "alice-xs-12345678",
    "ownerUid": "uid-alice",
    "allocationGeneration": 1,
    "retirementOperation": { "id": "placement-retire-uid-alice-alice-xs-12345678-g1", "kind": "retire-gateway", "status": "succeeded", "placementRetirement": true, "failedRetryably": false },
    "unreleasedHandoffOperationId": null,
    "ownerGatewayId": "shared-a",
    "activationLeases": [{ "uid": "uid-bob", "status": "parked" }]
  }]
}
```

`retirementOperation` is the operation that holds the retirement claim, or
`null` when it is gone. `placementRetirement` says whether that is the
placement retirement of this owner and generation, the only one the verbs
below act on. `failedRetryably` is the fleet controller's own classification:
the stuck-operation reaper failed it, or it failed only because the stopped
gateway's agent-store database sessions were still draining.
`unreleasedHandoffOperationId` names the activation or return operation of
this generation whose scheduler handoff is not released. `ownerGatewayId` is
the gateway the owner's record points at, and `activationLeases` lists every
user whose activation lease targets the gateway, with its status. With no
retired isolated gateway the read touches the gateway roots only.

### `POST /isolated-gateways/<gateway>/retirement/rearm`

```json
{ "ownerUid": "uid-alice", "allocationGeneration": 1 }
```

Returns a placement retirement that failed retryably to `pending`, clearing
its attempt, so the operation runner drives it again. In one transaction it
checks that the gateway is retired, owned by `ownerUid`, an isolated
allocation of `allocationGeneration`, that its retirement claim is the
placement retirement and that operation exists, that the owner's record no
longer points at the gateway, and that the operation failed retryably.

### `POST /isolated-gateways/<gateway>/delete-retired`

Same body. After the same checks, with the retirement `succeeded`, no
unreleased scheduler handoff, and no user holding a `requested`,
`provisioning`, `activating`, `active` or `returning` activation lease on the
gateway, it clears a failed activation preparation of
that generation from the owner, deletes the gateway's recovery operation and
receipt, and deletes the root with its releases, fenced on the
`retirementVersion` it read. These are separate writes, as before the verb
existed. The root delete runs in its own transaction, which checks again that
no user holds a live activation lease on the gateway. A root whose retirement
changed after the checks, or that a live lease now targets, answers `409` and
stays, and a failed write answers `500` and leaves the root for the next
call. The retirement and activation journals stay.

## Placement automation

These verbs carry out the placement steps for users who already have an
assignment, and the shared pool steps. The client decides which step to take
and when. Each verb checks its facts again inside the transaction that writes
it, and uses the operation id and `createdBy` that the fleet controller's own
pass uses. A repeat, whether from the client or from the fleet controller's
pass, is therefore answered with `already-committed`, `already-enqueued`,
`already-scheduled` or `already-superseded` and writes nothing new.

### Who may act

The orchestrator config holds `placementAutomationOwner`. It is
`fleet-controller` by default, or `client`. It also holds
`placementAutomationYieldedAt`, which the fleet controller writes when it sees
`client` and stops its own pass. Every verb below checks both fields in its
write transaction. Unless the owner is `client` and the yield is written, the
verb answers `409 {"code": "placement-owner"}` and writes nothing. Until the
switch is flipped, every verb answers this way. The client keeps reading
`/fleet/state` and acts only after it sees the yield. Each verb also checks the
owner in a read-only transaction before it reads Kubernetes or anything else,
so while the fleet controller owns placement no verb makes a Kubernetes call.
A yield can only be
stored while the owner is `client`, so handing placement back to the fleet
controller clears the yield in the same write.

### Handing placement over and back

The operator sets the owner with the Admin API alone:

- `GET /placement-automation` answers `{owner, yieldedAt, phase}`. The
  `placementAutomation` section of `/fleet/state` answers the same object.
- `POST /placement-automation/owner` with `{"owner": "client"}` or
  `{"owner": "fleet-controller"}` sets it, journals the request and answers the
  same object. Setting the current owner writes nothing and answers success.
  It takes `?dryRun=true` and an `Idempotency-Key` like every other verb.

`phase` is the handoff state:

| `phase` | Stored | Who acts |
|---|---|---|
| `fleet-controller` | owner `fleet-controller`, no yield | The fleet controller's pass. Every verb answers `placement-owner`. |
| `handoff-pending` | owner `client`, no yield | No one decides. A pass that started before the switch finishes and may still commit; every verb answers `placement-owner`. |
| `client` | owner `client`, yield written | The client. The fleet controller's pass decides nothing and each of its placement writes is refused. |

Setting `client` clears any yield, so the client acts only after a fresh one.
The fleet controller reads the owner at the start of each pass. The first pass
that sees `client` while no other pass of that fleet controller is running
writes `placementAutomationYieldedAt` and decides nothing. A restarted fleet
controller yields on its first pass. Setting `fleet-controller` stores the owner
and clears the yield in one write: every verb answers `placement-owner` from
then on, and the next pass decides again. Every placement write checks the
owner inside its own serializable transaction, so a write that raced a switch
either committed before it or is refused; none is half-applied. A write that
read the owner before the yield and touches nothing a client verb read
afterwards commits, serialized ahead of the yield; one that conflicts with a
client verb is aborted, retried and refused.

Every exported transaction that writes placement state takes the owner check
it asserts as a required argument: the verbs pass the client's, in-process
callers the fleet controller's.

First placement of a user with no assignment and no lease stays with the
fleet controller after the yield, by design; the client acts only on users
with an assignment.

A hung in-process pass blocks the yield until the fleet controller restarts.
It shows as the stuck-handoff error, which names the running passes, and as
`glm_placement_automation_handoff_pending_observations` climbing.

Hand placement back to the fleet controller before rolling the fleet
controller back to a build that predates the gate: an older build ignores the
owner and keeps deciding while the client acts.

A migration the fleet controller enqueued before it yielded keeps running; the
operation worker finishes it whoever owns placement. The client sees it in the
`migrations` and `operations` sections, and a request for the same operation
answers `already-enqueued`.

The fleet controller logs every owner or yield change it observes, exports
`glm_placement_automation_owner{owner,phase}`,
`glm_placement_automation_yielded_timestamp_seconds` and
`glm_placement_automation_handoff_pending_observations`, and logs an error when
a handoff stays pending for 8 observations (two minutes) and every 8 after.
When no pass has run through the gate since the switch, the error says so:
the installed in-process pass does not call the gate and cannot yield.

### What a 409 means

| `code` | Meaning | What the client does |
|---|---|---|
| `placement-owner` | The client does not own placement, or the fleet controller has not yielded. | It does not act. It reads the switch and the yield again on its next tick. |
| `precondition-failed` | A fact the client acted on has changed, such as an epoch, a release, the pool, a lease or the target's load. `error` names it for people; `reasonCode` names the cause for machines. | It logs the refusal and decides again from a fresh read on its next tick. It never retries within the same tick. |
| `observation-unknown` | The fleet controller's live read of the gateway's pods failed, or returned no status, an `unknown` status or a malformed one. `error` names the read failure when there was one. Nothing changed. | It tries again on a later tick. |

Every `precondition-failed` from a placement verb carries `reasonCode`, one
of the values below; a new cause gets a new value. `error` stays the
human-readable message, and the isolated verbs keep it in `reason` too. A
client treats an absent `reasonCode` as an unclassified refusal. The values
are a contract: `core/src/placement-refusal.spec.ts` pins them and checks
this table against them.

| `reasonCode` | Cause | Verbs |
|---|---|---|
| `migration-terminal` | The migration operation ended and cannot be re-armed. | `placement-migrations` |
| `user-held` | An operator holds the user. | `placement-migrations` |
| `shared-drain-superseded` | The shared drain no longer authorizes the migration. | `placement-migrations` |
| `migration-authority` | Another placement authority check failed, such as another pending migration of the user or a slug mismatch. | `placement-migrations` |
| `target-capacity` | The target has more users assigned or arriving than `expectedTargetUsersAtMost`. | `recover`, `placement-migrations` |
| `shared-pool-unconfigured` | The shared gateway pool is not configured. | shared verbs |
| `target-not-shared` | The target is not in the shared gateway pool. | `recover`, `runtime-reset` |
| `source-not-proven-unavailable` | The source is ready, has a fresh heartbeat, still has pods, is in an active roll, or changed too recently. | `recover` |
| `assignment-changed` | The operation id does not match the user's current source assignment. | `placement-migrations` |
| `roll-not-eligible` | The roll recovery is not eligible. | `roll-recovery` |
| `drain-move-not-supersedable` | The drain move cannot be superseded. | `supersede` |
| `fleet-state-changed` | A fleet state fence changed, such as a source epoch, a target heartbeat or a previous recovery. | `recover`, `runtime-reset`, `restore-serving` |
| `fence-mismatch` | A stored record changed under the verb's fence. | all |
| `source-recovery-pending` | The activation operation is still recovering its source. | `retire-owned`, `activation-lease/fail`, `recover-unreachable`, `isolated-gateway/allocate` |
| `user-missing` | The user does not exist. | isolated verbs, `restore-serving` |
| `user-slug-missing` | The user has no slug. | `isolated-gateway/allocate` |
| `lease-missing` | The user has no activation lease. | `activation-lease/complete` |
| `gateway-not-owned` | The gateway is not owned by the user. | `retire-owned`, `recover-unreachable` |
| `retirement-blocked` | A retirement fence failed; `error` says which. | `retire-owned` |
| `isolated-fence` | A lease or isolated gateway fence changed. | isolated verbs |
| `retirement-conflict` | A retirement claim or an in-flight migration blocks the change. | isolated verbs |
| `sizing-key-changed` | The user's sizing key changed during the call. | isolated verbs |
| `initial-release-conflict` | The gateway's initial release conflicts. | `isolated-gateway/allocate` |
| `source-not-stranded` | The user has no quiescing assignment left by a failed move of that user out of that gateway. | `restore-serving` |
| `migration-in-flight` | The move that closed the source is pending or running again, or another operation for the user or for the source gateway is pending or running. | `restore-serving` |
| `rollback-not-proven` | The failed move committed its cutover, holds forward state, its recorded steps do not show the target unmounted and only the source ingress left to resume, or an earlier attempt did not finish its rollback. | `restore-serving` |
| `account-not-active` | The user's account is suspended, scheduled for deletion or being erased, so the user is not served. | `restore-serving` |
| `source-gateway-retired` | The source gateway has no root or its desired status is `retired`; its ingress cannot be resumed. | `restore-serving` |
| `source-gateway-paused` | The source gateway's desired status is `paused`; its ingress cannot be resumed until the gateway runs again. | `restore-serving` |

A `409` that carries `auditId` and no `code` is an `Idempotency-Key` replay. It
answers with the audit of the earlier call instead of acting twice. With
`?dryRun=true`, a verb runs its whole transaction and then rolls it back. It
answers with the plan, or with the same `409` the real call would give.

### Target load

`expectedTargetUsersAtMost` is the client's own cap for the target gateway; the
platform holds no capacity number. The verb counts the distinct users on the
target other than the user being moved. A user counts if they have an
assignment on the target or a pending or running `migrate-user` operation
toward it. The verb answers `precondition-failed` when that count exceeds the
cap. To leave room for the user being moved, a client with a cap of `N` sends
`N - 1`. A repeat of a step that already took effect is answered `already-*`
before the load is counted, so a target that filled since then does not turn
the repeat into a refusal.

### `POST /shared-gateways/<source>/users/<uid>/recover`

```json
{ "slug": "alice", "toGatewayId": "shared-b", "expectedSourceEpoch": 3, "expectedTargetUsersAtMost": 9, "sourceUnchangedForAtLeastMs": 300000 }
```

Recovers a user off an unavailable shared gateway onto a peer, keeping the
user's home. Operation `recover-shared-<uid>-<source>-<epoch>`.

The client's view that the source is unavailable is advisory. After the owner
check and before the transaction, the fleet controller reads the source's pods
from Kubernetes itself: a live read made for this call, not a cached
observation. In the transaction, a recovery that already committed answers
`already-committed` first, whatever the source looks like now. Otherwise the
verb proceeds only when all of these hold:

| Fact | Refusal when it does not hold |
|---|---|
| Kubernetes reports the source `missing` | `ready`: `precondition-failed`, "observed ready". `not-ready`: `precondition-failed`, "still has Kubernetes pods". No usable read, or a source that does not run as pods (a virtual machine runtime): `observation-unknown`. |
| The source's runtime heartbeat is not fresh (older than the gateway unreachable bound) | `precondition-failed`, "still has a fresh runtime heartbeat". |
| No roll is active on the source (desired release equals live release) | `precondition-failed`, "is in an active roll". |
| With `sourceUnchangedForAtLeastMs`: the source's root has not changed for at least that long (now minus its `updatedAt`) | `precondition-failed`, naming how long ago it changed. |

These are the same fences the fleet controller's own pass applies. A dry run
makes the same read and gives the same answers. The grace period after a change
to the source's root is the client's number: the platform holds none and
applies none by default. The server measures it against the root's own
`updatedAt`. A client that reproduces the fleet controller's pass sends its own
grace, today the gateway unreachable bound, as `sourceUnchangedForAtLeastMs`.

The verb also checks, in the same transaction, that:

- the source assignment is serving at `expectedSourceEpoch`;
- the target is in the shared pool, running its live release, serving, ready,
  and has a fresh heartbeat and a fresh ready Kubernetes observation;
- the target load is within the cap;
- the user has no unresolved restore or source transfer;
- a draining source is confirmed missing and its pending moves are unclaimed.

It then moves the assignment to the target at epoch `+1` and records a
succeeded `migrate-user` operation. Answers
`{"operationId", "outcome": "committed", "sourceKubernetesStatus"}`, or
`{"operationId", "outcome": "already-committed"}` for a repeat.

### `POST /users/<uid>/runtime-reset`

```json
{ "slug": "alice", "targetGatewayId": "shared-b", "expectedAssignmentEpoch": 4, "previousRecoveryOperationId": "recover-disposable-..." }
```

Resets the runtime of a user who was recovered from an isolated gateway onto a
shared gateway. Operation
`recover-disposable-reset-<uid>-<target>-<epoch>`. The verb checks that:

- the previous recovery operation is the succeeded isolated recovery that left
  this assignment;
- the assignment is a serving repair at `expectedAssignmentEpoch`;
- no reset is pending;
- the target is in the pool and freshly serving, and does not mount the user.

It then writes the pending reset marker on the user and bumps the assignment
epoch. Answers `{"operationId", "outcome"}`.

### `POST /shared-gateways/<source>/roll-recovery`

```json
{ "targetGatewayId": "shared-b", "expectedLiveRelease": 1, "expectedDesiredRelease": 2 }
```

Supersedes the roll of a shared peer when the roll has no live target and its
source gateway is gone. After the owner check, the fleet controller reads the
source's pods from Kubernetes itself, live, right before the transaction. The
client's own view only tells it when to ask. A read that fails or returns no
usable status, or a source that does not run as pods, answers
`observation-unknown`, except that a recovery already scheduled answers
`already-scheduled` first. In the transaction, the verb checks that:

- the source and the target are running shared pool members;
- the target's live, desired and latest releases match;
- the target serves its live release and every assignment on it;
- no migration involves the target;
- the source's status is `missing` and fresh.

It then appends a release that copies the live one and creates a `rollout`
operation, `recover-shared-roll-<source>-to-<target>-r<desired>-to-r<live>`.
Answers `{"kind": "scheduled" | "already-scheduled", "release", "operationId", "sourceKubernetesStatus"}`.

### `POST /users/<uid>/placement-migrations`

```json
{
  "slug": "alice", "fromGatewayId": "shared-a", "toGatewayId": "shared-b",
  "source": "continuous-placement-policy", "operationId": "placement-<digest>",
  "sharedDrain": { "pairedTargetGatewayId": null }, "expectedTargetUsersAtMost": 9
}
```

Enqueues a `migrate-user` operation, which the operation runner drives. There
are three cases:

- **Placement:** `source: "continuous-placement-policy"` without `sharedDrain`.
- **Drain:** `continuous-placement-policy` with `sharedDrain`.
- **Activation or return:** `source: "builder-activation-lease"`. Its
  `operationId` must be the activation operation of `toGatewayId` or the
  return operation of `fromGatewayId`, or the verb answers `400`.

A new continuous operation's id must be the digest of the user, slug, source,
target and the user's current source assignment epoch. Any other id answers
`precondition-failed`. The verb also checks, in the same transaction, that:

- `slug` is the slug on the user's record;
- the user has no other pending or running `migrate-user` operation, or the
  verb answers `precondition-failed` naming it;
- the target load is within the cap;
- no operator holds the user;
- for a drain, the source is still draining and its replacement pairing is
  unchanged.

When the operation exists, the verb does one of three things:

- A pending, running or succeeded operation is left as it is.
- A failed operation is re-armed only in the cases the fleet controller's pass
  re-arms: a transient rollback, a pre-RPC authority failure, a completed
  source-only rollback, a repaired source, a startup or revision-not-ready
  return, an operator retry, or a drain move superseded by an activation.
- Any other ending answers `precondition-failed`.

A pending or running operation of the same id is answered `already-enqueued`
before the other-migration and load checks. Answers
`{"operationId", "outcome": "created" | "rearmed" | "already-enqueued"}`.

### `POST /placement-migrations/<operation>/supersede`

```json
{
  "uid": "uid-alice", "slug": "alice", "fromGatewayId": "shared-a", "toGatewayId": "shared-b",
  "leaseId": "lease-one", "generation": 1, "targetGatewayId": "alice-xs-1", "activationOperationId": "builder-activate-alice-xs-1-g1"
}
```

Fails a pending drain move that the operation runner never claimed, so that
the user's activation can proceed in its place. The verb checks that the
operation is that never-claimed move, that the user still holds the
`provisioning` lease of that id and generation toward `targetGatewayId`, and
that the source is still draining. It marks the move failed and
`supersededBy` the activation. Answers
`{"operationId", "outcome": "superseded" | "already-superseded"}`.

## Isolated gateway lifecycle

These routes move a user's activation lease and retire the user's isolated
gateway. The caller decides when. The fleet controller re-reads the user and
the gateway, checks the fence the caller states, and performs the write and
any Kubernetes effect in one place.

All of them are inert until placement automation belongs to the client. Each
route first checks, read-only, that the placement automation owner is
`client` and that the fleet controller has written its yield; otherwise it
answers `409` with `"code": "placement-owner"` and writes nothing, dry runs
included. That refusal is logged at warning level and not journaled, so a
client that polls before the handover does not fill the journal. The same
check runs again first inside every write transaction, and before any
Kubernetes or Compute Engine effect, so a change of owner between the two
still refuses; a refusal there is journaled as refused. The fleet
controller's own placement policy runs the same functions with the opposite
check: it acts while it owns placement, and while the client owns it with no
yield written yet, and stops once the yield is written.

Every route takes `dryRun` and `Idempotency-Key` as the contract describes,
and writes one journal entry per call under the caller. A dry run evaluates
every fence the real call does, reading only, and writes nothing. A route
whose fence no longer holds answers `409` with `"code": "precondition-failed"`
and a `reason`, writes nothing but the refused journal entry, and the caller
reads the user again. A malformed body answers `400`. Repeating a call whose
effect already applied answers `200` with the same body where the route says
so. Repeating an `Idempotency-Key` follows the contract: `409` with the
journal entry's id and status, not the first answer. A client treats that
`409` with status `completed` as success and reads the user again for the
result.

The lease routes take `leaseId` and `generation`, the lease the caller read.
`advance` and `fail` also take an optional `operationId`, the operation the
step belongs to. It must be one of the canonical ids for the lease's gateway
and generation (`builder-activate-<gateway>-g<generation>`,
`builder-return-<gateway>-g<generation>`,
`builder-recover-<gateway>-g<generation>` or
`placement-retire-<user>-<gateway>-g<generation>`),
`builder-authorization-ended-<gateway>`, or the id of a journal operation of
that user on that gateway, such as a migration the caller adopted. Any other
id answers `400` and writes nothing. The gateway is the lease's target for
`advance` and `targetGatewayId` for `fail`.

### `POST /users/<id>/activation-lease/advance`

```json
{ "leaseId": "lease-1", "generation": 3, "fromStatus": "activating", "toStatus": "active" }
```

Moves the lease one step: `provisioning` to `activating`, `provisioning` to
`active` (the user already runs on the target), `activating` to `active`, or
`active` to `returning`. Reaching `activating` or `returning` records the
given `operationId` as the lease's activation or return operation; without
one, it records the canonical id for the lease's gateway and generation,
`builder-activate-<gateway>-g<generation>` or
`builder-return-<gateway>-g<generation>`. Reaching `active` records the wake
duration once. Answers `{uid, leaseId, generation, status}`; a
lease already at `toStatus` for the same operation answers the same.
`precondition-failed` means the lease is another lease, another generation,
or at neither status.

### `POST /users/<id>/activation-lease/complete`

`{leaseId, generation, targetGatewayId, parked?}`. Closes a `returning` lease
once the user's record points away from `targetGatewayId`, and writes the
user's return receipt. `parked: true` says the gateway is kept for the next
activation, so the receipt names no retirement operation; otherwise it names
the placement retirement the caller starts with `retire-owned`. With demand
pending on the lease, and the user still entitled and on a serving shared
assignment, the next lease is a `requested` lease of the next generation;
otherwise the lease becomes `parked`, with a code saying why when demand was
dropped. Answers the lease now stored,
`{uid, lease: {leaseId, generation, status}}`. `precondition-failed` means
the lease is not that returning lease, or the user has not returned.

### `POST /users/<id>/activation-lease/fail`

`{leaseId, generation, targetGatewayId, message, operationId?}`. Marks a
`provisioning` or `activating` lease `failed`, recording `message` against
`operationId`: the recovery, retirement, authorization-ended or activation
operation that ended it. Without one, it records the canonical activation
operation `builder-activate-<gateway>-g<generation>`.
Answers `{uid, leaseId, generation, status: "failed"}`, also when the lease is
already failed. It refuses with `reasonCode` `source-recovery-pending` and
leaves the lease unchanged while the lease's activation operation still
recovers its source: always when `operationId` is that activation operation,
and for any other `operationId` when the activation has `failed` or is a
`pending` or `running` source-only recovery (see
[Source recovery](#source-recovery)).

### `POST /users/<id>/activation-lease/sizing-transition`

`{leaseId, generation, targetGatewayId, sizingKey}`. For an `active` lease on
`targetGatewayId`, records a return request on the lease (reason
`tier-change`) so the user's next activation uses the sizing profile of
`sizingKey`. The fleet controller reads the user's sizing key itself;
`sizingKey` is the new key the caller saw. Answers
`{uid, leaseId, generation, returnRequested: true}`. The lease stays `active`
with the request on it until the caller returns the user by advancing it to
`returning`. `precondition-failed` means the lease changed, the user is no
longer on that gateway or no longer has interactive access, the user's
current key differs from `sizingKey`, or that key's profile is not isolated.

### `POST /isolated-gateways/<gateway>/retire-owned`

```json
{ "ownerUid": "uid-alice", "generation": 3, "reason": "builder-returned" }
```

Retires an isolated gateway owned by `ownerUid` at allocation `generation`.
`reason` is one of `provisioning-timeout`, `provisioning-target-paused`,
`builder-authorization-ended`, `activation-failed`, `builder-returned`,
`operator-terminated`, `parked-computer-replaced` or `owned-gateway-not-kept`.
Optional fences: `leaseId`; `telemetryFenceOperationId` with
`telemetryFenceStatus` (`succeeded` or `terminal-failure`);
`authoritativeGatewayId` with `authoritativeLeaseStatus` (`provisioning`,
`activating` or `returning`); `zeroWorkloadRecoveryOperationId`.
`telemetryFenceOperationId` follows the operation id rule of the lease routes,
for `ownerUid`, this gateway and `generation`: any other id answers `400` and
writes nothing. The zero-workload receipt must be a succeeded recovery of
this user, gateway, lease and generation.

It claims the retirement and writes the placement retirement operation in one
transaction, and answers `{gatewayId, operationId, retired: true}`. The
operation runner then drains and deletes the gateway; while it runs, the
gateway reads as `retired` with that retirement claim, and
`GET /isolated-gateways/retired` shows its progress. `precondition-failed`
means the gateway is not owned by `ownerUid`, is already retired, is another
generation, a stated fence no longer matches, or a pending telemetry
operation or another retirement claim blocks it; the `reason` says which.
It also refuses with `reasonCode` `source-recovery-pending`, for every
reason, while the activation operation
`builder-activate-<gateway>-g<generation>` has `failed` and still recovers
its source. While that activation is `pending` or `running`, the in-flight
migration fence refuses first with `retirement-blocked` (see
[Source recovery](#source-recovery)).

### `POST /users/<id>/home/prepare`

```json
{
  "leaseId": "lease-1", "generation": 3,
  "sourceGatewayId": "shared-blue", "sourceAssignmentEpoch": 4,
  "sizingKey": "pro", "sizingTier": "m"
}
```

Prepares the user's virtual machine home for a `requested` lease, one step
per call. The body is the allocation body without `parkedGateway`. The fleet
controller re-reads the user and checks that the lease, its generation,
source gateway and epoch, the user's sizing key and tier, and the user's
interactive access all still match; otherwise it answers
`precondition-failed`, "home migration activation authority changed". The
sizing key's profile must run the gateway on a virtual machine.

Each call reads where the user's home is, then does at most the next step of
its migration: start a copy into a disk of the profile's home size, poll the
copy, retry a failed copy, keep the original, release the copy helper, or
attach the verified copy to the user's stopped computer. The original disk is
kept. The answer is `200` with one of:

- `{uid, state: "ready", effects}`: the home is on a disk that fits the
  profile, or the user has no home yet. The user's home migration record is
  now `complete` with `preparedFor: {leaseId, generation, sizingKey}`, which
  `allocate` checks. A record prepared for another lease, generation or
  sizing key does not count; a new migration replaces it. A repeat after
  `allocate` moved that same lease on (`provisioning` through `returning`)
  answers `ready` from the record alone, without a Compute Engine call.
- `{uid, state: "in-progress", step, effects}`: a step ran or is under way.
  The caller calls again.
- `{uid, state: "in-progress", step, lastError: {code}, effects}`: Compute
  Engine was unavailable (`http-429`, `http-5xx` or a network error such as
  `econnreset`) during `step`. Earlier steps stay committed; the caller calls
  again later.
- `{uid, state: "blocked", reason, attempts}`: three copies failed. The
  original is kept and an operator repairs the home; repeating the call
  answers the same.

`effects` lists each Compute Engine change the call made, as
`{name, resource}`. Every call writes one journal entry: `completed` for a
ready call that changed nothing, `partial` for one that changed something or
is in progress, with the answer and `effects` in `partialOutcome.details`, and
`failed` for an unavailable Compute Engine or a blocked home. A fence or owner
refusal after a Compute Engine change still answers `409`, and its failed
entry lists the effects made before it. Any other error answers `500` and is
journaled as failed, with the effects made before it; that includes a
migration still under way for a user whose home disk is gone, which needs an
operator.

The owner check runs again before every Compute Engine call and first in
every write. A dry run checks the fences against the stored record, makes no
Compute Engine call and writes nothing.

The fleet controller mounts this route only when it runs gateways on virtual
machines; without that configuration, like the pod reader rule below, the
route does not exist.

### `POST /users/<id>/isolated-gateway/allocate`

```json
{
  "leaseId": "lease-1", "generation": 3,
  "sourceGatewayId": "shared-blue", "sourceAssignmentEpoch": 4,
  "sizingKey": "pro", "sizingTier": "m",
  "parkedGateway": { "gatewayId": "alice-m-1a2b3c4d", "generation": 2 }
}
```

Starts a `requested` lease on an isolated gateway. `sourceGatewayId` and
`sourceAssignmentEpoch` are the shared gateway and serving assignment the
caller read; `sizingKey` and `sizingTier` are the user's sizing key and its
profile's tier. `parkedGateway`, when given, is the user's kept gateway.

The fleet controller first reads the user's current sizing key, shared
gateway and assignment epoch. When any differs from the request, it writes
the current values onto the lease and answers
`{uid, gatewayId: null, outcome: "refreshed"}`, allocating nothing; the
caller reads the lease again and calls with the new values.

Otherwise it checks the user's home. When the sizing key's profile runs the
gateway on a virtual machine, allocation and resume both need a stored home
preparation for this lease: the user's home migration record is `complete`
and its `preparedFor` names the request's `leaseId`, `generation` and
`sizingKey`. Without it the call answers `precondition-failed`, "home for
<user> is not prepared for lease <lease> generation <n> sizing key <key>",
before any Kubernetes effect, dry runs included. `POST /users/<id>/home/prepare`
writes that record; a fleet controller without it refuses every user whose
profile needs a virtual machine home. A record the fleet controller's own pass
wrote before the handover names no lease, so the client prepares the home
once for its first lease. The fleet controller's own pass prepares the home
itself just before it allocates, and is not held to the stored record.
Profiles that run as pods need no preparation.

Then it allocates. A parked gateway of the same sizing key that runs
the shared gateway's current artifact is resumed and the answer is
`outcome: "resumed"`. A parked gateway that is obsolete is retired, with
reason `parked-computer-replaced`, and a new gateway is allocated. That
retirement is refused with `reasonCode` `source-recovery-pending` while the
parked gateway's own activation still recovers its source (see
[Source recovery](#source-recovery)). A new
gateway gets its Kubernetes auth secret, after the owner check and never in a
dry run, then, in one transaction, its
root and first release (from the shared gateway's live artifact) and the
lease moved to `provisioning` with the gateway as its target. The answer is
`{uid, gatewayId, outcome: "allocated"}`. The gateway id is derived from the
lease, so a repeat answers the same gateway, without checking the home again.

While Kubernetes brings the gateway up, the lease reads `provisioning`; the
caller advances it once the activation operation starts.
`precondition-failed` means the lease is not that requested lease, the
user lost interactive access or the isolated sizing profile, the shared
gateway is not a running or draining pool member on a converged release, or
its release changed, the assignment
is not serving at that epoch, a parked gateway changed or could not be
retired, another gateway holds the derived id, or the home is not prepared.

Known limit, as in the fleet controller's own pass: the auth secret is created
before the allocation transaction. When the lease or its generation changes
between the two, the transaction refuses and the secret stays, orphaned under
an id the next lease no longer derives. A repeat for the same lease reuses
it.

### `POST /isolated-gateways/<gateway>/recover-unreachable`

```json
{
  "ownerUid": "uid-alice", "leaseId": "lease-1", "generation": 3,
  "authoritativeGatewayId": "shared-blue", "sourceUnavailable": true
}
```

Retires the runtime of an isolated gateway that stopped answering, after the
user is back on `authoritativeGatewayId` with a serving assignment. Without
`sourceUnavailable`, a gateway whose runtime is ready again is refused;
with it, the lease must be `returning` for reason `source-unavailable`.

It runs in three steps: reserve, observe, complete.

1. **Reserve.** In one transaction the fleet controller checks the fences,
   records the recovery operation `builder-recover-<gateway>-g<generation>`
   as pending, and pauses the gateway. If a fence fails it answers `409`
   `precondition-failed` and writes nothing. That includes a failed
   activation of this gateway and generation, or a `pending` or `running`
   source-only recovery of it, whose source recovery is pending
   (`reasonCode` `source-recovery-pending`); the check runs again when
   completing.
2. **Observe.** It reads the gateway's pods from Kubernetes.
3. **Complete.** With no pods left, it marks the operation succeeded with a
   zero-pod receipt and answers
   `{gatewayId, state: "recovered", operationId}`.

When the pods cannot be observed (the read failed or reported an unknown
status), the answer is `200`
`{gatewayId, state: "waiting", reason: "observation-unknown", operationId}`;
when pods remain it is the same with `reason: "pods-present"`. The
reservation stays: the gateway stays paused and the operation pending. The
caller repeats the same call later; the repeat re-checks the fences, keeps
the same operation and observes again. The journal entry of a waiting call
has outcome `partial`, with `partialOutcome.summary` `waiting: <reason>` and
the state, reason and operation id in `details`; a recovered call's entry is
`completed`. A fence that fails at completion,
after the reservation, answers `409` `precondition-failed` with the
reservation left in place.

The fleet controller never answers `409` `observation-unknown`: it learns
whether it can observe the pods only by reading them, which comes after the
reservation. Without a pod reader it mounts none of these routes.

A dry run runs the reservation transaction read-only, owner check included.
It neither reserves nor reads the pods.

## `PATCH /users/<id>/placement`

`{"managedBy": "cowboy", "expectedGatewayId": "<gateway>"}` releases an
operator hold only while the user is on that shared gateway with a serving
assignment and no operation in flight.

## `POST /users/<uid>/restore-serving`

No body. Finishes the rollback of a failed move that unmounted its target but
could not resume the user's ingress on the source gateway. Such a move ends
`failed` and leaves the user's assignment `quiescing` and the user's migration
fence naming the failed operation, so the user gets no answer and a new move
is refused. This route works whoever owns placement, and only on a fleet
controller: a host that cannot call a gateway does not mount it.

It restores the source only when all of this holds, checked in one read-only
transaction and again in the transaction that writes:

- The user has exactly one assignment. It is `quiescing` on the gateway the
  user is assigned to, carries the user's slug, and names the operation that
  closed it.
- That operation is a `migrate-user` of this user out of this gateway and is
  `failed`. It has no committed cutover, no forward migration state, no forward
  recovery checkpoint, no source transfer and no cancellation request, and it
  is not a source-only recovery.
- The operation's recorded steps end with one failed step, then
  `rollback:unmount-target` `done`, then `rollback:resume-ingress` `failed` or
  `done`. The failed step is `quiesce-source` or `flush-source`, every step
  before it is `done`, `quiesce-source` appears once and no step repeats. A
  move that failed at `final-sync-state` or later is refused: from the final
  copy on, the user's agent stores can belong to the target's database role,
  and only the move's own rollback hands them back.
- Every earlier attempt of the operation that its attempt history records
  finished its rollback: none has a `rollback:` step that is not `done`, and
  none reached `final-sync-state` without `rollback:resume-ingress` `done`.
  The last history entry counts as the attempt that failed only when it
  carries the operation's attempt number and claim time; after a reaped
  attempt, which records no history, every entry is an earlier attempt.
- The source gateway has a root whose desired status is `running` or
  `draining`. A `paused` gateway is refused with `source-gateway-paused`, a
  `retired` or missing one with `source-gateway-retired`.
- The user's account is active.
- The assignment has no forward recovery marker. The user has no restore
  fence and no source transfer fence, and the user's migration fence names that
  operation or is absent.
- No other operation for the user, and no operation on the source gateway, is
  `pending` or `running`.

It then asks the source gateway to resume the user's ingress under the failed
move's migration id. This is the gateway's `/resume` call alone. It does not
hand database ownership of the user's agent stores back to the source, which
is why only failures before the final copy are admitted. When the gateway
confirms, the route restores the schedules the move took off the source at
`quiesce-source`, if the move stored a schedule transfer that is not yet
restored. Then it marks the assignment `serving` under the failed operation,
which clears the migration fence. The route acts on the source it read before
it journaled; if that source has changed by the time it acts, it refuses with
`fleet-state-changed` and does not call the gateway.

The answer is
`{uid, slug, gatewayId, targetGatewayId, state: "serving", failedMoveId, operationId, schedulesRestored, sourceDraining}`.
`operationId` is the journal audit of the repair and `failedMoveId` the
operation of the failed move.

- `schedulesRestored` has four values:

  | Value | Meaning |
  |---|---|
  | `true` | The move's schedule transfer is restored on the source, by this call or already by the move's rollback. |
  | `false` | The transfer is stored and restoring it failed. It stays stored under the user, unrestored, with its failures. |
  | `"none"` | The move failed at `flush-source` and stored no transfer. Its schedule snapshot had finished by then, and a finished snapshot of a move between gateways always stores a transfer, so this value is not expected. |
  | `"unknown"` | The move failed at `quiesce-source` and stored no transfer. That step is the quiesce call followed by the schedule snapshot, and the snapshot disables each schedule before it answers, so a failure inside it can leave schedules disabled on the source with no record of which. |

  Neither `false` nor `"unknown"` holds the repair back: the user serves
  again. `false` is logged as an error and `"unknown"` as a warning.
- `sourceDraining` is `true` when the source gateway's desired status is
  `draining`. The user then serves again on a gateway that is being emptied,
  and the failed move stays terminal: a placement request for the same source,
  target and assignment epoch names the same operation and is refused with
  `migration-terminal`. Move the user with an operator move.

The journal audit of a repair ends `completed`. Its outcome is `partial`, with
a `partialOutcome` whose `details` are `{schedulesRestored, sourceDraining}`,
when `schedulesRestored` is `false` or `"unknown"` or `sourceDraining` is
`true`; otherwise it is `completed`.

The call answers after the gateway calls it makes: a resume and, when a
transfer is stored, a schedule restore, each with a 60 second timeout. A
request can therefore take about two minutes. The fleet controller's HTTP
server sets no response timeout. The charts route `/api/admin/users/*` to the
fleet controller and set a backend timeout only for a Google Cloud load
balancer: the fleet controller's `backendConfig.timeoutSec`, 3600 seconds by
default. With another ingress class the proxy's own timeout applies.

| Answer | Meaning |
|---|---|
| `404` | The user does not exist. Nothing is journaled. |
| `409` `precondition-failed` | A check above does not hold; `reasonCode` is `source-not-stranded`, `migration-in-flight`, `rollback-not-proven`, `fleet-state-changed`, `account-not-active`, `source-gateway-retired`, `source-gateway-paused` or `user-missing`. No record changed. A repeat after a repair answers `source-not-stranded`. |
| `502` `source-resume-failed` | The source gateway answered the resume with an error. No record changed. |
| `503` `source-resume-failed` | The source gateway could not be reached. No record changed. |

A refusal found before the journal entry is not journaled. A failed resume,
and a refusal found after the journal entry, are journaled as a failed audit.
A refusal at the write comes after the gateway resumed the ingress, so the
ingress is open while the assignment stays `quiescing`; the call can be
repeated once the cause is gone. With `?dryRun=true` the route runs the
read-only check and answers the plan or the same `409`; it does not call the
gateway.

An `Idempotency-Key` identifies one attempt, not the repair. Once an attempt
is journaled, a repeat with the same key answers `409` with that attempt's
audit, every time, and never calls the gateway again. That holds after a `502`
or `503` too. To try again, send the call without the header or with a new
key.

The fleet controller also makes this repair itself. Once a minute its stuck
operation reaper starts a pass over the failed moves whose rollback reached
the source ingress, leaving out any move it re-armed in that tick. The pass
applies the same checks and journals each repair as an audit of its own under
the actor `fleet-controller`. It runs beside the reaper and does not hold it.

- One pass runs at a time and starts at most five repairs, the moves that have
  waited longest first. Each repair can hold for a 60 second resume and a 60
  second schedule restore, so a pass ends within about ten minutes. A user on
  a healthy gateway who is listed behind n untried users on a gateway that
  does not answer waits ceil(n / 5) passes.
- When a tick finds a pass that has run for 15 minutes, it logs an error, and
  again every further 15 minutes. It never starts a second pass.
- After a failed resume it waits one minute, then twice as long each time up
  to 30 minutes, and stops after 12 attempts for that operation until the
  fleet controller restarts. It logs every failed attempt.
- A refusal that can pass later (`migration-in-flight`, `fleet-state-changed`,
  `account-not-active`, `source-gateway-paused`) is checked again on the same
  schedule, without a limit and without calling the gateway. It is logged once
  when the wait starts and once when it ends.
- Any other refusal is logged once and not checked again until the operation
  changes.
- A move that leaves the failed list is forgotten; if it fails again it
  starts a new count.

The pass makes no placement decision and does not take the placement owner
fence: it only completes the rollback the failed move began. This route stays
available throughout.

Known limits:

- A move that failed at `final-sync-state` or later is not repaired, by this
  route or by the pass.
- For a move whose source is not a shared gateway, a failed rollback can be
  retried, so a later attempt may already have handed the agent stores back
  after an earlier attempt left them with the target. The attempt history
  rule still refuses such a move, because the history does not show the
  recovery. That user has no repair verb; the remaining operator action is to
  suspend the account.
- After `schedulesRestored` `false` or `"unknown"`, a repeat of this route
  answers `source-not-stranded`, and nothing in the platform restores the
  schedules later. No Admin API route reads or restores a schedule transfer.
  For `false`, the transfer stays in platform state under the user with the
  migration id `mig-<failedMoveId>`; it holds each schedule's job definition
  and agent, and its `restoreFailures`. Restoring by hand means reading that
  record and creating those jobs again in the agent's scheduler on the source
  gateway. For `"unknown"` there is no record; a schedule the snapshot
  disabled is still on the source gateway and is enabled again by hand in the
  agent's scheduler.
- After the repair of an activation move, the failed operation still counts
  as recovering its source, and isolated gateway verbs for its target keep
  answering `source-recovery-pending`. That clears when the fleet controller
  re-arms the operation as a source-only recovery and it completes, which the
  repaired state still allows, or when the failed operation leaves the journal
  30 days after it failed.
