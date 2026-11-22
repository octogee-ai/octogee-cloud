import { type GatewayHelmObservation } from "@octogee/shared/types/gateway-releases";
import { type HeldNativeReturnSelection } from "./held-native-return-repair.js";
import type { OperationRecord, PlatformStateRepositories, PlatformStateStore } from "./platform-state/index.js";
export declare class SharedHeldReturnMaintenanceConflict extends Error {
}
export declare const SHARED_HELD_RETURN_MAINTENANCE = "shared-held-return-maintenance";
type Workload = {
    podName: string;
    podUid: string;
    replicaSetUid: string;
    deploymentUid: string;
};
export type SharedInertEmptyPeerScope = {
    gatewayId: string;
    workload: Workload;
};
type RoleImages = {
    gateway: string;
    "gateway-edge": string;
};
type RetainedBoot = {
    gatewayImageTag: string;
    completedInitImageId: string;
};
type RetainedOwner = {
    uid: string;
    slug: string;
    epoch: number;
    homeIdentitySha256: string;
};
export interface SharedHeldReturnMaintenancePlan {
    selection: HeldNativeReturnSelection;
    targetRelease: number;
    workload: Workload;
    retainedBoot: RetainedBoot;
    originalImages: RoleImages;
    maintenanceImages: RoleImages;
    acceptedMaintenanceSource: string;
    acceptedNativeSource: string;
    originalNativeSource: string;
    installedChartFingerprint: string;
    owners: RetainedOwner[];
}
export type SharedHeldReturnMaintenanceAdmission = SharedHeldReturnMaintenancePlan & {
    exactWorkloadObserved: true;
    noInFlightTasks: true;
    noPreparedImports: true;
    rollbackVerified: true;
    observedAt: number;
};
export interface SharedHeldReturnMaintenanceResult {
    attemptId: string;
    outcome: "installed" | "rolled-back";
    workload: Workload;
    images: RoleImages;
    runningImageIds: RoleImages;
    retainedBoot: RetainedBoot;
    nativeSource: string;
    owners: RetainedOwner[];
    noInFlightTasks: true;
    noPreparedImports: true;
    exclusiveReady: true;
    verifiedAt: number;
}
export interface ObservedSharedMaintenanceHelm {
    installed: GatewayHelmObservation;
    chartFingerprint: string;
    edgeImage: string;
    verifiedAt: number;
}
export interface SharedHeldReturnMaintenanceWithdrawal extends Omit<SharedHeldReturnMaintenanceResult, "outcome"> {
    migrationPolicyRestored: true;
    installed: ObservedSharedMaintenanceHelm;
}
export interface SharedHeldReturnMaintenanceClaim {
    gatewayId: string;
    auditId: string;
    attemptId: string;
    plan: SharedHeldReturnMaintenancePlan;
}
export type SharedHeldReturnMaintenanceDispatch = {
    phase: "dispatched" | "rollback";
    release: number;
};
type ScopedMaintenance = {
    operationId: string;
    gatewayId: string;
    attemptId: string;
};
export type SharedHeldReturnMaintenanceCommand = {
    action: "acquire";
    attemptId: string;
    selection: HeldNativeReturnSelection;
} | ({
    action: "status" | "hold-migration-policy" | "dispatch" | "stage" | "apply" | "rollback" | "withdraw" | "complete";
} & ScopedMaintenance);
export type SharedHeldReturnMaintenanceAdmin = (actor: string, command: SharedHeldReturnMaintenanceCommand, dryRun: boolean) => Promise<unknown>;
export interface SharedInertMaintenancePriorProof {
    attemptId: string;
    podUid: string;
    artifactSetId: string;
    originalContainerIds: RoleImages;
    ownerBackups: (RetainedOwner & {
        restoredArchiveSha256: string;
    })[];
}
export interface SharedInertMaintenanceCommonProof {
    attemptId: string;
    podUid: string;
    artifactSetId: string;
    originalContainerIds: RoleImages;
    heldContainerIds: RoleImages;
    observedImageIds: RoleImages;
    ownerHomes: RetainedOwner[];
    custodyGeneration: string;
    restoredArchiveSha256: string;
    writersHeldAt: number;
    capturedAt: number;
    restoredAt: number;
}
type Phase = "reserved" | "withdrawing" | "dispatched" | "rollback";
export declare function assertSharedHeldReturnMaintenanceUnfenced(state: PlatformStateRepositories, operation: Pick<OperationRecord, "input" | "inputUid" | "gatewayId" | "schedulerHandoff">): Promise<void>;
export declare function assertSharedInertEmptyPeerHeld(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, peer: SharedInertEmptyPeerScope, now: () => number): Promise<void>;
export declare function holdSharedInertEmptyPeer(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, peer: SharedInertEmptyPeerScope, verifyExactEmptyWorkload: () => Promise<void>, now: () => number): Promise<void>;
export declare function releaseSharedInertEmptyPeer(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, peer: SharedInertEmptyPeerScope, restoreAndVerifySql: (assertHeld: () => Promise<void>) => Promise<void>, now: () => number): Promise<void>;
export declare function acquireSharedHeldReturnMaintenance(store: PlatformStateStore, deps: {
    environment: "test" | "prod";
    actor: string;
    attemptId: string;
    now: () => number;
    readVerifiedAdmission(): Promise<SharedHeldReturnMaintenanceAdmission>;
}): Promise<SharedHeldReturnMaintenanceClaim>;
export declare function readSharedHeldReturnMaintenanceTerminal(store: PlatformStateStore, operator: ScopedMaintenance & {
    actor: string;
}): Promise<{
    gatewayId: string;
    auditId: string;
    attemptId: string;
    phase: "withdrawn" | "completed";
} | null>;
export declare function resumeSharedHeldReturnMaintenance(store: PlatformStateStore, gatewayId: string, attemptId: string): Promise<SharedHeldReturnMaintenanceClaim>;
export declare function assertSharedHeldReturnMaintenance(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim): Promise<Phase>;
export declare function readSharedHeldReturnMaintenanceDispatch(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim): Promise<SharedHeldReturnMaintenanceDispatch>;
export declare function assertSharedHeldReturnMaintenanceReserved(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim): Promise<void>;
export declare function advanceSharedHeldReturnMaintenance(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, phase: "dispatched" | "rollback", now?: () => number, verifyDispatch?: () => Promise<void>): Promise<void>;
export declare function authorizeSharedInertMaintenance(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, readVerifiedPrior: (assertCurrent: () => Promise<void>) => Promise<SharedInertMaintenancePriorProof>, now?: () => number): Promise<void>;
export declare function assertSharedInertPreLaunch(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim): Promise<SharedInertMaintenancePriorProof>;
export declare function authorizeSharedInertStockLaunch(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, readVerifiedCommon: (assertCurrent: () => Promise<void>) => Promise<SharedInertMaintenanceCommonProof>, now?: () => number): Promise<void>;
export declare function readAuthorizedSharedInertStock(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim): Promise<SharedInertMaintenanceCommonProof>;
export declare function rollbackSharedInertBeforeStock(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, restoreAndVerifyOriginal: (assertCurrent: () => Promise<void>) => Promise<SharedHeldReturnMaintenanceResult>, now?: () => number): Promise<void>;
export declare function stageSharedHeldReturnMaintenanceRelease(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, now: () => number): Promise<number>;
export declare function completeSharedHeldReturnMaintenance(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, deps: {
    readVerifiedResult(): Promise<SharedHeldReturnMaintenanceResult>;
    readInstalledHelm(): Promise<ObservedSharedMaintenanceHelm>;
    restoreMigrationPolicy(assertCurrent: () => Promise<void>): Promise<void>;
    now(): number;
}): Promise<void>;
export declare function withdrawSharedHeldReturnMaintenance(store: PlatformStateStore, claim: SharedHeldReturnMaintenanceClaim, deps: {
    restoreMigrationPolicy(): Promise<void>;
    readVerifiedWithdrawal(): Promise<SharedHeldReturnMaintenanceWithdrawal>;
    now(): number;
}): Promise<void>;
export {};
