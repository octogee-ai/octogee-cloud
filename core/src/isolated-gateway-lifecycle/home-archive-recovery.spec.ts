import { describe, expect, it, vi } from "vitest";
import type { PlatformStateRepositories } from "../platform-state/store.js";
import { assertFailedHomeRestoreReleased } from "./home-archive-recovery.js";

const identity = { ownerUid: "owner", targetGatewayId: "old-builder", leaseId: "original", generation: 3 };
const receipt = { kind: "activation-failed", gatewayId: "old-builder", leaseId: "original", generation: 3, operationId: "old-op" };
const failed = { id: "old-op", status: "failed", kind: "migrate-user", inputUid: "owner", input: { toGatewayId: "old-builder" } };

function fixture() {
  const getReceipt = vi.fn(async () => receipt);
  const getOperation = vi.fn(async () => failed);
  const listForUid = vi.fn(async () => []);
  const getAssignment = vi.fn(async () => null);
  const state = {
    users: { placementReceipts: { get: getReceipt } },
    journal: { operations: { get: getOperation, listForUid } },
    gateways: { assignments: { get: getAssignment } },
  } as unknown as PlatformStateRepositories;
  return { state, getReceipt, getOperation, listForUid, getAssignment };
}

describe("release a failed home restore generation", () => {
  it("requires the exact durable failed receipt and dispatched claim", async () => {
    const { state, getReceipt, getOperation } = fixture();
    await expect(assertFailedHomeRestoreReleased(state, identity)).resolves.toBeUndefined();
    expect(getReceipt).toHaveBeenCalledWith("owner", "original", 3, "activation-failed");
    expect(getOperation).toHaveBeenCalledWith("old-op");
  });

  it("refuses another dispatched activation or receipt generation", async () => {
    const { state, getOperation, getReceipt } = fixture();
    getOperation.mockResolvedValueOnce({ ...failed, status: "running" });
    await expect(assertFailedHomeRestoreReleased(state, identity)).rejects.toThrow(/claim/);
    getReceipt.mockResolvedValueOnce({ ...receipt, generation: 4 });
    await expect(assertFailedHomeRestoreReleased(state, identity)).rejects.toThrow(/receipt/);
  });
});
