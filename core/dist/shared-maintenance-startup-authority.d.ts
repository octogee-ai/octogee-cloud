import type { SharedMaintenanceRole, SharedMaintenanceStartupEnrollment } from "./shared-maintenance-startup.js";
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
    sidecarAudience: boolean;
};
type LaunchAuthority = {
    namespace: string;
    gatewayId: string;
    podUid: string;
    serviceAccountName: string;
    attemptId: string;
    roles: VerifiedRoleInventory;
    verifiedRestoredArchive: {
        attemptId: string;
        sha256: string;
    };
};
export declare function issueSharedMaintenanceStartupPermit(input: {
    request: LaunchRequest;
    binding: PodBinding;
    readVerifiedAuthority(): Promise<LaunchAuthority | null>;
    fleetPrivateKey: string;
    now?: () => number;
}): Promise<{
    raw: string;
    signature: string;
} | null>;
export {};
