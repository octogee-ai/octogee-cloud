import { describe, expect, it, vi } from "vitest";
import { MigrationTransportError, type MigrationClient } from "./fleet-migration-client.js";
import {
  advanceUserMigrationV2,
  beginUserMigrationV2Abort,
  classifyUserMigrationV2Error,
  userMigrationV2GatewayRootFence,
  isUserMigrationV2PostIntent,
  isUserMigrationV2Transition,
  type UserMigrationV2Deps,
} from "./user-migration-v2.js";
import type {
  UserMigrationV2Phase,
  UserMigrationV2State,
} from "@octogee/shared/types/glm";

const SOURCE_SYSTEM_CONFIG_COMMIT = "a".repeat(40);

function gatewayRootFence(
  gatewayId: string,
  release: number,
): UserMigrationV2State["sourceRootFence"] {
  return {
    gatewayId,
    updatedAt: release * 10,
    latestRelease: release,
    desiredRelease: release,
    liveRelease: release,
    gatewayClass: "isolated",
    ownerUid: "uid-1",
    builderSlug: "alice",
    configHash: gatewayId === "source" ? "1".repeat(64) : "2".repeat(64),
  };
}

function state(
  phase: UserMigrationV2State["phase"] = "initialized",
): UserMigrationV2State {
  const value: UserMigrationV2State = {
    phase,
    operationId: "op-1",
    migrationId: "mig-op-1",
    uid: "uid-1",
    slug: "alice",
    sourceGatewayId: "source",
    sourceRelease: 1,
    sourceEpoch: 7,
    sourceAssignmentMode: "assigned",
    sourceRootFence: gatewayRootFence("source", 1),
    targetGatewayId: "target",
    targetRelease: 3,
    targetRootFence: gatewayRootFence("target", 3),
  };
  if (["sourceQuiesced", "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete"].includes(phase)) {
    value.sourceSystemConfigCommit = SOURCE_SYSTEM_CONFIG_COMMIT;
  }
  return value;
}

function deps(): UserMigrationV2Deps {
  const client = {
    scheduler: vi.fn(async ({ migrationId, phase }) => ({ operationId: migrationId, agentIds: ["octogee-alice-coach"], phase, drained: true, snapshot: {} })),
    transferState: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", imported: true })),
    restoreTarget: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", restored: true })),
    resume: vi.fn(async () => undefined),
    quiesce: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 })),
    flushGateway: vi.fn(async () => ({
      migrationId: "mig-op-1",
      slug: "alice",
      ok: true,
      durationMs: 1,
      steps: [],
      systemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
    })),
    verifyTarget: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", ready: true })),
    unmount: vi.fn(async () => ({ migrationId: "mig-op-1", slug: "alice", unmounted: true })),
  } as unknown as MigrationClient;
  return {
    client,
    setSourceAssignmentState: vi.fn(async () => undefined),
    commitCutover: vi.fn(async () => undefined),
    now: vi.fn(() => 1_000),
    log: vi.fn(),
  };
}

describe("userMigrationV2GatewayRootFence", () => {
  const root = (coOwnerUids: string[]) => ({
    gatewayId: "source",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 10,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "isolated",
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: "l",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: { controlUiEnabled: true },
    ownerUid: "uid-1",
    builderSlug: "alice",
    modelBrokerLimits: null,
    preemption: null,
    allocation: null,
    coOwnerUids,
  });

  it("admits only Isolated-class roots, so every V2 target boots hold-capable and stages its schedules after cutover", () => {
    expect(userMigrationV2GatewayRootFence({ ...root([]), gatewayClass: "shared", profile: "standard", imageProfile: "standard" }, "source")).toBeNull();
    expect(userMigrationV2GatewayRootFence(root([]), "source")).toMatchObject({ gatewayClass: "isolated" });
  });

  it("projects an empty retired co-owner mirror and rejects non-empty legacy authority", () => {
    expect(userMigrationV2GatewayRootFence(root([]), "source")).toMatchObject({
      gatewayId: "source",
      ownerUid: "uid-1",
    });
    expect(userMigrationV2GatewayRootFence(
      root(["uid-former-helper"]),
      "source",
    )).toBeNull();
  });
});

describe("advanceUserMigrationV2", () => {
  it("drives the lean data-plane migration with no config-protocol steps", async () => {
    const d = deps();
    let current = state();
    const phases: string[] = [];
    while (current.phase !== "complete") {
      current = await advanceUserMigrationV2(current, d);
      phases.push(current.phase);
    }

    expect(phases).toEqual([
      "keysSynced", "preSynced", "sourceQuiesced",
      "finalSynced", "targetVerified", "cutover", "cutover", "sourceRetired", "complete",
    ]);
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(client.transferState.mock.calls.map((call) => call[0].mode)).toEqual([
      "keys", "pre", "final",
    ]);
    expect(client.transferState.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        mode: "keys",
        fromTransportId: "source",
        toTransportId: "target",
        includeActivationManifest: false,
      }),
      expect.objectContaining({ mode: "pre", fromTransportId: "source", toTransportId: "target", includeActivationManifest: true }),
      expect.objectContaining({
        mode: "final",
        fromTransportId: "source",
        toTransportId: "target",
        includeActivationManifest: true,
      }),
    ]);
    expect(client.restoreTarget).not.toHaveBeenCalled();
    expect(d.setSourceAssignmentState).toHaveBeenCalledWith("quiescing");
    expect(client.quiesce).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "source",
      transportId: "source",
    }));
    expect(client.flushGateway.mock.calls.map((call) => call[0])).toEqual([
      {
        migrationId: "mig-op-1",
        gatewayId: "source",
        transportId: "source",
        slug: "alice",
        reason: "migration-final",
      },
      {
        migrationId: "mig-op-1",
        gatewayId: "target",
        transportId: "target",
        slug: "alice",
        reason: "migration-converge",
        expectedSystemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
      },
    ]);
    expect(d.commitCutover).toHaveBeenCalledWith({
      operationId: "op-1",
      migrationId: "mig-op-1",
      sourceGatewayId: "source",
      sourceEpoch: 7,
      sourceRelease: 1,
      sourceAssignmentMode: "assigned",
      sourceRootFence: gatewayRootFence("source", 1),
      targetGatewayId: "target",
      targetRelease: 3,
      targetRootFence: gatewayRootFence("target", 3),
    });
    expect(client.unmount).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "source",
      transportId: "source",
    }));
    expect(Object.keys(client).every((name) => !/config/iu.test(name))).toBe(true);
  });

  it("prepares the destination before fencing source writes", async () => {
    const d = deps();
    await expect(advanceUserMigrationV2(state("keysSynced"), d)).resolves.toMatchObject({ phase: "preSynced" });
    expect(d.client.transferState).toHaveBeenCalledWith(expect.objectContaining({ mode: "pre", includeActivationManifest: true }));
    expect(d.setSourceAssignmentState).not.toHaveBeenCalled();
    expect(d.client.quiesce).not.toHaveBeenCalled();
  });

  it("marks the source quiescing before the quiesce RPC so the edge blocks first", async () => {
    const d = deps();
    const order: string[] = [];
    (d.setSourceAssignmentState as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("assignment-quiescing");
    });
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    client.quiesce.mockImplementation(async () => {
      order.push("quiesce-rpc");
      return { migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 };
    });

    client.flushGateway.mockImplementation(async () => {
      order.push("source-flush");
      return {
        migrationId: "mig-op-1",
        slug: "alice",
        ok: true,
        durationMs: 1,
        steps: [],
        systemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
      };
    });

    await advanceUserMigrationV2(state("preSynced"), d);

    expect(order).toEqual(["quiesce-rpc", "assignment-quiescing", "quiesce-rpc", "source-flush"]);
    expect(client.scheduler.mock.calls.map((call) => call[0].phase)).not.toContain("hold");
    expect(client.quiesce).toHaveBeenCalledWith(expect.objectContaining({ schedulerHandoff: true }));
  });

  it("resumes an operation an older controller persisted at preSynced by quiescing next, without another copy", async () => {
    const d = deps();
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;

    await expect(advanceUserMigrationV2(state("preSynced"), d)).resolves.toMatchObject({ phase: "sourceQuiesced" });

    expect(client.transferState).not.toHaveBeenCalled();
    expect(client.quiesce).toHaveBeenCalledTimes(2);
    expect(isUserMigrationV2Transition("preSynced", "sourceQuiesced")).toBe(true);
    expect(isUserMigrationV2Transition("keysSynced", "preSynced")).toBe(true);
  });

  it("persists the source's exact accepted config commit before final transfer", async () => {
    const d = deps();

    await expect(advanceUserMigrationV2(state("preSynced"), d)).resolves.toMatchObject({
      phase: "sourceQuiesced",
      sourceSystemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
    });
  });

  it.each([undefined, "not-a-commit"])(
    "fails closed when source flush does not prove an accepted config commit (%s)",
    async (systemConfigCommit) => {
      const d = deps();
      const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
      client.flushGateway.mockResolvedValueOnce({
        migrationId: "mig-op-1",
        slug: "alice",
        ok: true,
        durationMs: 1,
        steps: [],
        ...(systemConfigCommit === undefined ? {} : { systemConfigCommit }),
      });

      await expect(advanceUserMigrationV2(state("preSynced"), d))
        .rejects.toThrow(/accepted system.config commit/iu);
    },
  );

  it("converges target config after final transfer and before target verification", async () => {
    const d = deps();
    const order: string[] = [];
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    client.transferState.mockImplementation(async () => {
      order.push("final-transfer");
      return { migrationId: "mig-op-1", slug: "alice", imported: true };
    });
    client.flushGateway.mockImplementation(async () => {
      order.push("target-flush");
      return { migrationId: "mig-op-1", slug: "alice", ok: true, durationMs: 1, steps: [] };
    });
    client.verifyTarget.mockImplementation(async () => {
      order.push("target-verify");
      return { migrationId: "mig-op-1", slug: "alice", ready: true };
    });

    const finalSynced = await advanceUserMigrationV2(state("sourceQuiesced"), d);
    await advanceUserMigrationV2(finalSynced, d);

    expect(order).toEqual(["final-transfer", "target-flush", "target-verify"]);
  });

  it.each([
    ["source", "preSynced" as const, "quiesce"],
    ["target", "sourceQuiesced" as const, "transferState"],
  ])("replays the %s handoff phase after a lost flush response", async (_name, phase, priorRpc) => {
    const d = deps();
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    client.flushGateway.mockRejectedValueOnce(new MigrationTransportError("flush response lost"));

    await expect(advanceUserMigrationV2(state(phase), d)).rejects.toThrow(/response lost/u);
    await expect(advanceUserMigrationV2(state(phase), d)).resolves.toBeDefined();

    expect(client.flushGateway).toHaveBeenCalledTimes(2);
    expect(client[priorRpc]).toHaveBeenCalledTimes(priorRpc === "quiesce" ? 4 : 2);
  });

  it("advances state only after the RPC response so a lost response is reissued", async () => {
    const d = deps();
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    client.transferState.mockRejectedValueOnce(new MigrationTransportError("response lost"));

    await expect(advanceUserMigrationV2(state("initialized"), d)).rejects.toThrow(
      /response lost/u,
    );
    const retried = await advanceUserMigrationV2(state("initialized"), d);
    expect(retried.phase).toBe("keysSynced");
    expect(client.transferState).toHaveBeenCalledTimes(2);
  });

  it("drives the abort path: unmount target, restore source serving", async () => {
    const d = deps();
    let current = state("abortIntent");
    current = await advanceUserMigrationV2(current, d);
    expect(current.phase).toBe("abortTargetUnmounted");
    expect(d.client.resume).toHaveBeenCalledWith({ migrationId: "mig-op-1", gatewayId: "source", slug: "alice" });
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(client.unmount).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "target",
      transportId: "target",
    }));

    current = await advanceUserMigrationV2(current, d);
    expect(current.phase).toBe("aborted");
    expect(current.abortedAt).toBe(1_000);
    expect(d.setSourceAssignmentState).toHaveBeenCalledWith("serving");
  });

  it("restores source serving before a retryable target-unmount failure can return", async () => {
    const d = deps();
    const client = d.client as unknown as Record<string, ReturnType<typeof vi.fn>>;
    client.unmount.mockRejectedValueOnce(new Error("target unavailable"));

    await expect(advanceUserMigrationV2(state("abortIntent"), d))
      .rejects.toThrow(/target unavailable/u);

    expect(d.setSourceAssignmentState).toHaveBeenCalledWith("serving");
  });
});

describe("user migration V2 failure boundary", () => {
  it("persists abort intent before cutover and never aborts after it", () => {
    const aborted = beginUserMigrationV2Abort(state("preSynced"), "target broke", 42);
    expect(aborted).toMatchObject({
      phase: "abortIntent",
      abortFromPhase: "preSynced",
      abortReason: "target broke",
      abortIntentAt: 42,
    });

    expect(() => beginUserMigrationV2Abort(state("initialized"), "nothing durable", 42))
      .toThrow(/no durable target footprint/u);
    for (const phase of ["cutover", "sourceRetired", "complete"] as const) {
      expect(isUserMigrationV2PostIntent(state(phase))).toBe(true);
      expect(() => beginUserMigrationV2Abort(state(phase), "too late", 42))
        .toThrow(/must roll forward/u);
    }
    for (const phase of ["sourceQuiesced", "finalSynced", "targetVerified"] as const) {
      expect(() => beginUserMigrationV2Abort(state(phase), "ambiguous upgrade", 42)).toThrow(/must roll forward/u);
      expect(isUserMigrationV2Transition(phase, "abortIntent")).toBe(false);
    }
    const alreadyAborting = state("abortIntent");
    expect(beginUserMigrationV2Abort(alreadyAborting, "again", 42)).toBe(alreadyAborting);
  });

  it("accepts only the next durable phase or the legal pre-cutover abort branch", () => {
    const forward: UserMigrationV2Phase[] = [
      "initialized", "keysSynced", "preSynced", "sourceQuiesced",
      "finalSynced", "targetVerified", "cutover", "sourceRetired", "complete",
    ];
    for (let index = 0; index < forward.length - 1; index += 1) {
      expect(isUserMigrationV2Transition(forward[index], forward[index + 1])).toBe(true);
      expect(isUserMigrationV2Transition(forward[index], forward[index])).toBe(true);
    }
    expect(isUserMigrationV2Transition("initialized", "abortIntent")).toBe(false);
    expect(isUserMigrationV2Transition("preSynced", "abortIntent")).toBe(true);
    expect(isUserMigrationV2Transition("cutover", "abortIntent")).toBe(false);
    expect(isUserMigrationV2Transition("abortIntent", "abortTargetUnmounted")).toBe(true);
    expect(isUserMigrationV2Transition("abortTargetUnmounted", "aborted")).toBe(true);
  });
});

describe("classifyUserMigrationV2Error", () => {
  it("classifies transport loss and server unavailability as retry", () => {
    expect(classifyUserMigrationV2Error(new MigrationTransportError("fetch failed"))).toBe("retry");
    expect(classifyUserMigrationV2Error({ status: 503 })).toBe("retry");
    expect(classifyUserMigrationV2Error({ status: 429 })).toBe("retry");
    expect(classifyUserMigrationV2Error({ code: "ECONNRESET" })).toBe("retry");
    expect(classifyUserMigrationV2Error(new Error("socket hang up"))).toBe("retry");
  });

  it("classifies definitive rejections as terminal", () => {
    expect(classifyUserMigrationV2Error({ status: 400 })).toBe("terminal");
    expect(classifyUserMigrationV2Error({ status: 409 })).toBe("terminal");
    expect(classifyUserMigrationV2Error(new Error("target verify failed checks"))).toBe("terminal");
  });
});

describe("durable scheduler handoff onto a held gateway VM", () => {
  const HELD = '/scheduler/target: 500 {"error":"scheduler migration failed","message":"OpenClaw workspace identities are not initialized for this boot"}';

  function heldTarget(d: UserMigrationV2Deps, options: { readyAfter?: number } = {}) {
    const calls: string[] = [];
    let targetCalls = 0;
    vi.mocked(d.client.scheduler).mockImplementation(async ({ migrationId, phase, gatewayId, agentIds, snapshot }) => {
      if (gatewayId === "target" && ++targetCalls <= (options.readyAfter ?? 0)) {
        calls.push(`target:${phase}:held`);
        throw new Error(HELD);
      }
      calls.push(`${gatewayId}:${phase}${snapshot ? `:${JSON.stringify({ agentIds, snapshot })}` : ""}`);
      return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: phase === "export" ? { jobs: ["daily"] } : undefined };
    });
    let clock = 1_000;
    d.now = vi.fn(() => clock);
    d.wait = vi.fn(async (delayMs: number) => { clock += delayMs; });
    d.log = vi.fn();
    return calls;
  }

  it("exports on the source at final sync and sends nothing to the target's scheduler before cutover", async () => {
    const d = deps();
    const calls = heldTarget(d, { readyAfter: Number.POSITIVE_INFINITY });

    expect(await advanceUserMigrationV2(state("sourceQuiesced"), d)).toMatchObject({ phase: "finalSynced" });

    expect(calls).toEqual(["source:export"]);
  });

  it("stages the source's exported copy on the released target after cutover and records it before retiring", async () => {
    const d = deps();
    const calls = heldTarget(d);

    const staged = await advanceUserMigrationV2(state("cutover"), d);

    expect(staged).toMatchObject({ phase: "cutover", schedulerStagedAt: 1_000 });
    expect(calls).toEqual([
      "source:export",
      `target:stage:${JSON.stringify({ agentIds: ["octogee-alice-coach"], snapshot: { jobs: ["daily"] } })}`,
    ]);
    expect(d.client.unmount).not.toHaveBeenCalled();

    expect(await advanceUserMigrationV2(staged, d)).toMatchObject({ phase: "sourceRetired" });
    expect(calls.slice(2)).toEqual(["source:retire", "target:activate"]);
  });

  it("waits for the released target's OpenClaw before staging", async () => {
    const d = deps();
    const calls = heldTarget(d, { readyAfter: 3 });

    expect(await advanceUserMigrationV2(state("cutover"), d)).toMatchObject({ phase: "cutover", schedulerStagedAt: expect.any(Number) });

    expect(calls.filter((call) => call === "target:stage:held")).toHaveLength(3);
  });

  it("rolls forward retryably, never back, while the released target stays unready", async () => {
    const d = deps();
    heldTarget(d, { readyAfter: Number.POSITIVE_INFINITY });

    const error = await advanceUserMigrationV2(state("cutover"), d).then(() => null, (caught: unknown) => caught);

    expect(String(error)).toMatch(/target gateway target scheduler did not become ready within \d+ms/);
    expect(classifyUserMigrationV2Error(error)).toBe("retry");
    expect(d.client.resume).not.toHaveBeenCalled();
  });

  it("retires the source before activating target and retains cutover on failure", async () => {
    const d = deps();
    const current = { ...state("cutover"), schedulerStagedAt: 900 };
    const phases: string[] = [];
    vi.mocked(d.client.scheduler).mockImplementation(async ({ migrationId, phase }) => {
      phases.push(phase);
      if (phase === "activate") throw new Error("timeout activating");
      return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true };
    });
    await expect(advanceUserMigrationV2(current, d)).rejects.toThrow("timeout activating");
    expect(current.phase).toBe("cutover");
    expect(phases).toEqual(["retire", "activate"]);
    expect(d.client.unmount).not.toHaveBeenCalled();
    expect(d.client.resume).not.toHaveBeenCalled();
  });

  it("aborts before cutover by resuming only the source: the held target never received a stage", async () => {
    const d = deps();
    const calls = heldTarget(d, { readyAfter: Number.POSITIVE_INFINITY });

    expect(await advanceUserMigrationV2(state("abortIntent"), d)).toMatchObject({ phase: "abortTargetUnmounted" });

    expect(calls).toEqual(["source:resume"]);
    expect(d.setSourceAssignmentState).toHaveBeenCalledWith("serving");
    expect(d.client.resume).toHaveBeenCalled();
  });
});
