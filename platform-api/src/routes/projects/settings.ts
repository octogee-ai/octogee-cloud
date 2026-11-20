import { Router, type Request, type Response } from "express";
import { strictRateLimit } from "@octogee/core/http/security";
import { logger } from "@octogee/core/http/logging";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import { projectCheckoutEnabled, projectRepoSourceFromDoc } from "@octogee/shared/types/project";
import { enableGithubProjectCheckout, GithubProjectError } from "../../lib/github-project-working-copy.js";
import { projectIsArchived, withProject } from "../../lib/withProject.js";

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

router.get("/:wid/:pid/settings", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, { ownerOnly: true }, async ({ project }) => {
    res.json({ checkoutEnabled: projectCheckoutEnabled(project.checkoutEnabled), repoSource: projectRepoSourceFromDoc(project.repoSource) });
  });
});

router.patch("/:wid/:pid/settings", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, {
    ownerOnly: true,
    ownerErrorMessage: "Only the project owner can change project settings",
    logTag: "[project-settings] crashed for",
    errorMessage: "Could not update project settings",
  }, async ({ uid, project }) => {
    const requested = requestedProjectSettings(req.body);
    if (!requested.ok) {
      res.status(400).json({ error: requested.error });
      return;
    }
    const source = projectRepoSourceFromDoc(project.repoSource);
    const settings = { ...requested.value };
    if (settings.checkoutEnabled === true && source) {
      if (await projectIsArchived(project)) {
        res.status(409).json({ error: "Project is archived", code: "PROJECT_ARCHIVED" });
        return;
      }
      try {
        await enableGithubProjectCheckout({ wid, pid, uid }, source);
      } catch (error) {
        if (!(error instanceof GithubProjectError)) throw error;
        res.status(error.status).json({ error: error.message });
        return;
      }
      delete settings.checkoutEnabled;
    }
    await platformStateStore.workspaces.projects.patch(wid, pid, {
      ...settings,
      updatedAt: { serverNow: true },
    });
    logger.info("[project-settings] updated", { uid, project: `${wid}/${pid}`, fields: Object.keys(requested.value) });
    res.json({ success: true, ...requested.value });
  });
});

export default router;
