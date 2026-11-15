# Gateway supervisor

`gateway-supervisor/` holds everything the gateway image runs besides OpenClaw
itself. It is not one process. It contains the gateway pod's boot steps, the
runners that supervise OpenClaw and set up and reconcile each user assigned to
the gateway (the `provisioner.ts` entrypoint), and the VM agent that runs on an
isolated gateway's virtual machine. They share one package
(`@octogee/gateway-supervisor`) because they ship together in the gateway image
and share most of `lib/`.

The gateway image installs this directory at `/octogee/scripts`, its location
from before the directory had its own name. Older VM boot images and running
releases name paths under it, so the image keeps them;
[legacy names](../docs/legacy-names.md#paths-inside-the-gateway-image) lists
them.

## What starts each entrypoint

Boot steps that `gateway/entrypoint.sh` runs once, in order, before OpenClaw
starts:

| Entrypoint | What it does |
| --- | --- |
| `user-identity.ts` | Reads which user an isolated gateway's home belongs to |
| `clean-user-project-placeholders.ts` | Removes empty project placeholders left on a retained home |
| `recover-restarted-gateway-container-locks.ts` | Clears locks a killed container left behind |
| `system-config-restore.ts` | Restores each user's durable system configuration |
| `configured-user-bootstrap.ts` | Prepares the user an isolated gateway is configured for |
| `isolated-runtime-state-restore.ts` | Restores an isolated gateway's runtime state |
| `agent-anchor-restore.ts` | Restores agent anchors from their checkpoints |
| `pre-boot-config.ts` | Writes `openclaw.json` for the users the gateway serves |
| `ensure-configured-agent-runtime-dirs.ts` | Creates the configured agents' runtime directories |
| `user-claim.ts` | Records the claim an isolated gateway's home carries |
| `prepare-openclaw-sqlite-journals.ts` | Checks OpenClaw's SQLite journals before it opens them |
| `openclaw-boot-sentinel.ts` | Marks the boot phases OpenClaw passes |

Long-running runners that `gateway/entrypoint.sh` starts under
`supervise-runner.ts`, which restarts a runner that exits and records its
heartbeat:

| Runner label | Entrypoint | What wakes it |
| --- | --- | --- |
| `fleet-controller` | `provisioner.ts` | A streamed assignment watch on the platform API's fleet broker, with a 60-second repair pass (2 seconds without the watch); a 5-minute blob sync timer |
| `system-config-watch` | `system-config-watch.ts` | A file watch on the users' system configuration, with a 30-second poll |
| `byosub-syncback` | `byosub-syncback-runner.ts` | A 5-minute timer (`BYOSUB_SYNCBACK_INTERVAL_MS`) |
| `isolated-toolchain-hydrator` | `isolated-toolchain-hydrator.ts` | Runs until the isolated gateway's toolchain is in place, retrying with backoff |
| `github-cli-auth` | `github-cli-auth-hydrate.ts` | A 60-second timer |
| `surge-openclaw-supervisor` | `surge-openclaw-supervisor.ts` | Starts and supervises OpenClaw, and takes signed requests from the fleet controller on a local port |

Started by something else:

| Entrypoint | Started by |
| --- | --- |
| `prestop-flush.ts` | The gateway pod's preStop hook, and the VM runtime bundle |
| `prepare-project-storage.ts` | An init container in `charts/octogee-gateway` |
| `runner-metrics-exporter.ts` | `gateway/entrypoint.sh`, in the background |
| `source-transfer-stage.ts` (bundled), `libexec/source-transfer-launcher.py` | A fleet controller job that moves a user's files between gateways |
| `octo-desk.ts`, `octo-desktop-style.ts`, `octo-project.ts`, `octogee-config.ts` | The `octo-*` and `octogee` commands in the gateway image |
| `isolated-toolchain-command.ts` | The toolchain wrapper on an isolated gateway |
| `gitea-broker-probe.ts` | `scripts/verify-env.sh`, through `kubectl exec` |
| `vm-gateway-agent.ts` | `octo-gateway-agent` in the isolated gateway VM image, which runs it from the gateway image |
| `ops/migrate-user-stores.ts` | An operator, through `kubectl exec` |

`shared-runners/` in the image holds bundled copies of `supervise-runner`,
`provisioner`, `byosub-syncback-runner` and `runner-metrics-exporter`, which
`gateway/shared-auxiliary-runner.sh` runs.

## What it talks to

- The platform API's fleet broker, for every user setup step that needs an
  admin credential: Mattermost accounts, teams, channels and agent bots, Gitea
  organizations and repositories, object storage and secrets.
- OpenClaw on the same gateway, over its local RPC port and its files under
  `~/.openclaw`.
- The gateway's home volume: user directories, markers, locks, journals and
  checkpoints.

## Configuration

The gateway chart and the fleet controller's VM runtime bundle set the
environment. The provisioner reads `GATEWAY_ID`, `GATEWAY_CLASS`,
`FLEET_BROKER_URL`, `OCTOGEE_API_URL`, `POD_UID`, `OPENCLAW_GATEWAY_PORT`,
`OPENCLAW_GATEWAY_TOKEN` and `OPENCLAW_STATE_DIR`; `lib/config.ts` holds the
rest.

A product replaces `src/main.ts`, the composition root, through the overlay in
`scripts/ops/overlay.mjs`.

## Build and test

```bash
npm ci
npm run typecheck
npm test
```
