import { archiveSchedulerCustodyMatches } from "@octogee/core/admin-fleet-router";
import { assertFailedHomeRestoreReleased } from "@octogee/core/isolated-gateway-lifecycle";
import { createHash } from "node:crypto";
import type { PlatformStateRepositories, PlatformStateStore, PlatformUserRecord, UserHomeArchive } from "@octogee/core/platform-state";
import type { GatewayVmSpec, RetainedUserHome } from "@octogee/shared/types/glm";
import type { CreateGatewayVmInput, GatewayVmClient, GatewayVmDescription } from "./compute-vm.js";

type Restoring = Extract<UserHomeArchive, { phase: "restoring" }>;

interface Identity {
  ownerUid: string;
  gatewayId: string;
}

function restoreOwnerEligible(owner: NonNullable<Awaited<ReturnType<PlatformStateRepositories["users"]["records"]["get"]>>>): boolean {
  const { home, fences, accountLifecycle } = owner;
  const migration = home.homeMigration;
  return fences.computerRecovery === undefined && home.homeStorage === undefined &&
    (migration === undefined || (migration.phase === "complete" && migration.id === undefined &&
      migration.source === undefined && migration.target === undefined && migration.copy === undefined)) &&
    (accountLifecycle === null || accountLifecycle.status === "active");
}

function restoreRootMatches(root: Awaited<ReturnType<PlatformStateRepositories["gateways"]["roots"]["get"]>>,
  identity: Identity, lease: { leaseId: string; generation: number }): boolean {
  return root?.gatewayClass === "isolated" && root.ownerUid === identity.ownerUid && root.desiredStatus === "running" &&
    root.retirementClaim == null && root.allocation?.claimedByUid === identity.ownerUid &&
    root.allocation.leaseId === lease.leaseId && root.allocation.generation === lease.generation;
}

function matchesArchivedSource(owner: { home: { homeDisk?: { id?: unknown; source?: unknown } } },
  archive: Extract<UserHomeArchive, { phase: "restoring" }> | { snapshot: Restoring["snapshot"] }): boolean {
  return owner.home.homeDisk?.id === archive.snapshot.sourceDiskId &&
    owner.home.homeDisk?.source === archive.snapshot.sourceDisk;
}

function matchingRestoreDemand(archive: UserHomeArchive, identity: Identity, lease: { leaseId: string; generation: number }): boolean {
  return archive.phase !== "restoring" || (archive.targetGatewayId === identity.gatewayId &&
    archive.leaseId === lease.leaseId && archive.generation === lease.generation);
}

async function assertRestoreHolder(state: PlatformStateRepositories, archive: UserHomeArchive, identity: Identity,
  lease: { leaseId: string; generation: number }, allowRearm: boolean): Promise<void> {
  if (archive.phase !== "restoring" || matchingRestoreDemand(archive, identity, lease)) return;
  if (!allowRearm || lease.generation <= archive.generation) throw new Error("User home archive has another restore demand in progress");
  await assertFailedHomeRestoreReleased(state, { ...archive, ownerUid: identity.ownerUid });
}

async function readDemand(store: PlatformStateRepositories, identity: Identity, allowRearm = false) {
  const { ownerUid, gatewayId } = identity;
  const [owner, root] = await Promise.all([store.users.records.get(ownerUid), store.gateways.roots.get(gatewayId)]);
  const lease = owner?.activationLease;
  const archive = owner?.home.homeArchive;
  if (!owner || !archive || (archive.phase !== "archived" && archive.phase !== "restoring") ||
      !restoreOwnerEligible(owner) || !archiveSchedulerCustodyMatches(owner, archive) || lease?.status !== "provisioning" || lease.targetGatewayId !== gatewayId ||
      !restoreRootMatches(root, identity, lease) || !matchesArchivedSource(owner, archive)) {
    throw new Error("User home archive requires the exact active restore demand");
  }
  await assertRestoreHolder(store, archive, identity, lease, allowRearm);
  return { owner, archive, lease };
}

function sameDisk(a: RetainedUserHome, b: RetainedUserHome): boolean {
  return a.id === b.id && a.source === b.source;
}

async function recordInsertIntent(store: PlatformStateStore, identity: Identity, kind: "diskInsertRequested" | "vmInsertRequested"): Promise<void> {
  await store.transaction({ label: "parked-home.restore-insert-intent" }, async tx => {
    const { owner, archive } = await readDemand(tx, identity);
    if (archive.phase !== "restoring") throw new Error("User home archive lost its restore insert claim");
    if (!archive[kind]) await tx.users.records.patch(identity.ownerUid, {
      home: { homeArchive: { ...archive, [kind]: true } },
    }, { revision: owner.revision });
  });
}

type RestoreComputes = { store: PlatformStateStore; vm: GatewayVmClient;
  rebind?: (description: GatewayVmDescription) => Promise<GatewayVmDescription> };

function boundRestoreInstance(description: GatewayVmDescription, identity: Identity, name: string, claim: Restoring): string {
  if (description.name !== name || description.zone !== claim.zone ||
      description.metadata["octogee-owner-uid"] !== identity.ownerUid || !description.instanceId ||
      (description.gatewayId !== identity.gatewayId && description.gatewayId !== claim.previousTargetGatewayId) ||
      (claim.targetInstanceId !== undefined && description.instanceId !== claim.targetInstanceId)) {
    throw new Error("Snapshot-backed VM identity differs from the restore demand");
  }
  return description.instanceId;
}

async function verifyRestoredAttachment(deps: RestoreComputes, identity: Identity, claim: Restoring,
  input: { instanceName: string; disk: RetainedUserHome; description: GatewayVmDescription }) {
  const { store, vm } = deps;
  const { ownerUid, gatewayId } = identity;
  const { disk } = input;
  let vmDescription = input.description;
  const instanceId = boundRestoreInstance(vmDescription, identity, input.instanceName, claim);
  const pinnedDisk = disk;
  await store.transaction({ label: "parked-home.restored-instance" }, async tx => {
    const { owner, archive } = await readDemand(tx, identity);
    if (archive.phase !== "restoring" || !archive.restoredDisk || !sameDisk(archive.restoredDisk, pinnedDisk) ||
        (archive.targetInstanceId !== undefined && archive.targetInstanceId !== instanceId)) {
      throw new Error("Snapshot-backed VM claim changed before attachment verification");
    }
    if (archive.targetInstanceId === undefined) await tx.users.records.patch(ownerUid, {
      home: { homeArchive: { ...archive, targetInstanceId: instanceId } },
    }, { revision: owner.revision });
  });
  const attached = await vm.retainHome(vmDescription.name, vmDescription.zone, ownerUid);
  if (!sameDisk(attached, disk)) throw new Error("Snapshot-backed VM attached another home disk");
  if (vmDescription.gatewayId !== gatewayId) {
    if (!deps.rebind || vmDescription.gatewayId !== claim.previousTargetGatewayId || !claim.previousLeaseId || !claim.previousGeneration) {
      throw new Error("Snapshot-backed VM belongs to another gateway");
    }
    await assertFailedHomeRestoreReleased(store, { ownerUid, targetGatewayId: vmDescription.gatewayId,
      leaseId: claim.previousLeaseId, generation: claim.previousGeneration });
    await readDemand(store, identity);
    vmDescription = await deps.rebind(vmDescription);
    if (vmDescription.instanceId !== instanceId || vmDescription.gatewayId !== gatewayId) throw new Error("Snapshot-backed VM rebind changed identity");
  }
  return { attached, instanceId, vmDescription };
}

export async function restoreArchivedHome(deps: {
  store: PlatformStateStore; vm: GatewayVmClient;
  rebind?: (description: GatewayVmDescription) => Promise<GatewayVmDescription>;
}, identity: Identity, spec: GatewayVmSpec, input: CreateGatewayVmInput): Promise<GatewayVmDescription> {
  const { store, vm } = deps;
  const { ownerUid, gatewayId } = identity;
  const claim: Restoring = await store.transaction({ label: "parked-home.restore-claim" }, async tx => {
    const { owner, archive, lease } = await readDemand(tx, identity, true);
    if ((archive.desktop ?? "x11") !== spec.desktop) throw new Error("User home archive requires the same desktop runtime");
    if (archive.phase === "restoring") {
      if (archive.targetInstanceName !== input.instanceName) throw new Error("Restore VM name differs from the original claim");
      if (matchingRestoreDemand(archive, identity, lease)) return archive;
      const rearmed: Restoring = { ...archive, previousTargetGatewayId: archive.previousTargetGatewayId ?? archive.targetGatewayId,
        previousLeaseId: archive.previousLeaseId ?? archive.leaseId, previousGeneration: archive.previousGeneration ?? archive.generation,
        targetGatewayId: gatewayId, leaseId: lease.leaseId, generation: lease.generation };
      await tx.users.records.patch(ownerUid, { home: { homeArchive: rearmed } }, { revision: owner.revision });
      return rearmed;
    }
    const sourceZone = archive.snapshot.sourceDisk.split("/")[3] ?? "";
    const zone = spec.zones.includes(sourceZone) ? sourceZone : spec.zones.find(candidate => candidate.slice(0, -2) === sourceZone.slice(0, -2));
    if (!zone) throw new Error("Archive snapshot region is not in the current VM configuration");
    const suffix = createHash("sha256").update(JSON.stringify([ownerUid, archive.snapshot.id, lease.leaseId])).digest("hex").slice(0, 32);
    const restoring: Restoring = { ...archive, phase: "restoring", targetGatewayId: gatewayId,
      leaseId: lease.leaseId, generation: lease.generation, zone, diskName: `home-restore-${suffix}`, targetInstanceName: input.instanceName };
    await tx.users.records.patch(ownerUid, { home: { homeArchive: restoring } }, { revision: owner.revision });
    return restoring;
  });
  if (!spec.zones.includes(claim.zone)) throw new Error("Restore zone is not configured");
  let disk = claim.restoredDisk;
  const existing = await vm.describe(input.instanceName, claim.zone);
  if (existing && !disk) throw new Error("Unrecognized VM exists before its restored home was recorded");
  if (!disk) {
    await recordInsertIntent(store, identity, "diskInsertRequested");
    disk = await vm.restoreHomeFromSnapshot({ snapshot: claim.snapshot, ownerUid, zone: claim.zone,
      diskName: claim.diskName, minimumSizeGb: spec.homeDiskSizeGb }) ?? undefined;
    if (!disk) throw new Error("The snapshot-backed home disk is still being restored");
    const restoredDisk = disk;
    await store.transaction({ label: "parked-home.restored-disk" }, async tx => {
      const { owner, archive } = await readDemand(tx, identity);
      if (archive.phase !== "restoring" || archive.snapshot.id !== claim.snapshot.id ||
          archive.restoredDisk && !sameDisk(archive.restoredDisk, restoredDisk)) throw new Error("Restore disk claim changed");
      await tx.users.records.patch(ownerUid, { home: { homeArchive: { ...archive, restoredDisk } } }, { revision: owner.revision });
    });
  }
  await readDemand(store, identity);
  let vmDescription = existing;
  if (!vmDescription) {
    if (claim.targetInstanceId !== undefined) throw new Error("The pinned snapshot-backed VM is missing; restore remains fenced");
    await vm.verifyDetachedHome(disk, ownerUid);
    await recordInsertIntent(store, identity, "vmInsertRequested");
    vmDescription = (await vm.create({ ...input, zones: [claim.zone], retainedHome: disk })).description;
  }
  const verified = await verifyRestoredAttachment(deps, identity, claim, { instanceName: input.instanceName, disk, description: vmDescription });
  const { attached, instanceId } = verified;
  await store.transaction({ label: "parked-home.restored" }, async tx => {
    const { owner, archive } = await readDemand(tx, identity);
    if (archive.phase !== "restoring" || archive.snapshot.id !== claim.snapshot.id ||
        !archive.restoredDisk || !sameDisk(archive.restoredDisk, attached)) throw new Error("Snapshot-backed disk custody changed");
    const restored: UserHomeArchive = { operationId: archive.operationId, gatewayId: archive.gatewayId, instanceId: archive.instanceId,
      ...(archive.source ? { source: archive.source } : {}),
      ...(archive.nativeSchedulerRetirement ? { nativeSchedulerRetirement: archive.nativeSchedulerRetirement } : {}),
      phase: "restored", snapshot: archive.snapshot, bootDisk: archive.bootDisk, targetGatewayId: gatewayId,
      leaseId: archive.leaseId, generation: archive.generation, restoredDisk: attached, restoredInstanceId: instanceId };
    await tx.users.records.patch(ownerUid, { home: { homeArchive: restored, homeDisk: { ...attached }, homeCheckpoint: { clear: true } } },
      { revision: owner.revision });
  });
  return verified.vmDescription;
}

type Restored = Extract<UserHomeArchive, { phase: "restored" }>;

function sameRestoredDemand(archive: Restored, lease: NonNullable<PlatformUserRecord["activationLease"]>): boolean {
  return archive.leaseId === lease.leaseId && archive.generation === lease.generation && archive.targetGatewayId === lease.targetGatewayId;
}

function restoredArchiveMatchesAttachment(owner: PlatformUserRecord, archive: Restored, expectedOperationId: string,
  observedInstanceId: string | null, attached: RetainedUserHome): boolean {
  return archive.operationId === expectedOperationId && archive.restoredInstanceId === observedInstanceId &&
    sameDisk(archive.restoredDisk, attached) && owner.home.homeDisk?.id === attached.id && owner.home.homeDisk.source === attached.source;
}

function newerAuthorizedDemand(root: Awaited<ReturnType<PlatformStateRepositories["gateways"]["roots"]["get"]>>,
  identity: Identity, demand: PlatformUserRecord["activationLease"]): demand is NonNullable<PlatformUserRecord["activationLease"]> {
  return demand?.status === "provisioning" && demand.targetGatewayId === identity.gatewayId && restoreRootMatches(root, identity, demand);
}

export async function rearmRestoredHomeForDemand(deps: { store: PlatformStateStore; vm: Pick<GatewayVmClient, "retainHome"> },
  identity: Identity, description: GatewayVmDescription | null, observedOwner: PlatformUserRecord | null): Promise<void> {
  const archive = observedOwner?.home.homeArchive;
  const lease = observedOwner?.activationLease;
  if (archive?.phase !== "restored" || lease?.status !== "provisioning" || lease.targetGatewayId !== identity.gatewayId ||
      sameRestoredDemand(archive, lease)) return;
  const { ownerUid, gatewayId } = identity;
  if (!description || description.instanceId !== archive.restoredInstanceId ||
      description.zone !== archive.restoredDisk.zone || description.metadata["octogee-owner-uid"] !== ownerUid) {
    throw new Error("Failed restore rearm requires the exact restored VM");
  }
  const attached = await deps.vm.retainHome(description.name, description.zone, ownerUid);
  if (!sameDisk(attached, archive.restoredDisk)) throw new Error("Failed restore rearm requires the exact restored disk");
  await deps.store.transaction({ label: "parked-home.rearm-restored-demand" }, async tx => {
    const [current, root] = await Promise.all([tx.users.records.get(ownerUid), tx.gateways.roots.get(gatewayId)]);
    const currentArchive = current?.home.homeArchive;
    const demand = current?.activationLease ?? null;
    if (!current || currentArchive?.phase !== "restored" ||
        !restoredArchiveMatchesAttachment(current, currentArchive, archive.operationId, description.instanceId, attached) ||
        !newerAuthorizedDemand(root, identity, demand)) {
      throw new Error("Failed restore rearm ownership changed");
    }
    if (sameRestoredDemand(currentArchive, demand)) return;
    if (demand.generation <= currentArchive.generation || currentArchive.releaseProvenForActivation) {
      throw new Error("Failed restore rearm requires a newer demand and unreleased backup");
    }
    if (current.fences.pendingNativeSchedulerRetirement && !archiveSchedulerCustodyMatches(current, currentArchive)) {
      throw new Error("Failed restore rearm scheduler custody changed");
    }
    await assertFailedHomeRestoreReleased(tx, { ...currentArchive, ownerUid });
    await tx.users.records.patch(ownerUid, { home: { homeArchive: { ...currentArchive,
      targetGatewayId: gatewayId, leaseId: demand.leaseId, generation: demand.generation,
    } } }, { revision: current.revision });
  });
}
