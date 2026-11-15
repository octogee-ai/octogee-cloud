import { Router } from "express";
import { withGiteaTarget } from "@octogee/core/workspace/fileTarget";
import { validateWorkspacePath } from "@octogee/core/workspace/route-helpers";
import { removeUploadedWorkspaceBlob as removeWorkspaceBlob } from "@octogee/core/workspace/project-blob-edit";

const router: Router = Router();

router.post("/delete-blob", withGiteaTarget(async (req, res, _next, target) => {
  const { path: filePath } = req.body as { path?: string };
  if (!filePath) { res.status(400).json({ error: "Missing path" }); return; }

  const pathError = validateWorkspacePath(filePath);
  if (pathError) { res.status(400).json({ error: pathError }); return; }

  await removeWorkspaceBlob(target, filePath);

  res.json({ success: true, deleted: filePath });
}, { access: "write" }));

export default router;
