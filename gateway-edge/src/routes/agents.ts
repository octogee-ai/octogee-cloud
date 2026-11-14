import { authenticationFailureLimit, authenticatedRequestLimit } from "../middleware/authenticated-request-limit.js";
import { Router, Request, Response, NextFunction } from "express";
import { requireAuth } from "../middleware/auth.js";
import { agentIdentity } from "../lib/agent-identity.js";

const router = Router();

const ALLOWED_DEFAULT_AGENT_PATCH_FIELDS = ["name", "persona"] as const;
type DefaultAgentPatchField = (typeof ALLOWED_DEFAULT_AGENT_PATCH_FIELDS)[number];

function defaultAgentPatchFromBody(body: unknown): Partial<Record<DefaultAgentPatchField, string>> {
  const source = (body ?? {}) as Record<string, unknown>;
  const patch: Partial<Record<DefaultAgentPatchField, string>> = {};
  for (const key of ALLOWED_DEFAULT_AGENT_PATCH_FIELDS) {
    const value = source[key];
    if (typeof value === "string") patch[key] = value;
  }
  return patch;
}

router.patch("/me", authenticationFailureLimit, requireAuth, authenticatedRequestLimit(60), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid;
    if (!uid) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }

    const patch = defaultAgentPatchFromBody(req.body);
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "no_valid_fields", allowed: ALLOWED_DEFAULT_AGENT_PATCH_FIELDS });
      return;
    }

    const updated = await agentIdentity().sync(uid, patch);

    res.json({ ok: true, updated });
  } catch (e) { next(e); }
});

export default router;
