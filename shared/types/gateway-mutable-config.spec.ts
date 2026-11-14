import { describe, expect, it } from "vitest";

import {
  isGatewayMutableConfigForGateway,
  isGatewayMutableConfig,
  projectGatewayMutableConfigForGateway,
  type GatewayMutableConfig,
} from "./gateway-mutable-config.js";

function validConfig(
  overrides: Partial<GatewayMutableConfig> = {},
): GatewayMutableConfig {
  return {
    configSchemaVersion: 1,
    profile: "isolated",
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: "l",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: { controlUiEnabled: true },
    ownerUid: "uid-owner",
    builderSlug: "owner",
    modelBrokerLimits: null,
    preemption: null,
    allocation: null,
    ...overrides,
  };
}

describe("gateway mutable config", () => {
  it("accepts the complete durable root authority shape", () => {
    expect(isGatewayMutableConfig(validConfig({
      builderAccess: { controlUiEnabled: true },
    }))).toBe(true);
  });

  it("rejects the retired operator user gateway class", () => {
    expect(isGatewayMutableConfig({
      ...validConfig(),
      gatewayClass: "operator",
    })).toBe(false);
  });

  it("rejects class and runtime profile mismatches", () => {
    expect(isGatewayMutableConfig(validConfig({
      gatewayClass: "isolated",
      imageProfile: "standard",
    }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({
      profile: "standard",
      gatewayClass: "isolated",
      imageProfile: "isolated",
    }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({
      profile: "isolated",
      gatewayClass: "shared",
      imageProfile: "standard",
      ownerUid: null,
      builderSlug: null,
    }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({
      profile: null,
      gatewayClass: "shared",
      imageProfile: "isolated",
      ownerUid: null,
      builderSlug: null,
    }))).toBe(false);
  });

  it("accepts a durable root that carries no computeClass at all", () => {
    const config = validConfig();
    expect(Object.prototype.hasOwnProperty.call(config, "computeClass")).toBe(false);
    expect(isGatewayMutableConfigForGateway(config, "owner")).toBe(true);
  });

  it("treats a residual computeClass from the retired ComputeClass era as inert", () => {
    for (const residue of ["octogee-gateway-spot", "", 123, null]) {
      expect(
        isGatewayMutableConfigForGateway(
          { ...validConfig(), computeClass: residue },
          "owner",
        ),
      ).toBe(true);
    }
  });

  it("accepts a durable root that carries no openclawOverrides", () => {
    const config = validConfig();
    expect(Object.prototype.hasOwnProperty.call(config, "openclawOverrides")).toBe(false);
    expect(isGatewayMutableConfigForGateway(config, "owner")).toBe(true);
  });

  it("treats residual openclawOverrides from the retired admin knob as inert", () => {
    for (const residue of [null, { session: { dmScope: "per-channel-peer" } }]) {
      expect(
        isGatewayMutableConfigForGateway(
          { ...validConfig(), openclawOverrides: residue },
          "owner",
        ),
      ).toBe(true);
    }
  });

  it("rejects a non-boolean Control UI capability", () => {
    expect(isGatewayMutableConfig({
      ...validConfig(),
      builderAccess: { controlUiEnabled: "yes" },
    })).toBe(false);
  });

  it("accepts a per-user control identity and rejects any other identity mode", () => {
    expect(isGatewayMutableConfig(validConfig({
      builderAccess: { controlUiEnabled: true, controlIdentity: "per-user" },
    }))).toBe(true);
    expect(isGatewayMutableConfig(validConfig({
      builderAccess: { controlUiEnabled: true, controlIdentity: "shared-operator" },
    }))).toBe(true);
    expect(isGatewayMutableConfig({
      ...validConfig(),
      builderAccess: { controlUiEnabled: true, controlIdentity: "trusted-proxy" },
    })).toBe(false);
  });

  it("rejects network authority embedded in mutable user access", () => {
    expect(isGatewayMutableConfig({
      ...validConfig(),
      builderAccess: {
        platformMetadataEgress: true,
      },
    })).toBe(false);
  });

  it("rejects a credential-bearing or malformed root config", () => {
    expect(isGatewayMutableConfig({ ...validConfig(), byosub: {} })).toBe(false);
    expect(isGatewayMutableConfig({ ...validConfig(), standby: null })).toBe(false);
    expect(isGatewayMutableConfig({ ...validConfig(), standby: { kind: "hobby", schemaVersion: 1, mintedAt: 1 } })).toBe(false);
    expect(isGatewayMutableConfig(validConfig({ ownerUid: null }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({ builderSlug: null }))).toBe(false);
    expect(isGatewayMutableConfig({
      ...validConfig(),
      preemption: { warmTargetGatewayId: "owner-warm" },
    })).toBe(false);
  });

  it("projects only an empty retired co-owner mirror out of a desired-root read", () => {
    const transitional = { ...validConfig(), coOwnerUids: [] };

    expect(isGatewayMutableConfigForGateway(transitional, "owner")).toBe(false);
    expect(projectGatewayMutableConfigForGateway(transitional, "owner")).toEqual(validConfig());
    expect(
      projectGatewayMutableConfigForGateway(
        { ...validConfig(), coOwnerUids: ["uid-former-helper"] },
        "owner",
      ),
    ).toBeNull();
  });

  it("keeps shared gateways ownerless while requiring the complete dedicated owner pair", () => {
    expect(isGatewayMutableConfig(validConfig({
      profile: null,
      gatewayClass: "shared",
      imageProfile: "standard",
      ownerUid: null,
      builderSlug: null,
    }))).toBe(true);
    expect(isGatewayMutableConfig(validConfig({ ownerUid: "uid-owner", builderSlug: null }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({ ownerUid: null, builderSlug: "owner" }))).toBe(false);
  });

  it("rejects an unowned user", () => {
    const unowned = { ownerUid: null, builderSlug: null, allocation: null };
    expect(isGatewayMutableConfig(validConfig(unowned))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({ ...unowned, sizingTier: "s" }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({ ownerUid: null, builderSlug: "owner", allocation: null }))).toBe(false);
  });

  it("requires disposable allocations to carry the matching owner and lease generation", () => {
    expect(isGatewayMutableConfig(validConfig({
      allocation: {
        kind: "disposable-builder",
        schemaVersion: 1,
        leaseId: "lease-one",
        generation: 1,
        claimedByUid: "uid-owner",
      },
    }))).toBe(true);
    expect(isGatewayMutableConfig(validConfig({
      allocation: {
        kind: "disposable-builder",
        schemaVersion: 1,
        leaseId: "lease-one",
        generation: 1,
        claimedByUid: "uid-other",
      },
    }))).toBe(false);
    expect(isGatewayMutableConfig(validConfig({
      allocation: {
        kind: "disposable-builder",
        schemaVersion: 1,
        leaseId: "lease-one",
        generation: 0,
        claimedByUid: "uid-owner",
      },
    }))).toBe(false);
  });

  it("allows only the addressed gateway's generated service account", () => {
    expect(
      isGatewayMutableConfigForGateway(
        validConfig({ serviceAccountName: "octogee-gw-walter" }),
        "walter",
      ),
    ).toBe(true);
    expect(
      isGatewayMutableConfigForGateway(
        validConfig({ serviceAccountName: "octogee-gw-other" }),
        "walter",
      ),
    ).toBe(false);
  });

  it("rejects default and platform service accounts while preserving custom tenant KSAs", () => {
    for (const serviceAccountName of [
      "default",
      "octogee-api",
      "octogee-gateway",
      "octogee-cron",
      "glm-controller",
      "llm-broker",
    ]) {
      expect(
        isGatewayMutableConfigForGateway(validConfig({ serviceAccountName }), "walter"),
      ).toBe(false);
    }
    expect(
      isGatewayMutableConfigForGateway(
        validConfig({ serviceAccountName: "custom-tenant-ksa" }),
        "walter",
      ),
    ).toBe(true);
  });
});
