import { describe, expect, it, vi } from "vitest";
import { MigrationDrainPendingError } from "@octogee/core/fleet-migration-client";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { readSurgeAssignments } from "../surge-orphan-assignment.js";
import { reconcileSurgeUserHandoff, assertSurgeAssignmentCoverage,
  type SurgeAssignment, type SurgePod, type SurgePodHealth, type SurgeUserHandoffDeps } from "../surge-user-handoff.js";
import { oldPod, targetPod, abandonedPodUid, abandonedOperationId,
  otherGatewayOperationId, assignment, createSurgeHandoffHarness } from "./fixtures/surge-user-handoff.js";

const harness = (input: Parameters<typeof createSurgeHandoffHarness>[1] = {}) => createSurgeHandoffHarness(vi.fn, input);

describe("surge user handoff", () => {
  it("retries a Shared import forward after the target may upgrade its store", async () => {
    const scenario = { assignments: [assignment("u1", "alice")], transferError: new Error("failed after upgrade") as Error | undefined };
    const h = harness(scenario);
    const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true };
    await expect(reconcileSurgeUserHandoff(h.deps, input)).rejects.toThrow("failed after upgrade");
    expect(h.assignments()[0]).toMatchObject({ state: "quiescing", sharedSurgeForwardRecovery: { operationId: h.operationId, targetPodUid: targetPod.uid } });
    expect(h.deps.discardTargetUser).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
    scenario.transferError = undefined;
    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    expect(h.deps.transfer).toHaveBeenCalledTimes(2);
    expect(h.deps.releaseTarget).toHaveBeenCalledOnce();
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
  });

  it("continues on a replacement target with the original scheduler custody after an upgrade", async () => {
    const pods = [oldPod, targetPod];
    const scenario = { pods, assignments: [assignment("u1", "alice")], transferError: new Error("after upgrade") as Error | undefined };
    const h = harness(scenario);
    const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true };
    await expect(reconcileSurgeUserHandoff(h.deps, input)).rejects.toThrow("after upgrade");
    const firstExport = vi.mocked(h.deps.scheduler!).mock.calls.find(([r]) => r.phase === "export")![0].operationId;
    const replacement = { ...targetPod, uid: "replacement-uid", name: "replacement" };
    pods[1] = replacement;
    const read = vi.mocked(h.deps.readPodHealth).getMockImplementation()!;
    vi.mocked(h.deps.readPodHealth).mockImplementation((pod, gatewayId) => read(pod.uid === replacement.uid ? targetPod : pod, gatewayId));
    scenario.transferError = undefined;
    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    const exports = vi.mocked(h.deps.scheduler!).mock.calls.filter(([r]) => r.phase === "export");
    expect(exports.map(([r]) => r.operationId)).toEqual([firstExport, firstExport]);
    expect(h.deps.transfer).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: h.operationId, targetPod: replacement }));
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
    expect(h.deps.discardTargetUser).not.toHaveBeenCalled();
  });

  it("finishes both Shared assignments after the second import fails", async () => {
    const pods = [oldPod, targetPod];
    const targetMountedUsers: string[] = [];
    const scenario = { pods, targetMountedUsers, transferError: new Error("second upgrade failed") as Error | undefined, transferErrorSlug: "bob" };
    const h = harness(scenario);
    const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true };
    await expect(reconcileSurgeUserHandoff(h.deps, input)).rejects.toThrow("second upgrade failed");
    expect(h.assignments().every(row => row.state === "quiescing" && row.sharedSurgeForwardRecovery)).toBe(true);
    scenario.transferError = undefined;
    await expect(reconcileSurgeUserHandoff(h.deps, { ...input, supersedingImageTag: "next-sha" })).resolves.toEqual({ ready: false });
    expect(h.deps.transfer).toHaveBeenCalledTimes(4);
    expect(h.deps.releaseTarget).toHaveBeenCalledOnce();
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
    pods.splice(0, 2, { ...targetPod, ready: true });
    targetMountedUsers.push("alice", "bob");
    await expect(reconcileSurgeUserHandoff(h.deps, { ...input, supersedingImageTag: "next-sha" })).resolves.toEqual({ ready: true });
    expect(h.assignments().every(row => row.state === "serving" && !row.sharedSurgeForwardRecovery)).toBe(true);
  });

  it("rolls back Shared source when the forward boundary fails before any import", async () => {
    const h = harness({ assignments: [assignment("u1", "alice")] });
    vi.mocked(h.deps.markSharedSurgeForwardRecovery).mockRejectedValueOnce(new Error("boundary refused"));
    await expect(reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true })).rejects.toThrow("boundary refused");
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceIngress).toHaveBeenCalledOnce();
    expect(h.assignments()[0].state).toBe("serving");
  });

  it("keeps source fenced when boundary write commits but its acknowledgement is lost", async () => {
    const h = harness({ assignments: [assignment("u1", "alice")] });
    const mark = vi.mocked(h.deps.markSharedSurgeForwardRecovery).getMockImplementation()!;
    vi.mocked(h.deps.markSharedSurgeForwardRecovery).mockImplementationOnce(async input => { await mark(input); throw new Error("lost acknowledgement"); });
    await expect(reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true })).rejects.toThrow("lost acknowledgement");
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("quiescing");
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
  });

  it("keeps source fenced when forward marker cannot be read after an import failure", async () => {
    const h = harness({ assignments: [assignment("u1", "alice")] });
    vi.mocked(h.deps.transfer).mockImplementationOnce(async () => {
      vi.mocked(h.deps.readAssignments).mockRejectedValue(new Error("assignment read unavailable"));
      throw new Error("import failed");
    });
    await expect(reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true })).rejects.toThrow("assignment read unavailable");
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
    expect(h.deps.discardTargetUser).not.toHaveBeenCalled();
  });

  it("refuses to rebind a Shared target while its previous physical UID is still observed", async () => {
    const marker = { operationId: "surge-default-target-uid", targetPodUid: targetPod.uid, receivingPodUid: targetPod.uid };
    const replacement = { ...targetPod, uid: "replacement-uid", name: "replacement" };
    const h = harness({ pods: [oldPod, replacement], observedPodUids: [oldPod.uid, replacement.uid, targetPod.uid],
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: marker.operationId, sharedSurgeForwardRecovery: marker }] });
    const read = vi.mocked(h.deps.readPodHealth).getMockImplementation()!;
    vi.mocked(h.deps.readPodHealth).mockImplementation((pod, gatewayId) => read(pod.uid === replacement.uid ? targetPod : pod, gatewayId));
    await expect(reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true })).rejects.toThrow("physical custody changed");
    expect(h.deps.rebindSharedSurgeForwardRecovery).not.toHaveBeenCalled();
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
  });

  it("keeps source ingress closed when a shared target release has an unknown outcome", async () => {
    const h = harness({ assignments: [assignment("u1", "alice")], releaseErrorBeforeCommit: new Error("connection refused") });
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
    })).rejects.toThrow("connection refused");
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("tags post-observation handoff lines and nested progress lines with the owning operation id", async () => {
    const h = harness();
    vi.mocked(h.deps.reportMigrationProgress).mockRejectedValueOnce(new Error("pod gone"));
    vi.mocked(h.deps.waitForSourceIdle).mockRejectedValueOnce(new MigrationDrainPendingError("coach is active"));
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
      isolatedGateway: false,
    })).resolves.toEqual({ ready: false });
    const lines = vi.mocked(h.deps.log).mock.calls.map(([message]) => message);
    expect(lines).toContainEqual(expect.stringMatching(/^\[surge-handoff\] waiting for user activity to finish gateway=default: coach is active op=surge-default-target-uid$/u));
    expect(lines).toContainEqual(expect.stringMatching(/^🔴 \[migration\] destination progress unavailable: Error: pod gone;.* migrationId=surge-default-target-uid user=alice op=surge-default-target-uid$/u));
    expect(lines.filter((line) => line.includes(" op=")).every((line) => line.match(/ op=/gu)?.length === 1)).toBe(true);
  });

  it.each([false, true])("keeps source assignments serving when agent or voice work defers a roll (User=%s)", async (user) => {
    const h = harness();
    vi.mocked(h.deps.waitForSourceIdle).mockRejectedValueOnce(new MigrationDrainPendingError("coach is active"));
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
      isolatedGateway: user,
    })).resolves.toEqual({ ready: false });
    expect(h.deps.markAssignment).not.toHaveBeenCalled();
    expect(h.deps.quiesce).not.toHaveBeenCalled();
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceIngress).toHaveBeenCalledWith(expect.objectContaining({ slug: "alice", sourcePod: oldPod }));
    expect(h.assignments().every((item) => item.state === "serving")).toBe(true);
    expect(h.deps.reportMigrationProgress).toHaveBeenCalledWith(expect.objectContaining({ event: expect.objectContaining({ phase: "waiting-for-builder-idle", status: "pending" }) }));
    expect(h.deps.recordMigrationProgress).toHaveBeenCalledWith({
      gatewayId: "default",
      uid: h.assignments()[0].uid,
      event: expect.objectContaining({ phase: "waiting-for-builder-idle", status: "pending", source: oldPod.name, migrationId: h.operationId }),
    });
  });

  it("checks every mounted user before gating anyone and releases all earlier voice holds on defer", async () => {
    const h = harness();
    vi.mocked(h.deps.waitForSourceIdle).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new MigrationDrainPendingError("voice is active"));
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });
    expect(h.deps.markAssignment).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.resumeSourceIngress).mock.calls.map(([input]) => input.slug).sort()).toEqual(["alice", "bob"]);
  });

  it.each([false, true])("restores source admission when new work races the final gate (User=%s)", async (user) => {
    const h = harness({ assignments: [assignment("u1", "alice")] });
    vi.mocked(h.deps.quiesce).mockRejectedValueOnce(new MigrationDrainPendingError("new defaultAgent turn"));
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
      isolatedGateway: user,
    })).resolves.toEqual({ ready: false });
    expect(h.events).toEqual(["assignment:u1:quiescing", "assignment:u1:serving"]);
    expect(h.deps.waitForSourceIdle).toHaveBeenCalledOnce();
    expect(h.deps.resumeSourceIngress).toHaveBeenCalledOnce();
    expect(vi.mocked(h.deps.resumeSourceIngress).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(h.deps.markAssignment).mock.invocationCallOrder[1],
    );
    expect(h.deps.flush).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("serving");
  });

  it("reports failed source resume instead of hiding it as a pending drain", async () => {
    const h = harness();
    vi.mocked(h.deps.waitForSourceIdle).mockRejectedValueOnce(new MigrationDrainPendingError("coach active"));
    vi.mocked(h.deps.resumeSourceIngress).mockRejectedValueOnce(new Error("voice resume unavailable"));
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
    })).rejects.toThrow(/voice resume unavailable/);
    expect(h.deps.markAssignment).not.toHaveBeenCalled();
  });

  it("rejects the ambiguous short heartbeat for a pinned OpenClaw image tag", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      assignments: [],
      targetVersion: "27b966b",
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "27b966b-oc2026.7.1",
      requiresUserMigration: false,
    })).resolves.toEqual({ ready: false });
  });

  it("refuses to hand off a user mirror that has no exact assignment document", () => {
    expect(() => assertSurgeAssignmentCoverage(
      [assignment("u1", "alice")],
      [{ uid: "u1", slug: "alice" }, { uid: "u2", slug: "bob" }],
    )).toThrow(/missing assignment.*u2\/bob/);
    expect(() => assertSurgeAssignmentCoverage(
      [assignment("u1", "alice")],
      [{ uid: "u1", slug: "alice" }],
    )).not.toThrow();
  });

  it("releases a first-install pod only after observing no physical source", async () => {
    const h = harness({ pods: [targetPod], assignments: [] });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["release:target-uid"]);
  });

  it("keeps a sourceless user held if another physical pod appears before release", async () => {
    const h = harness({ pods: [targetPod], assignments: [assignment("u1", "alice")], bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" } });
    vi.mocked(h.deps.listPods).mockResolvedValueOnce({ pods: [targetPod], observedPodUids: [targetPod.uid] })
      .mockResolvedValueOnce({ pods: [targetPod, { ...oldPod, ready: false }], observedPodUids: [targetPod.uid, oldPod.uid] });
    await expect(reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha",
      requiresUserMigration: true, isolatedGateway: true })).resolves.toEqual({ ready: false });
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it("marks an empty held disposable isolated prelaunch live without releasing it", async () => {
    const h = harness({
      pods: [targetPod],
      assignments: [],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "builder-alice",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: true, prelaunchHeld: true });

    expect(h.events).toEqual([]);
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.deps.unreserveTargetOpenClaw).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an assignment",
      assignments: [assignment("u1", "alice")],
      targetMountedUsers: [] as string[],
      expectedEvents: ["hold-target:target-uid:alice", "release:target-uid"],
    },
    {
      name: "a tenant mount",
      assignments: [] as SurgeAssignment[],
      targetMountedUsers: ["alice"],
      expectedEvents: [] as string[],
    },
  ])("keeps held disposable prelaunch closed when it already has $name", async ({
    assignments,
    targetMountedUsers,
    expectedEvents,
  }) => {
    const h = harness({
      pods: [targetPod],
      assignments,
      targetMountedUsers,
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "builder-alice",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(expectedEvents);
    expect(h.deps.releaseTarget).toHaveBeenCalledTimes(assignments.length);
  });

  it("finalizes a user source as quiesce, flush, reserve target, stop source, copy, verify", async () => {
    const h = harness({ assignments: [assignment("u1", "alice")] });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "release:target-uid",
    ]);
    expect(h.deps.transfer).toHaveBeenCalledWith(expect.objectContaining({
      loadStrategy: "standard",
      configTransferMode: "configured-builder-system-config",
      expectedSystemConfigCommit: "a".repeat(40),
    }));
  });

  it("uses the expedited load only for a terminating disposable-gateway source", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false, terminating: true }, targetPod],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(h.deps.transfer).toHaveBeenCalledWith(expect.objectContaining({
      loadStrategy: "expedited",
      configTransferMode: "configured-builder-system-config",
    }));
  });

  it("rolls back a failed user handoff by holding the target, resuming the source, then reopening", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("configured user durable path is invalid"),
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
      isolatedGateway: true,
    })).rejects.toThrow("configured user durable path is invalid");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "hold-target:target-uid:alice",
      "resume-source:old-uid:alice",
      "assignment:u1:serving",
    ]);
    expect(h.deps.discardTargetUser).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.assignments()).toEqual([
      expect.objectContaining({ state: "serving", updatedByOperationId: h.operationId }),
    ]);
  });

  it("keeps the roster gated when a user rollback cannot resume its source", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
      resumeSourceError: new Error("source resume refused"),
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
      isolatedGateway: true,
    })).rejects.toThrow(
      "configured user handoff failed and its source could not be resumed: " +
        "handoff=rsync failed; resume=source resume refused",
    );

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "hold-target:target-uid:alice",
      "resume-source:old-uid:alice",
    ]);
    expect(h.assignments()).toEqual([
      expect.objectContaining({ state: "quiescing", updatedByOperationId: h.operationId }),
    ]);
  });

  it("restarts an interrupted copy before Native completion starts", async () => {
    const h = harness({ pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      bootingUids: [oldPod.uid, targetPod.uid], prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "held" },
      completionStarted: false });
    await expect(reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha",
      requiresUserMigration: true, isolatedGateway: true })).resolves.toEqual({ ready: false });
    expect(h.events).toContain("transfer:alice");
    expect(h.deps.releaseTarget).toHaveBeenCalledOnce();
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
  });

  it("keeps both pods held when target completion state is unavailable", async () => {
    const h = harness({ pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      bootingUids: [oldPod.uid, targetPod.uid], prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "held" } });
    vi.mocked(h.deps.holdTargetOpenClaw!).mockResolvedValue(undefined);
    await expect(reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha",
      requiresUserMigration: true, isolatedGateway: true })).rejects.toThrow("cannot prove whether Native completion started");
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
  });

  it("retains a held source and retries a verified isolated target after Native release fails", async () => {
    const pods = [{ ...oldPod }, { ...targetPod }], bootingUids = [targetPod.uid];
    const phases: Record<string, SurgePodHealth["prelaunchState"]> = { [targetPod.uid]: "held" };
    const scenario = { pods, bootingUids, prelaunchByUid: phases, assignments: [assignment("u1", "alice")],
      releaseErrorBeforeCommit: new Error("native release failed") as Error | undefined,
      targetPrelaunchStateAfterRelease: "held" as const, wait: async () => {} };
    const h = harness(scenario);
    const stop = vi.mocked(h.deps.stopSourceOpenClaw!).getMockImplementation()!;
    vi.mocked(h.deps.stopSourceOpenClaw!).mockImplementation(async input => { await stop(input); pods[0].ready = false; bootingUids.push(oldPod.uid); });
    const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true, isolatedGateway: true };
    await expect(reconcileSurgeUserHandoff(h.deps, input)).rejects.toThrow("native release failed");
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    expect(h.assignments()[0]).toMatchObject({ state: "quiescing", updatedByOperationId: h.operationId });
    scenario.releaseErrorBeforeCommit = undefined;
    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    expect(h.deps.releaseTarget).toHaveBeenCalledTimes(3);
    expect(h.deps.transfer).toHaveBeenCalledOnce();
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
  });

  it("keeps a cancelled isolated target fenced while its old source is held", async () => {
    const pods = [{ ...oldPod }, { ...targetPod }];
    const bootingUids = [targetPod.uid];
    const phases: Record<string, SurgePodHealth["prelaunchState"]> = { [targetPod.uid]: "held" };
    const terminalTargets: Record<string, SurgePodHealth["terminalTarget"]> = {};
    const scenario = {
      pods, bootingUids, prelaunchByUid: phases, terminalTargetByUid: terminalTargets,
      assignments: [assignment("u1", "alice")], transferError: new Error("rsync failed"),
      resumeSourceError: new Error("source resume temporarily unavailable") as Error | undefined,
    };
    const h = harness(scenario);
    const stop = vi.mocked(h.deps.stopSourceOpenClaw!).getMockImplementation()!;
    vi.mocked(h.deps.stopSourceOpenClaw!).mockImplementation(async input => {
      await stop(input);
      pods[0].ready = false;
      bootingUids.push(oldPod.uid);
    });
    const hold = vi.mocked(h.deps.holdTargetOpenClaw!).getMockImplementation()!;
    let holds = 0;
    vi.mocked(h.deps.holdTargetOpenClaw!).mockImplementation(async input => {
      await hold(input);
      if (++holds === 2) terminalTargets[targetPod.uid] = {
        migrationId: h.operationId, slug: "alice", targetPodUid: targetPod.uid, processHeld: true, completionStarted: true,
      };
    });
    const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
      isolatedGateway: true, };

    await expect(reconcileSurgeUserHandoff(h.deps, input)).rejects.toThrow("source resume temporarily unavailable");
    expect(h.assignments()[0]).toMatchObject({ state: "quiescing", updatedByOperationId: h.operationId });
    expect(pods[0].ready).toBe(false);
    expect(await h.deps.readPodHealth(pods[0], "default")).toMatchObject({ prelaunchState: "held" });
    expect(terminalTargets[targetPod.uid]).toMatchObject({ processHeld: true });

    scenario.resumeSourceError = undefined;
    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    expect(h.deps.resumeSourceOpenClaw).toHaveBeenCalledTimes(1);
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
    expect(h.assignments()[0]).toMatchObject({ state: "quiescing", updatedByOperationId: h.operationId });
    expect(h.deps.deleteCancelledTarget).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it.each(["source ingress unavailable", "source resume response lost"])("finishes rollback admission after Native resumes before %s", async fault => {
    const pods = [{ ...oldPod }, { ...targetPod }];
    const bootingUids = [targetPod.uid];
    const phases: Record<string, SurgePodHealth["prelaunchState"]> = { [targetPod.uid]: "held" };
    const terminalTargets: Record<string, SurgePodHealth["terminalTarget"]> = {};
    const h = harness({ pods, bootingUids, prelaunchByUid: phases, terminalTargetByUid: terminalTargets,
      assignments: [assignment("u1", "alice")], transferError: new Error("rsync failed") });
    const stop = vi.mocked(h.deps.stopSourceOpenClaw!).getMockImplementation()!;
    vi.mocked(h.deps.stopSourceOpenClaw!).mockImplementation(async input => {
      await stop(input);
      pods[0].ready = false;
      bootingUids.push(oldPod.uid);
    });
    const hold = vi.mocked(h.deps.holdTargetOpenClaw!).getMockImplementation()!;
    let holds = 0;
    vi.mocked(h.deps.holdTargetOpenClaw!).mockImplementation(async input => {
      await hold(input);
      if (++holds === 2) terminalTargets[targetPod.uid] = {
        migrationId: h.operationId, slug: "alice", targetPodUid: targetPod.uid, processHeld: true,
      };
    });
    const resume = vi.mocked(h.deps.resumeSourceOpenClaw!).getMockImplementation()!;
    vi.mocked(h.deps.resumeSourceOpenClaw!).mockImplementation(async input => {
      await resume(input);
      phases[oldPod.uid] = "starting";
      if (fault === "source resume response lost") throw new Error(fault);
    });
    if (fault === "source ingress unavailable") {
      vi.mocked(h.deps.resumeSourceIngress).mockRejectedValueOnce(new Error(fault));
    }
    const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
      isolatedGateway: true, };

    await expect(reconcileSurgeUserHandoff(h.deps, input)).rejects.toThrow(fault);
    expect(h.assignments()[0]).toMatchObject({ state: "quiescing", updatedByOperationId: h.operationId });
    expect(await h.deps.readPodHealth(pods[0], "default")).toMatchObject({ prelaunchState: "starting" });
    expect(terminalTargets[targetPod.uid]).toMatchObject({ processHeld: true });
    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    expect(h.assignments()[0].state).toBe("quiescing");
    expect(h.deps.claimCrashLoopEviction).not.toHaveBeenCalled();

    pods[0].ready = true;
    bootingUids.splice(bootingUids.indexOf(oldPod.uid), 1);
    phases[oldPod.uid] = "serving";
    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    expect(h.deps.resumeSourceIngress).toHaveBeenCalledTimes(fault === "source ingress unavailable" ? 2 : 1);
    expect(h.assignments()[0]).toMatchObject({ state: "serving", updatedByOperationId: h.operationId });
    expect(h.deps.resumeSourceOpenClaw).toHaveBeenCalledOnce();
    expect(h.deps.deleteCancelledTarget).toHaveBeenCalledOnce();
    expect(h.deps.transfer).toHaveBeenCalledOnce();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.deps.unreserveTargetOpenClaw).not.toHaveBeenCalled();
  });

  it.each(["ingress failure", "Native not ready", "missing held proof", "source UID changed", "target UID changed",
    "assignment epoch changed", "assignment owner changed"])("keeps resumed-source assignments gated for %s", async fault => {
    const pods = [{ ...oldPod }, { ...targetPod }];
    const h = harness({ pods,
      assignments: [assignment("u1", "alice", { state: "quiescing", updatedByOperationId: "surge-default-target-uid" })],
      bootingUids: fault === "Native not ready" ? [oldPod.uid, targetPod.uid] : [targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "serving", [targetPod.uid]: "held" },
      terminalTargetByUid: { [targetPod.uid]: { migrationId: "surge-default-target-uid", slug: "alice",
        targetPodUid: targetPod.uid, processHeld: fault === "missing held proof" ? undefined : true } },
    });
    vi.mocked(h.deps.resumeSourceIngress).mockImplementation(async () => {
      if (fault === "ingress failure") throw new Error("ingress remains unavailable");
      if (fault === "source UID changed") pods[0] = { ...pods[0], uid: "replacement-source" };
      if (fault === "target UID changed") pods[1] = { ...pods[1], uid: "replacement-target" };
      if (fault === "assignment epoch changed") h.assignments()[0].epoch += 1;
      if (fault === "assignment owner changed") h.assignments()[0].updatedByOperationId = "foreign-operation";
    });
    const attempt = reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha",
      requiresUserMigration: true, isolatedGateway: true, });
    if (fault === "ingress failure") await expect(attempt).rejects.toThrow("ingress remains unavailable");
    else await expect(attempt).resolves.toEqual({ ready: false });
    expect(h.deps.resumeSourceIngress).toHaveBeenCalledTimes(["Native not ready", "missing held proof"].includes(fault) ? 0 : 1);
    expect(h.deps.markAssignment).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    expect(h.deps.claimCrashLoopEviction).not.toHaveBeenCalled();
    expect(h.deps.deleteCancelledTarget).not.toHaveBeenCalled();
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.deps.unreserveTargetOpenClaw).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it.each(["foreign assignment", "unobserved pod"])("keeps a cancelled-target source held for %s", async fault => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [assignment("u1", "alice", { state: "quiescing",
        updatedByOperationId: fault === "foreign assignment" ? "foreign-operation" : "surge-default-target-uid" })],
      observedPodUids: fault === "unobserved pod" ? [oldPod.uid, targetPod.uid, "pending-pod"] : undefined,
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "held" },
      terminalTargetByUid: { [targetPod.uid]: { migrationId: "surge-default-target-uid", slug: "alice",
        targetPodUid: targetPod.uid, processHeld: true } },
    });
    const attempt = reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha",
      requiresUserMigration: true, isolatedGateway: true, });
    if (fault === "foreign assignment") await expect(attempt).rejects.toThrow("foreign assignment gate");
    else await expect(attempt).resolves.toEqual({ ready: false });
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
    expect(h.deps.markAssignment).not.toHaveBeenCalled();
    expect(h.deps.claimCrashLoopEviction).not.toHaveBeenCalled();
    expect(h.deps.deleteCancelledTarget).not.toHaveBeenCalled();
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("copies from a quiesced legacy source that predates the OpenClaw process gate", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      stopSourceLegacy: true,
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "release:target-uid",
    ]);
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    expect(h.deps.log).toHaveBeenCalledWith(
      expect.stringContaining("predates the OpenClaw process gate"),
    );
  });

  it("restores the roster without a resume when the source stop never landed", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      stopSourceError: new Error("source pod connection reset"),
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
      isolatedGateway: true,
    })).rejects.toThrow("source pod connection reset");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "assignment:u1:serving",
    ]);
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    expect(h.assignments()).toEqual([
      expect.objectContaining({ state: "serving", updatedByOperationId: h.operationId }),
    ]);
  });

  it("still resumes the source when the rollback target hold fails", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
      holdTargetError: new Error("target unreachable"),
      holdTargetErrorFromCall: 2,
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
      isolatedGateway: true,
    })).rejects.toThrow("rsync failed");

    expect(h.events).toContain("resume-source:old-uid:alice");
    expect(h.events.at(-1)).toBe("assignment:u1:serving");
    expect(h.deps.log).toHaveBeenCalledWith(
      expect.stringContaining("rollback target hold failed"),
    );
  });

  it("keeps a terminating shared-gateway source on the standard load", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false, terminating: true }, targetPod],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
      isolatedGateway: false,
    })).resolves.toEqual({ ready: false });

    expect(h.deps.transfer).toHaveBeenCalledWith(expect.objectContaining({
      loadStrategy: "standard",
      configTransferMode: "activation-manifest",
    }));
  });

  it("selects a replacement that reports the complete OpenClaw-qualified image tag", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      targetVersion: "cf36a88-oc2026.7.1",
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "cf36a88-oc2026.7.1",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "release:target-uid",
    ]);
  });

  it("gates each assignment only when its serial transfer begins", async () => {
    const h = harness();

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
      "release:target-uid",
    ]);
    expect(h.assignments().every((item) => item.updatedByOperationId === h.operationId)).toBe(true);
    const progress = vi.mocked(h.deps.reportMigrationProgress).mock.calls.map(([input]) => input);
    expect(progress.every((input) => input.targetPod.uid === targetPod.uid)).toBe(true);
    expect(progress.map((input) => `${input.event.slug}:${input.event.phase}:${input.event.status}`)).toContain("alice:quiesce-and-finalize-source:done");
    expect(progress.at(-1)?.event).toMatchObject({ slug: "bob", phase: "serving-handoff", status: "pending" });
  });

  it("carries durable state across an OpenClaw version change", async () => {
    const h = harness();
    await reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
    });
    expect(h.deps.quiesce).toHaveBeenCalled();
    expect(h.deps.transfer).toHaveBeenCalled();
    expect(h.events.at(-1)).toBe("release:target-uid");
  });

  it("preserves the source when an assigned user is absent from its mounted roster", async () => {
    const pods = [oldPod, targetPod];
    const targetMountedUsers: string[] = [];
    const h = harness({
      pods,
      assignments: [
        assignment("u1", "alice"),
        assignment("u2", "posthog-smoke-v0"),
      ],
      sourceMountedUsers: ["alice"],
      targetMountedUsers,
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("source has unmounted assigned user posthog-smoke-v0");

    expect(h.events).toEqual([]);
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.assignments().every(item => item.state === "serving")).toBe(true);
  });

  it("does not release an empty target while the source roster is unavailable", async () => {
    const sourceMountedUsers = ["alice"];
    const h = harness({ assignments: [assignment("u1", "alice")], sourceMountedUsers,
      transferError: new Error("anchor admission refused") });
    vi.mocked(h.deps.resumeSourceIngress).mockRejectedValue(new Error("resume admission refused"));
    const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true, };
    await expect(reconcileSurgeUserHandoff(h.deps, input)).rejects.toThrow("anchor admission refused");
    sourceMountedUsers.splice(0);
    await expect(reconcileSurgeUserHandoff(h.deps, input)).rejects.toThrow("anchor admission refused");
    expect(h.deps.transfer).toHaveBeenCalledTimes(2);
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("keeps a sourceless Shared target held when its assigned user is absent", async () => {
    const h = harness({ pods: [targetPod], assignments: [assignment("u1", "alice", {
      state: "quiescing", updatedByOperationId: "surge-default-target-uid",
    })], targetMountedUsers: [] });
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(h.assignments()[0].state).toBe("quiescing");
    expect(h.deps.recheckGatewayLater).toHaveBeenCalledWith("default");
  });

  it.each([
    { startedAt: 101, state: "serving", migratingIn: [], release: true },
    { startedAt: 99, state: "serving", migratingIn: [], release: false },
    { startedAt: 101, state: "quiescing", migratingIn: [], release: false },
    { startedAt: 101, state: "serving", migratingIn: ["alice"], release: false },
  ] as const)("recovers a same-release Shared replacement with proof of a fresh, unclaimed boot: %j", async ({ startedAt, state, migratingIn, release }) => {
    const h = harness({ pods: [targetPod], assignments: [assignment("u1", "alice", { state })], targetMountedUsers: [] });
    const read = vi.mocked(h.deps.readPodHealth).getMockImplementation()!;
    vi.mocked(h.deps.readPodHealth).mockImplementation(async (pod, gatewayId) => {
      const health = await read(pod, gatewayId);
      return health && { ...health, migratingIn, signedFleetState: { status: "ready", startedAt, users: [] } };
    });
    const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: false, recoverSharedPodAfter: 100 };

    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    expect(h.deps.releaseTarget).toHaveBeenCalledTimes(release ? 1 : 0);
    expect(h.deps.transfer).not.toHaveBeenCalled();
  });

  describe("sourceless Shared target with a leftover assignment", () => {
    const now = 900_000;
    const placed = (slug: string, gatewayId: string) => ({
      username: slug,
      provisioning: { openclaw: { gatewayId, slug } },
    });
    const stored = (row: SurgeAssignment) => ({
      ...row, gatewayId: "default", source: "migrate-user", createdAt: 1, updatedAt: 1,
    });
    const scenario = (targetMountedUsers: string[]) => {
      const rows = [assignment("u1", "alice"), assignment("u2", "bob"), assignment("u-gone", "isolatedcheck")];
      const records: Record<string, Record<string, unknown>> = {
        "gateways/default/assignments/u1": stored(rows[0]!),
        "gateways/default/assignments/u2": stored(rows[1]!),
        "gateways/default/assignments/u-gone": stored(rows[2]!),
        "users/u1": placed("alice", "default"),
        "users/u2": placed("bob", "default"),
        "users/u-gone": placed("isolatedcheck", "isolated-elsewhere"),
        "glmGateways/default": {
          docKind: "runtime", gatewayId: "default", release: 1, lifecycle: "active",
          heartbeat: { status: "ready", lastHeartbeatAt: 1, mountedCustomers: ["alice", "bob"] },
        },
      };
      const store = createDocumentFixtureStore(records);
      const h = harness({ pods: [targetPod], assignments: rows, targetMountedUsers });
      vi.mocked(h.deps.readAssignments).mockImplementation((gatewayId, liveRoster) =>
        readSurgeAssignments({ store, gatewayId, ...(liveRoster ? { liveRoster } : {}), now, log: h.deps.log }));
      return { h, records };
    };
    const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true };

    it.each([{}, { supersedingImageTag: "next-sha" }])("prunes the leftover row from the target's live roster and releases the target %j", async (queued) => {
      const { h, records } = scenario(["alice", "bob"]);

      await expect(reconcileSurgeUserHandoff(h.deps, { ...input, ...queued })).resolves.toEqual({ ready: false });

      expect(records["gateways/default/assignments/u-gone"]).toBeUndefined();
      expect(records["glmOperations/surge-prune-orphan-default-u-gone-1"]).toMatchObject({
        kind: "deprovision-user",
        status: "succeeded",
        input: { uid: "u-gone", slug: "isolatedcheck", gatewayId: "default", reason: "user-not-authoritative-runtime-unmounted" },
      });
      expect(h.events).toEqual(["release:target-uid"]);
    });

    it("keeps the target held while a user still placed here is unmounted", async () => {
      const { h, records } = scenario(["alice"]);

      await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });

      expect(records["gateways/default/assignments/u-gone"]).toBeUndefined();
      expect(records["gateways/default/assignments/u2"]).toBeDefined();
      expect(h.deps.releaseTarget).not.toHaveBeenCalled();
      expect(h.deps.recheckGatewayLater).toHaveBeenCalledWith("default");
    });
  });

  it.each([false, true])("retains Shared admission during a queued rollout with an incomplete serving roster (source present=%s)", async sourcePresent => {
    const h = harness({ pods: sourcePresent ? [oldPod, targetPod] : [targetPod], sourceMountedUsers: [],
      assignments: [assignment("u1", "alice", { state: "quiescing", updatedByOperationId: "surge-default-target-uid" })],
      targetMountedUsers: [] });
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", supersedingImageTag: "next-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.deps.markAssignment).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("fails closed when the source mounts a user without an assignment", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      sourceMountedUsers: ["alice", "orphan"],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("source mounted user orphan has no assignment");

    expect(h.events).toEqual([]);
  });

  it("restores owned assignments only after Kubernetes removes the old pod", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      targetMountedUsers: ["alice"],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: true });

    expect(h.events).toEqual(["assignment:u1:serving"]);
  });

  it("settles a Ready completed target without retrying its terminal attempt", async () => {
    const h = harness({ pods: [{ ...targetPod, ready: true }], targetReleased: true,
      assignments: [assignment("u1", "alice")], targetMountedUsers: ["alice"],
      terminalTargetByUid: { [targetPod.uid]: { migrationId: "surge-default-target-uid", slug: "alice", targetPodUid: targetPod.uid } } });
    await expect(reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha",
      requiresUserMigration: true, isolatedGateway: true, }))
      .resolves.toEqual({ ready: true });
    expect(h.events).toEqual([]);
    expect(h.deps.waitForSourceIdle).not.toHaveBeenCalled();
  });

  it("waits for a completed target to become Ready without requiring a different pod", async () => {
    const pods = [{ ...targetPod }], booting = [targetPod.uid];
    const phases: Record<string, SurgePodHealth["prelaunchState"]> = { [targetPod.uid]: "starting" };
    const h = harness({ pods, bootingUids: booting, prelaunchByUid: phases, targetReleased: true,
      assignments: [assignment("u1", "alice")], targetMountedUsers: ["alice"],
      terminalTargetByUid: { [targetPod.uid]: { migrationId: "surge-default-target-uid", slug: "alice", targetPodUid: targetPod.uid } } });
    const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
      isolatedGateway: true, };
    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    expect(h.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("waiting for a replacement pod"));
    pods[0] = { ...targetPod, ready: true };
    booting.splice(0);
    phases[targetPod.uid] = "serving";
    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: true });
    expect(h.events).toEqual([]);
    expect(h.deps.waitForSourceIdle).not.toHaveBeenCalled();
  });

  it("does not mark a source-less released replacement ready until every assigned user is mounted", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      targetMountedUsers: [],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: "surge-default-target-uid",
    });
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("assigned mounted roster"));
  });

  it("waits with both pods gated after target readiness opens", async () => {
    const h = harness({
      pods: [oldPod, { ...targetPod, ready: true }],
      targetReleased: true,
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });
    expect(h.events).toEqual([]);
  });

  it("releases a sourceless shared target, then heals its owned roster gates", async () => {
    const pods: SurgePod[] = [targetPod];
    const h = harness({
      pods,
      targetMountedUsers: ["alice"],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });
    expect(h.events).toEqual(["release:target-uid"]);

    h.setTargetReleased(true);
    pods[0] = { ...targetPod, ready: true };
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: true });
    expect(h.events).toEqual([
      "release:target-uid",
      "assignment:u1:serving",
    ]);
  });

  it("does not accept source loss while the old pod still exists but is NotReady", async () => {
    const h = harness({ pods: [{ ...oldPod, ready: false }, targetPod] });

    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(reconcileSurgeUserHandoff(h.deps, {
        gatewayId: "default",
        desiredImageTag: "new-sha",
        requiresUserMigration: true,
      })).resolves.toEqual({ ready: false });
    }
    expect(h.events).toEqual([]);
  });

  it("releases an empty release migration without requiring a healthy source pod", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "trial-op-000001",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      ownerlessOperatorPrewarm: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["release:target-uid"]);
  });

  it("keeps a non-empty operator prewarm closed while its source pod is NotReady", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "trial-op-000001",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      ownerlessOperatorPrewarm: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("leaves an empty same-release replacement to the pod-side readiness gate", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "trial-op-000001",
      desiredImageTag: "new-sha",
      requiresUserMigration: false,
      ownerlessOperatorPrewarm: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("does not bypass source health for an empty user gateway release migration", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      ownerlessOperatorPrewarm: false,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it.each([false, true])("retains an abandoned Shared gate without a mounted source (target present=%s)", async targetPresent => {
    const h = harness({ pods: targetPresent ? [oldPod, targetPod] : [oldPod], sourceMountedUsers: [],
      assignments: [assignment("u1", "alice", { state: "quiescing", updatedByOperationId: abandonedOperationId })] });
    const run = reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
    });
    if (targetPresent) await expect(run).rejects.toThrow("source has unmounted assigned user alice");
    else await expect(run).resolves.toEqual({ ready: false });
    expect(h.deps.markAssignment).not.toHaveBeenCalled();
    expect(h.deps.transfer).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({ state: "quiescing", updatedByOperationId: abandonedOperationId });
  });

  it("reclaims an abandoned surge gate before retrying the verified handoff", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    const readHealth = h.deps.readPodHealth;
    h.deps.readPodHealth = vi.fn<SurgeUserHandoffDeps["readPodHealth"]>(async (...args) => {
      const health = (await readHealth(...args))!;
      return args[0].uid === targetPod.uid ? health : { ...health, handoffReleased: true, prelaunchState: "serving" };
    });
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:serving",
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "release:target-uid",
    ]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: h.operationId,
    });
  });

  it("reclaims the completed prior handoff when its target becomes the next Ready source", async () => {
    const priorTargetUid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const priorTarget = {
      ...oldPod,
      uid: priorTargetUid,
      name: "gateway-prior-target",
    };
    const priorOperationId = `surge-default-${priorTargetUid}`;
    const h = harness({
      pods: [priorTarget, targetPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: priorOperationId,
      })],
    });

    const readHealth = h.deps.readPodHealth;
    h.deps.readPodHealth = vi.fn<SurgeUserHandoffDeps["readPodHealth"]>(async (...args) => {
      const health = (await readHealth(...args))!;
      return args[0].uid === targetPod.uid ? health : { ...health, handoffReleased: true, prelaunchState: "serving" };
    });
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:serving",
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "release:target-uid",
    ]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: h.operationId,
    });
  });

  it("reopens an abandoned Shared gate after exact Native custody resumes on its sole source", async () => {
    const h = harness({
      pods: [oldPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    const readHealth = h.deps.readPodHealth;
    h.deps.readPodHealth = vi.fn<SurgeUserHandoffDeps["readPodHealth"]>(async (...args) => ({ ...(await readHealth(...args))!, handoffReleased: true, prelaunchState: "serving" }));
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["assignment:u1:serving"]);
    expect(h.assignments()[0]).toMatchObject({
      state: "serving",
      updatedByOperationId: abandonedOperationId,
    });
  });

  it("keeps an assignment gated while its owner pod object is terminating", async () => {
    const h = harness({
      pods: [oldPod],
      observedPodUids: [oldPod.uid, abandonedPodUid],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: abandonedOperationId,
    });
  });

  it("retains an abandoned Shared gate without matching scheduler custody after pod replacement", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      targetMountedUsers: ["alice"],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    h.deps.scheduler = vi.fn(async () => { throw new Error("Cron migration must acquire hold before this phase"); });
    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("must acquire hold");

    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: abandonedOperationId,
    });
  });

  it("does not reclaim a surge gate while its owning pod still exists", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-old-uid",
      })],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow(/foreign assignment gate/);
    expect(h.events).toEqual([]);
  });

  it("does not reclaim a surge gate owned by a gateway with a shared prefix", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: otherGatewayOperationId,
      })],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow(/foreign assignment gate/);
    expect(h.events).toEqual([]);
  });

  it("retains Native custody when an unrelated operation is no longer running", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "placement-f061f700711dbdec1d7f8f2add33d1d3",
      })],
      ownerOperations: {
        "placement-f061f700711dbdec1d7f8f2add33d1d3": { status: "failed" },
      },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("foreign assignment gate");

    expect(h.events).toEqual([]);
    expect(h.deps.scheduler).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("does not reopen a terminal migration's source gate before native recovery", async () => {
    const owner = "builder-activate-alice-s-12345678-g1";
    const h = harness({ assignments: [assignment("u1", "alice", { state: "quiescing", updatedByOperationId: owner })],
      ownerOperations: { [owner]: { status: "failed", sourceRecoveryPending: true } },
    });
    await expect(reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true, })).rejects.toThrow(/foreign assignment gate/);
    expect(h.events).toEqual([]);
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("retains Native custody when an unrelated operation no longer exists", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "placement-deleted",
      })],
      ownerOperations: { "placement-deleted": null },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("foreign assignment gate");

    expect(h.events).toEqual([]);
    expect(h.deps.scheduler).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("refuses a foreign migration gate", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "migrate-user-op",
      })],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow(/foreign assignment gate/);
    expect(h.events).toEqual([]);
  });

  it("keeps assignments fenced when transfer may have upgraded the target", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("rsync failed");
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
    ]);
  });

  it("preserves configured isolated target state when its transfer fails", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
    })).rejects.toThrow("rsync failed");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "hold-target:target-uid:alice",
      "resume-source:old-uid:alice",
      "assignment:u1:serving",
    ]);
    expect(h.deps.discardTargetUser).not.toHaveBeenCalled();
  });

  it.each(["old-image", "source-held", "source-unready", "source-terminating", "source-missing-roster", "source-migrating",
    "target-starting", "target-hydrated", "target-released", "target-mounted", "target-migrating", "target-terminating",
    "missing-held-proof", "false-held-proof", "wrong-terminal-slug", "quiescing-assignment", "third-observed-uid",
    "budget-spent", "changed-after-budget", "epoch-after-budget", "owner-after-budget", "source-name-after-budget"])("refuses cancelled-target replacement when %s", async fault => {
    const pods = [{ ...oldPod }, { ...targetPod }];
    const assigned = assignment("u1", "alice", fault === "quiescing-assignment" ? { state: "quiescing", updatedByOperationId: "foreign" } : {});
    const h = harness({ pods, observedPodUids: fault === "third-observed-uid" ? [oldPod.uid, targetPod.uid, "pending"] : undefined,
      assignments: [assigned],
      evictionBudgetSpent: fault === "budget-spent" });
    if (fault === "source-unready") pods[0].ready = false;
    if (fault === "source-terminating") pods[0].terminating = true;
    if (fault === "target-terminating") pods[1].terminating = true;
    vi.mocked(h.deps.readPodHealth).mockImplementation(async pod => ({
      status: pod.uid === oldPod.uid ? "ready" : "booting", version: pod.uid === oldPod.uid ? "old-sha" : "new-sha",
      fleetSignatureCapability: "gateway-scoped", handoffReleased: pod.uid === targetPod.uid && fault === "target-released",
      prelaunchState: pod.uid === oldPod.uid ? fault === "source-held" ? "held" : "serving" :
        fault === "target-starting" ? "starting" : fault === "target-hydrated" ? "hydrated" : "held",
      mountedCustomers: pod.uid === oldPod.uid ? fault === "source-missing-roster" ? [] : ["alice"] : fault === "target-mounted" ? ["alice"] : [],
      migratingIn: (pod.uid === oldPod.uid && fault === "source-migrating") || (pod.uid === targetPod.uid && fault === "target-migrating") ? ["alice"] : [],
      ...(pod.uid === targetPod.uid ? { terminalTarget: { migrationId: h.operationId, targetPodUid: pod.uid,
        slug: fault === "wrong-terminal-slug" ? "bob" : "alice",
        ...(fault === "missing-held-proof" ? {} : { processHeld: fault !== "false-held-proof" }) } } : {}),
    }));
    if (["changed-after-budget", "epoch-after-budget", "owner-after-budget", "source-name-after-budget"].includes(fault)) vi.mocked(h.deps.claimCrashLoopEviction).mockImplementation(async () => {
      if (fault === "changed-after-budget") pods[0].ready = false;
      if (fault === "epoch-after-budget") assigned.epoch += 1;
      if (fault === "owner-after-budget") assigned.updatedByOperationId = "another-operation";
      if (fault === "source-name-after-budget") pods[0].name = "another-source";
      return { allowed: true, count: 1, budget: 3 };
    });
    await reconcileSurgeUserHandoff(h.deps, { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
      isolatedGateway: fault !== "old-image", });
    expect(h.deps.deleteCancelledTarget).not.toHaveBeenCalled();
    expect(h.deps.waitForSourceIdle).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("preserves every touched target when a later transfer fails", async () => {
    const h = harness({
      transferError: new Error("bob rsync failed"),
      transferErrorSlug: "bob",
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("bob rsync failed");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
    ]);
  });

  it("cleans stale target mounts before replaying a handoff", async () => {
    const h = harness({ targetMountedUsers: ["alice"] });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "discard:alice",
      "assignment:u1:serving",
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
      "release:target-uid",
    ]);
  });

  it("preserves a configured isolated target mount before replaying a handoff", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      targetMountedUsers: ["alice"],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "release:target-uid",
    ]);
    expect(h.deps.discardTargetUser).not.toHaveBeenCalled();
  });

  it("transfers into a held prelaunch isolated target whose OpenClaw is intentionally stopped", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toContain("transfer:alice");
    expect(h.events).toContain("release:target-uid");
  });

  it("keeps a booting non-prelaunch target out of transfer", async () => {
    const booting = harness({
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
    });
    await expect(reconcileSurgeUserHandoff(booting.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });
    expect(booting.events).toEqual([]);

    const starting = harness({
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "starting" },
    });
    await expect(reconcileSurgeUserHandoff(starting.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });
    expect(starting.events).toEqual([]);
  });

  it("retries the handoff for a isolated target left released but held by a rollback race", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      targetReleased: true,
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "hydrated" },
      targetMountedUsers: ["alice"],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toContain("transfer:alice");
    expect(h.events).toContain("release:target-uid");
  });

  it("retries a verified held target without resuming its old source", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["stop-source:old-uid:alice", "hold-target:target-uid:alice", "stop-source:old-uid:alice", "hold-target:target-uid:alice", "release:target-uid"]);
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
  });

  it("keeps source admission closed during forward retry", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "hydrated" },
    });
    vi.mocked(h.deps.resumeSourceIngress).mockImplementation(async () => {
      expect(h.assignments()[0].state).toBe("quiescing");
    });
    await reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
      isolatedGateway: true,
    });
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("does not read assignments for a shared gateway whose source is missing or NotReady", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      bootingUids: [oldPod.uid],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });

    expect(h.deps.readAssignments).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("leaves a NotReady non-held user source to recover on its own", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [assignment("u1", "alice")],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "serving", [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
  });

  it("releases an assigned user only after observing no physical source", async () => {
    const h = harness({
      pods: [targetPod],
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["hold-target:target-uid:alice", "release:target-uid"]);
  });

  it("leaves assignments open when a legacy source cannot begin a scoped handoff", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      fleetSignatureCapabilityByUid: { [oldPod.uid]: "legacy" },
    });
    const input = {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    };

    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.deps.readAssignments).not.toHaveBeenCalled();
    expect(h.deps.quiesce).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it("does not settle a ready legacy target through assignment or release control", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      targetReleased: true,
      targetMountedUsers: ["alice"],
      fleetSignatureCapabilityByUid: { [targetPod.uid]: "legacy" },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.deps.readAssignments).not.toHaveBeenCalled();
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it("gates only the stale target user when retry cleanup fails", async () => {
    const h = harness({
      targetMountedUsers: ["alice"],
      discardError: new Error("stale target cleanup failed"),
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("stale target cleanup failed");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "discard:alice",
    ]);
    expect(h.assignments().find((item) => item.uid === "u2")?.state).toBe("serving");
  });

  it("preserves both imports without invoking batch cleanup after a possible upgrade", async () => {
    const h = harness({
      transferError: new Error("bob rsync failed"),
      transferErrorSlug: "bob",
      discardError: new Error("target cleanup failed"),
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("bob rsync failed");

    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "assignment:u2:quiescing",
      "quiesce:bob",
      "transfer:bob",
    ]);
  });

  it("preserves an earlier forward import when a later roster gate fails", async () => {
    const h = harness({ markErrorUid: "u2" });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("assignment write failed");
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "assignment:u2:quiescing",
    ]);
  });

  it("keeps admission closed without discarding a possibly upgraded import", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      transferError: new Error("rsync failed"),
      discardError: new Error("target cleanup failed"),
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("rsync failed");
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
    ]);
  });

  it("confirms a committed target release when its HTTP response is lost", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      releaseErrorAfterCommit: new Error("connection reset"),
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).resolves.toEqual({ ready: false });
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "release:target-uid",
    ]);
  });

  it("retries a isolated target release after it returns to hold", async () => {
    const wait = vi.fn(async () => undefined);
    const h = harness({
      assignments: [assignment("u1", "alice")],
      prelaunchByUid: { [targetPod.uid]: "hydrated" },
      releaseErrorBeforeCommit: new Error("target supervisor restarted"),
      releaseErrorBeforeCommitOnce: true,
      wait,
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(wait).toHaveBeenCalledWith(7_000);
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "release:target-uid",
      "release:target-uid",
    ]);
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
  });

  it("confirms a isolated target release that commits during the retry delay", async () => {
    const target: { release: () => void } = { release: () => {} };
    const wait = vi.fn(async () => {
      target.release();
    });
    const h = harness({
      assignments: [assignment("u1", "alice")],
      releaseErrorBeforeCommit: new Error("connection reset"),
      wait,
    });
    target.release = () => h.setTargetReleased(true);

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
    })).resolves.toEqual({ ready: false });

    expect(wait).toHaveBeenCalledWith(7_000);
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "flush:old-uid:alice:migration-final",
      "hold-target:target-uid:alice",
      "stop-source:old-uid:alice",
      "transfer:alice",
      "release:target-uid",
    ]);
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
  });

  it("keeps admission closed when target release cannot be confirmed", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice")],
      releaseErrorBeforeCommit: new Error("connection refused"),
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
    })).rejects.toThrow("connection refused");
    expect(h.events).toEqual([
      "assignment:u1:quiescing",
      "quiesce:alice",
      "transfer:alice",
      "release:target-uid",
    ]);
    expect(h.assignments()[0]).toMatchObject({
      state: "quiescing",
      updatedByOperationId: h.operationId,
    });
  });
  it("stands down instead of converging a pod a pending release replaces", async () => {
    const h = harness();

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments().every((item) => item.state === "serving")).toBe(true);
  });

  it("retries a verified held user while a later release is pending", async () => {
    const h = harness({
      pods: [{ ...oldPod, ready: false }, targetPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      bootingUids: [oldPod.uid, targetPod.uid],
      prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "hydrated" },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["stop-source:old-uid:alice", "hold-target:target-uid:alice", "stop-source:old-uid:alice", "hold-target:target-uid:alice", "release:target-uid"]);
  });

  it("releases a live source voice hold when superseding a held isolated target", async () => {
    const h = harness({
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      prelaunchByUid: { [targetPod.uid]: "hydrated" },
    });
    vi.mocked(h.deps.resumeSourceIngress).mockImplementation(async () => {
      expect(h.assignments()[0].state).toBe("quiescing");
    });
    await reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
      isolatedGateway: true, supersedingImageTag: "next-sha",
    });
    expect(h.deps.resumeSourceIngress).toHaveBeenCalledOnce();
    expect(h.assignments()[0].state).toBe("serving");
  });

  it.each([false, true])("keeps source admission closed when a superseded target may be executing (held=%s)", async (held) => {
    const h = harness({
      pods: [{ ...oldPod, ready: !held }, targetPod],
      assignments: [{ ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: "surge-default-target-uid" }],
      bootingUids: [targetPod.uid, ...(held ? [oldPod.uid] : [])],
      prelaunchByUid: { [oldPod.uid]: held ? "held" : "serving", [targetPod.uid]: "starting" },
    });
    await reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
      isolatedGateway: true, supersedingImageTag: "next-sha",
    });
    expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    expect(h.deps.resumeSourceIngress).not.toHaveBeenCalled();
    expect(h.assignments()[0].state).toBe("quiescing");
  });

  it("unreserves a sourceless isolated target while standing down for a pending release", async () => {
    const h = harness({
      pods: [targetPod],
      assignments: [assignment("u1", "alice")],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual(["unreserve-target:target-uid:alice"]);
  });

  it("still settles a released target while a rollout is queued", async () => {
    const h = harness({
      pods: [{ ...targetPod, ready: true }],
      targetReleased: true,
      targetMountedUsers: ["alice"],
      assignments: [assignment("u1", "alice")],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: true });
  });

  it("reopens a gated lease for the sourceless target it unreserves while standing down", async () => {
    const h = harness({
      pods: [targetPod],
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
      bootingUids: [targetPod.uid],
      prelaunchByUid: { [targetPod.uid]: "held" },
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      isolatedGateway: true,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([
      "unreserve-target:target-uid:alice",
      "assignment:u1:serving",
    ]);
  });

  it("retains its source gate when a superseded shared target has unknown execution state", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: "surge-default-target-uid",
      })],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({ state: "quiescing" });
  });

  it("retains an abandoned source gate until a superseded shared target is known held", async () => {
    const h = harness({
      assignments: [assignment("u1", "alice", {
        state: "quiescing",
        updatedByOperationId: abandonedOperationId,
      })],
    });

    await expect(reconcileSurgeUserHandoff(h.deps, {
      gatewayId: "default",
      desiredImageTag: "new-sha",
      requiresUserMigration: true,
      supersedingImageTag: "next-sha",
    })).resolves.toEqual({ ready: false });

    expect(h.events).toEqual([]);
    expect(h.assignments()[0]).toMatchObject({ state: "quiescing" });
  });
});

describe("crash-looping surge target self-heal", () => {
  const wedgedTarget: SurgePod = { ...targetPod, crashLooping: true };
  const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: false, };

  it("deletes an unreachable crash-looping target so a fresh pod restarts the handoff, while the predecessor keeps serving", async () => {
    const h = harness({ pods: [oldPod, wedgedTarget], unreachableUids: [wedgedTarget.uid] });

    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });

    expect(h.deps.claimCrashLoopEviction).toHaveBeenCalledExactlyOnceWith({ gatewayId: "default", imageTag: "new-sha", pod: wedgedTarget });
    expect(h.deps.deleteCrashLoopingPod).toHaveBeenCalledExactlyOnceWith({ gatewayId: "default", pod: wedgedTarget });
    expect(h.events).toEqual([`delete-pod:${wedgedTarget.uid}`]);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringMatching(/deleted crash-looping surge target pod=gateway-new \(eviction 1 of 3 for image new-sha\)/));
  });

  it("leaves the pod in place once the eviction budget for that image is spent, so a broken release stays visible", async () => {
    const h = harness({ pods: [oldPod, wedgedTarget], unreachableUids: [wedgedTarget.uid], evictionBudgetSpent: true });

    await reconcileSurgeUserHandoff(h.deps, input).catch(() => undefined);

    expect(h.deps.deleteCrashLoopingPod).not.toHaveBeenCalled();
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringMatching(/leaving crash-looping surge target pod=gateway-new in place: the eviction budget of 3 for image new-sha is spent/));
  });

  it("leaves the pod alone when it is the only pod, when it is merely unreachable, or when it is Ready", async () => {
    const alone = harness({ pods: [wedgedTarget], unreachableUids: [wedgedTarget.uid] });
    await reconcileSurgeUserHandoff(alone.deps, input);
    expect(alone.deps.deleteCrashLoopingPod).not.toHaveBeenCalled();

    const unreachable = harness({ pods: [oldPod, targetPod], unreachableUids: [targetPod.uid] });
    await reconcileSurgeUserHandoff(unreachable.deps, input);
    expect(unreachable.deps.deleteCrashLoopingPod).not.toHaveBeenCalled();

    const readyButFlagged = harness({ pods: [{ ...oldPod, crashLooping: true }, targetPod] });
    await expect(reconcileSurgeUserHandoff(readyButFlagged.deps, input)).rejects.toThrow("scheduler physical custody changed");
    expect(readyButFlagged.deps.deleteCrashLoopingPod).not.toHaveBeenCalled();
  });
});

describe("surge user handoff on a lone shared pod", () => {
  const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true, isolatedGateway: false };

  it("asks for a later recheck while the lone pod's health is unavailable", async () => {
    const h = harness({ pods: [targetPod], unreachableUids: [targetPod.uid] });
    await expect(reconcileSurgeUserHandoff(h.deps, input)).resolves.toEqual({ ready: false });
    expect(h.deps.recheckGatewayLater).toHaveBeenCalledExactlyOnceWith("default");
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();
  });

  it("does not ask for a recheck once the lone ready pod serves its assigned users", async () => {
    const h = harness({ pods: [oldPod] });
    await reconcileSurgeUserHandoff(h.deps, input);
    expect(h.deps.recheckGatewayLater).not.toHaveBeenCalled();
  });

  it("rechecks a new gateway's booting target on every pass until OpenClaw is up, then releases it", async () => {
    const newGateway = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: false, isolatedGateway: false };
    const bootingUids = [targetPod.uid];
    const h = harness({ pods: [targetPod], assignments: [], bootingUids });

    await expect(reconcileSurgeUserHandoff(h.deps, newGateway)).resolves.toEqual({ ready: false });
    await expect(reconcileSurgeUserHandoff(h.deps, newGateway)).resolves.toEqual({ ready: false });
    expect(h.deps.recheckGatewayLater).toHaveBeenCalledTimes(2);
    expect(h.deps.recheckGatewayLater).toHaveBeenCalledWith("default");
    expect(vi.mocked(h.deps.log).mock.calls.filter(([message]) =>
      message.includes("target is booting; rechecking gateway=default target=gateway-new"))).toHaveLength(2);
    expect(h.deps.releaseTarget).not.toHaveBeenCalled();

    bootingUids.splice(0);
    vi.mocked(h.deps.recheckGatewayLater).mockClear();
    await reconcileSurgeUserHandoff(h.deps, newGateway);
    expect(h.events).toEqual(["release:target-uid"]);
    expect(h.deps.recheckGatewayLater).not.toHaveBeenCalled();
  });
});
