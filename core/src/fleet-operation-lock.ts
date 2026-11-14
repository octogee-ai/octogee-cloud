
export type RolloutLane = "cluster" | "builder-vm";

export interface FleetOperationLockRef {
  id: string;
  kind: string;
  status?: string;
  input?: unknown;
  userMigrationV2?: unknown;
  rolloutLane?: RolloutLane;
  cutoverCommittedAt?: number;
}

const SERIAL_KINDS: ReadonlySet<string> = new Set([
  "rollout",
  "migrate-user",
]);
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(["pending", "running"]);
const RESOURCE_FIELDS = [
  "gatewayId",
  "fromGatewayId",
  "toGatewayId",
  "sourceGatewayId",
  "targetGatewayId",
] as const;

function stringFields(
  value: unknown,
  fields: readonly string[],
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  return fields.flatMap((field) => typeof record[field] === "string" ? [record[field] as string] : []);
}

export function fleetOperationLockResources(
  operation: FleetOperationLockRef,
): ReadonlySet<string> {
  if (!SERIAL_KINDS.has(operation.kind)) return new Set();
  return new Set([
    ...stringFields(operation.input, RESOURCE_FIELDS),
    ...stringFields(operation.userMigrationV2, [
      "sourceGatewayId",
      "targetGatewayId",
    ]),
  ]);
}

export function serialLockReleasedAfterCutover(operation: FleetOperationLockRef): boolean {
  return operation.kind === "migrate-user" && typeof operation.cutoverCommittedAt === "number";
}

function nativeReturnBlocksSourceRollout(rollout: FleetOperationLockRef, returning: FleetOperationLockRef): boolean {
  if (rollout.kind !== "rollout" || rollout.rolloutLane === "cluster" || returning.kind !== "migrate-user" ||
      (returning.status !== undefined && !ACTIVE_STATUSES.has(returning.status))) return false;
  const source = stringFields(returning.input, ["fromGatewayId"])[0];
  const rolloutGateway = stringFields(rollout.input, ["gatewayId"])[0];
  const target = stringFields(returning.input, ["toGatewayId"])[0];
  return source !== undefined && source === rolloutGateway && !source.startsWith("shared-") &&
    target !== undefined && target.startsWith("shared-");
}

export function serialFleetOperationsConflict(
  candidate: FleetOperationLockRef,
  other: FleetOperationLockRef,
): boolean {
  if (!SERIAL_KINDS.has(candidate.kind) || !SERIAL_KINDS.has(other.kind)) return false;
  if (nativeReturnBlocksSourceRollout(candidate, other) || nativeReturnBlocksSourceRollout(other, candidate)) return true;
  if (serialLockReleasedAfterCutover(candidate) || serialLockReleasedAfterCutover(other)) return false;
  const candidateResources = fleetOperationLockResources(candidate);
  for (const resource of fleetOperationLockResources(other)) {
    if (candidateResources.has(resource)) return true;
  }
  return candidate.kind === "rollout" && other.kind === "rollout" && (
    candidate.rolloutLane === undefined || other.rolloutLane === undefined ||
    candidate.rolloutLane === other.rolloutLane
  );
}

export function findActiveGatewayMigration<T extends FleetOperationLockRef>(
  gatewayId: string,
  operations: readonly T[],
): T | null {
  return operations.find((operation) =>
    operation.kind === "migrate-user" &&
    ACTIVE_STATUSES.has(operation.status ?? "") &&
    fleetOperationLockResources(operation).has(gatewayId)
  ) ?? null;
}

export class GatewayMigrationInFlightError extends Error {
  constructor(
    readonly gatewayId: string,
    readonly operationId: string,
  ) {
    super(`user migration is in flight for gateway ${gatewayId}`);
    this.name = "GatewayMigrationInFlightError";
  }
}
