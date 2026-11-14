import { userEntitlements } from "@octogee/shared/types/user-entitlements";
export const GATEWAY_ACCESS_AUDIT_COLLECTION = "gatewayAccessAudit";
function record(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value : null;
}
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
export function isCanonicalWorkspaceMembership(value) {
    const membership = record(value);
    return membership?.canonicalSource === "mattermost-general" &&
        membership.canonicalState === "active" &&
        nonEmptyString(membership.mattermostChannelId) &&
        nonEmptyString(membership.mattermostUserId);
}
export function resolveGatewayPrincipalAccess(input) {
    if (!input.gateway.ownerUid || !input.gateway.workspaceSlug)
        return { kind: "denied", reason: "gateway_unowned" };
    if (input.gateway.ownerUid === input.uid) {
        return { kind: "owner", dashboard: true, workspaceManagement: true };
    }
    if (!isCanonicalWorkspaceMembership(input.membership))
        return { kind: "denied", reason: "membership_required" };
    if (input.gateway.perUserIdentity !== true)
        return { kind: "denied", reason: "identity_required" };
    return { kind: "member", dashboard: true, workspaceManagement: false };
}
export function workspacePermissionsEnabled(config, owner, now = new Date()) {
    return config.gatewayClass === "isolated" && config.builderAccess?.controlIdentity === "per-user" && userEntitlements().sizingKey(owner, now) !== null;
}
