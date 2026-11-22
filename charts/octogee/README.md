# octogee chart

## Provisioning service

The provisioning service creates each user's chat and git presence and issues
their chat credentials. It is off by default; set `provisioningService.enabled:
true` with an image to run it. While it is off the chart renders exactly what it
rendered before the service existed.

Set both `glm-controller.provisioningService.url` and
`octogee-api.provisioningService.url` to the service's in-cluster HTTP URL
to use it for provisioning, for example
`http://provisioning-service.<namespace>.svc.cluster.local:8080` at the
default port. The controller writes specs and mirrors results. The API
reads those results and manages per-pod Git keys through the service.

It runs two replicas behind a cluster-internal Service. Only the fleet
controller and the platform API may call it, and they authenticate with
projected service account tokens it checks through TokenReview. Enabling it
therefore requires `gatewayFleet.tokenReviewRbac.enabled`; the chart refuses to
render without that grant.

The service gives each caller its roles by service account name. The chart
passes it the names the two caller Deployments run as: `glm-controller` for the
fleet controller and `octogee-api.serviceAccountName` for the platform API. A
caller under any other service account is answered `403`.

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

## Preview gateway

The preview gateway serves previews at `https://<label>.<domain>/` through a
GKE Gateway of class `gke-l7-global-external-managed`, separate from the edge
Ingress. Every host under the domain reaches the platform API, which decides
from the `Host` header what to serve. It is off by default, and while it is off
the chart renders exactly what it rendered before.

Turn on the Gateway API on the cluster first, and create the address,
certificate map and Cloud Armor policy outside the chart. Then set:

| Value | Meaning |
| --- | --- |
| `previewGateway.enabled` | `true` to render the gateway |
| `previewGateway.domain` | base domain, such as `previews.example.com`; the gateway serves `*.<domain>` |
| `previewGateway.certificateMapName` | Certificate Manager certificate map, by name, with a certificate for `*.<domain>` |
| `previewGateway.staticIpName` | reserved global external IP address, by name |
| `previewGateway.securityPolicyName` | Cloud Armor backend security policy, by name |
| `previewGateway.name` | optional; names the Gateway and HTTPRoute (default `preview-gateway`) |

A Certificate Manager wildcard certificate needs DNS authorization. Point the
wildcard DNS record at the address without a proxy in front, so Cloud Armor
sees client addresses.

The chart renders the Gateway with one HTTPS listener on port 443, an
HTTPRoute, and a Service named `<name>-backend` that selects the platform API
pods. A `GCPBackendPolicy` applies the Cloud Armor policy to that Service and a
`HealthCheckPolicy` checks `/health` on the serving port. The Service is
separate from `octogee-api` so these policies never meet the edge Ingress
`BackendConfig`. There is no HTTP listener; serve the domain over HTTPS only,
for example from a top-level domain on the HSTS preload list.

The Gateway reaches the pods through container-native load balancing with
`GCE_VM_IP_PORT` zonal NEGs
([GatewayClass capabilities](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/gatewayclass-capabilities)).
For those backends a global external Application Load Balancer sends traffic
from `35.191.0.0/16` and `130.211.0.0/22` and health checks from
`35.191.0.0/16`
([firewall rules](https://docs.cloud.google.com/load-balancing/docs/firewall-rules)).
With `networkPolicy.enforceDefaultDeny`, `octogee-api-ingress` already allows
those ranges on the API port, so the gateway needs no further policy.
