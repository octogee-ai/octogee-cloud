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
| `DELETE /v1/users/{uid}/provisioning` | Stops managing the user and its git keys. Deletes nothing in the chat or git host. | `204`, `409 work-running` |
| `GET /v1/provisionings` | List: `?ready=true\|false&reason=<Reason>&workState=queued\|running\|retrying\|parked&limit=&pageToken=`. Answers `{ items, resourceVersion, nextPageToken? }`. | `200` |
| `GET /v1/provisionings?watch=true&resourceVersion=V&timeoutSeconds=T` | Returns at once with every resource changed after `V`, or holds until one changes or the timeout passes. Answers `{ items, resourceVersion }`; ask again from the returned version. | `200`, `410 resource-version-expired` |
| `POST /v1/users/{uid}/provisioning/retry` | Body `{ expectedAttempts? }`. Makes parked or retrying work due now. Honours `Idempotency-Key` for 24 hours. | `202`, `409 precondition-failed`, `409 not-retryable`, `409 idempotency-conflict` |
| `GET /v1/users/{uid}/provisioning/events` | The last 50 attempts, newest first, with each step's outcome, reason and duration. | `200`, `404` |
| `PUT /v1/users/{uid}/git-keys/{gatewayId}` | Body `{ spec: { publicKey } }`. Authorizes the key on the user's git owner. | `201`, `202`, `200`; body is the `GitKey`; `404` when the user has no provisioning |
| `DELETE /v1/users/{uid}/git-keys/{gatewayId}` | Releases the key. | `202` |
| `GET /v1/users/{uid}/credentials/{name}` | `{ name, value, version }`, `Cache-Control: no-store`. Names: `agent-chat-token`, `user-chat-token`. | `200`, `404`, `409 not-issued` |
| `GET /healthz`, `/readyz`, `/metrics` | Unauthenticated, no tenant data. | |

A write is done when `status.observedGeneration >= generation` and the `Ready`
condition is `True`. Conditions: `ChatReady`, `GitReady`, `CredentialsIssued`,
`Ready`, each with a reason from `PROVISIONING_CONDITION_REASONS`. Callers ignore
condition types, reasons and fields they do not know. `status.work.state` is
`queued`, `running`, `retrying`, `parked` or `idle`.

Errors are `{ "code": "...", "error": "..." }` with a code from
`PROVISIONING_ERROR_CODES`.

## Authentication

Every `/v1` request carries a projected Kubernetes service account token with
audience `provisioning-service`, checked with TokenReview. The reviewed service
account maps to roles through a fixed table:

| Service account | Roles |
| --- | --- |
| fleet controller | `writer`: provisioning put, delete, read, list, watch, retry, events |
| platform API | `key-writer`: git keys; `reader`: provisioning read, list, watch, events; `credential-reader`: credentials |

A failed review or wrong audience answers `401`; any other service account, or a
route outside its roles, answers `403`.

## Work

One queue row per user in the service's own PostgreSQL schema. A spec or key
write makes the row due; workers claim due rows with leases, so any number of
replicas share the work and at most one attempt per user runs at a time. A
failed attempt retries after `min(5 s * 2^attempts, 10 min)` with jitter; a
terminal error or the twelfth transient failure parks the work until the spec
changes or a retry is requested. Idle rows are resynced six hours after their
last success.

## Development

```bash
npm ci
npm run typecheck
npm test
```

Tests that need PostgreSQL read `OCTOGEE_TEST_POSTGRES_DSN` and are skipped
without it. `node ../scripts/ci/provisioning-service-postgres.mjs` starts a
private PostgreSQL 16 and runs them, as the checks workflow does.
