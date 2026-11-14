import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { installUserEntitlements, userEntitlements, type UserEntitlementResolver } from "../../shared/types/user-entitlements.js";
import { commitOperatorPlacement } from "@octogee/core/operator-placement";
import { assignOne } from "../ops/assign-user-gateway.js";

function sharedRoot(gatewayId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId, createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
    latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running",
    configSchemaVersion: 1, profile: "standard", gatewayClass: "shared", imageProfile: "standard", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: null, builderSlug: null, modelBrokerLimits: null, preemption: null,
    ...overrides,
  };
}

function servingRuntime(gatewayId: string, mountedCustomers: string[] = []): Record<string, unknown> {
  const now = Date.now();
  return {
    docKind: "runtime", gatewayId, release: 1, lifecycle: "serving",
    helm: { availableReplicas: 1 },
    heartbeat: { status: "ready", lastHeartbeatAt: now, mountedCustomers },
    kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: now },
  };
}

function user(openclaw: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    username: "alice", onboardingStep: "complete",
    provisioning: { status: "complete", openclaw: { status: "complete", slug: "alice", ...openclaw } },
  };
}

function assignment(gatewayId: string, uid: string, slug: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { uid, slug, gatewayId, source: "onboarding", state: "serving", epoch: 0, createdAt: 1, updatedAt: 1, updatedByOperationId: null, ...overrides };
}

function fixture(docs: Record<string, Record<string, unknown>>) {
  const records = new Map<string, Record<string, unknown>>(Object.entries({
    "config/orchestrator": { sharedGatewayAutoscaling: { enabled: true, buildersPerGateway: 2 } },
    "gateways/shared-0": sharedRoot("shared-0"),
    "glmGateways/shared-0": servingRuntime("shared-0"),
    ...docs,
  }));
  return { deps: { store: createDocumentFixtureStore(records) }, records };
}

const placement = { uid: "u1", gatewayId: "shared-0", source: "onboarding" as const, now: 5_000 };

describe("assign-user-gateway placement", () => {
  it("writes the mirror and the serving assignment together for an unplaced user", async () => {
    const { deps, records } = fixture({ "users/u1": user() });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toMatchObject({
      kind: "assigned", gatewayId: "shared-0", previous: null,
    });

    expect(records.get("users/u1")).toMatchObject({
      provisioning: { openclaw: { gatewayId: "shared-0", gatewayProfile: "standard", controlUiEnabled: false } },
    });
    expect(records.get("gateways/shared-0/assignments/u1")).toMatchObject({
      uid: "u1", slug: "alice", gatewayId: "shared-0", source: "onboarding", state: "serving", epoch: 0,
    });
  });

  it("repairs a missing assignment behind a mirror that already targets the gateway", async () => {
    const { deps, records } = fixture({ "users/u1": user({ gatewayId: "shared-0" }) });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toMatchObject({ kind: "already-assigned", gatewayId: "shared-0" });

    expect(records.get("gateways/shared-0/assignments/u1")).toMatchObject({ uid: "u1", slug: "alice", source: "repair", state: "serving" });
  });

  it("preserves an existing assignment while refreshing the mirror", async () => {
    const existing = assignment("shared-0", "u1", "alice", { source: "migrate-user", state: "quiescing", epoch: 8, updatedAt: 90, updatedByOperationId: "roll-1" });
    const { deps, records } = fixture({
      "users/u1": user({ gatewayId: "shared-0" }),
      "gateways/shared-0/assignments/u1": existing,
    });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toMatchObject({ kind: "already-assigned", gatewayId: "shared-0" });

    expect(records.get("gateways/shared-0/assignments/u1")).toEqual(existing);
    expect(records.get("users/u1")).toMatchObject({ provisioning: { openclaw: { gatewayProfile: "standard", controlUiEnabled: false } } });
  });

  it("writes nothing on a dry run", async () => {
    const { deps, records } = fixture({ "users/u1": user() });

    await expect(assignOne(deps, "u1", { dryRun: true, gatewayId: "shared-0" })).resolves.toMatchObject({ kind: "assigned", gatewayId: "shared-0" });

    expect(records.get("gateways/shared-0/assignments/u1")).toBeUndefined();
    expect(records.get("users/u1")).toEqual(user());
  });

  it("refuses a placement onto a missing gateway without writing the mirror", async () => {
    const { deps, records } = fixture({ "users/u1": user() });
    records.delete("gateways/shared-0");

    await expect(commitOperatorPlacement(deps.store, placement)).resolves.toMatchObject({ kind: "refused", reason: "gateway-not-found" });

    expect(records.get("users/u1")).toEqual(user());
    expect(records.get("gateways/shared-0/assignments/u1")).toBeUndefined();
  });

  it("assigns onto a named shared gateway that is past users per gateway", async () => {
    const { deps, records } = fixture({
      "users/u1": user(),
      "gateways/shared-0/assignments/u2": assignment("shared-0", "u2", "bob"),
      "gateways/shared-0/assignments/u3": assignment("shared-0", "u3", "carol"),
    });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toMatchObject({ kind: "assigned", gatewayId: "shared-0" });

    expect(records.get("gateways/shared-0/assignments/u1")).toMatchObject({ uid: "u1", gatewayId: "shared-0", state: "serving" });
  });

  it("assigns onto a named shared gateway that has an incoming migration", async () => {
    const { deps } = fixture({
      "users/u1": user(),
      "glmOperations/migrate-1": {
        kind: "migrate-user", status: "running", createdBy: "operator:test", createdAt: 1, startedAt: 2, completedAt: null,
        input: { uid: "u9", toGatewayId: "shared-0" }, steps: [],
      },
    });

    await expect(commitOperatorPlacement(deps.store, placement)).resolves.toMatchObject({ kind: "placed" });
  });

  it("refuses a gateway that does not exist", async () => {
    const { deps } = fixture({ "users/u1": user() });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-7" })).resolves.toEqual({
      kind: "refused", uid: "u1", reason: "gateway-not-found", message: "gateway shared-7 does not exist",
    });
  });

  it("refuses a retired gateway", async () => {
    const { deps } = fixture({ "users/u1": user(), "gateways/shared-0": sharedRoot("shared-0", { desiredStatus: "retired" }) });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toEqual({
      kind: "refused", uid: "u1", reason: "gateway-retired", message: "gateway shared-0 is retired",
    });
  });

  it("refuses a parked gateway", async () => {
    const { deps, records } = fixture({ "users/u1": user(), "gateways/shared-0": sharedRoot("shared-0", { desiredStatus: "paused" }) });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toEqual({
      kind: "refused", uid: "u1", reason: "gateway-not-running", message: "gateway shared-0 is paused, not running",
    });
    expect(records.get("gateways/shared-0/assignments/u1")).toBeUndefined();
  });

  it("refuses another user's isolated gateway", async () => {
    const { deps, records } = fixture({
      "users/u1": user(),
      "gateways/iso-bob": sharedRoot("iso-bob", { gatewayClass: "isolated", profile: "isolated", imageProfile: "isolated", ownerUid: "u2", builderSlug: "bob" }),
      "glmGateways/iso-bob": servingRuntime("iso-bob"),
    });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "iso-bob" })).resolves.toEqual({
      kind: "refused", uid: "u1", reason: "gateway-not-shared", message: "gateway iso-bob is isolated; only shared gateways take an assignment",
    });
    expect(records.get("gateways/iso-bob/assignments/u1")).toBeUndefined();
    expect(records.get("users/u1")).toEqual(user());
  });

  it("refuses a user that still holds an assignment on another gateway", async () => {
    const { deps } = fixture({
      "users/u1": user({ gatewayId: "shared-9" }),
      "gateways/shared-9/assignments/u1": assignment("shared-9", "u1", "alice"),
    });

    await expect(commitOperatorPlacement(deps.store, placement)).resolves.toMatchObject({ kind: "refused", reason: "assigned-elsewhere" });
  });

  it("refuses a user under a restore fence", async () => {
    const { deps } = fixture({ "users/u1": user({ restoreFence: { operationId: "restore-1" } }) });

    await expect(commitOperatorPlacement(deps.store, placement)).resolves.toMatchObject({ kind: "refused", reason: "restore-in-progress" });
  });

  it("assigns onto a running gateway that is not serving yet, recording the placement", async () => {
    const { deps, records } = fixture({ "users/u1": user() });
    records.delete("glmGateways/shared-0");

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toMatchObject({ kind: "assigned", gatewayId: "shared-0" });

    expect(records.get("gateways/shared-0/assignments/u1")).toMatchObject({ uid: "u1", gatewayId: "shared-0", state: "serving" });
  });

  it("refuses a user the platform has not admitted", async () => {
    const { deps } = fixture({ "users/u1": { ...user(), onboardingStep: "profile" } });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toEqual({
      kind: "refused", uid: "u1", reason: "user-not-admitted", message: "user is not admitted",
    });
  });

  it("decides from the platform record alone, without the account or the entitlement resolver", async () => {
    const { deps } = fixture({ "users/u1": user() });
    const product = userEntitlements();
    installUserEntitlements(new Proxy({}, {
      get: (_target, method) => {
        throw new Error(`the operator placement read the entitlement resolver (${String(method)})`);
      },
    }) as UserEntitlementResolver);
    try {
      await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toMatchObject({ kind: "assigned", gatewayId: "shared-0" });
    } finally {
      installUserEntitlements(product);
    }
  });

  it("assigns a user held by the operator and leaves the hold in place", async () => {
    const { deps, records } = fixture({ "users/u1": user({ managedBy: "operator" }) });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toMatchObject({ kind: "assigned", gatewayId: "shared-0" });

    expect(records.get("users/u1")).toMatchObject({ provisioning: { openclaw: { managedBy: "operator", gatewayId: "shared-0" } } });
    expect(records.get("gateways/shared-0/assignments/u1")).toMatchObject({ uid: "u1", state: "serving" });
  });

  it.each([
    ["no mirror", {}],
    ["a mirror on a gateway that holds no assignment for them", { gatewayId: "shared-7" }],
  ])("refuses a user with %s who holds an assignment on another gateway", async (_case, openclaw) => {
    const { deps, records } = fixture({
      "users/u1": user(openclaw),
      "gateways/shared-9": sharedRoot("shared-9"),
      "gateways/shared-9/assignments/u1": assignment("shared-9", "u1", "alice"),
    });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toMatchObject({
      kind: "refused", reason: "assigned-elsewhere", message: expect.stringContaining("shared-9"),
    });
    expect(records.get("gateways/shared-0/assignments/u1")).toBeUndefined();
  });

  it("refuses a user whose migration fence is held, naming the operation", async () => {
    const { deps, records } = fixture({ "users/u1": user({ migration: { state: "moving", operationId: "migrate-7", startedAt: 1 } }) });

    await expect(assignOne(deps, "u1", { dryRun: false, gatewayId: "shared-0" })).resolves.toMatchObject({
      kind: "refused", reason: "migration-in-progress", message: expect.stringContaining("migrate-7"),
    });
    expect(records.get("gateways/shared-0/assignments/u1")).toBeUndefined();
  });
});
