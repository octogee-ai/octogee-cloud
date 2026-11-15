import { createServiceLogger } from "@octogee/shared/server/service-logger";
import { randomUUID } from "node:crypto";
import { claimOperationAuditAction, finishOperationAudit, recordOperationAuditIntent, } from "./operation-audit.js";
const logger = createServiceLogger("fleet-mutation");
export class FleetMutationIdempotencyError extends Error {
    auditId;
    status;
    constructor(auditId, status) {
        super(`fleet mutation with this Idempotency-Key is already ${status}`);
        this.auditId = auditId;
        this.status = status;
        this.name = "FleetMutationIdempotencyError";
    }
}
export class FleetMutationPartialError extends Error {
    partialOutcome;
    aliasOutcomes;
    releaseRollout;
    constructor(message, partialOutcome, aliasOutcomes, releaseRollout) {
        super(message);
        this.partialOutcome = partialOutcome;
        this.aliasOutcomes = aliasOutcomes;
        this.releaseRollout = releaseRollout;
        this.name = "FleetMutationPartialError";
    }
}
export class FleetMutationRefusedError extends Error {
    refusal;
    partialOutcome;
    constructor(refusal, partialOutcome) {
        super(refusal.message);
        this.refusal = refusal;
        this.partialOutcome = partialOutcome;
        this.name = "FleetMutationRefusedError";
    }
}
function failureMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function logMutationFinished(logged, outcome, durationMs) {
    const finished = { ...logged, outcome: outcome.outcome, durationMs };
    if (outcome.outcome === "completed")
        logger.info("fleet mutation finished", finished);
    else
        logger.warn("fleet mutation finished", { ...finished, ...(outcome.outcome === "failed" ? { error: outcome.error } : {}) });
}
export async function runNormalFleetMutation(store, input) {
    const { action, claimId, classifyResult, idempotencyKey, ...intent } = input;
    const audit = await recordOperationAuditIntent(store, {
        ...intent,
        idempotencyKey: idempotencyKey ?? randomUUID(),
    });
    if (audit.disposition === "existing") {
        throw new FleetMutationIdempotencyError(audit.auditId, audit.status);
    }
    const claim = await claimOperationAuditAction(store, audit.auditId, {
        claimId: claimId ?? randomUUID(),
    });
    const logged = { auditId: audit.auditId, what: intent.what, why: intent.why, actor: intent.actor, forced: intent.forced, target: intent.target };
    const startedAt = Date.now();
    logger.info("fleet mutation started", logged);
    let result;
    let outcome;
    try {
        result = await action(claim);
        outcome = classifyResult?.(result) ?? { outcome: "completed" };
    }
    catch (error) {
        const failed = { ...logged, error: failureMessage(error), durationMs: Date.now() - startedAt };
        if (error instanceof FleetMutationRefusedError)
            logger.warn("fleet mutation refused", failed);
        else
            logger.error("fleet mutation failed", failed);
        try {
            const partial = error instanceof FleetMutationPartialError ? error : null;
            const refusedAfterEffects = error instanceof FleetMutationRefusedError ? error.partialOutcome : undefined;
            await finishOperationAudit(store, audit.auditId, {
                expectedClaimId: claim.claimId,
                outcome: "failed",
                error: failureMessage(error),
                ...(refusedAfterEffects ? { partialOutcome: refusedAfterEffects } : {}),
                ...(partial ? {
                    partialOutcome: partial.partialOutcome,
                    ...(partial.aliasOutcomes ? { aliasOutcomes: partial.aliasOutcomes } : {}),
                    ...(partial.releaseRollout ? { releaseRollout: partial.releaseRollout } : {}),
                } : {}),
            });
        }
        catch (completionError) {
            throw new AggregateError([error, completionError], `operation audit ${audit.auditId} action failed and its failure could not be recorded`);
        }
        throw error;
    }
    await finishOperationAudit(store, audit.auditId, {
        expectedClaimId: claim.claimId,
        ...outcome,
    });
    logMutationFinished(logged, outcome, Date.now() - startedAt);
    return result;
}
