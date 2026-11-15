import { expect, it, vi } from "vitest";
import { abortSurgeSchedulerTarget, activateSurgeScheduler, inspectExistingSurgeScheduler, resumeSurgeSchedulerSource, stageSurgeScheduler, surgeSchedulerOperationId, type SurgeSchedulerCustody } from "../surge-scheduler-handoff.js";
import { assignment, createSurgeHandoffHarness, oldPod, targetPod } from "./fixtures/surge-user-handoff.js";

function setup() {
  const row = assignment("u1", "alice", { state: "quiescing", updatedByOperationId: "surge-default-target-uid", updatedAt: 2 });
  const pods = [{ ...oldPod }, { ...targetPod }];
  const h = createSurgeHandoffHarness(vi.fn, { assignments: [row], pods });
  const custody: SurgeSchedulerCustody = { gatewayId: "default", owner: "surge-default-target-uid", assignment: { ...row }, source: { ...oldPod }, target: { ...targetPod } };
  return { ...h, custody, pods };
}

it("uses a distinct Native operation for every tenant, target and owned gate clock", () => {
  const { custody } = setup();
  const ids = [custody, { ...custody, assignment: { ...custody.assignment, uid: "u2", slug: "bob" } },
    { ...custody, target: { ...targetPod, uid: "replacement" } },
    { ...custody, assignment: { ...custody.assignment, updatedAt: 3 } }].map(surgeSchedulerOperationId);
  expect(new Set(ids).size).toBe(4);
});

it.each(["state", "owner", "epoch", "clock"])("refuses stale %s custody before any Native effect", async changed => {
  const h = setup();
  const row = h.assignments()[0];
  if (changed === "state") row.state = "serving";
  if (changed === "owner") row.updatedByOperationId = "new-owner";
  if (changed === "epoch") row.epoch++;
  if (changed === "clock") row.updatedAt!++;
  await expect(stageSurgeScheduler(h.deps, h.custody)).rejects.toThrow("scheduler assignment custody changed");
  expect(h.deps.scheduler).not.toHaveBeenCalled();
});

it("rechecks the exact owned clock after export before staging a snapshot", async () => {
  const h = setup();
  const scheduler = h.deps.scheduler!;
  h.deps.scheduler = vi.fn(async request => {
    const result = await scheduler(request);
    h.assignments()[0].updatedAt!++;
    return result;
  });
  await expect(stageSurgeScheduler(h.deps, h.custody)).rejects.toThrow("scheduler assignment custody changed");
  expect(h.deps.scheduler).toHaveBeenCalledTimes(1);
});

it("refuses target pod replacement between source export and staging", async () => {
  const h = setup();
  const scheduler = h.deps.scheduler!;
  h.deps.scheduler = vi.fn(async request => {
    const result = await scheduler(request);
    if (request.phase === "export") h.pods[1].uid = "replacement";
    return result;
  });
  await expect(stageSurgeScheduler(h.deps, h.custody)).rejects.toThrow("scheduler physical custody changed");
  expect(vi.mocked(h.deps.scheduler).mock.calls.map(([request]) => request.phase)).toEqual(["export"]);
});

it("stages the full exported project scope without a target hold that could truncate it", async () => {
  const h = setup();
  const agentIds = ["octogee-alice-coach", "octogee-alice-proj-demo-coach"];
  h.deps.scheduler = vi.fn(async request => ({ operationId: request.operationId, phase: request.phase, drained: true, agentIds,
    ...(request.phase === "export" ? { snapshot: { version: 1, operationId: request.operationId, agentIds, jobs: [], scratch: [] } } : {}) }));
  await stageSurgeScheduler(h.deps, h.custody);
  expect(vi.mocked(h.deps.scheduler).mock.calls.map(([request]) => [request.pod.uid, request.phase])).toEqual([
    [oldPod.uid, "export"], [targetPod.uid, "stage"],
  ]);
  expect(vi.mocked(h.deps.scheduler).mock.calls[0][0]).toMatchObject({ phase: "export", resolveAgentScope: true });
  expect(vi.mocked(h.deps.scheduler).mock.calls[1][0]).toMatchObject({ agentIds, snapshot: { version: 1, operationId: expect.any(String), agentIds, jobs: [], scratch: [] } });
});

it("requires confirmed target abort before resuming source schedules", async () => {
  const h = setup();
  await stageSurgeScheduler(h.deps, h.custody);
  vi.mocked(h.deps.scheduler!).mockClear();
  await abortSurgeSchedulerTarget(h.deps, h.custody);
  await resumeSurgeSchedulerSource(h.deps, h.custody);
  expect(vi.mocked(h.deps.scheduler!).mock.calls.map(([request]) => [request.pod.uid, request.phase])).toEqual([
    [targetPod.uid, "abort"], [oldPod.uid, "resume"],
  ]);
});

it("keeps source schedules held when target cleanup is ambiguous", async () => {
  const h = setup();
  await stageSurgeScheduler(h.deps, h.custody);
  h.deps.scheduler = vi.fn(async () => { throw new Error("lost abort acknowledgement"); });
  await expect(abortSurgeSchedulerTarget(h.deps, h.custody)).rejects.toThrow("lost abort acknowledgement");
  expect(h.deps.scheduler).toHaveBeenCalledTimes(1);
  expect(h.assignments()[0].state).toBe("quiescing");
});

it("refuses activation while the old source physical identity still exists", async () => {
  const h = setup();
  await expect(activateSurgeScheduler(h.deps, { ...h.custody, source: undefined })).rejects.toThrow("scheduler physical custody changed");
  expect(h.deps.scheduler).not.toHaveBeenCalled();
});

it("refuses a missing source scheduler record after export instead of manufacturing a scoped resume tombstone", async () => {
  const h = setup();
  await stageSurgeScheduler(h.deps, h.custody);
  h.deps.scheduler = vi.fn(async request => ({ operationId: request.operationId, phase: request.phase, drained: true,
    agentIds: request.phase === "resume" ? [] : ["octogee-alice-coach"] }));
  await expect(resumeSurgeSchedulerSource(h.deps, h.custody)).rejects.toThrow("scheduler resume scope changed");
  expect(vi.mocked(h.deps.scheduler).mock.calls[0][0].agentIds).toBeUndefined();
  expect(h.assignments()[0].state).toBe("quiescing");
});

it("never resumes the foreign fence or accepts an empty receipt for the unheld current operation", async () => {
  const h = setup();
  h.deps.scheduler = vi.fn(async request => {
    if (request.phase === "export") throw new Error("agent is held for migration foreign-native-owner");
    return { operationId: request.operationId, phase: request.phase, drained: true, agentIds: [] };
  });
  await expect(stageSurgeScheduler(h.deps, h.custody)).rejects.toThrow("foreign-native-owner");
  await abortSurgeSchedulerTarget(h.deps, h.custody);
  await expect(resumeSurgeSchedulerSource(h.deps, h.custody)).rejects.toThrow("scheduler resume scope changed");
  expect(vi.mocked(h.deps.scheduler).mock.calls.map(([request]) => request.phase)).toEqual(["export", "abort", "resume"]);
});

it("verifies the existing resumed receipt after a lost source resume acknowledgement", async () => {
  const h = setup();
  h.deps.scheduler = vi.fn(async request => {
    if (request.phase === "export") throw Object.assign(new Error("scheduler export failed"), { status: 500, body: { error: "scheduler migration failed", message: "Cron migration already resumed" } });
    return { operationId: request.operationId, phase: request.phase, drained: true, agentIds: ["octogee-alice-coach"] };
  });
  await inspectExistingSurgeScheduler(h.deps, h.custody);
  await abortSurgeSchedulerTarget(h.deps, h.custody);
  await resumeSurgeSchedulerSource(h.deps, h.custody);
  expect(vi.mocked(h.deps.scheduler).mock.calls.map(([request]) => request.phase)).toEqual(["export", "resume", "abort", "resume"]);
  expect(vi.mocked(h.deps.scheduler).mock.calls.every(([request]) => request.agentIds === undefined)).toBe(true);
});

it("refuses an empty terminal receipt if the source record disappeared after a resumed error", async () => {
  const h = setup();
  h.deps.scheduler = vi.fn(async request => {
    if (request.phase === "export") throw new Error("Cron migration already resumed");
    return { operationId: request.operationId, phase: request.phase, drained: true, agentIds: [] };
  });
  await expect(inspectExistingSurgeScheduler(h.deps, h.custody)).rejects.toThrow("retained scheduler");
  expect(vi.mocked(h.deps.scheduler).mock.calls.map(([request]) => request.phase)).toEqual(["export", "resume"]);
});

it("refuses a cached partial export before staging when Native retained host-bound jobs", async () => {
  const h = setup();
  h.deps.scheduler = vi.fn(async request => {
    const agentIds = ["octogee-alice-coach"];
    return { operationId: request.operationId, phase: request.phase, drained: true, agentIds,
      ...(request.phase === "export" ? { snapshot: { version: 1, operationId: request.operationId, agentIds, jobs: [], scratch: [], retainedJobIds: ["host-bound-job"] } } : {}) };
  });
  await expect(stageSurgeScheduler(h.deps, h.custody)).rejects.toThrow("full scheduler snapshot");
  expect(vi.mocked(h.deps.scheduler).mock.calls.some(([request]) => request.phase === "stage")).toBe(false);
});
