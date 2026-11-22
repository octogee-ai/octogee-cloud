export interface HobbyCheckpointClaim {
    version: 1;
    slotId: string;
    gatewayId: string;
    snapshotName: string;
    podUid: string;
    uid: string;
    slug: string;
    assignmentEpoch: 0;
}
export declare function readCheckpointRestore(boot: NodeJS.ProcessEnv, fresh: NodeJS.ProcessEnv, receipt: unknown): HobbyCheckpointClaim | null;
export declare function readMountedCheckpointClaim(): Promise<HobbyCheckpointClaim | null>;
export declare function waitForCheckpointClaim(role: "gateway" | "edge"): Promise<HobbyCheckpointClaim>;
export declare function matchesRestartedCheckpoint(env: NodeJS.ProcessEnv, claim: HobbyCheckpointClaim | null, restoredPodUid: string): claim is HobbyCheckpointClaim;
declare function readCheckpointCredentials(): Promise<{
    token: string;
    agentStoreDsn: string;
}>;
export declare function checkpointGatewayCredentials(read?: typeof readCheckpointCredentials, wait?: () => Promise<void>): Promise<{
    token: string;
    agentStoreDsn: string;
}>;
export {};
