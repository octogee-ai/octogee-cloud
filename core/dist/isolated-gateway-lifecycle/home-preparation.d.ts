import type { PlatformUserRecord } from "../platform-state/users.js";
import { type CopyHomeDisk, type HomeCopyInput, type HomeCopyProgress, type UserHomeLocation, type UserHomeMigration, type UserHomeOwner } from "./home.js";
import { type AllocateIsolatedGatewayInput, type IsolatedLifecycleDeps, type LifecycleMode } from "./inputs.js";
export interface HomeCapabilities {
    environment: string;
    subnetwork: string;
    nativeZones: readonly string[];
    nativeZone(uid: string): Promise<string | null>;
    inventory(uid: string, owner: UserHomeOwner): Promise<UserHomeLocation | null>;
    verifyStopped(uid: string, source: UserHomeLocation): Promise<void>;
    copy: {
        advance(input: HomeCopyInput): Promise<{
            progress: HomeCopyProgress;
            target?: CopyHomeDisk;
        }>;
        release(input: HomeCopyInput): Promise<boolean>;
        abort(input: HomeCopyInput): Promise<boolean>;
    };
    adopt(input: {
        uid: string;
        target: CopyHomeDisk;
    }): Promise<boolean>;
    removeStoppedHome(uid: string, source: UserHomeLocation): Promise<boolean>;
}
export interface HomeEffect {
    name: string;
    resource: string;
}
export type HomeCapabilitiesFactory = (record: (effect: HomeEffect) => void) => HomeCapabilities;
export declare class HomeComputeUnavailableError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export type HomePreparationRequest = Pick<AllocateIsolatedGatewayInput, "uid" | "leaseId" | "generation" | "sizingKey" | "sizingTier" | "sourceGatewayId" | "sourceAssignmentEpoch">;
export type HomePreparationStep = "start" | Exclude<UserHomeMigration["phase"], "complete" | "blocked">;
export type HomePreparation = {
    state: "ready";
} | {
    state: "in-progress";
    step: HomePreparationStep;
    lastError?: {
        code: string;
    };
} | {
    state: "blocked";
    reason: string;
    attempts: number;
};
export type HomePreparationDeps = Pick<IsolatedLifecycleDeps, "store" | "readSizingKey" | "requireOwner" | "now" | "log"> & {
    home: HomeCapabilities;
};
export declare function assertHomePreparationAuthority(owner: PlatformUserRecord, sizingKey: string | null, request: HomePreparationRequest): void;
export declare function prepareIsolatedHome(deps: HomePreparationDeps, request: HomePreparationRequest, mode?: LifecycleMode): Promise<HomePreparation>;
export declare function homePreparationReady(preparation: HomePreparation): boolean;
