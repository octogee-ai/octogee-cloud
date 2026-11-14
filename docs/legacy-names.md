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

## Names that are renamed instead

Stored values that a rename can still reach, such as operation kinds, the
gateway class and Admin API fields, are not on this page. They move to a
neutral name over one release that reads both spellings, and the release after
it stops reading the old one.
