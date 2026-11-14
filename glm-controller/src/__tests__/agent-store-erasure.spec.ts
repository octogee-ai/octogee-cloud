import { describe, expect, it, vi } from "vitest";
import { UserErasureBlockedError, createUserAgentStoreErasure, preserveUserGatewayRetirement } from "../lib/user-ops/agent-store-erasure.js";
import { AgentStoreErasureRetainedLoginError, type AgentStoreErasureCustody } from "@octogee/core/agent-store-credentials";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

function root(gatewayId: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { gatewayId, latestRelease: 1, desiredRelease: 1, liveRelease: 1, ...fields };
}

function assignment(gatewayId: string, uid: string): Record<string, unknown> {
  return { uid, slug: "alice", gatewayId, source: "onboarding", state: "serving", epoch: 1 };
}

function transferTask(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: "migration-transfer", migrationId: "move-1", slug: "other", mode: "final", sourceGatewayId: "shared-a",
    targetGatewayId: "shared-b", status: "running", attempt: 1, attemptId: "attempt-1", createdAt: 1, updatedAt: 1, startedAt: 1,
    ...fields,
  };
}

function harness() {
  const cleanup = { uid: "uid-1", slug: "alice", currentGatewayId: "shared-old" as string | null, projectSlugs: [] };
  const operation = { id: "erase-1", kind: "erase-user", status: "running", startedAt: 10, input: { uid: "uid-1", deletionId: "delete-1" } };
  const records: Record<string, Record<string, any>> = {
    "customerDeletionJobs/delete-1": { version: 1, uid: cleanup.uid, slug: cleanup.slug, currentGatewayId: cleanup.currentGatewayId,
      erasureOperationId: operation.id, status: "hibernating", requestedBy: "operator", requestedAt: 1, eraseAfter: 5, cleanupContext: cleanup },
    "users/uid-1": { username: "alice", accountLifecycle: { status: "deletion_scheduled", deletionId: "delete-1", eraseAfter: 5 }, provisioning: { openclaw: {} } },
    "glmOperations/erase-1": operation,
  };
  const store = createDocumentFixtureStore(records);
  const target = { namespace: "octogee_agent_one", namespaceOid: "123", owner: "shared", family: "agent" as const, role: "agent" as const,
    storeId: "d57c47b6-c455-4c58-a30e-30dc01d7d80a", agentId: "octogee-alice-coach" };
  const deps = {
    store, now: () => 20,
    sharedGatewayRetired: vi.fn(async () => true), runtimeAbsent: vi.fn(async () => true), ownerHomeAbsent: vi.fn(async () => true),
    eraseVm: vi.fn(async (_uid: string) => undefined),
    readSharedSource: vi.fn(async (_gatewayId: string) => ({ gatewayId: "shared-old", podUid: "pod-original", startedAt: 1,
      status: "ready", customers: ["ceckert-test"], migratingIn: [] })),
    unmountSharedUser: vi.fn(async () => undefined),
    eraseStores: vi.fn(async (_cleanup, custody: AgentStoreErasureCustody) => {
      await custody.assertWritersStopped([target]);
      const bound = await custody.bindTargets([target]);
      expect(bound).toEqual([target]);
      await custody.assertCurrent();
    }),
  };
  const claim = vi.fn(async () => undefined);
  return { records, store, deps, target, cleanup, operation, claim,
    run: () => createUserAgentStoreErasure(deps)(cleanup as never, "delete-1", operation as never, claim) };
}

function liveSharedGateway() {
  const h = harness(); h.deps.sharedGatewayRetired.mockResolvedValue(false);
  h.records["customerDeletionJobs/delete-1"]!.suspensionOperationId = "suspend-1";
  h.records["glmOperations/suspend-1"] = { id: "suspend-1", kind: "suspend-user", status: "succeeded",
    input: { uid: "uid-1", deletionId: "delete-1" }, steps: [{ name: "unmount-gateway", status: "done" }] };
  return h;
}

function custody(agentId: string, gatewayId: string): Record<string, Record<string, unknown>> {
  return { [`users/uid-1/agentStores/${agentId}`]: {
    agentId, gatewayId, assignmentEpoch: 1, storeId: "d57c47b6-c455-4c58-a30e-30dc01d7d80a", schema: "octogee_agent_one", recordedAt: 1,
  } };
}

function unassignedBeforeDeletion(custodyRecords = custody("octogee-alice-coach", "shared-old")) {
  const h = liveSharedGateway();
  h.cleanup.currentGatewayId = null;
  h.records["customerDeletionJobs/delete-1"]!.currentGatewayId = null;
  h.records["glmOperations/suspend-1"]!.steps = [{ name: "unmount-gateway", status: "skipped" }];
  Object.assign(h.records, custodyRecords);
  return h;
}

describe("PostgreSQL erasure of a user who was unassigned before deletion", () => {
  it("stops writers on the shared gateway that last held the user's agent stores, then erases", async () => {
    const h = unassignedBeforeDeletion();
    await h.run();
    expect(h.deps.unmountSharedUser).toHaveBeenCalledExactlyOnceWith("shared-old", h.cleanup, {
      podUid: "pod-original", agentIds: [h.target.agentId],
    }, h.operation);
    expect(h.records["customerDeletionJobs/delete-1"]!.sharedAgentStoreCleanup).toMatchObject({ gatewayId: "shared-old", complete: true });
    expect(h.records["customerDeletionJobs/delete-1"]!.postgresAgentStoreTargets).toEqual([h.target]);
  });

  it("records the source on the deletion job and reuses it once cloud cleanup has removed the user and their custody records", async () => {
    const h = unassignedBeforeDeletion();
    await h.run();
    expect(h.records["customerDeletionJobs/delete-1"]!.currentGatewayId).toBe("shared-old");
    delete h.records["users/uid-1"];
    delete h.records["users/uid-1/agentStores/octogee-alice-coach"];

    await h.run();

    expect(h.deps.unmountSharedUser).toHaveBeenCalledOnce();
    expect(h.records["customerDeletionJobs/delete-1"]!.currentGatewayId).toBe("shared-old");
  });

  it("treats a retired custody gateway as stopped", async () => {
    const h = unassignedBeforeDeletion(); h.deps.sharedGatewayRetired.mockResolvedValue(true);
    await h.run();
    expect(h.deps.sharedGatewayRetired).toHaveBeenCalledWith("shared-old");
    expect(h.deps.unmountSharedUser).not.toHaveBeenCalled();
  });

  it.each([
    ["no gateway", {}],
    ["two gateways", { ...custody("octogee-alice-coach", "shared-old"), ...custody("octogee-alice-proj-orbit-coach", "shared-new") }],
    ["an isolated gateway", custody("octogee-alice-coach", "builder-old")],
  ])("ends as blocked when custody names %s", async (_label, custodyRecords) => {
    const h = unassignedBeforeDeletion(custodyRecords);
    const failure = await h.run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UserErasureBlockedError);
    expect((failure as Error).message).toContain("unassigned before deletion");
    expect(h.deps.unmountSharedUser).not.toHaveBeenCalled();
    expect(h.records["customerDeletionJobs/delete-1"]!.postgresAgentStoreTargets).toBeUndefined();
    expect(h.records["customerDeletionJobs/delete-1"]!.currentGatewayId).toBeNull();
  });

  it("refuses while other work touches the custody gateway", async () => {
    const h = unassignedBeforeDeletion();
    h.records["glmMigrationTransferTasks/move-1__final"] = transferTask({ sourceGatewayId: "shared-old" });
    await expect(h.run()).rejects.toThrow("conflicting runtime work");
    expect(h.deps.unmountSharedUser).not.toHaveBeenCalled();
  });

  it("still requires a completed unmount when the deletion captured its gateway", async () => {
    const h = liveSharedGateway();
    h.records["glmOperations/suspend-1"]!.steps = [{ name: "unmount-gateway", status: "skipped" }];
    await expect(h.run()).rejects.toThrow("lacks completed suspension");
    expect(h.deps.unmountSharedUser).not.toHaveBeenCalled();
  });
});

describe("due user PostgreSQL erasure authority", () => {
  it("uses captured consent without current assignment and persists targets before erasure", async () => {
    const h = harness();
    await h.run();
    expect(h.records["customerDeletionJobs/delete-1"]!.postgresAgentStoreTargets).toEqual([h.target]);
    expect(h.deps.sharedGatewayRetired).toHaveBeenCalledWith("shared-old");
    await h.run();
  });

  it.each([
    ["early deadline", "customerDeletionJobs/delete-1", { eraseAfter: 30 }],
    ["foreign operation", "customerDeletionJobs/delete-1", { erasureOperationId: "other" }],
    ["changed cleanup", "customerDeletionJobs/delete-1", { cleanupContext: { uid: "other" } }],
    ["captured gateway replaced on the job", "customerDeletionJobs/delete-1", { currentGatewayId: "shared-other" }],
    ["claimed again", "glmOperations/erase-1", { startedAt: 11 }],
    ["operation retargeted", "glmOperations/erase-1", { input: { uid: "uid-1", deletionId: "delete-other" } }],
    ["cancelled", "glmOperations/erase-1", { cancellationRequestedAt: 12 }],
    ["reactivated", "users/uid-1", { accountLifecycle: { status: "active" } }],
    ["restoring", "users/uid-1", { provisioning: { openclaw: { restoreFence: {} } } }],
    ["reassigned", "users/uid-1", { provisioning: { openclaw: { gatewayId: "shared-new" } } }],
    ["assignment", "gateways/shared-new/assignments/uid-1", assignment("shared-new", "uid-1")],
    ["migration", "glmOperations/migration", { status: "running", input: { uid: "uid-1" } }],
    ["owned running host", "gateways/builder-old", root("builder-old", { ownerUid: "uid-1", gatewayClass: "isolated", desiredStatus: "running" })],
    ["user transfer", "glmMigrationTransferTasks/move-1__final", transferTask({ slug: "alice" })],
    ["transfer from the captured gateway", "glmMigrationTransferTasks/move-1__final", transferTask({ sourceGatewayId: "shared-old" })],
    ["transfer into the captured gateway", "glmMigrationTransferTasks/move-1__final", transferTask({ targetGatewayId: "shared-old" })],
  ])("refuses %s before invoking the database owner", async (_label, path, patch) => {
    const h = harness();
    h.records[path as string] = { ...h.records[path as string], ...patch as object };
    await expect(h.run()).rejects.toThrow();
    expect(h.deps.eraseStores).not.toHaveBeenCalled();
  });

  it("does not interpret historical hibernation as old Shared retirement", async () => {
    const h = harness(); h.deps.sharedGatewayRetired.mockResolvedValue(false);
    h.deps.readSharedSource.mockResolvedValue(null as never);
    await expect(h.run()).rejects.toThrow("awaits captured Shared retirement");
    expect(h.records["customerDeletionJobs/delete-1"]!.postgresAgentStoreTargets).toBeUndefined();
    expect(h.deps.eraseVm).not.toHaveBeenCalled();
  });

  it("completes exact user cleanup on a live shared gateway that still serves another user", async () => {
    const h = liveSharedGateway();
    await h.run();
    expect(h.deps.unmountSharedUser).toHaveBeenCalledExactlyOnceWith("shared-old", h.cleanup, {
      podUid: "pod-original", agentIds: [h.target.agentId],
    }, h.operation);
    expect(h.records["customerDeletionJobs/delete-1"]!.sharedAgentStoreCleanup).toMatchObject({
      gatewayId: "shared-old", podUid: "pod-original", startedAt: 1, agentIds: [h.target.agentId], complete: true,
    });
    await h.run();
    expect(h.deps.unmountSharedUser).toHaveBeenCalledOnce();
  });

  it("requires exact Native cleanup coverage for a PG-only project", async () => {
    const h = liveSharedGateway();
    const targets = [h.target, { ...h.target, namespace: "project", agentId: "octogee-alice-proj-hidden-coach" }];
    h.deps.eraseStores.mockImplementation(async (_cleanup, custody) => {
      await custody.assertWritersStopped(targets);
      await custody.bindTargets(targets);
    });
    await h.run();
    expect(h.deps.unmountSharedUser).toHaveBeenCalledWith("shared-old", h.cleanup, {
      podUid: "pod-original", agentIds: targets.map(target => target.agentId),
    }, h.operation);
  });

  it.each([null, { status: "booting" }, { gatewayId: "shared-replacement" }, { podUid: "" }, { startedAt: NaN }])(
    "refuses missing or invalid Shared runtime before Native effects: %j", async change => {
      const h = liveSharedGateway();
      h.deps.readSharedSource.mockResolvedValue(change === null ? null as never : { ...await h.deps.readSharedSource("shared-old"), ...change });
      await expect(h.run()).rejects.toThrow("awaits captured Shared retirement");
      expect(h.deps.unmountSharedUser).not.toHaveBeenCalled();
    });

  it.each([{ podUid: "recreated-pod" }, { startedAt: 2 }, { status: "booting" }, { customers: ["alice", "ceckert-test"] }])(
    "does not publish completion after the Shared source changes: %j", async change => {
      const h = liveSharedGateway(); const source = await h.deps.readSharedSource("shared-old");
      h.deps.readSharedSource.mockResolvedValueOnce(source).mockResolvedValueOnce({ ...source, ...change });
      await expect(h.run()).rejects.toThrow("Shared runtime changed");
      expect(h.records["customerDeletionJobs/delete-1"]!.sharedAgentStoreCleanup.complete).toBe(false);
    });

  it("refuses a recreated Shared process instead of adopting its old cleanup proof", async () => {
    const h = liveSharedGateway(); await h.run();
    h.deps.readSharedSource.mockResolvedValue({ ...await h.deps.readSharedSource("shared-old"), startedAt: 2 });
    await expect(h.run()).rejects.toThrow("Shared source or agent coverage changed");
    expect(h.deps.unmountSharedUser).toHaveBeenCalledOnce();
  });

  it("requires succeeded suspension for this exact due deletion before Native effects", async () => {
    const h = liveSharedGateway(); h.records["glmOperations/suspend-1"]!.input.deletionId = "other";
    await expect(h.run()).rejects.toThrow("lacks completed suspension");
    expect(h.deps.unmountSharedUser).not.toHaveBeenCalled();
  });

  it("rechecks deletion authority after waiting for retirement", async () => {
    const h = harness();
    h.deps.sharedGatewayRetired.mockImplementation(async () => {
      h.records["users/uid-1"]!.provisioning.openclaw.restoreFence = {};
      return true;
    });
    await expect(h.run()).rejects.toThrow("due deletion job");
    expect(h.records["customerDeletionJobs/delete-1"]!.postgresAgentStoreTargets).toBeUndefined();
  });

  it("uses existing VM erasure and refuses while its home remains", async () => {
    const h = harness(); h.deps.ownerHomeAbsent.mockResolvedValue(false);
    await expect(h.run()).rejects.toThrow("retained a gateway VM or home");
    expect(h.deps.eraseVm).toHaveBeenCalledWith("uid-1");
    expect(h.records["customerDeletionJobs/delete-1"]!.postgresAgentStoreTargets).toBeUndefined();
  });

  it("erases without a VM or home check on a platform that runs no VM gateways", async () => {
    const h = harness();
    const { ownerHomeAbsent: _ownerHomeAbsent, eraseVm: _eraseVm, ...deps } = h.deps;

    await createUserAgentStoreErasure(deps)(h.cleanup as never, "delete-1", h.operation as never, h.claim);

    expect(h.deps.eraseStores).toHaveBeenCalledOnce();
    expect(h.records["customerDeletionJobs/delete-1"]!.postgresAgentStoreTargets).toEqual([h.target]);
  });

  it("ends as blocked when the database retains a user Gateway login without proved retirement", async () => {
    const h = harness();
    const retained = new AgentStoreErasureRetainedLoginError("Agent-store erasure retains a user Gateway login without proved runtime retirement: octogee_gateway_stale");
    h.deps.eraseStores.mockRejectedValue(retained);
    const failure = await h.run().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UserErasureBlockedError);
    expect(failure).toMatchObject({ message: retained.message, cause: retained });
  });

  it("requires preserved user retirement and actual runtime absence", async () => {
    const h = harness(); h.cleanup.currentGatewayId = "builder-old";
    h.records["customerDeletionJobs/delete-1"]!.currentGatewayId = "builder-old";
    await expect(h.run()).rejects.toThrow("lacks its captured user retirement proof");
    const proof = { gatewayId: "builder-old", operationId: "retire-old", version: 1, completedAt: 15, runtime: "cluster" as const };
    await preserveUserGatewayRetirement(h.store, "uid-1", "delete-1", proof);
    h.deps.runtimeAbsent.mockResolvedValue(false);
    await expect(h.run()).rejects.toThrow("retained a gateway runtime");
    h.deps.runtimeAbsent.mockResolvedValue(true);
    await h.run();
    expect(h.deps.runtimeAbsent).toHaveBeenCalledWith("builder-old", "cluster");
  });
});
