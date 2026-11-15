import { clientRequestLimit } from "../../middleware/authenticated-request-limit.js";
import { Router } from "express";
import { requireByotSyncInternalAuth } from "../../middleware/byot-sync-auth.js";
import { openAuthenticatedUpstream } from "../../chat-proxy/openclaw/authenticated-upstream.js";
import { attachUpstreamRpcClient } from "../../chat-proxy/openclaw/bridge-upstream-rpc.js";
import { openNativeUserClient } from "../../openclaw-control/native-user-client.js";
import { resolveWorkspaceNativeIdentity } from "../../lib/workspace-native-access.js";
import { NativeConnectorApprovalAccessError, runNativeConnectorApproval, type NativeConnectorCommand, type NativeApprovalClient } from "../../lib/native-connector-approval.js";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

async function openService(): Promise<NativeApprovalClient> {
  const ws = await openAuthenticatedUpstream({ gatewayId: process.env.GATEWAY_ID!, url: "ws://127.0.0.1:18789", timeoutMs: 5000 });
  const rpc = attachUpstreamRpcClient(ws, { timeoutMs: 15_000 });
  return { call: rpc.call, scopes: new Set(["operator.admin"]), close: () => { rpc.dispose(); ws.close(); } };
}

function validCommand(value: unknown): value is NativeConnectorCommand {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  if (["gatewayId", "ownerUid", "agentId"].some(key => typeof input[key] !== "string" || !input[key])) return false;
  if (input.operation === "create") return ["title", "detail", "actionUrl", "coachChannelId"].every(key => typeof input[key] === "string" && input[key]);
  if (typeof input.nativeId !== "string" || !input.nativeId.startsWith("plugin:")) return false;
  if (input.operation === "get") return input.reviewerUid === undefined || typeof input.reviewerUid === "string";
  return input.operation === "resolve" && typeof input.reviewerUid === "string" && Boolean(input.reviewerUid)
    && input.decision === "deny";
}

export function createInternalConnectorApprovalRouter() {
  const router: Router = Router({ mergeParams: true });
  router.post("/", clientRequestLimit(1200, true), requireByotSyncInternalAuth, async (req, res, next) => {
    try {
      const command = req.body?.command;
      if (req.body?.purpose !== "connector-approval" || !validCommand(command)) { res.status(400).json({ error: "invalid_approval_command" }); return; }
      if (command.gatewayId !== process.env.GATEWAY_ID || command.gatewayId !== req.params.gatewayId) {
        res.status(409).json({ error: "gateway_mismatch" }); return;
      }
      const isolated = isIsolatedGatewayClassValue(process.env.GATEWAY_CLASS);
      if (isolated && command.operation !== "create" && command.reviewerUid) {
        const identity = await resolveWorkspaceNativeIdentity({ gatewayId: command.gatewayId, authorization: req.body.authorization });
        if (identity.uid !== command.reviewerUid) { res.status(403).json({ error: "reviewer_mismatch" }); return; }
      }
      res.set("cache-control", "no-store").json(await runNativeConnectorApproval(command, { isolated, openService, openUser: openNativeUserClient }));
    } catch (error) {
      if (error instanceof NativeConnectorApprovalAccessError) {
        res.status(error.status).set("cache-control", "no-store").json({ error: error.code });
        return;
      }
      next(error);
    }
  });
  return router;
}
