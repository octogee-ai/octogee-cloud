import { isDeepStrictEqual } from "node:util";
import {
  claimGatewayRetirementInStore,
  GatewayRetirementReleaseUnconvergedError,
  GatewayRetirementTelemetryUnavailableError,
} from "@octogee/core/gateway-retirement-claim";
import {
  builderActivateOperationId,
  isolatedRecoverOperationId,
  builderReturnOperationId,
} from "@octogee/core/isolated-operation-ids";
import type {
  GatewayRecoveryReceipt,
  GatewayRoot,
  NewOperation,
  OperationRecord,
  PlatformStateStore,
  PlatformStateTransaction,
  Stored,
} from "@octogee/core/platform-state";
import { schedulerHandoffAwaitingRelease } from "../../scheduler-handoff-release.js";

export type OwnedGatewayRetirementOutcome =
  | "not-owned"
  | "retirement-pending"
  | "retired";

export interface OwnedGatewayRetirementInput {
  store: PlatformStateStore;
  uid: string;
  deletionId: string;
  now: number;
  claimRetirement?: typeof claimGatewayRetirementInStore;
  preserveRetirementProof?: (proof: UserGatewayRetirementProof) => Promise<void>;
}

export interface UserGatewayRetirementProof {
  gatewayId: string;
  operationId: string;
  version: number;
  completedAt: number;
  runtime: "cluster" | "gce-vm";
}

interface RetirementCleanup {
  claimOperationId: string;
  recoveryOperationId: string | null;
  recoveryReceiptId: string | null;
}

type RootFields = Record<string, unknown>;

const USER_DELETION_ACTOR = "customer-deletion-lifecycle";

function retirementOperationId(deletionId: string, gatewayId: string): string {
  return `delete-retire-${deletionId}-${gatewayId}`;
}

function fieldsOf(root: GatewayRoot): RootFields {
  return root as unknown as RootFields;
}

export async function ensureOwnedGatewaysRetired(
  input: OwnedGatewayRetirementInput,
): Promise<OwnedGatewayRetirementOutcome> {
  const claimRetirement = input.claimRetirement ?? claimGatewayRetirementInStore;
  const owned = (await input.store.gateways.roots.list({ ownerUid: input.uid }))
    .filter((root) => root.gatewayClass === "builder")
    .sort((a, b) => a.gatewayId.localeCompare(b.gatewayId));
  if (owned.length === 0) return "not-owned";

  let pending = false;
  for (const root of owned) {
    pending = (await reconcileOwnedGatewayRetirement(input, root, claimRetirement)) || pending;
  }
  return pending ? "retirement-pending" : "retired";
}

async function reconcileOwnedGatewayRetirement(
  input: OwnedGatewayRetirementInput,
  root: Stored<GatewayRoot>,
  claimRetirement: typeof claimGatewayRetirementInStore,
): Promise<boolean> {
  const gatewayId = root.gatewayId;
  assertRetirementClaimOwnership(input, gatewayId, fieldsOf(root));
  if (root.desiredStatus === "retired") {
    return finishCompletedGatewayRetirement(input, root);
  }
  if (root.desiredStatus !== "running" && root.desiredStatus !== "paused") {
    throw new Error(
      `owned gateway ${gatewayId} has invalid desired status: ${String(root.desiredStatus)}`,
    );
  }
  try {
    await claimRetirement({
      store: input.store,
      gatewayId,
      operationId: retirementOperationId(input.deletionId, gatewayId),
      operation: automaticRetirementOperation(input, gatewayId),
      now: input.now,
      updatedBy: USER_DELETION_ACTOR,
      claimGuard: ({ root: claimedRoot }) => {
        assertRetirementClaimOwnership(input, gatewayId, claimedRoot as unknown as RootFields);
      },
    });
  } catch (error) {
    if (!retirableOnlyOncePaused(error)) throw error;
    await pauseOwnedGatewayForRetirement(input, gatewayId);
  }
  return true;
}

function retirableOnlyOncePaused(error: unknown): boolean {
  return error instanceof GatewayRetirementTelemetryUnavailableError ||
    error instanceof GatewayRetirementReleaseUnconvergedError;
}

async function pauseOwnedGatewayForRetirement(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
): Promise<void> {
  await input.store.transaction({ label: "customer-deletion.pause-owned-gateway" }, async (transaction) => {
    const current = await transaction.gateways.roots.get(gatewayId);
    if (current === null) return;
    assertRetirementClaimOwnership(input, gatewayId, fieldsOf(current));
    if (current.desiredStatus !== "running" || current.retirementClaim != null) return;
    await transaction.gateways.roots.patch(
      gatewayId,
      { desiredStatus: "paused", updatedAt: input.now, updatedBy: USER_DELETION_ACTOR },
      { updatedAt: current.updatedAt },
    );
  });
}

function automaticRetirementOperation(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
): NewOperation {
  return {
    kind: "retire-gateway",
    status: "pending",
    origin: "automatic",
    createdBy: USER_DELETION_ACTOR,
    createdAt: input.now,
    startedAt: null,
    completedAt: null,
    input: { gatewayId },
    steps: [],
    gatewayId,
  };
}

function disposableAllocationGeneration(gatewayId: string, root: RootFields): number | null {
  const allocation = root.allocation as { kind?: unknown; generation?: unknown } | null | undefined;
  if (allocation?.kind !== "disposable-builder") return null;
  if (!Number.isSafeInteger(allocation.generation) || (allocation.generation as number) < 1) {
    throw new Error(`owned gateway ${gatewayId} disposable allocation has no generation`);
  }
  return allocation.generation as number;
}

async function finishCompletedGatewayRetirement(
  input: OwnedGatewayRetirementInput,
  selected: Stored<GatewayRoot>,
): Promise<boolean> {
  const gatewayId = selected.gatewayId;
  const expectedClaim = retirementClaim(gatewayId, fieldsOf(selected));
  const generation = disposableAllocationGeneration(gatewayId, fieldsOf(selected));
  const recoveryId = generation === null ? null : isolatedRecoverOperationId(gatewayId, generation);
  const handoffOperationIds = generation === null ? [] : [
    builderActivateOperationId(gatewayId, generation),
    builderReturnOperationId(gatewayId, generation),
  ];
  let proof: UserGatewayRetirementProof | undefined;
  const canFinish = async (transaction: PlatformStateTransaction): Promise<RetirementCleanup | null> => {
    const root = await transaction.gateways.roots.get(gatewayId);
    if (root === null) return null;
    const fields = fieldsOf(root);
    const claim = unchangedRetirementClaim(input, gatewayId, root, expectedClaim);
    const [operations, runtime, assignmentsEmpty, users, receipt] = await Promise.all([
      transaction.journal.operations.getMany([claim.operationId, ...handoffOperationIds, ...(recoveryId === null ? [] : [recoveryId])]),
      transaction.fleetRegistry.get(gatewayId),
      transaction.gateways.assignments.isEmpty(gatewayId),
      transaction.users.records.listByGateway(gatewayId, { limit: 1 }),
      recoveryId === null ? null : transaction.journal.recoveryReceipts.get(recoveryId),
    ]);
    const operation = operations.get(claim.operationId) ?? null;
    if (!retirementOperationAllowsCleanup(input, gatewayId, claim.version, operation)) return null;
    proof = retirementProofForDeletion(input, gatewayId, fields, claim, operation);
    const tenantsRemain = runtime !== null || !assignmentsEmpty || users.length > 0 ||
      handoffOperationIds.some((operationId) => handoffAwaitsRelease(operations.get(operationId), input.deletionId));
    if (tenantsRemain) return null;
    return {
      claimOperationId: claim.operationId,
      ...ownedRecoveryArtifacts(input, gatewayId, fields, {
        recoveryId,
        operation: recoveryId === null ? undefined : operations.get(recoveryId),
        receipt,
      }),
    };
  };
  const cleanup = await input.store.transaction(
    { label: "customer-deletion.owned-gateway-retirement.verify", readOnly: true },
    canFinish,
  );
  if (!cleanup) return true;
  if (proof) await input.preserveRetirementProof!(proof);
  await input.store.gateways.roots.deleteChildren(gatewayId);
  return input.store.transaction({ label: "customer-deletion.owned-gateway-retirement.finish" }, async (transaction) => {
    const current = await canFinish(transaction);
    if (!current || !isDeepStrictEqual(current, cleanup)) return true;
    await transaction.gateways.roots.delete(gatewayId, { retirementVersion: expectedClaim.version });
    await transaction.journal.operations.delete(current.claimOperationId);
    if (current.recoveryOperationId !== null) await transaction.journal.operations.delete(current.recoveryOperationId);
    if (current.recoveryReceiptId !== null) await transaction.journal.recoveryReceipts.delete(current.recoveryReceiptId);
    return false;
  });
}

function unchangedRetirementClaim(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
  root: Stored<GatewayRoot>,
  expected: { operationId: string; version: number },
): { operationId: string; version: number } {
  const fields = fieldsOf(root);
  assertRetirementClaimOwnership(input, gatewayId, fields);
  const claim = retirementClaim(gatewayId, fields);
  if (root.desiredStatus !== "retired" || claim.operationId !== expected.operationId || claim.version !== expected.version) {
    throw new Error(`owned gateway ${gatewayId} retirement claim changed during user deletion`);
  }
  return claim;
}

function ownedRecoveryArtifacts(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
  root: RootFields,
  recovery: {
    recoveryId: string | null;
    operation: Stored<OperationRecord> | undefined;
    receipt: Stored<GatewayRecoveryReceipt> | null;
  },
): Pick<RetirementCleanup, "recoveryOperationId" | "recoveryReceiptId"> {
  if (recovery.operation !== undefined) assertRecoveryOwnership(input, gatewayId, root, recovery.operation as unknown as RootFields);
  if (recovery.receipt !== null) assertRecoveryOwnership(input, gatewayId, root, recovery.receipt as unknown as RootFields);
  return {
    recoveryOperationId: recovery.operation === undefined ? null : recovery.recoveryId,
    recoveryReceiptId: recovery.receipt === null ? null : recovery.recoveryId,
  };
}

function retirementProofForDeletion(input: OwnedGatewayRetirementInput, gatewayId: string, root: RootFields, claim: { operationId: string; version: number }, operation: OperationRecord): UserGatewayRetirementProof | undefined {
  if (!input.preserveRetirementProof) return undefined;
  const completedAt = operation.completedAt;
  if (typeof completedAt !== "number" || !Number.isFinite(completedAt)) throw new Error("retirement completion timestamp is unavailable");
  return { gatewayId, operationId: claim.operationId, version: claim.version, completedAt, runtime: root.runtime === "gce-vm" ? "gce-vm" : "cluster" };
}

function handoffAwaitsRelease(operation: Stored<OperationRecord> | undefined, deletionId: string): boolean {
  if (operation === undefined || operation.cancelledByDeletionId === deletionId) return false;
  return schedulerHandoffAwaitingRelease(operation);
}

function retirementOperationAllowsCleanup(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
  version: number,
  operation: OperationRecord | null,
): operation is OperationRecord {
  if (operation === null) return false;
  const operationInput = operation.input as RootFields | undefined;
  if (operation.kind !== "retire-gateway" || operation.gatewayId !== gatewayId ||
    operationInput?.gatewayId !== gatewayId || operationInput.retirementClaimVersion !== version ||
    (operationInput.uid != null && operationInput.uid !== input.uid)) {
    throw new Error(`owned gateway ${gatewayId} retirement operation does not match its owner and claim`);
  }
  if (operation.status === "failed") {
    throw new Error(`owned gateway ${gatewayId} retirement failed: ${String(operation.error ?? "unknown")}`);
  }
  if (operation.status !== "succeeded") return false;
  if (operationInput.retainData === true || operationInput.retainServiceAccount === true) {
    throw new Error(`owned gateway ${gatewayId} retirement retained resources; user cleanup cannot complete`);
  }
  return true;
}

function assertRecoveryOwnership(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
  root: RootFields,
  recovery: RootFields,
): void {
  const allocation = root.allocation as Record<string, unknown> | undefined;
  const recoveryInput = recovery.input as Record<string, unknown> | undefined;
  if (recoveryIdentityMismatch(input, gatewayId, recovery, recoveryInput) ||
    recoveryUserMismatch(input, root, recoveryInput as Record<string, unknown>, allocation) ||
    recoveryLeaseMismatch(recoveryInput as Record<string, unknown>, allocation as Record<string, unknown>)) {
    throw new Error(`owned gateway ${gatewayId} recovery artifact does not match its owner and allocation`);
  }
}

function recoveryIdentityMismatch(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
  recovery: Record<string, unknown>,
  recoveryInput: Record<string, unknown> | undefined,
): boolean {
  return recovery.kind !== "recover-unreachable-disposable" ||
    recoveryInput?.uid !== input.uid || recoveryInput.gatewayId !== gatewayId ||
    (recovery.gatewayId != null && recovery.gatewayId !== gatewayId) ||
    (recovery.inputUid != null && recovery.inputUid !== input.uid);
}

function recoveryUserMismatch(
  input: OwnedGatewayRetirementInput,
  root: Record<string, unknown>,
  recoveryInput: Record<string, unknown>,
  allocation: Record<string, unknown> | undefined,
): boolean {
  return typeof root.builderSlug !== "string" || !root.builderSlug || recoveryInput.builderSlug !== root.builderSlug ||
    allocation?.kind !== "disposable-builder" || allocation.claimedByUid !== input.uid;
}

function recoveryLeaseMismatch(
  recoveryInput: Record<string, unknown>,
  allocation: Record<string, unknown>,
): boolean {
  return typeof allocation.leaseId !== "string" || !allocation.leaseId ||
    !Number.isSafeInteger(allocation.generation) || (allocation.generation as number) <= 0 ||
    recoveryInput.leaseId !== allocation.leaseId || recoveryInput.generation !== allocation.generation;
}

function retirementClaim(gatewayId: string, root: Record<string, unknown>): { operationId: string; version: number } {
  const claim = root.retirementClaim as Record<string, unknown> | undefined;
  if (!claim || typeof claim.operationId !== "string" || !claim.operationId || claim.operationId.includes("/") ||
    !Number.isInteger(claim.version) || (claim.version as number) <= 0 ||
    claim.version !== root.retirementVersion || claim.phase !== "claimed") {
    throw new Error(`owned gateway ${gatewayId} has invalid retirement claim`);
  }
  return { operationId: claim.operationId, version: claim.version as number };
}

function assertRetirementClaimOwnership(
  input: OwnedGatewayRetirementInput,
  gatewayId: string,
  claimed: Record<string, unknown>,
): void {
  if (claimed.ownerUid !== input.uid || claimed.gatewayClass !== "builder") {
    throw new Error(`gateway ${gatewayId} ownership changed during user deletion`);
  }
}

