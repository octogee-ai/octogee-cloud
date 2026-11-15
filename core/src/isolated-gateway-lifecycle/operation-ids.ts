import {
  builderActivateOperationId,
  builderReturnOperationId,
  isolatedRecoverOperationId,
  placementRetireOperationId,
} from "@octogee/shared/types/isolated-operation-ids";
import type { OperationRecord, OperationsRepository } from "../platform-state/operations.js";

export interface LeaseOperationIdClaim {
  uid: string;
  gatewayId: string;
  generation: number;
  operationId: string;
}

export function authorizationEndedOperationId(gatewayId: string): string {
  return `builder-authorization-ended-${gatewayId}`;
}

function canonicalLeaseOperationIds(claim: LeaseOperationIdClaim): readonly string[] {
  return [
    builderActivateOperationId(claim.gatewayId, claim.generation),
    builderReturnOperationId(claim.gatewayId, claim.generation),
    isolatedRecoverOperationId(claim.gatewayId, claim.generation),
    placementRetireOperationId(claim.uid, claim.gatewayId, claim.generation),
    authorizationEndedOperationId(claim.gatewayId),
  ];
}

function operationReferences(operation: OperationRecord, claim: LeaseOperationIdClaim): boolean {
  const input = operation.input;
  return [operation.inputUid, input.uid, input.ownerUid].includes(claim.uid) &&
    [operation.gatewayId, input.gatewayId, input.fromGatewayId, input.toGatewayId].includes(claim.gatewayId);
}

export async function leaseOperationIdBelongs(
  operations: Pick<OperationsRepository, "get">,
  claim: LeaseOperationIdClaim,
): Promise<boolean> {
  if (canonicalLeaseOperationIds(claim).includes(claim.operationId)) return true;
  const operation = await operations.get(claim.operationId);
  return operation !== null && operationReferences(operation, claim);
}
