#!/usr/local/bin/node
/**
 * OpenClaw exec SecretRef resolver → octogee-api byok broker → GCP Secret Manager.
 *
 * Protocol (docs/gateway/secrets.md):
 *   stdin  → { protocolVersion: 1, provider, ids: ["byok-{slug}-anthropic/latest", ...] }
 *   stdout → { protocolVersion: 1, values: {...}, errors?: {...} }
 *
 * Invocation (from openclaw.json):
 *   {
 *     "secrets": {
 *       "providers": {
 *         "gcp-secret-manager": {
 *           "source": "exec",
 *           "command": "/octogee/scripts/secret-resolver.mjs",
 *           "passEnv": ["FLEET_BROKER_URL", "OCTOGEE_API_URL", "OCTOGEE_API_SA_TOKEN_PATH", "INTERNAL_SERVICE_KEY", "OPENCLAW_AGENTS_DIR", "HOME"],
 *           "jsonOnly": true
 *         }
 *       }
 *     }
 *   }
 *
 * Auth: brokers to octogee-api with the gateway's projected KSA token
 * (x-k8s-sa-token header, /var/run/secrets/octogee-api/token). octogee-api holds
 * the Secret Manager access and roster-scopes the slug — cattle gateways hold no
 * GCP creds. The provider id stays "gcp-secret-manager" (the SecretRef contract);
 * only the resolution path moved to the broker.
 *
 * Logging: stderr only, never stdout. OpenClaw expects `jsonOnly` on
 * stdout; any non-JSON write corrupts the resolution protocol.
 *
 * ── Defense-in-depth ──────────────────────────────────────────────────────
 *
 * The OpenClaw exec protocol does NOT pass requesting-agent context to the
 * resolver (verified against fork src/secrets/resolve.ts:682-705 — only
 * `passEnv` allowlist + the `ids` array reach us). True per-call agent
 * identity enforcement requires a fork patch and is tracked as a separate
 * security follow-up.
 *
 * What we CAN do in-resolver, applied below:
 *   1. Strict id grammar — reject anything that isn't `byok-{slug}-{provider}`
 *      with a known provider and a sane slug.
 *   2. Known-slug allowlist — only resolve for slugs that have a
 *      corresponding agent dir on disk or the validated user identity.
 *   3. Audit log — every accepted/rejected id goes to stderr with id +
 *      outcome so we have a forensic trail. Cloud Logging captures stderr.
 */
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import { isValidUsername, parseAgentId } from "@octogee/shared/types/identity";
import { readUserClaimFromEnv } from "@octogee/shared/server/user-claim";

// Cattle gateways are egress-blocked from the GCP metadata server, so this
// resolver materializes byok-* keys through the octogee-api broker
// (POST /internal/byok/api-key) instead of reaching Secret Manager directly.
// KSA-authed via the gateway's projected token — same contract as
// scripts/lib/internal-fetch.ts.
//
// The DEFAULTS must work without the broker env: openclaw forwards only the
// resolver's `passEnv` allowlist, and existing gateways preserve a pre-broker
// openclaw.json (entrypoint.sh keeps the PVC config) whose passEnv predates these
// vars. So default to the same-namespace SHORT service name — k8s DNS search
// domains resolve `octogee-api` to THIS pod's namespace, correct on every
// namespace with no K8S_NAMESPACE needed — and the gateway pod's mounted
// broker-token path. FLEET_BROKER_URL / OCTOGEE_API_URL / OCTOGEE_API_SA_TOKEN_PATH
// still override when a (new) gateway passes them through.
// http is by design (in-cluster ClusterIP, no TLS); host via an env-overridable
// var, both as a single source of truth and matching the rest of the repo's
// in-cluster URL idiom.
const BROKER_HOST = process.env.OCTOGEE_API_HOST || "octogee-api";
export const BROKER_BASE_URL =
  process.env.FLEET_BROKER_URL || process.env.OCTOGEE_API_URL || `http://${BROKER_HOST}:3001`;
export const KSA_TOKEN_PATH =
  process.env.OCTOGEE_API_SA_TOKEN_PATH || "/var/run/secrets/octogee-gateway-broker/token";

// OpenClaw's exec-provider contract is batch-fatal: any entry in the errors{}
// response makes it discard the WHOLE resolution batch and cold every owner on
// this provider. A single transient broker blip therefore costs every agent its
// credentials, so each id gets one retry and broker fan-out stays bounded.
export const BROKER_ATTEMPTS = 2;
export const BROKER_ATTEMPT_TIMEOUT_MS = 2200;
export const BROKER_RETRY_BACKOFF_MS = 250;
export const BROKER_TOTAL_BUDGET_MS = 4800;
export const BROKER_CONCURRENCY = 12;

const AGENTS_DIR =
  process.env.OPENCLAW_AGENTS_DIR ||
  path.join(process.env.HOME || "/home/node", ".openclaw", "agents");

export const BYOK_API_KEY_PROVIDER_IDS = [
  "openai",
  "anthropic",
  "openrouter",
  "grok",
  "minimax",
  "openai-compatible",
];
const BYOK_ID_RE = /^byok-(?<body>[a-z0-9][a-z0-9-]{0,128})(?:\/(?<version>[a-zA-Z0-9-]{1,32}))?$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const BYOK_API_KEY_PROVIDER_SUFFIXES = BYOK_API_KEY_PROVIDER_IDS
  .map((provider) => ({ provider, suffix: `-${provider}` }))
  .sort((a, b) => b.suffix.length - a.suffix.length);

function parseByokApiKeyId(id) {
  const m = id.match(BYOK_ID_RE);
  const body = m?.groups?.body;
  if (!body) return null;
  const match = BYOK_API_KEY_PROVIDER_SUFFIXES.find(({ suffix }) => body.endsWith(suffix));
  if (!match) return null;
  const slug = body.slice(0, -match.suffix.length);
  if (!SLUG_RE.test(slug)) return null;
  return { slug, provider: match.provider, version: m.groups?.version };
}

// Per-user broker-token ref for shared (multi-tenant) gateways. Each
// agent's anthropic auth-profile resolves through this id; the broker
// mints an owner-scoped, meter-only token for it. The agentId is embedded — the
// exec protocol passes no requesting-agent context (see the header note), so the
// id IS the per-agent scope — and the slug is allowlisted exactly like byok.
const AGENT_MODEL_TOKEN_ID_RE =
  /^agent-model-token-(?:(?<provider>openrouter|openai|vertex|meta)-)?(?<agentId>octogee-[a-z0-9-]{1,64}-coach)$/;
const AGENT_EMBEDDING_TOKEN_ID_RE =
  /^agent-embedding-token-openai-(?<agentId>octogee-[a-z0-9-]{1,64}-coach)$/;
const BROKER_TOKEN_EXPIRY_DIRECTORY = "agent-model-token-expiry";

function parseAgentScopedId(id, pattern) {
  const match = id.match(pattern);
  const agentId = match?.groups?.agentId;
  if (!agentId) return null;
  const parsed = parseAgentId(agentId);
  if (parsed.kind === "unknown") return null;
  return { match, agentId, slug: parsed.username };
}

/** Scan AGENTS_DIR once at startup for the set of provisioned slugs. The
 *  gateway pod spawns a fresh resolver per resolve call (per OpenClaw's
 *  exec-provider contract — see fork src/secrets/resolve.ts:452), so any
 *  new user becomes visible on the next spawn. No TOCTOU concern
 *  within a single resolver invocation. Same env var as the provisioner's
 *  AGENTS_DIR (scripts/lib/config.ts:18-19). */
function claimedUserSlug() {
  try {
    return readUserClaimFromEnv(process.env)?.builderSlug ?? null;
  } catch (err) {
    process.stderr.write(`[secret-resolver] user claim unreadable; no user slug is admitted: ${err?.message || err}\n`);
    return null;
  }
}

function loadKnownAgentRoster() {
  const slugs = new Set();
  const agentIds = new Set();
  const builderSlug = claimedUserSlug();
  if (builderSlug && isValidUsername(builderSlug)) slugs.add(builderSlug);
  try {
    const entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const parsed = parseAgentId(e.name);
      if (parsed.kind === "unknown") continue;
      slugs.add(parsed.username);
      agentIds.add(e.name);
    }
    return { slugs, agentIds };
  } catch (err) {
    process.stderr.write(
      `[secret-resolver] could not enumerate AGENTS_DIR (${AGENTS_DIR}): ${err?.message || err}\n`,
    );
    return { slugs, agentIds };
  }
}

const KNOWN_AGENT_ROSTER = loadKnownAgentRoster();

function audit(line) {
  process.stderr.write(`[secret-resolver/audit] ${line}\n`);
}

const VALID_ID_GRAMMAR_MESSAGE =
  "id does not match byok-{slug}-{provider}[/version], an agent model token, or an OpenAI embedding token";

function scopedSlugForId(id) {
  const byok = parseByokApiKeyId(id);
  if (byok) return { slug: byok.slug };
  const agentToken = parseAgentScopedId(id, AGENT_MODEL_TOKEN_ID_RE);
  if (agentToken) return { slug: agentToken.slug, agentId: agentToken.agentId };
  const embeddingToken = parseAgentScopedId(id, AGENT_EMBEDDING_TOKEN_ID_RE);
  if (embeddingToken) return { slug: embeddingToken.slug, agentId: embeddingToken.agentId };
  return null;
}

/** Validate a single id against grammar and the gateway's on-disk agent roster. */
function validateId(id) {
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return `id is not a non-empty string ≤256 chars`;
  }
  const scope = scopedSlugForId(id);
  if (!scope) return VALID_ID_GRAMMAR_MESSAGE;
  if (!KNOWN_AGENT_ROSTER.slugs.has(scope.slug)) {
    return `slug "${scope.slug}" has no provisioned agent dir`;
  }
  if (scope.agentId && !KNOWN_AGENT_ROSTER.agentIds.has(scope.agentId)) {
    return `agent "${scope.agentId}" is not provisioned on this gateway`;
  }
  return null;
}

/** Parse the exec request from stdin (it arrives as one JSON line). */
async function readRequest() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw new Error("empty stdin");
  return JSON.parse(raw);
}

function brokerRouteFor(id) {
  // agent-model-token-{agentId} → the per-user broker-token route; every
  // other id is a byok-* key. Both routes return { value } and roster-scope
  // server-side (the resolver holds no GCP creds and no agent identity).
  const agentToken = id.match(AGENT_MODEL_TOKEN_ID_RE);
  if (agentToken) {
    return {
      route: "/internal/byok/agent-model-token",
      payload: {
        agentId: agentToken.groups.agentId,
        ...(agentToken.groups.provider ? { provider: agentToken.groups.provider } : {}),
      },
    };
  }
  const embeddingToken = id.match(AGENT_EMBEDDING_TOKEN_ID_RE);
  if (embeddingToken) {
    return {
      route: "/internal/byok/agent-model-token",
      payload: {
        agentId: embeddingToken.groups.agentId,
        provider: "openai",
        purpose: "embeddings",
      },
    };
  }
  return { route: "/internal/byok/api-key", payload: { id } };
}

function isAgentBrokerTokenRef(id) {
  return AGENT_MODEL_TOKEN_ID_RE.test(id) || AGENT_EMBEDDING_TOKEN_ID_RE.test(id);
}

function brokerTokenExpiryDirectory(expiryDir) {
  return expiryDir || path.join(process.env.HOME || "/home/node", ".openclaw", "secrets", BROKER_TOKEN_EXPIRY_DIRECTORY);
}

function recordBrokerTokenExpiry(id, expiresAt, expiryDir) {
  const directory = brokerTokenExpiryDirectory(expiryDir);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, `${Buffer.from(id, "utf8").toString("base64url")}.json`);
  const temporary = path.join(directory, `.${process.pid}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ refId: id, expiresAt })}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function recordResolvedBrokerTokenExpiry(id, expiresAt, expiryDir) {
  if (!isAgentBrokerTokenRef(id)) return;
  if (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    audit(`expiry metadata unavailable id=${JSON.stringify(id)}`);
    return;
  }
  try {
    recordBrokerTokenExpiry(id, expiresAt, expiryDir);
  } catch (error) {
    audit(`expiry metadata write failed id=${JSON.stringify(id)} reason=${JSON.stringify(error?.message || String(error))}`);
  }
}

function retryable(error) {
  const err = error instanceof Error ? error : new Error(String(error));
  err.retryable = true;
  return err;
}

/** A 5xx or a transport failure may be a blip; a 4xx is the broker's decision
 *  and a malformed 200 is a broken contract — neither heals on retry. */
async function brokerAttempt(fetchImpl, url, headers, payload, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw retryable(err);
  }
  if (!res.ok) {
    const error = new Error(`byok broker returned ${res.status}`);
    if (res.status >= 500) error.retryable = true;
    throw error;
  }
  const body = await res.json();
  if (typeof body?.value !== "string") {
    throw new Error("byok broker: malformed response (no value)");
  }
  return { value: body.value, expiresAt: body.expiresAt };
}

/**
 * Materialize one byok-* ref via the octogee-api broker. The broker re-validates
 * the id grammar, roster-scopes the slug to THIS gateway, and reads Secret
 * Manager on our behalf — the resolver holds no GCP creds. The full id
 * (byok-{slug}-{provider}[/version]) goes to the broker, which parses it. `deps`
 * (token, fetchImpl) are injectable for tests; production reads the projected KSA
 * token from disk and uses the global fetch.
 */
function resolverDeps(deps) {
  const token = deps.token ?? fs.readFileSync(KSA_TOKEN_PATH, "utf8").trim();
  const headers = { "content-type": "application/json", "x-k8s-sa-token": token };
  if (process.env.INTERNAL_SERVICE_KEY) {
    headers["x-internal-service-key"] = process.env.INTERNAL_SERVICE_KEY;
  }
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    attemptTimeoutMs: deps.requestTimeoutMs ?? BROKER_ATTEMPT_TIMEOUT_MS,
    backoffMs: deps.retryBackoffMs ?? BROKER_RETRY_BACKOFF_MS,
    budgetMs: deps.budgetMs ?? BROKER_TOTAL_BUDGET_MS,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: deps.now ?? Date.now,
    expiryDir: deps.expiryDir,
    headers,
  };
}

export async function resolveOne(id, deps = {}) {
  const { fetchImpl, attemptTimeoutMs, backoffMs, budgetMs, sleep, now, expiryDir, headers } =
    resolverDeps(deps);
  const { route, payload } = brokerRouteFor(id);
  const url = `${BROKER_BASE_URL}${route}`;
  const startedAt = now();
  const remainingMs = () => budgetMs - (now() - startedAt);

  for (let attempt = 1; ; attempt++) {
    try {
      const resolved = await brokerAttempt(
        fetchImpl,
        url,
        headers,
        payload,
        Math.min(attemptTimeoutMs, Math.max(1, remainingMs())),
      );
      recordResolvedBrokerTokenExpiry(id, resolved.expiresAt, expiryDir);
      return resolved.value;
    } catch (err) {
      const budgetLeft = remainingMs() - backoffMs;
      if (attempt >= BROKER_ATTEMPTS || err?.retryable !== true || budgetLeft <= 0) throw err;
      audit(`retry id=${JSON.stringify(id)} attempt=${attempt} reason=${JSON.stringify(err.message)}`);
      await sleep(backoffMs);
    }
  }
}

export async function resolveBatch(ids, resolve = resolveOne) {
  const values = {};
  const errors = {};
  let next = 0;

  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= ids.length) return;
      const id = ids[index];
      try {
        values[id] = await resolve(id);
      } catch (err) {
        errors[id] = { message: err?.message || String(err) };
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(BROKER_CONCURRENCY, ids.length) },
      () => worker(),
    ),
  );
  return { values, errors };
}

/** Cap on per-call audit-log lines for rejects. A flood of rejects
 *  (probing for slugs, malformed ids) shouldn't be able to run up the
 *  Cloud Logging bill or hide a single legitimate access in a haystack
 *  of decoys. The errors[] response still surfaces every rejected id to
 *  the caller — this only caps the stderr forensic trail. */
const MAX_AUDIT_REJECTS_PER_CALL = 10;

async function main() {
  const req = await readRequest();
  const ids = Array.isArray(req.ids) ? req.ids : [];
  const values = {};
  const errors = {};

  // Validate up front — reject malformed ids and unknown slugs BEFORE any
  // GCP SM round-trip. Each rejected id surfaces as `errors[id]` and never
  // touches the network. Audit every decision (accept + reject) to stderr,
  // with a per-call cap on rejects to prevent log floods.
  const accepted = [];
  let rejectAuditCount = 0;
  let rejectTotal = 0;
  for (const id of ids) {
    const reason = validateId(id);
    if (reason) {
      rejectTotal++;
      if (rejectAuditCount < MAX_AUDIT_REJECTS_PER_CALL) {
        audit(`reject id=${JSON.stringify(id)} reason=${JSON.stringify(reason)}`);
        rejectAuditCount++;
      }
      errors[id] = { message: `Refused by resolver: ${reason}` };
      continue;
    }
    audit(`accept id=${JSON.stringify(id)}`);
    accepted.push(id);
  }
  if (rejectTotal > MAX_AUDIT_REJECTS_PER_CALL) {
    audit(`reject-summary suppressed=${rejectTotal - MAX_AUDIT_REJECTS_PER_CALL} (cap=${MAX_AUDIT_REJECTS_PER_CALL})`);
  }

  const resolved = await resolveBatch(accepted);
  Object.assign(values, resolved.values);
  Object.assign(errors, resolved.errors);

  const response = { protocolVersion: 1, values };
  if (Object.keys(errors).length > 0) response.errors = errors;
  process.stdout.write(JSON.stringify(response) + "\n");
}

// Run main() only when invoked directly (node secret-resolver.mjs), not when a
// test imports resolveOne for unit coverage.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    // Protocol-level failure — write an `errors._all` sentinel so OpenClaw
    // can surface the problem without crashing the resolver loop.
    process.stderr.write(`[secret-resolver] fatal: ${err?.stack || err}\n`);
    process.stdout.write(
      JSON.stringify({
        protocolVersion: 1,
        values: {},
        errors: { _all: { message: err?.message || String(err) } },
      }) + "\n",
    );
    process.exit(0);
  });
}
