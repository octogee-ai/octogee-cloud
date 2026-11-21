import type { MigrationTransferMode } from "@octogee/shared/types/fleet-controller";
import type { Revision, Stored } from "./store.js";
export type MigrationTransferTaskStatus = "running" | "succeeded" | "failed";
export interface MigrationTransferLeasePod {
    readonly name: string;
    readonly uid: string;
}
export interface MigrationTransferTask {
    readonly id: string;
    readonly kind: string;
    readonly migrationId: string;
    readonly slug: string;
    readonly mode: MigrationTransferMode;
    readonly sourceGatewayId: string;
    readonly targetGatewayId: string;
    readonly status: MigrationTransferTaskStatus;
    readonly attempt: number;
    readonly attemptId: string;
    readonly leaseOwner: string | null;
    readonly leasePod: MigrationTransferLeasePod | null;
    readonly leaseExpiresAt: number | null;
    readonly leaseRestartCount: number | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly startedAt: number;
    readonly completedAt: number | null;
    readonly error: string | null;
}
export interface MigrationTransferClaim {
    readonly attempt: number;
    readonly attemptId: string;
    readonly leaseOwner: string;
}
export interface MigrationTasksRepository {
    get(taskId: string): Promise<Stored<MigrationTransferTask> | null>;
    listByStatus(statuses: readonly MigrationTransferTaskStatus[]): Promise<readonly Stored<MigrationTransferTask>[]>;
    claim(task: MigrationTransferTask, expected: Revision | "absent"): Promise<void>;
    finish(taskId: string, claim: MigrationTransferClaim, completedAt: number, error: string | null): Promise<void>;
}
export declare function migrationTransferTaskId({ migrationId, mode }: {
    migrationId: string;
    mode?: MigrationTransferMode;
}): string;
export declare function retargetedMigrationTransferId(migrationId: string, gatewayId: string): string;
