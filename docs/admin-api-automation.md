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

Same body. After the same checks, with the retirement `succeeded` and no
unreleased scheduler handoff, it clears a failed activation preparation of
that generation from the owner, deletes the gateway's recovery operation and
receipt, and deletes the root with its releases, fenced on the
`retirementVersion` it read. These are separate writes, as before the verb
existed: a root whose retirement changed after the checks answers `409` and
stays, and a failed write answers `500` and leaves the root for the next
call. The retirement and activation journals stay.

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
