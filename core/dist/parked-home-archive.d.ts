import type { PlatformStateStore } from "./platform-state/store.js";
import type { PlatformUserRecord } from "./platform-state/users.js";
interface ParkedHomeArchiveGrant {
    ownerUid: string;
    sizingProfile: string;
}
export declare function parkedHomeUnderSnapshotCustody(owner: PlatformUserRecord | null): boolean;
export declare function resolveParkedHomeArchiveGrant(environment: string | null | undefined, value: string | undefined): ParkedHomeArchiveGrant | undefined;
export declare function simpleHomePreparation(value: PlatformUserRecord["home"]["homeMigration"]): boolean;
export declare function enqueueParkedHomeArchive(store: PlatformStateStore, input: {
    ownerUid: string;
    grant: ParkedHomeArchiveGrant | undefined;
    createdBy: string;
    dryRun?: boolean;
}): Promise<{
    operationId: string;
}>;
export {};
