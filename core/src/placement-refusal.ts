export const PLACEMENT_REFUSAL_REASONS = [
  "migration-terminal",
  "user-held",
  "shared-drain-superseded",
  "migration-authority",
  "target-capacity",
  "shared-pool-unconfigured",
  "target-not-shared",
  "source-not-proven-unavailable",
  "assignment-changed",
  "roll-not-eligible",
  "drain-move-not-supersedable",
  "fleet-state-changed",
  "fence-mismatch",
  "source-recovery-pending",
  "user-missing",
  "user-slug-missing",
  "lease-missing",
  "gateway-not-owned",
  "retirement-blocked",
  "isolated-fence",
  "retirement-conflict",
  "sizing-key-changed",
  "initial-release-conflict",
  "source-not-stranded",
  "migration-in-flight",
  "rollback-not-proven",
] as const;

export type PlacementRefusalReason = (typeof PLACEMENT_REFUSAL_REASONS)[number];

export class PlacementPreconditionFailed extends Error {
  constructor(readonly reasonCode: PlacementRefusalReason, message: string) {
    super(message);
    this.name = "PlacementPreconditionFailed";
  }
}

export class SourceRecoveryPendingError extends PlacementPreconditionFailed {
  constructor(readonly operationId: string) {
    super("source-recovery-pending", `operation ${operationId} is still recovering its source`);
    this.name = "SourceRecoveryPendingError";
  }
}
