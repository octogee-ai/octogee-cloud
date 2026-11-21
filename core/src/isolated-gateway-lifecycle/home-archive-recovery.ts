import type { PlatformStateRepositories } from "../platform-state/store.js";
import { IsolatedGatewayFenceError } from "./inputs.js";

interface RestoreGeneration {
  ownerUid: string;
  targetGatewayId: string;
  leaseId: string;
  generation: number;
}

function validRecoveryIdentity(identity: RestoreGeneration): boolean {
  return [identity.ownerUid, identity.targetGatewayId, identity.leaseId].every(id => typeof id === "string" && id.length > 0 && !id.includes("/")) &&
    Number.isSafeInteger(identity.generation) && identity.generation > 0;
}

export async function assertFailedHomeRestoreReleased(state: PlatformStateRepositories, identity: RestoreGeneration): Promise<void> {
  const { ownerUid, targetGatewayId, leaseId, generation } = identity;
  if (!validRecoveryIdentity(identity)) throw new IsolatedGatewayFenceError("Home archive restore receipt identity is incomplete");
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
