export type RolloutLane = "cluster" | "builder-vm";
export interface FleetOperationLockRef {
    id: string;
    kind: string;
    status?: string;
    input?: unknown;
    userMigrationV2?: unknown;
    rolloutLane?: RolloutLane;
    cutoverCommittedAt?: number;
}
export declare function fleetOperationLockResources(operation: FleetOperationLockRef): ReadonlySet<string>;
export declare function serialLockReleasedAfterCutover(operation: FleetOperationLockRef): boolean;
export declare function serialFleetOperationsConflict(candidate: FleetOperationLockRef, other: FleetOperationLockRef): boolean;
export declare function findActiveGatewayMigration<T extends FleetOperationLockRef>(gatewayId: string, operations: readonly T[]): T | null;
export declare class GatewayMigrationInFlightError extends Error {
    readonly gatewayId: string;
    readonly operationId: string;
    constructor(gatewayId: string, operationId: string);
}
