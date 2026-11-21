import { type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { Operation } from "@octogee/shared/types/glm";
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
type PrewarmStart = {
    state: "booting";
    claim: PrewarmClaim;
} | {
    state: "parked" | "handoff";
    claim: PrewarmClaim;
} | {
    state: "demand-won" | "ineligible";
};
export declare function startParkedGatewayPrewarm(store: PlatformStateStore, operation: Operation, now: number): Promise<PrewarmStart>;
export declare function finishParkedGatewayPrewarm(store: PlatformStateStore, operation: Operation, now: number, mode: "ready" | "rollback"): Promise<"parked" | "handoff" | "demand-won">;
export {};
