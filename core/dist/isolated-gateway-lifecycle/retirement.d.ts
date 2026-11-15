import type { GatewayAssignment } from "../platform-state/gateways.js";
import type { PlatformUserRecord } from "../platform-state/users.js";
import { type AuthoritativeLeaseStatus, type IsolatedLifecycleDeps, type RecoverUnreachableIsolatedGatewayInput, type RetireOwnedIsolatedGatewayInput } from "./inputs.js";
type RetirementDeps = Pick<IsolatedLifecycleDeps, "store" | "now" | "log" | "requireOwner">;
export type OwnedGatewayRetirement = {
    retired: true;
    operationId: string;
} | {
    retired: false;
    operationId: string;
    reason: string;
};
export interface PodObservation {
    status: string;
    totalPods: number;
    error?: string;
}
export interface UnreachableRecoveryDeps extends RetirementDeps {
    readGatewayPodDiagnostics(gatewayId: string): Promise<PodObservation>;
}
export type UnreachableRecovery = {
    state: "recovered";
    operationId: string;
} | {
    state: "waiting";
    reason: "observation-unknown" | "pods-present";
    operationId: string;
};
export declare function checkUnreachableRecoveryFence(input: Pick<RetirementDeps, "store" | "now">, request: RecoverUnreachableIsolatedGatewayInput): Promise<string>;
export declare function reserveUnreachableRecovery(input: RetirementDeps, request: RecoverUnreachableIsolatedGatewayInput, operationId: string): Promise<void>;
export declare function completeUnreachableRecovery(input: RetirementDeps, request: RecoverUnreachableIsolatedGatewayInput, operationId: string): Promise<void>;
export declare function recoverUnreachableIsolatedGateway(input: UnreachableRecoveryDeps, request: RecoverUnreachableIsolatedGatewayInput): Promise<UnreachableRecovery>;
interface RetirementAuthorityFenceInput {
    uid: string;
    authoritativeGatewayId: string;
    targetGatewayId: string;
    leaseId: string | undefined;
    generation: number | undefined;
    expectedLeaseStatus: AuthoritativeLeaseStatus;
    userRecord: Pick<PlatformUserRecord, "gateway" | "activationLease"> | null;
    assignment: Pick<GatewayAssignment, "uid" | "gatewayId" | "state"> | null;
}
export declare function retirementAuthorityFenceAllows(input: RetirementAuthorityFenceInput): boolean;
export declare function retireOwnedIsolatedGateway(input: RetirementDeps, request: RetireOwnedIsolatedGatewayInput): Promise<OwnedGatewayRetirement>;
export {};
