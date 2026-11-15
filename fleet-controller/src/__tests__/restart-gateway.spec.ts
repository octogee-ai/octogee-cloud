import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import { createRestartGatewayHandler } from "../handlers/restart-gateway";
import type { RestartGatewayDeps } from "../handlers/restart-gateway";
import type { OperationContext } from "../operation-router";
import type { KubeOps } from "../lib/kube-ops";

function mkOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: "op-restart-1",
    kind: "restart-gateway",
    status: "pending",
    createdBy: "admin@octogee.com",
    createdAt: 0,
    startedAt: null,
    completedAt: null,
    input: { gatewayId: "walter" },
    steps: [],
    ...overrides,
  };
}

function mkCtx() {
  const reported: OperationStep[] = [];
  const ctx: OperationContext = {
    reportStep: async (step) => {
      reported.push(step);
    },
  };
  return { ctx, reported };
}

function kubeOps(restartOpenClawInPlace: KubeOps["restartOpenClawInPlace"] = vi.fn(async () => undefined)): KubeOps {
  const unused = (name: string) => vi.fn(async () => {
    throw new Error(`restart-gateway must not call kubeOps.${name}`);
  });
  return {
    scaleDeployment: unused("scaleDeployment"),
    restartOpenClawInPlace,
    readDeployedReplicas: unused("readDeployedReplicas"),
    readAvailableReplicas: unused("readAvailableReplicas"),
    readGatewayPodDiagnostics: unused("readGatewayPodDiagnostics"),
    readGatewayPodDiagnosticsBatch: unused("readGatewayPodDiagnosticsBatch"),
    deletePersistentVolumeClaim: unused("deletePersistentVolumeClaim"),
    deleteSecret: unused("deleteSecret"),
    deleteServiceAccount: unused("deleteServiceAccount"),
    deleteService: unused("deleteService"),
  };
}

function mkDeps(overrides: Partial<RestartGatewayDeps> = {}): RestartGatewayDeps {
  return {
    kubeOps: kubeOps(),
    namespace: "octogee-test",
    resolveLiveRevisionId: vi.fn(async (gatewayId: string) => `${gatewayId}-r7`),
    now: () => 1000,
    log: vi.fn(),
    ...overrides,
  };
}

describe("createRestartGatewayHandler", () => {
  it('uses only the journaled restore recovery owner rather than the ordinary restart path', async () => {
    const recoverRestore = vi.fn(async () => {});
    const deps = mkDeps({ recoverRestore });
    const op = mkOp({ input: { gatewayId: 'shared-1', restoreRecovery: { operationId: 'return' } } });
    const { ctx } = mkCtx();
    expect((await createRestartGatewayHandler(deps)(op, ctx)).success).toBe(true);
    expect(recoverRestore).toHaveBeenCalledWith(op, ctx);
    expect(deps.kubeOps.restartOpenClawInPlace).not.toHaveBeenCalled();
  });
  it('does not fall back to ordinary restart when restore recovery is unavailable', async () => {
    const deps = mkDeps();
    const result = await createRestartGatewayHandler(deps)(mkOp({ input: { gatewayId: 'shared-1', restoreRecovery: {} } }), mkCtx().ctx);
    expect(result.success).toBe(false);
    expect(deps.kubeOps.restartOpenClawInPlace).not.toHaveBeenCalled();
  });
  it('delegates explicit source repair without ordinary process restart or restore authority', async () => {
    const recoverSource = vi.fn(async () => {}), deps = mkDeps({ recoverSource });
    const op = mkOp({ input: { gatewayId: 'shared-1', sourceRecovery: {} } }), { ctx } = mkCtx();
    expect((await createRestartGatewayHandler(deps)(op, ctx)).success).toBe(true);
    expect(recoverSource).toHaveBeenCalledWith(op, ctx);
    expect(deps.resolveLiveRevisionId).not.toHaveBeenCalled(); expect(deps.kubeOps.restartOpenClawInPlace).not.toHaveBeenCalled();
  });
  it('refuses unavailable source repair without falling back to an ordinary restart', async () => {
    const deps = mkDeps();
    expect((await createRestartGatewayHandler(deps)(mkOp({ input: { gatewayId: 'shared-1', sourceRecovery: {} } }), mkCtx().ctx)).success).toBe(false);
    expect(deps.kubeOps.restartOpenClawInPlace).not.toHaveBeenCalled();
  });
  it('refuses a mixed source and restore authority without invoking either', async () => {
    const recoverSource = vi.fn(async () => {}), recoverRestore = vi.fn(async () => {}), deps = mkDeps({ recoverSource, recoverRestore });
    expect((await createRestartGatewayHandler(deps)(mkOp({ input: { gatewayId: 'shared-1', sourceRecovery: {}, restoreRecovery: {} } }), mkCtx().ctx)).success).toBe(false);
    expect(recoverSource).not.toHaveBeenCalled(); expect(recoverRestore).not.toHaveBeenCalled();
  });
  it('retains a fenced source-repair retry when its readiness deadline expires', async () => {
    const deps = mkDeps({ recoverSource: vi.fn(async () => { throw new Error('source repair is not ready; outcome remains fenced'); }) });
    expect(await createRestartGatewayHandler(deps)(mkOp({ input: { gatewayId: 'shared-1', sourceRecovery: {} } }), mkCtx().ctx))
      .toMatchObject({ success: false, retryAfterMs: 60_000, error: 'source repair is not ready; outcome remains fenced' });
    expect(deps.kubeOps.restartOpenClawInPlace).not.toHaveBeenCalled();
  });
  it("calls kubeOps.restartOpenClawInPlace with the deployment derived from the serving revision", async () => {
    const deps = mkDeps();
    const handler = createRestartGatewayHandler(deps);
    const { ctx } = mkCtx();

    const result = await handler(mkOp(), ctx);

    expect(deps.kubeOps.restartOpenClawInPlace).toHaveBeenCalledTimes(1);
    expect(deps.kubeOps.restartOpenClawInPlace).toHaveBeenCalledWith({
      namespace: "octogee-test",
      name: "octogee-gateway-walter-r7",
    });
    expect(result.success).toBe(true);
  });

  it("reports a single `openclaw-restart` step that transitions running → done", async () => {
    const deps = mkDeps();
    const handler = createRestartGatewayHandler(deps);
    const { ctx, reported } = mkCtx();

    await handler(mkOp(), ctx);

    expect(reported.map((s) => `${s.name}:${s.status}`)).toEqual([
      "openclaw-restart:running",
      "openclaw-restart:done",
    ]);
  });

  it("returns failure when gatewayId is missing from op.input (defensive — admin route always provides)", async () => {
    const deps = mkDeps();
    const handler = createRestartGatewayHandler(deps);
    const { ctx } = mkCtx();

    const result = await handler(
      mkOp({ input: {} }),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/gatewayId/);
  });

  it("fails closed when the durable root has no serving revision", async () => {
    const deps = mkDeps({ resolveLiveRevisionId: vi.fn(async () => null) });

    const result = await createRestartGatewayHandler(deps)(mkOp(), mkCtx().ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/serving revision/i);
    expect(deps.kubeOps.restartOpenClawInPlace).not.toHaveBeenCalled();
  });

  it("reports the openclaw-restart step failed when kubeOps throws, surfacing the error message", async () => {
    const deps = mkDeps({
      kubeOps: kubeOps(vi.fn(async () => {
          throw new Error("kubectl: connection refused");
        })),
    });
    const handler = createRestartGatewayHandler(deps);
    const { ctx, reported } = mkCtx();

    const result = await handler(mkOp(), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/connection refused/);
    const failed = reported.find((s) => s.status === "failed");
    expect(failed?.name).toBe("openclaw-restart");
    expect(failed?.error).toMatch(/connection refused/);
  });

  it("treats a restart against an already failed pod as idempotently satisfied", async () => {
    const deps = mkDeps({
      kubeOps: kubeOps(vi.fn(async () => {
          throw new Error(
            "cannot exec into a container in a completed pod; current phase is Failed",
          );
        })),
    });
    const { ctx, reported } = mkCtx();

    const result = await createRestartGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(reported.map((step) => `${step.name}:${step.status}`)).toEqual([
      "openclaw-restart:running",
      "openclaw-restart:skipped",
    ]);
  });

  it("treats a dead OpenClaw process as satisfied by the container's own restart instead of retrying into the fresh boot", async () => {
    const log = vi.fn();
    const deps = mkDeps({
      log,
      kubeOps: kubeOps(vi.fn(async () => {
          throw new Error(
            "openclaw gateway restart (in-place) deploy/octogee-gateway-shared-0 ns=octogee-test failed (code=1): Gateway not reachable at ws://127.0.0.1:18789 (ECONNREFUSED)",
          );
        })),
    });
    const { ctx, reported } = mkCtx();

    const result = await createRestartGatewayHandler(deps)(mkOp(), ctx);

    expect(result.success).toBe(true);
    expect(reported.map((step) => `${step.name}:${step.status}`)).toEqual([
      "openclaw-restart:running",
      "openclaw-restart:skipped",
    ]);
    expect(reported[1]?.error).toMatch(/ECONNREFUSED/);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/walter OpenClaw process is not running/));
  });

  it("treats a restart against a disappeared pod as idempotently satisfied", async () => {
    const deps = mkDeps({
      kubeOps: kubeOps(vi.fn(async () => {
          throw new Error('Error from server (NotFound): pods "octogee-gateway-walter-abc" not found');
        })),
    });

    const result = await createRestartGatewayHandler(deps)(mkOp(), mkCtx().ctx);

    expect(result.success).toBe(true);
  });

  it("does NOT touch desiredStatus or any Firestore docs (restart is a one-shot kubectl op)", async () => {
    const deps = mkDeps();
    const handler = createRestartGatewayHandler(deps);
    const { ctx } = mkCtx();

    await handler(mkOp(), ctx);

    expect(deps.kubeOps.scaleDeployment).not.toHaveBeenCalled();
    expect(deps.kubeOps.readDeployedReplicas).not.toHaveBeenCalled();
  });

  it("does NOT gate on mounted users (restart is operator intent)", async () => {
    const deps = mkDeps();
    const handler = createRestartGatewayHandler(deps);
    const { ctx } = mkCtx();

    const result = await handler(
      mkOp({ input: { gatewayId: "walter", mountedCustomers: ["alice", "bob"] } }),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(deps.kubeOps.restartOpenClawInPlace).toHaveBeenCalledTimes(1);
  });
});
