# LLM broker

The LLM broker is the cluster service that holds the platform's model provider
keys. Agents on isolated and shared gateways never see those keys. Each gateway
gets per-gateway broker tokens from the API, and the broker exchanges a valid
token for an upstream model call. The broker checks the token, the owner's
access, the owner's model grant and spend limits, meters the call, and records
its usage.

## How it runs

`src/main.ts` is the operator composition root. It reads the platform state
store and the usage ledger from PostgreSQL, registers the operator rail, and
listens on `PORT` (default `3010`). The release runs it from the `octogee-api`
image:

```sh
node node_modules/@octogee/llm-broker/dist/main.js
```

```sh
npm ci
npm run build
npm test
```

## HTTP surface

| Route | Purpose |
| ----- | ------- |
| `GET /healthz` | Liveness, plus which providers have a credential configured. |
| `GET /v1/catalog` | Model discovery for the presented broker token (see below). |
| `/v1/*` | Relay to the token's provider. Only listed endpoints pass. |

Relayed endpoints by provider:

- Anthropic: `GET /v1/models`, `POST /v1/messages`, `POST /v1/messages/count_tokens`
- OpenRouter: `GET /v1/models`, `POST /v1/chat/completions`
- OpenAI: `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/embeddings`
- Vertex: `POST /v1/messages`

Tokens arrive in `x-api-key` or `Authorization: Bearer`. Unknown, expired or
revoked tokens get 401. An upstream that sends no headers in time gets 504, and
other upstream failures get 502.

## Configuration

| Variable | Meaning |
| -------- | ------- |
| `PORT` | Listen port, default `3010`. |
| `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `META_MODEL_API_KEY` | Platform provider keys. A user's own provider credential replaces the platform key where one is stored. |
| `ANTHROPIC_UPSTREAM_BASE_URL`, `OPENROUTER_UPSTREAM_BASE_URL`, `OPENAI_UPSTREAM_BASE_URL` | Upstream overrides. |
| `LLM_BROKER_HOUSE_MODEL`, `LLM_BROKER_OPENROUTER_HOUSE_MODEL`, `LLM_BROKER_OPENAI_HOUSE_MODEL`, `LLM_BROKER_VERTEX_HOUSE_MODEL` | The model a degraded request falls back to, per provider. The platform config's model dial overrides these. |
| `MODEL_BROKER_REQUESTS_PER_MINUTE`, `MODEL_BROKER_SPEND_WINDOW_USD`, `MODEL_BROKER_SPEND_WEEK_USD` | Default limits for owners with no explicit grant. |
| `LLM_BROKER_GRANT_CACHE_TTL_MS` | How long a resolved owner grant is cached. |
| `PLATFORM_VERTEX_ENABLED`, `PLATFORM_VERTEX_PROJECT_ID`, `PLATFORM_VERTEX_LOCATION`, `PLATFORM_VERTEX_MODEL_PRICES`, `VERTEX_UPSTREAM_BASE_URL` | Vertex routing, authenticated with the pod's workload identity. |
| `PLATFORM_DB_*` | The platform state database (see `@octogee/core/platform-state`). |

## Rails

A rail decides how a call is gated, metered and charged. The operator rail
(`operatorRailRegistry()` in `src/rails.ts`) admits every owner within the
spend limits and charges at cost. To add policy, build a registry with
`createModelBrokerRailRegistry({ rails, defaultRailId, ... })` and pass it to
`createLlmBrokerApp` from `@octogee/llm-broker/app` in your own composition
root. A rail implements `ModelBrokerRail`: `requiresGate`, `gate`,
`budgetExhausted`, `meter`, `allowance`, `throttle` and `logFields`. The
registry can also resolve an owner's rail profile, describe a funded budget and
name a balance ledger.

## Package interface

The `exports` map in `package.json` lists every public module. The API imports
the token store, rails, limits, budget and usage types from it, so the API and
the broker share one implementation.

## Model discovery
`GET /v1/catalog` accepts an issued model credential through `x-api-key` or
`Authorization: Bearer`. It reports only that credential's provider, issued
agent attribution, supported HTTP routes and registered models. Caller-supplied
owner, agent or provider fields do not change its scope. Embeddings credentials
cannot read this catalog.

The response has `schemaVersion: 1`, `providerCredentialConfigured: true` and
`admission: "request-time"`. Configuration and registration do not certify that
an upstream account or budget will admit a model call. Existing inference gates
still decide billing, degradation, throttling and executable routing for each
request. Discovery does not call those gates, reserve spend or contact a model
provider. Missing model pricing stays absent; present prices use numeric USD per
million tokens in the shared catalog's `pricing` fields.

Discovery checks token validity and current owner access before reading provider
credential configuration and again before responding. Responses use
`Cache-Control: no-store`. Unknown, expired or revoked tokens receive 401;
inactive owners and embeddings-only tokens receive 403; unavailable credentials
or metadata receive 503. Credentials and internal diagnostic details are omitted.

This endpoint exposes no private balance, spend limit or usage event. Private
usage remains behind the existing owner-authorized API. Native's Gateway-wide
`usage.status` cache must not hold those private balances. The Native provider
adapter and owner-authorized inspection integration remain separate work; this
HTTP response is not a ClawRouter compatibility contract.
