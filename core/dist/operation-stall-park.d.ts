import { type Operation, type OperationStallPark } from "@octogee/shared/types/glm";
import type { OperationRecord, PlatformStateTransaction } from "./platform-state/index.js";
export declare const PARKED_OPERATION_WAITING_ON = "parked; an operator resumes it";
export interface QueuedBehindOperation {
    id: string;
    kind: string;
    waitingOn: string;
}
export declare function operationsQueuedBehind(op: Operation, active: readonly Operation[]): QueuedBehindOperation[];
export declare function stallObservationStart(op: Pick<Operation, "firstStartedAt" | "stallPark">): number | null;
export interface ParkedOperationView {
    operationId: string;
    kind: string;
    uid: string | null;
    fromGatewayId: string | null;
    toGatewayId: string | null;
    gatewayId: string | null;
    park: OperationStallPark;
    parkedForMs: number;
    queuedBehind: QueuedBehindOperation[];
}
export declare function parkedOperationViews(active: readonly Operation[], now: number): ParkedOperationView[];
export declare class ParkedOperationResumeRefused extends Error {
    constructor(message: string);
}
export declare function assertResumableParkedOperation(op: OperationRecord | null, operationId: string): OperationStallPark;
export declare function resumeParkedOperationInTransaction(tx: PlatformStateTransaction, input: {
    operationId: string;
    parkedAt: number;
    actor: string;
    reason: string;
    auditId: string;
    now: number;
}): Promise<OperationStallPark>;
