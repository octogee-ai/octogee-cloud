export interface OfflineNativeRecoveryIdentity {
    uid: string;
    slug: string;
    operationId: string;
    sourceGatewayId: string;
    targetGatewayId: string;
    requestId: string;
    sourceEpoch: number;
    schedulerMigrationId: string;
    claimStartedAt: number;
    holdGeneration: string;
    original: {
        instanceId: string;
        bootDiskId: string;
        homeDiskId: string;
    };
    maintenance: {
        instanceId: string;
        bootDiskId: string;
        bootId: string;
        acceptedImageId: string;
        cloneDiskId: string;
    };
    immutableSnapshotId: string;
    cleanFileSha256: string;
    ownerAnchorSha256: string;
    ownerStoreSha256: string;
}
type OfflineAction = "reconcile" | "rollback";
export interface OfflineNativeRequest {
    identity: OfflineNativeRecoveryIdentity;
    action: OfflineAction;
    nonce: string;
    expiresAt: number;
}
export interface OfflineNativeResult {
    request: OfflineNativeRequest;
    outcome: "staged" | "restored";
    fileSha256: string;
    ownerAnchorSha256: string;
}
export declare function verifyOfflineNativeRequest(input: {
    raw: string;
    signature: string;
    fleetPublicKey: string;
    expected: OfflineNativeRecoveryIdentity;
    now: number;
}): OfflineNativeRequest;
export declare function signOfflineNativeRequest(request: OfflineNativeRequest, fleetPrivateKey: string): {
    raw: string;
    signature: string;
};
export declare function signOfflineNativeResult(result: OfflineNativeResult, maintenancePrivateKey: string): {
    raw: string;
    signature: string;
};
export declare function verifyOfflineNativeResult(input: {
    raw: string;
    signature: string;
    maintenancePublicKey: string;
    request: OfflineNativeRequest;
    now: number;
}): OfflineNativeResult;
export {};
