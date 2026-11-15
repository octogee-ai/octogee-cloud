import type { OperationAuditAliasOutcome, OperationAuditPartialOutcome, OperationAuditReleaseRolloutLinkage } from "@octogee/shared/types/glm";
import { type OperationAuditActionClaim, type OperationAuditIntentInput } from "./operation-audit.js";
import type { PlatformStateStore } from "./platform-state/store.js";
export declare class FleetMutationIdempotencyError extends Error {
    readonly auditId: string;
    readonly status: "recorded" | "in-progress" | "completed" | "failed";
    constructor(auditId: string, status: "recorded" | "in-progress" | "completed" | "failed");
}
export type NormalFleetMutationResult = {
    outcome: "completed";
    aliasOutcomes?: OperationAuditAliasOutcome[];
    releaseRollout?: OperationAuditReleaseRolloutLinkage;
} | {
    outcome: "partial";
    partialOutcome: OperationAuditPartialOutcome;
    aliasOutcomes?: OperationAuditAliasOutcome[];
    releaseRollout?: OperationAuditReleaseRolloutLinkage;
} | {
    outcome: "failed";
    error: string;
    partialOutcome?: OperationAuditPartialOutcome;
    aliasOutcomes?: OperationAuditAliasOutcome[];
    releaseRollout?: OperationAuditReleaseRolloutLinkage;
};
export declare class FleetMutationPartialError extends Error {
    readonly partialOutcome: OperationAuditPartialOutcome;
    readonly aliasOutcomes?: OperationAuditAliasOutcome[] | undefined;
    readonly releaseRollout?: OperationAuditReleaseRolloutLinkage | undefined;
    constructor(message: string, partialOutcome: OperationAuditPartialOutcome, aliasOutcomes?: OperationAuditAliasOutcome[] | undefined, releaseRollout?: OperationAuditReleaseRolloutLinkage | undefined);
}
export declare class FleetMutationRefusedError extends Error {
    readonly refusal: Error;
    readonly partialOutcome?: OperationAuditPartialOutcome | undefined;
    constructor(refusal: Error, partialOutcome?: OperationAuditPartialOutcome | undefined);
}
export interface NormalFleetMutationInput<T> extends OperationAuditIntentInput {
    claimId?: string;
    action: (claim: OperationAuditActionClaim) => Promise<T>;
    classifyResult?: (result: T) => NormalFleetMutationResult;
}
export declare function runNormalFleetMutation<T>(store: PlatformStateStore, input: NormalFleetMutationInput<T>): Promise<T>;
