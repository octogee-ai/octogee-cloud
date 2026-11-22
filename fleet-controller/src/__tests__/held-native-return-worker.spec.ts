import { createNativeReturnTargetExclusion } from "../lib/native-return-target-exclusion.js";
import { gatewayRoot } from "@octogee/core-testing/admin-dry-run-app";
import { gatewayScopedJobId, verifyFleetRequest } from "@octogee/core/fleet-signature";
import { SIGNATURE_HEADER } from "@octogee/shared/types/fleet-controller";
import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import { createHeldNativeReturnDestinationVerifier } from "../lib/held-native-return-destination.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import {
  assertPendingHeldNativeOfflineProjection, bindHeldNativeStoppedOriginal, recordHeldNativeOriginalRestart, reserveHeldNativeOfflineSource,
  acquireSharedHeldReturnMaintenance, advanceSharedHeldReturnMaintenance, assertSharedHeldReturnMaintenance,
  assertSharedInertPreLaunch, authorizeSharedInertMaintenance, authorizeSharedInertStockLaunch, readAuthorizedSharedInertStock, rollbackSharedInertBeforeStock,
  assertSharedHeldReturnMaintenanceUnfenced, completeSharedHeldReturnMaintenance, heldNativeReturnBlocksDestination,
  requestHeldNativeReturnRepair, resumeSharedHeldReturnMaintenance, stageSharedHeldReturnMaintenanceRelease, withdrawSharedHeldReturnMaintenance,
  nativeReturnTargetDenied, nativeReturnSharedStoreHandoffDenied,
  type SharedHeldReturnMaintenanceAdmission,
  type SharedHeldReturnMaintenanceResult,
} from "@octogee/core/fleet-state";
import type { Operation } from "@octogee/shared/types/glm";
import { expect, it, vi } from "vitest";
import { processOperation } from "../index.js";
import { createMigrateUserHandler, type MigrateUserDeps } from "../handlers/migrate-user.js";
import { createHeldNativeOfflineReturnWorker, createHeldNativeReturnWorker } from "../lib/held-native-return-worker.js";
import { createSharedHeldReturnMaintenanceOperator, type SharedHeldReturnMaintenancePhysical } from "../lib/held-shared-maintenance-operator.js";

const uid = "uid-owner", slug = "owner", sourceGatewayId = "owner-s-retained", targetGatewayId = "shared-target";
const operationId = `builder-return-${sourceGatewayId}-g4`, sourceEpoch = 7;
const schedulerMigrationId = `mig-${operationId}:scheduler:1:claim:100`;
const selection = { operationId, sourceGatewayId, targetGatewayId, sourceEpoch, schedulerMigrationId };
const detail = `[migration-activation:${slug}] source has no applied fingerprint; converge it before migration`;
const latestError = `migration forward recovery pending: status 503: /push-rsync-state/${sourceGatewayId}: 500 ${JSON.stringify({ error: "push-rsync-state failed", message: detail })}`;
const ownerPath = `users/${uid}`, operationPath = `glmOperations/${operationId}`, targetRuntimePath = `glmGateways/${targetGatewayId}`;

function fixture() {
  const latest = { attempt: 3, startedAt: 100, completedAt: 101, classification: "transient", error: latestError,
    steps: [{ name: "keys-sync-state", status: "done" }, { name: "transfer-agent-store", status: "failed" }] };
  const operations = {
    kind: "migrate-user", origin: "automatic", createdBy: "glm-controller-placement-policy", inputUid: uid,
    gatewayId: targetGatewayId, status: "pending", startedAt: null, completedAt: null, attempts: 3, nextAttemptAt: 900, steps: [],
    input: { uid, userSlug: slug, fromGatewayId: sourceGatewayId, toGatewayId: targetGatewayId, source: "builder-activation-lease" },
    schedulerHandoff: { uid, slug, fromGatewayId: sourceGatewayId, toGatewayId: targetGatewayId, migrationId: schedulerMigrationId,
      forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch } },
    schedulerHandoffReleased: false, attemptHistory: [latest],
  };
  const identity = { slug, gatewayId: sourceGatewayId, migration: { phase: "transferring", state: "moving", startedAt: 100, operationId },
    activationLease: { leaseId: "lease4", generation: 4, status: "returning", targetGatewayId: sourceGatewayId, returnOperationId: operationId } };
  const root = { desiredStatus: "running", desiredRelease: 1, liveRelease: 1, latestRelease: 1 };
  const assignment = { uid, slug, gatewayId: sourceGatewayId, epoch: sourceEpoch, state: "quiescing", updatedByOperationId: operationId,
    source: "migrate-user", createdAt: 10, updatedAt: 100 };
  const sourceRuntime = { docKind: "runtime", gatewayId: sourceGatewayId, release: 1, lifecycle: "serving", runtime: "gce-vm",
    vm: { instanceName: "vm-owner", instanceId: "1234", zone: "us-central1-a", status: "RUNNING" } };
  const targetRuntime = { docKind: "runtime", gatewayId: targetGatewayId, release: 1, lifecycle: "serving", runtime: "cluster",
    heartbeat: { status: "ready", mountedCustomers: ["somebody-else"], migratingIn: [] as string[] } };
  const docs = new Map<string, Record<string, unknown>>([
    [ownerPath, { username: slug, provisioning: { openclaw: identity, homeDisk: { id: "4321", source: "home" } } }],
    [`gateways/${sourceGatewayId}`, { ...root, gatewayId: sourceGatewayId, gatewayClass: "isolated", ownerUid: uid, builderSlug: slug,
      allocation: { kind: "disposable-builder", claimedByUid: uid, leaseId: "lease4", generation: 4 } }],
    [`gateways/${targetGatewayId}`, { ...root, gatewayId: targetGatewayId, gatewayClass: "shared" }],
    [`gateways/${sourceGatewayId}/assignments/${uid}`, assignment],
    [`glmGateways/${sourceGatewayId}`, sourceRuntime],
    [targetRuntimePath, targetRuntime],
    [operationPath, operations],
  ]);
  const store = createDocumentFixtureStore(docs, { serializeTransactions: true });
  return { store, docs, latest, assignment, operations, targetRuntime };
}

it("can plan the exact failed held return without changing the pending operation", async () => {
  const { store } = fixture();
  const before = await store.journal.operations.get(operationId);
  await expect(requestHeldNativeReturnRepair(store, selection, "test-operator", 500, true)).resolves.toMatchObject({ uid, slug, sourceEpoch });
  expect(await store.journal.operations.get(operationId)).toEqual(before);
});

it("rejects stale, active, transferred and ambiguously failed operations instead of applying a general source repair", async () => {
  for (const failure of ["epoch", "running", "execution", "wrong-error", "target-owner"]) {
    const t = fixture();
    if (failure === "epoch") t.assignment.epoch++;
    if (failure === "running") t.docs.set(operationPath, { ...t.operations, status: "running", startedAt: 501 });
    if (failure === "execution") t.docs.set(operationPath, { ...t.operations, sourceTransferExecution: { status: "dispatched" } });
    if (failure === "wrong-error") t.latest.error = "unrelated transfer rejection";
    if (failure === "target-owner") t.targetRuntime.heartbeat.migratingIn.push(slug);
    await expect(requestHeldNativeReturnRepair(t.store, selection, "test-operator", 500)).rejects.toThrow(/Held Native return/);
    expect((await t.store.journal.operations.get(operationId))?.schedulerHandoff?.forwardRecovery?.sourceReconcile).toBeUndefined();
  }
});

it("holds only the destination through a worker restart and reuses the exact return once the real verifier succeeds", async () => {
  const { store } = fixture();
  const identity = await requestHeldNativeReturnRepair(store, selection, "test-operator", 500);
  await expect(requestHeldNativeReturnRepair(store, selection, "test-operator", 501)).resolves.toEqual(identity);
  const selected = (await store.journal.operations.get(operationId))!;
  expect(heldNativeReturnBlocksDestination(selected, sourceGatewayId)).toBe(false);
  expect(heldNativeReturnBlocksDestination(selected, targetGatewayId)).toBe(true);
  expect(heldNativeReturnBlocksDestination(selected, "shared-unrelated")).toBe(false);
  expect(selected.nextAttemptAt).toBeUndefined();
  await store.journal.operations.patch(operationId, { status: "running", startedAt: 600 });
  const operation = { ...(await store.journal.operations.get(operationId))!, id: operationId } as Operation;
  const ctx = { reportStep: vi.fn(), assertActiveClaim: vi.fn(async () => {}) };
  for (const barrier of ["backup", "destination"]) {
    const reconcile = vi.fn();
    const blocked = createHeldNativeReturnWorker({
      store, reconcile, now: () => 660,
      verifyBackup: async () => {
        if (barrier === "backup") throw new Error("backup unavailable");
        return { generation: "immutable" };
      },
      assertBackupCurrent: async () => {},
      verifyDestination: async () => { if (barrier === "destination") throw new Error("destination unavailable"); },
    });
    await expect(blocked(operation, ctx)).rejects.toThrow(`${barrier} unavailable`);
    expect(reconcile).not.toHaveBeenCalled();
  }
  const interrupted = createHeldNativeReturnWorker({ store, verifyBackup: async () => ({ generation: "immutable" }), assertBackupCurrent: async () => {}, verifyDestination: async () => {}, now: () => 660,
    reconcile: async (_, assertCurrent) => {
      await assertCurrent();
      await store.journal.operations.patch(operationId, { status: "pending", startedAt: null });
      return { verifiedAt: 650, appliedFingerprint: "a".repeat(16), activationManifestSha256: "b".repeat(64) };
    } });
  await expect(interrupted(operation, ctx)).rejects.toThrow(/claim changed/);
  expect(heldNativeReturnBlocksDestination((await store.journal.operations.get(operationId))!, targetGatewayId)).toBe(true);
  await store.journal.operations.patch(operationId, { status: "running", startedAt: 700 });
  const retry = { ...(await store.journal.operations.get(operationId))!, id: operationId } as Operation;
  const complete = createHeldNativeReturnWorker({ store, verifyBackup: async () => ({ generation: "immutable" }), assertBackupCurrent: async () => {}, verifyDestination: async () => {}, now: () => 760,
    reconcile: async (authority, assertCurrent, backup) => {
      expect(backup).toEqual({ generation: "immutable" });
      expect(authority).toMatchObject({ ...identity, claimStartedAt: 700 });
      await assertCurrent();
      return { verifiedAt: 750, appliedFingerprint: "a".repeat(16), activationManifestSha256: "b".repeat(64) };
    } });
  const handoff = await complete(retry, ctx);
  expect(handoff.forwardRecovery).toMatchObject({ phase: "source-flushed", sourceEpoch, sourceReconcile: { receipt: { appliedFingerprint: "a".repeat(16), activationManifestSha256: "b".repeat(64) } } });
  const completed = (await store.journal.operations.get(operationId))!;
  expect(heldNativeReturnBlocksDestination(completed, targetGatewayId)).toBe(false);
  expect(completed.cutoverCommittedAt).toBeUndefined();
  expect((await store.gateways.assignments.get(sourceGatewayId, uid))?.state).toBe("quiescing");
});

it("reserves a stopped-original alternate without making an online receipt or releasing destination", async () => {
  const { store } = fixture();
  const reserved = await reserveHeldNativeOfflineSource(store, selection, "test-operator", 500);
  expect(heldNativeReturnBlocksDestination((await store.journal.operations.get(operationId))!, targetGatewayId)).toBe(true);
  await expect(requestHeldNativeReturnRepair(store, selection, "test-operator", 501)).rejects.toThrow("offline source");
  const witness = { originalInstanceId: "1234", stoppedAt: 520 };
  await expect(bindHeldNativeStoppedOriginal(store, selection, { ...witness, stoppedAt: 490 }, "test-operator", 530)).rejects.toThrow("reserved source");
  expect((await store.gateways.roots.get(sourceGatewayId))?.runtimeRestartFence?.phase).toBe("reserved");
  await expect(bindHeldNativeStoppedOriginal(store, selection, { ...witness, originalInstanceId: "2345" }, "test-operator", 530)).rejects.toThrow("reserved source");
  await expect(bindHeldNativeStoppedOriginal(store, selection, witness, "test-operator", 530)).resolves.toEqual(reserved);
  expect((await store.fleetRegistry.get(sourceGatewayId))?.vm).toMatchObject({ instanceId: "1234", status: "TERMINATED", stopReason: "operator" });
  await expect(assertPendingHeldNativeOfflineProjection(store, reserved)).resolves.toBeUndefined();
  await expect(assertPendingHeldNativeOfflineProjection(store, { ...reserved, uid: "foreign-owner" }))
    .rejects.toThrow("does not match the pending owner");
  await store.journal.operations.patch(operationId, { status: "running", startedAt: 600 });
  await expect(assertPendingHeldNativeOfflineProjection(store, reserved)).rejects.toThrow("no pending stopped-original claim");
  const operation = { ...(await store.journal.operations.get(operationId))!, id: operationId } as Operation;
  const stage = { verifiedAt: 650, holdGeneration: "a".repeat(64), maintenanceInstanceId: "5678", immutableSnapshotId: "90",
    fileSha256: "b".repeat(64), ownerAnchorSha256: "c".repeat(64) };
  const worker = createHeldNativeOfflineReturnWorker({
    store, now: () => 700, verifyDestination: async () => {}, verifyBackup: async () => ({ exact: "verified" }), assertBackupCurrent: async () => {},
    reconcile: async (authority, assertHeld) => { expect(authority.requestId).toBe(reserved.requestId); await assertHeld(); return stage; },
  });
  const handoff = await worker(operation, { reportStep: vi.fn(), assertActiveClaim: vi.fn(async () => {}) });
  expect(handoff.forwardRecovery?.offlineSourceRecovery).toMatchObject({ phase: "staged-offline", stage });
  expect(handoff.forwardRecovery?.sourceReconcile).toBeUndefined();
  const finished = (await store.journal.operations.get(operationId))!;
  expect(heldNativeReturnBlocksDestination(finished, targetGatewayId)).toBe(true);
  expect(finished.cutoverCommittedAt).toBeUndefined();
  expect(finished).toMatchObject({ status: "pending", startedAt: null, waitingOn: "held-native-offline-publication" });
  expect((await store.gateways.assignments.get(sourceGatewayId, uid))?.state).toBe("quiescing");
  const restart = { originalInstanceId: "1234", restartedAt: 710, internalIp: "10.1.2.3",
    cleanFileSha256: "d".repeat(64), restartedFileSha256: "d".repeat(64), ownerAnchorSha256: stage.ownerAnchorSha256 };
  await expect(recordHeldNativeOriginalRestart(store, selection, { ...restart, restartedFileSha256: "e".repeat(64) }, "test-operator", 720))
    .rejects.toThrow("restart is not verified");
  expect((await store.gateways.roots.get(sourceGatewayId))?.runtimeRestartFence?.phase).toBe("staged-offline");
  await expect(recordHeldNativeOriginalRestart(store, selection, restart, "test-operator", 720)).resolves.toEqual(reserved);
  const restored = (await store.journal.operations.get(operationId))!;
  expect(restored.schedulerHandoff?.forwardRecovery?.offlineSourceRecovery?.phase).toBe("original-restored");
  expect((await store.gateways.roots.get(sourceGatewayId))?.runtimeRestartFence).toBeUndefined();
  expect((await store.fleetRegistry.get(sourceGatewayId))?.vm).toMatchObject({ instanceId: "1234", status: "RUNNING" });
  expect(heldNativeReturnBlocksDestination(restored, targetGatewayId)).toBe(true);

});

it.each([false, true])("runs only the exact stopped-original claim and holds the journal after staging (Shared hold: %s)", async sharedHold => {
  const { store, docs, operations } = fixture();
  if (sharedHold) Object.assign(operations.schedulerHandoff.forwardRecovery, {
    sharedTargetImportHold: { gatewayId: targetGatewayId, maintenanceAttemptId: "verified-target-maintenance" },
  });
  const reserved = await reserveHeldNativeOfflineSource(store, selection, "test-operator", 500);
  const witness = { originalInstanceId: "1234", stoppedAt: 520 };
  const current = async () => (await store.journal.operations.get(operationId))! as unknown as Operation;
  const stage = vi.fn(async (_authority, assertHeld) => {
    await assertHeld();
    const active = await current();
    expect(active).toMatchObject({ status: "running", completedAt: null });
    return { verifiedAt: active.startedAt!, holdGeneration: "a".repeat(64), maintenanceInstanceId: "5678", immutableSnapshotId: "90",
      fileSha256: "b".repeat(64), ownerAnchorSha256: "c".repeat(64) };
  });
  const reconcileHeldNativeOfflineReturn = createHeldNativeOfflineReturnWorker({
    store, now: Date.now, verifyDestination: async () => {}, verifyBackup: async () => ({ verified: true }),
    assertBackupCurrent: async () => {}, reconcile: stage,
  });
  const handler = createMigrateUserHandler({ reconcileHeldNativeOfflineReturn } as MigrateUserDeps);
  const observeHeldNativeStoppedOriginal = async () => witness;
  const deps = { store, handlers: { "migrate-user": handler }, observeHeldNativeStoppedOriginal,
    log: vi.fn() } as unknown as Parameters<typeof processOperation>[1];
  await processOperation(await current(), deps);
  expect(stage).not.toHaveBeenCalled();
  await bindHeldNativeStoppedOriginal(store, selection, witness, "test-operator", 530);
  await processOperation(await current(), { ...deps, observeHeldNativeStoppedOriginal: undefined });
  expect(stage).not.toHaveBeenCalled();

  const source = `gateways/${sourceGatewayId}`;
  const before = docs.get(source)!;
  docs.set(source, { ...before, runtimeRestartFence: { ...before.runtimeRestartFence as object, attemptId: "another-request" } });
  await processOperation(await current(), deps);
  expect(stage).not.toHaveBeenCalled();
  docs.set(source, before);

  stage.mockRejectedValueOnce(new Error("independent backup read failed before staging"));
  await processOperation(await current(), deps);
  expect(await current()).toMatchObject({ status: "pending", startedAt: null, completedAt: null,
    schedulerHandoff: { forwardRecovery: { offlineSourceRecovery: { phase: "stopped-original", requestId: reserved.requestId } } } });
  await store.journal.operations.patch(operationId, { nextAttemptAt: { clear: true } });
  await processOperation(await current(), deps);
  expect(stage).toHaveBeenCalledTimes(2);
  expect(await current()).toMatchObject({ status: "pending", startedAt: null, completedAt: null, waitingOn: "held-native-offline-publication",
    schedulerHandoff: { forwardRecovery: { offlineSourceRecovery: { phase: "staged-offline", requestId: reserved.requestId } } } });
  await processOperation(await current(), deps);
  expect(stage).toHaveBeenCalledTimes(2);
  expect(heldNativeReturnBlocksDestination((await store.journal.operations.get(operationId))!, targetGatewayId)).toBe(true);
});

it("requires a live scoped import denial from the same ready destination pod", async () => {
  const { privateKey, publicKey } = FLEET_KEY_PAIR;
  let podUid = "first";
  let responseMode = "old";
  const runKubectl = vi.fn(async () => ({
    code: 0, stderr: "", stdout: JSON.stringify({ items: [{
      metadata: { uid: podUid, name: "destination-pod" },
      status: { phase: "Running", podIP: "10.1.2.3", conditions: [{ type: "Ready", status: "True" }] },
    }] }),
  }));
  const verify = createHeldNativeReturnDestinationVerifier({ namespace: "test", privateKey, runKubectl });
  const authority = { ...selection, uid, slug, requestId: "request", claimStartedAt: 600 };
  const assertCurrent = vi.fn(async () => {});
  const http = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(url).toBe(`http://10.1.2.3:3003/target-import-hold/${targetGatewayId}`);
    const body = String(init?.body);
    const sig = new Headers(init?.headers).get(SIGNATURE_HEADER);
    expect(verifyFleetRequest(publicKey, gatewayScopedJobId(schedulerMigrationId, targetGatewayId), body, sig ?? undefined)).toBe(true);
    if (responseMode === "old") return new Response(null, { status: 404 });
    if (responseMode === "replaced") podUid = "different";
    const observed = JSON.parse(body);
    return Response.json({ ...observed, ...(responseMode === "stale" && { nonce: "stale" }), held: true });
  });
  try {
    await expect(verify(authority, assertCurrent)).rejects.toThrow(/404/);
    responseMode = "stale";
    await expect(verify(authority, assertCurrent)).rejects.toThrow(/did not match/);
    responseMode = "replaced";
    await expect(verify(authority, assertCurrent)).rejects.toThrow(/pod changed/);
    responseMode = "current";
    await expect(verify(authority, assertCurrent)).resolves.toBeUndefined();
  } finally {
    http.mockRestore();
  }
});

it("witnesses the exact held owner over retained Pod loopback while migration ingress is closed", async () => {
  const { privateKey, publicKey } = FLEET_KEY_PAIR;
  const pod = { name: "retained-shared", uid: "retained-uid" };
  let observedUid = pod.uid;
  const execute = vi.fn();
  const verify = createHeldNativeReturnDestinationVerifier({
    namespace: "test", privateKey, loopbackPodUid: pod.uid,
    runKubectl: async (args, options) => {
      if (args.includes("get")) return { code: 0, stderr: "", stdout: JSON.stringify({ items: [{
        metadata: { ...pod, uid: observedUid },
        status: { phase: "Running", podIP: "10.1.2.3", conditions: [{ type: "Ready", status: "True" }] },
      }] }) };
      execute(args);
      const request = JSON.parse(options!.stdin!);
      expect(request.path).toBe(`/target-import-hold/${targetGatewayId}`);
      expect(verifyFleetRequest(publicKey, gatewayScopedJobId(schedulerMigrationId, targetGatewayId), request.body, request.signature)).toBe(true);
      return { code: 0, stderr: "", stdout: JSON.stringify({ status: 200, proof: { ...JSON.parse(request.body), held: true } }) };
    },
  });
  await verify({ ...selection, slug }, async () => {});
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0]?.[0].slice(0, 8)).toEqual(["-n", "test", "exec", "-i", pod.name, "-c", "gateway", "--"]);
  observedUid = "different";
  await expect(verify({ ...selection, slug }, async () => {})).rejects.toThrow(/exactly one ready pod/);
  expect(execute).toHaveBeenCalledOnce();
});

function sharedMaintenanceFixture() {
  const t = fixture();
  t.docs.set(`gateways/${targetGatewayId}`, gatewayRoot(targetGatewayId, { liveRelease: 1 }));
  const owners = Array.from({ length: 6 }, (_, index) => ({
    uid: `uid-seat-${index}`, slug: `seat-${index}`, epoch: index + 1, homeIdentitySha256: String(index + 1).repeat(64),
  }));
  t.targetRuntime.heartbeat.mountedCustomers = owners.map(owner => owner.slug);
  for (const owner of owners) {
    const { uid: ownerUid, slug: ownerSlug, epoch } = owner;
    t.docs.set(`users/${ownerUid}`, { username: ownerSlug, onboardingStep: "complete", provisioning: { openclaw: { slug: ownerSlug, gatewayId: targetGatewayId } } });
    t.docs.set(`gateways/${targetGatewayId}/assignments/${ownerUid}`, { uid: ownerUid, slug: ownerSlug,
      gatewayId: targetGatewayId, epoch, state: "serving", updatedByOperationId: null, source: "onboarding", createdAt: 1, updatedAt: 1 });
  }
  const outboundId = "placement-" + "c".repeat(32);
  const outboundPath = `glmOperations/${outboundId}`;
  t.docs.set(outboundPath, {
    kind: "migrate-user", origin: "automatic", status: "pending", inputUid: owners[0]!.uid, startedAt: null, completedAt: null,
    createdBy: "glm-controller-placement-policy",
    input: { uid: owners[0]!.uid, userSlug: owners[0]!.slug, fromGatewayId: targetGatewayId, toGatewayId: "shared-other",
      source: "continuous-placement-policy" }, steps: [],
  });
  const imageRepository = "registry.example/octogee/octogee-gateway";
  const edgeRepository = "registry.example/octogee/gateway-edge";
  const originalTag = "abcdef1@sha256:" + "a".repeat(64);
  const originalEdgeTag = "abcdef1@sha256:" + "b".repeat(64);
  const admission: SharedHeldReturnMaintenanceAdmission = {
    selection, targetRelease: 1, owners,
    retainedBoot: { gatewayImageTag: originalTag, completedInitImageId: imageRepository + "@sha256:" + "a".repeat(64) },
    workload: {
      podName: "shared-target-pod", podUid: "00000000-0000-4000-8000-000000000001",
      deploymentUid: "00000000-0000-4000-8000-000000000002", replicaSetUid: "00000000-0000-4000-8000-000000000003",
    },
    originalImages: { gateway: `${imageRepository}:${originalTag}`, "gateway-edge": `${edgeRepository}:${originalEdgeTag}` },
    maintenanceImages: { gateway: imageRepository + ":abcdef2@sha256:" + "c".repeat(64), "gateway-edge": edgeRepository + ":abcdef2@sha256:" + "d".repeat(64) },
    acceptedMaintenanceSource: "e".repeat(40), acceptedNativeSource: "d".repeat(40), originalNativeSource: "c".repeat(40),
    installedChartFingerprint: "8".repeat(64),
    exactWorkloadObserved: true, noInFlightTasks: true, noPreparedImports: true, rollbackVerified: true, observedAt: 500,
  };
  const payload = { imageRepository, imageTag: originalTag, gatewayEdgeImage: { imageRepository: edgeRepository, imageTag: originalEdgeTag },
    openclawSourceSha: "f".repeat(40) };
  t.docs.set(`gateways/${targetGatewayId}/releases/1`, {
    gatewayId: targetGatewayId, release: 1, createdAt: 1, createdBy: "test", sourceRelease: null, note: null, payload,
    payloadHash: releasePayloadHash(payload),
  });
  const installedHelm = { imageRepository, imageTag: originalTag, deploymentName: "shared-deployment", releaseName: "shared-helm",
    gatewayServiceName: "shared", gatewayEdgeServiceName: "shared-edge", serviceAccountName: "shared-sa", replicas: 1,
    availableReplicas: 1, lastAppliedAt: 540 };
  Object.assign(t.targetRuntime, {
    helm: installedHelm,
    kubernetes: { status: "ready", totalPods: 1, readyPods: 1, observedAt: 540, pods: [{
      uid: admission.workload.podUid, name: admission.workload.podName, replicaSetUid: admission.workload.replicaSetUid,
      nodeName: null, nodePool: null, instanceId: null,
    }] },
  });
  Object.assign(t.targetRuntime.heartbeat, { lastHeartbeatAt: 540, version: "abcdef1" });
  const observeInstalledHelm = async () => ({
    installed: installedHelm, chartFingerprint: admission.installedChartFingerprint,
    edgeImage: admission.originalImages["gateway-edge"], verifiedAt: 540,
  });
  const acquire = () => acquireSharedHeldReturnMaintenance(t.store, {
    environment: "test", actor: "protected-operator", attemptId: "00000000-0000-4000-8000-000000000004",
    now: () => 500, readVerifiedAdmission: async () => admission,
  });
  return { ...t, acquire, admission, outboundId, outboundPath, observeInstalledHelm, originalPayload: payload };
}

it("does not reserve Shared maintenance during conflicting placements, source maintenance, roster drift, or a stale preflight", async () => {
  for (const reason of ["inbound", "outbound", "offline", "roster", "stale"] as const) {
    const h = sharedMaintenanceFixture();
    if (reason === "inbound") h.docs.set(operationPath, { ...h.operations, status: "running", startedAt: 501 });
    if (reason === "outbound") Object.assign(h.docs.get(h.outboundPath)!, { attempts: 1 });
    if (reason === "offline") Object.assign(h.operations.schedulerHandoff.forwardRecovery, { offlineSourceRecovery: { phase: "reserved" } });
    if (reason === "roster") h.admission.owners[0]!.epoch++;
    if (reason === "stale") h.admission.observedAt = 500 - 61_000;
    const before = structuredClone(h.docs);
    await expect(h.acquire()).rejects.toThrow();
    expect(h.docs).toEqual(before);
  }
});

function setDormantNativeSchedulerReference(h: ReturnType<typeof sharedMaintenanceFixture>, index: number) {
  const { uid: ownerUid, slug: ownerSlug } = h.admission.owners[index]!;
  const oldSource = `${ownerSlug}-parked`;
  const oldShared = "shared-prior";
  const returnOperationId = `builder-return-${oldSource}-g3`;
  const localOwner = h.docs.get(`users/${ownerUid}`)!;
  const provisioning = localOwner.provisioning as Record<string, unknown>;
  const reference = {
    uid: ownerUid, slug: ownerSlug, sourceGatewayId: oldSource, sharedGatewayId: oldShared, migrationId: "first-native-return",
    returnOperationId, instanceId: "2200", instanceName: `${oldSource}-vm`, zone: "example-a",
    homeDiskId: "3100", homeDiskSource: "projects/example/zones/example-a/disks/original-home",
    completedAt: 330, cutoverCommittedAt: 320,
  };
  Object.assign(provisioning, {
    homeDisk: { id: reference.homeDiskId, source: reference.homeDiskSource },
    pendingNativeSchedulerRetirement: reference,
  });
  const historical = {
    kind: "migrate-user", status: "succeeded", inputUid: ownerUid, startedAt: 310, completedAt: 340, createdAt: 300,
    input: { uid: ownerUid, fromGatewayId: oldSource, toGatewayId: oldShared },
    schedulerHandoff: { uid: ownerUid, slug: ownerSlug, fromGatewayId: oldSource, toGatewayId: oldShared, migrationId: reference.migrationId },
    steps: [], cutoverCommittedAt: reference.cutoverCommittedAt, output: { nativeSourcePark: { parked: "suspended" } },
  };
  h.docs.set(`glmOperations/${returnOperationId}`, historical);
  return { oldSource, ownerUid, ownerSlug, reference, historical };
}

it("accepts terminal dormant scheduler history after Shared replacement without retiring the referenced home", async () => {
  const h = sharedMaintenanceFixture();
  const parked = setDormantNativeSchedulerReference(h, 0);
  const absent = setDormantNativeSchedulerReference(h, 1);
  h.docs.set(`gateways/${parked.oldSource}`, gatewayRoot(parked.oldSource,
    { gatewayClass: "isolated", desiredStatus: "paused", ownerUid: parked.ownerUid, builderSlug: parked.ownerSlug }));
  h.docs.set(`glmGateways/${parked.oldSource}`, { docKind: "runtime", runtime: "gce-vm", release: 1, lifecycle: "paused", gatewayId: parked.oldSource, vm: { status: "TERMINATED", instanceId: "3300" } });
  const claim = await h.acquire();
  await expect(assertSharedHeldReturnMaintenance(h.store, claim)).resolves.toBe("reserved");
  for (const owner of [parked, absent]) {
    expect((await h.store.users.records.get(owner.ownerUid))?.fences.pendingNativeSchedulerRetirement).toEqual(owner.reference);
  }
});

it.each(["incomplete", "wrong-return", "source-running", "other-fence"] as const)(
  "refuses a historical-looking record with unverified authority or source state (%s)", async reason => {
    const h = sharedMaintenanceFixture();
    const caseData = setDormantNativeSchedulerReference(h, 0);
    if (reason === "incomplete") Object.assign(caseData.reference, { completedAt: undefined });
    if (reason === "wrong-return") caseData.historical.input.toGatewayId = targetGatewayId;
    if (reason === "source-running") h.docs.set(`gateways/${caseData.oldSource}`, gatewayRoot(caseData.oldSource,
      { gatewayClass: "isolated", desiredStatus: "running", ownerUid: caseData.ownerUid, builderSlug: caseData.ownerSlug }));
    if (reason === "other-fence") await h.store.users.records.setFence(caseData.ownerUid, "restoreFence", { operationId: "existing-restore" }, "absent");
    const before = structuredClone(h.docs);
    await expect(h.acquire()).rejects.toThrow(/owner custody changed/);
    expect(h.docs).toEqual(before);
  },
);

it("authenticates scoped controller steps and refuses physical work before the exact staged release", async () => {
  const h = sharedMaintenanceFixture();
  const scope = { operationId, gatewayId: targetGatewayId, attemptId: "00000000-0000-4000-8000-000000000004" };
  const actor = "protected-operator";
  const readVerifiedAdmission = vi.fn(async () => h.admission);
  let policyHeld = false;
  const holdMigrationPolicy = vi.fn<SharedHeldReturnMaintenancePhysical["holdMigrationPolicy"]>(async (_claim, assertReserved) => {
    await assertReserved();
    policyHeld = true;
  });
  const verifyReadyToDispatch = vi.fn<SharedHeldReturnMaintenancePhysical["verifyReadyToDispatch"]>(async (_claim, assertReserved) => {
    await assertReserved();
    if (!policyHeld) throw new Error("migration policy was not held");
  });
  const applyStagedRelease = vi.fn<SharedHeldReturnMaintenancePhysical["applyStagedRelease"]>(
    async (_claim, staged, assertCurrent) => {
      expect(staged).toEqual({ phase: "dispatched", release: 2 });
      await expect(assertCurrent()).resolves.toBeUndefined();
    },
  );
  const admin = createSharedHeldReturnMaintenanceOperator({
    store: h.store, now: () => 520,
    physical: { readVerifiedAdmission, holdMigrationPolicy, verifyReadyToDispatch, applyStagedRelease, restoreMigrationPolicy: vi.fn(),
      readVerifiedWithdrawal: vi.fn(), readVerifiedResult: vi.fn(), readInstalledHelm: vi.fn() },
  });
  await expect(admin(actor, { action: "acquire", attemptId: scope.attemptId, selection }, true)).resolves.toMatchObject({ dryRun: true });
  expect(readVerifiedAdmission).not.toHaveBeenCalled();
  await expect(admin(actor, { action: "acquire", attemptId: scope.attemptId, selection }, false)).resolves.toMatchObject({ phase: "reserved" });
  expect(readVerifiedAdmission).toHaveBeenCalledWith(selection, scope.attemptId);
  await expect(admin("another-operator", { action: "dispatch", ...scope }, false)).rejects.toThrow(/another operation or operator/);
  await expect(admin(actor, { action: "apply", ...scope }, false)).rejects.toThrow(/matching staged release/);
  await expect(admin(actor, { action: "dispatch", ...scope }, false)).rejects.toThrow(/policy was not held/);
  await expect(admin(actor, { action: "hold-migration-policy", ...scope }, false)).resolves.toMatchObject({ phase: "reserved" });
  await expect(admin(actor, { action: "dispatch", ...scope }, false)).resolves.toMatchObject({ phase: "dispatched" });
  await expect(admin(actor, { action: "hold-migration-policy", ...scope }, false)).rejects.toThrow(/dispatched or withdrawn/);
  expect(holdMigrationPolicy).toHaveBeenCalledTimes(1);
  await expect(admin(actor, { action: "apply", ...scope }, false)).rejects.toThrow(/matching staged release/);
  expect(applyStagedRelease).not.toHaveBeenCalled();
  await expect(admin(actor, { action: "stage", ...scope }, false)).resolves.toMatchObject({ release: 2 });
  await expect(admin(actor, { action: "apply", ...scope }, false)).resolves.toMatchObject({ phase: "dispatched", release: 2 });
  expect(applyStagedRelease).toHaveBeenCalledTimes(1);
});

it("withdraws an untouched reservation only after restoring policy and verifying original custody", async () => {
  const h = sharedMaintenanceFixture();
  const claim = await h.acquire();
  const original = {
    attemptId: claim.attemptId, workload: h.admission.workload, owners: h.admission.owners,
    images: h.admission.originalImages, runningImageIds: h.admission.originalImages, retainedBoot: h.admission.retainedBoot,
    nativeSource: h.admission.originalNativeSource, noInFlightTasks: true, noPreparedImports: true, exclusiveReady: true, verifiedAt: 540,
    migrationPolicyRestored: true, installed: await h.observeInstalledHelm(),
  } as const;
  let now = 520;
  const restoreMigrationPolicy = vi.fn(async () => {
    now = 550;
    await expect(assertSharedHeldReturnMaintenance(h.store, claim)).resolves.toBe("withdrawing");
    await expect(advanceSharedHeldReturnMaintenance(h.store, claim, "dispatched", () => 530, async () => {})).rejects.toThrow(/dispatched or withdrawn/);
    await expect(stageSharedHeldReturnMaintenanceRelease(h.store, claim, () => 530)).rejects.toThrow(/before dispatch/);
  });
  const readVerifiedWithdrawal = vi.fn(async () => original);
  const withdraw = () => withdrawSharedHeldReturnMaintenance(h.store, claim, { restoreMigrationPolicy, readVerifiedWithdrawal, now: () => now });

  restoreMigrationPolicy.mockRejectedValueOnce(new Error("policy restoration interrupted"));
  await expect(withdraw()).rejects.toThrow(/interrupted/);
  await expect(assertSharedHeldReturnMaintenance(h.store, claim)).resolves.toBe("withdrawing");
  readVerifiedWithdrawal.mockResolvedValueOnce({ ...original, workload: { ...original.workload, podUid: "changed" } });
  await expect(withdraw()).rejects.toThrow(/exact verified completion/);
  expect((await h.store.journal.audits.get(claim.auditId))?.status).toBe("in-progress");

  await expect(withdraw()).resolves.toBeUndefined();
  await expect(withdraw()).resolves.toBeUndefined();
  expect(restoreMigrationPolicy).toHaveBeenCalledTimes(3);
  expect(await h.store.gateways.roots.get(targetGatewayId)).toMatchObject({ desiredRelease: 1, latestRelease: 1, liveRelease: 1 });
  expect((await h.store.gateways.roots.get(targetGatewayId))?.runtimeRestartFence).toBeUndefined();
  expect(await h.store.gateways.releases.get(targetGatewayId, 2)).toBeNull();
  expect(await h.store.journal.audits.get(claim.auditId)).toMatchObject({
    status: "completed", outcome: "partial", target: { withdrawnBeforeDispatch: true },
  });
  for (const id of [operationId, h.outboundId]) {
    expect((await h.store.journal.operations.get(id))?.status).toBe("pending");
  }
});

it("does not restore the policy through withdrawal after dispatch", async () => {
  const h = sharedMaintenanceFixture();
  const claim = await h.acquire();
  await advanceSharedHeldReturnMaintenance(h.store, claim, "dispatched", () => 520, async () => {});
  const restoreMigrationPolicy = vi.fn();
  const readVerifiedWithdrawal = vi.fn();
  await expect(withdrawSharedHeldReturnMaintenance(h.store, claim, { restoreMigrationPolicy, readVerifiedWithdrawal, now: () => 550 }))
    .rejects.toThrow(/before image dispatch/);
  expect(restoreMigrationPolicy).not.toHaveBeenCalled();
  expect(readVerifiedWithdrawal).not.toHaveBeenCalled();
});

it("gives the reservation precedence over inbound and outbound queue claims, and retains it through verified rollback", async () => {
  const h = sharedMaintenanceFixture();
  const claim = await h.acquire();
  const heldReturn = await h.store.journal.operations.get(operationId);
  expect(heldNativeReturnBlocksDestination(heldReturn!, targetGatewayId)).toBe(true);
  expect(heldNativeReturnBlocksDestination(heldReturn!, sourceGatewayId)).toBe(false);
  expect(await resumeSharedHeldReturnMaintenance(h.store, claim.gatewayId, claim.attemptId)).toEqual(claim);
  expect(await assertSharedHeldReturnMaintenance(h.store, claim)).toBe("reserved");
  for (const blocked of [operationId, h.outboundId]) {
    const op = (await h.store.journal.operations.get(blocked))!;
    await expect(assertSharedHeldReturnMaintenanceUnfenced(h.store, op)).rejects.toThrow(/blocks this operation/);
    expect(op.status).toBe("pending");
  }
  const testOnlyOwnerAction = { input: { uid: h.admission.owners[2]!.uid }, gatewayId: "unrelated" };
  await expect(assertSharedHeldReturnMaintenanceUnfenced(h.store, testOnlyOwnerAction)).rejects.toThrow(/blocks this operation/);
  await advanceSharedHeldReturnMaintenance(h.store, claim, "dispatched", () => 520, async () => {});
  expect(await stageSharedHeldReturnMaintenanceRelease(h.store, claim, () => 522)).toBe(2);
  expect(await stageSharedHeldReturnMaintenanceRelease(h.store, claim, () => 523)).toBe(2);
  expect(await h.store.gateways.roots.get(targetGatewayId)).toMatchObject({ desiredRelease: 2, liveRelease: 1 });
  await expect(completeSharedHeldReturnMaintenance(h.store, claim, {
    readVerifiedResult: async () => { throw new Error("physical readiness unavailable"); },
    restoreMigrationPolicy: vi.fn(),
    readInstalledHelm: h.observeInstalledHelm, now: () => 525,
  })).rejects.toThrow(/readiness unavailable/);
  expect(await assertSharedHeldReturnMaintenance(h.store, claim)).toBe("dispatched");
  await advanceSharedHeldReturnMaintenance(h.store, claim, "rollback", () => 530);
  expect(await stageSharedHeldReturnMaintenanceRelease(h.store, claim, () => 535)).toBe(3);
  expect(await h.store.gateways.roots.get(targetGatewayId)).toMatchObject({ desiredRelease: 3, liveRelease: 1 });
  expect((await h.store.gateways.releases.get(targetGatewayId, 3))?.payload).toEqual(h.originalPayload);
  expect((await h.store.journal.operations.listByStatus(["pending"])).map(op => op.id).sort()).toEqual([operationId, h.outboundId].sort());
  const result: SharedHeldReturnMaintenanceResult = {
    attemptId: claim.attemptId, outcome: "rolled-back", workload: h.admission.workload, owners: h.admission.owners,
    images: h.admission.originalImages, runningImageIds: h.admission.originalImages, retainedBoot: h.admission.retainedBoot,
    nativeSource: h.admission.originalNativeSource, noInFlightTasks: true, noPreparedImports: true, exclusiveReady: true, verifiedAt: 540,
  };
  const complete = (readback: SharedHeldReturnMaintenanceResult, readInstalledHelm = h.observeInstalledHelm) =>
    completeSharedHeldReturnMaintenance(h.store, claim, { readVerifiedResult: async () => readback,
      restoreMigrationPolicy: async assertCurrent => { await assertCurrent(); }, readInstalledHelm, now: () => 550 });
  for (const invalid of [{ ...result, verifiedAt: 529 }, { ...result, images: h.admission.maintenanceImages },
    { ...result, workload: { ...result.workload, podUid: "replacement" } }]) {
    await expect(complete(invalid)).rejects.toThrow(/exact verified completion/);
    expect(await assertSharedHeldReturnMaintenance(h.store, claim)).toBe("rollback");
  }
  await expect(complete(result, async () => ({ ...await h.observeInstalledHelm(), chartFingerprint: "0".repeat(64) })))
    .rejects.toThrow(/canonical retained Helm/);
  await complete(result);
  expect(await h.store.gateways.roots.get(targetGatewayId)).toMatchObject({ desiredRelease: 3, liveRelease: 3 });
  expect((await h.store.journal.audits.get(claim.auditId))?.status).toBe("completed");
  expect((await h.store.gateways.roots.get(targetGatewayId))?.runtimeRestartFence).toBeUndefined();
  expect(heldNativeReturnBlocksDestination((await h.store.journal.operations.get(operationId))!, targetGatewayId)).toBe(false);
  expect((await h.store.journal.operations.get(operationId))?.status).toBe("pending");
  expect((await h.store.journal.operations.get(h.outboundId))?.status).toBe("pending");
});

it("publishes the immutable retained Shared release from normal health plus observed running images under the original boot env", async () => {
  const h = sharedMaintenanceFixture();
  const claim = await h.acquire();
  await advanceSharedHeldReturnMaintenance(h.store, claim, "dispatched", () => 520, async () => {});
  expect(await stageSharedHeldReturnMaintenanceRelease(h.store, claim, () => 525)).toBe(2);
  const root = await h.store.gateways.roots.get(targetGatewayId);
  expect(root).toMatchObject({ desiredRelease: 2, liveRelease: 1 });
  const staged = await h.store.gateways.releases.get(targetGatewayId, 2);
  expect(staged?.payload.openclawSourceSha).toBe(h.admission.acceptedNativeSource);
  const result: SharedHeldReturnMaintenanceResult = {
    attemptId: claim.attemptId, outcome: "installed", workload: h.admission.workload, owners: h.admission.owners,
    images: h.admission.maintenanceImages, runningImageIds: h.admission.maintenanceImages, retainedBoot: h.admission.retainedBoot,
    nativeSource: h.admission.acceptedNativeSource, noInFlightTasks: true, noPreparedImports: true, exclusiveReady: true, verifiedAt: 540,
  };
  const restoreMigrationPolicy = vi.fn(async (assertCurrent: () => Promise<void>) => {
    await assertCurrent();
    await expect(advanceSharedHeldReturnMaintenance(h.store, claim, "rollback")).rejects.toThrow(/completing/);
  }).mockRejectedValueOnce(new Error("could not restore and verify ingress"));
  const complete = (readback: SharedHeldReturnMaintenanceResult) => completeSharedHeldReturnMaintenance(h.store, claim, {
    readVerifiedResult: async () => readback,
    restoreMigrationPolicy,
    readInstalledHelm: async () => {
      const previous = await h.observeInstalledHelm();
      return { ...previous, installed: { ...previous.installed, imageTag: staged!.payload.imageTag },
        edgeImage: h.admission.maintenanceImages["gateway-edge"] };
    },
    now: () => 550,
  });
  await expect(complete({ ...result, runningImageIds: h.admission.originalImages })).rejects.toThrow(/exact verified completion/);
  expect(restoreMigrationPolicy).not.toHaveBeenCalled();
  await expect(complete(result)).rejects.toThrow("could not restore and verify ingress");
  expect(await h.store.gateways.roots.get(targetGatewayId)).toMatchObject({
    desiredRelease: 2, liveRelease: 1, runtimeRestartFence: { restoringMigrationPolicy: true },
  });
  expect(await assertSharedHeldReturnMaintenance(h.store, claim)).toBe("dispatched");
  await complete(result);
  expect(restoreMigrationPolicy).toHaveBeenCalledTimes(2);
  expect(await h.store.gateways.roots.get(targetGatewayId)).toMatchObject({ desiredRelease: 2, liveRelease: 2 });
  expect((await h.store.fleetRegistry.get(targetGatewayId))?.heartbeat.version).toBe("abcdef1");
  const stillHeld = await h.store.journal.operations.get(operationId);
  expect(stillHeld?.status).toBe("pending");
  expect((await h.store.gateways.roots.get(targetGatewayId))?.runtimeRestartFence).toBeUndefined();
  expect(heldNativeReturnBlocksDestination(stillHeld!, targetGatewayId)).toBe(true);
  await expect(assertSharedHeldReturnMaintenanceUnfenced(h.store, stillHeld!)).rejects.toThrow(/offline source custody/);
});

function exclusionFixture() {
  const h = sharedMaintenanceFixture();
  const proof = {
    gatewayId: targetGatewayId, podUid: h.admission.workload.podUid, release: 1,
    payloadHash: releasePayloadHash(h.originalPayload), artifactSetId: "sealed-role-artifact",
    verifiedCommonArchiveSha256: "e".repeat(64),
    images: { gateway: h.originalPayload.imageTag.split("@").at(-1)!, "gateway-edge": h.originalPayload.gatewayEdgeImage.imageTag.split("@").at(-1)! },
  };
  const provider = {
    readRetainedCompletion: vi.fn(async () => proof),
    verifyPod: vi.fn(async (_reservation, assertCurrent: () => Promise<void>) => assertCurrent()),
    verifyStores: vi.fn(async (_scope, assertCurrent: () => Promise<void>) => assertCurrent()),
    verifyWholeRetirement: vi.fn(async (_gatewayId, assertCurrent: () => Promise<void>) => { await assertCurrent(); return true; }),
  };
  const deps = { store: h.store, provider, now: () => 550 };
  return { ...h, proof, provider, deps, exclusion: createNativeReturnTargetExclusion(deps), actor: "test-operator" };
}

it("persists owner-scoped denial before physical verification and refuses the rollback verifier without a real matching witness", async () => {
  const h = exclusionFixture();
  const before = structuredClone(h.docs);
  await expect(createNativeReturnTargetExclusion({ ...h.deps, provider: undefined }).reserve("test", h.actor, selection)).rejects.toThrow(/physical provider/);
  expect(h.docs).toEqual(before);
  const reserved = await h.exclusion.reserve("test", h.actor, selection);
  await expect(h.exclusion.reserve("test", h.actor, selection)).resolves.toEqual(reserved);
  expect(await nativeReturnTargetDenied(h.store, uid, targetGatewayId)).toBe(true);
  expect(await nativeReturnTargetDenied(h.store, uid, sourceGatewayId)).toBe(false);
  h.docs.set("gateways/shared-other", { ...h.docs.get(`gateways/${targetGatewayId}`), gatewayId: "shared-other" });
  expect(await nativeReturnTargetDenied(h.store, uid, "shared-other")).toBe(true);
  expect(await nativeReturnSharedStoreHandoffDenied(h.store, uid)).toBe(true);
  for (const owner of h.admission.owners) {
    expect(await nativeReturnTargetDenied(h.store, owner.uid, targetGatewayId)).toBe(false);
    expect(await nativeReturnSharedStoreHandoffDenied(h.store, owner.uid)).toBe(false);
  }
  await expect(h.exclusion.verifyOldTargetExclusion(reserved.scope)).rejects.toThrow(/durable verified exclusion missing/);
  h.provider.readRetainedCompletion.mockResolvedValueOnce({ ...h.proof, podUid: "different-pod" });
  await expect(h.exclusion.verifyReserved(h.actor, reserved)).rejects.toThrow(/completion mismatch/);
  expect(h.provider.verifyStores).not.toHaveBeenCalled();
});

it("keeps the verified former-target hold after the owner migration fence and operation are completed", async () => {
  const h = exclusionFixture();
  const reserved = await h.exclusion.reserve("test", h.actor, selection);
  await h.exclusion.verifyReserved(h.actor, reserved);
  await h.store.users.records.setFence(uid, "migration", { clear: true });
  await h.store.journal.operations.patch(operationId, { status: "failed", rolledBack: true });
  const restarted = createNativeReturnTargetExclusion(h.deps);
  await expect(restarted.verifyOldTargetExclusion(reserved.scope)).resolves.toBeUndefined();
  await expect(restarted.verifyOldTargetExclusion({ ...reserved.scope, schedulerMigrationId: "unrelated" })).rejects.toThrow(/verified exclusion missing/);
  expect(await nativeReturnTargetDenied(h.store, uid, targetGatewayId)).toBe(true);
  h.provider.readRetainedCompletion.mockResolvedValueOnce({ ...h.proof, images: { ...h.proof.images, gateway: "sha256:" + "9".repeat(64) } });
  await expect(restarted.verifyOldTargetExclusion(reserved.scope)).rejects.toThrow(/published Shared release/);
  expect(await nativeReturnTargetDenied(h.store, uid, targetGatewayId)).toBe(true);
});

it("lifts only Shared-wide quarantine after a completed rollback and independently verified whole retirement", async () => {
  const h = exclusionFixture();
  const { scope } = await h.exclusion.reserve("test", h.actor, selection);
  await h.exclusion.verifyReserved(h.actor, { scope, podUid: h.proof.podUid });
  const source = `gateways/${sourceGatewayId}/assignments/${uid}`;
  h.docs.set(source, { ...h.docs.get(source), state: "serving" });
  await h.store.users.records.setFence(uid, "migration", { clear: true });
  await h.store.journal.operations.patch(operationId, { status: "failed", completedAt: 510,
    rolledBack: true, schedulerHandoffReleased: true, input: { ...h.operations.input, compensatingNativeReturn: scope } });
  await expect(h.exclusion.releaseSharedHandoff("test", h.actor, scope)).rejects.toThrow(/whole retirement missing/);
  const target = `gateways/${targetGatewayId}`;
  h.docs.delete(target);
  h.docs.delete(targetRuntimePath);
  for (const other of h.admission.owners) h.docs.delete(`${target}/assignments/${other.uid}`);
  for (const [path, data] of h.docs) {
    if (path.startsWith("users/") && path !== ownerPath) {
      const current = structuredClone(data);
      const provisioning = current.provisioning as { openclaw?: Record<string, unknown> } | undefined;
      if (provisioning?.openclaw?.gatewayId === targetGatewayId) {
        provisioning.openclaw.gatewayId = "shared-successor";
        h.docs.set(path, current);
      }
    }
  }
  const retirementId = `shared-pool-retire-${targetGatewayId}`;
  const retirementPath = `glmOperations/${retirementId}`;
  h.docs.set(retirementPath, { kind: "retire-gateway", status: "succeeded", gatewayId: targetGatewayId,
    createdAt: 520, completedAt: 530, input: { gatewayId: targetGatewayId, source: "shared-pool-scaler", retirementClaimVersion: 1 },
    steps: [{ name: "helm-uninstall", status: "done" }, { name: "revoke-agent-store-credentials", status: "done" }] });
  h.provider.verifyWholeRetirement.mockResolvedValueOnce(false);
  await expect(h.exclusion.releaseSharedHandoff("test", h.actor, scope)).rejects.toThrow(/runtime or credential still exists/);
  expect(await nativeReturnSharedStoreHandoffDenied(h.store, uid)).toBe(true);
  await h.exclusion.releaseSharedHandoff("test", h.actor, scope);
  await h.exclusion.releaseSharedHandoff("test", h.actor, scope);
  expect(await nativeReturnSharedStoreHandoffDenied(h.store, uid)).toBe(false);
  expect(await nativeReturnTargetDenied(h.store, uid, targetGatewayId)).toBe(true);
  h.docs.set(targetRuntimePath, h.targetRuntime);
  expect(await nativeReturnSharedStoreHandoffDenied(h.store, uid)).toBe(true);
});

function inertPriorFixture(claim: Awaited<ReturnType<ReturnType<typeof sharedMaintenanceFixture>["acquire"]>>) {
  return {
    attemptId: claim.attemptId, podUid: claim.plan.workload.podUid, artifactSetId: "e".repeat(64),
    originalContainerIds: { gateway: "old-gateway", "gateway-edge": "old-edge" },
    ownerBackups: claim.plan.owners.map((owner, index) => ({ ...owner, restoredArchiveSha256: index.toString(16).repeat(64) })),
  };
}

it("separately authorizes inert replacement and refuses any stock authority before a verified current common restore", async () => {
  const h = sharedMaintenanceFixture();
  const claim = await h.acquire();
  const prior = inertPriorFixture(claim);
  await expect(authorizeSharedInertMaintenance(h.store, claim, async () => ({ ...prior, ownerBackups: prior.ownerBackups.slice(1) }), () => 510))
    .rejects.toThrow("all six independently verified owner backups");
  await authorizeSharedInertMaintenance(h.store, claim, async assertCurrent => { await assertCurrent(); return prior; }, () => 510);
  await expect(assertSharedInertPreLaunch(h.store, claim)).resolves.toEqual(prior);
  const ordinaryDispatch = vi.fn();
  await expect(advanceSharedHeldReturnMaintenance(h.store, claim, "dispatched", () => 515, ordinaryDispatch)).rejects.toThrow("dispatched or withdrawn");
  expect(ordinaryDispatch).not.toHaveBeenCalled();
  await expect(stageSharedHeldReturnMaintenanceRelease(h.store, claim, () => 515)).rejects.toThrow("before dispatch");
  await expect(readAuthorizedSharedInertStock(h.store, claim)).rejects.toThrow("no launch-authorized common restore");
  const { ownerBackups: _priorBackups, ...binding } = prior;
  const common = {
    ...binding, heldContainerIds: { gateway: "held-gateway", "gateway-edge": "held-edge" },
    observedImageIds: claim.plan.maintenanceImages, ownerHomes: claim.plan.owners,
    custodyGeneration: "b".repeat(64), restoredArchiveSha256: "c".repeat(64),
    writersHeldAt: 520, capturedAt: 530, restoredAt: 540,
  };
  for (const observed of [
    { ...common, capturedAt: 512 },
    { ...common, observedImageIds: claim.plan.originalImages },
    { ...common, heldContainerIds: { ...common.heldContainerIds, gateway: prior.originalContainerIds.gateway } },
  ]) {
    await expect(authorizeSharedInertStockLaunch(h.store, claim, async () => observed, () => 550)).rejects.toThrow("verified common restore");
  }
  await authorizeSharedInertStockLaunch(h.store, claim, async assertCurrent => { await assertCurrent(); return common; }, () => 550);
  await expect(readAuthorizedSharedInertStock(h.store, claim)).resolves.toEqual(common);
  await expect(assertSharedInertPreLaunch(h.store, claim)).rejects.toThrow("no longer permits");
  await expect(rollbackSharedInertBeforeStock(h.store, claim, vi.fn())).rejects.toThrow("no longer permits");
  await expect(advanceSharedHeldReturnMaintenance(h.store, claim, "rollback", () => 555)).rejects.toThrow("distinct inert launch authority");
  await expect(advanceSharedHeldReturnMaintenance(h.store, claim, "dispatched", () => 557)).resolves.toBeUndefined();
  await expect(stageSharedHeldReturnMaintenanceRelease(h.store, claim, () => 560)).resolves.toBe(2);
});

it("permits a retried pre-launch rollback only with verified original role and six-owner custody", async () => {
  const h = sharedMaintenanceFixture();
  const claim = await h.acquire();
  const prior = inertPriorFixture(claim);
  await authorizeSharedInertMaintenance(h.store, claim, async () => prior, () => 510);
  const original = {
    attemptId: claim.attemptId, outcome: "rolled-back" as const, workload: claim.plan.workload, owners: claim.plan.owners,
    images: claim.plan.originalImages, runningImageIds: claim.plan.originalImages, retainedBoot: claim.plan.retainedBoot,
    nativeSource: claim.plan.originalNativeSource, noInFlightTasks: true, noPreparedImports: true, exclusiveReady: true, verifiedAt: 540,
  } as const;
  await expect(rollbackSharedInertBeforeStock(h.store, claim, async assertCurrent => {
    await assertCurrent();
    await expect(assertSharedInertPreLaunch(h.store, claim)).rejects.toThrow("no longer permits");
    return { ...original, verifiedAt: 510 };
  }, () => 520)).rejects.toThrow("exact verified completion");
  await expect(rollbackSharedInertBeforeStock(h.store, claim, async current => { await current(); return original; }, () => 550))
    .resolves.toBeUndefined();
  await expect(readAuthorizedSharedInertStock(h.store, claim)).rejects.toThrow("no launch-authorized common restore");
  expect(await h.store.gateways.roots.get(targetGatewayId)).toMatchObject({ desiredRelease: 1, latestRelease: 1, liveRelease: 1 });
});
