import { authenticatedRequestLimit, authenticationFailureLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import {
  featureFlagBypassedForAdmin,
  type FeaturePolicy,
  type FeatureSubject,
} from "@octogee/shared/types/feature-flags";
import {
  TALK_TICKET_PURPOSE,
  VOICE_TALK_FLAG,
  isTalkVoiceId,
  type TalkVoiceCatalog,
} from "@octogee/shared/types/voice";
import { requireActiveAccount, requireAuthenticatedUid } from "@octogee/core/http/auth";
import { isMattermostPostId } from '@octogee/shared/types/mattermost-session-route';
import { logger } from "@octogee/core/http/logging";
import {
  HourlyMintQuotaExceededError,
  TicketCapExceededError,
  mintTicket,
} from "../lib/gateway-ticket.js";

export type VoiceAccess = "enabled" | "disabled" | "unavailable";

/** octogee-api's voice catalog: what the configured speech engine offers, plus a spoken sample. Absent on hosts without the relay. */
export interface VoiceCatalogPort {
  list(): Promise<TalkVoiceCatalog>;
  preview(input: { voice: string; name?: string }, signal?: AbortSignal): Promise<Buffer>;
}

export interface VoiceRoutesDeps {
  featurePolicy?: FeaturePolicy;
  catalog?: VoiceCatalogPort;
  resolveChannel?: (uid: string, channelId: string) => Promise<{ gatewayId: string; channelId: string } | null>;
  resolveConversation?: (uid: string, channelId: string, threadRootPostId?: string) => Promise<{ gatewayId: string; workspaceSlug: string; ownerUid: string; channelId: string; threadRootPostId: string; sessionKey: string } | null>;
}

function isVoiceSelection(value: unknown): value is { channelId: string; threadRootPostId?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return isMattermostPostId(body.channelId) &&
    (body.threadRootPostId === undefined || isMattermostPostId(body.threadRootPostId)) &&
    Object.keys(body).every(key => ['channelId', 'threadRootPostId'].includes(key));
}

const VOICE_PREVIEW_NAME_MAX = 60;

const previewRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.uid!,
  message: { error: "too_many_voice_previews" },
});

function featureSubject(req: Request): FeatureSubject {
  return {
    uid: req.uid!,
    isAdmin: req.isAdmin === true,
    ...(typeof req.workspaceSlug === "string" ? { workspaceSlug: req.workspaceSlug } : {}),
  };
}

export async function voiceTalkAccess(
  featurePolicy: FeaturePolicy | undefined,
  req: Request,
  context: string,
): Promise<VoiceAccess> {
  const subject = featureSubject(req);
  if (featureFlagBypassedForAdmin(VOICE_TALK_FLAG, subject)) return "enabled";
  if (!featurePolicy) return "disabled";
  const decision = await featurePolicy.evaluate(VOICE_TALK_FLAG, subject, context);
  return decision.state;
}

function respondDenied(res: Response, access: VoiceAccess): void {
  if (access === "unavailable") {
    res.status(503).json({ error: "feature_evaluation_unavailable" });
    return;
  }
  res.status(403).json({ error: "voice_talk_disabled" });
}

function catalogStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 600 ? status : null;
}

export function createVoiceRoutes({ featurePolicy, catalog, resolveConversation, resolveChannel }: VoiceRoutesDeps = {}): Router {
  const router = Router();

  const gate = (context: string) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const access = await voiceTalkAccess(featurePolicy, req, context);
      if (access !== "enabled") {
        respondDenied(res, access);
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };

  router.get('/context/:channelId', authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(120), requireActiveAccount, gate('voice-context'), async (req, res, next) => {
    try {
      const channelId = req.params.channelId;
      if (!isMattermostPostId(channelId)) { res.status(400).json({ error: 'invalid_voice_conversation' }); return; }
      if (!resolveChannel) { res.status(503).json({ error: 'voice_conversation_unavailable' }); return; }
      const scope = await resolveChannel(req.uid!, channelId);
      if (!scope) { res.status(403).json({ error: 'voice_conversation_forbidden' }); return; }
      if (scope.channelId !== channelId) throw new Error('Voice channel resolver returned a different channel');
      res.set('cache-control', 'no-store').json(scope);
    } catch (error) { next(error); }
  });

  const ticketRateLimit = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: req => req.uid!, message: { error: 'too_many_voice_tickets' } });
  router.post("/ticket", authenticationFailureLimit, requireAuthenticatedUid, ticketRateLimit, requireActiveAccount, gate("voice-ticket"), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const uid = req.uid!;
      const body: unknown = req.body;
      if (!isVoiceSelection(body)) {
        res.status(400).json({ error: "invalid_voice_conversation" }); return;
      }
      if (!resolveConversation) { res.status(503).json({ error: "voice_conversation_unavailable" }); return; }
      const scope = await resolveConversation(uid, body.channelId, body.threadRootPostId);
      if (!scope) { res.status(403).json({ error: "voice_conversation_forbidden" }); return; }
      if (scope.channelId !== body.channelId || !isMattermostPostId(scope.threadRootPostId) ||
        (body.threadRootPostId !== undefined && scope.threadRootPostId !== body.threadRootPostId)) throw new Error('Voice conversation resolver returned a different selection');
      const { gatewayId, ...payload } = scope;
      const ticket = await mintTicket({ uid, gatewayId, purpose: TALK_TICKET_PURPOSE, payload });
      const proxyUrl = process.env.API_PUBLIC_URL || "";
      res.set('cache-control', 'no-store').json({ wsTicket: ticket.ticket, proxyUrl, gatewayId, threadRootPostId: scope.threadRootPostId });
    } catch (err) {
      if (err instanceof TicketCapExceededError) {
        logger.warn("[voice] ticket cap exceeded", { uid: err.uid, cap: err.cap });
        res.status(429).json({ error: "too_many_voice_tickets" });
        return;
      }
      if (err instanceof HourlyMintQuotaExceededError) {
        logger.warn("[voice] hourly ticket quota exceeded", { uid: err.uid, quota: err.quota });
        res.set("Retry-After", "300");
        res.status(429).json({ error: "voice_ticket_quota_exceeded" });
        return;
      }
      next(err);
    }
  });

  router.get("/voices", authenticationFailureLimit, requireAuthenticatedUid, authenticatedRequestLimit(120), requireActiveAccount, gate("voice-catalog"), async (_req: Request, res: Response, next: NextFunction) => {
    try {
      if (!catalog) {
        res.status(503).json({ error: "voice_catalog_unavailable" });
        return;
      }
      res.set("Cache-Control", "private, max-age=60");
      res.json(await catalog.list());
    } catch (err) {
      next(err);
    }
  });

  router.post("/preview", authenticationFailureLimit, requireAuthenticatedUid, previewRateLimit, requireActiveAccount, gate("voice-preview"), async (req: Request, res: Response) => {
    try {
      if (!catalog) {
        res.status(503).json({ error: "voice_catalog_unavailable" });
        return;
      }
      const body = (req.body ?? {}) as { voice?: unknown; name?: unknown };
      const voice = body.voice ?? "";
      if (!isTalkVoiceId(voice)) {
        res.status(400).json({ error: "invalid_voice" });
        return;
      }
      const name = typeof body.name === "string" ? body.name.slice(0, VOICE_PREVIEW_NAME_MAX) : undefined;
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const wav = await catalog.preview({ voice, ...(name ? { name } : {}) }, abort.signal);
      res.set("Content-Type", "audio/wav");
      res.set("Cache-Control", "no-store");
      res.send(wav);
    } catch (err) {
      const status = catalogStatus(err);
      if (status !== null) {
        const upstreamFailure = status >= 500 && status !== 503;
        res.status(upstreamFailure ? 502 : status).json({ error: err instanceof Error ? err.message : "voice_preview_failed" });
        return;
      }
      logger.warn("[voice] preview failed", { uid: req.uid, error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: "voice_preview_failed" });
    }
  });

  return router;
}

export default createVoiceRoutes();
