import { expect, it, vi } from "vitest";
import { recoverAbandonedSurgeSchedulerSource } from "../surge-scheduler-source-recovery.js";
import { surgeSchedulerOperationId } from "../surge-scheduler-handoff.js";
import type { SurgeAssignment, SurgeUserHandoffDeps, SurgePod, SurgePodHealth } from "../surge-user-handoff.js";
import type { SchedulerMigrationResult } from "@octogee/shared/types/fleet-controller";

const SOURCE_UID = "11111111-1111-4111-8111-111111111111";
const TARGET_UID = "22222222-2222-4222-8222-222222222222";

function setup(kind: "source" | "target" = "source") {
  const formerTargetUid = kind === "source" ? TARGET_UID : SOURCE_UID;
  const row: SurgeAssignment = { uid: "uid-alice", slug: "alice", epoch: 7, state: "quiescing", updatedByOperationId: `surge-shared-example-${formerTargetUid}`, updatedAt: 1_234 };
  const assignments: SurgeAssignment[] = [row, { uid: "uid-bob", slug: "bobby", epoch: 2, state: "serving", updatedByOperationId: null, updatedAt: 1_000 }];
  const sourcePod: SurgePod = { uid: SOURCE_UID, name: "gateway-source", podIP: "10.0.0.1", image: "qualified-image", ready: true, terminating: false, crashLooping: false };
  const pods = [{ ...sourcePod }];
  const observedPodUids = [SOURCE_UID];
  const health: SurgePodHealth = { status: "ready", version: "installed-version", fleetSignatureCapability: "gateway-scoped", handoffReleased: true, prelaunchState: "none", mountedCustomers: ["alice", "bobby"] };
  const input = { gatewayId: "shared-example", assignment: { ...row }, sourcePod: { ...sourcePod } };
  const operationId = surgeSchedulerOperationId({ gatewayId: input.gatewayId, assignment: input.assignment, target: { uid: formerTargetUid } });
  const agentIds = ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"];
  let state: "held" | "exported" | "staged" | "activated" | "missing" | "resumed" = kind === "source" ? "held" : "staged";
  const scheduler = vi.fn<NonNullable<SurgeUserHandoffDeps["scheduler"]>>(async request => {
    expect(request.operationId).toBe(operationId);
    expect(request.gatewayId).toBe(input.gatewayId);
    expect(request.slug).toBe("alice");
    expect(request.pod).toEqual(sourcePod);
    expect(request).not.toHaveProperty("agentIds");
    expect(request).not.toHaveProperty("snapshot");
    if (request.phase === "export") {
      if (state === "resumed") throw new Error("Cron migration already resumed");
      if (state !== "held" && state !== "exported") throw new Error("existing Native custody missing");
      state = "exported";
      return { operationId, phase: "export", agentIds, drained: true,
        snapshot: { version: 1, operationId, agentIds, jobs: [], scratch: [] } };
    }
    if (request.phase === "resume") {
      const resumedScope = state === "missing" ? [] : agentIds;
      state = "resumed";
      return { operationId, phase: "resume", agentIds: resumedScope, drained: true };
    }
    if (request.phase === "activate") {
      if (state !== "staged" && state !== "activated") throw new Error("existing Native stage missing");
      state = "activated";
      return { operationId, phase: "activate", agentIds, drained: true };
    }
    throw new Error(`unexpected Native phase ${request.phase}`);
  });
  const deps = { readAssignments: vi.fn(async () => assignments), listPods: vi.fn(async () => ({ pods, observedPodUids })), readPodHealth: vi.fn(async () => health), scheduler };
  return { input, deps, row, assignments, pods, observedPodUids, health, agentIds, operationId, state: () => state, setState: (next: typeof state) => { state = next; } };
}

it("proves an existing held source export before releasing that exact Native operation", async () => {
  const h = setup();
  const proof = await recoverAbandonedSurgeSchedulerSource(h.deps, h.input);
  expect(h.deps.scheduler.mock.calls.map(([request]) => request.phase)).toEqual(["export", "resume"]);
  expect(h.state()).toBe("resumed");
  expect(proof).toMatchObject({ ...h.input, operationId: h.operationId, phase: "resume", agentIds: h.agentIds });
  expect(proof.observationFingerprint).not.toBe("");
  expect(h.row.state).toBe("quiescing");
  expect(h.row.updatedAt).toBe(1_234);
});

it("finishes the prior target only through its existing staged or activated receipt", async () => {
  const h = setup("target");
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).resolves.toMatchObject({ phase: "activate", operationId: h.operationId, agentIds: h.agentIds });
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).resolves.toMatchObject({ phase: "activate", operationId: h.operationId });
  expect(h.deps.scheduler.mock.calls.map(([request]) => request.phase)).toEqual(["activate", "activate"]);
  expect(h.row.state).toBe("quiescing");
});

it.each(["source", "target"] as const)("refuses unknown Native custody on the remaining %s without fresh hold or field writes", async kind => {
  const h = setup(kind); h.setState("missing");
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow(/existing Native/u);
  expect(h.deps.scheduler.mock.calls.map(([request]) => request.phase)).toEqual([kind === "source" ? "export" : "activate"]);
  expect(h.state()).toBe("missing");
  expect(h.row.state).toBe("quiescing");
});

it("refuses the empty resume tombstone if Native loses its retained record after export", async () => {
  const h = setup(); const scheduler = h.deps.scheduler.getMockImplementation()!;
  h.deps.scheduler.mockImplementation(async request => {
    const result = await scheduler(request);
    if (request.phase === "export") h.setState("missing");
    return result;
  });
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow(/scope|acknowledgement/u);
  expect(h.deps.scheduler.mock.calls.map(([request]) => request.phase)).toEqual(["export", "resume"]);
  expect(h.row.state).toBe("quiescing");
});

it.each(["foreign-owner", "malformed-owner", "state", "uid", "slug", "epoch", "clock"])("refuses changed or invalid %s before Native effects", async changed => {
  const h = setup();
  if (changed === "foreign-owner") h.input.assignment.updatedByOperationId = `surge-shared-foreign-${TARGET_UID}`;
  if (changed === "malformed-owner") h.input.assignment.updatedByOperationId = "surge-shared-example-not-a-pod";
  if (changed === "state") h.row.state = "serving";
  if (changed === "uid") h.row.uid = "foreign";
  if (changed === "slug") h.row.slug = "foreign";
  if (changed === "epoch") h.row.epoch++;
  if (changed === "clock") h.row.updatedAt!++;
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow(/custody|owner/u);
  expect(h.deps.scheduler).not.toHaveBeenCalled();
});

it.each(["target-present", "unprojected-uid", "recreated-pod", "changed-ip", "changed-image", "not-ready", "terminating", "crashloop", "health", "roster", "foreign-roster", "migrating-in", "terminal-target", "prelaunch-held", "prelaunch-hydrated", "prelaunch-starting"])("refuses unsafe %s source observation", async changed => {
  const h = setup();
  if (changed === "target-present") { h.pods.push({ ...h.pods[0], uid: TARGET_UID }); h.observedPodUids.push(TARGET_UID); }
  if (changed === "unprojected-uid") h.observedPodUids.push(TARGET_UID);
  if (changed === "recreated-pod") { h.pods[0].uid = TARGET_UID; h.observedPodUids[0] = TARGET_UID; }
  if (changed === "changed-ip") h.pods[0].podIP = "10.0.0.2";
  if (changed === "changed-image") h.pods[0].image = "foreign-image";
  if (changed === "not-ready") h.pods[0].ready = false;
  if (changed === "terminating") h.pods[0].terminating = true;
  if (changed === "crashloop") h.pods[0].crashLooping = true;
  if (changed === "health") h.health.status = "booting";
  if (changed === "roster") h.health.mountedCustomers = ["alice"];
  if (changed === "foreign-roster") h.health.mountedCustomers = ["alice", "bobby", "foreign"];
  if (changed === "migrating-in") h.health.migratingIn = ["alice"];
  if (changed === "terminal-target") h.health.terminalTarget = { migrationId: "prior-attempt", slug: "alice", targetPodUid: SOURCE_UID };
  if (changed === "prelaunch-held") h.health.prelaunchState = "held";
  if (changed === "prelaunch-hydrated") h.health.prelaunchState = "hydrated";
  if (changed === "prelaunch-starting") h.health.prelaunchState = "starting";
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow(/custody|roster|ready/u);
  expect(h.deps.scheduler).not.toHaveBeenCalled();
});

it.each(["clock", "captured-input", "other-uid", "other-slug", "other-epoch", "other-state", "other-owner", "other-clock", "pod", "health", "roster"])("retains admission when %s changes during export", async changed => {
  const h = setup(); const scheduler = h.deps.scheduler.getMockImplementation()!;
  h.deps.scheduler.mockImplementation(async request => {
    const result = await scheduler(request);
    if (changed === "clock") h.row.updatedAt!++;
    if (changed === "captured-input") { h.row.updatedAt!++; h.input.assignment.updatedAt!++; }
    if (changed === "other-uid") h.assignments[1].uid = "different-uid";
    if (changed === "other-slug") h.assignments[1].slug = "different-slug";
    if (changed === "other-epoch") h.assignments[1].epoch++;
    if (changed === "other-state") h.assignments[1].state = "quiescing";
    if (changed === "other-owner") h.assignments[1].updatedByOperationId = "another-owner";
    if (changed === "other-clock") h.assignments[1].updatedAt!++;
    if (changed === "pod") h.pods[0].podIP = "10.0.0.2";
    if (changed === "health") h.health.version = "different-boot-version";
    if (changed === "roster") h.health.mountedCustomers = ["alice"];
    return result;
  });
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow(/custody|roster/u);
  expect(h.deps.scheduler).toHaveBeenCalledTimes(1);
  expect(h.row.state).toBe("quiescing");
});

it.each(["resume", "activate"] as const)("requires the final %s ACK and unchanged custody before returning proof", async phase => {
  const h = setup(phase === "resume" ? "source" : "target");
  const scheduler = h.deps.scheduler.getMockImplementation()!;
  h.deps.scheduler.mockImplementation(async request => {
    const result = await scheduler(request);
    if (request.phase === phase) h.row.updatedAt!++;
    return result;
  });
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow(/custody/u);
  expect(h.row.state).toBe("quiescing");
});

it.each(["foreign-id", "wrong-phase", "not-drained", "empty", "foreign-agent", "bad-agent", "duplicate", "changed-scope", "no-snapshot", "foreign-snapshot"])("refuses invalid Native %s evidence", async changed => {
  const h = setup(); const scheduler = h.deps.scheduler.getMockImplementation()!;
  h.deps.scheduler.mockImplementation(async request => {
    const result: SchedulerMigrationResult = await scheduler(request);
    if (changed === "foreign-id") result.operationId = "other";
    if (changed === "wrong-phase") result.phase = "hold";
    if (changed === "not-drained") result.drained = false;
    if (changed === "empty") result.agentIds = [];
    if (changed === "foreign-agent") result.agentIds = ["octogee-bobby-coach"];
    if (changed === "bad-agent") result.agentIds = ["octogee-alice-coach", "octogee-alice-proj-invalid"];
    if (changed === "duplicate") result.agentIds = ["octogee-alice-coach", "octogee-alice-coach"];
    if (changed === "changed-scope" && request.phase === "resume") result.agentIds = ["octogee-alice-coach"];
    if (changed === "no-snapshot") delete result.snapshot;
    if (changed === "foreign-snapshot") result.snapshot = { version: 1, operationId: "foreign", agentIds: h.agentIds, jobs: [], scratch: [] };
    return result;
  });
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow(/scope|acknowledgement|snapshot/u);
  expect(h.row.state).toBe("quiescing");
});

it("rechecks the captured clock after a pending ready-health read before any Native call", async () => {
  const h = setup();
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  h.deps.readPodHealth.mockImplementationOnce(async () => { entered(); await pending; return h.health; });
  const recovery = recoverAbandonedSurgeSchedulerSource(h.deps, h.input);
  const observed = recovery.catch(error => error);
  await reading;
  h.row.updatedAt!++;
  release();
  await expect(recovery).rejects.toThrow(/custody/u);
  await observed;
  expect(h.deps.scheduler).not.toHaveBeenCalled();
});

it.each([undefined, 0, NaN, Number.MAX_SAFE_INTEGER + 1])("refuses invalid captured clock %s before Native calls", async updatedAt => {
  const h = setup(); h.input.assignment.updatedAt = updatedAt; h.row.updatedAt = updatedAt;
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow(/custody.*clock/u);
  expect(h.deps.scheduler).not.toHaveBeenCalled();
});

it("rechecks custody after an ambiguous Native failure without discarding that failure", async () => {
  const h = setup(); const failure = new Error("Native export acknowledgement lost");
  h.deps.scheduler.mockImplementation(async () => { h.row.updatedAt!++; throw failure; });
  const error = await recoverAbandonedSurgeSchedulerSource(h.deps, h.input).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors[0]).toBe(failure);
  expect(error.errors[1].message).toMatch(/custody/u);
  expect(h.row.state).toBe("quiescing");
});

it.each(["lost-resume-ack", "caller-crash-before-cas"] as const)("reuses Native's terminal resume receipt after %s without changing the gate", async failure => {
  const h = setup(); const scheduler = h.deps.scheduler.getMockImplementation()!;
  let lost = false;
  h.deps.scheduler.mockImplementation(async request => {
    const result = await scheduler(request);
    if (failure === "lost-resume-ack" && request.phase === "resume" && !lost) {
      lost = true;
      throw new Error("resume response lost after commit");
    }
    return result;
  });
  if (failure === "lost-resume-ack") await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow("resume response lost after commit");
  else await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).resolves.toMatchObject({ phase: "resume" });
  expect(h.state()).toBe("resumed");
  expect(h.row.state).toBe("quiescing");
  vi.mocked(h.deps.scheduler).mockClear();
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).resolves.toMatchObject({ phase: "resume", operationId: h.operationId, agentIds: h.agentIds });
  expect(h.deps.scheduler.mock.calls.map(([request]) => request.phase)).toEqual(["export", "resume"]);
  expect(h.row.updatedAt).toBe(1_234);
});

it("recognizes only the exact existing scheduler500 Native resumed receipt", async () => {
  const h = setup(); h.setState("resumed"); const scheduler = h.deps.scheduler.getMockImplementation()!;
  h.deps.scheduler.mockImplementation(async request => {
    if (request.phase === "export") throw Object.assign(new Error("scheduler pod=source: 500"), {
      status: 500, body: { error: "scheduler migration failed", message: "Cron migration already resumed" },
    });
    return scheduler(request);
  });
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).resolves.toMatchObject({ phase: "resume", operationId: h.operationId, agentIds: h.agentIds });
  expect(h.deps.scheduler.mock.calls.map(([request]) => request.phase)).toEqual(["export", "resume"]);
});

it.each([
  new Error("export failed"), new Error("prefix Cron migration already resumed"),
  Object.assign(new Error("server failure"), { status: 503, body: { error: "scheduler migration failed", message: "Cron migration already resumed" } }),
  Object.assign(new Error("server failure"), { status: 500, body: { error: "foreign route", message: "Cron migration already resumed" } }),
  Object.assign(new Error("server failure"), { status: 500, body: { error: "scheduler migration failed", message: "prefix Cron migration already resumed" } }),
])("propagates unrelated export errors without attempting resume: %j", async failure => {
  const h = setup(); h.deps.scheduler.mockRejectedValueOnce(failure);
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toBe(failure);
  expect(h.deps.scheduler.mock.calls.map(([request]) => request.phase)).toEqual(["export"]);
  expect(h.row.state).toBe("quiescing");
});

it("refuses a missing-record tombstone even after an exact already-resumed error", async () => {
  const h = setup(); h.setState("missing"); const scheduler = h.deps.scheduler.getMockImplementation()!;
  h.deps.scheduler.mockImplementation(async request => {
    if (request.phase === "export") throw new Error("Cron migration already resumed");
    return scheduler(request);
  });
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow(/scope/u);
  expect(h.deps.scheduler.mock.calls.map(([request]) => request.phase)).toEqual(["export", "resume"]);
  expect(h.row.state).toBe("quiescing");
});

function withStandby(kind: "source" | "target" = "source") {
  const h = setup(kind);
  const standbyTarget: SurgePod = { uid: "33333333-3333-4333-8333-333333333333", name: "new-empty-candidate", podIP: "10.0.0.3", image: "new-candidate-image", ready: false, terminating: false, crashLooping: false };
  const standbyHealth: SurgePodHealth = { status: "ready", version: "candidate-version", fleetSignatureCapability: "gateway-scoped", handoffReleased: false, prelaunchState: "none", mountedCustomers: [], migratingIn: [] };
  h.pods.push({ ...standbyTarget }); h.observedPodUids.push(standbyTarget.uid);
  const deps = { ...h.deps, readPodHealth: vi.fn(async (pod: SurgePod) => pod.uid === SOURCE_UID ? h.health : standbyHealth) };
  return { ...h, input: { ...h.input, standbyTarget: { ...standbyTarget } }, deps, standbyHealth };
}

it.each(["source", "target"] as const)("recovers the remaining %s beside an exact empty new candidate without touching that candidate", async kind => {
  const h = withStandby(kind);
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).resolves.toMatchObject({
    operationId: h.operationId, phase: kind === "source" ? "resume" : "activate", standbyTarget: h.input.standbyTarget,
  });
  expect(h.deps.scheduler.mock.calls.map(([request]) => request.pod.uid)).toEqual(kind === "source" ? [SOURCE_UID, SOURCE_UID] : [SOURCE_UID]);
  expect(new Set(h.deps.readPodHealth.mock.calls.map(([pod]) => pod.uid))).toEqual(new Set([SOURCE_UID, h.input.standbyTarget.uid]));
  expect(h.row.state).toBe("quiescing");
});

it.each(["actual-former-target", "ready", "terminating", "crashloop", "uid", "name", "ip", "image", "unprojected", "native-down", "released", "mounted", "migrating", "terminal", "prelaunch-held"])("refuses unsafe standby %s without Native effects", async changed => {
  const h = withStandby();
  if (changed === "actual-former-target") { h.input.standbyTarget.uid = TARGET_UID; h.pods[1].uid = TARGET_UID; h.observedPodUids[1] = TARGET_UID; }
  if (changed === "ready") h.pods[1].ready = true;
  if (changed === "terminating") h.pods[1].terminating = true;
  if (changed === "crashloop") h.pods[1].crashLooping = true;
  if (changed === "uid") h.pods[1].uid = TARGET_UID;
  if (changed === "name") h.pods[1].name = "foreign-name";
  if (changed === "ip") h.pods[1].podIP = "10.0.0.99";
  if (changed === "image") h.pods[1].image = "foreign-image";
  if (changed === "unprojected") h.observedPodUids.push(TARGET_UID);
  if (changed === "native-down") h.standbyHealth.status = "booting";
  if (changed === "released") h.standbyHealth.handoffReleased = true;
  if (changed === "mounted") h.standbyHealth.mountedCustomers = ["alice"];
  if (changed === "migrating") h.standbyHealth.migratingIn = ["alice"];
  if (changed === "terminal") h.standbyHealth.terminalTarget = { migrationId: "old-target-attempt", slug: "alice", targetPodUid: h.input.standbyTarget.uid };
  if (changed === "prelaunch-held") h.standbyHealth.prelaunchState = "held";
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow(/custody|standby|former/u);
  expect(h.deps.scheduler).not.toHaveBeenCalled();
});

it.each(["ready", "image", "version", "mounted", "old-target-returns"])("refuses standby %s drift after export before any resume", async changed => {
  const h = withStandby(); const scheduler = h.deps.scheduler.getMockImplementation()!;
  h.deps.scheduler.mockImplementation(async request => {
    const result = await scheduler(request);
    if (changed === "ready") h.pods[1].ready = true;
    if (changed === "image") h.pods[1].image = "foreign-image";
    if (changed === "version") h.standbyHealth.version = "restarted-candidate";
    if (changed === "mounted") h.standbyHealth.mountedCustomers = ["alice"];
    if (changed === "old-target-returns") { h.pods.push({ ...h.pods[1], uid: TARGET_UID }); h.observedPodUids.push(TARGET_UID); }
    return result;
  });
  await expect(recoverAbandonedSurgeSchedulerSource(h.deps, h.input)).rejects.toThrow(/custody|standby/u);
  expect(h.deps.scheduler.mock.calls.map(([request]) => request.phase)).toEqual(["export"]);
  expect(h.row.state).toBe("quiescing");
});

it("rechecks the gate after a pending standby-health read before any Native effect", async () => {
  const h = withStandby(); const read = h.deps.readPodHealth.getMockImplementation()!;
  let release!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { entered = resolve; });
  h.deps.readPodHealth.mockImplementation(async pod => {
    if (pod.uid === h.input.standbyTarget.uid) { entered(); await pending; }
    return read(pod);
  });
  const recovery = recoverAbandonedSurgeSchedulerSource(h.deps, h.input);
  const observed = recovery.catch(error => error);
  await reading;
  h.row.updatedAt!++;
  release();
  await expect(recovery).rejects.toThrow(/custody/u);
  await observed;
  expect(h.deps.scheduler).not.toHaveBeenCalled();
});
