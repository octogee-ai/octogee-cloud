import { authenticationFailureLimit, authenticatedRequestLimit } from "../../middleware/authenticated-request-limit.js";
import { Router } from "express";
import { requireAdmin } from "../../middleware/auth.js";
import { githubListRepos } from "../../lib/github.js";
import { readConnectorAccessToken } from "../../lib/connector-tokens.js";

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
