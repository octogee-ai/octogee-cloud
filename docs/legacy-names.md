# Legacy names

octogee-cloud began inside a product, and some names from that time are
stored in places a rename cannot reach safely: durable user state, chat and
git history, cloud resources that cannot be renamed, and image paths that
recorded releases pin. These names keep their spelling for good. Code that
works with them uses neutral identifiers. Only the stored or visible value
keeps the old word.

"Computer" and "VM" both mean the virtual machine an isolated gateway runs
on. Both are ordinary platform words, so names with "computer" in them are
not on this page.

## Agents, chat and git

| Name | What it is | Why it stays |
| --- | --- | --- |
| `octogee-{slug}-coach` | OpenClaw agent id of a user's default agent | It keys the agent's state directory, sessions, cron jobs and agent store on every gateway |
| `octogee-{slug}-proj-{project}-coach` | OpenClaw agent id of a project agent | Same as above |
| `{slug}-coach`, `{slug}-proj-{project}-coach` | Mattermost bot usernames, and the OpenClaw Mattermost account ids | Users see them, and message history refers to them |
| `{slug}-coach` | Mattermost channel where a user talks to their default agent | Message history lives in it |
| `project_coaches` | Gitea repository in each workspace organization that holds project agent files | Every workspace already has it |

## Files on a gateway home

| Name | What it is | Why it stays |
| --- | --- | --- |
| `~/.openclaw/customers/{slug}` | A user's directory on a gateway | Every home already holds it. `openclaw.json` points at it through the plugin setting `customersRoot` |
| `CUSTOMERS_DIR` | The environment variable `customersRoot` expands | `openclaw.json` files on homes refer to it by name |
| `~/.openclaw/customer-keys` | Per-user key directory | Every home already holds it |
| `builder-claim.json` | Ownership claim on an isolated gateway's home | The VM agent refuses to start a gateway if the claim does not match |
| `.builder-native-initial-state.json`, `.builder-store-migration.json` | Markers on an isolated gateway's home | Homes created earlier carry them |
| `octogee-customer-git-v3` | Version marker of a user's workspace git layout | Checkouts on homes carry it |

## Storage and images

| Name | What it is | Why it stays |
| --- | --- | --- |
| `customers/{slug}/` | Object storage prefix for a user's files, home checkpoints and runtime state | All user data in object storage lives under it |
| `octogee-gateway-builder`, `octogee-gateway-builder-base` | Artifact Registry paths of the isolated gateway image | Recorded releases and the build manifests of past builds pin these paths |
| `glm-controller`, `octogee-api` | Image names, Kubernetes deployments, service accounts, Helm subcharts and log prefixes of the fleet controller (built from `fleet-controller/`) and the platform API (built from `platform-api/`) | Recorded releases, the image manifests of past builds, cluster role bindings and Workload Identity bindings name them |
| `/octogee-api`, `dist/octogee-api/src/` | Paths inside the platform API image | Chart commands of running releases name them |

## Names that are renamed instead

Stored values that a rename can still reach, such as operation kinds, the
gateway class and Admin API fields, are not on this page. They move to a
neutral name over one release that reads both spellings, and the release after
it stops reading the old one.

## Source directories in v0.1.0

The source directories were renamed after v0.1.0, so that each is named after
the component it holds. A checkout of v0.1.0, and commits and links from before
15 November 2026, use the earlier names:

| In v0.1.0 | Now |
| --- | --- |
| `glm-controller/` | `fleet-controller/` |
| `octogee-api/` | `platform-api/` |
| `helm/` | `charts/` |
| `infra/gateway/` | `gateway/` |
| `infra/desktop/` | `desktop/` |
| `infra/vm-bridge/` | `vm-bridge/` |
| `infra/cloud-sql/` | `deploy/cloud-sql/` |
| `scripts/entrypoints/fleet-controller.ts` | `gateway-supervisor/entrypoints/provisioner.ts` |

The guides and scripts in a checkout match that checkout. When you install a
release, follow the guides at its tag.

## Paths inside the gateway image

The gateway image's runtime is built from `gateway-supervisor/` but keeps its place in
the image at `/octogee/scripts`. Consumers that can be older than the gateway
image name paths under it, so these paths stay:

| Path in the gateway image | Who names it | Why it stays |
| --- | --- | --- |
| `/octogee/scripts` (working directory) and `/octogee/scripts/entrypoints/vm-gateway-agent.ts` | `octo-gateway-agent` in the isolated gateway VM boot image | A retained or suspended VM boots an older boot image that pulls the new gateway image |
| `/octogee/scripts/secret-resolver.mjs` | The VM runtime bundle the fleet controller renders, the `octogee-gateway` chart, `core` (BYOT sync), and `openclaw.json` on gateway homes | Isolated gateways keep running older images while the controller and chart move ahead, and homes keep their `openclaw.json` |
| `/octogee/scripts/libexec/source-transfer-launcher.py` | The fleet controller's source transfer job, run inside the source gateway's image | The source gateway's image can be older than the controller |
| `/octogee/scripts/package.json` | `core`'s gateway restart probe and `gateway/apply-gateway-class-policy.mjs`, as the anchor they resolve modules from | Only its location is read |
| `/octogee/scripts/entrypoints/*.ts`, `/octogee/scripts/shared-runners/*.mjs` | `gateway/entrypoint.sh`, `gateway/shared-auxiliary-runner.sh` and the `octo-*` wrappers | They are built into the same image, but stay with the rest of the tree |
| `/octogee/scripts/ops/migrate-user-stores.ts` | Operators, run with `kubectl exec` in a gateway pod | Operator runbooks name it |
| `entrypoints/provisioner.ts` and its runner label `fleet-controller` | `gateway/entrypoint.sh` and `gateway/shared-auxiliary-runner.sh` | The runner heartbeat, its metrics and the logs carry the label, so it stays stable across releases |
