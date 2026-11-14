import { describe, expect, it } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { mapSaToTenant } from "../sa-to-tenant.js";

function durableGateway(
  gatewayId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "operator:test",
    updatedAt: 1,
    updatedBy: "operator:test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    liveRevisionId: `${gatewayId}-r1`,
    trafficRevisionId: `${gatewayId}-r1`,
    desiredStatus: "running",
    roll: null,
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "shared",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: null,
    builderSlug: null,
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

function inFlightRetirementClaim(): Record<string, unknown> {
  return {
    operationId: "shared-pool-retire-x",
    version: 1,
    claimedAt: 1,
    phase: "claimed",
    liveRelease: 1,
    liveRuntimeIdentity: null,
    previousDesiredStatus: "running",
  };
}

describe("mapSaToTenant", () => {
  it("maps per-gateway KSAs from durable root ownership", async () => {
    const result = await mapSaToTenant(
      createDocumentFixtureStore({
        "gateways/walter": durableGateway("walter", {
          gatewayClass: "isolated",
          imageProfile: "isolated",
          ownerUid: "uid-walter",
          builderSlug: "walter",
        }),
      }),
      { namespace: "octogee", saName: "octogee-gw-walter" },
      "octogee",
    );

    expect(result).toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "walter", ownerUid: "uid-walter" },
    });
  });

  it("maps a gateway with only an empty retired co-owner mirror", async () => {
    await expect(
      mapSaToTenant(
        createDocumentFixtureStore({
          "gateways/walter": durableGateway("walter", {
            gatewayClass: "isolated",
            imageProfile: "isolated",
            ownerUid: "uid-walter",
            builderSlug: "walter",
            coOwnerUids: [],
          }),
        }),
        { namespace: "octogee", saName: "octogee-gw-walter" },
        "octogee",
      ),
    ).resolves.toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "walter", ownerUid: "uid-walter" },
    });

    await expect(
      mapSaToTenant(
        createDocumentFixtureStore({
          "gateways/walter": durableGateway("walter", {
            gatewayClass: "isolated",
            imageProfile: "isolated",
            ownerUid: "uid-walter",
            builderSlug: "walter",
            coOwnerUids: ["uid-former-helper"],
          }),
        }),
        { namespace: "octogee", saName: "octogee-gw-walter" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("takes the KSA suffix as the bare gateway id", async () => {
    const result = await mapSaToTenant(
      createDocumentFixtureStore({ "gateways/canary-2": durableGateway("canary-2") }),
      { namespace: "octogee", saName: "octogee-gw-canary-2" },
      "octogee",
    );

    expect(result).toMatchObject({
      attached: true,
      tenant: { gatewayId: "canary-2" },
    });
  });

  it("rejects retired operator KSA names even when stale root config names one", async () => {
    const result = await mapSaToTenant(
      createDocumentFixtureStore({
        "gateways/walter": durableGateway("walter", {
          gatewayClass: "isolated",
          imageProfile: "isolated",
          ownerUid: "uid-walter",
          builderSlug: "walter",
          serviceAccountName: "octogee-gateway-walter",
        }),
      }),
      { namespace: "octogee", saName: "octogee-gateway-walter" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "unknown_sa" });
  });

  it("maps a custom KSA through exactly one active durable root", async () => {
    const result = await mapSaToTenant(
      createDocumentFixtureStore({
        "gateways/walter": durableGateway("walter", {
          gatewayClass: "isolated",
          imageProfile: "isolated",
          ownerUid: "uid-walter",
          builderSlug: "walter",
          serviceAccountName: "custom-operator-ksa",
        }),
      }),
      { namespace: "octogee", saName: "custom-operator-ksa" },
      "octogee",
    );

    expect(result).toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "walter", ownerUid: "uid-walter" },
    });
  });

  it("denies a custom KSA with no, ambiguous, or retired durable root", async () => {
    await expect(
      mapSaToTenant(
        createDocumentFixtureStore({}),
        { namespace: "octogee", saName: "custom-operator-ksa" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });

    await expect(
      mapSaToTenant(
        createDocumentFixtureStore({
          "gateways/alpha": durableGateway("alpha", { serviceAccountName: "custom-operator-ksa" }),
          "gateways/beta": durableGateway("beta", { serviceAccountName: "custom-operator-ksa" }),
        }),
        { namespace: "octogee", saName: "custom-operator-ksa" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });

    await expect(
      mapSaToTenant(
        createDocumentFixtureStore({
          "gateways/walter": durableGateway("walter", {
            serviceAccountName: "custom-operator-ksa",
            desiredStatus: "retired",
          }),
        }),
        { namespace: "octogee", saName: "custom-operator-ksa" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("requires the prefix KSA to equal the root's effective KSA", async () => {
    await expect(
      mapSaToTenant(
        createDocumentFixtureStore({
          "gateways/walter": durableGateway("walter", {
            serviceAccountName: "custom-operator-ksa",
          }),
        }),
        { namespace: "octogee", saName: "octogee-gw-walter" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });

    await expect(
      mapSaToTenant(
        createDocumentFixtureStore({
          "gateways/walter": durableGateway("walter", {
            serviceAccountName: "octogee-gw-other",
          }),
        }),
        { namespace: "octogee", saName: "octogee-gw-walter" },
        "octogee",
      ),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("soft-fails a namespace mismatch before the root lookup", async () => {
    const result = await mapSaToTenant(
      createDocumentFixtureStore({}),
      { namespace: "octogee-test", saName: "octogee-gw-walter" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "ns_mismatch" });
  });

  it("soft-fails a missing durable root", async () => {
    await expect(
      mapSaToTenant(createDocumentFixtureStore({}), { namespace: "octogee", saName: "octogee-gw-walter" }, "octogee"),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("fails closed on a malformed durable root", async () => {
    await expect(
      mapSaToTenant(
        createDocumentFixtureStore({ "gateways/walter": { gatewayId: "walter", desiredStatus: "running" } }),
        { namespace: "octogee", saName: "octogee-gw-walter" },
        "octogee",
      ),
    ).rejects.toBeInstanceOf(MalformedRecordError);
  });

  it("rejects a retired durable gateway", async () => {
    const result = await mapSaToTenant(
      createDocumentFixtureStore({ "gateways/walter": durableGateway("walter", { desiredStatus: "retired" }) }),
      { namespace: "octogee", saName: "octogee-gw-walter" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("keeps a retiring gateway's pod-bound identity while its retirement claim is in flight", async () => {
    const retiring = durableGateway("shared-0a1b2c3d4e5f", {
      desiredStatus: "retired",
      retirementVersion: 1,
      retirementClaim: inFlightRetirementClaim(),
    });

    await expect(
      mapSaToTenant(
        createDocumentFixtureStore({ "gateways/shared-0a1b2c3d4e5f": retiring }),
        { namespace: "octogee", saName: "octogee-gw-shared-0a1b2c3d4e5f", podUid: "pod-uid-1" },
        "octogee",
      ),
    ).resolves.toEqual({
      attached: true,
      result: "ok",
      retiring: true,
      tenant: { kind: "gateway", gatewayId: "shared-0a1b2c3d4e5f" },
    });

    await expect(
      mapSaToTenant(
        createDocumentFixtureStore({
          "gateways/walter": durableGateway("walter", {
            serviceAccountName: "custom-operator-ksa",
            desiredStatus: "retired",
            retirementVersion: 1,
            retirementClaim: inFlightRetirementClaim(),
          }),
        }),
        { namespace: "octogee", saName: "custom-operator-ksa", podUid: "pod-uid-1" },
        "octogee",
      ),
    ).resolves.toMatchObject({ attached: true, retiring: true, tenant: { gatewayId: "walter" } });
  });

  it("rejects a retiring gateway identity that is not bound to a pod", async () => {
    const result = await mapSaToTenant(
      createDocumentFixtureStore({
        "gateways/walter": durableGateway("walter", {
          desiredStatus: "retired",
          retirementVersion: 1,
          retirementClaim: inFlightRetirementClaim(),
        }),
      }),
      { namespace: "octogee", saName: "octogee-gw-walter" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("rejects a pod-bound identity of a retired gateway without a retirement claim", async () => {
    const result = await mapSaToTenant(
      createDocumentFixtureStore({ "gateways/walter": durableGateway("walter", { desiredStatus: "retired" }) }),
      { namespace: "octogee", saName: "octogee-gw-walter", podUid: "pod-uid-1" },
      "octogee",
    );

    expect(result).toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("binds a durable shared gateway without an owner", async () => {
    const result = await mapSaToTenant(
      createDocumentFixtureStore({ "gateways/default": durableGateway("default") }),
      { namespace: "octogee", saName: "octogee-gw-default" },
      "octogee",
    );

    expect(result).toEqual({
      attached: true,
      result: "ok",
      tenant: { kind: "gateway", gatewayId: "default" },
    });
  });

  it("never restores an owner from a stale release snapshot", async () => {
    const result = await mapSaToTenant(
      createDocumentFixtureStore({
        "gateways/walter": durableGateway("walter", {
          gatewayClass: "isolated",
          imageProfile: "isolated",
          ownerUid: "uid-current",
          builderSlug: "walter",
        }),
        "gateways/walter/releases/1": { payload: { ownerUid: "uid-stale" } },
      }),
      { namespace: "octogee", saName: "octogee-gw-walter" },
      "octogee",
    );

    expect(result).toMatchObject({
      attached: true,
      tenant: { gatewayId: "walter", ownerUid: "uid-current" },
    });
  });

  it("classifies the shared gateway KSA without tenant binding", async () => {
    await expect(
      mapSaToTenant(createDocumentFixtureStore({}), { namespace: "octogee", saName: "octogee-gateway" }, "octogee"),
    ).resolves.toEqual({ attached: false, result: "shared_gateway" });
  });

  it("soft-fails malformed and unknown service accounts", async () => {
    await expect(
      mapSaToTenant(createDocumentFixtureStore({}), { namespace: "octogee", saName: "octogee-gw-" }, "octogee"),
    ).resolves.toEqual({ attached: false, result: "malformed_sa" });
    await expect(
      mapSaToTenant(createDocumentFixtureStore({}), { namespace: "octogee", saName: "octogee-random" }, "octogee"),
    ).resolves.toEqual({ attached: false, result: "unknown_tenant" });
  });

  it("allows platform service accounts without any tenant lookup", async () => {
    await expect(
      mapSaToTenant(createDocumentFixtureStore({}), { namespace: "octogee", saName: "octogee-glm-controller" }, "octogee"),
    ).resolves.toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "glm-controller" },
    });
    await expect(
      mapSaToTenant(createDocumentFixtureStore({}), { namespace: "octogee", saName: "octogee-api" }, "octogee"),
    ).resolves.toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "octogee-api" },
    });
    await expect(
      mapSaToTenant(createDocumentFixtureStore({}), { namespace: "octogee", saName: "octogee-artifact-worker" }, "octogee"),
    ).resolves.toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "artifact-worker" },
    });
    await expect(
      mapSaToTenant(createDocumentFixtureStore({}), { namespace: "octogee", saName: "llm-broker" }, "octogee"),
    ).resolves.toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "llm-broker" },
    });
    await expect(
      mapSaToTenant(
        createDocumentFixtureStore({}),
        { namespace: "octogee", saName: "octogee-npm-cache-proxy" },
        "octogee",
      ),
    ).resolves.toEqual({
      attached: true,
      result: "ok_platform",
      tenant: { kind: "platform", actor: "npm-cache-proxy" },
    });
  });
});
