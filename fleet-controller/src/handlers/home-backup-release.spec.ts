import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { advanceActivationLease, planRestoredHomeBackupRelease } from "@octogee/core/isolated-gateway-lifecycle";
import { enqueueParkedHomeArchive } from "@octogee/core/admin-fleet-router";
import type { UserHomeArchive } from "@octogee/core/platform-state";
import { createHomeBackupReleaseHandler } from "./home-backup-release.js";
import { createHomeArchiveHandler } from "./home-archive.js";
import { retireNativeSchedulerBeforeStage } from "../lib/native-scheduler-retirement.js";
import { restoreArchivedHome } from "../lib/archived-home-restore.js";
import type { Operation } from "@octogee/shared/types/glm";

const uid = "owner";
const source = "shared-one";
const target = "builder-s";
const archiveOp = "archive-1";
const activationId = `builder-activate-${target}-g4`;
const leaseId = "lease-4";
const restoredDisk = { projectId: "test", name: "new-home", id: "201", sizeGb: 10, zone: "us-central1-b",
  source: "projects/test/zones/us-central1-b/disks/new-home", diskType: "pd-balanced" as const };
const archive: Extract<UserHomeArchive, { phase: "restored" }> = {
  phase: "restored", operationId: archiveOp, gatewayId: "old-computer", instanceId: "199", targetGatewayId: target, restoredInstanceId: "200",
  leaseId, generation: 4, restoredDisk,
  snapshot: { projectId: "test", name: "old-snapshot", id: "103", sourceDisk: "projects/test/zones/us-central1-b/disks/old-home", sourceDiskId: "102", sizeGb: 10 },
  bootDisk: { source: "projects/test/zones/us-central1-b/disks/old-boot", id: "101" },
};
const lease = { targetGatewayId: target, leaseId, generation: 4, activationOperationId: activationId, sourceGatewayId: source, status: "active" as const };
const migration = { id: activationId, kind: "migrate-user", status: "succeeded", origin: "automatic", createdBy: "glm-controller-placement-policy", inputUid: uid,
  input: { uid, userSlug: "alice", source: "builder-activation-lease", fromGatewayId: source, toGatewayId: target },
  startedAt: 200, completedAt: 500, cutoverCommittedAt: 400,
  schedulerHandoff: { uid, fromGatewayId: source, toGatewayId: target, slug: "alice", scheduleTransfer: true, stageAfterCutover: true },
};
const receipt = { schemaVersion: 1 as const, kind: "activated" as const, uid, at: 600, builderSlug: "alice", leaseId, generation: 4, cause: "chat",
  sizingTier: "s", entitlementTier: "hobby", gatewayId: target, sharedGatewayId: source, requestedAt: 100, wakeDurationMs: 500,
  activeDurationMs: null, operationId: activationId, retirementOperationId: null, operatorTerminated: false, error: null };

function fixture() {
  const docs: Record<string, Record<string, unknown>> = {
    [`users/${uid}`]: { slug: "alice", provisioning: { homeArchive: archive, homeDisk: restoredDisk, openclaw: { slug: "alice", activationLease: lease } } },
    [`glmOperations/${activationId}`]: { ...migration },
    [`glmGateways/${target}`]: { docKind: "runtime", gatewayId: target, release: 1, lifecycle: "serving", runtime: "gce-vm", vmBootRecovery: { ready: true, instanceId: archive.restoredInstanceId, observedAt: 550 } },
  };
  const store = createDocumentFixtureStore(docs);
  const provider = { eraseHomeSnapshot: vi.fn(async () => true) };
  const assertActiveClaim = vi.fn(async () => undefined);
  const create = () => store.transaction({ label: "activate" }, async tx => {
    const user = (await tx.users.records.get(uid))!;
    const operation = await planRestoredHomeBackupRelease(tx, user, user.activationLease!, 600);
    if (operation) await tx.journal.operations.create(operation);
  });
  const run = async (archiveGrant?: { ownerUid: string; sizingProfile: string }) => {
    const op = (await store.journal.operations.get(`release-home-backup-${archiveOp}`))! as unknown as Operation;
    return createHomeBackupReleaseHandler({ store, vm: provider, archiveGrant })(op, { assertActiveClaim, reportStep: vi.fn() });
  };
  return { store, docs, provider, create, run };
}

async function parkRestoredOwner(h: ReturnType<typeof fixture>, generation = lease.generation) {
  const returnId = `builder-return-${target}-g${generation}`;
  const retirement = {
    uid, slug: "alice", returnOperationId: returnId, migrationId: "returned-scheduler",
    sourceGatewayId: target, sharedGatewayId: source, instanceName: "restored-computer",
    instanceId: archive.restoredInstanceId, zone: restoredDisk.zone, homeDiskId: restoredDisk.id,
    homeDiskSource: restoredDisk.source, cutoverCommittedAt: 700, completedAt: 750,
  };
  await h.store.users.records.setGatewayMirror(uid, { gatewayId: source });
  await h.store.users.records.setActivationLease(uid, { ...lease, generation,
    status: "parked", returnOperationId: returnId }, { leaseId, generation: lease.generation, status: ["active"] });
  await h.store.users.records.setFence(uid, "pendingNativeSchedulerRetirement", retirement, "absent");
  h.docs[`gateways/${target}`] = {
    gatewayId: target, gatewayClass: "isolated", ownerUid: uid, desiredStatus: "paused", sizingProfile: "hobby",
    desiredRelease: 1, liveRelease: 1, latestRelease: 1,
  };
  h.docs[`gateways/${source}`] = { gatewayId: source, gatewayClass: "shared", desiredStatus: "running",
    desiredRelease: 1, liveRelease: 1, latestRelease: 1 };
  h.docs[`gateways/${source}/assignments/${uid}`] = { uid, gatewayId: source, slug: "alice", state: "serving", source: "onboarding", epoch: 2 };
  Object.assign(h.docs[`glmGateways/${target}`], {
    vmSpec: { desktop: "x11" }, vm: {
      instanceName: retirement.instanceName, instanceId: retirement.instanceId, zone: retirement.zone, status: "SUSPENDED",
    },
  });
  h.docs[`glmOperations/${returnId}`] = {
    ...migration, id: returnId, cutoverCommittedAt: 700, completedAt: 800,
    input: { ...migration.input, fromGatewayId: target, toGatewayId: source },
    schedulerHandoff: { uid, slug: "alice", migrationId: retirement.migrationId, fromGatewayId: target, toGatewayId: source },
    output: { nativeSourcePark: { parked: "suspended" } },
  };
  return retirement;
}

const archiveGrant = { ownerUid: uid, sizingProfile: "hobby" };
const backupOperationId = `release-home-backup-${archiveOp}`;

describe("coalesce a parked return with purged restored backup custody", () => {
  it("enqueues the ordinary archive once for the exact returned restored generation", async () => {
    const h = fixture();
    await h.store.users.placementReceipts.create(uid, receipt);
    await h.create();
    await h.store.journal.operations.patch(backupOperationId, { status: "running", startedAt: 800 });
    const nativeSchedulerRetirement = await parkRestoredOwner(h);
    await expect(h.run(archiveGrant)).resolves.toMatchObject({ success: true });
    const current = (await h.store.users.records.get(uid))!;
    expect(current.home.homeDisk).toEqual(restoredDisk);
    expect(current.home.homeArchive).toMatchObject({ phase: "preparing", nativeSchedulerRetirement,
      instanceId: archive.restoredInstanceId, source: { homeDiskId: restoredDisk.id } });
    const newArchiveId = current.home.homeArchive!.operationId;
    expect(current.fences.computerRecovery?.operationId).toBe(newArchiveId);
    expect(await h.store.journal.operations.get(newArchiveId)).toMatchObject({
      status: "pending", origin: "automatic", input: { action: "archive", ownerUid: uid,
        expectedGatewayId: target, expectedInstanceId: archive.restoredInstanceId },
    });
    await expect(h.run(archiveGrant)).resolves.toMatchObject({ success: true });
    expect(h.provider.eraseHomeSnapshot).toHaveBeenCalledOnce();
    expect((await h.store.users.records.get(uid))?.home.homeArchive?.operationId).toBe(newArchiveId);
  });

  it("archives the returned VM again without a grant when its sizing profile snapshots idle storage", async () => {
    const h = fixture();
    h.docs["config/orchestrator"] = { sizingProfiles: { hobby: { isolation: "isolated", sizingTier: "s", fallbackStorageGb: null,
      computer: { runtime: "gce-vm", desktop: "omarchy", machineType: "e2-standard-2", provisioningModel: "SPOT",
        bootDisk: { sizeGb: 80, type: "pd-ssd" }, homeSizeGiB: 10, idleStorage: "snapshot" } } } };
    await h.store.users.placementReceipts.create(uid, receipt);
    await h.create();
    await h.store.journal.operations.patch(backupOperationId, { status: "running", startedAt: 800 });
    await parkRestoredOwner(h);
    Object.assign(h.docs[`glmGateways/${target}`], { vmSpec: { desktop: "omarchy" } });
    await expect(h.run()).resolves.toMatchObject({ success: true });
    const current = (await h.store.users.records.get(uid))!;
    expect(current.home.homeArchive).toMatchObject({ phase: "preparing", desktop: "omarchy", instanceId: archive.restoredInstanceId });
    expect(await h.store.journal.operations.get(current.home.homeArchive!.operationId)).toMatchObject({
      status: "pending", origin: "automatic", input: { action: "archive", expectedGatewayId: target },
    });
  });

  it.each(["active", "newer-generation", "reacquired", "changed-instance", "competing-operation", "missing-grant"] as const)(
    "clears only the completed backup for an ineligible %s owner", async condition => {
      const h = fixture();
      await h.store.users.placementReceipts.create(uid, receipt);
      await h.create();
      await h.store.journal.operations.patch(backupOperationId, { status: "running", startedAt: 800 });
      if (condition !== "active" && condition !== "reacquired") {
        await parkRestoredOwner(h, condition === "newer-generation" ? lease.generation + 1 : lease.generation);
      }
      if (condition === "reacquired") {
        await h.store.users.records.setActivationLease(uid, { ...lease, generation: lease.generation + 1, status: "requested" },
          { leaseId, generation: lease.generation, status: ["active"] });
      }
      if (condition === "changed-instance") {
        Object.assign(h.docs[`glmGateways/${target}`].vm as object, { instanceId: "301" });
      }
      if (condition === "competing-operation") {
        h.docs["glmOperations/other-operation"] = { ...migration, id: "other-operation", status: "pending", completedAt: null };
      }
      await expect(h.run(condition === "missing-grant" ? undefined : archiveGrant)).resolves.toMatchObject({ success: true });
      const owner = await h.store.users.records.get(uid);
      expect(owner?.home.homeArchive).toBeUndefined();
      expect(owner?.home.homeDisk).toEqual(restoredDisk);
      expect(owner?.fences.computerRecovery).toBeUndefined();
    },
  );
});

describe("release the restored Builder backup", () => {
  it("never deletes before the exact placement receipt and committed authoritative schedule handoff", async () => {
    const h = fixture();
    await h.create();
    await expect(h.run()).resolves.toMatchObject({ success: false });
    expect(h.provider.eraseHomeSnapshot).not.toHaveBeenCalled();

    await h.store.users.placementReceipts.create(uid, receipt);
    h.docs[`glmOperations/${activationId}`].output = { unreleasedSchedulerFences: [{}] };
    await expect(h.run()).rejects.toThrow("scheduler custody");
    expect(h.provider.eraseHomeSnapshot).not.toHaveBeenCalled();
    expect((await h.store.users.records.get(uid))?.home.homeArchive).toEqual(archive);
  });

  it("retries exact snapshot and recycle purging before clearing the receipt and keeping the new home", async () => {
    const h = fixture();
    await h.store.users.placementReceipts.create(uid, receipt);
    await h.create();
    await h.create();
    const runtime = h.docs[`glmGateways/${target}`];
    const ready = runtime.vmBootRecovery;
    runtime.vmBootRecovery = { ready: true, instanceId: archive.restoredInstanceId, observedAt: 399 };
    await expect(h.run()).resolves.toMatchObject({ success: false });
    runtime.vmBootRecovery = { ready: true, instanceId: archive.instanceId, observedAt: 550 };
    await expect(h.run()).resolves.toMatchObject({ success: false });
    expect(h.provider.eraseHomeSnapshot).not.toHaveBeenCalled();
    runtime.vmBootRecovery = ready;
    h.provider.eraseHomeSnapshot.mockRejectedValueOnce(new Error("HTTP 403"))
      .mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    await expect(h.run()).resolves.toMatchObject({ success: false, retryAfterMs: expect.any(Number) });
    for (let count = 0; count < 2; count += 1) {
      await expect(h.run()).resolves.toMatchObject({ success: false, waitingForHomeArchiveProvider: true });
      expect((await h.store.users.records.get(uid))?.home.homeArchive).toEqual({ ...archive, releaseProvenForActivation: activationId });
      delete runtime.vmBootRecovery;
    }
    await expect(h.run()).resolves.toMatchObject({ success: true });
    expect((await h.store.users.records.get(uid))?.home).toMatchObject({ homeDisk: restoredDisk });
    expect((await h.store.users.records.get(uid))?.home.homeArchive).toBeUndefined();
    expect(h.provider.eraseHomeSnapshot).toHaveBeenNthCalledWith(4, archive.snapshot, uid);
    await expect(h.run()).resolves.toMatchObject({ success: true });
    expect(h.provider.eraseHomeSnapshot).toHaveBeenCalledTimes(4);
  });
});

it("archives, restores, releases, and repeats on the newly created home", async () => {
  const docs: Record<string, Record<string, unknown>> = {};
  const store = createDocumentFixtureStore(docs);
  const ctx = { assertActiveClaim: vi.fn(async () => undefined), reportStep: vi.fn() };
  const grant = { ownerUid: uid, sizingProfile: "hobby" };
  let disk = restoredDisk;
  let sourceInstanceId = "910";
  const releasedSnapshots: string[] = [];
  const backup = createHomeBackupReleaseHandler({ store, vm: {
    eraseHomeSnapshot: vi.fn(async snapshot => { releasedSnapshots.push(snapshot.id); return true; }),
  } });

  for (const round of [1, 2]) {
    const generation = round * 2;
    const returnId = `return-${round}`;
    const newLeaseId = `restore-${round}`;
    const activationOperationId = `builder-activate-${target}-g${generation}`;
    const expectedHome = disk;
    const freshHome = { ...restoredDisk, name: `new-home-${round}`, id: String(201 + round),
      source: `projects/test/zones/us-central1-b/disks/new-home-${round}` };
    const bootDisk = { id: String(101 + round), source: `projects/test/zones/us-central1-b/disks/boot-${round}` };
    const snapshot = { ...archive.snapshot, id: String(103 + round), sourceDisk: expectedHome.source, sourceDiskId: expectedHome.id };
    const mount = { gatewayId: target, instanceId: sourceInstanceId, instanceName: "computer", zone: expectedHome.zone,
      parkedAt: 10, checkpoint: { outcome: "stale", requestedAt: null, completedAt: null }, vmSpec: { desktop: "x11" } };
    const retirement = { uid, slug: "alice", returnOperationId: returnId, migrationId: `scheduler-${round}`,
      sourceGatewayId: target, sharedGatewayId: source, instanceName: mount.instanceName, instanceId: sourceInstanceId, zone: mount.zone,
      homeDiskId: expectedHome.id, homeDiskSource: expectedHome.source, cutoverCommittedAt: 3, completedAt: 4 };
    docs[`users/${uid}`] = { provisioning: { homeDisk: expectedHome, projectStorage: { nativeBoot: true }, pendingNativeSchedulerRetirement: retirement,
      openclaw: { slug: "alice", gatewayId: source, activationLease: { status: "parked", leaseId: "previous", generation: generation - 1,
        targetGatewayId: target, returnOperationId: returnId } } } };
    docs[`gateways/${source}`] = { gatewayClass: "shared", gatewayId: source, desiredStatus: "running", liveRelease: 1, desiredRelease: 1, latestRelease: 1 };
    docs[`gateways/${source}/assignments/${uid}`] = { uid, gatewayId: source, state: "serving", source: "onboarding", slug: "alice", epoch: 3 };
    const gateway = { gatewayClass: "isolated", gatewayId: target, ownerUid: uid, sizingProfile: "hobby",
      desiredStatus: "paused", liveRelease: 1, desiredRelease: 1, latestRelease: 1 };
    docs[`gateways/${target}`] = gateway;
    docs[`glmGateways/${target}`] = { docKind: "runtime", gatewayId: target, release: 1, lifecycle: "serving", runtime: "gce-vm",
      vmSpec: mount.vmSpec, vm: { instanceId: sourceInstanceId, instanceName: mount.instanceName, zone: mount.zone, status: "TERMINATED" } };
    docs[`glmOperations/${returnId}`] = { ...migration, id: returnId, cutoverCommittedAt: 3, completedAt: 5,
      input: { ...migration.input, fromGatewayId: target, toGatewayId: source },
      schedulerHandoff: { migrationId: retirement.migrationId, uid, slug: "alice", fromGatewayId: target, toGatewayId: source },
      output: { nativeSourcePark: { parked: "stopped" } } };

    const { operationId } = await enqueueParkedHomeArchive(store, { ownerUid: uid, grant, createdBy: "operator" });
    const sourceDescription = { gatewayId: target, instanceId: sourceInstanceId, name: mount.instanceName, zone: mount.zone, status: "TERMINATED",
      metadata: { "octogee-owner-uid": uid } };
    let modelSource: typeof sourceDescription | null = sourceDescription;
    const vmArchive = {
      describe: vi.fn(async () => modelSource), stop: vi.fn(),
      readArchiveBootDisk: vi.fn(async () => bootDisk),
      snapshotStoppedHome: vi.fn(async () => snapshot), verifyHomeSnapshot: vi.fn(),
      deleteRetainingHome: vi.fn(async () => { modelSource = null; }),
      deleteRetainedHome: vi.fn(), archiveDisksAbsent: vi.fn(async () => true),
    };
    const archiveResult = await createHomeArchiveHandler({ store, vm: vmArchive as never, grant })(
      (await store.journal.operations.get(operationId))! as unknown as Operation, ctx);
    expect(archiveResult.success, archiveResult.error).toBe(true);
    expect((await store.users.records.get(uid))?.home.homeArchive).toMatchObject({ phase: "archived", snapshot });
    await store.journal.operations.patch(operationId, { status: "succeeded" });

    const provisioning = { ...lease, status: "provisioning" as const, leaseId: newLeaseId, generation,
      activationOperationId, builderSlug: "alice" };
    docs[`gateways/${target}`] = { ...gateway, builderSlug: "alice", desiredStatus: "running",
      allocation: { claimedByUid: uid, leaseId: newLeaseId, generation } };
    await store.users.records.setActivationLease(uid, provisioning, { leaseId: "previous", generation: generation - 1, status: ["parked"] });
    sourceInstanceId = String(920 + round);
    const description = { ...sourceDescription, instanceId: sourceInstanceId, status: "RUNNING", gatewayId: target };
    const vmRestore = { describe: vi.fn(async () => null), restoreHomeFromSnapshot: vi.fn(async () => freshHome),
      verifyDetachedHome: vi.fn(), create: vi.fn(async () => ({ description })), retainHome: vi.fn(async () => freshHome) };
    await restoreArchivedHome({ store, vm: vmRestore as never }, { ownerUid: uid, gatewayId: target },
      { desktop: "x11", zones: [mount.zone], homeDiskSizeGb: 10 } as never, { instanceName: mount.instanceName } as never);
    expect(vmRestore.restoreHomeFromSnapshot).toHaveBeenCalledWith(expect.objectContaining({ snapshot }));
    expect((await store.users.records.get(uid))?.home.homeArchive).toMatchObject({ phase: "restored", restoredDisk: freshHome });
    docs[`glmOperations/${activationOperationId}`] = { ...migration, id: activationOperationId, status: "running", startedAt: 510, completedAt: null };
    docs[`glmGateways/${target}`] = { docKind: "runtime", gatewayId: target, release: 1, lifecycle: "serving", runtime: "gce-vm",
      vm: { instanceId: sourceInstanceId, instanceName: mount.instanceName, zone: mount.zone, status: "RUNNING" },
      vmBootRecovery: { ready: true, instanceId: sourceInstanceId, observedAt: 550 } };
    await store.users.records.setGatewayMirror(uid, { gatewayId: target });
    await store.users.records.setActivationLease(uid, { ...provisioning, status: "activating" },
      { leaseId: newLeaseId, generation, status: ["provisioning"] });
    const scheduler = vi.fn(async () => ({ operationId: retirement.migrationId, drained: true, phase: "retire" as const, agentIds: ["alice"] }));
    await retireNativeSchedulerBeforeStage({ store, vm: {
      describe: vi.fn(async () => description) as never, retainHome: vmRestore.retainHome, readBootImage: vi.fn(), readImage: vi.fn(),
      verifyBootReplacement: vi.fn(async () => false),
    }, log: vi.fn() }, { uid, slug: "alice", gatewayId: target, operationId: activationOperationId, claimedStartedAt: 510 }, scheduler);
    expect(scheduler).toHaveBeenCalledExactlyOnceWith({ gatewayId: target, slug: "alice", phase: "retire", migrationId: retirement.migrationId });
    await store.journal.operations.patch(activationOperationId, { status: "succeeded", completedAt: 590 });
    await advanceActivationLease({ store, requireOwner: async () => undefined, now: () => 600 }, {
      uid, leaseId: newLeaseId, generation, fromStatus: "activating", toStatus: "active",
    });
    const releaseId = `release-home-backup-${operationId}`;
    const release = await backup((await store.journal.operations.get(releaseId))! as unknown as Operation, ctx);
    expect(release.success, release.error).toBe(true);
    await store.journal.operations.patch(releaseId, { status: "succeeded" });
    expect((await store.users.records.get(uid))?.home.homeArchive).toBeUndefined();
    expect((await store.users.records.get(uid))?.home.homeDisk).toEqual(freshHome);
    disk = freshHome;
  }
  expect(releasedSnapshots).toEqual(["104", "105"]);
});
