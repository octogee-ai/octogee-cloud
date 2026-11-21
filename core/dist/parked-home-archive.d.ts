import type { PlatformStateStore } from "./platform-state/store.js";
interface ParkedHomeArchiveGrant {
    ownerUid: string;
    sizingProfile: string;
}
export declare function resolveParkedHomeArchiveGrant(environment: string | null | undefined, value: string | undefined): ParkedHomeArchiveGrant | undefined;
export declare function enqueueParkedHomeArchive(store: PlatformStateStore, input: {
    ownerUid: string;
    grant: ParkedHomeArchiveGrant | undefined;
    createdBy: string;
    dryRun?: boolean;
}): Promise<{
    operationId: string;
}>;
export {};
