import { Router, type Request, type Response } from "express";
import { strictRateLimit } from "../../middleware/security.js";
import { logger } from "../../middleware/logging.js";
import { platformStateStore } from "../../lib/platform-state.js";
import { withProject } from "../../lib/withProject.js";

const VISIBILITIES: ReadonlySet<unknown> = new Set(["private", "public", "unlisted"]);
const OWNER_SET_STATUSES: ReadonlySet<unknown> = new Set(["idea", "building", "launched", "paused"]);

interface ProjectSettings {
  visibility?: string;
  status?: string;
  checkoutEnabled?: boolean;
}

type RequestedSettings = { ok: true; value: ProjectSettings } | { ok: false; error: string };

function requestedProjectSettings(body: unknown): RequestedSettings {
  const { visibility, status, checkoutEnabled } = (body ?? {}) as Record<string, unknown>;
  if (visibility !== undefined && !VISIBILITIES.has(visibility)) {
    return { ok: false, error: "visibility must be private, public or unlisted" };
  }
  if (status !== undefined && !OWNER_SET_STATUSES.has(status)) {
    return { ok: false, error: "status must be idea, building, launched or paused" };
  }
  if (checkoutEnabled !== undefined && typeof checkoutEnabled !== "boolean") {
    return { ok: false, error: "checkoutEnabled must be a boolean" };
  }
  const value: ProjectSettings = {
    ...(visibility === undefined ? {} : { visibility: visibility as string }),
    ...(status === undefined ? {} : { status: status as string }),
    ...(checkoutEnabled === undefined ? {} : { checkoutEnabled }),
  };
  return Object.keys(value).length === 0 ? { ok: false, error: "No settings to change" } : { ok: true, value };
}

const router: Router = Router();

router.patch("/:wid/:pid/settings", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, {
    ownerOnly: true,
    ownerErrorMessage: "Only the project owner can change project settings",
    logTag: "[project-settings] crashed for",
    errorMessage: "Could not update project settings",
  }, async ({ uid }) => {
    const requested = requestedProjectSettings(req.body);
    if (!requested.ok) {
      res.status(400).json({ error: requested.error });
      return;
    }
    await platformStateStore.workspaces.projects.patch(wid, pid, {
      ...requested.value,
      updatedAt: { serverNow: true },
    });
    logger.info("[project-settings] updated", { uid, project: `${wid}/${pid}`, fields: Object.keys(requested.value) });
    res.json({ success: true, ...requested.value });
  });
});

export default router;
