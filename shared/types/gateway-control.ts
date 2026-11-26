import type {
  GatewayAccessCapabilities,
  GatewayAccessRole,
} from "./gateway-access.js";
import type { GatewayHeartbeatStatus } from "./gateway-releases.js";
import type { GatewayClass } from "./glm.js";

export interface GatewayControlListEntry {
  gatewayId: string;
  workspaceSlug: string;
  profile: string;
  gatewayClass?: string;
  imageProfile?: string;
  desiredStatus: string;
  imageTag?: string;
  controlUiEnabled: boolean;
  controlUiReady: boolean;
  hasDesktop: boolean;
  isCurrentAssignment: boolean;
  configStatus?: GatewayConfigStatus;
  via: GatewayAccessRole;
  capabilities: GatewayAccessCapabilities;
}

export type GatewayConfigState =
  | "clean"
  | "dirty"
  | "syncing"
  | "error"
  | "unavailable";

export interface GatewayConfigStatus {
  state: GatewayConfigState;
  acceptedCommit?: string;
  lastSyncedAt?: string;
  lastErrorCode?: string;
}

export interface OpenClawControlTicketResponse {
  launchUrl: string;
  expiresAt: number;
}

export interface GatewayControlListResponse {
  gateways: GatewayControlListEntry[];
}

export const USER_ACTIVATION_STATUSES = [
  "requested",
  "provisioning",
  "activating",
  "active",
  "returning",
] as const;
export type UserActivationStatus = (typeof USER_ACTIVATION_STATUSES)[number];

export function isUserActivationStatus(value: unknown): value is UserActivationStatus {
  return (USER_ACTIVATION_STATUSES as readonly unknown[]).includes(value);
}

export interface UserActivationSummary {
  status: UserActivationStatus;
  targetGatewayId: string | null;
}

export const WORKSPACE_GATEWAY_STATUS_MAX_SLUGS = 50;

export interface WorkspaceGatewayStatus {
  workspaceSlug: string;
  gatewayId: string | null;
  gatewayClass: GatewayClass | null;
  runtimeStatus: GatewayHeartbeatStatus;
  activation: UserActivationSummary | null;
}

export interface WorkspaceGatewayStatusResponse {
  workspaces: WorkspaceGatewayStatus[];
}
