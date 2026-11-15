import { authenticationFailureLimit, authenticatedRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router } from "express";
import { requireAdmin } from "@octogee/core/http/auth";
import { githubListRepos } from "@octogee/core/git-host/github";
import { readConnectorAccessToken } from "@octogee/core/connectors/connector-tokens";

const router: Router = Router();

router.get("/github/repos", authenticationFailureLimit, requireAdmin, authenticatedRequestLimit(60), async (req, res, next) => {
  try {
    const token = await readConnectorAccessToken(req.uid!, "github");
    if (!token) {
      res.status(422).json({ error: "GitHub not connected", reason: "github_not_connected" });
      return;
    }
    const { repos, truncated } = await githubListRepos(token);
    res.json({ repos, truncated });
  } catch (e) {
    next(e);
  }
});

export default router;
