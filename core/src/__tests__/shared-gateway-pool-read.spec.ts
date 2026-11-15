import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHARED_GATEWAY_AUTOSCALING_ENABLED,
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
      "config/orchestrator": { sharedGatewayAutoscaling: { enabled: false, buildersPerGateway: 6 } },
    });

    await expect(readSharedGatewayAutoscalingConfigInStore(store)).resolves.toEqual({ enabled: false, buildersPerGateway: 6 });
  });

  it("reads the defaults when the orchestrator config is absent", async () => {
    await expect(readSharedGatewayAutoscalingConfigInStore(createDocumentFixtureStore({}))).resolves.toEqual({
      enabled: DEFAULT_SHARED_GATEWAY_AUTOSCALING_ENABLED,
      buildersPerGateway: DEFAULT_SHARED_GATEWAY_USERS_PER_GATEWAY,
    });
  });

  it("fails closed on a malformed dial", async () => {
    const store = createDocumentFixtureStore({
      "config/orchestrator": { sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 1 } },
    });

    await expect(readSharedGatewayAutoscalingConfigInStore(store)).rejects.toBeInstanceOf(InvalidSharedGatewayAutoscalingConfigError);
  });
});
