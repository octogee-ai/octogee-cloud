import type { PlatformStateRepositories } from "../platform-state/store.js";
interface RestoreGeneration {
    ownerUid: string;
    targetGatewayId: string;
    leaseId: string;
    generation: number;
}
export declare function assertFailedHomeRestoreReleased(state: PlatformStateRepositories, identity: RestoreGeneration): Promise<void>;
export {};
