import { parseAgentId } from "@octogee/shared/types/identity";
export const CONNECTOR_APPROVAL_PLUGIN = "octogee-connector-tools";
export const CONNECTOR_APPROVAL_TIMEOUT_MS = 600_000;
export class NativeConnectorApprovalAccessError extends Error {
    status = 403;
    code = "approval_forbidden";
}
export function nativeApprovalViewState(snapshot) {
    if (snapshot.status === "allowed")
        return "approved";
    if (snapshot.status === "cancelled")
        return "expired";
    return snapshot.status;
}
export function parseNativeApproval(value, binding) {
    const snapshot = value;
    if (!snapshot || snapshot.id !== binding.nativeId || !Number.isSafeInteger(snapshot.expiresAtMs)
        || !["pending", "allowed", "denied", "expired", "cancelled"].includes(snapshot.status)
        || snapshot.presentation?.kind !== "plugin" || snapshot.presentation.pluginId !== CONNECTOR_APPROVAL_PLUGIN
        || snapshot.presentation.agentId !== binding.agentId
        || (snapshot.status === "allowed" && snapshot.decision !== "allow-once")) {
        throw new Error("Native connector approval binding is invalid");
    }
    return snapshot;
}
async function openClient(command, deps) {
    const reviewerUid = command.operation === "create" ? undefined : command.reviewerUid;
    if (!deps.isolated && reviewerUid && reviewerUid !== command.ownerUid)
        throw new NativeConnectorApprovalAccessError("Shared approval requires its owner");
    return deps.isolated && reviewerUid ? deps.openUser(reviewerUid, command.gatewayId) : deps.openService();
}
export async function runNativeConnectorApproval(command, deps) {
    const client = await openClient(command, deps);
    try {
        if (command.operation !== "create" && command.reviewerUid && deps.isolated && !client.scopes.has("operator.admin") && !client.scopes.has("operator.approvals")) {
            throw new NativeConnectorApprovalAccessError("Native approval permission is required");
        }
        const call = async (method, params) => {
            const result = await client.call(method, params);
            if (!result.ok)
                throw new Error(`OpenClaw ${method}: ${result.reason}`);
            return result.result;
        };
        if (command.operation === "create") {
            const agent = parseAgentId(command.agentId);
            if (agent.kind !== "coach")
                throw new Error("Connector approval requires a coach");
            const result = await call("plugin.approval.request", {
                pluginId: CONNECTOR_APPROVAL_PLUGIN, agentId: command.agentId,
                title: command.title, description: `Approve in Octogee. You can deny here or there: ${command.actionUrl}`,
                detail: command.detail, severity: "warning", allowedDecisions: ["deny"],
                timeoutMs: CONNECTOR_APPROVAL_TIMEOUT_MS, twoPhase: true,
                turnSourceChannel: "mattermost", turnSourceAccountId: `${agent.username}-coach`,
                turnSourceTo: `channel:${command.coachChannelId}`,
            });
            if (result.status !== "accepted" || !result.id?.startsWith("plugin:") || !Number.isSafeInteger(result.expiresAtMs)) {
                throw new Error("OpenClaw did not accept the connector approval delivery");
            }
            return result;
        }
        const result = await call("approval.get", { id: command.nativeId });
        parseNativeApproval(result.approval, command);
        if (command.operation === "get")
            return result;
        const resolved = await call("approval.resolve", { id: command.nativeId, kind: "plugin", decision: command.decision });
        parseNativeApproval(resolved.approval, command);
        return resolved;
    }
    finally {
        client.close();
    }
}
