import { Router } from "express";
import type { Response } from "express";
import { withFileTarget, type FileTarget } from "@octogee/core/workspace/fileTarget";
import { fetchPulseReport } from "../../lib/pulse-ingest.js";

const router: Router = Router();

function requireProject(target: FileTarget, res: Response): boolean {
  if (!target.projectSlug) {
    res.status(403).json({ error: "Pulse is project-scoped", code: "PROJECT_ONLY" });
    return false;
  }
  return true;
}

router.get(
  "/pulse",
  withFileTarget(async (_req, res, _next, target) => {
    if (!requireProject(target, res)) return;
    const report = await fetchPulseReport(target, Date.now());
    res.json(report);
  }),
);

export default router;
