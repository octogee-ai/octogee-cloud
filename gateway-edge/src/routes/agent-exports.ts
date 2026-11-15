import { authenticatedRequestLimit } from "../middleware/authenticated-request-limit.js";
import { Router, type Response } from "express";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { createAgentExportRuntime } from "../lib/agent-export-runtime.js";
const changedPreview = new Set([
  "authored export source content changed; preview again", "destination changed; preview again",
  "destination changed before publication; preview again", "authored export source authority changed",
  "authored export snapshot changed", "authored export preview expired",
  "export repository permission or default branch changed",
]);
function handleExportError(error: unknown, res: Response): void {
  if (error instanceof Error && changedPreview.has(error.message)) {
    res.status(409).json({ error: "export_preview_changed", message: "The source, destination, or approval changed. Choose the repository again for a fresh preview." }); return;
  }
  if (error instanceof Error && [
    "Choose an existing writable GitHub repository",
    "Choose an existing repository with a commit on its default branch; empty repositories are not supported",
    "repository is too large for a complete conflict preview",
    "authored export exceeds capture limit", "authored asset exceeds export size limit",
    "authored file exceeds export size limit", "Authored export supports at most 100 files",
    "authored export contains secret findings", "workspace mutation is in progress",
  ].includes(error.message)) {
    res.status(422).json({ error: "export_preview_unavailable", message: error.message }); return;
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "github_not_connected") {
    res.status(422).json({ error: "github_not_connected", message: "Connect GitHub in Connections, then choose your repository." }); return;
  }
  if (code === "export_not_available" || code === "forbidden") {
    res.status(code === "forbidden" ? 403 : 409).json({ error: "export_not_available", message: "Export requires the active workspace owner and a serving, unchanged agent workspace." }); return;
  }
  if (code === "export_unconfirmed") {
    res.status(504).json({ error: "export_unconfirmed", message: "Export is not confirmed. Check or retry this export to read its publication receipt." }); return;
  }
  res.status(503).json({ error: "export_unavailable", message: "Export could not be confirmed. Check or retry this export before starting another preview." });
}
export function createAgentExportsRouter(deps = { createRuntime: createAgentExportRuntime, localGatewayId: () => process.env.GATEWAY_ID }) {
  const router: Router = Router({ mergeParams: true });
  router.use((req, res, next) => {
    const gatewayId = req.params.gatewayId;
    const authorization = req.headers.authorization;
    if (!isValidGatewayId(gatewayId) || gatewayId !== deps.localGatewayId() || !authorization?.startsWith("Bearer ")) { res.status(403).json({ error: "forbidden" }); return; }
    res.locals.agentExport = deps.createRuntime({ gatewayId, authorization }); next();
  });
  router.get("/agents", authenticatedRequestLimit(120), async (_req, res) => { try { res.json(await res.locals.agentExport.agents()); } catch (error) { handleExportError(error, res); } });
  router.get("/repos", authenticatedRequestLimit(120), async (_req, res) => { try { res.json(await res.locals.agentExport.repos()); } catch (error) { handleExportError(error, res); } });
  router.get("/latest", authenticatedRequestLimit(120), async (_req, res) => { try { res.json(await res.locals.agentExport.latest()); } catch (error) { handleExportError(error, res); } });
  router.post("/preview", authenticatedRequestLimit(30), async (req, res) => {
    try {
      const { agentId, owner, repo } = req.body ?? {};
      if (![agentId, owner, repo].every(value => typeof value === "string" && value.length > 0 && value.length <= 200)) { res.status(400).json({ error: "invalid_export" }); return; }
      res.json(await res.locals.agentExport.service.preview(agentId, { owner, repo }));
    } catch (error) { handleExportError(error, res); }
  });
  router.post("/:id/apply", authenticatedRequestLimit(30), async (req, res) => {
    try {
      if (typeof req.body?.approvalHash !== "string" || !/^[a-f0-9]{64}$/u.test(req.body.approvalHash) || !/^export-[a-z0-9-]{1,80}$/u.test(String(req.params.id))) { res.status(400).json({ error: "invalid_export_approval" }); return; }
      res.json(await res.locals.agentExport.service.apply(req.params.id, req.body.approvalHash));
    } catch (error) { handleExportError(error, res); }
  });
  return router;
}
