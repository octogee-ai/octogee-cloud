import type { PlatformUserRecord } from "../platform-state/users.js";
export interface CopyHomeDisk {
    projectId: string;
    zone: string;
    name: string;
    id: string;
    sizeGb: number;
    source: string;
    diskType: "pd-balanced" | "pd-ssd";
}
export interface HomeCopyInput {
    operationId: string;
    ownerUid: string;
    source: CopyHomeDisk;
    sourceLayout: "flat" | "portable";
    targetZone: string;
    desiredGiB: number;
    subnetwork: string;
}
export type HomeCopyProgress = {
    status: "pending";
} | {
    status: "copying";
    usedBytes: number;
} | {
    status: "ready";
    usedBytes: number;
    filesystem: "btrfs";
    proof: Record<string, string>;
};
export declare class HomeCopyFailure extends Error {
}
export declare function homeCopyCapacity(input: {
    desiredGiB: number;
    sourceGiB: number;
    usedBytes: number;
}): number;
export interface UserHomeLocation {
    runtime: "gce-vm";
    disk: CopyHomeDisk;
    layout: "flat" | "portable";
    computer?: {
        name: string;
        id: string;
        zone: string;
    };
}
export interface HomePreparedFor {
    leaseId: string;
    generation: number;
    sizingKey: string;
}
export type UserHomeMigrationPhase = "copying" | "retaining" | "releasing" | "adopting" | "complete" | "failed" | "retrying" | "blocked";
export interface UserHomeMigration {
    id: string;
    tier: string;
    source: UserHomeLocation;
    copy: HomeCopyInput;
    phase: UserHomeMigrationPhase;
    attempt?: number;
    retryAt?: number;
    error?: string;
    target?: CopyHomeDisk;
    proof?: Extract<HomeCopyProgress, {
        status: "ready";
    }>;
    startedAt: number;
    completedAt?: number;
    preparedFor?: HomePreparedFor;
}
export interface PreparedWithoutMigration {
    phase: "complete";
    preparedFor: HomePreparedFor;
}
export interface UserHomeStorage extends UserHomeLocation {
    retained: UserHomeLocation[];
    admittedAt?: number;
}
export interface UserHomeOwner {
    computer?: {
        instanceName: string;
        instanceId: string;
        zone: string;
    };
    homeStorage?: UserHomeStorage;
    homeMigration?: UserHomeMigration | PreparedWithoutMigration;
    homeDisk?: CopyHomeDisk;
}
export declare function userHomeOwner(user: PlatformUserRecord): UserHomeOwner;
export declare function isActiveHomeMigration(state: UserHomeOwner["homeMigration"]): state is UserHomeMigration;
