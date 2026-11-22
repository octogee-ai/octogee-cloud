import { describe, expect, it, vi } from "vitest";
import { assertHeldNativeReturnRepairClaim } from "@octogee/core/fleet-state";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { createHeldNativeSourceHoldReader } from "./held-native-source-reconcile.js";

vi.mock("@octogee/core/fleet-state", () => ({ assertHeldNativeReturnRepairClaim: vi.fn() }));

const scope = {
  operationId: "fixture-operation", uid: "fixture-owner", slug: "owner", sourceGatewayId: "fixture-vm",
  targetGatewayId: "fixture-shared", sourceEpoch: 10, schedulerMigrationId: "scheduler", requestId: "b".repeat(64),
};
const source = { vmId: "501", bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", bootDiskId: "502", homeDiskId: "503" };
const sourceEmail = "source@example.test";
const hold = { scope, source, generation: "a".repeat(64), heldSince: 4, stores: [{ storeId: "native", databaseIdentity: "fixture-pg" }] };

function fixture() {
  vi.mocked(assertHeldNativeReturnRepairClaim).mockReset().mockResolvedValue(undefined);
  const descriptor = {
    name: "fixture", zone: "fixture-zone", machineType: "fixture", status: "RUNNING", instanceId: source.vmId,
    internalIp: "10.1.2.3", provisioningModel: null, gatewayId: scope.sourceGatewayId, labels: {},
    metadata: { "octogee-owner-uid": scope.uid }, lastStartedAt: 2,
    serviceAccounts: [{ email: sourceEmail, scopes: [] }],
  };
  const store = {
    journal: { operations: { get: vi.fn().mockResolvedValue({ status: "running", startedAt: 3 }) } },
    fleetRegistry: { get: vi.fn().mockResolvedValue({ runtime: "gce-vm", vm: { ...descriptor, instanceName: descriptor.name } }) },
    users: { records: { get: vi.fn().mockResolvedValue({ home: { homeDisk: { id: source.homeDiskId } } }) } },
  } as unknown as PlatformStateStore;
  const vm = {
    describe: vi.fn().mockResolvedValue(descriptor),
    readAttachedGuestDisks: vi.fn().mockResolvedValue({ bootDiskId: source.bootDiskId, homeDiskId: source.homeDiskId }),
  };
  const request = vi.fn().mockResolvedValue(hold);
  const readHold = createHeldNativeSourceHoldReader({ store, vm, request, privateKey: "fixture-key", port: "3003", projectId: "project" });
  return { readHold, vm, request, descriptor, expected: { ...source, serviceAccountEmail: sourceEmail } };
}

describe("TEST held source reader composition", () => {
  it("uses the exact provider identity and authoritative started claim for each signed phase", async () => {
    const { readHold, expected, request } = fixture();
    await expect(readHold(scope, expected, "acquire")).resolves.toEqual(hold);
    await expect(readHold(scope, expected, "read")).resolves.toEqual(hold);
    expect(request.mock.calls.map(([input]) => input.action)).toEqual(["acquire", "read"]);
    expect(request).toHaveBeenLastCalledWith({
      action: "read", privateKey: "fixture-key", sourceUrl: "http://10.1.2.3:3003",
      claim: {
        operationId: scope.operationId, uid: scope.uid, slug: scope.slug, gatewayId: scope.sourceGatewayId,
        targetGatewayId: scope.targetGatewayId, schedulerMigrationId: scope.schedulerMigrationId, requestId: scope.requestId,
        sourceEpoch: scope.sourceEpoch, ...source, claimStartedAt: 3,
      },
      gce: { projectId: "project", instanceName: "fixture", zone: "fixture-zone", serviceAccountEmail: sourceEmail },
    });
  });

  it("refuses before exchange on a changed service account and after exchange on source restart or revoked claim", async () => {
    const { readHold, expected, request, descriptor, vm } = fixture();
    await expect(readHold(scope, { ...expected, serviceAccountEmail: "other@example.test" }, "read")).rejects.toThrow("service account");
    expect(request).not.toHaveBeenCalled();
    vm.describe.mockResolvedValueOnce(descriptor).mockResolvedValueOnce({ ...descriptor, lastStartedAt: 9 });
    await expect(readHold(scope, expected, "read")).rejects.toThrow("binding changed");
    const current = vi.mocked(assertHeldNativeReturnRepairClaim);
    current.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("revoked claim"));
    await expect(readHold(scope, expected, "read")).rejects.toThrow("revoked claim");
  });
});
