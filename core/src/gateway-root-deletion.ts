import type { ProvisioningServiceClient } from "./provisioning-service-client.js";

declare const gitKeysReleased: unique symbol;

export interface GitKeysReleasedProof {
  readonly gatewayId: string;
  readonly [gitKeysReleased]: true;
}

export type GatewayGitKeyRelease = Pick<ProvisioningServiceClient, "releaseGatewayGitKeys">;

export interface RootGitKeyGate {
  client: GatewayGitKeyRelease | null;
  log(message: string): void;
}

export type RootGitKeyRelease =
  | { outcome: "released"; proof: GitKeysReleasedProof }
  | { outcome: "kept"; reason: string };

function proofFor(gatewayId: string): GitKeysReleasedProof {
  return Object.freeze({ gatewayId }) as GitKeysReleasedProof;
}

function remainingRows(answer: unknown): number | null {
  if (answer === null || typeof answer !== "object") return null;
  const { remaining } = answer as { remaining?: unknown };
  return typeof remaining === "number" && Number.isInteger(remaining) && remaining >= 0 ? remaining : null;
}

export async function releaseGitKeysBeforeRootDelete(gate: RootGitKeyGate, gatewayId: string): Promise<RootGitKeyRelease> {
  if (gate.client === null) {
    gate.log(`[git-keys] no provisioning service is configured, so the root of ${gatewayId} is deleted without releasing git keys`);
    return { outcome: "released", proof: proofFor(gatewayId) };
  }
  let answer: unknown;
  try {
    answer = await gate.client.releaseGatewayGitKeys(gatewayId);
  } catch (error) {
    return { outcome: "kept", reason: `releasing the git keys of ${gatewayId} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const remaining = remainingRows(answer);
  if (remaining === null) return { outcome: "kept", reason: `the provisioning service did not answer how many git key rows remain for ${gatewayId}` };
  if (remaining > 0) return { outcome: "kept", reason: `the provisioning service still holds ${remaining} git key rows for ${gatewayId}` };
  return { outcome: "released", proof: proofFor(gatewayId) };
}

export function assertGitKeysReleasedFor(gatewayId: string, proof: GitKeysReleasedProof): void {
  if (proof.gatewayId !== gatewayId) {
    throw new Error(`gateway root ${gatewayId} cannot be deleted with the git key release proof of ${proof.gatewayId}`);
  }
}
