import { Router, type Request, type Response } from "express";
import { strictRateLimit } from "@octogee/core/http/security";
import { projectRepoSourceFromDoc } from "@octogee/shared/types/project";
import { GithubProjectError, publishGithubProject } from "../../lib/github-project-working-copy.js";
import { withProject } from "../../lib/withProject.js";

const router: Router = Router();

router.post("/:wid/:pid/github-pull-request", strictRateLimit, async (req: Request, res: Response) => {
  const { wid, pid } = req.params as { wid: string; pid: string };
  await withProject(req, res, wid, pid, {
    ownerOnly: true, requireActive: true, allowStates: ["active"], errorMessage: "Could not publish the private checkpoint to GitHub",
  }, async ({ project, uid }) => {
    const source = projectRepoSourceFromDoc(project.repoSource);
    if (!source) {
      res.status(409).json({ error: "Connect a GitHub repository first." });
      return;
    }
    try {
      const result = await publishGithubProject({ wid, pid, uid }, source, `Update ${project.name || pid}`.slice(0, 256));
      res.json(result);
    } catch (error) {
      if (!(error instanceof GithubProjectError)) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
});

export default router;
