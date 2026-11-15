import { authenticationFailureLimit, authenticatedRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "@octogee/core/http/auth";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { mintTicket } from "../lib/gateway-ticket.js";
import { resolveActivityConversation } from "@octogee/core/channels/activity-conversation";
import { isMattermostPostId } from '@octogee/shared/types/mattermost-session-route';
import { isValidGatewayId } from "@octogee/shared/types/glm";

const router: Router = Router();

function isMattermostActivitySelection(value: unknown): value is { channelId: string; threadRootPostId?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return Object.keys(body).every(key => key === 'channelId' || key === 'threadRootPostId')
    && isMattermostPostId(body.channelId) && (body.threadRootPostId === undefined || isMattermostPostId(body.threadRootPostId));
}

router.post("/ticket", authenticationFailureLimit, requireAuth, authenticatedRequestLimit(60), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    if (req.body && Object.keys(req.body).length) {
      if (!isMattermostActivitySelection(req.body)) {
        res.status(400).json({ error: 'invalid_activity_channel' }); return;
      }
      const scope = await resolveActivityConversation({ users: platformStateStore.users.records, uid, ...req.body });
      if (!scope) { res.status(403).json({ error: 'activity_channel_forbidden' }); return; }
      const { gatewayId, ...payload } = scope;
      const ticket = await mintTicket({ uid, gatewayId, purpose: 'openclaw-ws', payload });
      res.set('Cache-Control', 'no-store').json({ wsTicket: ticket.ticket, proxyUrl: process.env.API_PUBLIC_URL || '', gatewayId, sessionKey: scope.sessionKey });
      return;
    }
    const rawGatewayId = (await platformStateStore.users.records.get(uid))?.gateway?.gatewayId;
    const gatewayId = isValidGatewayId(rawGatewayId) ? rawGatewayId : "";

    const t = await mintTicket({ uid, gatewayId, purpose: "openclaw-ws" });

    const proxyUrl = process.env.API_PUBLIC_URL || "";
    res.json({ wsTicket: t.ticket, proxyUrl, gatewayId });
  } catch (e) {
    next(e);
  }
});

export default router;
