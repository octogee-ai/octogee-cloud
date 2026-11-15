export declare class WorkspaceStorageQuotaError extends Error {
    readonly limitBytes: number;
    readonly projectedBytes: number;
    readonly name = "WorkspaceStorageQuotaError";
    readonly code = "FREE_STORAGE_LIMIT";
    constructor(limitBytes: number, projectedBytes: number);
}
export interface WorkspaceStorageReservation {
    slug: string;
    path: string;
    id: string;
    previousSize: number;
    newSize: number;
}
export interface WorkspaceStorageReservationInput {
    slug: string;
    path: string;
    newSize: number;
    manifestBytes: number;
    manifestPathBytes: number;
    limitBytes: number;
}
export interface WorkspaceStorageRelease {
    slug: string;
    path: string;
    removedBytes: number;
}
export interface WorkspaceStorageAccounting {
    reserve(input: WorkspaceStorageReservationInput): Promise<WorkspaceStorageReservation>;
    finalize(reservation: WorkspaceStorageReservation): Promise<void>;
    rollback(reservation: WorkspaceStorageReservation): Promise<void>;
    release(input: WorkspaceStorageRelease): Promise<void>;
}
export declare const NO_WORKSPACE_STORAGE_ACCOUNTING: WorkspaceStorageAccounting;
export declare function installWorkspaceStorageAccounting(accounting: WorkspaceStorageAccounting): void;
export declare function workspaceStorageAccounting(): WorkspaceStorageAccounting;
