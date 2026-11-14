import type { GatewayArtifact } from "@octogee/core/gateway-live-release";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { sweepRetiredSharedGateways } from "./shared-gateway-retirement-sweep.js";

export interface SharedGatewayProductDeps {
  store: PlatformStateStore;
  platformArtifact: GatewayArtifact;
  log(message: string): void;
}

export interface SharedGatewayAutomationLoop {
  intervalMs: number;
  tick(): Promise<void>;
}

export interface SharedGatewayAutomation {
  recoverInterruptedAdds(): Promise<void>;
  start(): SharedGatewayAutomationLoop;
}

export type SharedGatewayProductFactory = (deps: SharedGatewayProductDeps) => SharedGatewayAutomation;

export const SHARED_GATEWAY_LOOP_MS = 30_000;

export function startSharedGatewayLoop(input: {
  store: PlatformStateStore;
  log(message: string): void;
  automation: SharedGatewayAutomationLoop | null;
}): () => void {
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await sweepRetiredSharedGateways({ store: input.store, log: input.log });
    } catch (error) {
      input.log(`[shared-pool-scaler] blocked closed: ${error instanceof Error ? error.message : String(error)}`);
      inFlight = false;
      return;
    }
    try {
      await input.automation?.tick();
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), input.automation?.intervalMs ?? SHARED_GATEWAY_LOOP_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
