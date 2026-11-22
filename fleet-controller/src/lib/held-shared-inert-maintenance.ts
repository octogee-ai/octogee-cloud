import {
  assertSharedInertPreLaunch, authorizeSharedInertMaintenance, authorizeSharedInertStockLaunch,
  type SharedHeldReturnMaintenanceClaim, type SharedInertMaintenanceCommonProof, type SharedInertMaintenancePriorProof,
} from "@octogee/core/fleet-state";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { holdSharedMaintenanceImages } from "./held-shared-maintenance-images.js";

type ImageTransport = Parameters<typeof holdSharedMaintenanceImages>[0];

export function createHeldSharedInertMaintenance(input: {
  store: PlatformStateStore;
  transport: Omit<ImageTransport, "assertCurrent">;
  now: () => number;
  verifyPriorRestoreAndIsolation(claim: SharedHeldReturnMaintenanceClaim, assertCurrent: () => Promise<void>): Promise<SharedInertMaintenancePriorProof>;
  verifyInstallIdentity(claim: SharedHeldReturnMaintenanceClaim, prior: SharedInertMaintenancePriorProof,
    assertCurrent: () => Promise<void>): Promise<void>;
  verifyHeldCommonRestore(claim: SharedHeldReturnMaintenanceClaim, assertCurrent: () => Promise<void>): Promise<SharedInertMaintenanceCommonProof>;
}) {
  return {
    async reserveInert(claim: SharedHeldReturnMaintenanceClaim) {
      await authorizeSharedInertMaintenance(input.store, claim,
        current => input.verifyPriorRestoreAndIsolation(claim, current), input.now);
    },
    async installInert(claim: SharedHeldReturnMaintenanceClaim) {
      const prior = await assertSharedInertPreLaunch(input.store, claim);
      const assertCurrent = async () => { await assertSharedInertPreLaunch(input.store, claim); };
      const assertPhysical = async () => {
        await assertCurrent();
        await input.verifyInstallIdentity(claim, prior, assertCurrent);
        await assertCurrent();
      };
      await holdSharedMaintenanceImages({ ...input.transport, assertCurrent: assertPhysical },
        { gatewayId: claim.gatewayId, ...claim.plan }, "install");
      await assertPhysical();
    },
    async authorizeStock(claim: SharedHeldReturnMaintenanceClaim) {
      await authorizeSharedInertStockLaunch(input.store, claim,
        current => input.verifyHeldCommonRestore(claim, current), input.now);
    },
  };
}
