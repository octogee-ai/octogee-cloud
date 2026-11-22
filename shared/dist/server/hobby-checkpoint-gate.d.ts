interface HobbyCheckpointOwner {
    slotId: string;
    gatewayId: string;
    podUid: string;
    uid: string;
    slug: string;
    assignmentEpoch: 0;
}
export interface HobbyCheckpointClaim extends HobbyCheckpointOwner {
    version: 1;
    snapshotName: string;
}
export interface HobbyLiveRecoveryClaim {
    attemptId: string;
    phase: "seal" | "install";
    gatewayImageTag: string;
}
export interface HobbyLiveRecoveryProjection extends HobbyCheckpointOwner, HobbyLiveRecoveryClaim {
    namespace: string;
}
export interface HobbyLiveStandbyClaim extends HobbyCheckpointOwner {
    version: 2;
    mode: "live";
    namespace: string;
    recovery?: HobbyLiveRecoveryClaim;
}
type HobbyPodClaim = HobbyCheckpointClaim | HobbyLiveStandbyClaim;
export declare function readCheckpointRestore(boot: NodeJS.ProcessEnv, fresh: NodeJS.ProcessEnv, receipt: unknown): HobbyCheckpointClaim | null;
export declare function readMountedCheckpointClaim(): Promise<HobbyPodClaim | null>;
export declare function checkpointDesktop(claim: HobbyPodClaim, boot: NodeJS.ProcessEnv): string | undefined;
export declare function waitForCheckpointClaim(role: "gateway" | "edge"): Promise<HobbyPodClaim>;
export declare function matchesRestartedCheckpoint(env: NodeJS.ProcessEnv, claim: HobbyPodClaim | null, restoredPodUid: string): claim is HobbyCheckpointClaim;
declare function readCheckpointCredentials(): Promise<{
    token: string;
    agentStoreDsn: string;
}>;
export declare function checkpointGatewayCredentials(read?: typeof readCheckpointCredentials, wait?: () => Promise<void>): Promise<{
    token: string;
    agentStoreDsn: string;
}>;
export declare function initializeCheckpointEdge(isSidecar: boolean): Promise<void>;
export {};
