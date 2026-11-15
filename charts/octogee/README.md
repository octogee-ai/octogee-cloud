# octogee chart

## Provisioning service

The provisioning service creates each user's chat and git presence and issues
their chat credentials. It is off by default; set `provisioningService.enabled:
true` with an image to run it. While it is off the chart renders exactly what it
rendered before the service existed.

It runs two replicas behind a cluster-internal Service. Only the fleet
controller and the platform API may call it, and they authenticate with
projected service account tokens it checks through TokenReview. Enabling it
therefore requires `gatewayFleet.tokenReviewRbac.enabled`; the chart refuses to
render without that grant.

### Secrets

Create these in the release namespace before enabling the service.

`provisioning-service-postgres` (`provisioningService.databaseSecretName`):

| Key | Required | Value |
| --- | --- | --- |
| `host` | yes | PostgreSQL host |
| `port` | no | defaults to 5432 |
| `database` | yes | a database for this service alone |
| `user` | yes | a user that owns the service's schema |
| `password` | yes | that user's password |
| `sslmode` | yes | `disable`, `require` or `verify-full` |
| `ca-cert` | no | the PEM text of the server's CA for `verify-full`; the image bakes no database CA |
| `tls-server-identity` | no | expected server name for `verify-full` |

`provisioning-service-credential-key` (`provisioningService.credentialKeySecretName`)
holds the key that encrypts stored user credentials, under `key`:

```bash
kubectl -n <namespace> create secret generic provisioning-service-credential-key \
  --from-literal=key="$(openssl rand -base64 32)"
```

Losing or changing this key makes every stored credential unreadable; keep a
copy outside the cluster.

The service also reads `admin_token` (and `admin_user_id` when present) from
`mattermost-gateway`, and `token` from `gitea-token`, which the chat and git
hosts already use.

### Limits

Each caller service account may send `provisioningService.callerRequestsPerMinute`
requests a minute (service default 3000) and hold
`provisioningService.callerConcurrentWaits` waits and watches open (default 100).
Leave them empty to use the defaults.

### Schema

There is no migration Job. Each replica creates and upgrades the service's
schema at startup under an advisory lock, so the database user must own its
schema. An image older than the schema refuses to start: rolling back across a
schema upgrade crash-loops by design. Roll forward instead.
