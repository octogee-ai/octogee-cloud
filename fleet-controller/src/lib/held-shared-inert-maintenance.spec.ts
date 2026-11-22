import type { SharedHeldReturnMaintenanceClaim, SharedInertMaintenancePriorProof } from "@octogee/core/fleet-state";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { expect, it, vi } from "vitest";
import { createHeldSharedInertMaintenance } from "./held-shared-inert-maintenance.js";

const seam = vi.hoisted(() => ({ readPrior: vi.fn(), reserve: vi.fn(), authorize: vi.fn(), holdImages: vi.fn() }));
vi.mock("@octogee/core/fleet-state", () => ({
  assertSharedInertPreLaunch: seam.readPrior,
  authorizeSharedInertMaintenance: seam.reserve,
  authorizeSharedInertStockLaunch: seam.authorize,
}));
vi.mock("./held-shared-maintenance-images.js", () => ({ holdSharedMaintenanceImages: seam.holdImages }));

it("verifies retained installation identity before each inert image action and leaves stock publication separate", async () => {
  const active = [] as string[];
  const prior = { artifactSetId: "a".repeat(64) } as SharedInertMaintenancePriorProof;
  const claim = { gatewayId: "fixture-shared", plan: { workload: { podUid: "fixture-pod" } } } as SharedHeldReturnMaintenanceClaim;
  const readVerifiedCommon = vi.fn();
  const publishReady = vi.fn();
  const store = {} as PlatformStateStore;
  const provider = createHeldSharedInertMaintenance({
    store, now: () => 10, transport: { environment: "test", namespace: "synthetic-test", chart: "fixture", runHelm: vi.fn(), runKubectl: vi.fn() },
    verifyPriorRestoreAndIsolation: vi.fn(),
    async verifyInstallIdentity(identity, captured, assertCurrent) {
      expect(identity).toBe(claim);
      expect(captured).toBe(prior);
      await assertCurrent();
      active.push("physical");
    },
    verifyHeldCommonRestore: readVerifiedCommon,
  });
  seam.readPrior.mockRejectedValueOnce(new Error("no reserved inert authority"));
  await expect(provider.installInert(claim)).rejects.toThrow("no reserved inert authority");
  expect(seam.holdImages).not.toHaveBeenCalled();
  seam.readPrior.mockResolvedValue(prior);
  seam.holdImages.mockImplementation(async ({ assertCurrent }) => {
    await assertCurrent();
    active.push("image");
    return { publishReady };
  });
  await provider.installInert(claim);
  expect(active).toEqual(["physical", "image", "physical"]);
  expect(seam.holdImages).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ gatewayId: claim.gatewayId }), "install");
  expect(readVerifiedCommon).not.toHaveBeenCalled();
  expect(publishReady).not.toHaveBeenCalled();
});
