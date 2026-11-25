import { type GatewayDesiredStatus } from "./glm.js";
export declare const SHARED_POOL_SLOT_ID_PATTERN: RegExp;
export declare const SHARED_POOL_SLOT_ID_REQUIREMENT = "a shared gatewayId must be \"shared-\" followed by lowercase letters or digits";
export declare const DEFAULT_SHARED_GATEWAY_AUTOSCALING_ENABLED = true;
export declare const DEFAULT_SHARED_GATEWAY_USERS_PER_GATEWAY = 10;
export declare const DEFAULT_SHARED_GATEWAY_MIN_GATEWAYS = 1;
export declare const DEFAULT_SHARED_GATEWAY_MAX_GATEWAYS = 32;
export interface SharedGatewayAutoscalingConfig {
    enabled: boolean;
    buildersPerGateway: number;
    minGateways: number;
    maxGateways: number;
}
export interface SharedPoolScalingMember {
    gatewayId: string;
    desiredStatus: GatewayDesiredStatus;
    assignmentCount: number;
    mountedCount: number;
    incomingMigrationCount: number;
    converged: boolean;
    platformCurrent: boolean;
}
export declare const SHARED_POOL_REPLACEMENT_STALL_MS: number;
export interface SharedPoolReplacement {
    sourceGatewayId: string;
    targetGatewayId: string;
    updatedAt: number;
}
export declare function parseSharedPoolReplacements(value: unknown): SharedPoolReplacement[];
export interface SharedPoolScalingInput {
    config: SharedGatewayAutoscalingConfig;
    members: readonly SharedPoolScalingMember[];
    userDemandCount: number;
    now: number;
    replacements?: readonly SharedPoolReplacement[];
}
export type SharedPoolScalingDecision = {
    kind: "hold";
    reason: "disabled" | "steady" | "converging" | "draining" | "replica-ceiling" | "malformed-config" | "malformed-state";
} | {
    kind: "resume-member";
    gatewayId: string;
    reason: "minimum-replicas" | "scale-out" | "cancel-drain";
} | {
    kind: "mint-slot";
    reason: "minimum-replicas" | "scale-out";
} | {
    kind: "mint-slot";
    reason: "platform-replacement";
    replacesGatewayId: string;
} | {
    kind: "finish-replacement";
    sourceGatewayId: string;
    targetGatewayId: string;
} | {
    kind: "supersede-replacement";
    gatewayId: string;
} | {
    kind: "begin-drain";
    gatewayId: string;
} | {
    kind: "retire-member";
    gatewayId: string;
} | {
    kind: "max-capacity";
    assignmentCount: number;
    hotMemberCount: number;
};
export interface SharedGatewayPoolConfig {
    defaultGatewayId: string;
    sharedGatewayIds: readonly string[];
    sharedGatewayAutoscaling?: SharedGatewayAutoscalingConfig;
}
export interface SharedGatewayPoolCandidate {
    gatewayId: string;
    gatewayClass: string;
    desiredStatus: string;
    ready: boolean;
    serving: boolean;
    heartbeatFresh: boolean;
    liveReleaseReady: boolean;
    rosterComplete: boolean;
    incomingMigrationCount: number;
    assignmentCount: number;
}
export type SharedGatewaySelection = {
    kind: "selected";
    gatewayId: string;
    load: number;
    retainedCurrent: boolean;
} | {
    kind: "blocked";
    reason: "no-accepting-shared-gateway";
};
export interface SharedGatewayRebalance {
    fromGatewayId: string;
    toGatewayId: string;
}
export interface SharedPoolMemberRoot {
    gatewayId: string;
    gatewayClass: unknown;
    desiredStatus: unknown;
}
export declare function isSharedPoolSlotId(id: unknown): id is string;
export declare function compareSharedGatewayIds(left: string, right: string): number;
export declare function isSharedPoolMemberRoot(root: SharedPoolMemberRoot): boolean;
export declare const SHARED_POOL_SCALER_CREATOR = "glm-controller-shared-pool-scaler";
export type SharedGatewayAddedBy = "automation" | "operator";
export declare function sharedGatewayAddedBy(root: {
    readonly createdBy: string;
}): SharedGatewayAddedBy;
export declare function sharedPoolMemberIds(roots: readonly SharedPoolMemberRoot[]): string[];
export declare function deriveSharedGatewayPoolConfig(roots: readonly SharedPoolMemberRoot[], sharedGatewayAutoscaling?: SharedGatewayAutoscalingConfig): SharedGatewayPoolConfig | null;
export declare function parseSharedGatewayPoolConfig(value: unknown): SharedGatewayPoolConfig | null;
export declare function parseSharedGatewayAutoscalingConfig(value: unknown): SharedGatewayAutoscalingConfig | null;
export declare function authoritativeSharedGatewayLoad(candidate: SharedGatewayPoolCandidate): number;
export declare function isAcceptingSharedGateway(config: SharedGatewayPoolConfig, candidate: SharedGatewayPoolCandidate): boolean;
export declare function isSettledSharedGateway(config: SharedGatewayPoolConfig, candidate: SharedGatewayPoolCandidate): boolean;
export type SharedGatewayPlacementPurpose = "initial-placement" | "migration";
export interface SharedGatewayPlatformPreference {
    platformCurrentGatewayIds: readonly string[];
    buildersPerGateway: number;
}
export declare function platformPreferredSharedGatewayCandidates(input: {
    config: SharedGatewayPoolConfig;
    candidates: readonly SharedGatewayPoolCandidate[];
    purpose: SharedGatewayPlacementPurpose;
    preference: SharedGatewayPlatformPreference;
    currentGatewayId?: string | null;
}): SharedGatewayPoolCandidate[];
export declare function stableGatewayUidHash(uid: string): number;
export declare function selectSharedGateway(input: {
    uid: string;
    config: SharedGatewayPoolConfig;
    candidates: readonly SharedGatewayPoolCandidate[];
    purpose: SharedGatewayPlacementPurpose;
    currentGatewayId?: string | null;
    buildersPerGateway: number;
}): SharedGatewaySelection;
export declare function planSharedGatewayRebalance(input: {
    config: SharedGatewayPoolConfig;
    candidates: readonly SharedGatewayPoolCandidate[];
}): SharedGatewayRebalance | null;
