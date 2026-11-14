import type { GatewayMutableConfig } from "@octogee/core/gateway-live-release";
import { describe, expect, it, vi } from "vitest";

import { prepareGatewayRuntimeConfig } from "../gateway-runtime-config.js";

function userConfig(overrides: Partial<GatewayMutableConfig> = {}): GatewayMutableConfig {
  return {
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: "octogee-gw-walter",
    serviceAccount: { create: true },
    builderAccess: { controlUiEnabled: true },
    ownerUid: "uid-user",
    builderSlug: "builder",
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

describe("prepareGatewayRuntimeConfig", () => {
  it("injects live API-server CIDRs into enabled user control configuration", async () => {
    const resolveApiServerEgressCidrs = vi.fn(async () => [
      "10.128.0.2/32",
      "34.118.224.1/32",
    ]);

    await expect(
      prepareGatewayRuntimeConfig(
        userConfig(),
        "walter",
        resolveApiServerEgressCidrs,
      ),
    ).resolves.toMatchObject({
      builderAccess: {
        controlUiEnabled: true,
        kubeApiServerEgressCidrs: ["10.128.0.2/32", "34.118.224.1/32"],
      },
    });
    expect(resolveApiServerEgressCidrs).toHaveBeenCalledOnce();
  });

  it("preserves the last known CIDRs when live resolution returns empty", async () => {
    const config = userConfig({
      builderAccess: {
        controlUiEnabled: true,
        kubeApiServerEgressCidrs: ["10.128.0.2/32"],
      },
    });

    await expect(
      prepareGatewayRuntimeConfig(config, "walter", async () => []),
    ).resolves.toBe(config);
  });

  it("fails preparation when neither live nor last-known CIDRs are available", async () => {
    await expect(
      prepareGatewayRuntimeConfig(userConfig(), "walter", async () => []),
    ).rejects.toThrow("isolated gateway walter has no API-server egress CIDRs");
  });

  it("injects API-server CIDRs when user Control UI is disabled", async () => {
    const resolveApiServerEgressCidrs = vi.fn(async () => ["10.128.0.2/32"]);
    const config = userConfig({ builderAccess: { controlUiEnabled: false } });

    await expect(
      prepareGatewayRuntimeConfig(config, "walter", resolveApiServerEgressCidrs),
    ).resolves.toMatchObject({
      builderAccess: {
        controlUiEnabled: false,
        kubeApiServerEgressCidrs: ["10.128.0.2/32"],
      },
    });
    expect(resolveApiServerEgressCidrs).toHaveBeenCalledOnce();
  });
});
