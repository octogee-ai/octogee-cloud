import { gatewayScopedJobId, verifyFleetRequest } from "@octogee/core/fleet-signature";
import { SIGNATURE_HEADER } from "@octogee/shared/types/fleet-controller";
import { createHeldNativeReturnDestinationVerifier } from "../lib/held-native-return-destination.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { bindHeldNativeStoppedOriginal, heldNativeReturnBlocksDestination, requestHeldNativeReturnRepair, reserveHeldNativeOfflineSource } from "@octogee/core/fleet-state";
import type { Operation } from "@octogee/shared/types/glm";
import { expect, it, vi } from "vitest";
import { createHeldNativeOfflineReturnWorker, createHeldNativeReturnWorker } from "../lib/held-native-return-worker.js";

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
  await store.journal.operations.patch(operationId, { status: "running", startedAt: 600 });
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
  expect((await store.gateways.assignments.get(sourceGatewayId, uid))?.state).toBe("quiescing");
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
