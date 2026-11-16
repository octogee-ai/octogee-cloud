import type { ProvisioningServiceClient } from "./provisioning-service-client.js";
declare const gitKeysReleased: unique symbol;
export interface GitKeysReleasedProof {
    readonly gatewayId: string;
    readonly [gitKeysReleased]: true;
}
export type GatewayGitKeyRelease = Pick<ProvisioningServiceClient, "releaseGatewayGitKeys">;
export type RootGitKeyRelease = {
    outcome: "released";
    proof: GitKeysReleasedProof;
} | {
    outcome: "kept";
    reason: string;
};
export declare function releaseGitKeysBeforeRootDelete(keys: GatewayGitKeyRelease | null, gatewayId: string): Promise<RootGitKeyRelease>;
export declare function assertGitKeysReleasedFor(gatewayId: string, proof: GitKeysReleasedProof): void;
export {};
