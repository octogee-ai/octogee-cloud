import { type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { type Operation } from "@octogee/shared/types/glm";
import type { OperationRecord } from "../platform-state/operations.js";
import type { PlatformStateStore, PlatformStateTransaction } from "../platform-state/store.js";
export declare const PARKED_PREWARM_KIND = "prewarm-gateway";
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
declare const PREWARM_CLAIM_STATES: readonly ["booting", "handoff", "repairing", "repair-parking"];
type PrewarmClaimState = typeof PREWARM_CLAIM_STATES[number];
type PrewarmStart = {
    state: PrewarmClaimState | "parked";
    claim: PrewarmClaim;
} | {
    state: "demand-won" | "ineligible";
};
export declare function startParkedGatewayPrewarm(store: PlatformStateStore, operation: Operation, now: number, sourceVm?: {
    instanceId: string;
    bootImageId: string;
    needsRepair: boolean;
}): Promise<PrewarmStart>;
export declare function isFreshParkedPrewarmRecovery(value: unknown, instanceId: string, notBefore: unknown): boolean;
export declare function finishParkedGatewayPrewarm(store: PlatformStateStore, operation: Operation, now: number, mode: "ready" | "rollback" | "repaired"): Promise<"parked" | "handoff" | "demand-won" | "repair-parking">;
export declare function bootRepairedParkedGateway(store: PlatformStateStore, operation: Operation, now: number): Promise<"booting" | "demand-won">;
export {};
