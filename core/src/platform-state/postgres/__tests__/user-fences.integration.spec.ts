import { describe, expect, it } from "vitest";
import { FenceMismatchError, MissingRecordError } from "../../errors.js";
import { lease, NOW, useUserFixture } from "./fixtures/users.js";
import { dsn } from "./fixtures/harness.js";

const MISSING_USER = { constructor: MissingRecordError, record: { aggregate: "builder", key: "nobody" } };

describe.skipIf(!dsn)("PostgreSQL user records: record fences", () => {
  const fixture = useUserFixture();

  it("fences patches on the revision of the last read", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const before = (await records.get("alice"))!;
    await records.patch("alice", { workspaceId: "alice" }, { revision: before.revision });
    const after = (await records.get("alice"))!;

    await expect(records.patch("alice", { workspaceId: "stale" }, { revision: before.revision })).rejects.toMatchObject({
      constructor: FenceMismatchError, fence: "revision", expected: before.revision, actual: after.revision,
    });
    expect((await records.get("alice"))!.workspaceId).toBe("alice");
    await expect(records.patch("nobody", { workspaceId: "x" }, { revision: before.revision })).rejects.toMatchObject(MISSING_USER);
  });

  it("moves the gateway mirror only from the expected gateway and clears all four mirror fields together", async () => {
    const { records, assign, place } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await records.patch("alice", { openclaw: { status: "complete" } });
    await place("alice", "g1");
    await records.setGatewayMirror("alice", { gatewayId: "g1", gatewayAssignedAt: NOW, gatewayProfile: "isolated", controlUiEnabled: true });
    await assign("g2", "alice");

    await records.setGatewayMirror("alice", { gatewayId: "g2", gatewayProfile: "standard", controlUiEnabled: false }, { gatewayId: "g1" });
    expect((await records.get("alice"))!.gateway).toEqual({ gatewayId: "g2", gatewayAssignedAt: NOW, gatewayProfile: "standard", controlUiEnabled: false });

    await expect(records.setGatewayMirror("alice", { gatewayId: "g1" }, { gatewayId: "g1" })).rejects.toMatchObject({
      constructor: FenceMismatchError, fence: "present", expected: { gatewayId: "g1" }, actual: { gatewayId: "g2" },
    });
    await expect(records.setGatewayMirror("alice", { gatewayId: "g1" }, { gatewayId: null })).rejects.toMatchObject({
      fence: "absent", expected: { gatewayId: null }, actual: { gatewayId: "g2" },
    });

    await records.setGatewayMirror("alice", { clear: true }, { gatewayId: "g2" });
    expect(await records.get("alice")).toMatchObject({ gateway: null, openclaw: { status: "complete" } });
    const before = Date.now();
    await records.setGatewayMirror("alice", { gatewayId: "g1", gatewayAssignedAt: { serverNow: true } }, { gatewayId: null });
    expect((await records.get("alice"))!.gateway!.gatewayAssignedAt).toBeGreaterThanOrEqual(before - 5_000);
  });

  it("refuses a gateway mirror without a matching assignment at commit", async () => {
    const { records, gateway } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await gateway("g1");

    await expect(records.setGatewayMirror("alice", { gatewayId: "g1" })).rejects.toMatchObject({ code: "23514" });
    expect((await records.get("alice"))!.gateway).toBeNull();
  });

  it("refuses unknown gateway mirror fields", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await expect(records.setGatewayMirror("alice", { gatewayId: "g1", slug: "alice" } as never)).rejects.toThrow(TypeError);
  });

  it("fences on an absent or exact provisioning status", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await records.patch("alice", { provisioning: { status: "in_progress" } });

    await expect(records.patch("alice", { workspaceId: "x" }, { provisioningStatus: "absent" })).rejects.toMatchObject({
      constructor: FenceMismatchError, fence: "absent", expected: { provisioningStatus: null }, actual: { provisioningStatus: "in_progress" },
    });
    await expect(records.patch("alice", { workspaceId: "x" }, { provisioningStatus: "complete" })).rejects.toMatchObject({
      fence: "status", expected: "complete", actual: "in_progress",
    });
    await records.patch("alice", { provisioning: { status: "complete" } }, { provisioningStatus: "in_progress" });
    expect((await records.get("alice"))!.provisioning).toEqual({ status: "complete" });

    await records.create({ uid: "fresh", createdAt: NOW });
    await records.patch("fresh", { workspaceId: "fresh" }, { provisioningStatus: "absent", gatewayId: null });
    await expect(records.patch("fresh", { workspaceId: "x" }, { provisioningStatus: "complete" })).rejects.toMatchObject({
      fence: "status", expected: "complete", actual: null,
    });
  });
});

describe.skipIf(!dsn)("PostgreSQL user records: activation lease", () => {
  const fixture = useUserFixture();

  it("replaces the activation lease only while its leaseId and generation are the ones the caller read", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });

    await records.setActivationLease("alice", lease(), { leaseId: null, generation: null });
    expect((await records.get("alice"))!.activationLease).toEqual(lease());

    await expect(records.setActivationLease("alice", lease({ leaseId: "lease-x" }), { leaseId: null, generation: null })).rejects.toMatchObject({
      constructor: FenceMismatchError, fence: "leaseId", expected: null, actual: "lease-1",
    });
    await expect(records.setActivationLease("alice", lease({ generation: 2 }), { leaseId: "lease-1", generation: 2 })).rejects.toMatchObject({
      fence: "generation", expected: 2, actual: 1,
    });
    await expect(
      records.setActivationLease("alice", lease({ status: "active" }), { leaseId: "lease-1", generation: 1, status: ["active"] }),
    ).rejects.toMatchObject({ fence: "status", expected: ["active"], actual: "requested" });

    const next = lease({ leaseId: "lease-2", generation: 2, status: "provisioning", targetGatewayId: "alice-s-2" });
    await records.setActivationLease("alice", next, { leaseId: "lease-1", generation: 1, status: ["requested"] });
    expect((await records.get("alice"))!.activationLease).toEqual(next);

    await records.setActivationLease("alice", { clear: true }, { leaseId: "lease-2", generation: 2 });
    expect((await records.get("alice"))!.activationLease).toBeNull();
    await expect(records.setActivationLease("nobody", lease(), { leaseId: null, generation: null })).rejects.toMatchObject(MISSING_USER);
  });

  it("patches activation lease keys under the lease and status fence", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    await records.setActivationLease("alice", lease({ returnRequestedAt: NOW }), { leaseId: null, generation: null });
    const fence = { leaseId: "lease-1", generation: 1 };

    await expect(records.patchActivationLease("alice", { lastActiveAt: NOW + 5 }, { ...fence, status: ["active"] })).rejects.toMatchObject({
      constructor: FenceMismatchError, fence: "status", expected: ["active"], actual: "requested",
    });
    const before = Date.now();
    await records.patchActivationLease(
      "alice",
      { status: "returning", returnRequestedBy: "operator:chris", returnRequestedAt: { clear: true }, lastActiveAt: NOW + 5, returnedAt: { serverNow: true } },
      { ...fence, status: ["requested", "active"] },
    );
    const patched = (await records.get("alice"))!.activationLease!;
    expect(patched).toEqual({
      ...lease({ status: "returning", lastActiveAt: NOW + 5 }),
      returnRequestedBy: "operator:chris",
      returnedAt: expect.any(Number),
    });
    expect(patched.returnedAt).toBeGreaterThanOrEqual(before - 5_000);

    await expect(records.patchActivationLease("alice", { leaseId: "lease-9" } as never, fence)).rejects.toThrow(TypeError);
    await records.setActivationLease("alice", { clear: true }, fence);
    await expect(records.patchActivationLease("alice", { lastActiveAt: NOW }, { leaseId: null, generation: null })).rejects.toMatchObject({
      constructor: FenceMismatchError, fence: "present", expected: { activationLease: "present" }, actual: { activationLease: null },
    });
    await expect(records.patchActivationLease("alice", { lastActiveAt: NOW }, fence)).rejects.toMatchObject({
      fence: "leaseId", expected: "lease-1", actual: null,
    });
    expect((await records.get("alice"))!.activationLease).toBeNull();
    await expect(records.patchActivationLease("nobody", { lastActiveAt: NOW }, fence)).rejects.toMatchObject(MISSING_USER);
  });
});

describe.skipIf(!dsn)("PostgreSQL user records: value fences", () => {
  const fixture = useUserFixture();

  it("sets a fence only when it is absent and clears it only while it still holds the expected value", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const intent = { operationId: "op-restore", gatewayId: "shared-a", requestedAt: NOW };

    await records.setFence("alice", "restoreFence", intent, "absent");
    await expect(records.setFence("alice", "restoreFence", { operationId: "op-other" }, "absent")).rejects.toMatchObject({
      constructor: FenceMismatchError, fence: "absent", expected: { restoreFence: null }, actual: { restoreFence: intent },
    });
    await expect(records.setFence("alice", "restoreFence", { clear: true }, { ...intent, operationId: "op-stale" })).rejects.toMatchObject({
      fence: "present", expected: { restoreFence: { ...intent, operationId: "op-stale" } }, actual: { restoreFence: intent },
    });
    expect((await records.get("alice"))!.fences.restoreFence).toEqual(intent);

    await records.setFence("alice", "restoreFence", { clear: true }, { requestedAt: NOW, gatewayId: "shared-a", operationId: "op-restore" });
    expect((await records.get("alice"))!.fences).toEqual({});
    await expect(records.setFence("alice", "restoreFence", { clear: true }, intent)).rejects.toMatchObject({
      fence: "present", expected: { restoreFence: intent }, actual: { restoreFence: null },
    });
  });

  it("indexes the transfer and recovery fences it sets and clears them without an expected value", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const transfer = { operationId: "op-move", sourceGatewayId: "alice-s-1", targetGatewayId: "shared-a" };

    await records.setFence("alice", "sourceTransferFence", transfer, "absent");
    await records.setFence("alice", "computerRecovery", { operationId: "op-recover", gatewayId: "alice-s-1" }, "absent");
    const holders = await records.listGatewayFenceHolders("alice-s-1");
    expect(holders.sourceTransferSource.map((record) => record.uid)).toEqual(["alice"]);
    expect(holders.computerRecovery.map((record) => record.uid)).toEqual(["alice"]);

    await records.setFence("alice", "sourceTransferFence", { clear: true }, transfer);
    await records.setFence("alice", "computerRecovery", { clear: true });
    expect(await records.listGatewayFenceHolders("alice-s-1")).toEqual({
      assigned: [], sourceTransferSource: [], sourceTransferTarget: [], computerRecovery: [],
    });
  });

  it("compares a fence holding server time against the millis it was read as", async () => {
    const { records } = fixture();
    await records.create({ uid: "alice", createdAt: NOW });
    const reset = {
      status: "pending" as const, uid: "alice", slug: "alice", operationId: "op-reset", sourceGatewayId: "alice-s-1",
      targetGatewayId: "shared-a", generation: 2, disposableLeaseId: "lease-1", disposableLeaseGeneration: 1, requestedAt: NOW,
    };
    await records.setFence("alice", "runtimeReset", reset, "absent");
    await records.setFence("alice", "runtimeReset", { ...reset, acknowledgedAt: { serverNow: true } }, reset);

    const current = (await records.get("alice"))!.fences.runtimeReset!;
    expect(current).toEqual({ ...reset, acknowledgedAt: expect.any(Number) });
    await records.setFence("alice", "runtimeReset", { clear: true }, current);
    expect((await records.get("alice"))!.fences).toEqual({});
  });

  it("refuses a fence write for a missing user with or without an expected value", async () => {
    const { records } = fixture();
    await expect(records.setFence("nobody", "restoreFence", { operationId: "op" })).rejects.toMatchObject(MISSING_USER);
    await expect(records.setFence("nobody", "restoreFence", { operationId: "op" }, "absent")).rejects.toMatchObject(MISSING_USER);
    await expect(records.setFence("nobody", "lastError" as never, { operationId: "op" } as never)).rejects.toThrow(TypeError);
  });
});
