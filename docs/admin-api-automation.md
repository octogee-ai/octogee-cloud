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

## `PATCH /users/<id>/placement`

`{"managedBy": "cowboy", "expectedGatewayId": "<gateway>"}` releases an
operator hold only while the user is on that shared gateway with a serving
assignment and no operation in flight.
