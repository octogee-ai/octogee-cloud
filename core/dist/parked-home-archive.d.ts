import { type GatewayVmDesktop } from "@octogee/shared/types/glm";
import type { OperationRecord } from "./platform-state/operations.js";
import type { OpaqueMap, PlatformStateRepositories, PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";
import type { PlatformUserRecord, UserActivationLease, UserHomeArchive } from "./platform-state/users.js";
export interface ParkedHomeArchiveGrant {
    ownerUid: string;
    sizingProfile: string;
    desktop?: GatewayVmDesktop;
}
export declare const logger: import("@octogee/shared/server/service-logger").ServiceLogger;
export declare function readParkedHomeArchiveGrant(state: Pick<PlatformStateRepositories, "config" | "gateways">, target: {
    ownerUid: string;
    gatewayId: string;
}, operatorGrant: ParkedHomeArchiveGrant | undefined): Promise<ParkedHomeArchiveGrant | undefined>;
export declare function readOwnerHomeArchiveGrant(state: Pick<PlatformStateRepositories, "config" | "gateways" | "users">, ownerUid: string, operatorGrant: ParkedHomeArchiveGrant | undefined): Promise<ParkedHomeArchiveGrant | undefined>;
export declare function parkedHomeUnderSnapshotCustody(owner: PlatformUserRecord | null): boolean;
export declare function isAuthorizedHomeArchiveOrigin(operation: {
    origin?: unknown;
    createdBy?: unknown;
}): boolean;
export declare function resolveParkedHomeArchiveGrant(environment: string | null | undefined, value: string | undefined): ParkedHomeArchiveGrant | undefined;
export declare function simpleHomePreparation(value: PlatformUserRecord["home"]["homeMigration"]): boolean;
declare function parkedArchiveInputs(owner: Stored<PlatformUserRecord>): {
    gatewayId: string;
    sharedId: string;
    returnOperationId: string;
};
type ParkedInput = ReturnType<typeof parkedArchiveInputs>;
type ArchiveSource = NonNullable<UserHomeArchive["source"]>;
export declare function schedulerReturnMatches(owner: PlatformUserRecord, input: ParkedInput, returned: OperationRecord, custody: OpaqueMap): boolean;
export declare function retainedBootPreservesScheduler(image: OpaqueMap, custody: OpaqueMap, gateways: readonly string[]): boolean;
export declare function archivedSchedulerSourceImage(owner: PlatformUserRecord, gatewayId: string, instanceId: string, custody: OpaqueMap): {
    id: string;
    name: string;
    project: string;
} | null;
export declare function archiveSchedulerCustodyMatches(owner: PlatformUserRecord, archive: UserHomeArchive): boolean;
interface ArchiveTarget {
    gatewayId: string;
    instanceId: string;
    sharedId: string;
    assignmentEpoch: number;
    source: ArchiveSource;
    desktop: GatewayVmDesktop;
    nativeSchedulerRetirement?: OpaqueMap;
}
export declare function writeParkedHomeArchive(tx: PlatformStateTransaction, owner: Stored<PlatformUserRecord>, target: ArchiveTarget, operation: {
    operationId: string;
    createdBy: string;
    origin: "operator" | "automatic";
    now: number;
}): Promise<void>;
export declare function planReturnedHomeArchive(tx: PlatformStateTransaction, owner: Stored<PlatformUserRecord>, next: UserActivationLease, operatorGrant: ParkedHomeArchiveGrant | undefined, now: number): Promise<(() => Promise<void>) | undefined>;
export declare function planArchiveAfterBackupRelease(tx: PlatformStateTransaction, owner: Stored<PlatformUserRecord>, releaseOperationId: string, operatorGrant: ParkedHomeArchiveGrant | undefined, now: number): Promise<(() => Promise<void>) | undefined>;
export declare function enqueueParkedHomeArchive(store: PlatformStateStore, input: {
    ownerUid: string;
    grant: ParkedHomeArchiveGrant | undefined;
    createdBy: string;
    dryRun?: boolean;
}): Promise<{
    operationId: string;
}>;
export {};
