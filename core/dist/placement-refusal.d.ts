export declare const PLACEMENT_REFUSAL_REASONS: readonly ["migration-terminal", "user-held", "shared-drain-superseded", "migration-authority", "target-capacity", "shared-pool-unconfigured", "target-not-shared", "source-not-proven-unavailable", "assignment-changed", "roll-not-eligible", "drain-move-not-supersedable", "fleet-state-changed", "fence-mismatch", "source-recovery-pending", "user-missing", "user-slug-missing", "lease-missing", "gateway-not-owned", "retirement-blocked", "isolated-fence", "retirement-conflict", "sizing-key-changed", "initial-release-conflict", "source-not-stranded", "migration-in-flight", "rollback-not-proven", "account-not-active", "source-gateway-retired", "source-gateway-paused"];
export type PlacementRefusalReason = (typeof PLACEMENT_REFUSAL_REASONS)[number];
export declare class PlacementPreconditionFailed extends Error {
    readonly reasonCode: PlacementRefusalReason;
    constructor(reasonCode: PlacementRefusalReason, message: string);
}
export declare class SourceRecoveryPendingError extends PlacementPreconditionFailed {
    readonly operationId: string;
    constructor(operationId: string);
}
