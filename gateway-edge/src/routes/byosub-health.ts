import { Router, Request, Response, NextFunction } from "express";
import { authenticatedRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import * as fs from "fs";
import * as path from "path";
import {
  userDefaultAgentId,
  deriveByosubHealth,
  isSafeGatewayId,
} from "@octogee/core/model-credentials/byosub";
import {
  resolveByosubUserGateway,
  type ByosubGatewayAssignment,
} from "../lib/byosub-broker.js";
import {
  codexAgentDir,
  isSafeAgentId,
  readCodexAuthStateText,
} from "@octogee/core/byosub-restore";
import { readAuthProfileStore } from "@octogee/core/auth-profile-store";
import {
  CLAUDE_CLI_DEFAULT_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "@octogee/core/model-credential-materializer";

// GET /api/g/<gatewayId>/byosub/health — the DEEP byosub durability check.
//
// /api/model-credentials/subscription/connection (cluster) reads only the user integration
// authority, which survives a reroll/relocation regardless of whether the destination
// pod re-materialized a working credential. This route runs ON the user's
// own pod (locality seam) and crosses that expectation with pod reality — is the
// auth-profile store actually present, and does codex consider it alive — so a
// silent boot-sync materialization failure reports `missing` instead of a false
// `connected`. It's the durability harness's real proof and fixes the product
// false-"connected" the ref-only read can't catch.

export interface ByosubHealthDeps {
  resolveUserGateway: (uid: string) => Promise<ByosubGatewayAssignment | null>;
  localGatewayId: () => string | null;
  isMounted: (slug: string) => boolean;
  readStorePresent: (agentId: string, profileId: string) => boolean | Promise<boolean>;
  readProfileExpiresAt: (agentId: string, profileId: string) => number | null | Promise<number | null>;
  readAuthStateText: (agentId: string) => string | null | Promise<string | null>;
  now: () => number;
}

function requestedGatewayId(req: Request): string | null {
  const raw = (req.params as { gatewayId?: unknown }).gatewayId;
  return typeof raw === "string" && isSafeGatewayId(raw) ? raw : null;
}

function notOnThisPod(res: Response): void {
  res.json({ connected: false, status: "not_on_this_pod" });
}

export function createByosubHealthRouter(deps: ByosubHealthDeps): Router {
  const router = Router({ mergeParams: true });
  router.get(
    "/health",
    authenticatedRequestLimit(120),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const pathGatewayId = requestedGatewayId(req);
        const localGatewayId = deps.localGatewayId();
        // This endpoint is a per-pod proof, not a cluster ref read. It must only
        // answer for the fleet-scoped gateway path that actually reached this pod;
        // otherwise a stale source pod can masquerade as the relocation target.
        if (!pathGatewayId || !localGatewayId || localGatewayId !== pathGatewayId) {
          notOnThisPod(res);
          return;
        }

        const resolved = await deps.resolveUserGateway(req.uid!);
        if (!resolved) {
          res.status(422).json({ connected: false, status: "not_provisioned" });
          return;
        }
        if (resolved.gatewayId !== localGatewayId) {
          notOnThisPod(res);
          return;
        }
        const agentId = userDefaultAgentId(resolved.slug);
        // The slug can fall back to the client-writable `username`, and below it
        // feeds filesystem paths (codexAgentDir / CUSTOMERS_DIR). isSafeAgentId
        // ([a-z0-9-]{1,64}) on the derived id transitively constrains the slug to
        // a path-safe charset — refuse before any fs access if it doesn't.
        if (!isSafeAgentId(agentId)) {
          res.status(422).json({ connected: false, status: "not_provisioned" });
          return;
        }
        const mountedHere = deps.isMounted(resolved.slug);
        const refProvider = resolved.refProvider;
        const profileId =
          refProvider === "anthropic"
            ? CLAUDE_CLI_DEFAULT_PROFILE_ID
            : OPENAI_CODEX_DEFAULT_PROFILE_ID;
        if (!refProvider) {
          res.json(
            deriveByosubHealth({
              mountedHere,
              refProvider,
              storePresent: false,
              profileExpiresAt: null,
              authStateText: null,
              profileId,
              now: deps.now(),
            }),
          );
          return;
        }
        res.json(
          deriveByosubHealth({
            mountedHere,
            refProvider,
            storePresent: await deps.readStorePresent(agentId, profileId),
            profileExpiresAt:
              profileId === CLAUDE_CLI_DEFAULT_PROFILE_ID
                ? await deps.readProfileExpiresAt(agentId, profileId)
                : null,
            authStateText: await deps.readAuthStateText(agentId),
            profileId,
            now: deps.now(),
          }),
        );
      } catch (e) {
        next(e);
      }
    },
  );
  return router;
}

const CUSTOMERS_DIR = process.env.CUSTOMERS_DIR ?? "/home/node/.openclaw/customers";
const OPENCLAW_DIR = process.env.OPENCLAW_DIR ?? path.dirname(CUSTOMERS_DIR);

async function profileRecord(agentId: string, profileId: string): Promise<Record<string, unknown> | null> {
  const store = await readAuthProfileStore(codexAgentDir(OPENCLAW_DIR, agentId));
  const profiles = (store as { profiles?: unknown } | null)?.profiles;
  if (!profiles || typeof profiles !== "object") return null;
  const profile = (profiles as Record<string, unknown>)[profileId];
  return profile && typeof profile === "object" && !Array.isArray(profile)
    ? (profile as Record<string, unknown>)
    : null;
}

const byosubHealthRouter = createByosubHealthRouter({
  resolveUserGateway: resolveByosubUserGateway,
  localGatewayId: () => process.env.GATEWAY_ID?.trim() || null,
  isMounted: (slug) => fs.existsSync(path.join(CUSTOMERS_DIR, slug)),
  readStorePresent: async (agentId, profileId) => {
    return await profileRecord(agentId, profileId) !== null;
  },
  readProfileExpiresAt: async (agentId, profileId) => {
    const expires = (await profileRecord(agentId, profileId))?.expires;
    return typeof expires === "number" && Number.isFinite(expires) ? expires : null;
  },
  // null (empty OR unreadable state) maps to healthy-by-design: this endpoint's
  // contract is store-PRESENCE, and deriveByosubHealth only reaches the auth-state
  // read once storePresent is true. A corrupt-but-present store reading healthy is
  // the boundary of store-presence scope — the deferred 1-token probe is what would
  // catch it.
  readAuthStateText: async (agentId) => await readCodexAuthStateText(OPENCLAW_DIR, agentId),
  now: () => Date.now(),
});

export default byosubHealthRouter;
