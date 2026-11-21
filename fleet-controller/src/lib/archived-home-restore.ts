import { createHash } from "node:crypto";
import type { PlatformStateRepositories, PlatformStateStore, UserHomeArchive } from "@octogee/core/platform-state";
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

async function readDemand(store: PlatformStateRepositories, identity: Identity) {
  const { ownerUid, gatewayId } = identity;
  const [owner, root] = await Promise.all([store.users.records.get(ownerUid), store.gateways.roots.get(gatewayId)]);
  const lease = owner?.activationLease;
  const archive = owner?.home.homeArchive;
  if (!owner || !archive || (archive.phase !== "archived" && archive.phase !== "restoring") ||
      !restoreOwnerEligible(owner) || lease?.status !== "provisioning" || lease.targetGatewayId !== gatewayId ||
      !restoreRootMatches(root, identity, lease) || !matchesArchivedSource(owner, archive)) {
    throw new Error("User home archive requires the exact active restore demand");
  }
  if (!matchingRestoreDemand(archive, identity, lease)) {
    throw new Error("User home archive has another restore demand in progress");
  }
  return { owner, archive, lease };
}

function sameDisk(a: RetainedUserHome, b: RetainedUserHome): boolean {
  return a.id === b.id && a.source === b.source;
}

export async function restoreArchivedHome(deps: {
  store: PlatformStateStore; vm: GatewayVmClient;
}, identity: Identity, spec: GatewayVmSpec, input: CreateGatewayVmInput): Promise<GatewayVmDescription> {
  if (spec.desktop !== "x11") throw new Error("User home archive requires the same desktop runtime");
  const { store, vm } = deps;
  const { ownerUid, gatewayId } = identity;
  const claim: Restoring = await store.transaction({ label: "parked-home.restore-claim" }, async tx => {
    const { owner, archive, lease } = await readDemand(tx, identity);
    if (archive.phase === "restoring") return archive;
    const sourceZone = archive.snapshot.sourceDisk.split("/")[3] ?? "";
    const zone = spec.zones.includes(sourceZone) ? sourceZone : spec.zones.find(candidate => candidate.slice(0, -2) === sourceZone.slice(0, -2));
    if (!zone) throw new Error("Archive snapshot region is not in the current VM configuration");
    const suffix = createHash("sha256").update(JSON.stringify([ownerUid, archive.snapshot.id, lease.leaseId])).digest("hex").slice(0, 32);
    const restoring: Restoring = { ...archive, phase: "restoring", targetGatewayId: gatewayId,
      leaseId: lease.leaseId, generation: lease.generation, zone, diskName: `home-restore-${suffix}` };
    await tx.users.records.patch(ownerUid, { home: { homeArchive: restoring } }, { revision: owner.revision });
    return restoring;
  });
  if (!spec.zones.includes(claim.zone)) throw new Error("Restore zone is not configured");
  let disk = claim.restoredDisk;
  const existing = await vm.describe(input.instanceName, claim.zone);
  if (existing && !disk) throw new Error("Unrecognized VM exists before its restored home was recorded");
  if (!disk) {
    await readDemand(store, identity);
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
    await vm.verifyDetachedHome(disk, ownerUid);
    await readDemand(store, identity);
    vmDescription = (await vm.create({ ...input, zones: [claim.zone], retainedHome: disk })).description;
  }
  if (vmDescription.name !== input.instanceName || vmDescription.zone !== claim.zone ||
      vmDescription.gatewayId !== gatewayId || vmDescription.metadata["octogee-owner-uid"] !== ownerUid ||
      !vmDescription.instanceId) throw new Error("Snapshot-backed VM identity differs from the restore demand");
  const instanceId = vmDescription.instanceId;
  const attached = await vm.retainHome(vmDescription.name, vmDescription.zone, ownerUid);
  if (!sameDisk(attached, disk)) throw new Error("Snapshot-backed VM attached another home disk");
  await store.transaction({ label: "parked-home.restored" }, async tx => {
    const { owner, archive } = await readDemand(tx, identity);
    if (archive.phase !== "restoring" || archive.snapshot.id !== claim.snapshot.id ||
        !archive.restoredDisk || !sameDisk(archive.restoredDisk, attached)) throw new Error("Snapshot-backed disk custody changed");
    const restored: UserHomeArchive = { operationId: archive.operationId, gatewayId: archive.gatewayId, instanceId: archive.instanceId,
      phase: "restored", snapshot: archive.snapshot, bootDisk: archive.bootDisk, targetGatewayId: gatewayId,
      leaseId: archive.leaseId, generation: archive.generation, restoredDisk: attached, restoredInstanceId: instanceId };
    await tx.users.records.patch(ownerUid, { home: { homeArchive: restored, homeDisk: { ...attached }, homeCheckpoint: { clear: true } } },
      { revision: owner.revision });
  });
  return vmDescription;
}
