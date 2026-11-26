import { archivedSchedulerSourceImage, archiveSchedulerCustodyMatches, isAuthorizedHomeArchiveOrigin, readParkedHomeArchiveGrant, simpleHomePreparation } from "@octogee/core/admin-fleet-router";
import type { FleetRegistryRecord, PlatformStateRepositories, PlatformStateStore, PlatformUserRecord, UserHomeArchive } from "@octogee/core/platform-state";
import { isUserParkedVm, type RetainedUserHome } from "@octogee/shared/types/glm";
import type { GatewayVmClient, GatewayVmDescription } from "../lib/compute-vm.js";
import { assertVmRecoveryFence } from "../lib/vm-recovery-fence.js";
import type { OperationContext, OperationHandler, OperationResult } from "../operation-router.js";

interface ArchiveIdentity {
  ownerUid: string;
  gatewayId: string;
  instanceId: string;
  operationId: string;
  sizingProfile: string;
}

function archivePending(error: string): OperationResult {
  return { steps: [], success: false, waitingForHomeArchiveProvider: true, error };
}

function archiveOwnerStorageCompatible(owner: NonNullable<Awaited<ReturnType<PlatformStateRepositories["users"]["records"]["get"]>>>): boolean {
  return owner.home.homeStorage === undefined && simpleHomePreparation(owner.home.homeMigration);
}

function archiveRootMatches(root: Awaited<ReturnType<PlatformStateRepositories["gateways"]["roots"]["get"]>>, identity: ArchiveIdentity): boolean {
  return root?.ownerUid === identity.ownerUid && root.gatewayClass === "isolated" && root.sizingProfile === identity.sizingProfile &&
    root.desiredStatus === "paused" && root.retirementClaim == null;
}

function archiveRecordMatches(archive: UserHomeArchive | undefined, identity: ArchiveIdentity): archive is UserHomeArchive {
  return archive !== undefined && archive.operationId === identity.operationId &&
    archive.instanceId === identity.instanceId && archive.gatewayId === identity.gatewayId;
}

function exactArchiveParkedVm(parked: unknown, identity: ArchiveIdentity, zone: string) {
  return isUserParkedVm(parked) && parked.instanceId === identity.instanceId && parked.gatewayId === identity.gatewayId &&
    parked.zone === zone && parked.vmSpec?.desktop === "x11" ? parked : null;
}

function verifyArchiveSource(input: { owner: PlatformUserRecord; archive: UserHomeArchive;
  runtime: FleetRegistryRecord | null; home: RetainedUserHome; identity: ArchiveIdentity }) {
  const { archive, home, runtime, identity, owner } = input;
  const source = archive.source;
  if (!source) return exactArchiveParkedVm(owner.home.computer, identity, home.zone);
  if (source.zone !== home.zone || source.homeDiskId !== home.id) return null;
  const observed = runtime?.vm;
  if (!observed) return archive.phase === "snapshot-ready" || !archive.nativeSchedulerRetirement ? source : null;
  return observed.instanceId === identity.instanceId && observed.instanceName === source.instanceName &&
    observed.zone === source.zone && ["SUSPENDED", "STOPPING", "TERMINATED", "STOPPED"].includes(observed.status ?? "") ? source : null;
}

async function readArchive(state: PlatformStateRepositories, identity: ArchiveIdentity) {
  const { ownerUid, gatewayId } = identity;
  const [owner, root, runtime] = await Promise.all([
    state.users.records.get(ownerUid), state.gateways.roots.get(gatewayId), state.fleetRegistry.get(gatewayId),
  ]);
  const archive = owner?.home.homeArchive;
  const home = owner?.home.homeDisk as RetainedUserHome | undefined;
  const parked = owner?.home.computer;
  if (!owner || !archiveRecordMatches(archive, identity) || !archiveRootMatches(root, identity) ||
      !archiveOwnerStorageCompatible(owner) || !archiveSchedulerCustodyMatches(owner, archive) || !home || !/^[1-9]\d{0,19}$/u.test(home.id)) {
    throw new Error("Home archive authority changed");
  }
  if (archive.phase === "archived") return { owner, archive, home, parked };
  const exactParked = verifyArchiveSource({ owner, archive, runtime, home, identity });
  if (!exactParked || archive.phase === "restoring") throw new Error("Home archive lost its exact parked VM");
  await assertVmRecoveryFence(state, identity);
  return { owner, archive, home, parked: exactParked };
}

type ArchiveClaim = NonNullable<OperationContext["assertActiveClaim"]>;
type ArchiveObservation = () => Promise<Awaited<ReturnType<typeof readArchive>>>;
interface ArchiveSource {
  archive: UserHomeArchive;
  home: RetainedUserHome;
  source: GatewayVmDescription | null;
  instanceName: string;
  zone: string;
  snapshotName: string;
}

async function prepareSnapshot(deps: { store: PlatformStateStore; vm: GatewayVmClient }, identity: ArchiveIdentity,
  assertClaim: ArchiveClaim, read: ArchiveObservation, observation: ArchiveSource): Promise<UserHomeArchive | null> {
  const { vm, store } = deps;
  const { archive, home, source, instanceName, zone, snapshotName } = observation;
  if (archive.phase !== "preparing") return archive;
  if (!source) throw new Error("Home archive source VM is absent before snapshot-ready");
  if (source.status === "STOPPING") return null;
  if (source.status === "SUSPENDED") {
    await read();
    await vm.stop(instanceName, zone);
    return null;
  }
  const input = { home, ownerUid: identity.ownerUid, instanceName, instanceId: identity.instanceId, snapshotName };
  await read();
  const bootDisk = await vm.readArchiveBootDisk(input);
  const snapshot = await vm.snapshotStoppedHome(input);
  if (!snapshot) return null;
  const ready: UserHomeArchive = { ...archive, phase: "snapshot-ready", snapshot, bootDisk };
  await assertClaim();
  await store.transaction({ label: "parked-home.snapshot-ready" }, async tx => {
    const current = await readArchive(tx, identity);
    if (current.archive.phase !== "preparing" || current.home.id !== home.id) throw new Error("Home archive source changed");
    await tx.users.records.patch(identity.ownerUid, { home: { homeArchive: ready } }, { revision: current.owner.revision });
  });
  return ready;
}

async function disposeParkedHome(deps: { store: PlatformStateStore; vm: GatewayVmClient }, identity: ArchiveIdentity,
  assertClaim: ArchiveClaim, read: ArchiveObservation, observation: ArchiveSource): Promise<OperationResult> {
  const { vm, store } = deps;
  const { archive, home, source, instanceName, zone, snapshotName } = observation;
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
}

async function requireArchiveOperation(store: PlatformStateStore, operation: Parameters<OperationHandler>[0], ctx: OperationContext,
  operatorGrant: { ownerUid: string; sizingProfile: string } | undefined) {
  const { ownerUid, expectedGatewayId, expectedInstanceId, action } = operation.input;
  const refuse = (): never => { throw new Error("Home archive requires an exact archive grant and operation claim"); };
  if (typeof ownerUid !== "string" || action !== "archive" || !isAuthorizedHomeArchiveOrigin(operation) ||
      operation.input.uid !== ownerUid || typeof expectedGatewayId !== "string" || typeof expectedInstanceId !== "string" ||
      !ctx.assertActiveClaim) return refuse();
  const grant = await readParkedHomeArchiveGrant(store, { ownerUid, gatewayId: expectedGatewayId }, operatorGrant);
  if (!grant) return refuse();
  const identity = { ownerUid: grant.ownerUid, gatewayId: expectedGatewayId, instanceId: expectedInstanceId,
    operationId: operation.id, sizingProfile: grant.sizingProfile };
  return { identity, assertClaim: ctx.assertActiveClaim };
}

async function verifyReplacementImage(vm: GatewayVmClient, identity: ArchiveIdentity, owner: PlatformUserRecord,
  archive: UserHomeArchive, source: GatewayVmDescription): Promise<void> {
  if (!archive.nativeSchedulerRetirement) return;
  const expected = archivedSchedulerSourceImage(owner, identity.gatewayId, identity.instanceId, archive.nativeSchedulerRetirement);
  if (!expected) return;
  const [boot, admitted] = await Promise.all([vm.readBootImage(source.name, source.zone), vm.readImage(expected.name, expected.project)]);
  if (boot.id !== expected.id || boot.name !== expected.name || admitted.id !== expected.id || !admitted.homeAdmission) {
    throw new Error("Parked scheduler replacement boot image does not match the retained home");
  }
}

export function createHomeArchiveHandler(deps: {
  store: PlatformStateStore; vm: GatewayVmClient; grant?: { ownerUid: string; sizingProfile: string };
}): OperationHandler {
  return async (operation, ctx) => {
    const { identity, assertClaim } = await requireArchiveOperation(deps.store, operation, ctx, deps.grant);
    const read = async () => { await assertClaim(); return readArchive(deps.store, identity); };
    const { vm } = deps;
    const { owner, archive, parked, home } = await read();
    if (archive.phase === "archived") return { steps: [], success: true, output: { snapshot: archive.snapshot, zeroProvisionedDisks: true } };
    if (archive.phase === "restored" || !parked) throw new Error("Home archive is no longer operating on a parked VM");
    const { instanceName, zone } = parked;
    const snapshotName = `home-archive-${operation.id}`;
    const source = await vm.describe(instanceName, zone);
    if (source && (source.instanceId !== identity.instanceId || source.gatewayId !== identity.gatewayId || source.metadata["octogee-owner-uid"] !== identity.ownerUid)) {
      throw new Error("Home archive source VM identity changed");
    }
    if (source) await verifyReplacementImage(vm, identity, owner, archive, source);
    const ready = await prepareSnapshot(deps, identity, assertClaim, read, { archive, home, source, instanceName, zone, snapshotName });
    if (!ready) return archivePending("Waiting for the exact source stop or home snapshot");
    return await disposeParkedHome(deps, identity, assertClaim, read, { archive: ready, home, source, instanceName, zone, snapshotName });
  };
}
