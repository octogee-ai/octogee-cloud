import { type MigrationPhase } from "./fleet-migration.js";
import { type MigrationClient } from "./fleet-migration-client.js";
import type { FleetBrokerProjectCheckoutScope } from "@octogee/shared/types/fleet-broker";
import type { ScheduleRestoreFailureRecord, ScheduleTransferDoc } from "@octogee/shared/types/fleet-controller";
import type { WorkspaceMigrationPhase } from "@octogee/shared/types/workspace-migration";
export interface ReportedStep {
    name: string;
    status: "running" | "done" | "failed" | "skipped";
    error?: string;
}
export interface CutoverCommit {
    uid: string;
    slug: string;
    toGatewayId: string;
    fromGatewayId: string;
    flipMirror: boolean;
}
export type ScheduleRestoreRecord = Pick<ScheduleTransferDoc, "restoredTo" | "restoredAt"> & Required<Pick<ScheduleTransferDoc, "restoreAttemptedTo" | "restoreAttemptedAt" | "restoreFailures">>;
export interface MigrationRunnerDeps {
    client: MigrationClient;
    commitCutover: (commit: CutoverCommit) => Promise<void>;
    readCurrentGateway?: () => Promise<string | null>;
    prepareRollbackTarget?: (gatewayId: string, slug: string) => Promise<void>;
    prepareRollbackSource?: (gatewayId: string, slug: string) => Promise<void>;
    setAssignmentState?: (input: {
        gatewayId: string;
        uid: string;
        state: "serving" | "quiescing" | "migrating";
    }) => Promise<void>;
    readScheduleTransfer: (migrationId: string) => Promise<ScheduleTransferDoc | null>;
    saveScheduleTransfer: (doc: ScheduleTransferDoc) => Promise<void>;
    recordScheduleRestore: (migrationId: string, restore: ScheduleRestoreRecord) => Promise<void>;
    finishLegacySchedulerHandoff?: () => Promise<void>;
    log: (msg: string) => void;
    reportStep?: (step: ReportedStep) => Promise<void> | void;
    setMigrationPhase?: (phase: WorkspaceMigrationPhase) => Promise<void>;
    readTargetSystemConfigCommit?: (gatewayId: string) => Promise<string | null>;
    persistForwardRecovery?: (state: {
        sourceSystemConfigCommit?: string;
    }) => Promise<void>;
    now?: () => number;
    wait?: (delayMs: number) => Promise<void>;
}
export declare function isTargetSchedulerNotReady(error: unknown): boolean;
export declare function isPermanentSchedulerRefusal(error: unknown): boolean;
export interface MigrationRunnerInput {
    resumeForwardRecovery?: {
        sourceSystemConfigCommit?: string;
    };
    operationId?: string;
    migrationId: string;
    uid: string;
    slug: string;
    fromGatewayId: string;
    toGatewayId: string;
    crossGateway?: boolean;
    gateAssignment?: boolean;
    projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
    includeActivationManifest?: boolean;
    preserveSource?: true;
    verifyPreparedTarget?: true;
    convergeTargetSystemConfig?: TargetSystemConfigConvergence;
}
export type TargetSystemConfigConvergence = "source-commit" | "target-commit";
export interface MigrationRunnerResult {
    waitingForUserIdle?: boolean;
    success: boolean;
    finalPhase: MigrationPhase;
    errorAt?: {
        phase: MigrationPhase;
        error: string;
    };
    rolledBack: boolean;
}
interface ScheduleTransferScope {
    migrationId: string;
    slug: string;
}
type ScheduleRestoreDeps = Pick<MigrationRunnerDeps, "client" | "log" | "now" | "readScheduleTransfer" | "recordScheduleRestore">;
export interface ScheduleRestoreFailure {
    name: string;
    agentId: string | null;
    sourceJobId: string | null;
    error: string;
    transient: boolean;
}
export declare function scheduleRestoreRecord(gatewayId: string, at: number, failures: readonly ScheduleRestoreFailureRecord[], custodyReleased: boolean): ScheduleRestoreRecord;
export declare function awaitsOnlyCustodyRelease(doc: ScheduleTransferDoc): boolean;
export declare function restoreScheduleTransfer(deps: ScheduleRestoreDeps, input: ScheduleTransferScope & {
    gatewayId: string;
    doc?: ScheduleTransferDoc;
    custodyReleased?: boolean;
}): Promise<ScheduleRestoreFailure[]>;
type SchedulerRequest = Parameters<MigrationClient["scheduler"]>[0];
export declare function callReleasedTargetScheduler(deps: Pick<MigrationRunnerDeps, "client" | "log" | "now" | "wait">, request: SchedulerRequest): Promise<void>;
export declare function runMigration(input: MigrationRunnerInput, deps: MigrationRunnerDeps): Promise<MigrationRunnerResult>;
export {};
