import type { GatewayRoot, PlatformStateStore } from "@octogee/core/platform-state";
import type { GatewayVmClient, GatewayVmDescription } from "./compute-vm.js";

interface NativeRetirementInput {
  gatewayId: string;
  operationId: string;
  version: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function pausedRetirementClaimMatches(root: GatewayRoot, input: NativeRetirementInput): boolean {
  const claim = record(root.retirementClaim);
  return root.gatewayClass === "isolated" &&
    nonEmpty(root.ownerUid) && root.desiredStatus === "retired" &&
    claim.operationId === input.operationId && claim.version === input.version &&
    claim.phase === "claimed" && claim.previousDesiredStatus === "paused";
}

function stoppedVmMatches(
  current: GatewayVmDescription,
  vm: Record<string, unknown>,
  root: GatewayRoot,
  gatewayId: string,
): boolean {
  return current.instanceId === vm.instanceId &&
    current.name === vm.instanceName && current.zone === vm.zone &&
    current.gatewayId === gatewayId &&
    current.labels["octogee-owner-uid"] === (root.ownerUid as string).toLowerCase() &&
    current.metadata["octogee-owner-uid"] === root.ownerUid &&
    ["TERMINATED", "STOPPED", "SUSPENDED"].includes(current.status);
}

export async function pausedIsolatedRetirementSourceFencedOff(
  deps: {
    store: PlatformStateStore;
    describe: GatewayVmClient["describe"];
    podsAbsent: (gatewayId: string) => Promise<boolean>;
  },
  input: NativeRetirementInput,
): Promise<boolean> {
  const [root, runtime] = await Promise.all([
    deps.store.gateways.roots.get(input.gatewayId),
    deps.store.fleetRegistry.get(input.gatewayId),
  ]);
  if (root === null || !pausedRetirementClaimMatches(root, input)) return false;
  if (runtime?.runtime === "cluster") return deps.podsAbsent(input.gatewayId);
  if (runtime === null || runtime.runtime !== "gce-vm") return false;
  const vm = record(runtime.vm);
  if (!nonEmpty(vm.instanceName) || !nonEmpty(vm.instanceId) || !nonEmpty(vm.zone)) return false;
  const current = await deps.describe(vm.instanceName, vm.zone);
  return current === null || stoppedVmMatches(current, vm, root, input.gatewayId);
}
