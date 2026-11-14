import { describe, expect, it } from "vitest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import { createModelBrokerOwnerAccessResolver } from "./model-broker-owner-access.js";

function durableGateway(gatewayId: string, ownerUid: string | null): Record<string, unknown> {
  return {
    gatewayId,
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    liveRevisionId: `${gatewayId}-r1`,
    trafficRevisionId: `${gatewayId}-r1`,
    desiredStatus: "running",
    roll: null,
    configSchemaVersion: 1,
    profile: null,
    gatewayClass: "isolated",
    imageProfile: "standard",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid,
    builderSlug: ownerUid === null ? null : "alice",
    modelBrokerLimits: null,
    preemption: null,
  };
}

function resolver(documents: Record<string, Record<string, unknown>>) {
  return createModelBrokerOwnerAccessResolver(createDocumentFixtureStore(documents));
}

describe("createModelBrokerOwnerAccessResolver", () => {
  it("allows an active token owner", async () => {
    const resolve = resolver({ "users/uid-1": { accountLifecycle: { status: "active" } } });
    await expect(resolve({ gatewayId: "gw-1", ownerUid: "uid-1" })).resolves.toBe(true);
  });

  it.each(["suspended", "deletion_scheduled", "erasing"])(
    "denies a %s token owner",
    async (status) => {
      const resolve = resolver({ "users/uid-1": { accountLifecycle: { status } } });
      await expect(resolve({ gatewayId: "gw-1", ownerUid: "uid-1" })).resolves.toBe(false);
    },
  );

  it("resolves the owner from a single-tenant gateway when the token has no ownerUid", async () => {
    const resolve = resolver({
      "gateways/gw-1": durableGateway("gw-1", "uid-1"),
      "users/uid-1": { username: "alice" },
    });
    await expect(resolve({ gatewayId: "gw-1", ownerUid: null })).resolves.toBe(true);
  });

  it("fails closed when either owner identity or user data is missing", async () => {
    await expect(resolver({})({ gatewayId: "gw-1", ownerUid: null })).resolves.toBe(false);
    await expect(resolver({ "gateways/gw-1": durableGateway("gw-1", null) })({ gatewayId: "gw-1", ownerUid: null }))
      .resolves.toBe(false);
    await expect(resolver({ "gateways/gw-1": durableGateway("gw-1", "uid-1") })({ gatewayId: "gw-1", ownerUid: null }))
      .resolves.toBe(false);
  });

  it("refuses a gateway root that is not a durable record", async () => {
    const resolve = resolver({ "gateways/gw-1": { ownerUid: "uid-1" }, "users/uid-1": { username: "alice" } });
    await expect(resolve({ gatewayId: "gw-1", ownerUid: null })).rejects.toBeInstanceOf(MalformedRecordError);
  });
});
