import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { commitAddUserPlacement } from "../lib/fleet-place-user.js";

function root(gatewayId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running",
    configSchemaVersion: 1, profile: "standard", gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null,
    ...overrides,
  };
}

function alice(openclaw: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { username: "alice", onboardingStep: "complete", provisioning: { status: "complete", openclaw: { slug: "alice", ...openclaw } }, ...extra };
}

function placementStore(docs: Record<string, Record<string, unknown>>) {
  const records = new Map(Object.entries(docs));
  return { store: createDocumentFixtureStore(records), records };
}

const placement = { uid: "u1", gatewayId: "shared-b", now: 5_000 };

describe("fleet add-customer placement", () => {
  it("writes the serving assignment in the same transaction as the user mirror", async () => {
    const { store, records } = placementStore({
      "users/u1": alice(),
      "gateways/shared-b": root("shared-b"),
    });

    await expect(commitAddUserPlacement(store, placement)).resolves.toBe("placed");

    expect(records.get("users/u1")).toMatchObject({
      provisioning: { openclaw: { gatewayId: "shared-b", gatewayProfile: "standard", controlUiEnabled: false } },
    });
    expect(records.get("gateways/shared-b/assignments/u1")).toEqual({
      uid: "u1", slug: "alice", gatewayId: "shared-b", source: "repair", state: "serving", epoch: 0,
      createdAt: 5_000, updatedAt: 5_000, updatedByOperationId: null,
    });
  });

  it("creates the missing assignment behind a mirror-only placement", async () => {
    const { store, records } = placementStore({
      "users/u1": alice({ gatewayId: "shared-b", gatewayProfile: "standard" }),
      "gateways/shared-b": root("shared-b"),
    });

    await expect(commitAddUserPlacement(store, placement)).resolves.toBe("placed");

    expect(records.get("gateways/shared-b/assignments/u1")).toMatchObject({ uid: "u1", slug: "alice", state: "serving" });
  });

  it("repairs the mirrored profile without rewriting the existing assignment", async () => {
    const assignment = { uid: "u1", slug: "alice", gatewayId: "shared-b", source: "onboarding", state: "serving", epoch: 3, createdAt: 1, updatedAt: 2, updatedByOperationId: null };
    const { store, records } = placementStore({
      "users/u1": alice({ gatewayId: "shared-b", gatewayProfile: "isolated" }),
      "gateways/shared-b": root("shared-b"),
      "gateways/shared-b/assignments/u1": assignment,
    });

    await expect(commitAddUserPlacement(store, placement)).resolves.toBe("repaired");

    expect(records.get("users/u1")).toMatchObject({ provisioning: { openclaw: { gatewayProfile: "standard", controlUiEnabled: false } } });
    expect(records.get("gateways/shared-b/assignments/u1")).toEqual(assignment);
  });

  it("reports an already-assigned user as unchanged without writing", async () => {
    const docs = {
      "users/u1": alice({ gatewayId: "shared-b", gatewayProfile: "standard" }),
      "gateways/shared-b": root("shared-b"),
      "gateways/shared-b/assignments/u1": { uid: "u1", slug: "alice", gatewayId: "shared-b", source: "onboarding", state: "serving", epoch: 3, createdAt: 1, updatedAt: 2, updatedByOperationId: null },
    };
    const { store, records } = placementStore(structuredClone(docs));

    await expect(commitAddUserPlacement(store, placement)).resolves.toBe("unchanged");

    expect(Object.fromEntries(records)).toEqual(docs);
  });

  it("fails loudly instead of writing a mirror for a gateway without a durable root", async () => {
    const docs = { "users/u1": alice() };
    const { store, records } = placementStore(structuredClone(docs));

    await expect(commitAddUserPlacement(store, placement)).rejects.toThrow("gateway shared-b does not exist");

    expect(Object.fromEntries(records)).toEqual(docs);
  });

  it("refuses inside the transaction when the user is served elsewhere", async () => {
    const docs = {
      "users/u1": alice({ gatewayId: "shared-a" }),
      "gateways/shared-a": root("shared-a"),
      "gateways/shared-b": root("shared-b"),
      "gateways/shared-a/assignments/u1": { uid: "u1", slug: "alice", gatewayId: "shared-a", source: "onboarding", state: "serving", epoch: 1, createdAt: 1, updatedAt: 1, updatedByOperationId: null },
    };
    const { store, records } = placementStore(structuredClone(docs));

    await expect(commitAddUserPlacement(store, placement)).rejects.toThrow(/assigned to shared-a.*migrate-customer/);

    expect(Object.fromEntries(records)).toEqual(docs);
  });

  it("refuses a gateway that is no longer running", async () => {
    const { store } = placementStore({
      "users/u1": alice(),
      "gateways/shared-b": root("shared-b", { desiredStatus: "draining" }),
    });

    await expect(commitAddUserPlacement(store, placement)).rejects.toThrow("gateway shared-b is draining, not running");
  });

  it("places a user whose mirror names another gateway that holds no assignment for them", async () => {
    const { store, records } = placementStore({
      "users/u1": alice({ gatewayId: "shared-a" }),
      "gateways/shared-a": root("shared-a"),
      "gateways/shared-b": root("shared-b"),
    });

    await expect(commitAddUserPlacement(store, placement)).resolves.toBe("placed");

    expect(records.get("users/u1")).toMatchObject({ provisioning: { openclaw: { gatewayId: "shared-b" } } });
  });

  it("places a user held by the operator and leaves the hold in place", async () => {
    const { store, records } = placementStore({ "users/u1": alice({ managedBy: "operator" }), "gateways/shared-b": root("shared-b") });

    await expect(commitAddUserPlacement(store, placement)).resolves.toBe("placed");

    expect(records.get("users/u1")).toMatchObject({ provisioning: { openclaw: { managedBy: "operator", gatewayId: "shared-b" } } });
  });

  it("places a user on a running gateway that is not serving yet", async () => {
    const { store, records } = placementStore({
      "users/u1": alice(),
      "gateways/shared-b": root("shared-b"),
      "glmGateways/shared-b": { docKind: "runtime", gatewayId: "shared-b", release: 1, lifecycle: "starting", heartbeat: { status: "unreachable", lastHeartbeatAt: 1, mountedCustomers: [] } },
    });

    await expect(commitAddUserPlacement(store, placement)).resolves.toBe("placed");

    expect(records.get("gateways/shared-b/assignments/u1")).toMatchObject({ uid: "u1", gatewayId: "shared-b", state: "serving" });
  });

  it.each([
    ["another user's isolated gateway", { "gateways/shared-b": root("shared-b", { gatewayClass: "isolated", profile: "isolated", imageProfile: "isolated", ownerUid: "u2", builderSlug: "bob" }) }, "gateway shared-b is isolated"],
    ["the user's own isolated gateway", { "gateways/shared-b": root("shared-b", { gatewayClass: "isolated", profile: "isolated", imageProfile: "isolated", ownerUid: "u1", builderSlug: "alice" }) }, "gateway shared-b is isolated"],
    ["a retired gateway", { "gateways/shared-b": root("shared-b", { desiredStatus: "retired" }) }, "gateway shared-b is retired"],
    ["a paused gateway", { "gateways/shared-b": root("shared-b", { desiredStatus: "paused" }) }, "gateway shared-b is paused, not running"],
    ["a user under a restore fence", { "users/u1": alice({ restoreFence: { operationId: "restore-1" } }) }, "restore in progress"],
    ["a closed account", { "users/u1": alice({}, { accountLifecycle: { status: "deletion_scheduled", eraseAfter: 1_800_000_000_000 } }) }, "account is not interactive"],
    ["a user not admitted", { "users/u1": { ...alice(), onboardingStep: "profile" } }, "user is not admitted"],
    ["a user whose migration fence is held", { "users/u1": alice({ migration: { state: "moving", operationId: "migrate-7", startedAt: 1 } }) }, "migrate-7"],
    ["a user with no mirror holding an assignment on another gateway", {
      "gateways/shared-a": root("shared-a"),
      "gateways/shared-a/assignments/u1": { uid: "u1", slug: "alice", gatewayId: "shared-a", source: "onboarding", state: "serving", epoch: 1, createdAt: 1, updatedAt: 1, updatedByOperationId: null },
    }, "assigned to shared-a"],
  ])("refuses %s without writing", async (_name, overrides, message) => {
    const docs = { "users/u1": alice(), "gateways/shared-b": root("shared-b"), ...overrides };
    const { store, records } = placementStore(structuredClone(docs));

    await expect(commitAddUserPlacement(store, placement)).rejects.toThrow(message);

    expect(Object.fromEntries(records)).toEqual(docs);
  });
});
