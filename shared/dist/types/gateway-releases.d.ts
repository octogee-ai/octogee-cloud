import type { MigrationProgressRecord } from "./glm.js";
import type { GatewayPodPlacement, GatewayPodReplacements } from "./gateway-pod-replacements.js";
import { type GatewayMutableConfig } from "./gateway-mutable-config.js";
import { type GatewayDesiredStatus } from "./glm.js";
export declare const GATEWAY_RELEASES_SUBCOLLECTION = "releases";
export declare const GATEWAY_ASSIGNMENTS_SUBCOLLECTION = "assignments";
export type GatewayLifecycleStatus = GatewayDesiredStatus;
export interface GatewayRetirementClaim {
    operationId: string;
    version: number;
    claimedAt: number;
    phase: "claimed";
    liveRelease: number | null;
    liveRuntimeIdentity: {
        startedAt: number;
        version: string;
        openclawVersion: string;
    } | null;
    previousDesiredStatus: Exclude<GatewayLifecycleStatus, "retired">;
}
export interface GatewayDoc {
    gatewayId: string;
    createdAt: number;
    createdBy: string;
    updatedAt: number;
    updatedBy: string;
    latestRelease: number;
    desiredRelease: number;
    liveRelease: number | null;
    desiredStatus: GatewayLifecycleStatus;
    retireAfter?: number | null;
    retirementVersion?: number;
    retirementClaim?: GatewayRetirementClaim | null;
}
export interface GatewayEdgeImage {
    imageRepository: string;
    imageTag: string;
}
export interface GatewayProfileImage {
    imageRepository: string;
    imageTag: string;
}
export type GatewayProfileImages = {
    builder: GatewayProfileImage;
} | {
    isolated: GatewayProfileImage;
};
export declare function dualReadIsolatedProfileImage(images: GatewayProfileImages): GatewayProfileImage;
export interface ReleasePayload {
    imageRepository: string;
    imageTag: string;
    openclawSourceSha?: string;
    profileImages?: GatewayProfileImages;
    gatewayEdgeImage?: GatewayEdgeImage;
}
export declare function isReleasePayload(value: unknown): value is ReleasePayload;
export declare function isGatewayEdgeImage(value: unknown, gatewayImageRepository: string): value is GatewayEdgeImage;
export type ReleasePayloadSchemaUpgrade = {
    status: "current";
    payload: ReleasePayload;
    payloadHash: string;
} | {
    status: "upgraded";
    migration: "remove-retired-mac-ops-token-protocol";
    payload: ReleasePayload;
    payloadHash: string;
} | {
    status: "unsupported";
    reason: "payload-hash-mismatch" | "unsupported-payload-schema";
};
export declare function upgradeReleasePayloadSchema(payload: unknown, persistedPayloadHash: unknown): ReleasePayloadSchemaUpgrade;
export interface ReleaseDoc {
    gatewayId: string;
    release: number;
    createdAt: number;
    createdBy: string;
    sourceRelease: number | null;
    note: string | null;
    payloadHash: string;
    payload: ReleasePayload;
}
export type AssignmentSource = "onboarding" | "migrate-user" | "repair";
export type AssignmentState = "serving" | "quiescing" | "migrating";
export declare function isAssignmentState(value: unknown): value is AssignmentState;
export interface AssignmentDoc {
    uid: string;
    slug: string;
    gatewayId: string;
    source: AssignmentSource;
    state: AssignmentState;
    epoch: number;
    createdAt: number;
    updatedAt: number;
    updatedByOperationId: string | null;
    handoffProgress?: MigrationProgressRecord[];
    sharedSurgeForwardRecovery?: {
        operationId: string;
        targetPodUid: string;
        receivingPodUid: string;
    };
}
export type GatewayRuntimeLifecycle = "provisioning" | "serving" | "failed";
export type GatewayHeartbeatStatus = "unknown" | "booting" | "ready" | "unreachable" | "error";
export interface GatewayHelmObservation {
    releaseName: string;
    deploymentName: string;
    gatewayServiceName: string;
    gatewayEdgeServiceName: string;
    serviceAccountName: string;
    imageRepository: string | null;
    imageTag: string | null;
    replicas: number | null;
    availableReplicas: number | null;
    lastAppliedAt: number | null;
}
export interface GatewayHeartbeatObservation {
    status: GatewayHeartbeatStatus;
    lastHeartbeatAt: number | null;
    version: string | null;
    openclawVersion: string | null;
    internalUrl: string | null;
    startedAt: number | null;
    mountedCustomers: string[];
    migratingIn: string[];
    configStatus?: import("./fleet-controller.js").GatewayConfigStatus;
    configuredBuilder?: import("./fleet-controller.js").ConfiguredUserReport | null;
    openclawProcess?: import("./fleet-controller.js").OpenClawProcessReport | null;
}
export interface GatewayRuntimeDoc {
    docKind: "runtime";
    gatewayId: string;
    release: number;
    lifecycle: GatewayRuntimeLifecycle;
    createdAt: number;
    createdByOperationId: string | null;
    helm: GatewayHelmObservation;
    heartbeat: GatewayHeartbeatObservation;
    kubernetes?: GatewayKubernetesObservation;
    podReplacements?: GatewayPodReplacements;
    lastError: {
        message: string | null;
        at: number | null;
    };
}
export declare const GATEWAY_KUBERNETES_STATUSES: readonly ["ready", "not-ready", "missing", "unknown"];
export type GatewayKubernetesStatus = (typeof GATEWAY_KUBERNETES_STATUSES)[number];
export declare function isGatewayKubernetesStatus(value: unknown): value is GatewayKubernetesStatus;
export interface GatewayKubernetesReading {
    readonly kubernetes: {
        readonly status: GatewayKubernetesStatus;
        readonly totalPods: number | null;
        readonly readyPods: number | null;
        readonly ageMs: number | null;
    };
    readonly kubernetesObservedAt: number | null;
}
export interface GatewayKubernetesObservation {
    status: GatewayKubernetesStatus;
    totalPods: number;
    readyPods: number;
    observedAt: number;
    pods?: GatewayPodPlacement[];
}
export declare function hasFreshReadyKubernetesObservation(runtime: Pick<GatewayRuntimeDoc, "kubernetes">, nowMs: number, maxAgeMs: number): boolean;
export declare function isGatewayRuntimeDoc(data: unknown): data is GatewayRuntimeDoc;
export declare function isGatewayDesiredDoc(data: unknown): data is GatewayDoc;
export declare function projectGatewayDesiredRootForGateway(value: unknown, gatewayId: string): (GatewayDoc & GatewayMutableConfig) | null;
export declare function helmReleaseNameForGateway(gatewayId: string): string;
export declare function gatewayEdgeServiceName(id: string): string;
export declare function gatewayPodServiceName(id: string): string;
export declare function releasePayloadHash(payload: ReleasePayload): string;
export declare const PLATFORM_RELEASE_RECORD_DOC_PATH = "glmControllerState/platformRelease";
export interface PlatformReleaseRecord {
    schemaVersion: 1;
    payloadHash: string;
    imageTag: string;
    openclawSourceSha: string | null;
    writtenAt: number;
}
export declare function platformReleaseRecord(payload: ReleasePayload, writtenAt: number): PlatformReleaseRecord;
export declare function parsePlatformReleaseRecord(value: unknown): PlatformReleaseRecord | null;
export type GatewayFieldClassification = "release" | "gateway-mutable";
export declare const RELEASE_FIELDS: readonly ["imageRepository", "imageTag"];
export declare const GATEWAY_MUTABLE_FIELDS: readonly ["profile", "gatewayClass", "imageProfile", "sizingTier", "gcpProject", "gatewayContainerSecurityContext", "serviceAccountName", "serviceAccount", "builderAccess", "ownerUid", "builderSlug", "modelBrokerLimits", "allocation", "desiredStatus", "liveRelease", "retireAfter"];
export declare function classifyGatewayField(field: string): GatewayFieldClassification;
export type PlacementRejectReason = "builder-missing" | "builder-operator-managed" | "account-not-interactive" | "restore-in-progress" | "source-transfer-in-progress" | "gateway-root-invalid" | "gateway-not-running" | "gateway-not-serving" | "gateway-target-not-accepting" | "assigned-elsewhere";
export type CommitPlacementResult = {
    kind: "mirror-only";
} | {
    kind: "assignment-preserved";
} | {
    kind: "assigned";
    release: number | null;
} | {
    kind: "rejected";
    reason: PlacementRejectReason;
};
export declare function userRestoreFencePresent(user: unknown): boolean;
export declare function userRuntimeMutationFenced(user: unknown): boolean;
