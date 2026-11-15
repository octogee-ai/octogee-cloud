import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import { gatewayModelCredentialSyncUrl } from "./byot-sync-trigger.js";
import { createModelCredentialSyncAuthHeaders } from "@octogee/core/model-credentials/byot-sync-internal-auth";
import { NativeConnectorApprovalAccessError, parseNativeApproval, type NativeConnectorCommand, type NativeApprovalSnapshot } from "./native-connector-approval.js";
import { resolveGatewayAssignment, type GatewayResolverState } from "../chat-proxy/openclaw/gateway-resolver.js";
import { parseAgentId } from "@octogee/shared/types/identity";

export interface ConnectorApprovalBinding { ownerUid: string; gatewayId: string; agentId: string; nativeApprovalId: string }
export type ConnectorApprovalRpc = (command: NativeConnectorCommand, authorization?: string) => Promise<unknown>;

export function connectorApprovalRpc(store: GatewayResolverState, env: NodeJS.ProcessEnv = process.env): ConnectorApprovalRpc {
  return async (command, authorization) => {
    const assignment = await resolveGatewayAssignment({ store, uid: command.ownerUid });
    if (assignment.gatewayId !== command.gatewayId) throw new Error("Approval gateway assignment changed; request a new approval");
    const runtime = await store.fleetRegistry.get(command.gatewayId);
    const url = gatewayModelCredentialSyncUrl(command.gatewayId, env, runtime ?? undefined)
      .replace(/\/model-credential-sync$/u, "/connector-approvals");
    const body = { purpose: "connector-approval", command, ...(authorization ? { authorization } : {}) };
    const headers = createModelCredentialSyncAuthHeaders({ body, gatewayId: command.gatewayId, secret: env.BYOT_SYNC_INTERNAL_SIGNING_SECRET ?? "" });
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000), redirect: "error" });
    if (response.status === 403) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("Native connector approval unavailable: HTTP 403 with invalid JSON");
      }
      if (body !== null && typeof body === "object" && "error" in body && body.error === "approval_forbidden") {
        throw new NativeConnectorApprovalAccessError("Native approval permission is required");
      }
    }
    if (!response.ok) throw new Error(`Native connector approval unavailable: HTTP ${response.status}`);
    return response.json();
  };
}

function calendarReminderDetail(kind: string, preview: Record<string, unknown>): string {
  if (kind !== "calendar-create") return "";
  if (preview.reminders !== undefined && preview.reminders !== "default" && preview.reminders !== "none") {
    throw new Error("Calendar reminder policy is malformed");
  }
  return `Reminders: ${preview.reminders === "none" ? "No reminders" : "Calendar defaults"}\n\n`;
}

export async function requestConnectorApproval(store: Pick<PlatformStateRepositories, "workspaces">, rpc: ConnectorApprovalRpc, input: {
  ownerUid: string; gatewayId: string; agentId: string; kind: string; digest: string; preview: Record<string, unknown>; actionUrl: string;
}): Promise<{ nativeApprovalId: string; expiresAtMs: number }> {
  const agent = parseAgentId(input.agentId);
  if (agent.kind !== "coach") throw new Error("Connector approval requires a coach");
  const [workspace, channel] = await Promise.all([
    store.workspaces.records.get(agent.username),
    store.workspaces.channels.get({ workspaceSlug: agent.username, projectSlug: null }, "coach-dm"),
  ]);
  const coachChannelId = channel?.mattermostChannelId;
  if (workspace?.ownerUid !== input.ownerUid || typeof coachChannelId !== "string" || !/^[a-z0-9]{26}$/u.test(coachChannelId)) {
    throw new Error("Canonical Agent DM is unavailable for connector approval");
  }
  const preview = JSON.stringify(input.preview, null, 2);
  const detail = preview.length <= 12_000 ? preview : "This preview exceeds the native display limit. Open the full review link before approving.";
  const result = await rpc({ operation: "create", gatewayId: input.gatewayId, ownerUid: input.ownerUid, agentId: input.agentId,
    title: `Connector: ${input.kind}`, detail: `${calendarReminderDetail(input.kind, input.preview)}${detail}\n\nExact action SHA256: ${input.digest}\nFull review: ${input.actionUrl}`,
    actionUrl: input.actionUrl, coachChannelId }) as { id?: string; expiresAtMs?: number };
  if (!result.id?.startsWith("plugin:") || !Number.isSafeInteger(result.expiresAtMs)) throw new Error("Malformed native approval acceptance");
  return { nativeApprovalId: result.id, expiresAtMs: result.expiresAtMs! };
}

export async function readConnectorApproval(rpc: ConnectorApprovalRpc, binding: ConnectorApprovalBinding,
  reviewer?: { uid: string; authorization: string }, decision?: "deny"): Promise<NativeApprovalSnapshot> {
  const command: NativeConnectorCommand = decision && reviewer
    ? { ...binding, operation: "resolve", nativeId: binding.nativeApprovalId, reviewerUid: reviewer.uid, decision }
    : { ...binding, operation: "get", nativeId: binding.nativeApprovalId, ...(reviewer ? { reviewerUid: reviewer.uid } : {}) };
  const result = await rpc(command, reviewer?.authorization) as { approval?: unknown };
  return parseNativeApproval(result.approval, { nativeId: binding.nativeApprovalId, agentId: binding.agentId });
}

export function connectorApprovalBinding(data: Record<string, unknown>): ConnectorApprovalBinding {
  for (const key of ["ownerUid", "gatewayId", "agentId", "nativeApprovalId"]) {
    if (typeof data[key] !== "string" || !data[key]) throw new Error("Connector approval binding is missing; request a new approval");
  }
  return { ownerUid: data.ownerUid as string, gatewayId: data.gatewayId as string, agentId: data.agentId as string, nativeApprovalId: data.nativeApprovalId as string };
}
