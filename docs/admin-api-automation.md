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
  "config": { "sharedGatewayAutoscaling": {}, "sizingProfiles": {}, "disposableGatewayIdleMs": null },
  "sharedPoolAutomation": { "actionSequence": 4, "lastActionAt": 1794268800000, "replacements": [] },
  "users": [],
  "gateways": [],
  "latestReleasePayloadHashes": { "shared-a": "<hash>" },
  "assignments": [],
  "runtimes": [],
  "operations": []
}
```

`config.sharedGatewayAutoscaling` is `null` when the stored dial is malformed.
`operations` holds the operations in the statuses named by
`?operationStatus=` (default `pending,running`). `latestReleasePayloadHashes`
covers shared gateways only and is `null` for one whose latest release has no
readable payload. Each user carries only `uid`, `slug`, `admitted`,
`accountLifecycle`, `provisioning.status`, `gateway.gatewayId`,
`openclaw.managedBy` and its restore and source-transfer fences.

### Selecting sections

`?sections=` names the sections to answer, comma-separated, from `config`,
`sharedPoolAutomation`, `users`, `gateways`, `releases`, `assignments`,
`runtimes`, `operations` and `migrations`. Without it the answer is the one
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
- `releases`: `platformArtifactHash` and `latestReleasePayloadHashes` as
  above, plus `platformCurrentSharedGatewayIds`, the shared gateways whose
  latest release payload hash equals `platformArtifactHash` (empty when the
  server has no platform artifact).
- `migrations`: the `migrate-user` operations that are `pending` or
  `running`, whatever `?operationStatus=` says.

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

### What a 409 means

| `code` | Meaning | What the client does |
|---|---|---|
| `placement-owner` | The client does not own placement, or the fleet controller has not yielded. | It does not act. It reads the switch and the yield again on its next tick. |
| `precondition-failed` | A fact the client acted on has changed, such as an epoch, a release, the pool, a lease or the target's load. `error` names it. | It logs the refusal and decides again from a fresh read on its next tick. It never retries within the same tick. |
| `observation-unknown` | The fleet controller's live read of the gateway's pods failed, or returned no status, an `unknown` status or a malformed one. `error` names the read failure when there was one. Nothing changed. | It tries again on a later tick. |

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
already failed.

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

## `PATCH /users/<id>/placement`

`{"managedBy": "cowboy", "expectedGatewayId": "<gateway>"}` releases an
operator hold only while the user is on that shared gateway with a serving
assignment and no operation in flight.
