import { authenticatedRequestLimit, authenticationFailureLimit } from "../middleware/authenticated-request-limit.js";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { Router, type Request, type Response } from "express";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import { requireActiveAccount, requireAuthenticatedUid } from "../../../gateway-edge/src/middleware/auth.js";
import { forwardMmRest } from "../../../gateway-edge/src/chat-proxy/mm-proxy/rest.js";
import type { CreatedPostObserver, ProductNotifications } from "../lib/user-notifications.js";

const MM_INTERNAL_URL = process.env.MM_INTERNAL_URL || "";

const API_PUBLIC_URL = process.env.API_PUBLIC_URL || "";

interface CachedMmCreds {
  mmToken: string;
  mmUserId: string;
  expiresAt: number;
}

export const mmCredsCache = new Map<string, CachedMmCreds>();
const MM_CREDS_CACHE_TTL = 5 * 60 * 1000;

export const MM_CREDS_CACHE_MAX = 5000;

export function setMmCredsCache(uid: string, entry: CachedMmCreds): void {
  if (mmCredsCache.size >= MM_CREDS_CACHE_MAX && !mmCredsCache.has(uid)) {
    const now = Date.now();
    for (const [k, v] of mmCredsCache) {
      if (v.expiresAt <= now) mmCredsCache.delete(k);
    }
    while (mmCredsCache.size >= MM_CREDS_CACHE_MAX) {
      const oldest = mmCredsCache.keys().next().value;
      if (oldest === undefined) break;
      mmCredsCache.delete(oldest);
    }
  }
  mmCredsCache.set(uid, entry);
}

type GetMmCredsResult =
  | { ok: true; mmToken: string; mmUserId: string }
  | { ok: false; reason: "not-provisioned" }
  | { ok: false; reason: "lookup-error" };

type MattermostCredentialStore = Pick<PlatformStateRepositories, "users" | "secrets">;

async function getMmCreds(store: MattermostCredentialStore, uid: string): Promise<GetMmCredsResult> {
  const cached = mmCredsCache.get(uid);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return { ok: true, mmToken: cached.mmToken, mmUserId: cached.mmUserId };
    }
    mmCredsCache.delete(uid);
  }

  try {
    const [user, secret] = await Promise.all([
      store.users.records.get(uid),
      store.secrets.get(uid, "mattermost"),
    ]);

    const mmUserId = user?.mattermostUserId;
    const mmToken = secret?.kind === "builder-mattermost" ? secret.personalToken : null;

    if (!mmUserId || !mmToken) return { ok: false, reason: "not-provisioned" };

    setMmCredsCache(uid, {
      mmToken,
      mmUserId,
      expiresAt: Date.now() + MM_CREDS_CACHE_TTL,
    });

    return { ok: true, mmToken, mmUserId };
  } catch (e) {
    logger.error(
      `[mm-proxy] failed to load MM creds for ${uid}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { ok: false, reason: "lookup-error" };
  }
}

export function createMattermostMintRoutes(store: MattermostCredentialStore): Router {
  const router = Router();
  router.post("/", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(60), requireActiveAccount, async (req: Request, res: Response) => {
    if (!API_PUBLIC_URL) {
      logger.error("[mm-proxy] API_PUBLIC_URL unset — refusing to mint with empty mmUrl");
      res.status(503).json({ error: "Chat service misconfigured" });
      return;
    }
    const uid = req.uid!;
    const result = await getMmCreds(store, uid);
    if (!result.ok) {
      if (result.reason === "lookup-error") {
        res.status(503).json({ error: "Credential lookup unavailable" });
        return;
      }
      res.status(502).json({ error: "Chat not provisioned" });
      return;
    }
    res.json({
      mmUrl: API_PUBLIC_URL,
      mmToken: result.mmToken,
      mmUserId: result.mmUserId,
    });
  });
  return router;
}

export function isCreatePostRequest(method: string | undefined, url: string | undefined): boolean {
  return method === "POST" && (url ?? "").split("?")[0] === "/api/v4/posts";
}

export function createMmRestProxyHandler(
  store: Pick<PlatformStateRepositories, "users" | "workspaces">,
  notifications?: Pick<ProductNotifications, "createPostObserver">,
): (req: Request, res: Response) => void {
  let postObserver: CreatedPostObserver | null = null;
  const observer = (): CreatedPostObserver | null => {
    if (!notifications) return null;
    postObserver ??= notifications.createPostObserver(store);
    return postObserver;
  };
  return (req, res) => {
    if (!MM_INTERNAL_URL) {
      logger.error("[mm-proxy] MM_INTERNAL_URL unset — cannot proxy MM REST");
      res.status(502).json({ error: "Chat service misconfigured" });
      return;
    }
    const authorization = req.headers.authorization;
    forwardMmRest(
      {
        mmInternalUrl: MM_INTERNAL_URL,
        log: (msg) => logger.warn(msg),
        captureResponse: (incoming) => notifications !== undefined && isCreatePostRequest(incoming.method, incoming.url),
        onCapturedResponse: (captured) => {
          void observer()?.handleCreatedPost({ ...captured, authorization });
        },
      },
      req,
      res,
    );
  };
}
