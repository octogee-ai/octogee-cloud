import { userEntitlements, type UserEntitlementInputs } from "@octogee/shared/types/user-entitlements";
export const GATEWAY_ACCESS_AUDIT_COLLECTION = "gatewayAccessAudit";

export interface GatewayPrincipalGateway {
  perUserIdentity?: boolean;
  gatewayId: string;
  ownerUid: string | null;
  workspaceSlug: string | null;
}

export interface ResolvedGatewayAccess {
  kind: "owner" | "member";
  dashboard: boolean;
  workspaceManagement: boolean;
}

export type GatewayAccessDenialReason = "gateway_unowned" | "membership_required" | "identity_required";
export type GatewayPrincipalAccess = ResolvedGatewayAccess | { kind: "denied"; reason: GatewayAccessDenialReason };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function isCanonicalWorkspaceMembership(value: unknown): boolean {
  const membership = record(value);
  return membership?.canonicalSource === "mattermost-general" &&
    membership.canonicalState === "active" &&
    nonEmptyString(membership.mattermostChannelId) &&
    nonEmptyString(membership.mattermostUserId);
}

export function resolveGatewayPrincipalAccess(input: {
  gateway: GatewayPrincipalGateway;
  uid: string;
  membership: unknown;
}): GatewayPrincipalAccess {
  if (!input.gateway.ownerUid || !input.gateway.workspaceSlug) return { kind: "denied", reason: "gateway_unowned" };
  if (input.gateway.ownerUid === input.uid) {
    return { kind: "owner", dashboard: true, workspaceManagement: true };
  }
  if (!isCanonicalWorkspaceMembership(input.membership)) return { kind: "denied", reason: "membership_required" };
  if (input.gateway.perUserIdentity !== true) return { kind: "denied", reason: "identity_required" };
  return { kind: "member", dashboard: true, workspaceManagement: false };
}

export function workspacePermissionsEnabled(config: { gatewayClass?: string; builderAccess?: { controlIdentity?: string } | null }, owner: UserEntitlementInputs, now = new Date()): boolean {
  return config.gatewayClass === "isolated" && config.builderAccess?.controlIdentity === "per-user" && userEntitlements().sizingKey(owner, now) !== null;
}
