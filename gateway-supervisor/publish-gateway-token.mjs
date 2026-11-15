#!/usr/bin/env node
/**
 * publish-gateway-token.mjs — push the gateway's freshly generated auth
 * token into GCP Secret Manager so chat-proxy can authenticate upstream
 * WS connections without ever seeing the token on disk.
 *
 * Called once per gateway pod boot from entrypoint.sh AFTER the token
 * is generated and exported as OPENCLAW_GATEWAY_TOKEN. chat-proxy fetches
 * the latest version of the same secret when it opens an upstream.
 *
 * Secret name: `gateway-auth-token-{gatewayId}` (e.g. `gateway-auth-token-gw-test`).
 * One secret per gateway-id keeps future multi-pod fleets cleanly scoped
 * (each pod rotates its own secret; chat-proxy resolves the right secret
 * from the user's assigned gatewayId in Firestore).
 *
 * Stays tight: logs to stderr only (stdout reserved for future JSON-RPC
 * callers).
 *
 * Exit codes (entrypoint.sh keys off these):
 *   0   — published successfully
 *   2   — setup-incomplete: secret missing, permission denied, or similar
 *         misconfigured-deploy failure. entrypoint.sh treats this as FATAL
 *         and crash-loops the pod so the operator fixes setup-secrets.sh
 *         before any traffic hits a broken gateway.
 *   1   — transient SM error (UNAVAILABLE, rate-limit, DNS blip). entrypoint
 *         treats this as WARN-and-continue; the pod still boots for ops
 *         traffic, and the next boot republishes.
 *
 * Required env:
 *   OPENCLAW_GATEWAY_TOKEN  — the token value to publish
 *   GCP_PROJECT_ID          — GCP project owning the Secret Manager secret
 *   GATEWAY_ID              — gateway identifier, feeds the secret name
 *
 * Optional:
 *   GATEWAY_TOKEN_KEEP_VERSIONS — how many prior versions to retain. Floor 2.
 */

// Exit codes referenced by entrypoint.sh.
const EXIT_TRANSIENT = 1;
const EXIT_SETUP_INCOMPLETE = 2;
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
const PROJECT_ID = process.env.GCP_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT ?? "";
const GATEWAY_ID = process.env.GATEWAY_ID ?? "";
// Floor at 2 — the stale-cache overlap window in chat-proxy
// (gateway-token.ts TTL=30s) requires at least two enabled versions so a
// cache hit on the prior version stays valid while the fresh publish
// propagates. An operator setting KEEP_VERSIONS=1 combined with a rolling
// gateway update could otherwise double-prune down to zero enabled
// versions under a race.
const KEEP_VERSIONS = Math.max(
  2,
  Number.parseInt(process.env.GATEWAY_TOKEN_KEEP_VERSIONS ?? "2", 10) || 2,
);

function log(msg) {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  process.stderr.write(`${ts} [publish-gateway-token] ${msg}\n`);
}

if (!TOKEN) {
  log("OPENCLAW_GATEWAY_TOKEN unset — nothing to publish");
  process.exit(0);
}
if (!PROJECT_ID) {
  log("GCP_PROJECT_ID unset — skipping publish (local dev or misconfigured)");
  process.exit(0);
}
if (!GATEWAY_ID || !/^[a-z0-9-]+$/.test(GATEWAY_ID)) {
  log(`GATEWAY_ID missing or invalid (${JSON.stringify(GATEWAY_ID)}) — skipping publish`);
  process.exit(0);
}

const SECRET_ID = `gateway-auth-token-${GATEWAY_ID}`;
const PARENT = `projects/${PROJECT_ID}`;
const SECRET_NAME = `${PARENT}/secrets/${SECRET_ID}`;

const client = new SecretManagerServiceClient();

const SETUP_INCOMPLETE = "setup-incomplete";

/** Classify an SM error — did setup-secrets.sh fail to run (fatal for
 *  deploy), or is this a transient GCP blip (warn + continue)? */
function classifyError(err) {
  const code = err?.code;
  // gRPC canonical codes (https://grpc.github.io/grpc/core/md_doc_statuscodes.html):
  //   5  NOT_FOUND         — secret doesn't exist. Setup incomplete.
  //   7  PERMISSION_DENIED — IAM binding missing. Setup incomplete.
  //   9  FAILED_PRECONDITION / ALREADY_EXISTS — ambiguous, treat as transient.
  //  14  UNAVAILABLE       — SM down / rate-limited. Transient.
  //  16  UNAUTHENTICATED   — Workload Identity misconfigured. Setup incomplete.
  if (code === 5 || code === 7 || code === 16) return SETUP_INCOMPLETE;
  return "transient";
}

async function main() {
  // The secret shell is pre-created by scripts/setup-secrets.sh with IAM
  // bindings already in place. If it's missing that's a setup-incomplete
  // failure — we exit EXIT_SETUP_INCOMPLETE so entrypoint.sh crash-loops
  // the pod. The operator fixes provisioning before any traffic hits a
  // gateway that can't be authenticated against.
  try {
    await client.getSecret({ name: SECRET_NAME });
  } catch (err) {
    const kind = classifyError(err);
    log(
      `GATEWAY_AUTH_PUBLISH_FAILED: cannot fetch secret shell ${SECRET_ID} ` +
        `in project ${PROJECT_ID} (${kind}) — ${err.message}. ` +
        (kind === SETUP_INCOMPLETE
          ? "Run setup-secrets.sh --env=... to provision."
          : "SM likely transiently unavailable — next boot will retry."),
    );
    process.exit(kind === SETUP_INCOMPLETE ? EXIT_SETUP_INCOMPLETE : EXIT_TRANSIENT);
  }

  // Add the new version FIRST, then prune — so there's always at least
  // one usable version in the secret even if the prune step races a
  // chat-proxy fetch.
  let added;
  try {
    [added] = await client.addSecretVersion({
      parent: SECRET_NAME,
      payload: { data: Buffer.from(TOKEN, "utf8") },
    });
  } catch (err) {
    const kind = classifyError(err);
    log(
      `GATEWAY_AUTH_PUBLISH_FAILED: addSecretVersion on ${SECRET_ID} (${kind}) — ${err.message}`,
    );
    process.exit(kind === SETUP_INCOMPLETE ? EXIT_SETUP_INCOMPLETE : EXIT_TRANSIENT);
  }
  const newVersion = added.name?.split("/").pop() ?? "?";
  log(`published version ${newVersion} of ${SECRET_ID}`);

  // Prune: destroy any enabled versions older than the last KEEP_VERSIONS.
  // `destroy` is irreversible but saves storage + keeps the audit trail
  // clean. We keep at least 2 so there's a stale-cache overlap window
  // during rotations where chat-proxy may still be using the prior
  // version from its in-process cache.
  //
  // Proto `state` is typically the enum-name string on the Node client
  // (`"ENABLED"`) but the underlying proto3 is an int32 (1 = ENABLED).
  // Accept both so a future client release that switches encoding
  // doesn't silently break pruning.
  const [versions] = await client.listSecretVersions({ parent: SECRET_NAME });
  const enabled = versions
    .filter((v) => v.state === "ENABLED" || v.state === 1)
    .sort((a, b) => {
      // Versions are numbered; the most recent has the highest integer.
      const na = Number.parseInt(a.name?.split("/").pop() ?? "0", 10);
      const nb = Number.parseInt(b.name?.split("/").pop() ?? "0", 10);
      return nb - na;
    });
  const toDestroy = enabled.slice(KEEP_VERSIONS);
  for (const v of toDestroy) {
    if (!v.name) continue;
    try {
      await client.destroySecretVersion({ name: v.name });
      log(`destroyed old version ${v.name.split("/").pop()}`);
    } catch (err) {
      // Non-fatal — leaves extra versions around but doesn't break boot.
      // A double-destroy (another pod's concurrent prune) surfaces as
      // FAILED_PRECONDITION here; swallow.
      log(`WARN: could not destroy ${v.name}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  const kind = classifyError(err);
  log(`GATEWAY_AUTH_PUBLISH_FAILED: unexpected (${kind}) — ${err.message}`);
  process.exit(kind === SETUP_INCOMPLETE ? EXIT_SETUP_INCOMPLETE : EXIT_TRANSIENT);
});
