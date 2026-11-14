import type { RolloutLane } from "@octogee/core/fleet-operation-lock";
import type { PlatformStateRepositories } from "@octogee/core/platform-state";
import { isValidGatewayId } from "@octogee/shared/types/glm";
import type { OperationRef } from "./operation-queue.js";

export async function readOperationRolloutLanes(
  state: Pick<PlatformStateRepositories, "gateways" | "fleetRegistry">,
  operations: readonly OperationRef[],
): Promise<ReadonlyMap<string, RolloutLane>> {
  const gatewayIds = [...new Set(operations.flatMap((operation) => {
    const gatewayId = operation.input?.gatewayId;
    return operation.kind === "rollout" && isValidGatewayId(gatewayId) ? [gatewayId] : [];
  }))];
  const [roots, runtimes] = await Promise.all([
    state.gateways.roots.getMany(gatewayIds),
    state.fleetRegistry.getMany(gatewayIds),
  ]);
  const lanes = new Map<string, RolloutLane>();
  for (const gatewayId of gatewayIds) {
    const root = roots.get(gatewayId);
    const runtime = runtimes.get(gatewayId);
    if (root?.gatewayClass !== "shared" && root?.gatewayClass !== "isolated") continue;
    if (runtime?.runtime === "cluster") lanes.set(gatewayId, "cluster");
    if (root.gatewayClass === "isolated" && runtime?.runtime === "gce-vm") lanes.set(gatewayId, "builder-vm");
  }
  return lanes;
}

export function withOperationRolloutLane<T extends OperationRef>(
  operation: T,
  lanes: ReadonlyMap<string, RolloutLane>,
): T {
  const gatewayId = operation.input?.gatewayId;
  return {
    ...operation,
    rolloutLane: operation.kind === "rollout" && typeof gatewayId === "string"
      ? lanes.get(gatewayId) : undefined,
  };
}
