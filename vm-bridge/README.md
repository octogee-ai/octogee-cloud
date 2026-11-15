# VM bridge

A TCP proxy that lets an isolated gateway running on a Google Cloud virtual
machine reach the platform services inside the cluster. A gateway pod reaches
them through cluster DNS; a virtual machine is outside the cluster and cannot,
so it connects to the bridge's internal load balancer instead.

It forwards connections and does nothing else: it terminates no TLS, checks no
credential and keeps no state. The services behind it authenticate each
caller as they do for a gateway pod.

## How it runs

| What | Where |
| --- | --- |
| Image | `ghcr.io/octogee-ai/octogee-cloud/vm-bridge`, built from [`Dockerfile`](Dockerfile): the unprivileged nginx Alpine image with its OS packages upgraded |
| Workload | Deployment `octogee-vm-bridge`, two replicas, no service account token |
| Service | `octogee-vm-bridge`, an internal `LoadBalancer` open only to `global.computer.cidr` |
| Chart | [`charts/octogee/templates/vm-bridge.yaml`](../charts/octogee/templates/vm-bridge.yaml), rendered only when `global.computer.enabled` is set |

The image has no configuration of its own. The chart writes the nginx `stream`
configuration into the ConfigMap `octogee-vm-bridge-nginx` and mounts it over
`/etc/nginx/nginx.conf`.

## What it forwards

| Port | To |
| --- | --- |
| 3001 | The platform API, Service `octogee-api` |
| 8065 | Mattermost |
| 3000 | Gitea over HTTP |
| 2222 | Gitea over SSH |
| `llmBroker.port`, 3010 by default | The LLM broker |
| `npmCacheProxy.port`, 3005 by default | The npm cache proxy, when `npmCacheProxy.enabled` is set |

A NetworkPolicy admits connections only from `global.computer.cidr` on those
ports and lets the bridge connect only to DNS and to those services.

The same template binds the `system:auth-delegator` cluster role to the
virtual machines' Google service account, `global.computer.serviceAccountEmail`,
so a gateway on a virtual machine can have the cluster review Kubernetes
service account tokens.

## Configuration

All of it is in the platform chart's values:

| Value | What it is |
| --- | --- |
| `global.computer.enabled` | Installs the bridge |
| `global.computer.cidr` | The subnet the virtual machines run in |
| `global.computer.serviceAccountEmail` | The virtual machines' Google service account |
| `global.computer.bridge.image.*` | The bridge image; `repository`, `tag` and `digest` are all required |
| `networkPolicy.nodeLocalDnsCidr` | The DNS resolver nginx uses to look up the services |

The fleet controller reads the load balancer address of the Service named by
its `GATEWAY_VM_BRIDGE_SERVICE` variable, `octogee-vm-bridge` by default, and
gives it to each virtual machine
([`fleet-controller/src/vm-gateway-runtime.ts`](../fleet-controller/src/vm-gateway-runtime.ts)).

## Build and test

```bash
docker build -f vm-bridge/Dockerfile .
```

There is no code to test here.
[`tests/specs/helm-vm-bridge-image.spec.ts`](../tests/specs/helm-vm-bridge-image.spec.ts)
renders the template.
