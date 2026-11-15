import type { GatewayRoot, OperationRecord, PlatformStateStore, Stored } from "@octogee/core/platform-state";
import type { KubeOps } from "../kube-ops.js";

export async function isRetiredSharedGateway(
  store: PlatformStateStore,
  gatewayId: string,
  readRuntimeAbsent: (gatewayId: string) => Promise<boolean>,
): Promise<boolean> {
  if (!/^shared-[a-z0-9]+$/.test(gatewayId)) return false;
  const proof = await readRetirementProof(store, gatewayId);
  if (!proof || !(await readRuntimeAbsent(gatewayId))) return false;
  return await readRetirementProof(store, gatewayId) === proof;
}

async function readRetirementProof(store: PlatformStateStore, gatewayId: string): Promise<string | null> {
  const operationId = `shared-pool-retire-${gatewayId}`;
  return store.transaction({ label: "retired-shared-gateway.proof", readOnly: true }, async (transaction) => {
    const [root, runtime, operation, assignmentsEmpty, users, operations] = await Promise.all([
      transaction.gateways.roots.get(gatewayId),
      transaction.fleetRegistry.get(gatewayId),
      transaction.journal.operations.get(operationId),
      transaction.gateways.assignments.isEmpty(gatewayId),
      transaction.users.records.listByGateway(gatewayId, { limit: 1 }),
      transaction.journal.operations.listByGateway(gatewayId),
    ]);
    if (runtime !== null || !assignmentsEmpty || users.length > 0 || operation === null ||
      retirementOperationIdentityMismatch(operation, gatewayId)) return null;
    const version = operation.input.retirementClaimVersion;
    if (!isRetirementClaimVersion(version) || retirementOperationRetainedResources(operation) ||
      retirementOperationTimingMismatch(operation)) return null;
    if (root !== null && sharedRootRetirementMismatch(root, operationId, version)) return null;
    if (gatewayRecreationObserved(operations, operation)) return null;
    return JSON.stringify([operationId, version, operation.createdAt, operation.completedAt]);
  });
}

function retirementOperationIdentityMismatch(operation: OperationRecord, gatewayId: string): boolean {
  return operation.kind !== "retire-gateway" || operation.status !== "succeeded" ||
    operation.gatewayId !== gatewayId || operation.input?.gatewayId !== gatewayId ||
    operation.input?.source !== "shared-pool-scaler";
}

function retirementOperationRetainedResources(operation: OperationRecord): boolean {
  return operation.input?.retainData === true || operation.input?.retainServiceAccount === true;
}

function isRetirementClaimVersion(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function retirementOperationTimingMismatch(operation: OperationRecord): boolean {
  return typeof operation.createdAt !== "number" || !Number.isFinite(operation.createdAt) ||
    typeof operation.completedAt !== "number" || !Number.isFinite(operation.completedAt) ||
    operation.completedAt < operation.createdAt;
}

function sharedRootRetirementMismatch(root: GatewayRoot, operationId: string, version: number): boolean {
  return root.gatewayClass !== "shared" || root.ownerUid != null ||
    root.desiredStatus !== "retired" || root.retirementVersion !== version ||
    root.retirementClaim?.operationId !== operationId || root.retirementClaim.version !== version ||
    root.retirementClaim.phase !== "claimed";
}

function gatewayRecreationObserved(operations: readonly Stored<OperationRecord>[], operation: OperationRecord): boolean {
  return operations.some((candidate) => {
    return candidate.kind === "add-gateway" && (
      (candidate.status !== "succeeded" && candidate.status !== "failed") ||
      typeof candidate.createdAt !== "number" || !Number.isFinite(candidate.createdAt) ||
      candidate.createdAt >= operation.createdAt);
  });
}

export async function retiredSharedGatewayRuntimeAbsent(
  kubeOps: Pick<KubeOps, "readAvailableReplicas" | "readGatewayPodDiagnostics">,
  namespace: string,
  gatewayId: string,
  deploymentName: string,
): Promise<boolean> {
  if (await kubeOps.readAvailableReplicas({ namespace, name: deploymentName }) !== null) return false;
  const pods = await kubeOps.readGatewayPodDiagnostics({ namespace, gatewayId });
  if (pods.status !== "missing" || pods.totalPods !== 0 || pods.pods.length !== 0) return false;
  return await kubeOps.readAvailableReplicas({ namespace, name: deploymentName }) === null;
}
