import { type ParkedHomeArchiveGrant } from "../parked-home-archive.js";
import { type GatewaySizingProfile } from "@octogee/shared/types/sizing-profile";
import type { PlatformUserRecord, UserActivationLease } from "../platform-state/users.js";
import { type AdvanceActivationLeaseInput, type CompleteActivationLeaseInput, type FailActivationLeaseInput, type IsolatedLifecycleDeps, type LifecycleMode, type SizingKeyTransitionInput } from "./inputs.js";
export declare function userAllowsInteractiveAccess(user: PlatformUserRecord): boolean;
export declare function exactLeaseFence(lease: UserActivationLease, status: UserActivationLease["status"][]): {
    leaseId: string;
    generation: number;
    status: import("../platform-state/users.js").UserActivationLeaseStatus[];
};
export declare function canonicalAdvanceOperationId(lease: UserActivationLease, toStatus: AdvanceActivationLeaseInput["toStatus"]): string | undefined;
export declare function nextActivationLease(lease: UserActivationLease, request: AdvanceActivationLeaseInput, now: number): UserActivationLease | null;
export declare function activationLeaseAdvanceAlreadyApplied(lease: UserActivationLease, request: AdvanceActivationLeaseInput): boolean;
export declare function nextCompletedActivationLease(input: {
    lease: UserActivationLease;
    user: PlatformUserRecord;
    sizingKey: string | null;
    sizingProfile: GatewaySizingProfile | null;
    sourceGatewayId: string;
    sourceAssignmentEpoch: number;
    nextLeaseId: string;
    now: number;
}): UserActivationLease | null;
export declare function nextFailedActivationLease(lease: UserActivationLease, request: FailActivationLeaseInput, now: number): UserActivationLease | null;
export declare function advanceActivationLease(input: Pick<IsolatedLifecycleDeps, "store" | "now" | "requireOwner">, given: AdvanceActivationLeaseInput, mode?: LifecycleMode): Promise<void>;
export declare function completeActivationLease(input: Pick<IsolatedLifecycleDeps, "store" | "readSizingKey" | "now" | "requireOwner"> & {
    leaseIdFactory?: () => string;
    archiveGrant?: ParkedHomeArchiveGrant;
}, request: CompleteActivationLeaseInput, mode?: LifecycleMode): Promise<void>;
export declare function failActivationLease(input: Pick<IsolatedLifecycleDeps, "store" | "now" | "requireOwner" | "sourceRecoveryPending">, request: FailActivationLeaseInput, mode?: LifecycleMode): Promise<void>;
export declare function nextSizingKeyTransitionLease(user: PlatformUserRecord, sizingKey: string | null, request: SizingKeyTransitionInput, now: number): UserActivationLease;
export declare function requestSizingKeyTransition(input: Pick<IsolatedLifecycleDeps, "store" | "readSizingKey" | "now" | "requireOwner" | "mutations">, request: SizingKeyTransitionInput, mode?: LifecycleMode): Promise<void>;
