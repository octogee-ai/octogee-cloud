import { Router, Request, Response } from "express";
import type { FeaturePolicy } from "@octogee/shared/types/feature-flags";
import { strictRateLimit } from "@octogee/core/http/security";
import { logger } from "@octogee/core/http/logging";
import { platformStateStore } from "@octogee/core/identity/platform-state-store";
import {
  createProjectForActor,
  projectSlugAvailability,
  type ProjectCreateInput,
} from "../../lib/project-create-service.js";
import {
  projectRepoSourceAccess,
  proveRepoReachable,
  type RepoSourceAccess,
} from "./repo-source.js";

export function createProjectCreateRoutes(
  { featurePolicy, prewarmProjectRunCapacity }: {
    featurePolicy?: FeaturePolicy;
    prewarmProjectRunCapacity?: () => Promise<void>;
  } = {},
): Router {
  const router = Router();

  router.get("/slug-available", async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? "").trim();

    const availability = projectSlugAvailability(slug);
    if (!availability.ok) {
      res.json({ available: false, reason: availability.reason });
      return;
    }

    const workspaceId = req.workspaceSlug;
    if (!workspaceId) {
      res.status(422).json({ error: "Workspace not provisioned" });
      return;
    }

    const existing = await platformStateStore.workspaces.projects.get(workspaceId, slug);
    res.json({ available: existing === null });
  });

  router.post("/", strictRateLimit, async (req: Request, res: Response) => {
    try {
      const input = req.body as ProjectCreateInput;
      const result = await createProjectForActor(
        {
          uid: req.uid!,
          userData: req.user,
          workspaceId: req.workspaceSlug,
          ...(await requestedRepoSourceAccess(featurePolicy, req, input)),
          proveRepoSource: async (repoSource) => {
            const reachable = await proveRepoReachable(
              req.uid!,
              req.workspaceSlug!,
              repoSource,
            );
            return reachable.ok
              ? null
              : {
                  status: reachable.status,
                  body: { error: reachable.error, reason: reachable.reason },
                };
          },
          source: "ui",
        },
        input,
        prewarmProjectRunCapacity,
      );
      res.status(result.status).json(result.body);
    } catch (err) {
      logger.error("[projects] Create failed:", { err });
      res.status(500).json({ error: "Failed to create project" });
    }
  });

  return router;
}

// The flag only decides whether a caller may point a new project at GitHub, so
// a plain Gitea create must not pay a flag-provider round trip to be told so.
async function requestedRepoSourceAccess(
  featurePolicy: FeaturePolicy | undefined,
  req: Request,
  input: ProjectCreateInput | null | undefined,
): Promise<{ repoSourceAccess?: RepoSourceAccess }> {
  if (input?.repoSource === undefined || input.repoSource === null) return {};
  return {
    repoSourceAccess: await projectRepoSourceAccess(featurePolicy, req, "projects-create"),
  };
}

export default createProjectCreateRoutes();
