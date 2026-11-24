import { describe, it, expect, vi } from "vitest";
import type { ScheduleRecord, ScheduleRestoreResult, ScheduleTransferDoc } from "@octogee/shared/types/fleet-controller";
import { restoreScheduleTransfer, runMigration, type MigrationRunnerDeps, type MigrationRunnerInput } from "./fleet-migration-runner.js";
import { MigrationDrainPendingError, MigrationRpcError, MigrationTransportError, type MigrationClient } from "./fleet-migration-client.js";

const STANDUP: ScheduleRecord = { sourceJobId: "job-standup", agentId: "octogee-alice-coach", job: { name: "standup", schedule: { kind: "cron", expr: "0 9 * * *" } } };

function happyClient(): MigrationClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    abortImport: vi.fn(async () => { throw new Error("happyClient does not abort imports"); }),
    scheduler: vi.fn(),
    schedules: vi.fn(async (request: Parameters<MigrationClient["schedules"]>[0]) => {
      calls.push(`schedules:${request.gatewayId}:${request.op}`);
      if (request.op === "snapshot") return { migrationId: request.migrationId, slug: request.slug, op: "snapshot", records: [STANDUP], skipped: [] };
      if (request.op === "remove") return { migrationId: request.migrationId, slug: request.slug, op: "remove", removed: request.jobIds.length, failed: [] };
      return { migrationId: request.migrationId, slug: request.slug, op: "restore", created: request.records.length, existing: 0, failed: [] };
    }) as unknown as MigrationClient["schedules"],
    sourceActivationReadiness: vi.fn(async () => "ready" as const),
    resume: vi.fn(async () => undefined),
    restoreTarget: vi.fn(async ({ slug }) => {
      calls.push(`restore:${slug}`);
      return { migrationId: "m1", slug, restored: true, steps: ["clone-workspace-repo"] };
    }) as MigrationClient["restoreTarget"],
    quiesce: vi.fn(async ({ slug }) => {
      calls.push(`quiesce:${slug}`);
      return { migrationId: "m1", slug, drained: true, runningCount: 0 };
    }) as MigrationClient["quiesce"],
    flushGateway: vi.fn(async ({ slug, reason }) => {
      calls.push(`flush:${slug}:${reason}`);
      return { migrationId: "m1", slug, ok: true, durationMs: 1, steps: [] };
    }) as MigrationClient["flushGateway"],
    transferState: vi.fn(async ({ slug, mode }) => {
      calls.push(`transfer:${slug}:${mode ?? "default"}`);
      return { migrationId: "m1", slug, imported: true };
    }) as MigrationClient["transferState"],
    verifyTarget: vi.fn(async ({ slug }) => {
      calls.push(`verify:${slug}`);
      return {
        migrationId: "m1",
        slug,
        ready: true,
        checks: { customerDir: true, coachWired: true, mountMarked: true },
      };
    }) as MigrationClient["verifyTarget"],
    unmount: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`unmount:${gatewayId}:${slug}`);
      return { migrationId: "m1", slug, unmounted: true };
    }) as MigrationClient["unmount"],
    calls,
  } as MigrationClient & { calls: string[] };
}

interface HarnessOptions {
  client?: MigrationClient & { calls: string[] };
  gateAssignment?: boolean;
  toGatewayId?: string;
  fromGatewayId?: string;
}

function harness(options: HarnessOptions = {}) {
  const client = options.client ?? happyClient();
  const events: string[] = [];
  const assignmentWrites: Array<{ gatewayId: string; uid: string; state: string }> = [];
  const transfers = new Map<string, ScheduleTransferDoc>();
  const deps: MigrationRunnerDeps = {
    client,
    readScheduleTransfer: vi.fn(async (migrationId: string) => structuredClone(transfers.get(migrationId)) ?? null),
    saveScheduleTransfer: vi.fn(async (doc: ScheduleTransferDoc) => {
      transfers.set(doc.migrationId, structuredClone(doc));
      events.push(`schedules-saved:${doc.sourceGatewayId}->${doc.targetGatewayId}:${doc.records.length}`);
    }),
    recordScheduleRestore: vi.fn(async (migrationId, restore) => {
      transfers.set(migrationId, { ...transfers.get(migrationId)!, ...restore });
      events.push(`schedules-restored:${restore.restoredTo}`);
    }),
    commitCutover: vi.fn(async (commit) => {
      events.push(`cutover:${commit.fromGatewayId}->${commit.toGatewayId}:mirror=${commit.flipMirror}`);
    }),
    setAssignmentState: vi.fn(async (input) => {
      assignmentWrites.push(input);
      events.push(`assignment:${input.gatewayId}:${input.state}`);
    }),
    log: (msg) => events.push(`log:${msg}`),
    reportStep: vi.fn(async (step) => {
      events.push(`report:${step.name}:${step.status}`);
    }),
  };
  const input: MigrationRunnerInput = {
    migrationId: "m1",
    uid: "uid-alice",
    slug: "alice",
    fromGatewayId: options.fromGatewayId ?? "gw-blue",
    toGatewayId: options.toGatewayId ?? "gw-green",
    includeActivationManifest: true,
    ...(options.gateAssignment !== undefined ? { gateAssignment: options.gateAssignment } : {}),
  };
  return { client, deps, input, events, assignmentWrites, transfers };
}

describe("runMigration — happy path", () => {
  it("executes keys → prepare → quiesce → final → verify → cutover → unmount with an incremental final copy and zero target restore", async () => {
    const { client, deps, input } = harness();

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: true, finalPhase: "done", rolledBack: false });
    expect(client.calls).toEqual([
      "transfer:alice:keys",
      "transfer:alice:pre",
      "quiesce:alice",
      "quiesce:alice",
      "schedules:gw-blue:snapshot",
      "schedules:gw-blue:remove",
      "flush:alice:migration-final",
      "transfer:alice:final",
      "verify:alice",
      "schedules:gw-green:restore",
      "unmount:gw-blue:alice",
    ]);
    expect(client.restoreTarget).not.toHaveBeenCalled();
    expect(client.calls.every((call) => !/config/u.test(call))).toBe(true);
  });

  it("emits reportStep running→done for each forward step in order", async () => {
    const { deps, input, events } = harness();

    await runMigration(input, deps);

    const reports = events.filter((event) => event.startsWith("report:"));
    expect(reports).toEqual([
      "report:keys-sync-state:running", "report:keys-sync-state:done",
      "report:pre-sync-state:running", "report:pre-sync-state:done",
      "report:wait-for-active-work:running", "report:wait-for-active-work:done",
      "report:quiesce-source:running", "report:quiesce-source:done",
      "report:flush-source:running", "report:flush-source:done",
      "report:final-sync-state:running", "report:final-sync-state:done",
      "report:verify-target:running", "report:verify-target:done",
      "report:cutover-firestore:running", "report:cutover-firestore:done",
      "report:unmount-source:running", "report:unmount-source:done",
    ]);
  });

  it("cross-gateway cutover is ONE commit that flips the mirror; unmount comes AFTER", async () => {
    const { deps, input, events } = harness();

    await runMigration(input, deps);

    const cutoverIndex = events.indexOf("cutover:gw-blue->gw-green:mirror=true");
    const unmountReport = events.indexOf("report:unmount-source:running");
    expect(cutoverIndex).toBeGreaterThan(-1);
    expect(unmountReport).toBeGreaterThan(cutoverIndex);
  });

  it("same-gateway migration commits with NO mirror flip", async () => {
    const { deps, input, events } = harness({ toGatewayId: "gw-blue" });

    await runMigration(input, deps);

    expect(events).toContain("cutover:gw-blue->gw-blue:mirror=false");
  });

  it.each(["workspace-only", "workspace-and-projects"] as const)(
    "carries %s checkout scope through both state transfers",
    async (projectCheckoutScope) => {
      const { client, deps, input } = harness();
      input.projectCheckoutScope = projectCheckoutScope;

      await runMigration(input, deps);

      const transferCalls = (client.transferState as ReturnType<typeof vi.fn>).mock.calls;
      expect(transferCalls).toHaveLength(3);
      expect(transferCalls.map(([call]) => call)).toEqual([
        expect.objectContaining({
          mode: "keys",
          projectCheckoutScope,
          includeActivationManifest: false,
        }),
        expect.objectContaining({ mode: "pre", projectCheckoutScope, includeActivationManifest: true }),
        expect.objectContaining({
          mode: "final",
          projectCheckoutScope,
          includeActivationManifest: true,
        }),
      ]);
    },
  );
});

describe("target system-config convergence", () => {
  const SOURCE_COMMIT = "a".repeat(40);
  const TARGET_COMMIT = "b".repeat(40);

  function flushesTo(client: MigrationClient, gatewayId: string) {
    return (client.flushGateway as ReturnType<typeof vi.fn>).mock.calls
      .map(([request]) => request)
      .filter((request) => request.gatewayId === gatewayId);
  }

  it("converges a isolated target on its own accepted commit after a shared gateway source's final copy, before verify", async () => {
    const { client, deps, input } = harness();
    deps.readTargetSystemConfigCommit = vi.fn(async () => TARGET_COMMIT);

    const result = await runMigration({ ...input, convergeTargetSystemConfig: "target-commit" }, deps);

    expect(result.success).toBe(true);
    expect(deps.readTargetSystemConfigCommit).toHaveBeenCalledWith("gw-green");
    expect(flushesTo(client, "gw-green")).toEqual([expect.objectContaining({
      slug: "alice",
      reason: "migration-converge",
      expectedSystemConfigCommit: TARGET_COMMIT,
    })]);
    const finalSync = client.calls.indexOf("transfer:alice:final");
    const converge = client.calls.lastIndexOf("flush:alice:migration-converge");
    expect(converge).toBeGreaterThan(finalSync);
    expect(client.calls.indexOf("verify:alice")).toBeGreaterThan(converge);
  });

  it("converges on the commit a user source accepted at its final flush", async () => {
    const client = happyClient();
    (client.flushGateway as ReturnType<typeof vi.fn>).mockImplementation(async ({ slug, reason }) => {
      client.calls.push(`flush:${slug}:${reason}`);
      return {
        migrationId: "m1", slug, ok: true, durationMs: 1, steps: [],
        ...(reason === "migration-final" ? { systemConfigCommit: SOURCE_COMMIT } : {}),
      };
    });
    const { deps, input } = harness({ client });
    deps.readTargetSystemConfigCommit = vi.fn(async () => TARGET_COMMIT);

    await runMigration({ ...input, convergeTargetSystemConfig: "source-commit" }, deps);

    expect(deps.readTargetSystemConfigCommit).not.toHaveBeenCalled();
    expect(flushesTo(client, "gw-green")).toEqual([expect.objectContaining({
      reason: "migration-converge",
      expectedSystemConfigCommit: SOURCE_COMMIT,
    })]);
  });

  it("fails and rolls back before cutover when the target has no commit to fence a shared-gateway-source converge", async () => {
    const { client, deps, input, events } = harness();
    deps.readTargetSystemConfigCommit = vi.fn(async () => null);

    const result = await runMigration({ ...input, convergeTargetSystemConfig: "target-commit" }, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.errorAt?.error).toMatch(/target gw-green has no accepted system config commit/);
    expect(flushesTo(client, "gw-green")).toEqual([]);
    expect(events.some((event) => event.startsWith("cutover:"))).toBe(false);
  });

  it("requires the user source's own commit instead of falling back to the target's", async () => {
    const { client, deps, input, events } = harness();
    deps.readTargetSystemConfigCommit = vi.fn(async () => TARGET_COMMIT);

    const result = await runMigration({ ...input, convergeTargetSystemConfig: "source-commit" }, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.errorAt?.error).toMatch(/source has no accepted system config commit/);
    expect(deps.readTargetSystemConfigCommit).not.toHaveBeenCalled();
    expect(flushesTo(client, "gw-green")).toEqual([]);
    expect(events.some((event) => event.startsWith("cutover:"))).toBe(false);
  });

  it("fails and rolls back before cutover when the target does not converge", async () => {
    const client = happyClient();
    (client.flushGateway as ReturnType<typeof vi.fn>).mockImplementation(async ({ slug, reason }) => {
      client.calls.push(`flush:${slug}:${reason}`);
      return { migrationId: "m1", slug, ok: reason !== "migration-converge", durationMs: 1, steps: [] };
    });
    const { deps, input, events } = harness({ client });
    deps.readTargetSystemConfigCommit = vi.fn(async () => TARGET_COMMIT);

    const result = await runMigration({ ...input, convergeTargetSystemConfig: "target-commit" }, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.errorAt?.error).toMatch(/did not converge system config/);
    expect(events.some((event) => event.startsWith("cutover:"))).toBe(false);
  });

  it("never converges a target that holds no durable system config", async () => {
    const { client, deps, input } = harness();

    await runMigration(input, deps);

    expect(flushesTo(client, "gw-green")).toEqual([]);
  });
});

describe("migration preparation", () => {
  it("never fences or drains the source if destination preparation fails", async () => {
    const h = harness({ gateAssignment: true });
    vi.mocked(h.client.transferState).mockImplementation(async ({ mode, slug, migrationId }) => {
      if (mode === "pre") throw new Error("incompatible destination");
      return { migrationId, slug, imported: true };
    });
    const result = await runMigration(h.input, h.deps);
    expect(result.success).toBe(false);
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.assignmentWrites).toEqual([]);
  });
});

describe("runMigration — failures", () => {
  it("quiesce failure FAILS the migration: rollback runs, no cutover commit", async () => {
    const client = happyClient();
    (client.quiesce as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }).mockRejectedValue(new Error("agents busy"));
    const { deps, input, events } = harness({ client });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.errorAt).toMatchObject({ phase: "pre-synced", error: "agents busy" });
    expect(events.some((event) => event.startsWith("cutover:"))).toBe(false);
    expect(events.some((event) => event.startsWith("report:rollback:"))).toBe(true);
  });

  it("keeps the durable target cutover when post-cutover source cleanup fails", async () => {
    const client = happyClient();
    (client.unmount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("source pod gone"));
    const { deps, input, events } = harness({ client });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: true, finalPhase: "done", rolledBack: false });
    expect(events).toContain("report:unmount-source:skipped");
  });

  it.each([
    ["a source eviction already holding the agent-deletion lease", '/unmount/shared-0: 500 {"error":"unmount failed","message":"[remove:alice] agents.delete failed for octogee-alice-coach (OpenClawStateLeaseError: agent deletion core:agent-deletion/octogee-alice-coach is held by 6bfbcbdf (lease epoch 1790259821898): code=OPENCLAW_STATE_LEASE_HELD)"}'],
    ["a concurrent source config write", '/unmount/shared-0: 500 {"error":"unmount failed","message":"config changed since last load; re-read and retry","code":"hash-mismatch"}'],
    ["a dropped source socket", '/unmount/shared-0: 500 {"error":"unmount failed","message":"socket closed before connect response","code":"connect-failed"}'],
  ])("leaves the committed cutover untouched when source cleanup loses to %s", async (_name, message) => {
    const client = happyClient();
    (client.unmount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(message));
    const { deps, input, events } = harness({ client });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: true, finalPhase: "done", rolledBack: false });
    expect(events.filter((event) => event.startsWith("cutover:"))).toEqual(["cutover:gw-blue->gw-green:mirror=true"]);
    expect(events.some((event) => event.startsWith("report:rollback:"))).toBe(false);
    expect(events).toContain("report:unmount-source:skipped");
    expect(events.some((event) => event.startsWith("log:") && event.includes("cleanup failed after durable cutover") && event.includes(message))).toBe(true);
  });

  it("reports failed destination cleanup without claiming rollback completed", async () => {
    const client = happyClient();
    (client.verifyTarget as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("verify broke"));
    (client.unmount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("target also broke"));
    const { deps, input, events } = harness({ client, gateAssignment: true, fromGatewayId: "shared-blue" });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.errorAt?.error).toContain("target also broke");
    expect(events).toContain("report:rollback:unmount-target:failed");
    expect(events).not.toContain("assignment:shared-blue:serving");
    expect(client.resume).not.toHaveBeenCalled();
  });

  it("preserves pre-quiesce source ownership when held target state prevents import and rollback cleanup", async () => {
    const client = happyClient();
    const held = "agent database files are still held open: /state/agents/octogee-alice-coach/agent/openclaw-agent.sqlite";
    (client.transferState as ReturnType<typeof vi.fn>).mockImplementation(async ({ mode }) => {
      if (mode === "pre") throw new Error(held);
      return { migrationId: "m1", slug: "alice", imported: true };
    });
    (client.unmount as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(held));
    const { deps, input, events } = harness({ client, gateAssignment: true, fromGatewayId: "shared-blue" });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false, finalPhase: "keys-synced", rolledBack: false });
    expect(result.errorAt?.error).toContain(`rollback:unmount-target: ${held}`);
    expect(client.quiesce).not.toHaveBeenCalled();
    expect(client.schedules).not.toHaveBeenCalled();
    expect(deps.commitCutover).not.toHaveBeenCalled();
    expect(events).toContain("report:rollback:unmount-target:failed");
    expect(events).not.toContain("assignment:shared-blue:quiescing");
  });
});

describe("runMigration — gated quiesce", () => {
  it("marks the assignment quiescing BEFORE the source quiesce RPC", async () => {
    const client = happyClient();
    const { deps, input, events } = harness({ client, gateAssignment: true });

    await runMigration(input, deps);

    const markIndex = events.indexOf("assignment:gw-blue:quiescing");
    const quiesceReport = events.indexOf("report:quiesce-source:done");
    expect(markIndex).toBeGreaterThan(-1);
    expect(markIndex).toBeLessThan(quiesceReport);
  });

  it("quiesce failure restores the assignment to serving on rollback", async () => {
    const client = happyClient();
    (client.quiesce as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }).mockRejectedValue(new Error("agents busy"));
    const { deps, input, events } = harness({ client, gateAssignment: true });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(events).toContain("assignment:gw-blue:quiescing");
    expect(events).toContain("assignment:gw-blue:serving");
  });

  it("flushes the source after assignment-gated quiescence and before final sync", async () => {
    const client = happyClient();
    const { deps, input, events } = harness({ client, gateAssignment: true });

    await runMigration(input, deps);

    const gate = events.indexOf("assignment:gw-blue:quiescing");
    const quiesceDone = events.indexOf("report:quiesce-source:done");
    const flushRunning = events.indexOf("report:flush-source:running");
    const finalSyncRunning = events.indexOf("report:final-sync-state:running");
    const quiesce = client.calls.indexOf("quiesce:alice");
    const flush = client.calls.indexOf("flush:alice:migration-final");
    const finalSync = client.calls.indexOf("transfer:alice:final");
    expect(gate).toBeGreaterThan(-1);
    expect(quiesceDone).toBeGreaterThan(gate);
    expect(flushRunning).toBeGreaterThan(quiesceDone);
    expect(finalSyncRunning).toBeGreaterThan(flushRunning);
    expect(quiesce).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(quiesce);
    expect(finalSync).toBeGreaterThan(flush);
  });

  it("flush failure restores the source assignment and never starts final sync", async () => {
    const client = happyClient();
    (client.flushGateway as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("durable checkpoint unavailable"),
    );
    const { deps, input, events } = harness({ client, gateAssignment: true });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.errorAt).toMatchObject({
      phase: "source-quiesced",
      error: "durable checkpoint unavailable",
    });
    expect(client.calls).not.toContain("transfer:alice:final");
    expect(events).toContain("assignment:gw-blue:serving");
  });

  it("a pre-quiesce failure never touches roster state", async () => {
    const client = happyClient();
    (client.transferState as ReturnType<typeof vi.fn>).mockImplementation(async ({ mode }: { mode?: string }) => {
      if (mode === "keys") throw new Error("key sync broke");
      return { migrationId: "m1", slug: "alice", imported: true };
    });
    const { deps, input, assignmentWrites } = harness({ client, gateAssignment: true });

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false });
    expect(assignmentWrites).toEqual([]);
  });

  it("legacy migration (no gateAssignment): no roster-state writes at all", async () => {
    const { deps, input, assignmentWrites } = harness();

    await runMigration(input, deps);

    expect(assignmentWrites).toEqual([]);
  });

  it("refuses a gated migration without setAssignmentState wired", async () => {
    const { deps, input } = harness({ gateAssignment: true });
    delete (deps as { setAssignmentState?: unknown }).setAssignmentState;

    const result = await runMigration(input, deps);

    expect(result).toMatchObject({ success: false });
    expect(result.errorAt?.error).toMatch(/setAssignmentState/u);
  });
});

it("resumes source ingress after final copy fails, and never on successful cutover", async () => {
  const failed = harness({ gateAssignment: true });
  const transfer = vi.mocked(failed.client.transferState).getMockImplementation()!;
  vi.mocked(failed.client.transferState).mockImplementationOnce(transfer).mockImplementationOnce(transfer).mockRejectedValueOnce(new Error("copy failed"));
  await runMigration(failed.input, failed.deps);
  expect(failed.client.resume).toHaveBeenCalledWith({ migrationId: "m1", gatewayId: "gw-blue", slug: "alice" });
  const success = harness({ gateAssignment: true });
  await runMigration(success.input, success.deps);
  expect(success.client.resume).not.toHaveBeenCalled();
});

it("reports source assignment publication failure after native ingress resumes", async () => {
  const h = harness({ gateAssignment: true });
  vi.mocked(h.client.quiesce).mockResolvedValueOnce({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }).mockRejectedValueOnce(new Error("drain failed"));
  vi.mocked(h.deps.setAssignmentState!).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("restore failed"));
  await expect(runMigration(h.input, h.deps)).rejects.toThrow("restore failed");
  expect(h.client.resume).toHaveBeenCalledOnce();
  expect(h.assignmentWrites).not.toContainEqual(expect.objectContaining({ state: "serving" }));
});


describe("schedule transfer", () => {
  it("snapshots the source's jobs once it is quiesced, persists them, and recreates them on the target after cutover before unmounting the source", async () => {
    const h = harness({ gateAssignment: true });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true, finalPhase: "done" });

    const order = h.events.filter((event) => /^(report:quiesce-source:|report:flush-source:done|schedules-|cutover:|report:unmount-source:done)/.test(event));
    expect(order).toEqual([
      "report:quiesce-source:running",
      "schedules-saved:gw-blue->gw-green:1",
      "report:quiesce-source:done",
      "report:flush-source:done",
      "cutover:gw-blue->gw-green:mirror=true",
      "schedules-restored:gw-green",
      "report:unmount-source:done",
    ]);
    expect(h.client.schedules).toHaveBeenNthCalledWith(1, { migrationId: "m1", slug: "alice", gatewayId: "gw-blue", op: "snapshot" });
    expect(h.client.schedules).toHaveBeenNthCalledWith(2, { migrationId: "m1", slug: "alice", gatewayId: "gw-blue", op: "remove", jobIds: ["job-standup"] });
    expect(h.client.schedules).toHaveBeenNthCalledWith(3, { migrationId: "m1", slug: "alice", gatewayId: "gw-green", op: "restore", records: [STANDUP] });
    expect(h.transfers.get("m1")).toEqual({
      migrationId: "m1", slug: "alice", sourceGatewayId: "gw-blue", targetGatewayId: "gw-green",
      records: [STANDUP], skipped: [], snapshotAt: expect.any(Number),
      restoredTo: "gw-green", restoredAt: expect.any(Number), restoreAttemptedTo: "gw-green", restoreAttemptedAt: expect.any(Number), restoreFailures: [],
    });
  });

  it("quiesces the source without a cron.migration hold and never drives the scheduler handoff", async () => {
    const h = harness({ gateAssignment: true });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    for (const [request] of vi.mocked(h.client.quiesce).mock.calls) {
      expect(request).not.toHaveProperty("schedulerHandoff");
      expect(request).not.toHaveProperty("schedulerMigrationId");
    }
    expect(h.client.scheduler).not.toHaveBeenCalled();
  });

  it("removes the source jobs only after the snapshot is saved", async () => {
    const h = harness();

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    const removeCall = vi.mocked(h.client.schedules).mock.calls.findIndex(([request]) => request.op === "remove");
    expect(vi.mocked(h.deps.saveScheduleTransfer).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(h.client.schedules).mock.invocationCallOrder[removeCall]!);
  });

  it("warns when the source could not remove every saved job and still recreates them all", async () => {
    const h = harness();
    const fake = vi.mocked(h.client.schedules).getMockImplementation()!;
    vi.mocked(h.client.schedules).mockImplementation(async (request) => {
      if (request.op === "snapshot") return { migrationId: "m1", slug: "alice", op: "snapshot", records: [STANDUP, { ...STANDUP, sourceJobId: "job-digest" }], skipped: [] };
      if (request.op === "remove") return { migrationId: "m1", slug: "alice", op: "remove", removed: 1, failed: [{ jobId: "job-digest", error: "busy" }] };
      return fake(request);
    });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    expect(h.events.some((event) => event.startsWith("log:") && event.includes("⚠") && event.includes("gw-blue kept 1 of 2 snapshotted schedule(s)"))).toBe(true);
    expect(h.client.schedules).toHaveBeenLastCalledWith(expect.objectContaining({ op: "restore", records: [STANDUP, { ...STANDUP, sourceJobId: "job-digest" }] }));
  });

  it("completes the move when the source cannot be asked to remove the saved jobs", async () => {
    const h = harness();
    const fake = vi.mocked(h.client.schedules).getMockImplementation()!;
    vi.mocked(h.client.schedules).mockImplementation(async (request) => {
      if (request.op === "remove") throw new Error("/schedules/gw-blue: 503 restarting");
      return fake(request);
    });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true, finalPhase: "done" });

    expect(h.events.some((event) => event.startsWith("log:") && event.includes("could not remove") && event.includes("503 restarting"))).toBe(true);
    expect(h.client.schedules).toHaveBeenLastCalledWith(expect.objectContaining({ gatewayId: "gw-green", op: "restore" }));
  });

  it("records the jobs the target could not recreate", async () => {
    const h = harness();
    const snapshotAndRestore = vi.mocked(h.client.schedules).getMockImplementation()!;
    vi.mocked(h.client.schedules).mockImplementation(async (request) => request.op === "restore"
      ? { migrationId: "m1", slug: "alice", op: "restore", created: 0, existing: 0,
        failed: [{ name: "standup", agentId: STANDUP.agentId, sourceJobId: STANDUP.sourceJobId, error: "invalid cron", retryable: false }] }
      : snapshotAndRestore(request));

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    expect(h.deps.recordScheduleRestore).toHaveBeenCalledWith("m1", {
      restoreAttemptedTo: "gw-green", restoreAttemptedAt: expect.any(Number),
      restoreFailures: [{ name: "standup", agentId: STANDUP.agentId, sourceJobId: STANDUP.sourceJobId, error: "invalid cron" }],
    });
  });

  it("restores the snapshot on the source when the migration rolls back before cutover", async () => {
    const h = harness({ gateAssignment: true });
    vi.mocked(h.client.flushGateway).mockRejectedValue(new Error("durable checkpoint unavailable"));

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: false, rolledBack: true });

    expect(h.client.calls.filter((call) => call.startsWith("schedules:"))).toEqual(["schedules:gw-blue:snapshot", "schedules:gw-blue:remove", "schedules:gw-blue:restore"]);
    expect(h.transfers.get("m1")).toMatchObject({ restoredTo: "gw-blue", restoreFailures: [] });
    expect(h.events).toContain("assignment:gw-blue:serving");
  });

  it("never snapshots when the migration fails before the source is quiesced", async () => {
    const h = harness({ gateAssignment: true });
    vi.mocked(h.client.quiesce).mockResolvedValueOnce({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }).mockRejectedValue(new Error("agents busy"));

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: false, rolledBack: true });

    expect(h.client.schedules).not.toHaveBeenCalled();
    expect(h.deps.saveScheduleTransfer).not.toHaveBeenCalled();
  });

  it.each(["404 endpoint unavailable", "500 cron.list failed"])("retains the source when its schedule snapshot fails: %s", async (failure) => {
    const h = harness({ gateAssignment: true });
    vi.mocked(h.client.schedules).mockRejectedValue(new Error(`/schedules/gw-blue: ${failure}`));

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: false, rolledBack: true });

    expect(h.client.schedules).toHaveBeenCalledOnce();
    expect(h.deps.saveScheduleTransfer).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    expect(h.client.unmount).not.toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue" }));
    expect(h.client.resume).toHaveBeenCalledWith({ migrationId: "m1", gatewayId: "gw-blue", slug: "alice" });
    expect(h.events).toContain("assignment:gw-blue:serving");
  });

  it("restores fenced jobs on the source before rollback when persisting the snapshot fails", async () => {
    const h = harness();
    vi.mocked(h.deps.saveScheduleTransfer).mockRejectedValue(new Error("firestore unavailable"));

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: false, rolledBack: true });

    expect(h.client.calls.filter((call) => call.startsWith("schedules:"))).toEqual(["schedules:gw-blue:snapshot", "schedules:gw-blue:restore"]);
    expect(h.client.schedules).toHaveBeenLastCalledWith({ migrationId: "m1", slug: "alice", gatewayId: "gw-blue", op: "restore", records: [STANDUP] });
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    expect(vi.mocked(h.client.schedules).mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(h.client.resume).mock.invocationCallOrder[0]!);
  });

  it("completes the migration and leaves the snapshot pending when the target restore fails", async () => {
    const h = harness({ gateAssignment: true });
    const snapshot = vi.mocked(h.client.schedules).getMockImplementation()!;
    vi.mocked(h.client.schedules).mockImplementation(async (request) => {
      if (request.op === "restore") throw new Error("/schedules/gw-green: 503 gateway restarting");
      return snapshot(request);
    });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true, finalPhase: "done", rolledBack: false });

    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue" }));
    expect(h.transfers.get("m1")).toMatchObject({
      restoreAttemptedTo: "gw-green",
      restoreFailures: [expect.objectContaining({ error: "/schedules/gw-green: 503 gateway restarting" })],
    });
    expect(h.transfers.get("m1")?.restoredTo).toBeUndefined();
    expect(h.events).toContain("report:unmount-source:done");
    expect(h.events.some((event) => event.startsWith("log:") && event.includes("schedule restore on gw-green failed") && event.includes("503 gateway restarting"))).toBe(true);
  });

  it("completes the migration when recording the restore fails", async () => {
    const h = harness();
    vi.mocked(h.deps.recordScheduleRestore).mockRejectedValue(new Error("firestore unavailable"));

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true, finalPhase: "done" });

    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue" }));
  });

  it("carries a snapshot an interrupted attempt left pending, and asks the source to remove its jobs again", async () => {
    const h = harness();
    const pending: ScheduleTransferDoc = {
      migrationId: "m1", slug: "alice", sourceGatewayId: "gw-blue", targetGatewayId: "gw-green", records: [STANDUP], skipped: [], snapshotAt: 1,
    };
    h.transfers.set("m1", pending);

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    expect(h.client.calls.filter((call) => call.startsWith("schedules:"))).toEqual(["schedules:gw-blue:remove", "schedules:gw-green:restore"]);
    expect(h.deps.saveScheduleTransfer).not.toHaveBeenCalled();
    expect(h.transfers.get("m1")).toMatchObject({ records: [STANDUP], restoredTo: "gw-green" });
  });

  it("takes a fresh snapshot when an earlier attempt's jobs were already restored to the source", async () => {
    const h = harness();
    h.transfers.set("m1", {
      migrationId: "m1", slug: "alice", sourceGatewayId: "gw-blue", targetGatewayId: "gw-green", records: [], skipped: [], snapshotAt: 1,
      restoredTo: "gw-blue", restoredAt: 2, restoreFailures: [],
    });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    expect(h.client.calls.filter((call) => call.startsWith("schedules:"))).toEqual(["schedules:gw-blue:snapshot", "schedules:gw-blue:remove", "schedules:gw-green:restore"]);
    expect(h.transfers.get("m1")).toMatchObject({ records: [STANDUP], restoredTo: "gw-green" });
  });

  it("finishes an old-protocol scheduler handoff instead of a snapshot restore before unmounting the source", async () => {
    const h = harness();
    h.deps.finishLegacySchedulerHandoff = vi.fn(async () => { h.events.push("legacy-handoff-finished"); });

    expect(await runMigration({ ...h.input, resumeForwardRecovery: {} }, h.deps)).toMatchObject({ success: true });

    expect(h.deps.finishLegacySchedulerHandoff).toHaveBeenCalledOnce();
    expect(h.client.schedules).not.toHaveBeenCalled();
    expect(vi.mocked(h.deps.finishLegacySchedulerHandoff).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(h.client.unmount).mock.invocationCallOrder[0]!);
  });

  it("keeps a strict schedule handoff failure pending after cutover without unmounting the source", async () => {
    const h = harness();
    h.deps.commitCutover = vi.fn(async () => { h.deps.readCurrentGateway = async () => "gw-green"; });
    h.deps.finishLegacySchedulerHandoff = vi.fn(async () => { throw new Error("native scheduler retirement authority changed"); });

    const result = await runMigration({ ...h.input, resumeForwardRecovery: {} }, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.errorAt?.error).toContain("migration cutover committed; destination recovery pending: status 503");
    expect(result.errorAt?.error).toContain("native scheduler retirement authority changed");
    expect(h.client.unmount).not.toHaveBeenCalled();
  });

  it("moves no schedules when the user stays on the same gateway", async () => {
    const h = harness({ toGatewayId: "gw-blue" });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: true });

    expect(h.client.schedules).not.toHaveBeenCalled();
    expect(h.deps.readScheduleTransfer).not.toHaveBeenCalled();
  });
});

describe("restoreScheduleTransfer", () => {
  const CHECK: ScheduleRecord = { sourceJobId: "job-check", agentId: "octogee-alice-proj-orbit", job: { name: "Proactive check", schedule: { kind: "every", everyMs: 60_000 } } };
  const doc: ScheduleTransferDoc = {
    migrationId: "m1", slug: "alice", sourceGatewayId: "gw-blue", targetGatewayId: "gw-green", records: [STANDUP, CHECK], skipped: [], snapshotAt: 1,
  };
  const held = "CronAgentMigrationHeldError: Cron agent octogee-alice-proj-orbit is held for migration mig-old:scheduler:1:claim:1";

  function restoreFails(h: ReturnType<typeof harness>, failed: ScheduleRestoreResult["failed"]): void {
    vi.mocked(h.client.schedules).mockResolvedValue({
      migrationId: "m1", slug: "alice", op: "restore", created: doc.records.length - failed.length, existing: 0, failed,
    } as never);
  }

  it("warns about each schedule it could not restore, naming the agent, the job and the cause, and returns them", async () => {
    const h = harness();
    h.transfers.set("m1", doc);
    restoreFails(h, [{ name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: held, retryable: false }]);

    const failures = await restoreScheduleTransfer(h.deps, { migrationId: "m1", slug: "alice", gatewayId: "gw-green" });

    expect(failures).toEqual([{ name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: held, transient: false }]);
    expect(h.events.filter((event) => event.startsWith("log:[migration-runner] ⚠"))).toEqual([
      `log:[migration-runner] ⚠ schedule "Proactive check" of octogee-alice-proj-orbit was not restored on gw-green migrationId=m1 slug=alice: ${held}`,
    ]);
    expect(h.transfers.get("m1")).toMatchObject({
      restoreAttemptedTo: "gw-green",
      restoreFailures: [{ name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: held }],
    });
    expect(h.transfers.get("m1")?.restoredTo).toBeUndefined();
  });

  it("attributes a failure to the agent and source job the gateway names when another agent has a schedule of the same name", async () => {
    const h = harness();
    const coachCheck: ScheduleRecord = { ...CHECK, sourceJobId: "job-coach-check", agentId: "octogee-alice-coach" };
    h.transfers.set("m1", { ...doc, records: [coachCheck, CHECK] });
    restoreFails(h, [{ name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: "invalid cron", retryable: false }]);

    const failures = await restoreScheduleTransfer(h.deps, { migrationId: "m1", slug: "alice", gatewayId: "gw-green" });

    expect(failures).toEqual([{ name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: "invalid cron", transient: false }]);
    expect(h.events.filter((event) => event.startsWith("log:[migration-runner] ⚠"))).toEqual([
      "log:[migration-runner] ⚠ schedule \"Proactive check\" of octogee-alice-proj-orbit was not restored on gw-green migrationId=m1 slug=alice: invalid cron",
    ]);
    expect(h.transfers.get("m1")?.restoreFailures).toEqual([
      { name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: "invalid cron" },
    ]);
  });

  it("leaves a failure unattributed when the gateway names no schedule of this transfer", async () => {
    const h = harness();
    h.transfers.set("m1", doc);
    restoreFails(h, [{ name: "Proactive check", agentId: CHECK.agentId, sourceJobId: "job-elsewhere", error: "invalid cron", retryable: false }]);

    const failures = await restoreScheduleTransfer(h.deps, { migrationId: "m1", slug: "alice", gatewayId: "gw-green" });

    expect(failures).toEqual([{ name: "Proactive check", agentId: null, sourceJobId: null, error: "invalid cron", transient: false }]);
    expect(h.transfers.get("m1")?.restoreFailures).toEqual([{ name: "Proactive check", error: "invalid cron" }]);
  });

  it.each([
    "OpenClaw workspace identities are not initialized for this boot",
    'invalid cron.add params: Auth profile "platform-openai:default" is temporarily unavailable for platform-openai/gpt-6.1-terra.',
    "cron.add response timed out after 30000ms",
  ])("takes the gateway's word over the message on whether a schedule may yet be restored: %s", async (refusal) => {
    const h = harness();
    h.transfers.set("m1", doc);
    restoreFails(h, [{ name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: refusal, retryable: false }]);

    const failures = await restoreScheduleTransfer(h.deps, { migrationId: "m1", slug: "alice", gatewayId: "gw-green" });

    expect(failures).toEqual([expect.objectContaining({ sourceJobId: CHECK.sourceJobId, transient: false })]);
  });

  it("marks a schedule the gateway could not reach its scheduler for as one to retry, and stores only its cause", async () => {
    const h = harness();
    h.transfers.set("m1", doc);
    const timeout = "cron.add response timed out after 30000ms";
    restoreFails(h, [{ name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: timeout, retryable: true }]);

    const failures = await restoreScheduleTransfer(h.deps, { migrationId: "m1", slug: "alice", gatewayId: "gw-green" });

    expect(failures).toEqual([{ name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: timeout, transient: true }]);
    expect(h.transfers.get("m1")?.restoreFailures).toEqual([
      { name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: timeout },
    ]);
  });

  it.each([
    ["the gateway is unavailable", new MigrationRpcError("/schedules/gw-green: 503 gateway restarting", { status: 503 }), true],
    ["the gateway cannot be reached", new MigrationTransportError("schedules transport failed: socket hang up"), true],
    ["the gateway lost its scheduler", new MigrationRpcError("/schedules/gw-green: 500 socket closed before cron.list response", { status: 500, retryable: true }), true],
    ["the gateway fails without saying whether it may yet succeed", new MigrationRpcError("/schedules/gw-green: 500 Internal Server Error", { status: 500 }), true],
    ["its answer does not match the request", new Error("schedules restore acknowledgement mismatch"), true],
    ["the gateway refuses it", new MigrationRpcError("/schedules/gw-green: 500 restore failed", { status: 500, retryable: false }), false],
    ["the gateway rejects the request", new MigrationRpcError("/schedules/gw-green: 400 invalid schedule transfer request", { status: 400 }), false],
  ] as const)("reports every pending schedule as unrestored when the restore call fails because %s", async (_cause, error, transient) => {
    const h = harness();
    h.transfers.set("m1", doc);
    vi.mocked(h.client.schedules).mockRejectedValue(error);

    const failures = await restoreScheduleTransfer(h.deps, { migrationId: "m1", slug: "alice", gatewayId: "gw-green" });

    expect(failures).toEqual([
      { name: "standup", agentId: STANDUP.agentId, sourceJobId: STANDUP.sourceJobId, error: error.message, transient },
      { name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: error.message, transient },
    ]);
    expect(h.transfers.get("m1")).toMatchObject({
      restoreAttemptedTo: "gw-green",
      restoreFailures: [
        { name: "standup", agentId: STANDUP.agentId, sourceJobId: STANDUP.sourceJobId, error: error.message },
        { name: "Proactive check", agentId: CHECK.agentId, sourceJobId: CHECK.sourceJobId, error: error.message },
      ],
    });
    expect(h.transfers.get("m1")?.restoredTo).toBeUndefined();
  });

  it("leaves a failed read of the transfer record to its caller, restoring and recording nothing", async () => {
    const h = harness();
    h.transfers.set("m1", doc);
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    vi.mocked(h.deps.readScheduleTransfer).mockRejectedValueOnce(reset);

    await expect(restoreScheduleTransfer(h.deps, { migrationId: "m1", slug: "alice", gatewayId: "gw-green" })).rejects.toBe(reset);

    expect(h.client.schedules).not.toHaveBeenCalled();
    expect(h.deps.recordScheduleRestore).not.toHaveBeenCalled();
    expect(h.transfers.get("m1")).toEqual(doc);
  });

  it("warns when there is no transfer record to restore", async () => {
    const h = harness();

    expect(await restoreScheduleTransfer(h.deps, { migrationId: "m1", slug: "alice", gatewayId: "gw-green" })).toEqual([]);

    expect(h.events).toContain("log:[migration-runner] ⚠ no schedule transfer record migrationId=m1 slug=alice to restore on gw-green");
    expect(h.client.schedules).not.toHaveBeenCalled();
  });

  it("leaves a transfer whose schedules restored unrestored while custody is held, restores nothing again, and records it once custody is released", async () => {
    const h = harness();
    h.transfers.set("m1", doc);
    restoreFails(h, []);
    const scope = { migrationId: "m1", slug: "alice", gatewayId: "gw-green" };

    expect(await restoreScheduleTransfer(h.deps, { ...scope, custodyReleased: false })).toEqual([]);

    expect(h.transfers.get("m1")).toMatchObject({ restoreAttemptedTo: "gw-green", restoreFailures: [] });
    expect(h.transfers.get("m1")).not.toHaveProperty("restoredTo");

    expect(await restoreScheduleTransfer(h.deps, { ...scope, custodyReleased: false })).toEqual([]);
    expect(h.transfers.get("m1")).not.toHaveProperty("restoredTo");
    expect(await restoreScheduleTransfer(h.deps, { ...scope, custodyReleased: true })).toEqual([]);

    expect(h.client.schedules).toHaveBeenCalledTimes(1);
    expect(h.transfers.get("m1")).toMatchObject({ restoredTo: "gw-green", restoreAttemptedTo: "gw-green", restoreFailures: [] });
  });

  it("reports nothing when the snapshot was already restored", async () => {
    const h = harness();
    h.transfers.set("m1", { ...doc, restoredTo: "gw-green", restoredAt: 2, restoreFailures: [] });

    expect(await restoreScheduleTransfer(h.deps, { migrationId: "m1", slug: "alice", gatewayId: "gw-green" })).toEqual([]);
    expect(h.client.schedules).not.toHaveBeenCalled();
  });
});

it("reports transfer and import together without counting target config convergence", async () => {
  const h = harness();
  let clock = 0;
  h.deps.now = () => clock;
  h.deps.readTargetSystemConfigCommit = async () => { clock += 5_000; return "b".repeat(40); };
  vi.mocked(h.client.transferState).mockImplementation(async ({ mode, slug }) => {
    clock += mode === "final" ? 70_000 : 400;
    return { migrationId: "m1", slug, imported: true };
  });

  expect(await runMigration({ ...h.input, convergeTargetSystemConfig: "target-commit" }, h.deps)).toMatchObject({ success: true });

  const finalSync = h.events.find((event) => event.startsWith("log:") && event.includes("final-sync-state ok"));
  expect(finalSync).toContain("transferAndImportMs=70000");
  const keysSync = h.events.find((event) => event.startsWith("log:") && event.includes("keys-sync-state ok"));
  expect(keysSync).toContain("transferAndImportMs=400");
});

describe("rollback releases the source", () => {
  function heldSourceHarness() {
    const h = harness({ gateAssignment: true });
    h.deps.wait = vi.fn(async () => undefined);
    vi.mocked(h.client.quiesce).mockResolvedValueOnce({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 }).mockRejectedValue(new Error("/quiesce/gw-blue timed out after 60000ms"));
    return h;
  }

  it("retries the source ingress resume until it is confirmed", async () => {
    const h = heldSourceHarness();
    vi.mocked(h.client.resume).mockRejectedValueOnce(new Error("/resume/gw-blue: 500 socket closed")).mockRejectedValueOnce(new Error("/resume/gw-blue: 500 socket closed"));

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(h.client.resume).toHaveBeenCalledTimes(3);
    expect(h.deps.wait).toHaveBeenCalledTimes(2);
    expect(h.events).toContain("report:rollback:resume-ingress:done");
    expect(h.events).toContain("assignment:gw-blue:serving");
  });

  it("reports an ingress it could not resume as a failed rollback and keeps the source unpublished", async () => {
    const h = heldSourceHarness();
    vi.mocked(h.client.resume).mockRejectedValue(new Error("/resume/gw-blue timed out after 60000ms"));

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.errorAt?.error).toContain("/quiesce/gw-blue timed out after 60000ms");
    expect(result.errorAt?.error).toContain("source ingress on gw-blue not resumed");
    expect(h.events).toContain("report:rollback:resume-ingress:failed");
    expect(h.assignmentWrites).not.toContainEqual(expect.objectContaining({ state: "serving" }));
  });

  it("publishes source serving only after native ingress acknowledges resumption", async () => {
    const h = heldSourceHarness();
    vi.mocked(h.client.resume).mockImplementation(async () => {
      expect(h.assignmentWrites).not.toContainEqual(expect.objectContaining({ state: "serving" }));
    });
    expect(await runMigration(h.input, h.deps)).toMatchObject({ rolledBack: true });
    expect(h.assignmentWrites.at(-1)).toMatchObject({ state: "serving" });
  });

  it("never touches source ingress when the failure precedes the quiesce", async () => {
    const h = harness({ gateAssignment: true });
    vi.mocked(h.client.transferState).mockImplementation(async ({ mode, slug }) => {
      if (mode === "keys") throw new Error("key sync broke");
      return { migrationId: "m1", slug, imported: true };
    });

    const result = await runMigration(h.input, h.deps);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(h.client.resume).not.toHaveBeenCalled();
  });
});

 it.each([false, true])("defers active agent work without discarding preparation (fenced=%s)", async (fenced) => {
  const h = harness({ gateAssignment: true });
  if (fenced) vi.mocked(h.client.quiesce).mockResolvedValueOnce({ migrationId: "m1", slug: "alice", drained: true, runningCount: 0 });
  vi.mocked(h.client.quiesce).mockRejectedValue(new MigrationDrainPendingError("coach is active"));
  expect(await runMigration(h.input, h.deps)).toMatchObject({ success: false, waitingForUserIdle: true, rolledBack: false });
  expect(h.client.unmount).not.toHaveBeenCalled();
  expect(h.client.flushGateway).not.toHaveBeenCalled();
  expect(h.client.resume).toHaveBeenCalled();
  expect(h.deps.commitCutover).not.toHaveBeenCalled();
  expect(h.assignmentWrites).toEqual(fenced ? [expect.objectContaining({ state: "quiescing" }), expect.objectContaining({ state: "serving" })] : []);
});

describe("pre-drain probe journaling", () => {
  it("reports a probe failure under wait-for-active-work, never as a quiesce-source step, and resumes ingress", async () => {
    const h = harness({ gateAssignment: true });
    vi.mocked(h.client.quiesce).mockRejectedValueOnce(new Error("Timed out waiting for an OpenClaw runtime update"));

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: false, rolledBack: true });

    expect(h.events).toContain("report:wait-for-active-work:failed");
    expect(h.events.some((event) => event.startsWith("report:quiesce-source"))).toBe(false);
    expect(h.client.resume).toHaveBeenCalledWith({ migrationId: "m1", gatewayId: "gw-blue", slug: "alice" });
    expect(h.assignmentWrites).toEqual([]);
  });

  it("journals a phase-write failure during the probe and rolls back instead of rejecting", async () => {
    const h = harness({ gateAssignment: true });
    h.deps.setMigrationPhase = vi.fn(async (phase: string) => { if (phase === "waiting") throw new Error("firestore unavailable"); });

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: false, rolledBack: true });

    expect(h.events).toContain("report:wait-for-active-work:failed");
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.events).toContain("report:rollback:unmount-target:done");
  });

  it("reports a probe deferral under wait-for-active-work as skipped", async () => {
    const h = harness({ gateAssignment: true });
    vi.mocked(h.client.quiesce).mockRejectedValueOnce(new MigrationDrainPendingError("coach is active"));

    expect(await runMigration(h.input, h.deps)).toMatchObject({ success: false, waitingForUserIdle: true });

    expect(h.events).toContain("report:wait-for-active-work:skipped");
    expect(h.events.some((event) => event.startsWith("report:quiesce-source"))).toBe(false);
  });
});

it("retains the source fence after an ambiguous final upgrade and resumes from the durable checkpoint", async () => {
  const h = harness({ gateAssignment: true });
  let checkpoint: { sourceSystemConfigCommit?: string } | undefined;
  h.deps.persistForwardRecovery = vi.fn(async state => { checkpoint = structuredClone(state); });
  vi.mocked(h.client.transferState).mockImplementationOnce(async request => ({ ...request, imported: true }))
    .mockImplementationOnce(async request => ({ ...request, imported: true }))
    .mockRejectedValueOnce(new Error("target Doctor upgraded agent store; response lost"));
  const first = await runMigration(h.input, h.deps);
  expect(first).toMatchObject({ success: false, rolledBack: false, errorAt: { error: expect.stringContaining("status 503") } });
  expect(checkpoint).toEqual({});
  expect(h.client.resume).not.toHaveBeenCalled();
  expect(h.client.unmount).not.toHaveBeenCalled();
  expect(h.client.calls.filter((call) => call.startsWith("schedules:"))).toEqual(["schedules:gw-blue:snapshot", "schedules:gw-blue:remove"]);
  vi.mocked(h.client.transferState).mockClear();
  vi.mocked(h.client.quiesce).mockClear();
  const second = await runMigration({ ...h.input, resumeForwardRecovery: checkpoint }, h.deps);
  expect(second).toMatchObject({ success: true, rolledBack: false });
  expect(h.client.quiesce).not.toHaveBeenCalled();
  expect(vi.mocked(h.client.transferState).mock.calls.map(([request]) => request.mode)).toEqual(["keys", "final"]);
  expect(h.client.unmount).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: h.input.fromGatewayId }));
  expect(h.client.calls.filter((call) => call.startsWith("schedules:"))).toEqual(["schedules:gw-blue:snapshot", "schedules:gw-blue:remove", "schedules:gw-green:restore"]);
  expect(h.transfers.get("m1")).toMatchObject({ records: [STANDUP], restoredTo: "gw-green" });
});

it("syncs the user's keys to the target again before the final sync when resuming forward recovery", async () => {
  const h = harness({ gateAssignment: true });

  expect(await runMigration({ ...h.input, resumeForwardRecovery: {} }, h.deps)).toMatchObject({ success: true, rolledBack: false });

  expect(h.client.calls.filter((call) => call.startsWith("transfer:"))).toEqual(["transfer:alice:keys", "transfer:alice:final"]);
  expect(h.client.quiesce).not.toHaveBeenCalled();
  expect(h.client.flushGateway).not.toHaveBeenCalled();
  expect(h.events.filter((event) => event.startsWith("report:")).slice(0, 4)).toEqual([
    "report:keys-sync-state:running", "report:keys-sync-state:done",
    "report:final-sync-state:running", "report:final-sync-state:done",
  ]);
});

it("keeps forward recovery pending with the source fenced when the resumed keys sync fails", async () => {
  const h = harness({ gateAssignment: true });
  vi.mocked(h.client.transferState).mockRejectedValueOnce(new Error("target import port busy"));

  const result = await runMigration({ ...h.input, resumeForwardRecovery: {} }, h.deps);

  expect(result).toMatchObject({ success: false, rolledBack: false });
  expect(result.errorAt?.error).toBe("migration forward recovery pending: status 503: target import port busy");
  expect(h.events).toContain("report:keys-sync-state:failed");
  expect(vi.mocked(h.client.transferState).mock.calls.map(([request]) => request.mode)).toEqual(["keys"]);
  expect(h.client.resume).not.toHaveBeenCalled();
  expect(h.client.unmount).not.toHaveBeenCalled();
});

it("does not dispatch final transfer or release the source when critical checkpoint persistence is ambiguous", async () => {
  const h = harness({ gateAssignment: true });
  h.deps.persistForwardRecovery = vi.fn(async () => { throw new Error("checkpoint write response lost"); });
  expect(await runMigration(h.input, h.deps)).toMatchObject({ success: false, rolledBack: false });
  expect(vi.mocked(h.client.transferState).mock.calls.map(([request]) => request.mode)).toEqual(["keys", "pre"]);
  expect(h.client.resume).not.toHaveBeenCalled();
  expect(h.client.unmount).not.toHaveBeenCalled();
});


it("leaves the destination authoritative when cutover committed but its acknowledgement was lost", async () => {
  const h = harness({ gateAssignment: true });
  let owner = h.input.fromGatewayId;
  h.deps.readCurrentGateway = async () => owner;
  vi.mocked(h.deps.commitCutover).mockImplementation(async () => {
    owner = h.input.toGatewayId;
    throw new Error("commit response lost");
  });
  const result = await runMigration(h.input, h.deps);
  expect(result).toMatchObject({ success: false, rolledBack: false, errorAt: { error: expect.stringContaining("destination recovery pending") } });
  expect(h.client.unmount).not.toHaveBeenCalled();
  expect(h.client.resume).not.toHaveBeenCalled();
  expect(h.assignmentWrites.some(write => write.state === "serving")).toBe(false);
});

it("retains both copies when ownership cannot be read after an ambiguous cutover", async () => {
  const h = harness({ gateAssignment: true });
  h.deps.readCurrentGateway = vi.fn(async () => { throw new Error("Firestore unavailable"); });
  vi.mocked(h.deps.commitCutover).mockRejectedValue(new Error("commit outcome unknown"));

  expect(await runMigration(h.input, h.deps)).toMatchObject({
    success: false,
    rolledBack: false,
    errorAt: { error: "migration ownership lookup pending: status 503: Firestore unavailable" },
  });
  expect(h.client.unmount).not.toHaveBeenCalled();
  expect(h.client.resume).not.toHaveBeenCalled();
  expect(h.assignmentWrites.some(write => write.state === "serving")).toBe(false);
});


it("keeps preparation on Shared and activates the target only after the ownership switch", async () => {
  const h = harness({ gateAssignment: true, fromGatewayId: "shared-blue" });
  let owner = h.input.fromGatewayId;
  h.deps.readCurrentGateway = async () => owner;
  h.deps.readTargetSystemConfigCommit = async () => "a".repeat(40);
  vi.mocked(h.deps.commitCutover).mockImplementation(async () => { owner = h.input.toGatewayId; });
  vi.mocked(h.client.transferState).mockImplementation(async request => {
    expect(owner).toBe(h.input.fromGatewayId);
    if (request.mode === "pre") expect(h.assignmentWrites).toHaveLength(0);
    return { migrationId: request.migrationId, slug: request.slug, imported: true };
  });
  vi.mocked(h.client.resume).mockImplementation(async request => {
    expect(owner).toBe(h.input.toGatewayId);
    expect(request.role).toBe("target");
  });
  expect(await runMigration({ ...h.input, preserveSource: true, convergeTargetSystemConfig: "target-commit" }, h.deps)).toMatchObject({ success: true });
  expect(h.client.resume).toHaveBeenCalledOnce();
  expect(h.client.verifyTarget).not.toHaveBeenCalled();
});

it("retains target ownership and source files when assigned target startup fails", async () => {
  const h = harness({ gateAssignment: true, fromGatewayId: "shared-blue" });
  let owner = h.input.fromGatewayId;
  h.deps.readCurrentGateway = async () => owner;
  vi.mocked(h.deps.commitCutover).mockImplementation(async () => { owner = h.input.toGatewayId; });
  vi.mocked(h.client.resume).mockRejectedValue(new Error("runtime not ready"));
  expect(await runMigration({ ...h.input, preserveSource: true }, h.deps)).toMatchObject({ success: false, rolledBack: false });
  expect(owner).toBe(h.input.toGatewayId);
  expect(h.client.unmount).not.toHaveBeenCalled();
});

it("verifies a disposable target before cutover and again before cleaning up the source", async () => {
  const h = harness({ gateAssignment: true, fromGatewayId: "shared-blue" });
  h.deps.readTargetSystemConfigCommit = async () => "a".repeat(40);
  expect(await runMigration({ ...h.input, preserveSource: true, verifyPreparedTarget: true, convergeTargetSystemConfig: "target-commit" }, h.deps)).toMatchObject({ success: true });
  const [prepared, serving] = vi.mocked(h.client.verifyTarget).mock.invocationCallOrder;
  const [cutover] = vi.mocked(h.deps.commitCutover).mock.invocationCallOrder;
  expect(prepared).toBeLessThan(cutover);
  expect(serving).toBeGreaterThan(cutover);
  expect(serving).toBeLessThan(vi.mocked(h.client.unmount).mock.invocationCallOrder[0]);
});

it("keeps the Shared owner when a disposable target's prepared import cannot be verified", async () => {
  const h = harness({ gateAssignment: true, fromGatewayId: "shared-blue" });
  vi.mocked(h.client.verifyTarget).mockRejectedValueOnce(new Error("prepared target is incomplete"));
  expect(await runMigration({ ...h.input, preserveSource: true, verifyPreparedTarget: true }, h.deps)).toMatchObject({ success: false });
  expect(h.deps.commitCutover).not.toHaveBeenCalled();
  expect(h.client.unmount).not.toHaveBeenCalledWith(expect.objectContaining({ gatewayId: h.input.fromGatewayId }));
});
