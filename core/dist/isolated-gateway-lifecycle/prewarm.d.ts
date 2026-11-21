import { type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { type Operation } from "@octogee/shared/types/glm";
import type { OperationRecord } from "../platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction } from "../platform-state/store.js";
export declare const PARKED_PREWARM_KIND = "prewarm-gateway";
export declare const ACTIVE_PARKED_PREWARM_STATUSES: readonly ["pending", "running"];
export interface ParkedPrewarmInput {
    uid: string;
    gatewayId: string;
    generation: number;
    sourceSha: string;
    bootImageId: string;
    payload: ReleasePayload;
}
export declare function parkedPrewarmInput(operation: Pick<Operation, "input">): ParkedPrewarmInput;
export declare function readActiveParkedPrewarm(state: Pick<PlatformStateTransaction, "journal">, uid: string): Promise<OperationRecord | null>;
type PrewarmClaim = {
    release: number;
    previousRelease: number;
    previousInstanceId: string;
    sourceGatewayId: string;
    sourceAssignmentEpoch: number;
};
declare const BOOTING = "booting";
declare const HANDOFF = "handoff";
declare const REPAIR_PARKING = "repair-parking";
declare const DEMAND_WON = "demand-won";
declare const PREWARM_CLAIM_STATES: readonly ["booting", "handoff", "repairing", "repair-parking"];
type PrewarmClaimState = typeof PREWARM_CLAIM_STATES[number];
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
};
export declare function startParkedGatewayPrewarm(store: PlatformStateStore, operation: Operation, now: number, sourceVm?: OriginalVm): Promise<PrewarmStart>;
export declare function isFreshParkedPrewarmRecovery(value: unknown, instanceId: string, notBefore: unknown): boolean;
type PrewarmFinishMode = "ready" | "rollback" | "repaired";
export declare function finishParkedGatewayPrewarm(store: PlatformStateStore, operation: Operation, now: number, mode: PrewarmFinishMode): Promise<"parked" | typeof HANDOFF | typeof DEMAND_WON | typeof REPAIR_PARKING>;
export declare function bootRepairedParkedGateway(store: PlatformStateStore, operation: Operation, now: number): Promise<typeof BOOTING | typeof DEMAND_WON>;
export {};
