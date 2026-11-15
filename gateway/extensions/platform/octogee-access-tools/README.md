# Octogee Access Tools

An OpenClaw plugin for [octogee-cloud](https://github.com/octogee-ai/octogee-cloud)
gateways. When one user's agent tries to control another user's VM, the plugin
holds the action until the VM's owner approves it.

## Where it works

The plugin is the gateway side of an octogee-cloud API, so it only works on an
octogee-cloud gateway. It needs:

- octogee-cloud's OpenClaw build, version 2026.11.3 or later;
- the octogee-cloud API (`octogee-api`) reachable from the gateway;
- a Kubernetes service account token that `octogee-api` accepts, mounted in the
  gateway pod.

On any other OpenClaw host the plugin cannot reach `octogee-api`, so it blocks
every `computer`, `browser` and `nodes` tool call. Do not install it outside
octogee-cloud.

The owner-only approval check relies on two OpenClaw hook fields,
`requireApproval.reviewerGuard` and `requester.getAuthenticatedIdentity`.
octogee-cloud's OpenClaw build has them; upstream OpenClaw releases do not yet.
Without them OpenClaw ignores the reviewer check, so any approver could approve
the action.

## What it does

The plugin registers a `before_tool_call` hook. For each `computer`, `browser`
or `nodes` tool call it:

1. Asks `octogee-api` (`POST /internal/computer/agent-context`) which user owns
   the VM the agent would act on.
2. Lets the call run when the requester is that owner: a signed-in user with
   the owner's id, or the owner's Mattermost account writing to the
   agent's Mattermost account.
3. Otherwise asks for approval, with the choices "allow once" and "deny" and a
   five-minute timeout. Only the owner can approve. Before the approval takes
   effect, the plugin reads the VM's owner again and refuses if the owner or the
   VM changed.
4. Blocks the call when there is no active agent task, the requester cannot be
   verified, or `octogee-api` does not answer.

## Configuration

| Key         | Default                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `brokerUrl` | `FLEET_BROKER_URL`, then `OCTOGEE_API_URL`, then `http://octogee-api.<K8S_NAMESPACE or octogee>.svc.cluster.local:3001` |
| `tokenPath` | `/var/run/octogee/api-token/token`                                                                                   |

octogee-cloud's gateway configuration sets both:

```json
"octogee-access-tools": {
  "enabled": true,
  "config": {
    "brokerUrl": "${FLEET_BROKER_URL}",
    "tokenPath": "${OCTOGEE_API_SA_TOKEN_PATH}"
  }
}
```

## Install

octogee-cloud builds this plugin into its gateway image, so operators do not
install it separately. The ClawHub package is the same build, published so the
release can be reviewed and installed on gateways built another way:

```sh
openclaw plugins install clawhub:@octogee-ai/octogee-access-tools
```

## Development

```sh
cd gateway/extensions/platform/octogee-access-tools
npm ci
npm test
```

The gateway image build (`gateway/build-extensions.mjs`) bundles
`index.ts` and its dependencies into one `index.js`, which is the entry
`package.json` declares.

## Releasing

1. Set the new version in both `package.json` and `openclaw.plugin.json`, and
   merge the change.
2. Tag the merged commit `octogee-access-tools-v<version>` and push the tag.

The [Publish plugin](https://github.com/octogee-ai/octogee-cloud/blob/main/.github/workflows/publish-plugin.yml)
workflow builds the same `index.js` the gateway image ships and publishes it to
ClawHub as `@octogee-ai/octogee-access-tools`.

## License

MIT. See [LICENSE](https://github.com/octogee-ai/octogee-cloud/blob/main/LICENSE).
