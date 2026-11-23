import type { ScheduleTransferDoc } from "@octogee/shared/types/fleet-controller";
import type { WorkspaceMigrationPhase } from "@octogee/shared/types/workspace-migration";
import type { UserMigrationV2GatewayRootFence, UserMigrationV2Phase, UserMigrationV2State } from "@octogee/shared/types/glm";
import { type MigrationClient } from "./fleet-migration-client.js";
export interface UserMigrationV2CutoverFence {
    operationId: string;
    migrationId: string;
    sourceGatewayId: string;
    sourceEpoch: number;
    sourceRelease: number;
    sourceAssignmentMode: "assigned" | "unassigned-live";
    sourceRootFence: UserMigrationV2GatewayRootFence;
    targetGatewayId: string;
    targetRelease: number;
    targetRootFence: UserMigrationV2GatewayRootFence;
}
export declare function userMigrationV2GatewayRootFence(value: unknown, gatewayId: string): UserMigrationV2GatewayRootFence | null;
export declare function userMigrationV2GatewayRootFenceEqual(left: UserMigrationV2GatewayRootFence | null | undefined, right: UserMigrationV2GatewayRootFence | null | undefined): boolean;
export declare function userMigrationV2GatewayRootFenceMatches(value: unknown, fence: UserMigrationV2GatewayRootFence): boolean;
export interface UserMigrationV2Deps {
    client: MigrationClient;
    setSourceAssignmentState: (state: "serving" | "quiescing") => Promise<void>;
    commitCutover: (fence: UserMigrationV2CutoverFence) => Promise<void>;
    now: () => number;
    log: (message: string) => void;
    wait?: (delayMs: number) => Promise<void>;
    setMigrationPhase?: (phase: WorkspaceMigrationPhase) => Promise<void>;
    readScheduleTransfer: (migrationId: string) => Promise<ScheduleTransferDoc | null>;
    saveScheduleTransfer: (transfer: ScheduleTransferDoc) => Promise<void>;
}
export declare function advanceUserMigrationV2(state: UserMigrationV2State, deps: UserMigrationV2Deps): Promise<UserMigrationV2State>;
export declare function isUserMigrationV2ForwardOnly(state: UserMigrationV2State): boolean;
export declare function isUserMigrationV2PostIntent(state: UserMigrationV2State): boolean;
export declare function isUserMigrationV2Transition(from: UserMigrationV2Phase, to: UserMigrationV2Phase): boolean;
export declare function beginUserMigrationV2Abort(state: UserMigrationV2State, reason: string, now: number): UserMigrationV2State;
export type UserMigrationV2ErrorClass = "retry" | "terminal";
export declare function classifyUserMigrationV2Error(error: unknown): UserMigrationV2ErrorClass;
