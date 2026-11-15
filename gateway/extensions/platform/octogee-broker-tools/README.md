# Octogee Broker Discovery

An OpenClaw plugin for [octogee-cloud](https://github.com/octogee-ai/octogee-cloud)
gateways. It:

- lists the models each agent's own broker credential can use, in the model
  picker and in the runtime model catalog;
- lets the agent's owner read that agent's broker usage;
- adds the broker auth profiles an agent needs when the operator asks.

## Where it works

The plugin talks to octogee-cloud's model broker and API, so it only does
anything on an octogee-cloud gateway. It needs:

- octogee-cloud's OpenClaw build, version 2026.11.3 or later;
- the model broker at the provider base URLs octogee-cloud sets on the gateway:
  `ANTHROPIC_BASE_URL`, `PLATFORM_OPENAI_BASE_URL`, `OPENROUTER_BASE_URL`,
  `PLATFORM_META_BASE_URL` and `PLATFORM_VERTEX_BASE_URL`;
- agents with octogee-cloud's agent ids, whose provider credentials are stored
  as `gcp-secret-manager` exec SecretRefs;
- the octogee-cloud API (`octogee-api`) and a Kubernetes service account token
  it accepts, for usage reads.

On another OpenClaw host the plugin loads, but discovery finds no models and
usage reads report the broker as unavailable.

## Model discovery

The plugin registers the provider `octogee-broker`, which runs late in catalog
discovery, and a live catalog for text models. For each of `anthropic`,
`platform-openai`, `platform-openrouter`, `platform-meta` and `platform-vertex`
whose configured base URL matches its environment variable, it:

1. resolves the agent's own credential for that provider;
2. reads `<broker>/v1/catalog` with that credential;
3. keeps the response only when it names the same agent, provider and model
   purpose, and offers a route for the provider's configured API;
4. resolves the credential and the agent again before returning any rows.

Each read stops after 2 MiB or eight seconds, and nothing is cached. Costs are
USD per million tokens. A model without complete runtime metadata or pricing
shows in the picker with a warning and is left out of the runtime catalog.

Discovery does not admit inference or reserve spend; the broker checks each
inference request. The plugin does not replace the `anthropic` or `platform-*`
providers or their auth, and its usage hooks report usage as handled with no
data, so OpenClaw shows no usage from other sources for it.

## Usage reads

Gateway method `octogee.broker.inspect`, scope `operator.read`. Parameters:
`{ "agentId": "<agent id>" }`.

The caller must be a signed-in user with a profile and current authority, and
the plugin checks that again after each step. It posts the agent id and the
caller's user id to `octogee-api` at `/internal/byok/broker-inspect`, signed
with the gateway's service account token; `octogee-api` checks that the caller
owns the agent. The plugin returns only a fixed set of usage fields, such as the
current usage window, the weekly reset and any credit balance. An inference
token cannot read them, and no separate read token is issued.

## Broker auth profiles

Gateway method `octogee.brokerProfiles.materialize`, scope `operator.admin`.
Parameters: `{ "agentIds": ["<agent id>", ...] }`, 1 to 128 ids. Each id must
have octogee-cloud's agent id form, `octogee-<user>-coach` or
`octogee-<user>-proj-<project>-coach`, which is the form its secret resolver
serves `agent-model-token-*` secrets for.

For each agent on the gateway's roster, the plugin adds any missing broker auth
profiles: `anthropic:default`, plus `platform-openrouter:default`,
`platform-openai:default`, `platform-meta:default` and
`platform-vertex:default` when that provider's base URL is set. It refuses when
an existing profile with the same id points at a different credential.

## Configuration

| Key         | When unset                                                           |
| ----------- | -------------------------------------------------------------------- |
| `brokerUrl` | `FLEET_BROKER_URL`, then `OCTOGEE_API_URL`; there is no default      |
| `tokenPath` | `OCTOGEE_API_SA_TOKEN_PATH`, then `/var/run/octogee/api-token/token` |

Both are used only for usage reads. With no broker URL, usage reads respond
unavailable and the gateway log says which settings to set. octogee-cloud's
gateway configuration sets them:

```json
"octogee-broker-tools": {
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
openclaw plugins install clawhub:@octogee-ai/octogee-broker-tools
```

## Development

```sh
cd gateway/extensions/platform/octogee-broker-tools
npm ci
npm test
```

To check the plugin against an exact, clean OpenClaw source checkout:

```sh
node gateway/verify-broker-plugin-contract.mjs <source> <full-sha>
node gateway/verify-broker-plugin-runtime.mjs <source> <full-sha>
```

The runtime check builds the bundle the gateway ships, loads it with the
installed OpenClaw SDK next to the original Anthropic provider, checks that
usage is suppressed, and resolves a synthetic agent credential through the
catalog callback. It does not run live inference, a deployed image or user
credentials.

## Releasing

1. Set the new version in both `package.json` and `openclaw.plugin.json`, and
   merge the change.
2. Tag the merged commit `octogee-broker-tools-v<version>` and push the tag.

The [Publish plugin](https://github.com/octogee-ai/octogee-cloud/blob/main/.github/workflows/publish-plugin.yml)
workflow builds the same `index.js` the gateway image ships and publishes it to
ClawHub as `@octogee-ai/octogee-broker-tools`.

## License

MIT. See [LICENSE](https://github.com/octogee-ai/octogee-cloud/blob/main/LICENSE).
