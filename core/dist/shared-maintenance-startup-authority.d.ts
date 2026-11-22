import { type SharedMaintenanceRole, type SharedMaintenanceStartupEnrollment, type SharedMaintenanceCompletionReceipt } from "./shared-maintenance-startup.js";
type LaunchRequest = SharedMaintenanceStartupEnrollment & {
    nonce: string;
};
type RoleIdentity = {
    previousContainerId: string;
    runningContainerId: string;
    buildId: string;
    acceptedImageId: string;
    runningImageId: string;
};
type VerifiedRoleInventory = Record<SharedMaintenanceRole, RoleIdentity>;
type PodBinding = {
    namespace: string;
    gatewayId: string;
    podUid: string;
    serviceAccountName: string;
    execRole: SharedMaintenanceRole;
};
type LaunchAuthority = {
    namespace: string;
    gatewayId: string;
    podUid: string;
    serviceAccountName: string;
    attemptId: string;
    artifactSetId: string;
    roles: VerifiedRoleInventory;
    verifiedRestoredArchive: {
        attemptId: string;
        sha256: string;
    };
};
type ScopedRole = {
    request: LaunchRequest;
    binding: PodBinding;
};
export declare function issueSharedMaintenanceStartupPair(input: {
    gateway: ScopedRole;
    edge: ScopedRole;
    readVerifiedAuthority(): Promise<LaunchAuthority | null>;
    enrolledIssuerPrivateKey: string;
    now?: () => number;
}): Promise<{
    gateway: {
        raw: string;
        signature: string;
    };
    "gateway-edge": {
        raw: string;
        signature: string;
    };
} | null>;
export declare function issueSharedMaintenanceCompletion(input: {
    gateway: ScopedRole;
    edge: ScopedRole;
    readVerifiedPublication(): Promise<(LaunchAuthority & {
        publication: SharedMaintenanceCompletionReceipt["publication"];
    }) | null>;
    enrolledIssuerPrivateKey: string;
    now?: () => number;
}): Promise<{
    raw: string;
    signature: string;
} | null>;
export {};
