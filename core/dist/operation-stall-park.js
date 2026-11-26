import { isOperationStallParked, } from "@octogee/shared/types/glm";
import { serialFleetOperationsConflict } from "./fleet-operation-lock.js";
export const PARKED_OPERATION_WAITING_ON = "parked; an operator resumes it";
const SELF_WAITS = new Set([
    "builder-idle",
    "home-archive-provider",
    "isolated-gateway-ready",
    PARKED_OPERATION_WAITING_ON,
]);
export function operationsQueuedBehind(op, active) {
    return active.flatMap((other) => {
        const waitingOn = other.waitingOn;
        if (other.id === op.id || other.status !== "pending" || typeof waitingOn !== "string" || waitingOn.length === 0 ||
            SELF_WAITS.has(waitingOn) || !serialFleetOperationsConflict(op, other))
            return [];
        return [{ id: other.id, kind: other.kind, waitingOn }];
    });
}
export function stallObservationStart(op) {
    if (typeof op.firstStartedAt !== "number")
        return null;
    return Math.max(op.firstStartedAt, op.stallPark?.resumedAt ?? 0);
}
function inputString(op, key) {
    const value = op.input?.[key];
    return typeof value === "string" && value.length > 0 ? value : null;
}
export function parkedOperationViews(active, now) {
    return active.flatMap((op) => {
        if (op.status !== "pending" || !isOperationStallParked(op) || !op.stallPark)
            return [];
        return [{
                operationId: op.id,
                kind: op.kind,
                uid: inputString(op, "uid"),
                fromGatewayId: inputString(op, "fromGatewayId"),
                toGatewayId: inputString(op, "toGatewayId"),
                gatewayId: inputString(op, "gatewayId"),
                park: op.stallPark,
                parkedForMs: now - op.stallPark.parkedAt,
                queuedBehind: operationsQueuedBehind(op, active),
            }];
    });
}
export class ParkedOperationResumeRefused extends Error {
    constructor(message) {
        super(message);
        this.name = "ParkedOperationResumeRefused";
    }
}
export function assertResumableParkedOperation(op, operationId) {
    if (op === null)
        throw new ParkedOperationResumeRefused(`operation ${operationId} does not exist`);
    if (op.status !== "pending" || !isOperationStallParked(op) || !op.stallPark) {
        throw new ParkedOperationResumeRefused(`operation ${operationId} is not parked`);
    }
    return op.stallPark;
}
export async function resumeParkedOperationInTransaction(tx, input) {
    const current = await tx.journal.operations.get(input.operationId);
    const park = assertResumableParkedOperation(current, input.operationId);
    if (park.parkedAt !== input.parkedAt) {
        throw new ParkedOperationResumeRefused(`operation ${input.operationId} was parked again since it was read`);
    }
    const resumed = {
        ...park, resumedAt: input.now, resumedBy: input.actor, resumeReason: input.reason, resumeAuditId: input.auditId,
    };
    await tx.journal.operations.patch(input.operationId, {
        stallPark: resumed,
        waitingOn: { clear: true },
        nextAttemptAt: input.now,
    }, { status: ["pending"], startedAt: null });
    return resumed;
}
