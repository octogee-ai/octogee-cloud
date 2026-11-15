import type { PlatformStateStore } from "@octogee/core/platform-state";
import { isRetiredSharedGateway } from "./user-ops/retired-shared-gateway.js";

export function createNativeReturnTargetRetirementVerifier(input: {
  store: PlatformStateStore;
  runtimeAbsent(gatewayId: string): Promise<boolean>;
  credentialsRetired(gatewayId: string, assertCurrent: () => Promise<void>): Promise<boolean>;
}) {
  return async (gatewayId: string, assertCurrent: () => Promise<void>): Promise<boolean> => {
    await assertCurrent();
    if (!await isRetiredSharedGateway(input.store, gatewayId, input.runtimeAbsent)) return false;
    await assertCurrent();
    if (!await input.credentialsRetired(gatewayId, assertCurrent)) return false;
    await assertCurrent();
    return isRetiredSharedGateway(input.store, gatewayId, input.runtimeAbsent);
  };
}
