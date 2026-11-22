import { type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { type Operation } from "@octogee/shared/types/glm";
import type { OperationRecord } from "../platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction } from "../platform-state/store.js";
import { GUEST_RELEASE_MODE } from "./guest-release.js";
export declare const PARKED_PREWARM_KIND = "prewarm-gateway";
export declare const ACTIVE_PARKED_PREWARM_STATUSES: readonly ["pending", "running"];
interface ParkedPrewarmCommon {
    uid: string;
    gatewayId: string;
    generation: number;
    payload: ReleasePayload;
}
export interface DemandGuestSource {
    gatewayId: string;
    release: number;
}
type GuestReleaseOrigin = {
    sourceSha: string;
    demandSource?: undefined;
} | {
    sourceSha?: undefined;
    demandSource: DemandGuestSource;
};
export type ParkedPrewarmInput = ParkedPrewarmCommon & ({
    mode?: undefined;
    bootImageId: string;
    sourceSha: string;
} | ({
    mode: typeof GUEST_RELEASE_MODE;
    bootImageId?: undefined;
} & GuestReleaseOrigin));
export declare function parkedPrewarmInput(operation: Pick<Operation, "input">): ParkedPrewarmInput;
export interface RetainedGuestDisks {
    bootImageId: string;
    bootDiskId: string;
    homeDiskId: string;
}
export declare function readRetainedGuestDisks(value: unknown): RetainedGuestDisks | undefined;
export declare function readActiveParkedPrewarm(state: Pick<PlatformStateTransaction, "journal">, uid: string): Promise<OperationRecord | null>;
type PrewarmClaim = {
    release: number;
    previousRelease: number;
    previousInstanceId: string;
    sourceGatewayId: string;
    sourceAssignmentEpoch: number;
    guestDisks?: RetainedGuestDisks;
    guestVerifiedAt?: number;
};
declare const BOOTING = "booting";
declare const HANDOFF = "handoff";
declare const REPAIR_PARKING = "repair-parking";
declare const DEMAND_WON = "demand-won";
declare const PREWARM_CLAIM_STATES: readonly ["booting", "handoff", "repairing", "repair-parking"];
type PrewarmClaimState = typeof PREWARM_CLAIM_STATES[number];
export declare function parkedPrewarmPlacementHold(operation: OperationRecord): "blocking" | typeof HANDOFF | undefined;
export declare function activeParkedPrewarmGatewayIds(operations: readonly OperationRecord[]): ReadonlySet<string>;
type PrewarmStart = {
    state: PrewarmClaimState | "parked";
    claim: PrewarmClaim;
} | {
    state: "demand-won" | "ineligible";
};
type OriginalVm = {
    instanceId: string;
    bootImageId: string;
    needsRepair: boolean;
    guestDisks?: RetainedGuestDisks;
};
export declare function latestGuestReleaseRequest(operations: readonly OperationRecord[], request: Pick<ParkedPrewarmCommon, "gatewayId" | "generation">): OperationRecord | undefined;
export declare function startParkedGatewayPrewarm(store: PlatformStateStore, operation: Operation, now: number, sourceVm?: OriginalVm): Promise<PrewarmStart>;
export declare function isFreshParkedPrewarmRecovery(value: unknown, instanceId: string, notBefore: unknown): boolean;
type PrewarmFinishMode = "ready" | "rollback" | "repaired";
interface ParkedBootRejection {
    instanceId: string;
    bootImageId: string;
    reason: string;
}
export declare function finishParkedGatewayPrewarm(store: PlatformStateStore, operation: Operation, now: number, mode: PrewarmFinishMode, bootRejection?: ParkedBootRejection): Promise<"parked" | typeof HANDOFF | typeof DEMAND_WON | typeof REPAIR_PARKING>;
export declare function bootRepairedParkedGateway(store: PlatformStateStore, operation: Operation, now: number): Promise<typeof BOOTING | typeof DEMAND_WON>;
export {};
