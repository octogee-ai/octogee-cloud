import { describe, expect, it, vi } from "vitest";
import type { HeldNativeSourceClaim } from "@octogee/shared/types/fleet-controller";
import { createHeldNativeSourceAcquisition } from "../lib/held-native-source-acquisition.js";
import { acquireHeldNativeSourceKeeper } from "../lib/held-native-source-keeper.js";

vi.mock("../lib/held-native-source-keeper.js", () => ({ acquireHeldNativeSourceKeeper: vi.fn() }));

const source = { vmId: "501", bootId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", bootDiskId: "502", homeDiskId: "503" };
const oldClaim: HeldNativeSourceClaim = {
  ...source, uid: "fixture-owner", slug: "owner", gatewayId: "isolated", targetGatewayId: "shared", sourceEpoch: 10,
  operationId: "operation", schedulerMigrationId: "migration", requestId: "a".repeat(64), claimStartedAt: 20,
};
const newClaim = { ...oldClaim, claimStartedAt: 40 };

function fixture() {
  const close = vi.fn().mockResolvedValue({ maintenanceAttempted: true });
  const oldKeeper = { assertHeld: vi.fn().mockResolvedValue(undefined), runExclusive: vi.fn(), close };
  const newKeeper = { ...oldKeeper, close: vi.fn().mockResolvedValue({ maintenanceAttempted: false }) };
  vi.mocked(acquireHeldNativeSourceKeeper).mockReset().mockResolvedValueOnce(oldKeeper).mockResolvedValueOnce(newKeeper);
  let current = oldClaim;
  const assertWorkerClaim = vi.fn(async (claim: HeldNativeSourceClaim) => {
    if (claim !== current) throw new Error("broker revoked claim");
  });
  const host = {
    heldSince: 30, homeDirectory: "/synthetic/home", stores: [{ storeId: "workspace", databaseIdentity: "fixture-pg" }],
    readSourceBacking: vi.fn().mockResolvedValue(source), assertOrdinaryWritersExcluded: vi.fn(), assertOwnerStoreWritesHeld: vi.fn(),
  };
  const acquireHostHold = vi.fn().mockResolvedValue(host);
  const recoverInterruptedHold = vi.fn().mockResolvedValue({ ...host, heldSince: 45 });
  const acquisition = createHeldNativeSourceAcquisition({ assertWorkerClaim, acquireHostHold, recoverInterruptedHold, now: () => 50 });
  return { acquisition, close, acquireHostHold, recoverInterruptedHold, setClaim: (next: HeldNativeSourceClaim) => { current = next; } };
}

describe("interrupted held Native acquisition", () => {
  it("requires recovery of a potentially written attempt and rotates the generation under the new exact claim", async () => {
    const { acquisition, close, acquireHostHold, recoverInterruptedHold, setClaim } = fixture();
    const first = await acquisition.acquire(oldClaim);
    await expect(acquisition.acquire(oldClaim)).resolves.toEqual(first);
    await expect(acquisition.read(newClaim)).rejects.toThrow("no exact acquired claim");
    setClaim(newClaim);
    recoverInterruptedHold.mockRejectedValueOnce(new Error("protected originals are not restored"));
    await expect(acquisition.acquire(newClaim)).rejects.toThrow("not restored");
    expect(acquisition.getHeldSourceKeeper()).toBeUndefined();
    await expect(acquisition.read(oldClaim)).rejects.toThrow("no exact acquired claim");
    const next = await acquisition.acquire(newClaim);
    expect(next.generation).not.toBe(first.generation);
    expect(close).toHaveBeenCalledTimes(1);
    expect(acquireHostHold).toHaveBeenCalledTimes(1);
    expect(recoverInterruptedHold).toHaveBeenLastCalledWith(
      { ...newClaim, holdGeneration: next.generation },
      { binding: { ...oldClaim, holdGeneration: first.generation }, maintenanceAttempted: true },
    );
    await expect(acquisition.read(newClaim)).resolves.toEqual(next);
  });

  it("refuses a different scope or an old keeper that still owns an active write", async () => {
    const { acquisition, close, recoverInterruptedHold, setClaim } = fixture();
    await acquisition.acquire(oldClaim);
    const wrong = { ...newClaim, targetGatewayId: "foreign" };
    setClaim(wrong);
    await expect(acquisition.acquire(wrong)).rejects.toThrow("no authorized replacement");
    expect(close).not.toHaveBeenCalled();
    setClaim(newClaim);
    close.mockRejectedValueOnce(new Error("keeper cannot release during maintenance"));
    await expect(acquisition.acquire(newClaim)).rejects.toThrow("during maintenance");
    expect(recoverInterruptedHold).not.toHaveBeenCalled();
  });
});
