import { describe, it, expect, vi } from "vitest";
import {
  createRolloutHandler,
  planDesiredReleaseActivation,
  type RolloutDeps,
} from "../handlers/rollout.js";
import type { Operation } from "@octogee/shared/types/glm";
import type { GatewayDoc, ReleasePayload } from "@octogee/shared/types/gateway-releases";
import type { OperationContext } from "../operation-router.js";

function mkPayload(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: "cafe123-ocbeta2",
    gatewayEdgeImage: {
      imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge",
      imageTag: "cafe123-ocbeta2",
    },
    ...overrides,
  };
}

function mkGateway(overrides: Partial<GatewayDoc> = {}): GatewayDoc {
  return {
    gatewayId: "default",
    createdAt: 1,
    createdBy: "ci",
    updatedAt: 1,
    updatedBy: "ci",
    latestRelease: 2,
    desiredRelease: 2,
    liveRelease: 1,
    desiredStatus: "running",
    ...overrides,
  };
}

function mkOp(input: Record<string, unknown>): Operation {
  return {
    id: "op-1",
    kind: "rollout",
    status: "running",
    createdBy: "test",
    createdAt: 0,
    startedAt: 0,
    completedAt: null,
    input,
    steps: [],
  };
}

const ctx: OperationContext = { reportStep: vi.fn<OperationContext["reportStep"]>(async () => undefined) };

function mkDeps(overrides: Partial<RolloutDeps> = {}): RolloutDeps & { logs: string[] } {
  const logs: string[] = [];
  let now = 0;
  return {
    readGatewayDoc: async () => mkGateway(),
    readReleasePayload: async () => mkPayload(),
    readDeploymentPrerequisiteError: vi.fn(async () => null),
    activateDesiredRelease: vi.fn(async () => ({ success: true as const })),
    requestReconcileTick: vi.fn(),
    releaseRecordTimeoutMs: 10_000,
    convergeTimeoutMs: 100_000,
    pollIntervalMs: 1_000,
    now: () => now,
    wait: async () => {
      now += 1_000;
    },
    log: (msg: string) => logs.push(msg),
    logs,
    ...overrides,
  };
}

describe("rollout op — durable root validation", () => {
  it("activates a release without consulting source version metadata", async () => {
    const deps = mkDeps({ readGatewayDoc: async () => mkGateway({ liveRelease: 2 }) });
    Object.assign(deps, { readGatewayOpenclawVersion: vi.fn(async () => { throw new Error("version unavailable"); }) });
    const result = await createRolloutHandler(deps)(mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }), ctx);
    expect(result.success).toBe(true);
    expect(deps.activateDesiredRelease).toHaveBeenCalled();
  });
  it("refuses a gateway with no durable gateways/{id} desired doc without naming retired recovery tools", async () => {
    const deps = mkDeps({ readGatewayDoc: async () => null });
    const handler = createRolloutHandler(deps);
    const res = await handler(mkOp({ gatewayId: "legacy-gw", targetRelease: 2, imageTag: "cafe123-ocbeta2" }), ctx);
    expect(res.success).toBe(false);
    expect(res.error).toContain("legacy-gw");
    expect(res.error).toContain("durable gateways/legacy-gw desired doc");
    expect(res.error).not.toContain("backfill-gateway-identity");
  });

  it("fails on missing gatewayId / targetRelease / imageTag inputs", async () => {
    const handler = createRolloutHandler(mkDeps());
    expect((await handler(mkOp({ targetRelease: 2, imageTag: "t" }), ctx)).error)
      .toContain("gatewayId");
    expect((await handler(mkOp({ gatewayId: "g", imageTag: "t" }), ctx)).error)
      .toContain("targetRelease");
    expect((await handler(mkOp({ gatewayId: "g", targetRelease: 2 }), ctx)).error)
      .toContain("imageTag");
  });

  it("refuses a retired gateway", async () => {
    const deps = mkDeps({
      readGatewayDoc: async () => mkGateway({ desiredStatus: "retired" }),
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("retired");
  });
});

describe("rollout desired release activation", () => {
  it("activates only the exact staged release from a stable live root", () => {
    expect(planDesiredReleaseActivation(
      mkGateway({ desiredRelease: 1, liveRelease: 1 }),
      2,
      100,
      "op-1",
    )).toEqual({
      success: true,
      patch: {
        desiredRelease: 2,
        updatedAt: 100,
        updatedBy: "rollout:op-1",
      },
    });
  });

  it("is idempotent after the operation has activated its release", () => {
    expect(planDesiredReleaseActivation(mkGateway(), 2, 100, "op-1"))
      .toEqual({ success: true, patch: null });
  });

  it("rejects a superseded target", () => {
    expect(planDesiredReleaseActivation(
      mkGateway({ latestRelease: 3, desiredRelease: 1, liveRelease: 1 }),
      2,
      100,
      "op-1",
    )).toMatchObject({ success: false, error: expect.stringContaining("superseded") });
  });

  it("replaces an incomplete desired release while the live source remains serving", () => {
    expect(planDesiredReleaseActivation(
      mkGateway({ latestRelease: 3, desiredRelease: 2, liveRelease: 1 }),
      3,
      100,
      "op-1",
    )).toEqual({
      success: true,
      patch: {
        desiredRelease: 3,
        updatedAt: 100,
        updatedBy: "rollout:op-1",
      },
    });
  });
});

describe("rollout op — awaits the roll arm's convergence", () => {
  it("fails before activation when the release omits its paired gateway-edge image", async () => {
    const deps = mkDeps({
      readReleasePayload: async () => mkPayload({ gatewayEdgeImage: undefined }),
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("missing its immutable gateway-edge image reference");
    expect(deps.activateDesiredRelease).not.toHaveBeenCalled();
  });

  it("supersedes a prior incomplete desired release without waiting for its convergence", async () => {
    let activated = false;
    const activateDesiredRelease = vi.fn(async () => {
      activated = true;
      return { success: true as const };
    });
    const reportStep = vi.fn<OperationContext["reportStep"]>(async () => undefined);
    const deps = mkDeps({
      readGatewayDoc: async () => activated
        ? mkGateway({
            latestRelease: 3,
            desiredRelease: 3,
            liveRelease: 3,
          })
        : mkGateway({
            latestRelease: 3,
            desiredRelease: 2,
            liveRelease: 1,
          }),
      readReleasePayload: async (_gatewayId, release) =>
        release === 3 ? mkPayload({ imageTag: "feed456-ocbeta2" }) : null,
      activateDesiredRelease,
      wait: async () => {
        throw new Error("newer rollout should not wait for the incomplete prior release");
      },
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 3, imageTag: "feed456-ocbeta2" }),
      { reportStep },
    );

    expect(res.success).toBe(true);
    expect(activateDesiredRelease).toHaveBeenCalledWith({
      gatewayId: "default",
      targetRelease: 3,
      operationId: "op-1",
    });
    expect(
      reportStep.mock.calls.filter((call) => call[0].status === "running"),
    ).toHaveLength(1);
  });

  it("fails a running older rollout promptly when a newer cut advances latest release", async () => {
    let newerReleaseCut = false;
    let now = 0;
    const deps = mkDeps({
      readGatewayDoc: async () => newerReleaseCut
        ? mkGateway({ latestRelease: 3, desiredRelease: 2, liveRelease: 1 })
        : mkGateway({ latestRelease: 2, desiredRelease: 2, liveRelease: 1 }),
      activateDesiredRelease: vi.fn(async () => ({ success: true as const })),
      convergeTimeoutMs: 2_000,
      now: () => now,
      wait: async () => {
        now += 1_000;
        newerReleaseCut = true;
      },
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain("superseded by latest release 3");
    expect(deps.activateDesiredRelease).toHaveBeenCalledTimes(1);
  });

  it("activates the newer latest release while the old live source serves until convergence", async () => {
    let activated = false;
    let converged = false;
    let sourceObservedDuringHandoff = false;
    let now = 0;
    const deps = mkDeps({
      readGatewayDoc: async () => {
        if (!activated) return mkGateway({ latestRelease: 3, desiredRelease: 2, liveRelease: 1 });
        if (!converged) {
          sourceObservedDuringHandoff = true;
          return mkGateway({ latestRelease: 3, desiredRelease: 3, liveRelease: 1 });
        }
        return mkGateway({ latestRelease: 3, desiredRelease: 3, liveRelease: 3 });
      },
      readReleasePayload: async (_gatewayId, release) =>
        release === 3 ? mkPayload({ imageTag: "feed456-ocbeta2" }) : null,
      activateDesiredRelease: vi.fn(async () => {
        activated = true;
        return { success: true as const };
      }),
      convergeTimeoutMs: 2_000,
      now: () => now,
      wait: async () => {
        now += 1_000;
        expect(sourceObservedDuringHandoff).toBe(true);
        converged = true;
      },
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 3, imageTag: "feed456-ocbeta2" }),
      ctx,
    );

    expect(res.success).toBe(true);
    expect(deps.activateDesiredRelease).toHaveBeenCalledWith({
      gatewayId: "default",
      targetRelease: 3,
      operationId: "op-1",
    });
  });

  it("refreshes operation liveness on every convergence poll", async () => {
    let polls = 0;
    const reportStep = vi.fn<OperationContext["reportStep"]>(async () => undefined);
    const deps = mkDeps({
      readGatewayDoc: async () =>
        polls >= 3
          ? mkGateway({ liveRelease: 2 })
          : mkGateway(),
      wait: async () => {
        polls += 1;
      },
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      { reportStep },
    );

    expect(res.success).toBe(true);
    expect(
      reportStep.mock.calls.filter((call) => call[0].status === "running"),
    ).toHaveLength(4);
  });

  it("kicks a reconcile tick and succeeds once liveRelease reaches desiredRelease", async () => {
    let converged = false;
    const deps = mkDeps({
      readGatewayDoc: async () =>
        converged
          ? mkGateway({ liveRelease: 2 })
          : mkGateway(),
      wait: async () => {
        converged = true;
      },
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
    expect(deps.activateDesiredRelease).toHaveBeenCalledWith({
      gatewayId: "default",
      targetRelease: 2,
      operationId: "op-1",
    });
    expect(deps.requestReconcileTick).toHaveBeenCalledTimes(2);
    expect(deps.requestReconcileTick).toHaveBeenCalledWith("default");
  });

  it("does not reconcile when exact release activation is rejected", async () => {
    const deps = mkDeps({
      activateDesiredRelease: vi.fn(async () => ({
        success: false as const,
        error: "another release is not live",
      })),
    });

    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );

    expect(res).toMatchObject({ success: false, error: "another release is not live" });
    expect(deps.requestReconcileTick).not.toHaveBeenCalled();
  });

  it("narrates convergence progress into the op log", async () => {
    const states: GatewayDoc[] = [
      mkGateway(),
      mkGateway({ liveRelease: 2 }),
    ];
    let i = 0;
    const deps = mkDeps({
      readGatewayDoc: async () => states[Math.min(i, states.length - 1)],
      wait: async () => {
        i += 1;
      },
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
    expect(deps.logs.some((l) => l.includes("converging r1 → r2"))).toBe(true);
    expect(deps.logs.some((l) => l.includes("converged onto release 2"))).toBe(true);
  });

  it("fails when the desired release payload never matches the requested image (superseded or the release cut failed)", async () => {
    const deps = mkDeps({
      readReleasePayload: async () => mkPayload({ imageTag: "other-tag" }),
      releaseRecordTimeoutMs: 3_000,
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/superseded|release/i);
  });

  it("tolerates the admin wrapper's release write landing shortly AFTER the op is claimed (record race)", async () => {
    let recorded = false;
    const deps = mkDeps({
      readReleasePayload: async () => (recorded ? mkPayload() : mkPayload({ imageTag: "stale" })),
      readGatewayDoc: async () =>
        recorded ? mkGateway({ liveRelease: 2 }) : mkGateway(),
      wait: async () => {
        recorded = true;
      },
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
  });

  it("times out with the last observed convergence state when it never lands", async () => {
    const deps = mkDeps({
      convergeTimeoutMs: 5_000,
      readGatewayDoc: async () => mkGateway(),
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain("did not converge within 5000ms");
    expect(res.error).toContain("converging r1 → r2");
  });

  it("no-op rollout (already live on the requested release) succeeds immediately", async () => {
    const deps = mkDeps({
      readGatewayDoc: async () => mkGateway({ liveRelease: 2 }),
      readDeploymentPrerequisiteError: vi.fn(async () => "existing identity needs repair"),
    });
    const res = await createRolloutHandler(deps)(
      mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }),
      ctx,
    );
    expect(res.success).toBe(true);
    expect(deps.readDeploymentPrerequisiteError).not.toHaveBeenCalled();
  });
});

describe("rollout deployment prerequisites", () => {
  const input = { gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" };
  const scopeError = "VM sep092: identity scopes are outdated; pause and resume the gateway through Admin to repair them";

  it("fails a known prerequisite before activating desired release or waiting for readiness", async () => {
    const gateway = mkGateway({ desiredRelease: 1 });
    const deps = mkDeps({
      readGatewayDoc: async () => gateway,
      readDeploymentPrerequisiteError: vi.fn(async () => scopeError),
    });
    const steps = { reportStep: vi.fn(async () => undefined) };
    const result = await createRolloutHandler(deps)(mkOp(input), steps);

    expect(result).toMatchObject({ success: false, error: scopeError });
    expect(deps.activateDesiredRelease).not.toHaveBeenCalled();
    expect(deps.requestReconcileTick).not.toHaveBeenCalled();
    expect(gateway.desiredRelease).toBe(1);
    expect(deps.now()).toBe(0);
    expect(steps.reportStep).toHaveBeenLastCalledWith(expect.objectContaining({ status: "failed", error: scopeError }));
  });

  it("stops waiting when a prerequisite becomes terminal after desired release activation", async () => {
    const deps = mkDeps({
      readDeploymentPrerequisiteError: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(scopeError),
    });
    const result = await createRolloutHandler(deps)(mkOp(input), ctx);

    expect(result).toMatchObject({ success: false, error: scopeError });
    expect(deps.activateDesiredRelease).toHaveBeenCalledOnce();
    expect(deps.now()).toBe(0);
  });

  it("retries a transient prerequisite read before activation and then permits convergence", async () => {
    let activated = false;
    const readDeploymentPrerequisiteError = vi.fn().mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue(null);
    const deps = mkDeps({
      readGatewayDoc: async () => mkGateway({ desiredRelease: activated ? 2 : 1, liveRelease: activated ? 2 : 1 }),
      readDeploymentPrerequisiteError,
      activateDesiredRelease: vi.fn(async () => { activated = true; return { success: true as const }; }),
    });
    const result = await createRolloutHandler(deps)(mkOp(input), ctx);

    expect(result.success).toBe(true);
    expect(deps.now()).toBe(1_000);
    expect(readDeploymentPrerequisiteError).toHaveBeenCalledTimes(2);
    expect(deps.activateDesiredRelease).toHaveBeenCalledOnce();
  });

  it("fails non-transient prerequisite validation errors without hiding them behind the readiness deadline", async () => {
    const deps = mkDeps({
      readDeploymentPrerequisiteError: vi.fn(async () => { throw new Error("invalid VM service account configuration"); }),
    });
    const result = await createRolloutHandler(deps)(mkOp(input), ctx);

    expect(result).toMatchObject({ success: false, error: "invalid VM service account configuration" });
    expect(deps.activateDesiredRelease).not.toHaveBeenCalled();
    expect(deps.now()).toBe(0);
  });

  it("retains the convergence deadline and last transient prerequisite error when Compute stays unavailable", async () => {
    const deps = mkDeps({
      convergeTimeoutMs: 2_000,
      readDeploymentPrerequisiteError: vi.fn(async () => { throw new Error("status 503"); }),
    });
    const result = await createRolloutHandler(deps)(mkOp(input), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain("status 503");
    expect(result.error).toContain("2000ms");
    expect(deps.activateDesiredRelease).not.toHaveBeenCalled();
    expect(deps.now()).toBe(2_000);
  });
});


it("permits a paused rollout without requiring the running VM's identity to be repaired first", async () => {
  const deps = mkDeps({
    readGatewayDoc: async () => mkGateway({ desiredStatus: "paused" }),
    readDeploymentPrerequisiteError: vi.fn(async () => "identity scopes are outdated"),
    activateDesiredRelease: vi.fn(async () => {
      deps.readGatewayDoc = async () => mkGateway({ desiredStatus: "paused", liveRelease: 2 });
      return { success: true as const };
    }),
  });
  const result = await createRolloutHandler(deps)(mkOp({ gatewayId: "default", targetRelease: 2, imageTag: "cafe123-ocbeta2" }), ctx);
  expect(result.success).toBe(true);
  expect(deps.readDeploymentPrerequisiteError).not.toHaveBeenCalled();
});

describe('held unadmitted activation target rollback ownership', () => {
  const proof = { operationId: 'builder-activate-builder-a-g1', migrationId: 'mig-builder-activate-builder-a-g1:scheduler:1:claim:1000', uid: 'alice', slug: 'alice', sourceGatewayId: 'shared-a', sourceEpoch: 7, targetGatewayId: 'builder-a', leaseId: 'lease-a', generation: 1, liveRelease: 1, desiredRelease: 2, latestRelease: 2, retainedPodUid: 'old', discardedPodUid: 'new', rollOperationId: 'op-1', rollClaimStartedAt: 0, completedAt: 1000 };
  it('settles the current rollout as failed after owned rollback instead of claiming target readiness or activating another release', async () => {
    const rollback = vi.fn(async () => proof);
    const deps = mkDeps({ rollbackUnadmittedActivationTarget: rollback });
    const op = mkOp({ gatewayId: 'builder-a', targetRelease: 2, imageTag: 'cafe123-ocbeta2' });
    const result = await createRolloutHandler(deps)(op, ctx);
    expect(result).toMatchObject({ success: false, output: { builderActivationTargetRollback: proof } });
    expect(result.error).toContain('source recovery');
    expect(deps.activateDesiredRelease).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledWith(op, ctx);
  });
  it('observes a newly demonstrated held target cycle while the existing rollout awaits convergence', async () => {
    const rollback = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(proof);
    const deps = mkDeps({ rollbackUnadmittedActivationTarget: rollback });
    const result = await createRolloutHandler(deps)(mkOp({ gatewayId: 'builder-a', targetRelease: 2, imageTag: 'cafe123-ocbeta2' }), ctx);
    expect(result).toMatchObject({ success: false, output: { builderActivationTargetRollback: proof } });
    expect(deps.activateDesiredRelease).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(2);
  });
});
