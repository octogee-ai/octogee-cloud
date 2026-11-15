import { Router, Request, Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { logger } from "../../middleware/logging.js";
import {
  archiveProjectSessionChannel,
  archiveSessionChannel,
  createProjectSessionChannel,
  createSessionChannel,
  renameProjectSessionChannel,
  renameSessionChannel,
  type SessionChannelActor,
} from "../../lib/channel-service.js";

const router: Router = Router();

function actorFrom(req: Request): SessionChannelActor {
  return {
    uid: req.uid!,
    workspaceId: req.workspaceSlug,
  };
}

router.post("/", strictRateLimit, async (req: Request, res: Response) => {
  try {
    const result = await createSessionChannel(actorFrom(req), req.body ?? {});
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error("[channels] Create failed:", { err });
    res.status(500).json({ error: "Failed to create channel" });
  }
});

// Project-lane routes are registered before the generic /:name routes; "proj"
// is a reserved channel name, so /proj/* can never shadow a real workspace
// channel.
router.post("/proj/:pid", strictRateLimit, async (req: Request, res: Response) => {
  try {
    const { pid } = req.params as { pid: string };
    const result = await createProjectSessionChannel(actorFrom(req), pid, req.body ?? {});
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error("[channels] Project create failed:", { err });
    res.status(500).json({ error: "Failed to create channel" });
  }
});

router.patch("/proj/:pid/:name", strictRateLimit, async (req: Request, res: Response) => {
  try {
    const { pid, name } = req.params as { pid: string; name: string };
    const result = await renameProjectSessionChannel(actorFrom(req), pid, name, req.body ?? {});
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error("[channels] Project update failed:", { err });
    res.status(500).json({ error: "Failed to update channel" });
  }
});

router.post("/proj/:pid/:name/archive", strictRateLimit, async (req: Request, res: Response) => {
  try {
    const { pid, name } = req.params as { pid: string; name: string };
    const result = await archiveProjectSessionChannel(actorFrom(req), pid, name);
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error("[channels] Project archive failed:", { err });
    res.status(500).json({ error: "Failed to archive channel" });
  }
});

router.patch("/:name", strictRateLimit, async (req: Request, res: Response) => {
  try {
    const { name } = req.params as { name: string };
    const result = await renameSessionChannel(actorFrom(req), name, req.body ?? {});
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error("[channels] Update failed:", { err });
    res.status(500).json({ error: "Failed to update channel" });
  }
});

router.post("/:name/archive", strictRateLimit, async (req: Request, res: Response) => {
  try {
    const { name } = req.params as { name: string };
    const result = await archiveSessionChannel(actorFrom(req), name);
    res.status(result.status).json(result.body);
  } catch (err) {
    logger.error("[channels] Archive failed:", { err });
    res.status(500).json({ error: "Failed to archive channel" });
  }
});

export default router;
