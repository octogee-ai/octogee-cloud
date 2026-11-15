import { trustedBrokerBaseUrl } from "@octogee/core/internal-brokers/automation-authorization-broker";
import { internalFetch } from "@octogee/core/internal-fetch";

export interface WorkspaceNativeIdentity { uid: string; gatewayId: string; workspaceSlug: string; targetUid?: string }
export class WorkspaceNativeAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export async function resolveWorkspaceNativeIdentity(args: {
  gatewayId: string; authorization?: string; targetUid?: string;
  baseUrl?: string; env?: Record<string, string | undefined>; tokenPath?: string; fetchImpl?: typeof fetch;
}): Promise<WorkspaceNativeIdentity> {
  if (!args.authorization?.startsWith("Bearer ")) throw new WorkspaceNativeAccessError(401, "Unauthenticated");
  const env = args.env ?? process.env;
  const raw = args.baseUrl ?? env.OPENCLAW_RUNTIME_BROKER_URL;
  if (!raw) throw new Error("OPENCLAW_RUNTIME_BROKER_URL is required");
  const base = trustedBrokerBaseUrl(raw, env);
  const response = await internalFetch(`${base}/internal/openclaw-control/workspace-access`, {
    method: "POST", headers: { authorization: args.authorization, "content-type": "application/json" },
    body: JSON.stringify({ gatewayId: args.gatewayId, ...(args.targetUid ? { targetUid: args.targetUid } : {}) }), redirect: "error",
  }, { tokenPath: args.tokenPath, fetchImpl: args.fetchImpl, requireProjectedToken: true, timeoutMs: 5000 });
  if (!response.ok) throw new WorkspaceNativeAccessError([401, 403, 404].includes(response.status) ? response.status : 503, "Workspace access unavailable");
  const body = await response.json() as WorkspaceNativeIdentity;
  if (body.gatewayId !== args.gatewayId || typeof body.uid !== "string" || !body.uid || typeof body.workspaceSlug !== "string" || !body.workspaceSlug ||
    body.targetUid !== args.targetUid) throw new Error("Workspace broker returned an invalid identity");
  return body;
}
