import { expect, it, vi } from "vitest";
import type { SchedulerMigrationRequest, SchedulerMigrationResult } from "@octogee/shared/types/fleet-controller";
import { reconcileSurgeUserHandoff, type SurgePod, type SurgeUserHandoffDeps } from "../surge-user-handoff.js";
import { oldPod, targetPod, assignment, createSurgeHandoffHarness } from "./fixtures/surge-user-handoff.js";

it.each([false, true])("preserves an existing Native job through a complete-roster Shared surge (enabled=%s)", async enabled => {
  const job = {
    id: "6b3353c2-d7eb-4e71-a3fb-b86a137ddf50",
    agentId: "octogee-alice-coach",
    name: "retained schedule",
    enabled,
    schedule: { kind: "at", at: "2099-01-01T00:00:00.000Z" },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "synthetic continuity fixture", toolsAllow: [] },
    delivery: { mode: "none" },
  };
  const scratch = [{ jobId: job.id, content: "retained scratch", revision: 3, updatedAtMs: 10, sourceSha256: "a".repeat(64) }];
  const jobs = new Map([[oldPod.uid, [job]], [targetPod.uid, [] as typeof job[]]]);
  const scratchByPod = new Map([[oldPod.uid, scratch], [targetPod.uid, [] as typeof scratch]]);
  const statuses = new Map<string, string>();
  const scheduler = vi.fn(async (input: SchedulerMigrationRequest & { gatewayId: string; slug: string; pod: SurgePod }): Promise<SchedulerMigrationResult> => {
    const key = `${input.pod.uid}:${input.operationId}`;
    const agentIds = input.agentIds ?? [job.agentId];
    if (input.phase === "hold") statuses.set(key, "held");
    if (input.phase === "export") {
      expect(input.resolveAgentScope).toBe(true);
      statuses.set(key, "exported");
      return { operationId: input.operationId, phase: input.phase, drained: true, agentIds,
        snapshot: { version: 1, operationId: input.operationId, agentIds, jobs: jobs.get(input.pod.uid), scratch: scratchByPod.get(input.pod.uid) } };
    }
    if (input.phase === "stage") {
      expect(statuses.get(key)).toBeUndefined();
      const snapshot = input.snapshot as { operationId: string; jobs: typeof job[]; scratch: typeof scratch };
      expect(snapshot.operationId).toBe(input.operationId);
      jobs.set(input.pod.uid, structuredClone(snapshot.jobs));
      scratchByPod.set(input.pod.uid, structuredClone(snapshot.scratch));
      statuses.set(key, "staged");
    }
    if (input.phase === "activate") {
      expect(statuses.get(key)).toBe("staged");
      statuses.set(key, "activated");
    }
    if (input.phase === "retire") {
      expect(statuses.get(key)).toBe("exported");
      jobs.set(input.pod.uid, []);
      statuses.set(key, "retired");
    }
    return { operationId: input.operationId, phase: input.phase, drained: true, agentIds };
  });
  const pods = [{ ...oldPod }, { ...targetPod }];
  const targetMountedUsers: string[] = [];
  const h = createSurgeHandoffHarness(vi.fn, { pods, targetMountedUsers, assignments: [assignment("u1", "alice")] });
  const transfer = h.deps.transfer;
  h.deps.transfer = vi.fn(async input => {
    await transfer(input);
    targetMountedUsers.push(input.slug);
  });
  const deps = Object.assign(h.deps, { scheduler });
  const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true, };
  await expect(reconcileSurgeUserHandoff(deps, input)).resolves.toEqual({ ready: false });
  pods.splice(0, pods.length, { ...targetPod, ready: true });
  await expect(reconcileSurgeUserHandoff(deps, input)).resolves.toEqual({ ready: true });
  expect(h.assignments()[0].state).toBe("serving");
  expect(jobs.get(targetPod.uid)).toEqual([job]);
  expect(scratchByPod.get(targetPod.uid)).toEqual(scratch);
});

it("rolls back an interrupted imported Shared roster only with retained Native export and confirmed target abort", async () => {
  const row = assignment("u1", "alice", { state: "quiescing", updatedByOperationId: "surge-default-target-uid", updatedAt: 7 });
  const sourceMountedUsers: string[] = [];
  const h = createSurgeHandoffHarness(vi.fn, { assignments: [row], sourceMountedUsers, targetMountedUsers: ["alice"] });
  const calls: string[] = [];
  h.deps.scheduler = vi.fn(async request => {
    calls.push(`${request.pod.uid}:${request.phase}`);
    if (request.phase === "hold") throw new Error("must not invent a new hold to prove interrupted custody");
    return { operationId: request.operationId, phase: request.phase, drained: true, agentIds: ["octogee-alice-coach"],
      ...(request.phase === "export" ? { snapshot: { retained: true } } : {}) };
  });
  h.deps.discardTargetUser = vi.fn(async () => { calls.push("discard-target"); });
  h.deps.resumeSourceIngress = vi.fn(async () => { calls.push("resume-ingress"); sourceMountedUsers.push("alice"); });
  await expect(reconcileSurgeUserHandoff(h.deps, {
    gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
  })).resolves.toEqual({ ready: false });
  expect(calls).toEqual(["old-uid:export", "target-uid:abort", "discard-target", "resume-ingress", "old-uid:resume"]);
  expect(h.assignments()[0].state).toBe("serving");
  expect(h.deps.transfer).not.toHaveBeenCalled();
  expect(h.deps.releaseTarget).not.toHaveBeenCalled();
});

it("keeps an abandoned Shared gate closed with only a source pod and no Native custody settlement", async () => {
  const h = createSurgeHandoffHarness(vi.fn, { pods: [oldPod], assignments: [assignment("u1", "alice", {
    state: "quiescing", updatedByOperationId: "surge-default-11111111-2222-4333-8444-555555555555",
  })] });
  const readHealth = h.deps.readPodHealth;
  h.deps.readPodHealth = vi.fn<SurgeUserHandoffDeps["readPodHealth"]>(async (...args) => ({ ...(await readHealth(...args))!, handoffReleased: true, prelaunchState: "serving" }));
  h.deps.scheduler = vi.fn(async () => { throw new Error("Cron migration must acquire hold before this phase"); });
  await expect(reconcileSurgeUserHandoff(h.deps, {
    gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
  })).rejects.toThrow("must acquire hold");
  expect(h.assignments()[0].state).toBe("quiescing");
  expect(h.deps.markAssignment).not.toHaveBeenCalled();
});

it("settles Native scheduler custody before reopening a source for a queued Shared release", async () => {
  const h = createSurgeHandoffHarness(vi.fn, { prelaunchByUid: { [targetPod.uid]: "held" }, assignments: [assignment("u1", "alice", {
    state: "quiescing", updatedByOperationId: "surge-default-target-uid", updatedAt: 7,
  })] });
  const calls: string[] = [];
  h.deps.scheduler = vi.fn(async request => {
    calls.push(`${request.pod.uid}:${request.phase}`);
    return { operationId: request.operationId, phase: request.phase, drained: true, agentIds: ["octogee-alice-coach"],
      ...(request.phase === "export" ? { snapshot: { retained: true } } : {}) };
  });
  h.deps.resumeSourceIngress = vi.fn(async () => { calls.push("resume-ingress"); });
  await expect(reconcileSurgeUserHandoff(h.deps, {
    gatewayId: "default", desiredImageTag: "new-sha", supersedingImageTag: "queued-sha", requiresUserMigration: true,
  })).resolves.toEqual({ ready: false });
  expect(calls).toEqual(["old-uid:export", "target-uid:abort", "resume-ingress", "old-uid:resume"]);
  expect(h.assignments()[0].state).toBe("serving");
});

it("captures the committed assignment clock when gating a legacy clockless assignment", async () => {
  const h = createSurgeHandoffHarness(vi.fn, { assignments: [assignment("u1", "alice", { updatedAt: undefined })] });
  await expect(reconcileSurgeUserHandoff(h.deps, {
    gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
  })).resolves.toEqual({ ready: false });
  expect(h.assignments()[0].updatedAt).toBeGreaterThan(0);
  expect(h.deps.scheduler).toHaveBeenCalledWith(expect.objectContaining({ phase: "export", resolveAgentScope: true, operationId: expect.stringMatching(/^surge-cron:/u) }));
  expect(h.deps.releaseTarget).toHaveBeenCalledOnce();
});

it("keeps schedules and admission closed if the restored source starts terminating", async () => {
  const pods = [{ ...oldPod }, { ...targetPod }];
  const h = createSurgeHandoffHarness(vi.fn, { pods, assignments: [assignment("u1", "alice")] });
  vi.mocked(h.deps.markSharedSurgeForwardRecovery).mockRejectedValueOnce(new Error("boundary refused"));
  h.deps.resumeSourceIngress = vi.fn(async () => { pods[0] = { ...pods[0], terminating: true }; });
  await expect(reconcileSurgeUserHandoff(h.deps, {
    gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
  })).rejects.toThrow("Shared rollback source is not serving");
  expect(vi.mocked(h.deps.scheduler!).mock.calls.some(([request]) => request.phase === "resume")).toBe(false);
  expect(h.assignments()[0].state).toBe("quiescing");
});

it.each([false, true])("keeps a nonportable job on a serving source when the move is refused (export ACK lost=%s)", async lostExportAck => {
  const h = createSurgeHandoffHarness(vi.fn, { assignments: [assignment("u1", "alice")] });
  let sourceHeld = false;
  h.deps.scheduler = vi.fn(async request => {
    const agentIds = ["octogee-alice-coach"];
    const result = { operationId: request.operationId, phase: request.phase, drained: true, agentIds };
    if (request.phase === "export") {
      expect(request.retainNonportable).toBe(true);
      sourceHeld = true;
      if (lostExportAck) throw new Error("export acknowledgement lost");
      return { ...result, snapshot: { version: 1, operationId: request.operationId, agentIds,
        jobs: [], scratch: [], retainedJobIds: ["host-bound-job"] } };
    }
    if (request.phase === "abort") return { ...result, agentIds: [] };
    if (request.phase === "resume") {
      if (!sourceHeld) return { ...result, agentIds: [] };
      sourceHeld = false;
    }
    return result;
  });
  await expect(reconcileSurgeUserHandoff(h.deps, {
    gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
  })).rejects.toThrow(lostExportAck ? "export acknowledgement lost" : "full scheduler snapshot");
  expect(h.assignments()[0].state).toBe("serving");
  expect(sourceHeld).toBe(false);
  expect(h.deps.resumeSourceIngress).toHaveBeenCalledOnce();
  expect(h.deps.transfer).not.toHaveBeenCalled();
  expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  expect(vi.mocked(h.deps.scheduler).mock.calls.some(([request]) => request.phase === "stage")).toBe(false);
});

it("does not reopen source admission when a foreign Native fence prevented this operation from holding", async () => {
  const h = createSurgeHandoffHarness(vi.fn, { assignments: [assignment("u1", "alice")] });
  h.deps.scheduler = vi.fn(async request => {
    if (request.phase === "export") throw new Error("Cron agent is held for migration foreign-native-owner");
    return { operationId: request.operationId, phase: request.phase, drained: true, agentIds: [] };
  });
  await expect(reconcileSurgeUserHandoff(h.deps, {
    gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
  })).rejects.toThrow("foreign-native-owner");
  expect(h.assignments()[0].state).toBe("quiescing");
  expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  expect(vi.mocked(h.deps.scheduler).mock.calls.every(([request]) => !request.operationId.includes("foreign-native-owner"))).toBe(true);
});
