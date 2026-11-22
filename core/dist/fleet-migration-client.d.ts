import { type ScheduleCheckRequestBody, type ScheduleCheckResult, type ScheduleRemoveRequestBody, type ScheduleRemoveResult, type ScheduleRestoreRequestBody, type ScheduleRestoreResult, type ScheduleSnapshotRequestBody, type ScheduleSnapshotResult, type ScheduleTransferRequestBody, type SchedulerMigrationRequestBody, type SchedulerMigrationResult, type FlushGatewayResponse, type HeldNativeSourceBinding, type HeldNativeSourceReconcileProof, type ImportResponse, type MigrationProgressRequestBody, type QuiesceResponse, type RestoreMigrationResponse, type UnmountResponse, type VerifyMigrationResponse } from "@octogee/shared/types/fleet-controller";
import type { FleetBrokerProjectCheckoutScope, FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { MigrationSyncMode } from "./fleet-migration.js";
export interface MigrationClientTimeouts {
    quiesceMs?: number;
    transferMs?: number;
    unmountMs?: number;
    verifyMs?: number;
}
export interface MigrationClientDeps {
    privateKey: string;
    resolveGatewayUrl: (gatewayId: string) => string;
    fetch?: typeof globalThis.fetch;
    log?: (msg: string) => void;
    timeouts?: MigrationClientTimeouts;
    prepareAgentStores?: (gatewayId: string, slug: string) => Promise<void>;
    resolveTransferAttemptForCleanup?: (input: Parameters<MigrationClient["abortImport"]>[0]) => Promise<string | undefined>;
    transferState: MigrationClient["transferState"];
}
interface GatewayAddress {
    gatewayId: string;
    transportId?: string;
}
export interface MigrationClient {
    abortImport(opts: {
        migrationId: string;
        gatewayId: string;
        slug: string;
        mode: MigrationSyncMode;
    }): Promise<void>;
    scheduler(opts: SchedulerMigrationRequestBody & {
        gatewayId: string;
        transportId?: string;
    }): Promise<SchedulerMigrationResult>;
    schedules(opts: ScheduleSnapshotRequestBody & GatewayAddress): Promise<ScheduleSnapshotResult>;
    schedules(opts: ScheduleRestoreRequestBody & GatewayAddress): Promise<ScheduleRestoreResult>;
    schedules(opts: ScheduleRemoveRequestBody & GatewayAddress): Promise<ScheduleRemoveResult>;
    schedules(opts: ScheduleCheckRequestBody & GatewayAddress): Promise<ScheduleCheckResult>;
    schedules(opts: ScheduleTransferRequestBody & GatewayAddress): Promise<ScheduleTransferResult>;
    sourceActivationReadiness(opts: GatewayAddress & {
        migrationId: string;
        slug: string;
    }): Promise<"ready" | "unavailable" | "unsupported">;
    resume(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
        role?: "target";
        requireExactAcknowledgement?: boolean;
    }): Promise<void>;
    quiesce(opts: {
        stopMattermost?: boolean;
        schedulerHandoff?: boolean;
        schedulerMigrationId?: string;
        retainNonportable?: boolean;
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
        timeoutMs?: number;
    }): Promise<QuiesceResponse>;
    flushGateway(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
        reason: string;
        expectedSystemConfigCommit?: string;
    }): Promise<FlushGatewayResponse>;
    restoreTarget(opts: {
        resume?: boolean;
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        uid: string;
        slug: string;
        snapshot: FleetBrokerUserSnapshot;
    }): Promise<RestoreMigrationResponse>;
    transferState(opts: {
        migrationId: string;
        fromGatewayId: string;
        toGatewayId: string;
        fromTransportId?: string;
        toTransportId?: string;
        slug: string;
        mode?: MigrationSyncMode;
        includeActivationManifest?: boolean;
        preserveSource?: true;
        projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
        reportImport?: (status: "running" | "done" | "failed", at: number) => Promise<void>;
    }): Promise<ImportResponse>;
    verifyTarget(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
    }): Promise<VerifyMigrationResponse>;
    unmount(opts: {
        migrationId: string;
        gatewayId: string;
        transportId?: string;
        slug: string;
    }): Promise<UnmountResponse>;
}
export interface MigrationRpcErrorOptions {
    details?: unknown;
    status?: number;
    code?: string;
    retryable?: boolean;
}
export declare class MigrationRpcError extends Error {
    readonly details?: unknown;
    readonly status?: number;
    readonly code?: string;
    readonly retryable: boolean | undefined;
    constructor(message: string, options?: MigrationRpcErrorOptions);
}
export declare class MigrationDrainPendingError extends Error {
    readonly retryable = true;
}
export declare class MigrationTransportError extends Error {
    readonly retryable = true;
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
export declare function isDefinitiveConfigRpcRejection(error: unknown): boolean;
export { reconcileHeldNativeSource } from "./held-native-source-reconcile.js";
export declare function requestHeldNativeSourceReconcile(input: {
    binding: HeldNativeSourceBinding;
    sourceUrl: string;
    privateKey: string;
    fetch?: typeof globalThis.fetch;
}): Promise<HeldNativeSourceReconcileProof>;
export declare function createMigrationClient(deps: MigrationClientDeps): MigrationClient;
type ScheduleTransferResult = ScheduleSnapshotResult | ScheduleRestoreResult | ScheduleRemoveResult | ScheduleCheckResult;
export declare function reportMigrationProgress(deps: Pick<MigrationClientDeps, "privateKey" | "resolveGatewayUrl" | "fetch">, gatewayId: string, body: MigrationProgressRequestBody): Promise<void>;
