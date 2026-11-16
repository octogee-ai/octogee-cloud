# provisioning-service

Converges each user's chat host and git host resources to the spec its callers
write. It decides nothing about when: it acts on a spec, retries with backoff,
parks what keeps failing, and reports it. It never touches a gateway, a user's
home or OpenClaw; mounting a user stays with the gateway supervisor.

The types are `@octogee/shared/types/provisioning-service`.

## API, `/v1`

| Method and path | Effect | Answers |
| --- | --- | --- |
| `PUT /v1/users/{uid}/provisioning` | Body `{ spec, expectedResourceVersion? }`. Creates or replaces the spec; `generation` grows only when the spec differs; work is enqueued in the same transaction. | `201` created, `202` changed, `200` unchanged; body is the `UserProvisioning` |
| `GET /v1/users/{uid}/provisioning` | Read one. `?waitForGeneration=N&timeoutSeconds=T` holds until `status.observedGeneration >= N` or the work parks. | `200`, `404` |
| `DELETE /v1/users/{uid}/provisioning` | Stops managing the user and its git keys, at a new resource version that the watch reports as a deletion. A waiter on the user answers `404`. Deletes nothing in the chat or git host. | `204`, `409 work-running` |
| `GET /v1/provisionings` | List: `?ready=true\|false&reason=<Reason>&workState=queued\|running\|retrying\|parked&limit=&pageToken=`. Answers `{ items, resourceVersion, nextPageToken? }`. | `200` |
| `GET /v1/provisionings?watch=true&resourceVersion=V&timeoutSeconds=T&limit=L` | Returns at once with the changes after `V`, oldest first and at most `L` (default and maximum 500), or holds until one happens or the timeout passes. Answers `{ items, deleted?, resourceVersion }`: `items` are the resources changed, `deleted` is `[{ uid, resourceVersion }]` for each user deleted, present only when there is one. Apply both in `resourceVersion` order, since a uid can be deleted and created again. Ask again from the returned version, which is the last change's when the page was cut short. | `200`, `410 resource-version-expired` |
| `POST /v1/users/{uid}/provisioning/retry` | Body `{ expectedAttempts? }`. Makes parked or retrying work due now. Honours `Idempotency-Key` for 24 hours. | `202`, `409 precondition-failed`, `409 not-retryable`, `409 idempotency-conflict` |
| `GET /v1/users/{uid}/provisioning/events` | The last 50 attempts, newest first, with each step's outcome, reason and duration. | `200`, `404` |
| `PUT /v1/users/{uid}/git-keys/{holder}` | Body `{ spec: { publicKey } }`. Authorizes the key on the user's git owner. | `201`, `202`, `200`; body is the `GitKey`; `404` when the user has no provisioning |
| `GET /v1/users/{uid}/git-keys/{holder}` | Reads the key. | `200`; body is the `GitKey`; `404` when there is none |
| `DELETE /v1/users/{uid}/git-keys/{holder}` | Releases the key. Optional body `{ expectedPublicKey }` releases it only while the row still holds that key, compared by key material. | `202`, `409 precondition-failed` when the row holds another key |
| `GET /v1/git-key-holders` | Lists every holder with live rows. | `200`; body `{ holders: [{ holder, gatewayId }] }` |
| `DELETE /v1/git-key-holders/{holder}` | Releases every user's key for one holder that is gone. | `202`; body `{ remaining }`, the holder's rows not yet released from the git host |
| `DELETE /v1/gateways/{gatewayId}/git-keys` | Releases every user's key for every holder of a retired gateway. | `202`; body `{ remaining }`, the gateway's rows not yet released from the git host |

A holder is one gateway pod: `<gatewayId>/<podName>`, URL-encoded as one path
segment. Each pod holds its own key, so two pods of one gateway, as during a
surge roll, hold two keys at once. A holder that is not a gateway id and a pod
name is refused with `400`.
| `GET /v1/users/{uid}/credentials/{name}` | `{ name, value, version }`, `Cache-Control: no-store`. Names: `agent-chat-token`, `user-chat-token`. | `200`, `404`, `409 not-issued` |
| `GET /healthz`, `/readyz`, `/metrics` | Unauthenticated, no tenant data. `/readyz` and `/metrics` answer from a database check and work snapshot each replica takes every 5 seconds. | `200`, `503` |

A write is done when `status.observedGeneration >= generation` and the `Ready`
condition is `True`. Conditions: `ChatReady`, `GitReady`, `CredentialsIssued`,
`Ready`, each with a reason from `PROVISIONING_CONDITION_REASONS`. Callers ignore
condition types, reasons and fields they do not know. `status.work.state` is
`queued`, `running`, `retrying`, `parked` or `idle`.

Errors are `{ "code": "...", "error": "..." }` with a code from
`PROVISIONING_ERROR_CODES`.

## Limits

Each authenticated caller, keyed by its reviewed service account, may make
`PROVISIONING_CALLER_REQUESTS_PER_MINUTE` requests a minute to `/v1` and may hold
`PROVISIONING_CALLER_CONCURRENT_WAITS` requests open at once with
`waitForGeneration` or `watch=true`. A request beyond either limit does nothing
and answers `429 rate-limited` with `Retry-After`. `/healthz`, `/readyz` and
`/metrics` are not limited.

## Authentication

Every `/v1` request carries a projected Kubernetes service account token with
audience `provisioning-service`, checked with TokenReview. The service has two
callers with fixed roles, and the environment names the service account each one
runs as:

| Caller | Service account named by | Roles |
| --- | --- | --- |
| fleet controller | `PROVISIONING_FLEET_CONTROLLER_SERVICE_ACCOUNT` | `writer`: provisioning put, delete, read, list, watch, retry, events; `key-retirer`: list git key holders and release a gone holder's or a retired gateway's git keys; `credential-reader`: credentials, to copy issued chat tokens where the platform reads them |
| platform API | `PROVISIONING_PLATFORM_API_SERVICE_ACCOUNT` | `key-writer`: git keys; `reader`: provisioning read, list, watch, events; `credential-reader`: credentials |

The two settings must name different service accounts. The platform chart sets
them to the service accounts its fleet controller and platform API Deployments
run as (`glm-controller` and `octogee-api.serviceAccountName`).

Only service accounts in `PROVISIONING_CALLER_NAMESPACE` are matched. A failed
review or wrong audience answers `401`; any other service account, or a route
outside its roles, answers `403`. The service's own service account needs
permission to create TokenReviews.

## Git keys

No caller puts or deletes a GitKey yet. A row is keyed by user and gateway id,
but a shared gateway rolls with a surge, so for a while two pods of one gateway
each hold their own key for the same user. Until the row's holder is a pod, the
platform API registers and releases each pod's key directly on the git host,
under a title per pod, after the service reports the user's git side ready.

Keys registered by the earlier path carry another title. When a GitKey is put
and the user's own git account already holds the identical public key under
another managed title, whether the earlier path's or another holder's, the
service adopts it on an attempt that follows the put: it removes that key and
registers the same key under its own holder's title, restoring the removed key
if the registration fails. A different public key is added beside it, and that
key is left alone. Keys are compared by type and key material, never by
comment.

Every put of a row, an unchanged one included, increments the row's
`putSequence`, which the put answers, clears the row's backoff and makes the
user's work due: idle or retrying work is queued at once, and running work runs
again when it finishes. Parked work stays parked, and a key pass processes the
put (see Work). `status.observedPutSequence` is the
highest put sequence an attempt that started after that put has processed: it
registered the key, finding it on the git host under the holder's title or
registering it there, or recorded a refusal. A transient failure leaves it
unchanged. An attempt adopts only while `putSequence` is above
`observedPutSequence` at its start. An attempt with nothing new to observe that
finds its key under another managed title leaves that key alone and reports
`Registered=False` with reason `GitKeyHeldElsewhere` and the key backoff, so a
key a pod on another build claimed stays with that pod. A caller treats its key
as registered only when `Registered=True` and `observedPutSequence` is at least
the sequence its put returned.

Within one attempt, rows marked for release are reconciled before the others,
and the git host's key list is read again after every release or register, so
each row sees the keys the rows before it left. A refusal or failure recorded
by an attempt that read the row before a later put leaves the backoff that put
cleared.

Releasing a row deletes only a key under that row's own title. It never deletes
a key by its material alone, so a key another holder or the earlier path holds
stays registered.

A key another user's account holds, or one on the user's own account under a
title outside the managed prefix (added by hand), is never adopted. The git
host refuses it, and the row reports `Registered=False` with reason
`GitKeyHeldElsewhere`. That refusal is recorded on its row only: the rest of
the user's attempt finishes, the user's work is not parked, and the attempt's
`git-keys` step carries it. Every other failure, a credential or permission
error from the git host and any failed release (a deleted key's included),
fails the attempt as before, so it is retried or parked.

A key held elsewhere backs off per row: 1 minute, doubling to at most 6 hours,
shown as `status.nextAttemptAt`. The service owns the retry: the user's work is
scheduled for that time, and the key is tried again then without any put. A put
resets the backoff and is tried at once.

With `PROVISIONING_HOST_ADAPTERS=fake`, `PROVISIONING_FAKE_GIT_KEYS` seeds the
fake git host with keys, as JSON mapping each owner to `{ publicKey, holder }`
entries.

## Chat accounts

The chat host adapter adopts an existing chat account found by username or by
email, as the earlier provisioning path did. The service assumes the email in a
spec is verified by the caller; if a platform admits unverified emails, adoption
by email would let one user take over another's chat account.

## Outputs

`status.outputs.git` reports the repositories the service created or confirmed,
with their clone and SSH URLs. It does not say that a gateway has pushed the
workspace; that signal stays with the gateway.

## Work

One queue row per user in the service's own PostgreSQL schema. A spec or key
write makes the row due; workers claim due rows with leases, so any number of
replicas share the work and at most one attempt per user runs at a time. An
attempt stops calling hosts once its lease has gone a full lease period without
a confirmed heartbeat. A failed attempt retries after
`min(5 s * 2^attempts, 10 min)` with jitter; a terminal error, the twelfth
transient failure, or a twelfth attempt that ended without finishing parks the
work until the spec changes or a retry is requested. A key write leaves parked
work parked. Idle rows are resynced six hours after their last success.

Git keys keep converging while the user's work is parked. A key pass claims the
parked row under a lease when a key is marked for release, or when a key has a
put no attempt has tried yet and the user's git account exists. It releases the
marked keys, registers the put ones, and returns the row to parked with its
attempts, running no other step. A put that marked a running attempt dirty is
therefore still processed when that attempt's lease expires on its last
attempt. A release or register that fails is recorded on that key's row
(`Registered=Unknown`, reason `GitKeyFailed`), logged at error level and retried
after the key backoff; a released row stays until a release succeeds. A retry
requested during the pass queues the work once the pass ends.

Schema v3 keys git keys by holder. It refuses to migrate a database that holds
any git key row; such rows must be released first.

## Known limits

- A token issued by the chat host but not stored, because the attempt lost its
  lease or the write failed, stays valid on the chat host; nothing revokes it.
- A stored token is not checked against the chat host again on resync.
- The conformance suite runs the implementation with in-process fake host
  adapters, so it cannot yet assert host resource counts, account adoption, host
  fault injection, the absence of overlapping host calls for one user, or
  resync. The package's own tests cover these against the fakes; running the
  real adapters against HTTP fake hosts is follow-up work.

## Schema

At startup each replica creates and upgrades its tables in one transaction
holding a PostgreSQL advisory lock, so replicas starting together migrate once.
Upgrades are numbered and applied in place; a build refuses to start on a schema
newer than it knows.

## Environment

| Variable | Required | Secret | Meaning |
| --- | --- | --- | --- |
| `PROVISIONING_PORT` | no, `8080` | no | HTTP port |
| `PROVISIONING_DB_HOST` | yes | no | PostgreSQL host |
| `PROVISIONING_DB_PORT` | no, `5432` | no | PostgreSQL port |
| `PROVISIONING_DB_NAME` | yes | no | database |
| `PROVISIONING_DB_USER` | yes | no | database user |
| `PROVISIONING_DB_PASSWORD` | yes | yes | database password |
| `PROVISIONING_DB_SSLMODE` | yes | no | `disable`, `require` or `verify-full` |
| `PROVISIONING_DB_CA_CERT` | no | no | PEM CA, `verify-full` only |
| `PROVISIONING_DB_TLS_SERVER_IDENTITY` | no | no | server name to verify when the host is an address, `verify-full` only |
| `PROVISIONING_DB_POOL_MAX` | no, `10` | no | connection pool size |
| `PROVISIONING_DATABASE_SCHEMA` | no, `provisioning_service` | no | schema holding the service's tables |
| `PROVISIONING_CALLER_NAMESPACE` | yes | no | namespace of the callers' service accounts |
| `PROVISIONING_FLEET_CONTROLLER_SERVICE_ACCOUNT` | yes | no | service account the fleet controller runs as |
| `PROVISIONING_PLATFORM_API_SERVICE_ACCOUNT` | yes | no | service account the platform API runs as; must differ from the fleet controller's |
| `PROVISIONING_CREDENTIAL_KEY` | yes | yes | base64 of 32 bytes; encrypts issued credentials |
| `PROVISIONING_TOKEN_REVIEW_URL` | no | no | TokenReview endpoint; defaults to the in-cluster API server |
| `KUBERNETES_SERVICE_HOST`, `KUBERNETES_SERVICE_PORT_HTTPS` | when the URL above is unset | no | set by Kubernetes |
| `PROVISIONING_TOKEN_REVIEW_TOKEN_FILE` | no, `/var/run/secrets/kubernetes-api/token` | file is | the service's own token for TokenReview |
| `PROVISIONING_TOKEN_REVIEW_CA_FILE` | no, `/var/run/secrets/kubernetes-api/ca.crt` for https | no | API server CA |
| `PROVISIONING_CALLER_REQUESTS_PER_MINUTE` | no, `3000` | no | `/v1` requests a minute per caller service account |
| `PROVISIONING_CALLER_CONCURRENT_WAITS` | no, `100` | no | held wait and watch requests per caller service account |
| `PROVISIONING_CHANGE_RETENTION_SECONDS` | no, `86400` | no | how long watch can resume from an old `resourceVersion` |
| `PROVISIONING_HOST_ADAPTERS` | yes | no | `real` in every deployment; `fake` only for tests |
| `PROVISIONING_ALLOW_FAKE_HOST_ADAPTERS` | with `fake` | no | must be `for-tests-only`, or `fake` refuses to start |
| `PROVISIONING_FAKE_HOST_DELAY_MS` | no, `0` | no | delay of each fake host call, for tests |
| `PROVISIONING_CHAT_HOST_URL` | with `real` | no | chat host base URL |
| `PROVISIONING_CHAT_HOST_ADMIN_TOKEN` | with `real` | yes | chat host admin token |
| `PROVISIONING_CHAT_HOST_ADMIN_USER_ID` | no | no | chat host admin user id |
| `PROVISIONING_CHAT_CONTROL_COMMAND_URL` | with `real` | no | URL the team's control command calls |
| `PROVISIONING_GIT_HOST_URL` | with `real` | no | git host API URL |
| `PROVISIONING_GIT_HOST_ADMIN_TOKEN` | with `real` | yes | git host admin token |
| `HOSTNAME` | no | no | replica identity for leases; set by Kubernetes |

A missing required setting stops startup with an error naming it.

## Development

```bash
npm ci
npm run typecheck
npm test
```

Tests that need PostgreSQL read `OCTOGEE_TEST_POSTGRES_DSN` and are skipped
without it. `node ../scripts/ci/provisioning-service-postgres.mjs` starts a
private PostgreSQL 16 and runs them and the conformance suite, as the checks
workflow does.

## Conformance suite

`npm run conformance` tests an implementation from outside, over HTTP only. It
starts a fake TokenReview endpoint, empties the database named by
`PROVISIONING_CONFORMANCE_DSN` (it runs `DROP OWNED BY CURRENT_USER`, so give it
a database and a non-superuser role of its own), and starts the implementation
with `PROVISIONING_CONFORMANCE_COMMAND` (default: this package's `src/main.ts`).
The implementation receives the settings in the environment table above, with
`PROVISIONING_HOST_ADAPTERS=fake`, `PROVISIONING_ALLOW_FAKE_HOST_ADAPTERS=for-tests-only`,
`PROVISIONING_DB_SSLMODE=disable` and `PROVISIONING_TOKEN_REVIEW_URL` pointing at
the fake; some cases also set the limits, the retention window or the fake host
delay. `/metrics` must report `provisioning_leases_held`, the attempts this
replica holds, and `provisioning_lease_expired_total`, the expired leases it took
over; the replica case uses them to prove a takeover happened. A `resourceVersion`
newer than the service has issued answers `410`, like an expired one. Deletion
markers are kept as long as the change log, so a watch from before the retained
window answers `410` and the caller lists again.
