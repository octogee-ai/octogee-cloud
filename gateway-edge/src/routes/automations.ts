import { authenticatedRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router, type Request, type Response } from "express";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import { AUTOMATION_OPENCLAW_CONNECT_TIMEOUT_MS, AUTOMATION_OPENCLAW_RPC_TIMEOUT_MS } from "@octogee/shared/types/automations";
import { attachUpstreamRpcClient, type UpstreamRpcError } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";
import { openAuthenticatedUpstream } from "../chat-proxy/openclaw/authenticated-upstream.js";
import { authorizeAutomationOwner, type AutomationAuthorizationOutcome } from "@octogee/core/internal-brokers/automation-authorization-broker";
import { AutomationBrokerError, automationRecord, executeAutomation, type AutomationScope } from "./automation-native.js";

export interface AutomationsRouterDeps {
  authorizeOwner(input: { gatewayId: string; authorization?: string; uid: string }): Promise<AutomationAuthorizationOutcome>;
  localGatewayId(): string | null;
  invoke(method: string, params: Record<string, unknown>): Promise<unknown>;
}
interface AuthorizedAutomationOwner extends AutomationScope { gatewayId: string }
function requestedGatewayId(req: Request): string | null {
  const gatewayId = (req.params as { gatewayId?: unknown }).gatewayId;
  return isValidGatewayId(gatewayId) ? gatewayId : null;
}
export class NativeAutomationError extends Error {
  constructor(readonly native: UpstreamRpcError) { super(native.message); }
}
async function authorize(
  req: Request,
  res: Response,
  deps: Pick<AutomationsRouterDeps, "authorizeOwner" | "localGatewayId">,
): Promise<AuthorizedAutomationOwner | null> {
  const gatewayId = requestedGatewayId(req);
  if (!gatewayId || deps.localGatewayId() !== gatewayId) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  const outcome = await deps.authorizeOwner({
    gatewayId,
    authorization: req.headers.authorization,
    uid: req.uid!,
  });
  if (outcome.kind === "unauthenticated") {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  if (outcome.kind === "not_found") {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (outcome.kind === "forbidden") {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  if (outcome.kind === "coach_channel_not_ready") {
    res.status(409).json({ error: "coach_channel_not_ready" });
    return null;
  }
  return {
    slug: outcome.slug,
    gatewayId: outcome.gatewayId,
    coachChannelId: outcome.coachChannelId,
  };
}

function sendNativeError(res: Response, error: NativeAutomationError): void {
  const details = automationRecord(error.native.details);
  const conflict = details?.code === "CRON_JOB_CHANGED";
  const bounded = conflict ? { code: "CRON_JOB_CHANGED", expectedConfigRevision: details.expectedConfigRevision, actualConfigRevision: details.actualConfigRevision } : undefined;
  let status = error.native.code === "INVALID_REQUEST" ? 400 : 502;
  if (conflict) status = 409;
  res.status(status).json({ error: "native_automation_error", code: error.native.code, message: error.message, ...(bounded ? { details: bounded } : {}) });
}
export function createAutomationsRouter(deps: AutomationsRouterDeps): Router {
  const router = Router({ mergeParams: true });
  router.post("/rpc", authenticatedRequestLimit(120), async (req, res, next) => {
    try {
      const resolved = await authorize(req, res, deps);
      if (!resolved) return;
      const body = automationRecord(req.body);
      if (!body) {
        res.status(400).json({ error: "invalid_automation_request" });
        return;
      }
      res.json({ result: await executeAutomation(deps.invoke, resolved, body) });
    } catch (error) {
      if (error instanceof AutomationBrokerError) {
        res.status(error.status).json({ error: error.code, ...(error.details ? { details: error.details } : {}) });
      } else if (error instanceof NativeAutomationError) {
        sendNativeError(res, error);
      } else {
        next(error);
      }
    }
  });
  return router;
}
export interface LocalAutomationOpenClawDeps {
  gatewayId(): string;
  gatewayUrl(): string;
  openAuthenticatedUpstream: typeof openAuthenticatedUpstream;
  attachRpcClient: typeof attachUpstreamRpcClient;
}

const localAutomationOpenClawDeps: LocalAutomationOpenClawDeps = {
  gatewayId: () => process.env.GATEWAY_ID ?? "",
  gatewayUrl: () => process.env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789",
  openAuthenticatedUpstream,
  attachRpcClient: attachUpstreamRpcClient,
};

export async function invokeLocalOpenClaw(
  method: string,
  params: Record<string, unknown>,
  deps: LocalAutomationOpenClawDeps = localAutomationOpenClawDeps,
): Promise<unknown> {
  const gatewayId = deps.gatewayId();
  if (!isValidGatewayId(gatewayId)) throw new Error("GATEWAY_ID is required for automation broker");
  const ws = await deps.openAuthenticatedUpstream({
    gatewayId,
    url: deps.gatewayUrl(),
    timeoutMs: AUTOMATION_OPENCLAW_CONNECT_TIMEOUT_MS,
  });
  const rpc = deps.attachRpcClient(ws, { timeoutMs: AUTOMATION_OPENCLAW_RPC_TIMEOUT_MS });
  try {
    const result = await rpc.call(method, params);
    if (!result.ok) {
      if (result.error) throw new NativeAutomationError(result.error);
      throw new Error(`automation broker ${method} failed: ${result.reason}`);
    }
    return result.result;
  } finally {
    rpc.dispose();
    ws.close();
  }
}

const automationsRouter = createAutomationsRouter({
  authorizeOwner: authorizeAutomationOwner,
  localGatewayId: () => process.env.GATEWAY_ID ?? null,
  invoke: invokeLocalOpenClaw,
});

export default automationsRouter;
