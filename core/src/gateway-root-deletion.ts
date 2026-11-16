import type { ProvisioningServiceClient } from "./provisioning-service-client.js";

declare const gitKeysReleased: unique symbol;

export interface GitKeysReleasedProof {
  readonly gatewayId: string;
  readonly [gitKeysReleased]: true;
}

export type GatewayGitKeyRelease = Pick<ProvisioningServiceClient, "releaseGatewayGitKeys">;

export type RootGitKeyRelease =
  | { outcome: "released"; proof: GitKeysReleasedProof }
  | { outcome: "kept"; reason: string };

function proofFor(gatewayId: string): GitKeysReleasedProof {
  return Object.freeze({ gatewayId }) as GitKeysReleasedProof;
}

export async function releaseGitKeysBeforeRootDelete(keys: GatewayGitKeyRelease | null, gatewayId: string): Promise<RootGitKeyRelease> {
  if (keys === null) return { outcome: "released", proof: proofFor(gatewayId) };
  let remaining: number;
  try {
    ({ remaining } = await keys.releaseGatewayGitKeys(gatewayId));
  } catch (error) {
    return { outcome: "kept", reason: `releasing the git keys of ${gatewayId} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (remaining > 0) return { outcome: "kept", reason: `the provisioning service still holds ${remaining} git key rows for ${gatewayId}` };
  return { outcome: "released", proof: proofFor(gatewayId) };
}

export function assertGitKeysReleasedFor(gatewayId: string, proof: GitKeysReleasedProof): void {
  if (proof.gatewayId !== gatewayId) {
    throw new Error(`gateway root ${gatewayId} cannot be deleted with the git key release proof of ${proof.gatewayId}`);
  }
}
