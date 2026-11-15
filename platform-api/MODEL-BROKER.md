# Model broker discovery

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
