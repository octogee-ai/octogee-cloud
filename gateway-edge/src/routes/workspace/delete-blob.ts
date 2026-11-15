import { Router } from "express";
import { withGiteaTarget } from "../../lib/fileTarget.js";
import { validateWorkspacePath } from "./helpers.js";
import { removeUploadedWorkspaceBlob as removeWorkspaceBlob } from "../../lib/project-blob-edit.js";

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
