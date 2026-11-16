import { type MigrationClient } from "./fleet-migration-client.js";
import type { NormalFleetMutationResult } from "./normal-fleet-mutation.js";
import type { PlatformStateStore } from "./platform-state/index.js";
export interface StrandedSource {
    uid: string;
    slug: string;
    gatewayId: string;
    epoch: number;
    assignmentUpdatedAt: number;
    operationId: string;
    targetGatewayId: string;
}
export type ScheduleTransferRestored = boolean | "none";
export type SchedulesRestored = ScheduleTransferRestored | "unknown";
export interface StrandedSourceRestored {
    uid: string;
    slug: string;
    gatewayId: string;
    operationId: string;
    targetGatewayId: string;
    state: "serving";
    schedulesRestored: SchedulesRestored;
    sourceDraining: boolean;
}
export type ResumeSourceIngress = (input: {
    operationId: string;
    gatewayId: string;
    slug: string;
}) => Promise<void>;
export type RestoreSourceSchedules = (input: {
    uid: string;
    operationId: string;
    gatewayId: string;
    slug: string;
}) => Promise<ScheduleTransferRestored>;
export interface StrandedSourceGatewayCalls {
    resumeSourceIngress: ResumeSourceIngress;
    restoreSourceSchedules: RestoreSourceSchedules;
}
export interface StrandedSourceRestoreDeps extends StrandedSourceGatewayCalls {
    store: PlatformStateStore;
    log: (message: string) => void;
    now?: () => Date;
}
export declare class StrandedSourceResumeFailed extends Error {
    readonly gatewayId: string;
    readonly operationId: string;
    readonly gatewayAnswered: boolean;
    constructor(source: StrandedSource, cause: unknown);
}
export declare function readStrandedSource(store: PlatformStateStore, uid: string): Promise<StrandedSource>;
export declare function restoreStrandedSourceServing(deps: StrandedSourceRestoreDeps, expected: StrandedSource): Promise<StrandedSourceRestored>;
export declare function strandedSourceRestoreOutcome(restored: Pick<StrandedSourceRestored, "slug" | "gatewayId" | "schedulesRestored" | "sourceDraining">): NormalFleetMutationResult;
export interface StrandedSourceGatewayDeps {
    store: PlatformStateStore;
    clientFor: (gatewayId: string) => Promise<MigrationClient>;
    migrationIdFor: (operationId: string) => string;
    log: (message: string) => void;
    now?: () => number;
}
export declare function strandedSourceGatewayCalls(deps: StrandedSourceGatewayDeps): StrandedSourceGatewayCalls;
