export type PlatformAggregate = "operation" | "operation-audit" | "gateway-recovery-receipt" | "gateway" | "gateway-release" | "gateway-assignment" | "gateway-vm-runtime" | "fleet-registry" | "shared-pool-scaler" | "platform-release" | "migration-transfer-task" | "orchestrator-config" | "platform-config" | "writer-quiescence" | "mattermost-admin" | "builder" | "builder-agent" | "placement-receipt" | "schedule-transfer" | "agent-store" | "user-account" | "agent-model-selection" | "session-model-audit" | "model-credential" | "subscription-link" | "subscription-flow" | "connector-integration" | "connect-flow" | "workspace" | "workspace-member" | "workspace-project" | "workspace-project-member" | "workspace-channel" | "activity-receipt" | "builder-agent-identity" | "channel-identity" | "builder-secret" | "gateway-ticket" | "control-ticket" | "control-session" | "gateway-access-audit" | "model-broker-token" | "model-broker-gateway-token" | "customer-deletion-job" | "anonymous-operational-archive" | "agent-import" | "agent-import-pointer" | "model-broker-usage";
export type PlatformStateBackend = "firestore" | "postgresql";
export type FenceName = "revision" | "status" | "startedAt" | "updatedAt" | "epoch" | "generation" | "leaseId" | "retirementVersion" | "latestRelease" | "runtimeRestartFence" | "actionClaimId" | "actionSequence" | "actionStartedAt" | "attemptId" | "absent" | "present";
export interface RecordKey {
    readonly aggregate: PlatformAggregate;
    readonly key: string;
}
export type UnsupportedOperationReason = "read-after-write" | "write-in-read-only-transaction" | "backend-capability";
export type PlatformStateError = FenceMismatchError | MissingRecordError | AlreadyExistsError | DuplicateRecordError | UnsupportedOperationError | ContentionExhaustedError | MalformedRecordError | BackendFailureError;
export declare class FenceMismatchError extends Error {
    readonly record: RecordKey;
    readonly fence: FenceName;
    readonly expected: unknown;
    readonly actual: unknown;
    readonly code: "fence-mismatch";
    constructor(record: RecordKey, fence: FenceName, expected: unknown, actual: unknown);
}
export declare class MissingRecordError extends Error {
    readonly record: RecordKey;
    readonly code: "missing-record";
    constructor(record: RecordKey, options?: ErrorOptions);
}
export declare class AlreadyExistsError extends Error {
    readonly record: RecordKey;
    readonly code: "already-exists";
    constructor(record: RecordKey, options?: ErrorOptions);
}
export declare class DuplicateRecordError extends Error {
    readonly aggregate: PlatformAggregate;
    readonly lookup: string;
    readonly value: string;
    readonly keysFound: readonly string[];
    readonly code: "duplicate-record";
    constructor(aggregate: PlatformAggregate, lookup: string, value: string, keysFound: readonly string[]);
}
export declare class UnsupportedOperationError extends Error {
    readonly backend: PlatformStateBackend;
    readonly operation: string;
    readonly reason: UnsupportedOperationReason;
    readonly code: "unsupported-operation";
    constructor(backend: PlatformStateBackend, operation: string, reason: UnsupportedOperationReason);
}
export declare class ContentionExhaustedError extends Error {
    readonly backend: PlatformStateBackend;
    readonly transactionLabel: string;
    readonly attempts: number;
    readonly code: "contention-exhausted";
    constructor(backend: PlatformStateBackend, transactionLabel: string, attempts: number, options?: ErrorOptions);
}
export declare class MalformedRecordError extends Error {
    readonly record: RecordKey;
    readonly detail: string;
    readonly code: "malformed-record";
    constructor(record: RecordKey, detail: string);
}
export declare class BackendFailureError extends Error {
    readonly backend: PlatformStateBackend;
    readonly operation: string;
    readonly code: "backend-failure";
    constructor(backend: PlatformStateBackend, operation: string, options: ErrorOptions);
}
export declare function isPlatformStateError(error: unknown): error is PlatformStateError;
