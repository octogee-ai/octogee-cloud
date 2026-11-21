import type { PlatformStateRepositories, PlatformStateStore, UserHomeArchive } from "@octogee/core/platform-state";
import { isUserParkedVm, type RetainedUserHome } from "@octogee/shared/types/glm";
import type { GatewayVmClient } from "../lib/compute-vm.js";
import { assertVmRecoveryFence } from "../lib/vm-recovery-fence.js";
import type { OperationHandler, OperationResult } from "../operation-router.js";

interface ArchiveIdentity {
  ownerUid: string;
  gatewayId: string;
  instanceId: string;
  operationId: string;
  sizingProfile: string;
}

function archivePending(error: string): OperationResult {
  return { steps: [], success: false, retryAfterMs: 5_000, error };
}

async function readArchive(state: PlatformStateRepositories, identity: ArchiveIdentity) {
  const { ownerUid, gatewayId, operationId, instanceId, sizingProfile } = identity;
  const [owner, root] = await Promise.all([state.users.records.get(ownerUid), state.gateways.roots.get(gatewayId)]);
  const archive = owner?.home.homeArchive;
  const home = owner?.home.homeDisk as RetainedUserHome | undefined;
  const parked = owner?.home.computer;
  if (!owner || !archive || archive.operationId !== operationId || archive.instanceId !== instanceId ||
      archive.gatewayId !== gatewayId || root?.ownerUid !== ownerUid || root.sizingProfile !== sizingProfile ||
      root.desiredStatus !== "paused" || root.retirementClaim != null ||
      owner.home.homeStorage !== undefined || (owner.home.homeMigration !== undefined &&
        (owner.home.homeMigration.phase !== "complete" || owner.home.homeMigration.id !== undefined ||
          owner.home.homeMigration.source !== undefined || owner.home.homeMigration.target !== undefined ||
          owner.home.homeMigration.copy !== undefined)) ||
      owner.home.projectStorageNativeBoot === true || !home || !/^[1-9]\d{0,19}$/u.test(home.id)) {
    throw new Error("Home archive authority changed");
  }
  if (archive.phase === "archived") return { owner, archive, home, parked };
  if (!isUserParkedVm(parked) || parked.instanceId !== instanceId || parked.gatewayId !== gatewayId ||
      parked.zone !== home.zone || parked.vmSpec?.desktop !== "x11" || archive.phase === "restoring") {
    throw new Error("Home archive lost its exact parked VM");
  }
  await assertVmRecoveryFence(state, identity);
  return { owner, archive, home, parked };
}

export function createHomeArchiveHandler(deps: {
  store: PlatformStateStore; vm: GatewayVmClient; grant?: { ownerUid: string; sizingProfile: string };
}): OperationHandler {
  return async (operation, ctx) => {
    const { ownerUid, expectedGatewayId, expectedInstanceId, action } = operation.input;
    const grant = deps.grant;
    if (!grant || ownerUid !== grant.ownerUid || action !== "archive" || operation.origin !== "operator" ||
        operation.input.uid !== ownerUid || typeof expectedGatewayId !== "string" || typeof expectedInstanceId !== "string" ||
        !ctx.assertActiveClaim) throw new Error("Home archive requires an exact operator grant and operation claim");
    const identity = { ownerUid: grant.ownerUid, gatewayId: expectedGatewayId, instanceId: expectedInstanceId,
      operationId: operation.id, sizingProfile: grant.sizingProfile };
    const assertClaim = ctx.assertActiveClaim;
    const read = async () => { await assertClaim(); return readArchive(deps.store, identity); };
    const { vm, store } = deps;
    try {
      let { archive, parked, home } = await read();
      if (archive.phase === "archived") return { steps: [], success: true, output: { snapshot: archive.snapshot, zeroProvisionedDisks: true } };
      if (archive.phase === "restored" || !parked) throw new Error("Home archive is no longer operating on a parked VM");
      const { instanceName, zone } = parked;
      const snapshotName = `home-archive-${operation.id}`;
      const source = await vm.describe(instanceName, zone);
      if (source && (source.instanceId !== identity.instanceId || source.metadata["octogee-owner-uid"] !== identity.ownerUid)) {
        throw new Error("Home archive source VM identity changed");
      }
      if (archive.phase === "preparing") {
        if (!source) throw new Error("Home archive source VM is absent before snapshot-ready");
        if (source.status === "SUSPENDED") {
          await read();
          await vm.stop(instanceName, zone);
          return archivePending("Waiting for the exact source VM to stop");
        }
        const input = { home, ownerUid: identity.ownerUid, instanceName, instanceId: identity.instanceId, snapshotName };
        await read();
        const bootDisk = await vm.readArchiveBootDisk(input);
        const snapshot = await vm.snapshotStoppedHome(input);
        if (!snapshot) return archivePending("Waiting for the exact home snapshot to become ready");
        const ready: UserHomeArchive = { ...archive, phase: "snapshot-ready", snapshot, bootDisk };
        await assertClaim();
        await store.transaction({ label: "parked-home.snapshot-ready" }, async tx => {
          const current = await readArchive(tx, identity);
          if (current.archive.phase !== "preparing" || current.home.id !== home.id) throw new Error("Home archive source changed");
          await tx.users.records.patch(identity.ownerUid, { home: { homeArchive: ready } }, { revision: current.owner.revision });
        });
        archive = ready;
      }
      if (archive.phase !== "snapshot-ready") throw new Error("Home archive has an invalid deletion phase");
      const { snapshot, bootDisk } = archive;
      if (snapshot.sourceDisk !== home.source || snapshot.sourceDiskId !== home.id) throw new Error("Home archive snapshot does not cover the current home");
      await vm.verifyHomeSnapshot(snapshot, identity.ownerUid);
      await read();
      if (source) {
        const actualBoot = await vm.readArchiveBootDisk({ home, ownerUid: identity.ownerUid, instanceName,
          instanceId: identity.instanceId, snapshotName });
        if (actualBoot.id !== bootDisk.id || actualBoot.source !== bootDisk.source) throw new Error("Home archive boot disk identity changed");
        await read();
        await vm.deleteRetainingHome(instanceName, zone, identity.ownerUid, home, identity.instanceId);
      }
      if (await vm.describe(instanceName, zone)) return archivePending("Waiting for the archived VM to disappear");
      await read();
      await vm.deleteRetainedHome(home, identity.ownerUid);
      if (!await vm.archiveDisksAbsent(home, bootDisk)) return archivePending("Waiting for the archived provisioned disks to disappear");
      await assertClaim();
      await store.transaction({ label: "parked-home.archived" }, async tx => {
        const current = await readArchive(tx, identity);
        const runtime = await tx.fleetRegistry.get(identity.gatewayId);
        if (current.archive.phase !== "snapshot-ready" || current.archive.snapshot.id !== snapshot.id ||
            runtime?.vm && runtime.vm.instanceId !== identity.instanceId) throw new Error("Home archive custody changed before publication");
        if (runtime) await tx.fleetRegistry.patch(identity.gatewayId, { vm: null, vmInstance: { clear: true }, vmHome: { clear: true } });
        await tx.users.records.patch(identity.ownerUid, {
          home: { computer: { clear: true }, homeArchive: { ...current.archive, phase: "archived" } },
        }, { revision: current.owner.revision });
        await tx.users.records.setFence(identity.ownerUid, "computerRecovery", { clear: true }, current.owner.fences.computerRecovery);
      });
      return { steps: [], success: true, output: { snapshot, zeroProvisionedDisks: true } };
    } catch (error) {
      return archivePending(error instanceof Error ? error.message : String(error));
    }
  };
}
