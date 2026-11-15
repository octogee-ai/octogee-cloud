import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSurgeOpenClawProcessGate } from "../../gateway-supervisor/lib/surge-openclaw-process-gate.js";
import { reconcileSurgeUserHandoff, type SurgePod } from "../../fleet-controller/src/surge-user-handoff.js";
import { oldPod, targetPod, assignment, createSurgeHandoffHarness } from "../../fleet-controller/src/__tests__/fixtures/surge-user-handoff.js";

const harness = (input: Parameters<typeof createSurgeHandoffHarness>[1] = {}) => createSurgeHandoffHarness(vi.fn, input);

describe("real process-gate terminal target recovery", () => {
  it.each([false, true])("preserves source recovery after a terminal target rollback (superseding=%s)", async (superseding) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "surge-terminal-target-"));
    try {
      const gate = createSurgeOpenClawProcessGate(root);
      await gate.ensure({ podUid: targetPod.uid, readinessReleased: false });
      const scenario = { assignments: [assignment("u1", "alice")], transferError: new Error("first transfer failed"),
        resumeSourceError: superseding ? new Error("source resume refused") : undefined, pods: [oldPod, targetPod] };
      const h = harness(scenario);
      const originalHealth = vi.mocked(h.deps.readPodHealth).getMockImplementation()!;
      vi.mocked(h.deps.readPodHealth).mockImplementation(async (pod, gatewayId) => {
        const health = await originalHealth(pod, gatewayId);
        if (!health || pod.uid !== targetPod.uid) return health;
        const state = await gate.read();
        return { ...health, status: "booting", prelaunchState: "held", terminalTarget: state?.terminalTarget };
      });
      vi.mocked(h.deps.holdTargetOpenClaw!).mockImplementation(async ({ operationId, slug }) => {
        h.events.push(`hold-target:${targetPod.uid}:${slug}`);
        const request = { podUid: targetPod.uid, migrationId: operationId, slug, targetPodUid: targetPod.uid };
        const held = await gate.hold(request);
        if (held.phase === "cancelling") await gate.finalizeTargetCancellation(request);
        else await gate.markHeld(request);
      });
      const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
        isolatedGateway: true };
      await expect(reconcileSurgeUserHandoff(h.deps, input)).rejects.toThrow(superseding ? "source resume refused" : "first transfer failed");
      expect(await gate.read()).toMatchObject({ role: "normal", mode: "held", phase: "held",
        terminalTarget: { migrationId: h.operationId, slug: "alice", targetPodUid: targetPod.uid } });
      expect(h.assignments()[0].state).toBe(superseding ? "quiescing" : "serving");
      scenario.resumeSourceError = undefined;
      if (superseding) scenario.pods[0] = { ...oldPod, ready: false };
      const firstAttempt = [...h.events];
      const drainCount = vi.mocked(h.deps.waitForSourceIdle).mock.calls.length;
      await expect(reconcileSurgeUserHandoff(h.deps, { ...input,
        ...(superseding ? { supersedingImageTag: "next-sha" } : {}) })).resolves.toEqual({ ready: false });
      expect(h.events).toEqual(superseding ? [...firstAttempt, "resume-source:old-uid:alice", "assignment:u1:serving"] : firstAttempt);
      expect(h.deps.waitForSourceIdle).toHaveBeenCalledTimes(drainCount);
      expect(h.assignments()[0].state).toBe("serving");
      await expect(gate.hold({ podUid: targetPod.uid, migrationId: h.operationId, slug: "alice", targetPodUid: targetPod.uid }))
        .rejects.toThrow("target migration already released");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("replaces a cancelled held target before retrying the same artifact on a fresh UID", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "surge-terminal-replace-"));
    try {
      const gate = createSurgeOpenClawProcessGate(root);
      await gate.ensure({ podUid: targetPod.uid, readinessReleased: false });
      const request = { podUid: targetPod.uid, migrationId: "surge-default-target-uid", slug: "alice", targetPodUid: targetPod.uid };
      await gate.hold(request);
      await gate.markHeld(request);
      await gate.hold(request);
      await gate.finalizeTargetCancellation(request);
      const terminal = (await gate.read())!.terminalTarget!;
      const pods = [oldPod, targetPod];
      const h = harness({ pods, assignments: [assignment("u1", "alice")] });
      const fresh = { ...targetPod, uid: "fresh-uid", name: "fresh-pod" };
      let released = false;
      vi.mocked(h.deps.readPodHealth).mockImplementation(async pod => ({
        status: pod.uid === oldPod.uid || released ? "ready" : "booting", version: pod.uid === oldPod.uid ? "old-sha" : "new-sha",
        fleetSignatureCapability: "gateway-scoped", handoffReleased: pod.uid === fresh.uid && released,
        prelaunchState: pod.uid === oldPod.uid || released ? "serving" : "held",
        mountedCustomers: pod.uid === oldPod.uid || released ? ["alice"] : [], migratingIn: [],
        ...(pod.uid === targetPod.uid ? { terminalTarget: { ...terminal, processHeld: true } } : {}),
      }));
      const remove = vi.fn(async ({ pod }: { pod: SurgePod }) => { h.events.push(`delete-cancelled:${pod.uid}`); });
      Object.assign(h.deps, { deleteCancelledTarget: remove });
      const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true,
        isolatedGateway: true };
      expect(await reconcileSurgeUserHandoff(h.deps, input)).toEqual({ ready: false });
      expect(remove).toHaveBeenCalledExactlyOnceWith({ gatewayId: "default", pod: targetPod });
      expect(h.events).toEqual([`delete-cancelled:${targetPod.uid}`]);
      expect(h.deps.waitForSourceIdle).not.toHaveBeenCalled();
      expect(await gate.read()).toMatchObject({ terminalTarget: terminal, mode: "held", phase: "held" });
      pods[1] = { ...targetPod, terminating: true };
      await reconcileSurgeUserHandoff(h.deps, input);
      expect(h.deps.waitForSourceIdle).not.toHaveBeenCalled();
      pods.push(fresh);
      await expect(reconcileSurgeUserHandoff(h.deps, input)).rejects.toThrow("multiple source pods");
      expect(h.deps.waitForSourceIdle).not.toHaveBeenCalled();
      pods.splice(1, 1);
      vi.mocked(h.deps.listPods).mockResolvedValueOnce({ pods: [...pods], observedPodUids: [oldPod.uid, targetPod.uid, fresh.uid] });
      await reconcileSurgeUserHandoff(h.deps, input);
      expect(h.deps.waitForSourceIdle).not.toHaveBeenCalled();
      await gate.ensure({ podUid: fresh.uid, readinessReleased: false });
      vi.mocked(h.deps.holdTargetOpenClaw!).mockImplementation(async ({ operationId, slug, targetPod: pod }) => {
        const next = { podUid: pod.uid, migrationId: operationId, slug, targetPodUid: pod.uid };
        await gate.hold(next); await gate.markHeld(next);
      });
      vi.mocked(h.deps.releaseTarget).mockImplementation(async ({ pod }) => { released = true; h.events.push(`release:${pod.uid}`); });
      await reconcileSurgeUserHandoff(h.deps, input);
      expect(h.deps.transfer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: "surge-default-fresh-uid", targetPod: fresh }));
      expect(h.events).toContain(`release:${fresh.uid}`);
      expect(remove).toHaveBeenCalledTimes(1);
      pods.splice(0, 1); pods[0] = { ...fresh, ready: true };
      expect(await reconcileSurgeUserHandoff(h.deps, input)).toEqual({ ready: true });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

});

describe("real target reservation inspection during forward retry", () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])("preserves the target reservation across retries and supervisor restart (completionStarted=%s, sourceless=%s)", async (completionStarted, sourceless) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "surge-inspect-target-"));
    vi.stubEnv("POD_UID", targetPod.uid);
    try {
      const { createHoldSurgeOpenClawHandler } = await import("../../gateway-supervisor/lib/surge-openclaw-process-http.js");
      const { signFleetRequest, gatewayScopedJobId } = await import("../../gateway-supervisor/lib/fleet-signature.js");
      const { SIGNATURE_HEADER } = await import("../../shared/types/fleet-controller.js");
      const { FLEET_KEY_PAIR } = await import("../../gateway-supervisor/__tests__/fixtures/fleet-keys.js");
      let gate = createSurgeOpenClawProcessGate(root);
      const request = { podUid: targetPod.uid, migrationId: "surge-default-target-uid", slug: "alice", targetPodUid: targetPod.uid };
      await gate.ensure({ podUid: targetPod.uid, readinessReleased: false });
      if (!sourceless || completionStarted) { await gate.hold(request); await gate.markHeld(request); }
      if (completionStarted) { await gate.claimTargetCompletion(request); await gate.reholdTarget(request); await gate.markHeld(request); }
      const h = harness({ pods: sourceless ? [targetPod] : [{ ...oldPod, ready: false }, targetPod],
        assignments: [sourceless ? assignment("u1", "alice") : { ...assignment("u1", "alice"), state: "quiescing", updatedByOperationId: request.migrationId }],
        bootingUids: [oldPod.uid, targetPod.uid], prelaunchByUid: { [oldPod.uid]: "held", [targetPod.uid]: "held" } });
      vi.mocked(h.deps.holdTargetOpenClaw!).mockImplementation(async input => {
        const processGate = {
          status: async () => (await gate.read())!,
          hydrate: async (r: Omit<typeof request, "podUid">) => gate.hydrateTarget({ ...r, podUid: targetPod.uid }),
          hold: async (r: Omit<typeof request, "podUid">) => gate.hold({ ...r, podUid: targetPod.uid }),
          resume: async (r: Omit<typeof request, "podUid">) => gate.resumeSource({ ...r, podUid: targetPod.uid }),
          unreserve: async (r: Omit<typeof request, "podUid">) => gate.unreserveTarget({ ...r, podUid: targetPod.uid }),
          finalizeTargetCancellation: async (r: Omit<typeof request, "podUid">) => gate.finalizeTargetCancellation({ ...r, podUid: targetPod.uid }),
        };
        const handler = createHoldSurgeOpenClawHandler({ publicKey: FLEET_KEY_PAIR.publicKey, gatewayId: "default", configuredBuilder: () => true, processGate });
        const body = { migrationId: input.operationId, slug: input.slug, targetPodUid: input.targetPod.uid, receivingPodUid: input.targetPod.uid, inspectTarget: input.inspectTarget, reserveTarget: input.reserveTarget };
        const rawBody = JSON.stringify(body);
        const signature = signFleetRequest(FLEET_KEY_PAIR.privateKey, gatewayScopedJobId(input.operationId, "default"), rawBody);
        let status = 200; let result: Record<string, unknown> = {};
        const res = { status(code: number) { status = code; return this; }, json(value: Record<string, unknown>) { result = value; } };
        await handler({ rawBody, params: { gatewayId: "default" }, header: (name: string) => name.toLowerCase() === SIGNATURE_HEADER.toLowerCase() ? signature : undefined } as never, res as never, vi.fn());
        if (status !== 200) throw new Error(JSON.stringify(result));
        return { completionStarted: result.completionStarted as boolean | undefined };
      });
      const input = { gatewayId: "default", desiredImageTag: "new-sha", requiresUserMigration: true, isolatedGateway: true };
      if (sourceless) vi.mocked(h.deps.releaseTarget).mockImplementationOnce(async () => {
        await gate.claimTargetCompletion(request);
        await gate.reholdTarget(request);
        await gate.markHeld(request);
        throw new Error("Native start failed");
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = reconcileSurgeUserHandoff(h.deps, input);
        if (sourceless && attempt === 0) await expect(result).rejects.toThrow("Native start failed");
        else await expect(result).resolves.toEqual({ ready: false });
        expect(await gate.read()).toMatchObject({ role: "target", mode: "held", phase: "held", completionStarted: sourceless || completionStarted });
        gate = createSurgeOpenClawProcessGate(root);
        await gate.ensure({ podUid: targetPod.uid, readinessReleased: false });
      }
      expect(h.deps.transfer).toHaveBeenCalledTimes(completionStarted || sourceless ? 0 : 2);
      expect(h.deps.releaseTarget).toHaveBeenCalledTimes(2);
      expect(h.deps.resumeSourceOpenClaw).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
