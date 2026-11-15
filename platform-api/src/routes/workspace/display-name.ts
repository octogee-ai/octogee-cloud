import { Router, Request, Response, NextFunction } from "express";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { mmApi } from "../../lib/mattermost.js";
import { USERNAME_RE } from "@octogee/shared/types/identity";
import { logger } from "@octogee/core/http/logging";

const router: Router = Router();

const MM_TEAM_DISPLAY_NAME_MAX = 64;

router.patch("/display-name", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const uid = req.uid!;
    const raw = typeof req.body?.displayName === "string" ? req.body.displayName : "";
    const displayName = raw.trim();
    if (displayName.length === 0) {
      res.status(400).json({ error: "displayName is required" });
      return;
    }
    if (displayName.length > MM_TEAM_DISPLAY_NAME_MAX) {
      res.status(400).json({
        error: `displayName exceeds ${MM_TEAM_DISPLAY_NAME_MAX}-char MM limit`,
      });
      return;
    }

    const userData = req.user ?? {};
    const slug = userData.workspaceId || userData.username;
    if (!slug) {
      res.status(404).json({ error: "No workspace for caller" });
      return;
    }

    const workspace = USERNAME_RE.test(slug) ? await platformStateStore.workspaces.records.get(slug) : null;
    if (!workspace) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }
    if (workspace.ownerUid !== uid) {
      res.status(403).json({ error: "Only the workspace owner can rename" });
      return;
    }

    const teamId = workspace.mattermostTeamId;
    if (!teamId) {
      res.status(409).json({ error: "Workspace is not yet provisioned" });
      return;
    }

    await mmApi(`/teams/${teamId}`, "PUT", { display_name: displayName });

    res.json({ ok: true, displayName });
  } catch (err) {
    logger.error(`[workspace] PATCH /display-name failed`, {
      uid: req.uid,
      error: err instanceof Error ? err.message : String(err),
    });
    next(err);
  }
});

export default router;
