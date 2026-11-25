import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHARED_GATEWAY_AUTOSCALING_ENABLED,
  DEFAULT_SHARED_GATEWAY_MAX_GATEWAYS,
  DEFAULT_SHARED_GATEWAY_MIN_GATEWAYS,
  DEFAULT_SHARED_GATEWAY_USERS_PER_GATEWAY,
} from "@octogee/shared/types/shared-gateway-pool";
import {
  InvalidSharedGatewayAutoscalingConfigError,
  readSharedGatewayAutoscalingConfigInStore,
} from "../shared-gateway-pool-read.js";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";

describe("readSharedGatewayAutoscalingConfigInStore", () => {
  it("reads the operator autoscaling dial", async () => {
    const store = createDocumentFixtureStore({
      "config/orchestrator": { sharedGatewayAutoscaling: { enabled: false, buildersPerGateway: 6, minGateways: 0, maxGateways: 3 } },
    });

    await expect(readSharedGatewayAutoscalingConfigInStore(store)).resolves.toEqual({
      enabled: false,
      buildersPerGateway: 6,
      minGateways: 0,
      maxGateways: 3,
    });
  });

  it("reads the defaults when the orchestrator config is absent", async () => {
    await expect(readSharedGatewayAutoscalingConfigInStore(createDocumentFixtureStore({}))).resolves.toEqual({
      enabled: DEFAULT_SHARED_GATEWAY_AUTOSCALING_ENABLED,
      buildersPerGateway: DEFAULT_SHARED_GATEWAY_USERS_PER_GATEWAY,
      minGateways: DEFAULT_SHARED_GATEWAY_MIN_GATEWAYS,
      maxGateways: DEFAULT_SHARED_GATEWAY_MAX_GATEWAYS,
    });
  });

  it.each([
    { enabled: true, buildersPerGateway: 1 },
    { enabled: true, buildersPerGateway: 4, minGateways: 5, maxGateways: 4 },
  ])("fails closed on a malformed dial %j", async (sharedGatewayAutoscaling) => {
    const store = createDocumentFixtureStore({ "config/orchestrator": { sharedGatewayAutoscaling } });

    await expect(readSharedGatewayAutoscalingConfigInStore(store)).rejects.toBeInstanceOf(InvalidSharedGatewayAutoscalingConfigError);
  });
});
