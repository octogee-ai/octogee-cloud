import type { PlatformStateRepositories } from "../platform-state/store.js";
import { IsolatedGatewayFenceError } from "./inputs.js";

interface RestoreGeneration {
  ownerUid: string;
  targetGatewayId: string;
  leaseId: string;
  generation: number;
}

export async function assertFailedHomeRestoreReleased(state: PlatformStateRepositories, identity: RestoreGeneration): Promise<void> {
  const { ownerUid, targetGatewayId, leaseId, generation } = identity;
  const receipt = await state.users.placementReceipts.get(ownerUid, leaseId, generation, "activation-failed");
  if (!receipt || receipt.kind !== "activation-failed" || receipt.gatewayId !== targetGatewayId ||
      receipt.leaseId !== leaseId || receipt.generation !== generation) {
    throw new IsolatedGatewayFenceError("Failed home restore receipt does not match the original demand");
  }
  const [operation, active, assignment] = await Promise.all([
    receipt.operationId ? state.journal.operations.get(receipt.operationId) : null,
    state.journal.operations.listForUid(ownerUid, { statuses: ["pending", "running"] }),
    state.gateways.assignments.get(targetGatewayId, ownerUid),
  ]);
  if (receipt.operationId && (operation?.status !== "failed" || operation.kind !== "migrate-user" ||
      operation.inputUid !== ownerUid || operation.input.toGatewayId !== targetGatewayId)) {
    throw new IsolatedGatewayFenceError("Failed home restore still has an unresolved dispatched claim");
  }
  if (assignment || active.some(entry => entry.gatewayId === targetGatewayId || entry.input.toGatewayId === targetGatewayId)) {
    throw new IsolatedGatewayFenceError("Failed home restore still has an assignment or active claim");
  }
}
