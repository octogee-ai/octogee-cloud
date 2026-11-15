import { authenticationFailureLimit, authenticatedRequestLimit } from "../middleware/authenticated-request-limit.js";
import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth.js";
import { agentIdentity } from "../lib/agent-identity.js";
import { getWorkspaceMmContext } from "../lib/mattermost-context.js";
import { readMattermostSecret } from "../lib/mattermost-secret.js";
import { platformStateStore } from "../lib/platform-state.js";

const router: Router = Router();

const GATEWAY_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function extractValidGatewayId(user: { provisioning?: unknown }): string {
  const provisioning = user.provisioning as { openclaw?: { gatewayId?: unknown } } | undefined;
  const raw = provisioning?.openclaw?.gatewayId;
  return typeof raw === "string" && GATEWAY_ID_RE.test(raw) ? raw : "";
}

router.get("/token", authenticationFailureLimit, requireAuth, authenticatedRequestLimit(120), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const userData = req.user!;

    const ctx = await getWorkspaceMmContext(uid);
    const mmUserId = ctx?.userId;
    const dmChannelId = ctx?.coachDmChannelId;

    if (!mmUserId || !dmChannelId) {
      res.status(202).json({
        status: "provisioning",
        message: "Chat is being set up. Please try again in a few seconds.",
      });
      return;
    }

    const secret = await readMattermostSecret(platformStateStore, uid, "mattermost");

    if (!secret?.personalToken) {
      res.status(202).json({
        status: "provisioning",
        message: "Chat credentials are being set up.",
      });
      return;
    }

    const proxyUrl = process.env.API_PUBLIC_URL || "";
    const defaultAgentMmUserId = ctx.coachUserId || null;
    const coachName = (await agentIdentity().read(uid)).name || null;
    const gatewayId = extractValidGatewayId(userData);

    res.json({ mmUserId, dmChannelId, proxyUrl, gatewayId, coachMmUserId: defaultAgentMmUserId, coachName });
  } catch (e) { next(e); }
});

export default router;
