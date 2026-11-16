import type { GatewayGitKeyRelease } from "@octogee/core/gateway-root-deletion";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { sweepRetiredSharedGateways } from "./shared-gateway-retirement-sweep.js";

export const SHARED_GATEWAY_RETIREMENT_SWEEP_MS = 30_000;

export function startSharedGatewayRetirementLoop(input: {
  store: PlatformStateStore;
  gatewayGitKeys: GatewayGitKeyRelease | null;
  log(message: string): void;
}): () => void {
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await sweepRetiredSharedGateways({ store: input.store, gatewayGitKeys: input.gatewayGitKeys, log: input.log });
    } catch (error) {
      input.log(`[glm-controller] ⚠ shared gateway retirement sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), SHARED_GATEWAY_RETIREMENT_SWEEP_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
