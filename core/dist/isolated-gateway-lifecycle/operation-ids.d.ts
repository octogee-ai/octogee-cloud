import type { OperationsRepository } from "../platform-state/operations.js";
export interface LeaseOperationIdClaim {
    uid: string;
    gatewayId: string;
    generation: number;
    operationId: string;
}
export declare function authorizationEndedOperationId(gatewayId: string): string;
export declare function leaseOperationIdBelongs(operations: Pick<OperationsRepository, "get">, claim: LeaseOperationIdClaim): Promise<boolean>;
