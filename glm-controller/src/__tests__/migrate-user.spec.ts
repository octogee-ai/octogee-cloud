import { migrationSourceReady } from "../migration-root-stability.js";
import { generateKeyPairSync } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import type { Operation, OperationStep } from "@octogee/shared/types/glm";
import type { OperationRecord } from "@octogee/core/platform-state";
import { createMigrateUserHandler, FRESH_TARGET_CONFIG_COMMIT_WAIT_MS } from "../handlers/migrate-user";
import type { MigrateUserDeps } from "../handlers/migrate-user";
import type { OperationContext } from "../operation-router";
import { createMigrationClient, MigrationDrainPendingError, MigrationRpcError, MigrationTransportError, type MigrationClient } from "@octogee/core/fleet-migration-client";
import {
  ADD_USER_DEADLINE_MS,
  MIGRATION_VERIFY_DEFAULT_AGENT_ATTACH_IN_PROGRESS,
  type ScheduleRecord,
  type ScheduleTransferDoc,
} from "@octogee/shared/types/fleet-controller";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import { buildOperationCompletionUpdate, classifyOperationFailure, OPERATOR_ISOLATED_GATEWAY_WAIT_MS } from "../operation-retry";
import { assertUserRestoreSettled, createOperationContext, PendingUserRestoreError } from "../operation-context";
import { builderReturnOperationId } from "@octogee/core/user-activation-lease";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import type { NativeReturnPark, NativeSourcePark } from "../lib/native-vm-return";
import { retireNativeSchedulerBeforeStage } from "../lib/native-scheduler-retirement";
import { createCronCustodyGateways, type CronCustodyGateways, type CustodyJob } from "@octogee/core/testing/cron-custody";
import { restoreScheduleTransfer, type ScheduleRestoreRecord } from "@octogee/core/fleet-migration-runner";

const SOURCE_SYSTEM_CONFIG_COMMIT = "a".repeat(40);
const STANDUP: ScheduleRecord = { sourceJobId: "job-standup", agentId: "octogee-alice-coach", job: { name: "standup", schedule: { kind: "cron", expr: "0 9 * * *" } } };
const PENDING_SCHEDULES: ScheduleTransferDoc = {
  migrationId: "mig-op-1", slug: "alice", sourceGatewayId: "gw-blue", targetGatewayId: "gw-green", records: [STANDUP], skipped: [], snapshotAt: 4_500,
};
const TARGET_SYSTEM_CONFIG_COMMIT = "c".repeat(40);

const SNAPSHOT: FleetBrokerUserSnapshot = {
  uid: "uid-alice",
  slug: "alice",
  tier: "trial",
  gatewayId: "gw-blue",
  status: "complete",
  agentIds: ["octogee-alice-coach"],
  repoUrl: "git@gitea:octogee/alice.git",
  mattermostUserId: "mm-alice",
  customerMmUserId: "mm-alice",
  channels: [],
  projects: [],
  ownerName: "Alice",
  email: "alice@example.com",
  displayName: "Alice",
  lastName: "",
  photoURL: "",
  persona: null,
  coachToken: "coach-token",
  coachMmUserId: "mm-coach",
} as unknown as FleetBrokerUserSnapshot;

function gatewayRootFence(
  gatewayId: string,
  release = 1,
): NonNullable<Operation["userMigrationV2"]>["sourceRootFence"] {
  return {
    gatewayId,
    updatedAt: gatewayId === "gw-blue" ? 17 : 18,
    latestRelease: release,
    desiredRelease: release,
    liveRelease: release,
    gatewayClass: "isolated",
    ownerUid: "uid-alice",
    builderSlug: "alice",
    configHash: gatewayId === "gw-blue" ? "7".repeat(64) : "8".repeat(64),
  };
}

function mkOp(overrides: Partial<OperationRecord>): OperationRecord {
  return {
    id: "op-1",
    kind: "migrate-user",
    status: "running",
    createdBy: "admin@octogee.com",
    createdAt: 1_000,
    startedAt: 4_000,
    completedAt: null,
    input: { uid: "uid-alice", toGatewayId: "gw-green" },
    steps: [],
    ...overrides,
  };
}

function happyClient(): MigrationClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    abortImport: vi.fn(async () => undefined),
    scheduler: vi.fn(async ({ migrationId, phase }) => ({ operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: [] } })),
    schedules: vi.fn(async (request: Parameters<MigrationClient["schedules"]>[0]) => {
      calls.push(`schedules:${request.gatewayId}:${request.op}`);
      if (request.op === "snapshot") return { migrationId: request.migrationId, slug: request.slug, op: "snapshot", records: [STANDUP], skipped: [] };
      if (request.op === "remove") return { migrationId: request.migrationId, slug: request.slug, op: "remove", removed: request.jobIds.length, failed: [] };
      return { migrationId: request.migrationId, slug: request.slug, op: "restore", created: request.records.length, existing: 0, failed: [] };
    }) as unknown as MigrationClient["schedules"],
    restoreTarget: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`restore:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, restored: true, steps: [] };
    }) as MigrationClient["restoreTarget"],
    resume: vi.fn(async () => undefined),
    quiesce: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`quiesce:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, drained: true, runningCount: 0 };
    }) as MigrationClient["quiesce"],
    flushGateway: vi.fn(async ({ migrationId, slug }) => ({
      migrationId,
      slug,
      ok: true,
      durationMs: 1,
      systemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
      steps: [],
    })) as MigrationClient["flushGateway"],
    transferState: vi.fn(async ({ fromGatewayId, toGatewayId, slug, mode }) => {
      calls.push(`transfer:${mode ?? "default"}:${fromGatewayId}->${toGatewayId}`);
      return { migrationId: "mig-op-1", slug, imported: true };
    }) as MigrationClient["transferState"],
    verifyTarget: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`verify:${gatewayId}`);
      return {
        migrationId: "mig-op-1",
        slug,
        ready: true,
        checks: { customerDir: true, coachWired: true, mountMarked: true },
      };
    }) as MigrationClient["verifyTarget"],
    unmount: vi.fn(async ({ gatewayId, slug }) => {
      calls.push(`unmount:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, unmounted: true };
    }) as MigrationClient["unmount"],
    calls,
  } as MigrationClient & { calls: string[] };
}

interface HarnessOptions {
  client?: MigrationClient & { calls: string[] };
  durable?: boolean;
  sourceGatewayId?: string;
}

function mkDeps(options: HarnessOptions = {}) {
  const client = options.client ?? happyClient();
  const events: string[] = [];
  const persisted: Array<NonNullable<Operation["userMigrationV2"]>> = [];
  const transfers = new Map<string, ScheduleTransferDoc>();
  const setMigrationPhase = vi.fn<NonNullable<MigrateUserDeps["setMigrationPhase"]>>(async () => undefined);
  const deps: MigrateUserDeps = {
    readScheduleTransfer: vi.fn(async (uid: string, migrationId: string) => structuredClone(transfers.get(`${uid}/${migrationId}`)) ?? null),
    saveScheduleTransfer: vi.fn(async (uid: string, doc: ScheduleTransferDoc) => {
      transfers.set(`${uid}/${doc.migrationId}`, structuredClone(doc));
      events.push(`schedules-saved:${uid}/${doc.migrationId}`);
    }),
    recordScheduleRestore: vi.fn(async (uid: string, migrationId: string, restore) => {
      transfers.set(`${uid}/${migrationId}`, { ...transfers.get(`${uid}/${migrationId}`)!, ...restore });
      events.push(`schedules-restored:${uid}/${migrationId}:${restore.restoredTo}`);
    }),
    readUser: vi.fn(async () => ({
      slug: "alice",
      currentGatewayId: options.sourceGatewayId ?? "gw-blue",
    })),
    readUserSnapshot: vi.fn(async () => SNAPSHOT),
    prepareNativeVmReturn: vi.fn(async () => null),
    retireNativeSchedulerBeforeStage: vi.fn(async () => undefined),
    readOperation: vi.fn(async () => null),
    readUserAgentIds: vi.fn(async () => []),
    readGatewaySystemConfigCommit: vi.fn(async () => TARGET_SYSTEM_CONFIG_COMMIT),
    readOpenClawBuild: vi.fn(async () => "d".repeat(40)),
    commitCutover: vi.fn(async (commit) => {
      events.push(`cutover:${commit.fromGatewayId}->${commit.toGatewayId}:mirror=${commit.flipMirror}`);
    }),
    resolveGatewayUrl: vi.fn(async (gatewayId: string) => `http://${gatewayId}.svc:3003`),
    reportMigrationProgress: vi.fn(async () => undefined),
    recordMigrationProgress: vi.fn(async () => undefined),
    buildClient: vi.fn(() => client),
    assertMigrationRecoveryAuthority: vi.fn(async () => undefined),
    assertMigrationSourcePreparationAuthority: vi.fn(async () => undefined),
    setMigrationPhase,
    completeMigrationRecovery: vi.fn(async () => undefined),
    prepareIsolatedRecoveryTarget: vi.fn(async () => undefined),
    prepareMigrationAgentStores: vi.fn(async () => undefined),
    resolveSourcePlacement: vi.fn(async () => ({
      release: 1,
      epoch: 4,
      assignmentMode: "assigned" as const,
    })),
    resolveTargetPlacement: vi.fn(async () => ({ ok: true as const, release: 2, gatewayClass: "shared" as const })),
    setAssignmentState: vi.fn(async (input) => {
      events.push(`assignment:${input.gatewayId}:${input.state}`);
    }),
    readGatewayRootFence: vi.fn(async (gatewayId: string) => gatewayRootFence(
      gatewayId,
      gatewayId === "gw-blue" ? 1 : 2,
    )),
    commitV2Cutover: vi.fn(async (input) => {
      events.push(`v2-cutover:${input.sourceGatewayId}->${input.targetGatewayId}`);
    }),
    useDurableMigration: vi.fn(async () => options.durable === true),
    findPreemptedVm: vi.fn(async () => null),
    genMigrationId: (operationId: string) => `mig-${operationId}`,
    now: vi.fn(() => 5_000),
    sleep: vi.fn(async () => undefined),
    log: vi.fn(),
  };
  const steps: OperationStep[] = [];
  const ctx: OperationContext = {
    assertActiveClaim: vi.fn(async () => undefined),
    persistSchedulerHandoff: vi.fn(async () => undefined),
    persistCutoverCommitted: vi.fn(async (at: number) => {
      events.push(`cutover-recorded:${at}`);
    }),
    reportStep: vi.fn(async (step: OperationStep) => {
      steps.push(step);
    }),
    persistUserMigrationV2: vi.fn(async (state) => {
      persisted.push(state);
    }),
  } as unknown as OperationContext;
  return { deps, ctx, client, events, steps, persisted, transfers, setMigrationPhase };
}

function tickingClock(h: ReturnType<typeof mkDeps>): void {
  let clock = 5_000;
  vi.mocked(h.deps.now).mockImplementation(() => clock);
  vi.mocked(h.deps.sleep).mockImplementation(async (ms: number) => { clock += ms; });
}

function freshUserFromSharedGateway(h: ReturnType<typeof mkDeps>, commits: Array<string | null>): void {
  tickingClock(h);
  vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, gatewayClass: "shared" });
  vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "isolated" });
  vi.mocked(h.client.flushGateway).mockImplementation(async ({ migrationId, slug }) => ({ migrationId, slug, ok: true, durationMs: 1, steps: [] }));
  const commitCutover = vi.mocked(h.deps.commitCutover).getMockImplementation()!;
  vi.mocked(h.deps.commitCutover).mockImplementation(async (commit) => {
    await commitCutover(commit);
    vi.mocked(h.deps.readUser).mockResolvedValue({ slug: "alice", currentGatewayId: commit.toGatewayId });
  });
  const reads = vi.mocked(h.deps.readGatewaySystemConfigCommit).mockResolvedValue(commits.at(-1)!);
  for (const commit of commits.slice(0, -1)) reads.mockResolvedValueOnce(commit);
}

function loseClaimDuringCommitRead(h: ReturnType<typeof mkDeps>): void {
  vi.mocked(h.deps.readGatewaySystemConfigCommit).mockImplementation(async () => {
    vi.mocked(h.ctx.assertActiveClaim!).mockRejectedValue(new Error("operation op-1 claim lost"));
    return TARGET_SYSTEM_CONFIG_COMMIT;
  });
}

function targetConvergeRequests(h: ReturnType<typeof mkDeps>) {
  return vi.mocked(h.client.flushGateway).mock.calls.map(([request]) => request).filter((request) => request.gatewayId === "gw-green");
}

function mockNativeReturn(checkpointRequested = false) {
  return {
    checkpointRequested,
    requestCheckpoint: vi.fn(async () => {}),
    awaitCheckpoint: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    releaseWriterHold: vi.fn(async () => {}),
    sourceVmStatus: vi.fn(async (): Promise<string | null> => "RUNNING"),
    park: vi.fn(async (park: NativeSourcePark): Promise<NativeReturnPark> =>
      park.mode === "suspend" ? { parked: "suspended" } : { parked: "stopped", stopReason: park.reason }),
    acknowledgeCompletedSchedulerHandoff: vi.fn(async () => {}),
  };
}

describe("previous native return cleanup ownership", () => {
  const privateKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it.each(["acknowledged", "unready", "retargeted", "abort-failed", "abort-mismatch", "unmount-failed", "unmount-mismatch", "claim-lost", "owner-changed", "missing-preparer", "source-url-claim-lost", "scheduler-owner-changed", "ingress-claim-lost", "target-url-claim-lost"] as const)("cleans the old Shared import before source resume can reclaim PostgreSQL ownership: %s", async scenario => {
    const source = "builder-alice", target = "shared-green";
    const h = mkDeps({ sourceGatewayId: source });
    const native = mockNativeReturn();
    h.deps.prepareNativeVmReturn = vi.fn(async () => native);
    const events: string[] = [];
    let targetDetached = false;
    let owner = "shared", claimLost = false, ownerChanged = false;
    h.ctx.assertActiveClaim = vi.fn(async () => { if (claimLost) throw new Error("fixture operation claim lost"); });
    h.deps.readUser = vi.fn(async () => ({ slug: "alice", currentGatewayId: ownerChanged ? "foreign-user" : source }));
    const prepareAgentStores = vi.fn(async (gatewayId: string, slug: string) => {
      expect(slug).toBe("alice");
      events.push(`ownership:${gatewayId}`);
      if (gatewayId === source) owner = "builder";
    });
    h.deps.prepareMigrationAgentStores = scenario === "missing-preparer" ? undefined : vi.fn(async (gatewayId, slug, authority) => {
      expect(authority?.expectedUserUid).toBe("uid-alice");
      await authority?.assertCurrent();
      await prepareAgentStores(gatewayId, slug);
      await authority?.assertCurrent();
    });
    const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body)) as { migrationId: string; slug: string; mode?: string; phase?: string };
      const reply = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
      if (url.pathname.startsWith("/scheduler/")) {
        events.push(`scheduler:${url.pathname.endsWith(target) ? target : source}:${body.phase}`);
        if (url.pathname.endsWith(source) && body.phase === "resume") {
          if (owner !== "builder") return reply({ error: "source scheduler cannot read foreign PostgreSQL stores" }, 500);
          ownerChanged = scenario === "scheduler-owner-changed";
        }
        return reply({ operationId: body.migrationId, phase: body.phase, agentIds: [], drained: true });
      }
      if (url.pathname.startsWith("/abort-rsync-import/")) {
        events.push(`abort:${body.mode}`);
        if (scenario === "abort-failed") return reply({ error: "import cleanup failed" }, 500);
        return reply({ migrationId: scenario === "abort-mismatch" ? "foreign-import" : body.migrationId, slug: body.slug, imported: false });
      }
      if (url.pathname.startsWith("/unmount/")) {
        events.push("unmount");
        if (owner !== "shared") return reply({ error: "permission denied for canonical agent schema" }, 500);
        if (scenario === "unmount-failed") return reply({ error: "Native detach incomplete" }, 500);
        targetDetached = true;
        claimLost = scenario === "claim-lost";
        ownerChanged = scenario === "owner-changed";
        return reply({ migrationId: scenario === "unmount-mismatch" ? "foreign-import" : body.migrationId, slug: body.slug, unmounted: true });
      }
      if (url.pathname.startsWith("/resume/")) {
        events.push("resume");
        if (!targetDetached) return reply({ error: "source resumed before old target cleanup" }, 500);
        claimLost = scenario === "ingress-claim-lost";
        return reply({ resumed: true });
      }
      throw new Error(`unexpected migration RPC ${url.pathname}`);
    });
    const transferState = vi.fn<MigrationClient["transferState"]>();
    h.deps.buildClient = resolveGatewayUrl => createMigrationClient({ privateKey, resolveGatewayUrl, fetch, prepareAgentStores, transferState });
    h.deps.resolveGatewayUrl = vi.fn(async (gatewayId, options) => {
      if (scenario === "unready" && gatewayId === target && options?.allowUnready !== true) throw new Error("old Shared target requires its exact recovery transport");
      if (gatewayId === source && scenario === "source-url-claim-lost" || gatewayId === target && scenario === "target-url-claim-lost") claimLost = true;
      return `http://${gatewayId}.fixture:3003`;
    });
    h.deps.resolveSourcePlacement = vi.fn(async () => { throw new Error("fixture forward boundary reached"); });
    const operation = mkOp({ attempts: 21, input: { uid: "uid-alice", userSlug: "alice", fromGatewayId: source, toGatewayId: scenario === "retargeted" ? "shared-new" : target, source: "builder-activation-lease" },
      schedulerHandoff: { migrationId: "mig-op-1:scheduler:21:claim:1000", uid: "uid-alice", slug: "alice", fromGatewayId: source, toGatewayId: target } });
    const result = await createMigrateUserHandler(h.deps)(operation, h.ctx);
    if (scenario === "acknowledged" || scenario === "unready" || scenario === "retargeted") {
      expect(events).toEqual([`scheduler:${target}:abort`, "abort:keys", "abort:pre", "abort:final", "unmount", `ownership:${source}`, `scheduler:${source}:resume`, `ownership:${source}`, "resume"]);
      expect(result).toMatchObject({ success: false, error: "fixture forward boundary reached" });
      expect(h.deps.resolveSourcePlacement).toHaveBeenCalledOnce();
    } else {
      expect(result.success).toBe(false);
      if (["source-url-claim-lost", "scheduler-owner-changed", "ingress-claim-lost"].includes(scenario)) {
        expect(prepareAgentStores).toHaveBeenCalledTimes(scenario === "ingress-claim-lost" ? 2 : 1);
        if (scenario === "source-url-claim-lost") expect(events).not.toContain(`scheduler:${source}:resume`);
        if (scenario !== "ingress-claim-lost") expect(events).not.toContain("resume");
      } else {
        expect(prepareAgentStores).not.toHaveBeenCalled();
        if (scenario === "target-url-claim-lost") expect(fetch).not.toHaveBeenCalled();
        expect(events).not.toContain(`scheduler:${source}:resume`);
        expect(events).not.toContain("resume");
      }
      expect(h.deps.resolveSourcePlacement).not.toHaveBeenCalled();
    }
    expect(h.deps.resolveGatewayUrl).toHaveBeenCalledWith(target, { allowUnready: true });
    expect(transferState).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
  });
});

describe("PostgreSQL agent context transfer", () => {
  it.each(["pristine", "released", "claim-lost", "authority-lost", "missing-preparer"] as const)("restores Shared database access before resolving source readiness: %s", async scenario => {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, epoch: 4, assignmentMode: "assigned", gatewayClass: "shared" });
    const op = mkOp({ input: { uid: "uid-alice", fromGatewayId: "shared-blue", toGatewayId: "gw-green" } });
    if (scenario === "released") Object.assign(op, {
      schedulerHandoff: { migrationId: "mig-op-1:scheduler:1:claim:1000", fromGatewayId: "shared-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" },
      schedulerHandoffReleased: true, schedulerHandoffReleasedAt: 3000,
    });
    let prepared = false, lost = false;
    const order: string[] = [];
    h.ctx.assertActiveClaim = vi.fn(async () => { if (lost && scenario === "claim-lost") throw new Error("source preparation claim changed"); });
    h.deps.assertMigrationSourcePreparationAuthority = vi.fn(async params => {
      expect(params).toEqual({ uid: "uid-alice", slug: "alice", sourceGatewayId: "shared-blue", targetGatewayId: "gw-green", sourceEpoch: 4, operationId: "op-1", claimStartedAt: 4000 });
      if (lost && scenario === "authority-lost") throw new Error("source preparation placement changed");
    });
    h.deps.prepareMigrationAgentStores = scenario === "missing-preparer" ? undefined : vi.fn(async (gatewayId, slug, authority) => {
      expect([gatewayId, slug, authority?.expectedUserUid]).toEqual(["shared-blue", "alice", "uid-alice"]);
      await authority?.assertCurrent();
      prepared = true; lost = true; order.push("ownership");
    });
    h.deps.resolveGatewayUrl = vi.fn(async gatewayId => {
      if (gatewayId === "shared-blue") {
        if (!prepared) throw new Error("source readiness blocked by agent-store permissions");
        order.push("source-ready");
      }
      return `http://${gatewayId}.svc:3003`;
    });
    const result = await createMigrateUserHandler(h.deps)(op, h.ctx);
    if (scenario === "pristine" || scenario === "released") {
      expect(result).toMatchObject({ success: true });
      expect(order.slice(0, 2)).toEqual(["ownership", "source-ready"]);
      expect(h.deps.setMigrationPhase).toHaveBeenCalledWith({ uid: "uid-alice", sourceGatewayId: "shared-blue", operationId: "op-1", phase: "preparing" });
    } else {
      expect(result.success).toBe(false);
      expect(h.deps.resolveGatewayUrl).not.toHaveBeenCalled();
      expect(h.client.transferState).not.toHaveBeenCalled();
    }
  });

  it("does not reclaim Shared stores during an admitted current handoff", async () => {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, epoch: 4, assignmentMode: "assigned", gatewayClass: "shared" });
    const op = mkOp({ input: { uid: "uid-alice", fromGatewayId: "shared-blue", toGatewayId: "gw-green" },
      schedulerHandoff: { migrationId: "mig-op-1:scheduler:1:claim:4000", fromGatewayId: "shared-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" } });
    expect(await createMigrateUserHandler(h.deps)(op, h.ctx)).toMatchObject({ success: true });
    expect(h.deps.prepareMigrationAgentStores).not.toHaveBeenCalled();
    expect(h.deps.assertMigrationSourcePreparationAuthority).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses the current store without selecting an archived context (durable=%s)", async durable => {
    const h = mkDeps({ durable });
    expect(await createMigrateUserHandler(h.deps)(mkOp({ startedAt: 4000 }), h.ctx)).toMatchObject({ success: true });
    expect(h.client.transferState).toHaveBeenCalledWith(expect.objectContaining({ mode: "final" }));
  });
});

describe("abandoned Shared migration recovery", () => {
  it.each(["success", "missing-callback", "ownership-failed", "authority-lost", "claim-lost", "missing-claim", "cleanup-failed"] as const)("prepares source store ownership before recovery scheduler resume: %s", async scenario => {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    const handoff = { migrationId: "mig-op-1:scheduler:1:claim:1000", fromGatewayId: "shared-blue", toGatewayId: "shared-green",
      uid: "uid-alice", slug: "alice", stageAfterCutover: true as const,
      sourceRecovery: { migrationId: "mig-op-1:scheduler:1:claim:1000", sourceEpoch: 4, steps: [{ name: "quiesce-source", status: "done" as const }] } };
    const request = mkOp({ input: { uid: "uid-alice", fromGatewayId: "shared-blue", toGatewayId: "shared-green", recoverSourceOnly: true }, schedulerHandoff: handoff, attempts: 1 });
    const order: string[] = [];
    let prepared = false, authorityLost = false, claimLost = false;
    h.deps.assertMigrationRecoveryAuthority = vi.fn(async () => { if (authorityLost) throw new Error("recovery authority changed after ownership await"); });
    vi.mocked(h.deps.resolveGatewayUrl).mockImplementation(async gatewayId => {
      if (gatewayId === "shared-blue" && !prepared) throw new Error("source runtime is not ready until store ownership is restored");
      return `http://${gatewayId}.svc:3003`;
    });
    h.ctx.assertActiveClaim = scenario === "missing-claim" ? undefined : vi.fn(async () => { if (claimLost) throw new Error("operation claim replaced after ownership await"); });
    h.client.abortImport = vi.fn(async ({ mode }) => { order.push(`abort:${mode}`); });
    vi.mocked(h.client.unmount).mockImplementation(async ({ migrationId, slug }) => {
      order.push("unmount");
      if (scenario === "cleanup-failed") throw new Error("target cleanup incomplete");
      return { migrationId, slug, unmounted: true };
    });
    const prepare = vi.fn<NonNullable<MigrateUserDeps["prepareMigrationAgentStores"]>>(async (gatewayId, slug, authority) => {
      expect(gatewayId).toBe("shared-blue"); expect(slug).toBe("alice");
      expect(authority?.expectedUserUid).toBe("uid-alice");
      expect(authority?.assertCurrent).toBeTypeOf("function");
      await authority?.assertCurrent();
      order.push("ownership");
      if (scenario === "ownership-failed") throw new Error("ownership transfer refused");
      prepared = true;
      authorityLost = scenario === "authority-lost"; claimLost = scenario === "claim-lost";
    });
    h.deps.prepareMigrationAgentStores = scenario === "missing-callback" ? undefined : prepare;
    h.client.scheduler = vi.fn(async ({ migrationId, phase }) => {
      order.push(`scheduler:${phase}`);
      if (!prepared) throw new Error("permission denied for source agent schema");
      return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true };
    });
    h.client.resume = vi.fn(async () => { order.push("resume"); });
    h.deps.completeMigrationRecovery = vi.fn(async () => { order.push("complete"); });
    const result = await createMigrateUserHandler(h.deps)(request, h.ctx);
    if (scenario === "success") {
      expect(result, JSON.stringify(result)).toMatchObject({ success: false, rolledBack: true });
      expect(order).toEqual(["abort:keys", "abort:pre", "abort:final", "unmount", "ownership", "scheduler:resume", "resume", "complete"]);
      expect(prepare).toHaveBeenCalledOnce();
    } else {
      expect(result.rolledBack).not.toBe(true);
      expect(h.client.scheduler).not.toHaveBeenCalled();
      expect(h.client.resume).not.toHaveBeenCalled();
      expect(h.deps.completeMigrationRecovery).not.toHaveBeenCalled();
      if (["missing-callback", "missing-claim", "cleanup-failed"].includes(scenario)) expect(prepare).not.toHaveBeenCalled();
      else expect(prepare).toHaveBeenCalledOnce();
    }
    expect(h.client.transferState).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
  });

  it.each(["success", "resume-failure", "authority-failure", "ownership-changed", "never-quiesced", "controller-restart"])("restores a pre-cutover user activation through the existing source-only worker: %s", async (scenario) => {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    const target = "alice-s-12345678";
    const id = `builder-activate-${target}-g1`;
    const request = mkOp({ id, status: "running", startedAt: 4_000, attempts: 1,
      input: { uid: "uid-alice", userSlug: "alice", fromGatewayId: "shared-blue", toGatewayId: target, source: "builder-activation-lease", recoverSourceOnly: true },
      schedulerHandoff: { migrationId: `mig-${id}:scheduler:1:claim:1000`, fromGatewayId: "shared-blue", toGatewayId: target, uid: "uid-alice", slug: "alice", stageAfterCutover: true },
    });
    const sourceRecovery: NonNullable<NonNullable<Operation["schedulerHandoff"]>["sourceRecovery"]> = { migrationId: request.schedulerHandoff!.migrationId, sourceEpoch: 4, steps: [{ name: "quiesce-source", status: "done" }] };
    request.schedulerHandoff!.sourceRecovery = sourceRecovery;
    if (scenario === "controller-restart") {
      delete request.input.recoverSourceOnly;
      delete request.schedulerHandoff!.sourceRecovery;
      h.client.abortImport = vi.fn().mockRejectedValue(new Error("live worker unavailable"));
      h.client.unmount = vi.fn(async ({ slug, migrationId }) => ({ migrationId, slug, unmounted: true }));
    }
    if (scenario === "resume-failure") h.client.resume = vi.fn().mockRejectedValue(new Error("native resume refused"));
    if (scenario === "authority-failure") h.deps.assertMigrationRecoveryAuthority = vi.fn().mockRejectedValue(new Error("authority changed"));
    if (scenario === "ownership-changed") h.deps.assertMigrationRecoveryAuthority = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error("authority changed during target cleanup"));
    if (scenario === "never-quiesced") {
      request.attemptHistory = [{ attempt: 1, startedAt: 1_000, completedAt: 2_000, error: "keys failed", classification: "transient", steps: [{ name: "keys-sync-state", status: "failed" }] }];
      sourceRecovery.steps = request.attemptHistory[0].steps;
      h.client.resume = vi.fn().mockRejectedValue(new Error("foreign voice hold"));
    }
    const result = await createMigrateUserHandler(h.deps)(request, h.ctx);
    expect(result.success).toBe(false);
    expect(h.client.transferState).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    if (scenario === "success" || scenario === "never-quiesced" || scenario === "controller-restart") {
      expect(result.rolledBack).toBe(true);
      expect(h.deps.resolveGatewayUrl).toHaveBeenCalledWith(target, { allowUnready: true });
      expect(h.client.abortImport).not.toHaveBeenCalled();
      expect(h.client.unmount).toHaveBeenCalledOnce();
      if (scenario !== "never-quiesced") expect(h.client.resume).toHaveBeenCalledOnce();
      else expect(h.client.resume).not.toHaveBeenCalled();
      expect(h.deps.completeMigrationRecovery).toHaveBeenCalledOnce();
      expect(h.steps).toContainEqual(expect.objectContaining({ name: "recover-source", status: "done" }));
    } else {
      expect(h.deps.completeMigrationRecovery).not.toHaveBeenCalled();
      if (scenario === "authority-failure" || scenario === "ownership-changed") expect(h.client.resume).not.toHaveBeenCalled();
    }
  });
  it.each(["reserved", "missing-callback", "authority-lost", "scheduler-first", "scheduler-failed", "terminal-changed"] as const)("reserves an abandoned isolated target before source-only cleanup: %s", async scenario => {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    const target = "alice-m-12345678", id = `builder-activate-${target}-g1`;
    const op = mkOp({ id, status: "running", startedAt: 4_000, attempts: 1,
      input: { uid: "uid-alice", userSlug: "alice", fromGatewayId: "shared-blue", toGatewayId: target, source: "builder-activation-lease", recoverSourceOnly: true },
      schedulerHandoff: { migrationId: `mig-${id}:scheduler:1:claim:1000`, fromGatewayId: "shared-blue", toGatewayId: target,
        uid: "uid-alice", slug: "alice", stageAfterCutover: true },
    });
    op.schedulerHandoff!.sourceRecovery = { migrationId: op.schedulerHandoff!.migrationId, sourceEpoch: 4,
      steps: [{ name: "quiesce-source", status: "done" }] };
    if (scenario.startsWith("scheduler-")) delete op.schedulerHandoff!.stageAfterCutover;
    const events: string[] = [];
    h.client.scheduler = vi.fn(async ({ migrationId, phase }) => {
      events.push(`scheduler:${phase}`);
      if (scenario === "scheduler-failed" && phase === "abort") throw new Error("scheduler abort unavailable");
      return { operationId: migrationId, phase, agentIds: [], drained: true };
    });
    const originalUnmount = h.client.unmount;
    h.client.unmount = vi.fn(async request => {
      if (!reserved || scenario === "terminal-changed") throw new Error("User import cleanup has no matching target reservation");
      events.push("unmount");
      return originalUnmount(request);
    });
    let reserved = false;
    const reserve = vi.fn(async () => { events.push("reserve"); reserved = true; });
    h.deps.prepareIsolatedRecoveryTarget = scenario === "missing-callback" ? undefined : reserve;
    h.deps.assertMigrationRecoveryAuthority = vi.fn(async () => {
      events.push("authority");
      if (scenario === "authority-lost" && reserved) throw new Error("authority changed after reservation");
    });
    const result = await createMigrateUserHandler(h.deps)(op, h.ctx);
    if (scenario === "reserved") {
      expect(result, JSON.stringify(result)).toMatchObject({ success: false, rolledBack: true });
      expect(reserve).toHaveBeenCalledExactlyOnceWith({ recovery: { uid: "uid-alice", sourceGatewayId: "shared-blue", operationId: id, sourceEpoch: 4, claimStartedAt: 4_000 },
        targetGatewayId: target, migrationId: `mig-${id}`, slug: "alice" });
      expect(events.filter(event => event !== "authority")).toEqual(["reserve", "unmount", "scheduler:resume"]);
      expect(h.deps.prepareMigrationAgentStores).toHaveBeenNthCalledWith(1, target, "alice", expect.objectContaining({ expectedUserUid: "uid-alice" }));
      expect(h.deps.completeMigrationRecovery).toHaveBeenCalledOnce();
    } else {
      expect(result.rolledBack).not.toBe(true);
      expect(h.client.abortImport).not.toHaveBeenCalled();
      if (scenario.startsWith("scheduler-")) {
        expect(reserve).not.toHaveBeenCalled();
        expect(events).toEqual(["scheduler:abort"]);
      }
      expect(h.client.resume).not.toHaveBeenCalled();
      expect(h.deps.completeMigrationRecovery).not.toHaveBeenCalled();
    }
  });

  it.each(["handed-back", "authority-lost", "claim-lost"] as const)("hands the carried stores to the user's user for target cleanup and back to the source before it resumes: %s", async scenario => {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    const target = "alice-m-12345678", id = `builder-activate-${target}-g1`;
    const op = mkOp({ id, status: "running", startedAt: 4_000, attempts: 1,
      input: { uid: "uid-alice", userSlug: "alice", fromGatewayId: "shared-blue", toGatewayId: target, source: "builder-activation-lease", recoverSourceOnly: true },
      schedulerHandoff: { migrationId: `mig-${id}:scheduler:1:claim:1000`, fromGatewayId: "shared-blue", toGatewayId: target,
        uid: "uid-alice", slug: "alice", stageAfterCutover: true },
    });
    op.schedulerHandoff!.sourceRecovery = { migrationId: op.schedulerHandoff!.migrationId, sourceEpoch: 4,
      steps: [{ name: "quiesce-source", status: "done" }] };
    const events: string[] = [];
    let owner = "shared-blue", changed = false;
    vi.mocked(h.deps.resolveGatewayUrl).mockImplementation(async (gatewayId, options) => {
      if (gatewayId === target && options?.allowUnready) changed = scenario !== "handed-back";
      return `http://${gatewayId}.svc:3003`;
    });
    h.deps.assertMigrationRecoveryAuthority = vi.fn(async () => { if (changed && scenario === "authority-lost") throw new Error("recovery authority changed during target cleanup"); });
    h.ctx.assertActiveClaim = vi.fn(async () => { if (changed && scenario === "claim-lost") throw new Error("operation re-claimed during target cleanup"); });
    h.deps.prepareIsolatedRecoveryTarget = vi.fn(async () => { events.push("reserve"); });
    h.deps.prepareMigrationAgentStores = vi.fn(async (gatewayId, slug, authority) => {
      expect({ slug, uid: authority?.expectedUserUid }).toEqual({ slug: "alice", uid: "uid-alice" });
      await authority!.assertCurrent();
      owner = gatewayId;
      events.push(`stores:${gatewayId}`);
    });
    const unmount = h.client.unmount;
    h.client.unmount = vi.fn(async request => {
      if (owner !== target) throw new Error("PostgreSQL search capability unavailable: insufficient CREATE privilege");
      events.push(`unmount:${request.gatewayId}`);
      return unmount(request);
    });
    const resume = h.client.resume;
    h.client.resume = vi.fn(async request => {
      if (owner !== "shared-blue") throw new Error("source resumed without its stores");
      events.push("resume");
      return resume(request);
    });

    const result = await createMigrateUserHandler(h.deps)(op, h.ctx);

    if (scenario === "handed-back") {
      expect(result, JSON.stringify(result)).toMatchObject({ success: false, rolledBack: true });
      expect(events).toEqual(["reserve", `stores:${target}`, `unmount:${target}`, "stores:shared-blue", "resume"]);
      expect(h.deps.completeMigrationRecovery).toHaveBeenCalledOnce();
    } else {
      expect(result.rolledBack).not.toBe(true);
      expect(events).toEqual(["reserve", `stores:${target}`]);
      expect(h.client.scheduler).not.toHaveBeenCalled();
      expect(h.client.resume).not.toHaveBeenCalled();
      expect(h.deps.completeMigrationRecovery).not.toHaveBeenCalled();
    }
  });

  const previous = { migrationId: "mig-op-1:scheduler:1:claim:1000", fromGatewayId: "shared-blue", toGatewayId: "shared-green", uid: "uid-alice", slug: "alice" };
  function recovery() {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    return h;
  }
  const op = () => mkOp({ status: "running", startedAt: 4_000, schedulerHandoff: previous, attempts: 1, input: { uid: "uid-alice", fromGatewayId: "shared-blue", toGatewayId: "shared-green" } });
  it.each(["missing", "foreign-id", "changed-epoch", "history-evicted"])("requires exact durable recovery intent before native mutation: %s", async (scenario) => {
    const h = recovery();
    const request = op();
    request.input.recoverSourceOnly = true;
    const steps: OperationStep[] = [{ name: "keys-sync-state", status: "done" }, { name: "pre-sync-state", status: "failed", error: "agent database files are still held open: /state/agent.sqlite" }, { name: "rollback:unmount-target", status: "failed" }];
    request.schedulerHandoff = { ...previous, sourceRecovery: { migrationId: previous.migrationId, sourceEpoch: 4, steps } };
    if (scenario === "missing") delete request.schedulerHandoff.sourceRecovery;
    if (scenario === "foreign-id") request.schedulerHandoff.sourceRecovery!.migrationId = "mig-other:scheduler:1:claim:1000";
    if (scenario === "changed-epoch") request.schedulerHandoff.sourceRecovery!.sourceEpoch = 3;
    request.attemptHistory = Array.from({ length: 20 }, (_, index) => ({ attempt: 4 + index, startedAt: 1_000, completedAt: 2_000, error: "cleanup failed", classification: "terminal", steps: [] }));
    vi.mocked(h.client.resume).mockRejectedValue(new Error("foreign voice hold"));
    const result = await createMigrateUserHandler(h.deps)(request, h.ctx);
    expect(result.rolledBack === true).toBe(scenario === "history-evicted");
    expect(h.client.resume).not.toHaveBeenCalled();
    if (scenario !== "history-evicted") {
      expect(h.client.abortImport).not.toHaveBeenCalled();
      expect(h.client.unmount).not.toHaveBeenCalled();
      expect(h.client.scheduler).not.toHaveBeenCalled();
    }
  });
  it.each([
    ["failed in pre-sync before any quiesce", [{ name: "keys-sync-state", status: "done" }, { name: "pre-sync-state", status: "failed" }, { name: "rollback:unmount-gateway", status: "done" }]],
    ["failed its pre-drain probe", [{ name: "keys-sync-state", status: "done" }, { name: "pre-sync-state", status: "done" }, { name: "target-scheduler-ready", status: "done" }, { name: "wait-for-active-work", status: "failed" }, { name: "rollback:unmount-gateway", status: "done" }]],
    ["skipped its quiesce", [{ name: "keys-sync-state", status: "done" }, { name: "quiesce-source", status: "skipped" }, { name: "pre-sync-state", status: "failed" }]],
    ["never started its quiesce", [{ name: "keys-sync-state", status: "done" }, { name: "quiesce-source", status: "pending" }]],
  ] as const)("retries a move whose previous attempt %s without demanding recovery authority or touching the source", async (_label, steps) => {
    const h = recovery();
    const request = op();
    request.attemptHistory = [{ attempt: 1, startedAt: 1_000, completedAt: 2_000,
      error: "/push-rsync-state/shared-blue: 500 Timed out waiting for an OpenClaw runtime update",
      classification: "transient",
      steps: [...steps],
    }];
    h.deps.assertMigrationRecoveryAuthority = vi.fn().mockRejectedValue(new Error("workspace migration recovery authority changed"));

    expect(await createMigrateUserHandler(h.deps)(request, h.ctx)).toMatchObject({ success: true });

    expect(h.deps.assertMigrationRecoveryAuthority).not.toHaveBeenCalled();
    expect(h.deps.completeMigrationRecovery).not.toHaveBeenCalled();
    expect(h.client.abortImport).toHaveBeenCalledTimes(3);
    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "shared-green" }));
    expect(h.client.scheduler).not.toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "shared-blue", phase: "resume" }));
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.client.transferState).toHaveBeenCalled();
  });

  it("releases source ingress, without recovery authority, when the previous attempt died after its probe acquired the hold", async () => {
    const h = recovery();
    const request = op();
    request.attemptHistory = [{ attempt: 1, startedAt: 1_000, completedAt: 2_000, error: "controller restarted", classification: "transient",
      steps: [{ name: "keys-sync-state", status: "done" }, { name: "pre-sync-state", status: "done" }, { name: "wait-for-active-work", status: "done" }],
    }];
    h.deps.assertMigrationRecoveryAuthority = vi.fn().mockRejectedValue(new Error("workspace migration recovery authority changed"));

    expect(await createMigrateUserHandler(h.deps)(request, h.ctx)).toMatchObject({ success: true });

    expect(h.deps.assertMigrationRecoveryAuthority).not.toHaveBeenCalled();
    expect(h.client.resume).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "shared-blue" }));
    expect(h.client.scheduler).not.toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "shared-blue", phase: "resume" }));
  });

  it("still demands recovery authority when the previous attempt held the source", async () => {
    const h = recovery();
    const request = op();
    request.attemptHistory = [{ attempt: 1, startedAt: 1_000, completedAt: 2_000, error: "flush failed", classification: "transient",
      steps: [{ name: "keys-sync-state", status: "done" }, { name: "quiesce-source", status: "done" }, { name: "flush-source", status: "failed" }],
    }];
    h.deps.assertMigrationRecoveryAuthority = vi.fn().mockRejectedValue(new Error("workspace migration recovery authority changed"));

    expect(await createMigrateUserHandler(h.deps)(request, h.ctx)).toMatchObject({ success: false });

    expect(h.deps.assertMigrationRecoveryAuthority).toHaveBeenCalledOnce();
    expect(h.client.transferState).not.toHaveBeenCalled();
  });

  it("aborts all old imports and the target before reopening native source ingress and publishing recovery", async () => {
    const h = recovery();
    const order: string[] = [];
    vi.mocked(h.client.abortImport).mockImplementation(async ({ mode }) => { order.push(`abort:${mode}`); });
    vi.mocked(h.client.unmount).mockImplementation(async ({ gatewayId, migrationId, slug }) => { order.push(`unmount:${gatewayId}`); return { migrationId, slug, unmounted: true }; });
    vi.mocked(h.client.resume).mockImplementation(async () => { order.push("resume"); });
    vi.mocked(h.deps.completeMigrationRecovery!).mockImplementation(async (input) => {
      expect(order).toEqual(["abort:keys", "abort:pre", "abort:final", "unmount:shared-green", "resume"]);
      expect(input).toMatchObject({ sourceEpoch: 4, claimStartedAt: 4_000, operationId: "op-1" });
      order.push("published");
    });
    expect(await createMigrateUserHandler(h.deps)(op(), h.ctx)).toMatchObject({ success: true });
    expect(h.client.abortImport).toHaveBeenCalledTimes(3);
    expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledWith(expect.objectContaining({ migrationId: "mig-op-1:scheduler:2:claim:4000" }));
  });
  it.each(["authority", "abort", "unmount", "resume", "publish"])("does not start a fresh transfer after %s recovery failure", async (step) => {
    const h = recovery();
    const fail = vi.fn(async () => { throw new Error("recovery refused"); });
    if (step === "authority") h.deps.assertMigrationRecoveryAuthority = fail;
    if (step === "abort") h.client.abortImport = fail;
    if (step === "unmount") h.client.unmount = fail;
    if (step === "resume") h.client.resume = fail;
    if (step === "publish") h.deps.completeMigrationRecovery = fail;
    expect(await createMigrateUserHandler(h.deps)(op(), h.ctx)).toMatchObject({ success: false });
    expect(h.client.transferState).not.toHaveBeenCalled();
    expect(h.ctx.persistSchedulerHandoff).not.toHaveBeenCalled();
    if (step !== "publish") expect(h.deps.completeMigrationRecovery).not.toHaveBeenCalled();
  });
  it("finishes boot recovery as a rollback rather than retrying the abandoned target", async () => {
    const h = recovery();
    const request = op();
    request.input.recoverSourceOnly = true;
    request.schedulerHandoff = { ...previous, sourceRecovery: { migrationId: previous.migrationId, sourceEpoch: 4, steps: [{ name: "quiesce-source", status: "done" }] } };
    expect(await createMigrateUserHandler(h.deps)(request, h.ctx)).toMatchObject({ success: false, rolledBack: true, error: "abandoned Shared migration rolled back; native source recovery completed" });
    expect(h.client.transferState).not.toHaveBeenCalled();
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.client.verifyTarget).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    expect(h.steps).toContainEqual(expect.objectContaining({ name: "recover-source", status: "done" }));
  });
  it("resumes the source without contacting a removed target whose cleanup already completed", async () => {
    const h = recovery();
    const request = op();
    request.input.recoverSourceOnly = true;
    request.schedulerHandoff = { ...previous, sourceRecovery: { migrationId: previous.migrationId, sourceEpoch: 4, steps: [
      { name: "quiesce-source", status: "done" },
      { name: "rollback:scheduler-abort", status: "done" },
      { name: "rollback:unmount-target", status: "done" },
    ] } };
    vi.mocked(h.deps.resolveGatewayUrl).mockImplementation(async gatewayId => {
      if (gatewayId === "shared-green") throw new Error("target gateway was removed");
      return "http://source";
    });
    expect(await createMigrateUserHandler(h.deps)(request, h.ctx)).toMatchObject({ success: false, rolledBack: true });
    expect(h.client.abortImport).not.toHaveBeenCalled();
    expect(h.client.unmount).not.toHaveBeenCalled();
    expect(h.client.resume).toHaveBeenCalledOnce();
    expect(h.client.scheduler).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "shared-blue", phase: "resume" }));
    expect(h.deps.completeMigrationRecovery).toHaveBeenCalledOnce();
    expect(h.client.transferState).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
  });
  it("does not release unrelated voice ingress when the abandoned attempt failed before quiescence", async () => {
    const h = recovery();
    const request = op();
    request.input.recoverSourceOnly = true;
    request.attemptHistory = [{ attempt: 1, startedAt: 1_000, completedAt: 2_000,
      error: "rsync import port 30873 is already serving migrationId=other slug=bob",
      classification: "terminal", steps: [{ name: "keys-sync-state", status: "failed" }],
    }];
    request.schedulerHandoff = { ...previous, sourceRecovery: { migrationId: previous.migrationId, sourceEpoch: 4, steps: request.attemptHistory[0].steps } };
    vi.mocked(h.client.resume).mockRejectedValue(new Error("foreign voice hold"));
    expect(await createMigrateUserHandler(h.deps)(request, h.ctx)).toMatchObject({ rolledBack: true });
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.client.scheduler).toHaveBeenCalledWith(expect.objectContaining({ phase: "resume", gatewayId: "shared-blue" }));
    expect(h.deps.completeMigrationRecovery).toHaveBeenCalledOnce();
  });
  it.each(["released", "still-held", "purge-failed", "failed-entry", "transient"])("retries held target cleanup before publishing pre-quiesce source recovery: %s", async (scenario) => {
    const h = recovery();
    const request = op();
    request.input.recoverSourceOnly = true;
    request.attemptHistory = [{ attempt: 1, startedAt: 1_000, completedAt: 2_000,
      error: "agent database files are still held open: /state/agents/alice/agent/openclaw-agent.sqlite",
      classification: "terminal", steps: [{ name: "keys-sync-state", status: "done" }, { name: "pre-sync-state", status: "failed" }, { name: "rollback:unmount-target", status: "failed" }],
    }];
    if (scenario === "purge-failed") request.attemptHistory[0].error = "native cleanup incomplete: purgeFailed=true failed=[]";
    if (scenario === "failed-entry") request.attemptHistory[0].error = 'native cleanup incomplete: purgeFailed=false failed=["database purge failed"]';
    if (scenario === "transient") request.attemptHistory[0].error = "request timed out";
    request.attemptHistory[0].steps[1].error = request.attemptHistory[0].error;
    request.schedulerHandoff = { ...previous, sourceRecovery: { migrationId: previous.migrationId, sourceEpoch: 4, steps: request.attemptHistory[0].steps } };
    vi.mocked(h.client.resume).mockRejectedValue(new Error("foreign voice hold"));
    if (scenario === "still-held") vi.mocked(h.client.unmount).mockRejectedValue(new Error("agent database files are still held open"));

    const result = await createMigrateUserHandler(h.deps)(request, h.ctx);

    expect(result.rolledBack === true).toBe(scenario !== "still-held");
    if (scenario === "still-held") expect(result).toMatchObject({ success: false, error: "agent database files are still held open" });
    expect(h.client.abortImport).toHaveBeenCalledTimes(3);
    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "shared-green" }));
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.client.transferState).not.toHaveBeenCalled();
    expect(h.deps.completeMigrationRecovery).toHaveBeenCalledTimes(scenario !== "still-held" ? 1 : 0);
  });

  it("refuses source-only recovery without original evidence despite another attempt's keys-sync failure", async () => {
    const h = recovery();
    const request = op();
    request.attempts = 2;
    request.input.recoverSourceOnly = true;
    request.steps = [{ name: "keys-sync-state", status: "failed" }];
    vi.mocked(h.client.resume).mockRejectedValue(new Error("voice hold still owned"));
    expect(await createMigrateUserHandler(h.deps)(request, h.ctx)).toMatchObject({ success: false, error: "Shared migration recovery intent missing or changed" });
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.deps.completeMigrationRecovery).not.toHaveBeenCalled();
  });
  it.each(["cutover", "source-moved"])("refuses source-only recovery before native RPCs after %s", async (scenario) => {
    const h = recovery();
    const request = op();
    request.input.recoverSourceOnly = true;
    if (scenario === "cutover") request.cutoverCommittedAt = 3_000;
    if (scenario === "source-moved") request.input.fromGatewayId = "shared-other";
    expect(await createMigrateUserHandler(h.deps)(request, h.ctx)).toMatchObject({ success: false, rolledBack: false });
    expect(h.client.scheduler).not.toHaveBeenCalled();
    expect(h.client.abortImport).not.toHaveBeenCalled();
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.deps.completeMigrationRecovery).not.toHaveBeenCalled();
  });
});

describe("private project agent workspace rollout", () => {
  it.each(["wake", "idle return"] as const)("keeps the source serving during %s until the running target supports the workspace", async direction => {
    const h = mkDeps();
    const wake = direction === "wake";
    const source = wake ? "shared-blue" : "user-blue";
    const target = wake ? "user-green" : "shared-green";
    vi.mocked(h.deps.readUser).mockResolvedValue({ slug: "alice", currentGatewayId: source });
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, gatewayClass: wake ? "shared" : "isolated" });
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: wake ? "isolated" : "shared" });
    const native = mockNativeReturn();
    if (!wake) vi.mocked(h.deps.prepareNativeVmReturn).mockResolvedValue(native);
    const readWorkspace = vi.fn(async (gatewayId: string): Promise<boolean | undefined> => gatewayId === source ? true : undefined);
    h.deps.readPrivateProjectAgentWorkspace = readWorkspace;
    const operation = mkOp({ origin: "automatic", input: { uid: "uid-alice", fromGatewayId: source, toGatewayId: target } });
    const handler = createMigrateUserHandler(h.deps);

    expect(await handler(operation, h.ctx)).toMatchObject({
      success: false,
      error: expect.stringContaining("gateway compatibility pending: status 503"),
      output: { gatewayCompatibilityPending: true },
    });
    expect(readWorkspace.mock.calls).toEqual([[source, "alice"], [target, "alice"]]);
    expect(h.deps.setMigrationPhase).not.toHaveBeenCalled();
    expect(h.deps.prepareNativeVmReturn).not.toHaveBeenCalled();
    expect(h.deps.setAssignmentState).not.toHaveBeenCalled();
    expect(h.client.transferState).not.toHaveBeenCalled();
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();

    readWorkspace.mockImplementation(async gatewayId => gatewayId === source);
    expect(await handler(operation, h.ctx)).toMatchObject({ success: true });
    expect(h.client.quiesce).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: source }));
    expect(h.deps.commitCutover).toHaveBeenCalledOnce();
  });

  it.each([undefined, false])("allows an older or ineligible source to move normally (%s)", async workspace => {
    const h = mkDeps();
    const readWorkspace = vi.fn(async (gatewayId: string) => gatewayId === "gw-blue" ? workspace : undefined);
    h.deps.readPrivateProjectAgentWorkspace = readWorkspace;
    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
    expect(readWorkspace).toHaveBeenCalledExactlyOnceWith("gw-blue", "alice");
    expect(h.deps.commitCutover).toHaveBeenCalledOnce();
  });
  it("waits when a GitHub-backed agent is eligible to adopt the private path before source quiesce", async () => {
    const h = mkDeps();
    h.deps.readPrivateProjectAgentWorkspace = vi.fn(async gatewayId => gatewayId === "gw-blue" ? false : undefined);
    vi.mocked(h.deps.readUserSnapshot).mockResolvedValue({ ...SNAPSHOT, projectAgents: [
      { projectId: "orbit", githubBacked: true, enabled: true, mmUserId: "bot", token: "pat", status: "provisioning" },
    ] });
    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
    expect(result).toMatchObject({ success: false, output: { gatewayCompatibilityPending: true } });
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.deps.setAssignmentState).not.toHaveBeenCalled();
  });

  it("keeps source custody when the running source cannot verify its workspace", async () => {
    const h = mkDeps();
    h.deps.readPrivateProjectAgentWorkspace = vi.fn(async () => { throw new Error("Gateway config could not be read"); });
    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("Gateway config could not be read"),
      output: { gatewayCompatibilityPending: true } });
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
  });
});

describe("native VM return", () => {
  function nativeReturn(h: ReturnType<typeof mkDeps>) {
    const native = mockNativeReturn();
    h.deps.prepareNativeVmReturn = vi.fn(async () => native);
    return native;
  }

  it("recovers the reported older scheduler hold before retrying the same quiesce", async () => {
    const h = mkDeps();
    nativeReturn(h);
    const oldScheduler = "mig-builder-return-alice-s-old-g3:scheduler:1:claim:2000";
    h.deps.recoverAbandonedNativeScheduler = vi.fn(async () => undefined);
    const quiesce = h.client.quiesce;
    let blocked = true;
    h.client.quiesce = vi.fn(async request => {
      if (blocked && request.schedulerHandoff) {
        blocked = false;
        throw new MigrationRpcError("/quiesce/gw-blue: 500 quiesce failed", { status: 500, details: {
          error: "quiesce failed", message: `Cron agent octogee-alice-coach is held for migration ${oldScheduler}`,
        } });
      }
      return quiesce(request);
    });
    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
    expect(result.success).toBe(true);
    expect(h.deps.recoverAbandonedNativeScheduler).toHaveBeenCalledOnce();
    expect(h.deps.recoverAbandonedNativeScheduler).toHaveBeenCalledWith(
      expect.objectContaining({ fromGatewayId: "gw-blue", sourceEpoch: 4, hold: {
        operationId: "builder-return-alice-s-old-g3", migrationId: oldScheduler, agentId: "octogee-alice-coach",
      } }), expect.any(Function), expect.any(Function),
    );
    expect(vi.mocked(h.client.quiesce).mock.calls.filter(([request]) => request.schedulerHandoff)).toHaveLength(2);
  });

  it("continues a validated Native forward recovery on its live source release", async () => {
    const h = mkDeps();
    const native = nativeReturn(h);
    const sourceRoot = { gatewayClass: "isolated", desiredStatus: "running" as const, desiredRelease: 2, liveRelease: 1 };
    vi.mocked(h.deps.useDurableMigration).mockImplementation(async (_source, _target, retainedRelease) => {
      if (!migrationSourceReady(sourceRoot, retainedRelease)) throw new Error("source gateway not migration-ready");
      return false;
    });
    const handoff = { migrationId: "mig-op-1:scheduler:1:claim:4000", uid: "uid-alice", slug: "alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", forwardRecovery: { schemaVersion: 1 as const, phase: "source-flushed" as const, sourceEpoch: 4 } };
    const result = await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: handoff }), h.ctx);
    expect(result).toMatchObject({ success: true });
    expect(native.park).toHaveBeenCalledOnce();
    expect(h.deps.useDurableMigration).toHaveBeenCalledWith("gw-blue", "gw-green", 1);
    expect(h.ctx.assertActiveClaim).toHaveBeenCalledWith(true);
  });

  it("retains the live Native source release before the forward checkpoint", async () => {
    const h = mkDeps();
    const native = nativeReturn(h);
    const sourceRoot = { gatewayClass: "isolated", desiredStatus: "running" as const, desiredRelease: 2, liveRelease: 1 };
    vi.mocked(h.deps.useDurableMigration).mockImplementation(async (_source, _target, retainedRelease) => {
      if (!migrationSourceReady(sourceRoot, retainedRelease)) throw new Error("source gateway not migration-ready");
      return false;
    });
    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
    expect(result).toMatchObject({ success: true });
    expect(native.requestCheckpoint).toHaveBeenCalledOnce();
    expect(native.awaitCheckpoint).toHaveBeenCalledOnce();
    expect(native.park).toHaveBeenCalledOnce();
    expect(h.client.scheduler).toHaveBeenCalledWith(expect.objectContaining({ phase: "activate" }));
  });

  it("rejects an unconverged source for an ordinary migration", async () => {
    const h = mkDeps();
    const sourceRoot = { gatewayClass: "isolated", desiredStatus: "running" as const, desiredRelease: 2, liveRelease: 1 };
    vi.mocked(h.deps.useDurableMigration).mockImplementation(async (_source, _target, retainedRelease) => {
      if (!migrationSourceReady(sourceRoot, retainedRelease)) throw new Error("source gateway not migration-ready");
      return false;
    });
    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: false, error: "source gateway not migration-ready" });
    expect(h.client.transferState).not.toHaveBeenCalled();
  });

  it("does not relax source readiness when the forward recovery scope changed", async () => {
    const h = mkDeps();
    nativeReturn(h);
    const handoff = { migrationId: "mig-op-1:scheduler:1:claim:4000", uid: "uid-alice", slug: "alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", forwardRecovery: { schemaVersion: 1 as const, phase: "source-flushed" as const, sourceEpoch: 999 } };
    await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: handoff }), h.ctx);
    expect(h.deps.useDurableMigration).not.toHaveBeenCalled();
  });

  it("restores target SSH keys before retrying a fenced Native return", async () => {
    const h = mkDeps();
    nativeReturn(h);
    let targetHasKey = false;
    vi.mocked(h.client.transferState).mockImplementation(async request => {
      if (request.mode === "keys") targetHasKey = true;
      if (request.mode === "final" && !targetHasKey) throw new Error("local SSH public key is missing for alice");
      return { migrationId: request.migrationId, slug: request.slug, imported: true };
    });
    const handoff = { migrationId: "mig-op-1:scheduler:1:claim:4000", uid: "uid-alice", slug: "alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", forwardRecovery: { schemaVersion: 1 as const, phase: "source-flushed" as const, sourceEpoch: 4 } };
    const result = await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: handoff }), h.ctx);
    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(vi.mocked(h.client.transferState).mock.calls.map(([request]) => request.mode)).toEqual(["keys", "final"]);
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.ctx.assertActiveClaim).toHaveBeenCalledWith(true);
  });

  it("keeps the source fenced when recovery key transfer fails", async () => {
    const h = mkDeps();
    nativeReturn(h);
    vi.mocked(h.client.transferState).mockRejectedValue(new Error("key transfer unavailable"));
    const handoff = { migrationId: "mig-op-1:scheduler:1:claim:4000", uid: "uid-alice", slug: "alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", forwardRecovery: { schemaVersion: 1 as const, phase: "source-flushed" as const, sourceEpoch: 4 } };
    const result = await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: handoff }), h.ctx);
    expect(result).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("key transfer unavailable") });
    expect(vi.mocked(h.client.transferState).mock.calls.map(([request]) => request.mode)).toEqual(["keys"]);
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
  });

  it("returns to a shared gateway after the prior assignment removed its user SSH key", async () => {
    const h = mkDeps();
    nativeReturn(h);
    let targetHasUserKey = false;
    vi.mocked(h.client.transferState).mockImplementation(async request => {
      if (request.mode === "keys") targetHasUserKey = true;
      if (request.mode === "final" && !targetHasUserKey) {
        throw new Error("local SSH public key is missing for alice");
      }
      return { migrationId: request.migrationId, slug: request.slug, imported: true };
    });
    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
    expect(vi.mocked(h.client.transferState).mock.calls.map(([request]) => request.mode)).toEqual(["keys", "final"]);
    expect(h.client.transferState).toHaveBeenNthCalledWith(1, {
      migrationId: "mig-op-1", slug: "alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", mode: "keys",
    });
  });

  it("hands off the current PostgreSQL store before checkpoint and cutover", async () => {
    const h = mkDeps();
    const native = nativeReturn(h);
    const order: string[] = [];
    h.client.transferState = vi.fn(async request => {
      if (request.mode === "keys") return { migrationId: "mig-op-1", slug: "alice", imported: true };
      order.push("store-handoff");
      expect(request).toMatchObject({ mode: "final", includeActivationManifest: true });
      return { migrationId: "mig-op-1", slug: "alice", imported: true };
    });
    native.requestCheckpoint.mockImplementation(async () => { order.push("request-checkpoint"); });
    vi.mocked(h.deps.commitCutover).mockImplementation(async () => {
      order.push("cutover");
    });
    expect(await createMigrateUserHandler(h.deps)(mkOp({ startedAt: 4000 }), h.ctx)).toMatchObject({ success: true });
    expect(order).toEqual(["store-handoff", "request-checkpoint", "cutover"]);
  });

  it("keeps the source available when returning user keys cannot be transferred", async () => {
    const h = mkDeps();
    const native = nativeReturn(h);
    vi.mocked(h.client.transferState).mockRejectedValueOnce(new Error("user key transfer failed"));
    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: false, rolledBack: true });
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.client.flushGateway).not.toHaveBeenCalled();
    expect(native.requestCheckpoint).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    expect(h.deps.setAssignmentState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "quiescing" }));
  });

  it("unmounts the user on the live user after its writer hold is released and before suspending it", async () => {
    const h = mkDeps();
    const native = nativeReturn(h);
    const order: string[] = [];
    native.awaitCheckpoint.mockImplementation(async () => { order.push("checkpoint"); });
    native.releaseWriterHold.mockImplementation(async () => { order.push("release-writers"); });
    vi.mocked(h.client.unmount).mockImplementation(async ({ gatewayId, slug }) => {
      order.push(`unmount:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, unmounted: true };
    });
    native.park.mockImplementation(async park => { order.push(`park:${park.mode}`); return { parked: "suspended" }; });
    const verify = h.client.verifyTarget;
    h.client.verifyTarget = vi.fn(async request => { order.push("verify"); return verify(request); });

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true, output: { nativeSourcePark: { parked: "suspended" } } });
    expect(order).toEqual(["checkpoint", "release-writers", "unmount:gw-blue", "park:suspend", "verify"]);
    expect(native.sourceVmStatus).toHaveBeenCalledOnce();
    expect(vi.mocked(h.deps.log).mock.calls.flat().join("\n")).toContain("source gw-blue suspended for reuse");
  });

  it("retains the native home when its checkpoint fails after the store cutover", async () => {
    const h = mkDeps();
    const native = nativeReturn(h);
    native.awaitCheckpoint.mockRejectedValue(new Error("checkpoint upload failed"));
    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({
      success: false, rolledBack: false, error: expect.stringContaining("checkpoint upload failed"),
    });
    expect(h.deps.commitCutover).toHaveBeenCalledOnce();
    expect(native.park).not.toHaveBeenCalled();
    expect(native.releaseWriterHold).not.toHaveBeenCalled();
    expect(h.client.resume).not.toHaveBeenCalled();
  });





  it.each([true, false])("retains the source fence after a final import refusal regardless of target cleanup: %s", async (cleanupConfirmed) => {
    const h = mkDeps();
    const native = nativeReturn(h);
    const missingWitness = "Shared import has no original workspace identity witness";
    const order: string[] = [];
    const assignment = { gatewayId: "gw-blue", epoch: 4, state: "serving" };
    vi.mocked(h.deps.setAssignmentState).mockImplementation(async request => {
      expect(request.gatewayId).toBe(assignment.gatewayId);
      expect(request.epoch).toBe(assignment.epoch);
      assignment.state = request.state;
      order.push(`assignment:${request.state}`);
    });
    vi.mocked(h.client.transferState).mockImplementation(async request => {
      if (request.mode === "final") {
        expect(request).toMatchObject({ includeActivationManifest: true });
        expect(assignment.state).toBe("quiescing");
        order.push("final-import-refused");
        throw new MigrationRpcError(missingWitness, { status: 500 });
      }
      return { migrationId: request.migrationId, slug: request.slug, imported: true };
    });
    vi.mocked(h.client.abortImport).mockImplementation(async request => { order.push(`abort:${request.gatewayId}`); });
    vi.mocked(h.client.unmount).mockImplementation(async request => {
      order.push(`unmount:${request.gatewayId}`);
      if (!cleanupConfirmed) throw new MigrationTransportError("target cleanup outcome unknown");
      return { ...request, unmounted: true };
    });
    const scheduler = h.client.scheduler;
    h.client.scheduler = vi.fn(async request => {
      order.push(`scheduler:${request.gatewayId}:${request.phase}`);
      return scheduler(request);
    });
    vi.mocked(h.client.resume).mockImplementation(async request => { order.push(`resume:${request.gatewayId}`); });

    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining(missingWitness) });
    expect(h.client.abortImport).not.toHaveBeenCalled();
    expect(h.client.unmount).not.toHaveBeenCalled();
    expect(order).toEqual(["assignment:quiescing", "final-import-refused"]);
    expect(assignment).toEqual({ gatewayId: "gw-blue", epoch: 4, state: "quiescing" });
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    expect(native.requestCheckpoint).not.toHaveBeenCalled();
    expect(native.park).not.toHaveBeenCalled();
    expect(h.client.restoreTarget).not.toHaveBeenCalled();
  });

  describe("checkpoint release readiness", () => {
    const handoff = { migrationId: "mig-op-1:scheduler:1", fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" };
    const op = () => mkOp({ attempts: 1, schedulerHandoff: handoff, input: {
      uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
    } });

    it("finishes an operator's return that restarted after cutover: final checkpoint, then the VM parks", async () => {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      const native = nativeReturn(h);
      const operatorReturn = mkOp({ attempts: 1, schedulerHandoff: handoff, input: {
        uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green",
      } });

      expect(await createMigrateUserHandler(h.deps)(operatorReturn, h.ctx)).toMatchObject({ success: true });

      expect(native.park).toHaveBeenCalledOnce();
      expect(h.steps.filter(step => step.status === "done").map(step => step.name)).toEqual(
        expect.arrayContaining(["checkpoint-native-computer", "release-native-writers", "park-native-computer"]),
      );
    });

    it.each([
      new MigrationRpcError("VM containers paused", { status: 503 }),
      new MigrationRpcError("WS open failed: Unexpected server response: 503", { status: 500 }),
      new MigrationTransportError("VM containers paused"),
    ])("waits for the thawed user to retire its schedules and unmount before suspending it: %s", async (unavailable) => {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      const native = nativeReturn(h);
      const order: string[] = [];
      native.releaseWriterHold.mockImplementation(async () => { order.push("release-writers"); });
      native.park.mockImplementation(async () => { order.push("park"); return { parked: "suspended" }; });
      const unmount = h.client.unmount;
      h.client.unmount = vi.fn(async (request) => { order.push(`unmount:${request.gatewayId}`); return unmount(request); });
      const scheduler = h.client.scheduler;
      h.client.scheduler = vi.fn(async (request) => {
        if (request.phase === "retire") {
          if (order.at(-1) === "release-writers") {
            order.push("paused");
            throw unavailable;
          }
          order.push("retired");
        } else {
          order.push("activated");
        }
        return scheduler(request);
      });
      expect(await createMigrateUserHandler(h.deps)(op(), h.ctx)).toMatchObject({ success: true });
      expect(order).toEqual(["release-writers", "paused", "retired", "unmount:gw-blue", "park", "activated"]);
      expect(native.park).toHaveBeenCalledExactlyOnceWith({ mode: "suspend" });
      expect(h.deps.sleep).toHaveBeenCalledOnce();
    });

    it("stops instead of suspending a source whose thawed user never answers the retire", async () => {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      const native = nativeReturn(h);
      let clock = 5_000;
      vi.mocked(h.deps.now).mockImplementation(() => clock);
      vi.mocked(h.deps.sleep).mockImplementation(async (ms) => { clock += ms; });
      const scheduler = h.client.scheduler;
      h.client.scheduler = vi.fn(async (request) => {
        if (request.phase === "retire") throw new MigrationRpcError("VM paused", { status: 503 });
        expect(native.park).toHaveBeenCalledOnce();
        return scheduler(request);
      });
      expect(await createMigrateUserHandler(h.deps)(op(), h.ctx)).toMatchObject({ success: true });
      expect(clock).toBe(65_000);
      expect(native.park).toHaveBeenCalledExactlyOnceWith({ mode: "stop", reason: expect.stringContaining("did not resume") });
      expect(vi.mocked(h.client.scheduler).mock.calls.map(([request]) => request.phase).at(-1)).toBe("activate");
      expect(h.client.unmount).not.toHaveBeenCalled();
      const log = vi.mocked(h.deps.log).mock.calls.flat().join("\n");
      expect(log).toContain(`stay fenced under ${handoff.migrationId}`);
      expect(log).toContain("stopped instead of suspended");
    });

    it("waits for released source cleanup when no scheduler handoff was retained", async () => {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      nativeReturn(h);
      const unmount = h.client.unmount;
      h.client.unmount = vi.fn().mockRejectedValueOnce(new MigrationRpcError("paused", { status: 503 })).mockImplementation(unmount);
      const request = op();
      delete request.schedulerHandoff;
      expect(await createMigrateUserHandler(h.deps)(request, h.ctx)).toMatchObject({ success: true });
      expect(h.client.unmount).toHaveBeenCalledTimes(2);
      expect(h.deps.sleep).toHaveBeenCalledOnce();
    });



    it.each([false, true])("releases an earlier checkpoint before deferring an active user (source fenced=%s)", async (fenced) => {
      const h = mkDeps();
      const native = nativeReturn(h);
      native.checkpointRequested = true;
      const order: string[] = [];
      native.release.mockImplementation(async () => { order.push("release"); });
      const quiesce = h.client.quiesce;
      let calls = 0;
      h.client.quiesce = vi.fn(async (request) => {
        calls++;
        if (calls === (fenced ? 2 : 1)) throw new MigrationDrainPendingError("active user");
        return quiesce(request);
      });
      const scheduler = h.client.scheduler;
      h.client.scheduler = vi.fn(async (request) => {
        if (request.phase === "resume") expect(order).toContain("release");
        return scheduler(request);
      });
      h.client.resume = vi.fn(async () => {
        expect(order).toContain("release");
        if (order.at(-1) === "release") { order.push("paused"); throw new MigrationRpcError("paused", { status: 503 }); }
        order.push("resumed");
      });
      expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ waitingForUserIdle: true, rolledBack: false });
      expect(order).toEqual(["release", "paused", "resumed"]);
      expect(native.requestCheckpoint).not.toHaveBeenCalled();
      expect(h.deps.commitCutover).not.toHaveBeenCalled();
    });



    it("does not resume a rollback until the running source is reachable", async () => {
      const h = mkDeps();
      const native = nativeReturn(h);
      native.requestCheckpoint.mockRejectedValue(new Error("native return checkpoint claim authority changed"));
      let clock = 5_000;
      vi.mocked(h.deps.now).mockImplementation(() => clock);
      vi.mocked(h.deps.sleep).mockImplementation(async (ms) => { clock += ms; });
      const scheduler = h.client.scheduler;
      h.client.scheduler = vi.fn(async (request) => {
        if (request.phase === "resume") throw new MigrationRpcError("still paused", { status: 503 });
        return scheduler(request);
      });
      const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
      expect(result).toMatchObject({ success: false, rolledBack: false });
      expect(classifyOperationFailure(result.error)).toBe("transient");
      expect(h.deps.setAssignmentState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "serving" }));
      expect(h.client.resume).not.toHaveBeenCalled();
    });

    it("stops cleanup if the operation claim changes while waiting for the VM", async () => {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      nativeReturn(h);
      let claimLost = false;
      h.ctx.assertActiveClaim = vi.fn(async () => { if (claimLost) throw new Error("operation re-claimed"); });
      vi.mocked(h.client.scheduler).mockRejectedValueOnce(new MigrationRpcError("paused", { status: 503 }));
      vi.mocked(h.deps.sleep).mockImplementation(async () => { claimLost = true; });
      expect(await createMigrateUserHandler(h.deps)(op(), h.ctx)).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("operation re-claimed") });
      expect(h.client.scheduler).toHaveBeenCalledOnce();
      expect(h.client.unmount).not.toHaveBeenCalled();
    });

    it.each([
      ["TERMINATED", true], ["STOPPED", false], [null, true], ["SUSPENDED", false],
    ] as const)("skips the RPCs and stops a source VM Compute reports %s (handoff=%s)", async (status, withHandoff) => {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      const native = nativeReturn(h);
      native.sourceVmStatus.mockResolvedValue(status);
      const request = op();
      if (!withHandoff) delete request.schedulerHandoff;
      expect(await createMigrateUserHandler(h.deps)(request, h.ctx)).toMatchObject({ success: true });
      expect(vi.mocked(h.client.scheduler).mock.calls.map(([call]) => [call.gatewayId, call.phase])).toEqual(withHandoff ? [["gw-green", "activate"]] : []);
      expect(h.client.unmount).not.toHaveBeenCalled();
      expect(h.deps.sleep).not.toHaveBeenCalled();
      expect(native.park).toHaveBeenCalledExactlyOnceWith({ mode: "stop", reason: `source VM is ${status ?? "absent"}` });
      expect(h.client.verifyTarget).toHaveBeenCalledOnce();
      expect(native.acknowledgeCompletedSchedulerHandoff).toHaveBeenCalledOnce();
      expect(h.steps.filter(step => step.status === "done").map(step => step.name)).toEqual([
        "checkpoint-native-computer", "release-native-writers", "park-native-computer", ...(withHandoff ? ["activate-scheduler"] : []), "verify-target",
      ]);
      const log = vi.mocked(h.deps.log).mock.calls.flat().join("\n");
      expect(log).toContain(`source VM is ${status ?? "absent"}; scheduler retire and unmount RPCs skipped`);
      if (withHandoff) expect(log).toContain(handoff.migrationId);
    });

    it.each(["stopped", "cleanup-failure"])("does not let a stop decision bypass a lost operation claim: %s", async path => {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      const native = nativeReturn(h);
      if (path === "stopped") native.sourceVmStatus.mockResolvedValue("TERMINATED");
      h.ctx.assertActiveClaim = vi.fn().mockRejectedValue(new Error("operation re-claimed"));
      expect(await createMigrateUserHandler(h.deps)(op(), h.ctx)).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("operation re-claimed") });
      expect(h.client.scheduler).not.toHaveBeenCalled();
      expect(h.client.unmount).not.toHaveBeenCalled();
      if (path === "cleanup-failure") expect(native.park).not.toHaveBeenCalled();
    });

    it.each([
      new MigrationRpcError("unauthorized", { status: 401 }),
      new MigrationRpcError("held database files", { status: 500 }),
    ])("stops the source on an unrelated cleanup failure without polling it away: %s", async (error) => {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      const native = nativeReturn(h);
      const scheduler = h.client.scheduler;
      h.client.scheduler = vi.fn(async (request) => {
        if (request.phase === "retire") throw error;
        return scheduler(request);
      });
      expect(await createMigrateUserHandler(h.deps)(op(), h.ctx)).toMatchObject({ success: true });
      expect(h.deps.sleep).not.toHaveBeenCalled();
      expect(vi.mocked(h.client.scheduler).mock.calls.map(([request]) => request.phase)).toEqual(["retire", "activate"]);
      expect(h.client.unmount).not.toHaveBeenCalled();
      expect(native.park).toHaveBeenCalledExactlyOnceWith({ mode: "stop", reason: `live source cleanup failed: ${error.message}` });
      expect(h.steps.filter(step => step.status === "failed").map(step => step.name)).toEqual(["retire-source-scheduler"]);
    });
  });

  it("joins Shared channel readiness after source cleanup without starting a competing restore", async () => {
    const h = mkDeps();
    const native = nativeReturn(h);
    const order: string[] = [];
    let clock = 1_000;
    h.deps.now = () => clock;
    const reportStep = h.ctx.reportStep;
    h.ctx.reportStep = step => {
      if (step.name === "checkpoint-native-computer" && step.status === "done") step.startedAt = 1_000;
      return reportStep(step);
    };
    native.requestCheckpoint.mockImplementation(async () => { order.push("request-checkpoint"); });
    native.awaitCheckpoint.mockImplementation(async () => { order.push("checkpoint"); clock += 25; });
    const transfer = h.client.transferState;
    h.client.transferState = vi.fn(async input => {
      if (input.mode === "final") {
        await input.reportImport?.("running", clock);
        await input.reportImport?.("done", clock);
      }
      return transfer(input);
    });
    const verify = h.client.verifyTarget;
    h.client.verifyTarget = vi.fn(async (input) => {
      order.push("verify");
      expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue" }));
      return verify(input);
    });
    vi.mocked(h.deps.commitCutover).mockImplementation(async () => { order.push("cutover"); });
    native.park.mockImplementation(async () => { order.push("park"); return { parked: "suspended" }; });

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
    expect(order).toEqual(["request-checkpoint", "cutover", "checkpoint", "park", "verify"]);
    expect(h.setMigrationPhase.mock.calls.map(([input]) => input.phase))
      .toEqual(["preparing", "waiting", "transferring", "checkpointing"]);
    expect(h.setMigrationPhase.mock.invocationCallOrder.at(-1))
      .toBeLessThan(native.requestCheckpoint.mock.invocationCallOrder[0]!);
    expect(h.deps.recordMigrationProgress).toHaveBeenCalledWith({
      operation: expect.objectContaining({ id: "op-1" }),
      event: expect.objectContaining({ status: "running", slug: "alice", at: expect.any(Number) }),
    });
    const journal = vi.mocked(h.deps.recordMigrationProgress).mock.calls.map(([{ event }]) => [event.phase, event.status]);
    expect(journal).toEqual(expect.arrayContaining([
      ["target-import-and-activation", "running"],
      ["target-import-and-activation", "done"],
      ["checkpoint-native-computer", "done"],
      ["park-native-computer", "done"],
      ["verify-target", "done"],
    ]));
    expect(h.deps.recordMigrationProgress).toHaveBeenCalledWith({
      operation: expect.objectContaining({ id: "op-1" }),
      event: expect.objectContaining({ phase: "checkpoint-native-computer", status: "done", elapsedMs: 25 }),
    });
    const lines = vi.mocked(h.deps.log).mock.calls.map(([message]) => message);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.endsWith(" op=op-1") && line.match(/ op=/gu)?.length === 1)).toBe(true);
    expect(h.client.restoreTarget).not.toHaveBeenCalled();
    expect(h.client.transferState).toHaveBeenCalledTimes(2);
    expect(h.client.transferState).toHaveBeenNthCalledWith(2, expect.objectContaining({ mode: "final", includeActivationManifest: true }));
  });

  describe("Shared restore", () => {
    const interruptedMount = {
      migrationId: "mig-op-1", slug: "alice", ready: false,
      checks: { customerDir: true, coachWired: true, mountMarked: false },
    };
    const operation = () => mkOp({ cutoverCommittedAt: 100, input: {
      uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
    } });
    function recovery(input: { dispatched: boolean } = { dispatched: true }) {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      nativeReturn(h);
      h.ctx.assertActiveClaim = vi.fn(async () => undefined);
      h.ctx.withUserRestoreFence = vi.fn(async (_input, work) => work());
      h.ctx.assertUserRestoreSettled = vi.fn(async () => undefined);
      if (input.dispatched) {
        vi.mocked(h.ctx.assertUserRestoreSettled).mockRejectedValueOnce(new PendingUserRestoreError("pending"));
      }
      vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, epoch: 7 });
      vi.mocked(h.deps.readUserSnapshot).mockResolvedValue({ ...SNAPSHOT, gatewayId: "gw-green" });
      return h;
    }

    it("leaves an interrupted Shared mount for the operator even when its agent reports healthy", async () => {
      const h = recovery({ dispatched: false });
      vi.mocked(h.client.verifyTarget).mockRejectedValue(new MigrationRpcError("incomplete mount", {
        status: 409, details: { ...interruptedMount, checks: { ...interruptedMount.checks, accountHealthy: true } },
      }));
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({
        success: false, rolledBack: false, error: expect.stringContaining("native return completion pending: status 503: incomplete mount"),
      });
      expect(h.client.verifyTarget).toHaveBeenCalledOnce();
      expect(h.ctx.withUserRestoreFence).not.toHaveBeenCalled();
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
      expect(h.steps).not.toContainEqual(expect.objectContaining({ name: "restore-target" }));
    });

    it("resumes an exact dispatched restore under its assignment fence before completing the return", async () => {
      const h = recovery();
      vi.mocked(h.client.restoreTarget).mockImplementation(async (request) => {
        expect(h.ctx.assertActiveClaim).toHaveBeenCalled();
        return { migrationId: request.migrationId, slug: request.slug, restored: true, steps: ["verify-channel-ready"] };
      });
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: true });
      expect(h.client.restoreTarget).toHaveBeenCalledWith({
        migrationId: "mig-op-1", gatewayId: "gw-green", uid: "uid-alice", slug: "alice",
        snapshot: { ...SNAPSHOT, gatewayId: "gw-green" }, resume: true,
      });
      expect(h.ctx.withUserRestoreFence).toHaveBeenCalledWith({
        uid: "uid-alice", slug: "alice", gatewayId: "gw-green", fromGatewayId: "gw-blue", assignmentEpoch: 7, resume: true,
      }, expect.any(Function));
      expect(h.ctx.assertUserRestoreSettled).toHaveBeenCalledTimes(2);
      expect(h.steps).toContainEqual(expect.objectContaining({ name: "restore-target", status: "done" }));
      expect(h.client.verifyTarget).toHaveBeenCalledOnce();
      expect(h.client.transferState).not.toHaveBeenCalled();
      expect(h.deps.commitCutover).not.toHaveBeenCalled();
    });

    it("never resumes a restore without durable coordination", async () => {
      const h = recovery();
      delete h.ctx.withUserRestoreFence;
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false });
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
    });

    it("keeps a replacement-pod restore fenced and pending across repeated missing-persona-witness refusals after cutover", async () => {
      const h = recovery();
      const native = nativeReturn(h);
      const missingWitness = "Shared restore has no original workspace identity witness";
      const id = builderReturnOperationId("gw-blue", 1);
      const scope = { uid: "uid-alice", slug: "alice", gatewayId: "gw-green", fromGatewayId: "gw-blue", assignmentEpoch: 7 };
      const restoreAttempt = { ...scope, operationId: id, attemptId: "restore-before-pod-loss", phase: "dispatched", claimStartedAt: 3_000, dispatchedAt: 3_100 };
      const acknowledge = vi.fn(async () => undefined);
      const begin = vi.fn(async (input: Parameters<NonNullable<OperationContext["withUserRestoreFence"]>>[0]) => {
        expect(input).toEqual({ ...scope, resume: true });
        return acknowledge;
      });
      vi.mocked(h.client.restoreTarget).mockImplementation(async request => {
        expect(request).toMatchObject({ uid: scope.uid, slug: scope.slug, gatewayId: scope.gatewayId, migrationId: `mig-${id}`, resume: true });
        expect(request.snapshot).toMatchObject({ uid: scope.uid, slug: scope.slug, gatewayId: scope.gatewayId, status: "complete" });
        throw new MigrationRpcError(missingWitness, { status: 500 });
      });

      for (const attempts of [4, 5]) {
        const op = mkOp({ id, origin: "automatic", attempts, cutoverCommittedAt: 100, input: {
          uid: scope.uid, userSlug: scope.slug, fromGatewayId: scope.fromGatewayId, toGatewayId: scope.gatewayId, source: "builder-activation-lease",
        } });
        const { ctx, steps } = createOperationContext({
          opId: id, assertActiveClaim: h.ctx.assertActiveClaim, persist: vi.fn(async () => undefined), log: vi.fn(),
          userRestore: { begin, assertSettled: async () => assertUserRestoreSettled(op, restoreAttempt) },
        });
        const result = await createMigrateUserHandler(h.deps)(op, ctx);
        expect(result).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining(`native return completion pending: status 503: ${missingWitness}`) });
        expect(steps).toContainEqual(expect.objectContaining({ name: "restore-target", status: "failed", error: missingWitness }));
        const completion = buildOperationCompletionUpdate({ op, result, steps, now: 6_000 });
        expect(completion).toMatchObject({ status: "pending", startedAt: null, attempts: attempts + 1 });
        expect(completion.error).toEqual(expect.stringContaining(missingWitness));
        expect(() => assertUserRestoreSettled(op, restoreAttempt)).toThrow(PendingUserRestoreError);
      }

      expect(h.client.restoreTarget).toHaveBeenCalledTimes(2);
      expect(begin).toHaveBeenCalledTimes(2);
      expect(acknowledge).not.toHaveBeenCalled();
      expect(h.deps.readUser).toHaveBeenCalledWith(scope.uid);
      expect(h.deps.commitCutover).not.toHaveBeenCalled();
      expect(h.deps.setAssignmentState).not.toHaveBeenCalled();
      expect(h.client.resume).not.toHaveBeenCalled();
      expect(h.client.transferState).not.toHaveBeenCalled();
      expect(h.client.unmount).not.toHaveBeenCalled();
      expect(h.client.scheduler).not.toHaveBeenCalled();
      expect(h.client.verifyTarget).not.toHaveBeenCalled();
      expect(native.releaseWriterHold).not.toHaveBeenCalled();
      expect(native.park).not.toHaveBeenCalled();
      expect(native.acknowledgeCompletedSchedulerHandoff).not.toHaveBeenCalled();
    });

    it("does not accept ready state after an ambiguous earlier restore", async () => {
      const h = recovery({ dispatched: false });
      const native = nativeReturn(h);
      vi.mocked(h.ctx.assertUserRestoreSettled!).mockRejectedValue(new Error("restore delivery remains ambiguous"));
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({
        success: false, error: expect.stringContaining("ambiguous"),
      });
      expect(h.client.verifyTarget).not.toHaveBeenCalled();
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
      expect(native.release).not.toHaveBeenCalled();
      expect(h.client.unmount).not.toHaveBeenCalled();
      expect(h.client.scheduler).not.toHaveBeenCalled();
    });

    it("does not dispatch when placement or suspension wins the fence transaction", async () => {
      const h = recovery();
      vi.mocked(h.ctx.withUserRestoreFence!).mockRejectedValue(new Error("restore assignment changed"));
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false });
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
    });

    it.each([
      null,
      { ...SNAPSHOT, gatewayId: "gw-other" },
      { ...SNAPSHOT, gatewayId: "gw-green", uid: "uid-other" },
      { ...SNAPSHOT, gatewayId: "gw-green", slug: "other" },
      { ...SNAPSHOT, gatewayId: "gw-green", status: "provisioning" as const },
    ])("refuses a snapshot that no longer proves the assigned complete owner: %j", async (snapshot) => {
      const h = recovery();
      vi.mocked(h.deps.readUserSnapshot).mockResolvedValue(snapshot);
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, rolledBack: false });
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
    });

    it("refuses recovery after losing the operation claim", async () => {
      const h = recovery();
      vi.mocked(h.ctx.assertActiveClaim!).mockRejectedValue(new Error("operation re-claimed"));
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, error: expect.stringContaining("operation re-claimed") });
      expect(h.client.restoreTarget).not.toHaveBeenCalled();
    });

    it.each([
      { migrationId: "other", slug: "alice", restored: true, steps: [] },
      { migrationId: "mig-op-1", slug: "other", restored: true, steps: [] },
      { migrationId: "mig-op-1", slug: "alice", restored: false, steps: [] },
    ])("rejects an unconfirmed or mismatched restore receipt: %j", async (receipt) => {
      const h = recovery();
      vi.mocked(h.client.restoreTarget).mockResolvedValue(receipt);
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, rolledBack: false });
      expect(h.client.verifyTarget).not.toHaveBeenCalled();
    });

    it("does not report restored readiness after assignment changes during the RPC", async () => {
      const h = recovery();
      vi.mocked(h.deps.readUser).mockResolvedValueOnce({ slug: "alice", currentGatewayId: "gw-green" })
        .mockResolvedValue({ slug: "alice", currentGatewayId: "gw-other" });
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, error: expect.stringContaining("owner changed") });
      expect(h.client.restoreTarget).toHaveBeenCalledOnce();
      expect(h.client.verifyTarget).not.toHaveBeenCalled();
    });

    it("does not verify completion when the claim is lost during restore", async () => {
      const h = recovery();
      let claimLost = false;
      vi.mocked(h.client.restoreTarget).mockImplementation(async (request) => {
        claimLost = true;
        return { migrationId: request.migrationId, slug: request.slug, restored: true, steps: [] };
      });
      vi.mocked(h.ctx.assertActiveClaim!).mockImplementation(async () => {
        if (claimLost) throw new Error("operation re-claimed");
      });
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, error: expect.stringContaining("operation re-claimed") });
      expect(h.client.restoreTarget).toHaveBeenCalledOnce();
      expect(h.client.verifyTarget).not.toHaveBeenCalled();
    });

    it("leaves a busy restore pending without changing ownership", async () => {
      const h = recovery();
      vi.mocked(h.client.restoreTarget).mockRejectedValue(new Error("mount already in flight"));
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("mount already in flight") });
      expect(h.client.verifyTarget).not.toHaveBeenCalled();
      expect(h.steps).toContainEqual(expect.objectContaining({ name: "restore-target", status: "failed" }));
    });

    it("does not restore again when verification remains incomplete after a resumed restore", async () => {
      const h = recovery();
      vi.mocked(h.client.verifyTarget).mockRejectedValue(new MigrationRpcError("incomplete mount", { status: 409, details: interruptedMount }));
      expect(await createMigrateUserHandler(h.deps)(operation(), h.ctx)).toMatchObject({ success: false, rolledBack: false });
      expect(h.client.restoreTarget).toHaveBeenCalledOnce();
      expect(h.client.verifyTarget).toHaveBeenCalledOnce();
    });
  });

  it("retries forward when Shared is still mounting without rolling back or declaring success", async () => {
    const h = mkDeps();
    nativeReturn(h);
    vi.mocked(h.client.verifyTarget).mockRejectedValue(new Error("status 409: defaultAgent not ready"));
    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({
      success: false, rolledBack: false, error: expect.stringContaining("status 503"),
    });
    expect(h.deps.commitCutover).toHaveBeenCalledOnce();
    expect(h.client.unmount).not.toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-green" }));
    expect(h.deps.setAssignmentState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "serving" }));
  });

  function attachInProgress(): MigrationRpcError {
    return new MigrationRpcError("/verify/gw-green: 409 agent attaching", {
      status: 409,
      code: MIGRATION_VERIFY_DEFAULT_AGENT_ATTACH_IN_PROGRESS,
    });
  }

  it("waits out a agent attach Shared reports in progress instead of failing the return", async () => {
    const h = mkDeps();
    nativeReturn(h);
    const ready = h.client.verifyTarget;
    h.client.verifyTarget = vi.fn()
      .mockRejectedValueOnce(attachInProgress())
      .mockRejectedValueOnce(attachInProgress())
      .mockImplementation(ready);

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true, rolledBack: false });
    expect(h.client.verifyTarget).toHaveBeenCalledTimes(3);
    expect(h.deps.sleep).toHaveBeenCalledTimes(2);
    expect(h.steps.filter((step) => step.status === "failed")).toEqual([]);
  });

  it("stops waiting for an in-progress agent attach at the provisioner's attach deadline", async () => {
    const h = mkDeps();
    nativeReturn(h);
    let clock = 5_000;
    vi.mocked(h.deps.now).mockImplementation(() => clock);
    vi.mocked(h.deps.sleep).mockImplementation(async (ms: number) => { clock += ms; });
    vi.mocked(h.client.verifyTarget).mockRejectedValue(attachInProgress());

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({
      success: false, rolledBack: false, error: expect.stringContaining("native return completion pending"),
    });
    const slept = vi.mocked(h.deps.sleep).mock.calls.reduce((total, [ms]) => total + ms, 0);
    expect(slept).toBeGreaterThanOrEqual(ADD_USER_DEADLINE_MS);
    expect(slept).toBeLessThan(ADD_USER_DEADLINE_MS + 30_000);
  });

  it("fails promptly when Shared reports the agent unwired with no attach in progress", async () => {
    const h = mkDeps();
    nativeReturn(h);
    vi.mocked(h.client.verifyTarget).mockRejectedValue(
      new MigrationRpcError("/verify/gw-green: 409 coachWired:false", { status: 409 }),
    );

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({
      success: false, rolledBack: false, error: expect.stringContaining("coachWired:false"),
    });
    expect(h.client.verifyTarget).toHaveBeenCalledOnce();
    expect(h.deps.sleep).not.toHaveBeenCalled();
  });

  it("stops instead of suspending a source whose live unmount fails, and says so", async () => {
    const h = mkDeps();
    const native = nativeReturn(h);
    vi.mocked(h.client.unmount).mockRejectedValue(new Error("source unreachable"));
    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
    expect(result).toMatchObject({ success: true, rolledBack: false, output: {
      nativeSourcePark: { parked: "stopped", stopReason: "live source cleanup failed: source unreachable" },
    } });
    expect(native.park).toHaveBeenCalledExactlyOnceWith({ mode: "stop", reason: "live source cleanup failed: source unreachable" });
    expect(h.client.verifyTarget).toHaveBeenCalledOnce();
    expect(h.steps.filter(step => step.status === "failed").map(step => step.name)).toEqual(["unmount-source"]);
    const log = vi.mocked(h.deps.log).mock.calls.flat().join("\n");
    expect(log).toContain("live source cleanup failed: source unreachable; stopping gw-blue instead of suspending it");
    expect(log).toContain("source gw-blue stopped instead of suspended: live source cleanup failed: source unreachable");
    expect(h.deps.setAssignmentState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "serving" }));
  });

  it("finishes a cutover by stopping a source whose route is gone", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    const native = nativeReturn(h);
    vi.mocked(h.deps.resolveGatewayUrl).mockImplementation(async (id) => {
      if (id === "gw-blue") throw new Error("source VM disappeared");
      return `http://${id}:18789`;
    });
    const result = await createMigrateUserHandler(h.deps)(mkOp({ input: {
      uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
    } }), h.ctx);
    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(native.park).toHaveBeenCalledExactlyOnceWith({ mode: "stop", reason: "live source cleanup failed: source VM disappeared" });
    expect(h.client.verifyTarget).toHaveBeenCalledOnce();
  });

  it.each([false, true])("requests the native checkpoint before Shared cutover and awaits it after, before release (resumed=%s)", async (requested) => {
    const { deps, ctx, client, events } = mkDeps();
    const native = mockNativeReturn(requested);
    native.requestCheckpoint.mockImplementation(async () => { events.push("request-checkpoint"); });
    native.awaitCheckpoint.mockImplementation(async () => { events.push("native-checkpoint"); });
    native.park.mockImplementation(async () => { events.push("park"); return { parked: "suspended" }; });
    deps.prepareNativeVmReturn = vi.fn(async () => native);
    const result = await createMigrateUserHandler(deps)(mkOp({}), ctx);
    expect(result.success).toBe(true);
    expect(native.requestCheckpoint).toHaveBeenCalledOnce();
    expect(native.awaitCheckpoint).toHaveBeenCalledOnce();
    expect(events.indexOf("request-checkpoint")).toBeLessThan(events.indexOf("cutover:gw-blue->gw-green:mirror=true"));
    expect(events.indexOf("native-checkpoint")).toBeGreaterThan(events.indexOf("cutover:gw-blue->gw-green:mirror=true"));
    expect(events.indexOf("native-checkpoint")).toBeLessThan(events.indexOf("park"));
    expect(client.transferState).toHaveBeenCalledTimes(2);
    expect(client.transferState).toHaveBeenNthCalledWith(2, expect.objectContaining({ mode: "final", includeActivationManifest: true }));
    expect(client.unmount).toHaveBeenCalledOnce();
    expect(client.flushGateway).toHaveBeenCalledTimes(requested ? 0 : 1);
    expect(native.release).not.toHaveBeenCalled();
    expect(native.park).toHaveBeenCalledOnce();
  });

  it("finishes source cleanup when a retry finds the native return already cut over", async () => {
    const { deps, ctx, client } = mkDeps({ sourceGatewayId: "gw-green" });
    const native = mockNativeReturn(true);
    deps.prepareNativeVmReturn = vi.fn(async () => native);
    const result = await createMigrateUserHandler(deps)(mkOp({ input: {
      uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
    } }), ctx);
    expect(result.success).toBe(true);
    expect(native.park).toHaveBeenCalledExactlyOnceWith({ mode: "suspend" });
    expect(client.unmount).toHaveBeenCalledOnce();
    expect(client.flushGateway).not.toHaveBeenCalled();
    expect(native.requestCheckpoint).not.toHaveBeenCalled();
    expect(client.verifyTarget).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-green" }));
  });

  it("does not report a recovered cutover complete while the destination is unavailable", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    nativeReturn(h);
    vi.mocked(h.client.verifyTarget).mockRejectedValue(new Error("not connected"));
    const result = await createMigrateUserHandler(h.deps)(mkOp({ input: {
      uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
    } }), h.ctx);
    expect(result).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("not connected") });
  });

  it("rolls forward after an uncertain cutover response when Shared already owns the user", async () => {
    const { deps, ctx, client } = mkDeps();
    const native = mockNativeReturn();
    deps.prepareNativeVmReturn = vi.fn(async () => native);
    vi.mocked(deps.commitCutover).mockImplementation(async () => {
      vi.mocked(deps.readUser).mockResolvedValue({ slug: "alice", currentGatewayId: "gw-green" });
      throw new Error("lost response");
    });
    const result = await createMigrateUserHandler(deps)(mkOp({}), ctx);
    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(native.release).not.toHaveBeenCalled();
    expect(native.park).toHaveBeenCalledOnce();
    expect(client.unmount).toHaveBeenCalledOnce();
    expect(deps.setAssignmentState).not.toHaveBeenCalledWith(expect.objectContaining({ state: "serving" }));
  });

  it("keeps the source assignment when the native checkpoint claim fails", async () => {
    const { deps, ctx, client } = mkDeps();
    const native = mockNativeReturn();
    native.requestCheckpoint.mockRejectedValue(new Error("native VM has another checkpoint request"));
    deps.prepareNativeVmReturn = vi.fn(async () => native);
    const result = await createMigrateUserHandler(deps)(mkOp({}), ctx);
    expect(result).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("native VM has another checkpoint request") });
    expect(native.awaitCheckpoint).not.toHaveBeenCalled();
    expect(deps.commitCutover).not.toHaveBeenCalled();
    expect(client.unmount).not.toHaveBeenCalled();
    expect(native.release).not.toHaveBeenCalled();
    expect(deps.setAssignmentState).toHaveBeenLastCalledWith(expect.objectContaining({ state: "quiescing" }));
  });

  describe("partial scheduler handoff", () => {
    const handoffId = "mig-op-1:scheduler:1:claim:4000";
    const schedulerCalls = (h: ReturnType<typeof mkDeps>) =>
      vi.mocked(h.client.scheduler).mock.calls.map(([request]) => [request.gatewayId, request.phase, request.retainNonportable]);

    it("moves portable schedules to Shared and leaves host-bound jobs dormant on the VM", async () => {
      const h = mkDeps();
      const native = nativeReturn(h);
      const order: string[] = [];
      vi.mocked(h.client.verifyTarget).mockImplementation(async () => {
        order.push("verify");
        return { migrationId: "mig-op-1", slug: "alice", ready: true, checks: { customerDir: true, coachWired: true, mountMarked: true } };
      });
      native.acknowledgeCompletedSchedulerHandoff.mockImplementation(async () => { order.push("acknowledge"); });
      native.park.mockImplementation(async () => { order.push("park"); return { parked: "suspended" }; });
      const snapshot = { version: 1, operationId: handoffId, agentIds: ["octogee-alice-coach"], jobs: [], scratch: [], retainedJobIds: ["desktop-watch"] };
      vi.mocked(h.client.quiesce).mockImplementation(async (request) => {
        order.push(`quiesce:${request.gatewayId}`);
        expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledWith({ migrationId: handoffId, fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" });
        return { migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 };
      });
      vi.mocked(h.client.scheduler).mockImplementation(async ({ gatewayId, phase, migrationId }) => {
        order.push(`${gatewayId}:${phase}`);
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot };
      });
      vi.mocked(h.deps.commitCutover).mockImplementation(async () => { order.push("cutover"); });
      vi.mocked(h.client.unmount).mockImplementation(async ({ gatewayId, slug }) => {
        order.push(`unmount:${gatewayId}`);
        return { migrationId: "mig-op-1", slug, unmounted: true };
      });

      expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
      expect(order).toEqual(["quiesce:gw-blue", "quiesce:gw-blue", "gw-blue:export", "gw-green:stage", "cutover", "gw-blue:retire", "unmount:gw-blue", "park", "gw-green:activate", "verify", "acknowledge"]);
      expect(vi.mocked(h.client.quiesce).mock.calls[1][0]).toMatchObject({ schedulerHandoff: true, schedulerMigrationId: handoffId, retainNonportable: true });
      expect(schedulerCalls(h)).toEqual([
        ["gw-blue", "export", true], ["gw-green", "stage", undefined], ["gw-blue", "retire", undefined], ["gw-green", "activate", undefined],
      ]);
      expect(vi.mocked(h.client.scheduler).mock.calls[1][0]).toMatchObject({ migrationId: handoffId, agentIds: ["octogee-alice-coach"], snapshot });
      expect(h.steps.filter((step) => step.status === "done").map((step) => step.name)).toEqual([
        "keys-sync-state", "wait-for-active-work", "quiesce-source", "flush-source", "transfer-agent-store", "stage-scheduler", "request-native-checkpoint", "cutover-firestore", "checkpoint-native-computer",
        "release-native-writers", "retire-source-scheduler", "unmount-source", "park-native-computer", "activate-scheduler", "verify-target",
      ]);
      expect(vi.mocked(h.deps.log).mock.calls.flat().join("\n")).toContain("desktop-watch");
    });

    it.each(["activate", "verify"])("does not attest completion when %s fails", async phase => {
      const h = mkDeps();
      const native = nativeReturn(h);
      if (phase === "verify") vi.mocked(h.client.verifyTarget).mockRejectedValue(new Error("target unavailable"));
      else vi.mocked(h.client.scheduler).mockImplementation(async ({ migrationId, phase }) => {
        if (phase === "activate") throw new Error("scheduler unavailable");
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: [] } };
      });
      expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: false, rolledBack: false });
      expect(native.acknowledgeCompletedSchedulerHandoff).not.toHaveBeenCalled();
    });





    it("stops the VM and leaves its exported copies fenced for the next activation when the live retire fails", async () => {
      const h = mkDeps();
      const native = nativeReturn(h);
      vi.mocked(h.client.scheduler).mockImplementation(async ({ phase, migrationId }) => {
        if (phase === "retire") throw new Error("VM unreachable");
        if (phase === "activate") expect(native.park).toHaveBeenCalledOnce();
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: [] } };
      });

      expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
      expect(schedulerCalls(h).map(([, phase]) => phase)).toEqual(["export", "stage", "retire", "activate"]);
      expect(h.client.unmount).not.toHaveBeenCalled();
      expect(native.park).toHaveBeenCalledExactlyOnceWith({ mode: "stop", reason: "live source cleanup failed: VM unreachable" });
      expect(vi.mocked(h.deps.log).mock.calls.flat().join("\n")).toContain(`stay fenced under ${handoffId}`);
    });

    it("does not report the schedules fenced once the live user retired them, even if its unmount then fails", async () => {
      const h = mkDeps();
      const native = nativeReturn(h);
      vi.mocked(h.client.unmount).mockRejectedValue(new MigrationRpcError("unmount refused", { status: 500 }));

      expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
      expect(schedulerCalls(h).map(([, phase]) => phase)).toEqual(["export", "stage", "retire", "activate"]);
      expect(native.park).toHaveBeenCalledExactlyOnceWith({ mode: "stop", reason: "live source cleanup failed: unmount refused" });
      expect(vi.mocked(h.deps.log).mock.calls.flat().join("\n")).not.toContain("stay fenced");
    });

    it("finishes the scheduler handoff when a retry finds the native return already cut over", async () => {
      const h = mkDeps({ sourceGatewayId: "gw-green" });
      const native = nativeReturn(h);
      const handoff = { migrationId: handoffId, fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" };
      const order: string[] = [];
      vi.mocked(h.client.scheduler).mockImplementation(async ({ gatewayId, phase, migrationId }) => {
        order.push(`${gatewayId}:${phase}`);
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true };
      });
      vi.mocked(h.client.unmount).mockImplementation(async ({ gatewayId, slug }) => {
        order.push(`unmount:${gatewayId}`);
        return { migrationId: "mig-op-1", slug, unmounted: true };
      });

      expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: handoff, attempts: 1, input: {
        uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
      } }), h.ctx)).toMatchObject({ success: true });
      expect(order).toEqual(["gw-blue:retire", "unmount:gw-blue", "gw-green:activate"]);
      expect(native.park).toHaveBeenCalledExactlyOnceWith({ mode: "suspend" });
      expect(h.client.verifyTarget).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-green" }));
      expect(h.client.transferState).not.toHaveBeenCalled();
    });

    it("re-exports portable schedules under a fresh handoff when a restart resumes a claimed checkpoint", async () => {
      const h = mkDeps();
      const native = nativeReturn(h);
      native.checkpointRequested = true;
      const previous = { migrationId: handoffId, fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" };
      const retried = "mig-op-1:scheduler:2:claim:6000";
      const order: string[] = [];
      vi.mocked(h.client.quiesce).mockImplementation(async (request) => {
        order.push(`quiesce:${request.gatewayId}:${request.schedulerMigrationId}:${request.retainNonportable}`);
        return { migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 };
      });
      vi.mocked(h.client.scheduler).mockImplementation(async ({ gatewayId, phase, migrationId }) => {
        order.push(`${gatewayId}:${phase}:${migrationId}`);
        return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: { retainedJobIds: [] } };
      });
      vi.mocked(h.deps.commitCutover).mockImplementation(async () => { order.push("cutover"); });

      expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: previous, attempts: 1, startedAt: 6_000 }), h.ctx)).toMatchObject({ success: true });
      expect(order).toEqual([
        `gw-green:abort:${handoffId}`, `gw-blue:resume:${handoffId}`,
        "quiesce:gw-blue:undefined:undefined",
        `quiesce:gw-blue:${retried}:true`, `gw-blue:export:${retried}`, `gw-green:stage:${retried}`,
        "cutover", `gw-blue:retire:${retried}`, `gw-green:activate:${retried}`,
      ]);
      expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledWith({ ...previous, migrationId: retried });
      expect(h.client.flushGateway).not.toHaveBeenCalled();
      expect(native.requestCheckpoint).toHaveBeenCalledOnce();
      expect(native.awaitCheckpoint).toHaveBeenCalledOnce();
    });
  });
});

describe("migrate-customer — gateway VM activation", () => {
  it("moves the user's schedules onto the VM through the user's schedule transfer record", async () => {
    const h = mkDeps();
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "isolated" });

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });

    expect(h.events.filter((event) => /^(schedules-|cutover:)/.test(event))).toEqual([
      "schedules-saved:uid-alice/mig-op-1", "cutover:gw-blue->gw-green:mirror=true", "schedules-restored:uid-alice/mig-op-1:gw-green",
    ]);
    expect(h.client.calls.filter((call) => call.startsWith("schedules:") || call.startsWith("unmount:"))).toEqual([
      "schedules:gw-blue:snapshot", "schedules:gw-blue:remove", "schedules:gw-green:restore", "unmount:gw-blue",
    ]);
    expect(h.transfers.get("uid-alice/mig-op-1")).toMatchObject({ sourceGatewayId: "gw-blue", targetGatewayId: "gw-green", records: [STANDUP], restoredTo: "gw-green" });
    expect(h.client.scheduler).not.toHaveBeenCalled();
    expect(vi.mocked(h.client.quiesce).mock.calls.every(([request]) => request.schedulerHandoff === undefined)).toBe(true);
  });

  it("converges the user's durable config on the source's accepted commit before verifying", async () => {
    const h = mkDeps();
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "isolated" });

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });

    expect(vi.mocked(h.client.flushGateway).mock.calls.map(([request]) => request)
      .filter((request) => request.gatewayId === "gw-green")).toEqual([expect.objectContaining({
      reason: "migration-converge",
      expectedSystemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
    })]);
  });

  it("converges a user returning from a shared gateway on the user's own accepted commit", async () => {
    const h = mkDeps();
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, gatewayClass: "shared" });
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "isolated" });
    vi.mocked(h.client.flushGateway).mockImplementation(async ({ migrationId, slug }) => ({
      migrationId, slug, ok: true, durationMs: 1, steps: [],
    }));

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });

    expect(h.deps.readGatewaySystemConfigCommit).toHaveBeenCalledWith("gw-green");
    expect(vi.mocked(h.client.flushGateway).mock.calls.map(([request]) => request)
      .filter((request) => request.gatewayId === "gw-green")).toEqual([expect.objectContaining({
      reason: "migration-converge",
      expectedSystemConfigCommit: TARGET_SYSTEM_CONFIG_COMMIT,
    })]);
  });

  it("waits for a fresh user's first accepted commit before converging on it", async () => {
    const h = mkDeps();
    freshUserFromSharedGateway(h, [null, null, TARGET_SYSTEM_CONFIG_COMMIT]);

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });

    expect(h.deps.readGatewaySystemConfigCommit).toHaveBeenCalledTimes(3);
    expect(targetConvergeRequests(h)).toEqual([expect.objectContaining({
      reason: "migration-converge",
      expectedSystemConfigCommit: TARGET_SYSTEM_CONFIG_COMMIT,
    })]);
  });

  it("fails the attempt once a fresh user has accepted no commit within the wait", async () => {
    const h = mkDeps();
    freshUserFromSharedGateway(h, [null]);

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({
      success: false,
      rolledBack: false,
      error: expect.stringContaining("destination recovery pending: status 503: target gw-green has no accepted system config commit"),
    });

    expect(vi.mocked(h.deps.sleep).mock.calls.reduce((slept, [ms]) => slept + ms, 0)).toBe(FRESH_TARGET_CONFIG_COMMIT_WAIT_MS);
    expect(targetConvergeRequests(h)).toEqual([]);
  });

  it("never converges a fresh user on an attempt that lost its claim during the commit read", async () => {
    const h = mkDeps();
    freshUserFromSharedGateway(h, [TARGET_SYSTEM_CONFIG_COMMIT]);
    loseClaimDuringCommitRead(h);

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({
      success: false,
      rolledBack: false,
      error: expect.stringContaining("destination recovery pending: status 503: operation op-1 claim lost"),
    });
    expect(targetConvergeRequests(h)).toEqual([]);
  });

  it("fails a User-to-User activation whose source flush proves no commit", async () => {
    const h = mkDeps();
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, gatewayClass: "isolated" });
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "isolated" });
    vi.mocked(h.client.flushGateway).mockImplementation(async ({ migrationId, slug }) => ({
      migrationId, slug, ok: true, durationMs: 1, steps: [],
    }));

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: false });
    expect(h.deps.readGatewaySystemConfigCommit).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
  });

  it("never converges a Shared target, which holds no durable config", async () => {
    const h = mkDeps();

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });

    expect(vi.mocked(h.client.flushGateway).mock.calls.map(([request]) => request)
      .filter((request) => request.gatewayId === "gw-green")).toEqual([]);
  });
});

describe("migrate-customer — User activation onto a held VM", () => {
  const deferred = {
    migrationId: "mig-op-1:scheduler:1:claim:4000", fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice",
    stageAfterCutover: true as const,
    scheduleTransfer: true as const,
  };

  function heldActivation(options: { sourceGatewayId?: string } = {}) {
    const h = mkDeps(options);
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "isolated" });
    const order: string[] = [];
    const schedules = vi.mocked(h.client.schedules).getMockImplementation()!;
    vi.mocked(h.client.schedules).mockImplementation(async (request) => {
      order.push(`${request.gatewayId}:${request.op}`);
      return schedules(request);
    });
    vi.mocked(h.deps.commitCutover).mockImplementation(async () => { order.push("cutover"); });
    vi.mocked(h.ctx.persistSchedulerHandoff!).mockImplementation(async (state) => { order.push(`persist:${JSON.stringify(state)}`); });
    vi.mocked(h.client.unmount).mockImplementation(async ({ gatewayId, slug }) => {
      order.push(`unmount:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, unmounted: true };
    });
    return { ...h, order };
  }

  it("snapshots the source after it is fenced and recreates the schedules on the VM only after cutover releases it", async () => {
    const h = heldActivation();

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });

    expect(h.order).toEqual([
      `persist:${JSON.stringify(deferred)}`,
      "gw-blue:snapshot",
      "gw-blue:remove",
      `persist:${JSON.stringify({ ...deferred, forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 4, sourceSystemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT } })}`,
      "cutover", "gw-green:restore", "unmount:gw-blue",
    ]);
  });

  it("persists a Shared target's handoff without the held-vm marker", async () => {
    const h = mkDeps();
    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
    expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledTimes(2);
    expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledWith({
      scheduleTransfer: true,
      migrationId: "mig-op-1:scheduler:1:claim:4000", fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice",
    });
  });

  it.each([false, true])("retires deferred native schedules before the VM restore (retry=%s)", async retry => {
    const h = heldActivation(retry ? { sourceGatewayId: "gw-green" } : {});
    if (retry) h.transfers.set("uid-alice/mig-op-1", PENDING_SCHEDULES);
    vi.mocked(h.deps.retireNativeSchedulerBeforeStage).mockImplementation(async input => {
      expect(input).toEqual({ uid: "uid-alice", slug: "alice", gatewayId: "gw-green", operationId: "op-1", claimedStartedAt: 4_000 });
      h.order.push("retire-deferred-native");
    });
    const op = mkOp({ startedAt: 4_000, ...(retry ? { schedulerHandoff: deferred, attempts: 1, cutoverCommittedAt: 4_000 } : {}) });
    expect(await createMigrateUserHandler(h.deps)(op, h.ctx)).toMatchObject({ success: true });
    expect(h.order.indexOf("retire-deferred-native")).toBeGreaterThan(-1);
    expect(h.order.indexOf("retire-deferred-native")).toBeLessThan(h.order.indexOf("gw-green:restore"));
  });

  it("restores a rolled-back snapshot to the source without retiring native schedules there", async () => {
    const h = heldActivation();
    vi.mocked(h.client.flushGateway).mockRejectedValue(new Error("durable checkpoint unavailable"));

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: false, rolledBack: true });

    expect(h.order.filter((call) => /:(snapshot|restore)$/.test(call))).toEqual(["gw-blue:snapshot", "gw-blue:restore"]);
    expect(h.transfers.get("uid-alice/mig-op-1")).toMatchObject({ restoredTo: "gw-blue" });
    expect(h.deps.retireNativeSchedulerBeforeStage).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps native retirement failure pending before schedule restore (postcutover retry: %s)", async retry => {
    const h = heldActivation(retry ? { sourceGatewayId: "gw-green" } : {});
    if (retry) h.transfers.set("uid-alice/mig-op-1", PENDING_SCHEDULES);
    vi.mocked(h.deps.commitCutover).mockImplementation(async () => {
      h.order.push("cutover");
      vi.mocked(h.deps.readUser).mockResolvedValue({ slug: "alice", currentGatewayId: "gw-green" });
    });
    vi.mocked(h.deps.retireNativeSchedulerBeforeStage).mockRejectedValue(new Error("native scheduler retirement authority changed"));
    const op = mkOp(retry ? { schedulerHandoff: deferred, attempts: 1, cutoverCommittedAt: 4_000 } : {});

    const result = await createMigrateUserHandler(h.deps)(op, h.ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toContain("status 503");
    expect(result.error).toContain("native scheduler retirement authority changed");
    expect(h.order).not.toContain("gw-green:restore");
    expect(h.order).not.toContain("unmount:gw-blue");
    expect(h.transfers.get("uid-alice/mig-op-1")?.restoredTo).toBeUndefined();
    vi.mocked(h.deps.retireNativeSchedulerBeforeStage).mockResolvedValue(undefined);
    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: deferred, attempts: 1, cutoverCommittedAt: 4_000 }), h.ctx))
      .toMatchObject({ success: true, rolledBack: false });
    expect(h.order).toContain("gw-green:restore");
    expect(h.order).toContain("unmount:gw-blue");
  });

  it("restores the persisted snapshot when a retry finds the cutover committed", async () => {
    const h = heldActivation({ sourceGatewayId: "gw-green" });
    h.transfers.set("uid-alice/mig-op-1", PENDING_SCHEDULES);

    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: deferred, attempts: 1, cutoverCommittedAt: 4_000 }), h.ctx))
      .toMatchObject({ success: true });

    expect(h.order).toEqual(["gw-green:restore", "unmount:gw-blue"]);
    expect(h.client.schedules).toHaveBeenCalledWith({ migrationId: "mig-op-1", slug: "alice", gatewayId: "gw-green", op: "restore", records: [STANDUP] });
    expect(h.transfers.get("uid-alice/mig-op-1")).toMatchObject({ restoredTo: "gw-green", restoredAt: 5_000, restoreFailures: [] });
    expect(h.client.scheduler).not.toHaveBeenCalled();
  });

  it("activates the assigned user after losing the cutover acknowledgment", async () => {
    const h = heldActivation({ sourceGatewayId: "gw-green" });
    const handoff = { ...deferred, fromGatewayId: "shared-blue" };
    const result = await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: handoff, attempts: 20 }), h.ctx);
    expect(result).toMatchObject({ success: true });
    expect(h.client.resume).toHaveBeenCalledWith({ migrationId: "mig-op-1", gatewayId: "gw-green", slug: "alice", role: "target" });
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    expect(h.client.transferState).not.toHaveBeenCalled();
  });

  it("keeps assignment recovery pending while the owner read is unavailable", async () => {
    const h = heldActivation();
    vi.mocked(h.deps.readUser).mockRejectedValue(new Error("unavailable"));
    const result = await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: deferred }), h.ctx);
    expect(result).toMatchObject({ success: false, error: "migration ownership lookup pending: status 503: unavailable" });
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.client.unmount).not.toHaveBeenCalled();
  });

  it("does not restore again once the snapshot is recorded restored", async () => {
    const h = heldActivation({ sourceGatewayId: "gw-green" });
    h.transfers.set("uid-alice/mig-op-1", { ...PENDING_SCHEDULES, restoredTo: "gw-green", restoredAt: 4_800, restoreFailures: [] });

    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: deferred, attempts: 1 }), h.ctx))
      .toMatchObject({ success: true });

    expect(h.order).toEqual(["unmount:gw-blue"]);
  });

  it("keeps a committed cutover in forward recovery, the snapshot pending, while the VM cannot yet restore schedules", async () => {
    const h = heldActivation({ sourceGatewayId: "gw-green" });
    h.transfers.set("uid-alice/mig-op-1", PENDING_SCHEDULES);
    vi.mocked(h.client.schedules).mockRejectedValue(new MigrationRpcError("/schedules/gw-green: 503 OpenClaw is starting", { status: 503 }));

    const result = await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: deferred, attempts: 5, cutoverCommittedAt: 4_000 }), h.ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.failedAfterCutover).toBeUndefined();
    expect(result.error).toMatch(/^migration cutover committed; destination recovery pending: status 503: .*503 OpenClaw is starting/u);
    expect(classifyOperationFailure(result.error)).toBe("transient");
    expect(h.order).toEqual([]);
    expect(h.transfers.get("uid-alice/mig-op-1")).toMatchObject({ restoreAttemptedTo: "gw-green" });
    expect(h.transfers.get("uid-alice/mig-op-1")?.restoredTo).toBeUndefined();
  });

  it("keeps a committed cutover in forward recovery while its transfer record cannot be read, and restores the schedules on the retry", async () => {
    const h = heldActivation({ sourceGatewayId: "gw-green" });
    h.transfers.set("uid-alice/mig-op-1", PENDING_SCHEDULES);
    vi.mocked(h.deps.readScheduleTransfer).mockRejectedValueOnce(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    const op = { schedulerHandoff: deferred, attempts: 1, cutoverCommittedAt: 4_000 };

    const first = await createMigrateUserHandler(h.deps)(mkOp(op), h.ctx);

    expect(first).toMatchObject({ success: false, rolledBack: false });
    expect(first.failedAfterCutover).toBeUndefined();
    expect(first.error).toMatch(/^migration cutover committed; destination recovery pending: status 503: .*read ECONNRESET/u);
    expect(buildOperationCompletionUpdate({ op: { kind: "migrate-user", ...op }, result: first, steps: [], now: 5_000 }))
      .toMatchObject({ status: "pending", attempts: 2 });
    expect(h.order).toEqual([]);
    expect(h.transfers.get("uid-alice/mig-op-1")).toEqual(PENDING_SCHEDULES);

    expect(await createMigrateUserHandler(h.deps)(mkOp({ ...op, attempts: 2 }), h.ctx)).toMatchObject({ success: true });
    expect(h.order).toEqual(["gw-green:restore", "unmount:gw-blue"]);
    expect(h.transfers.get("uid-alice/mig-op-1")).toMatchObject({ restoredTo: "gw-green", restoreFailures: [] });
  });

  it("fails a committed cutover, without rolling it back, when the VM refuses to restore schedules", async () => {
    const h = heldActivation({ sourceGatewayId: "gw-green" });
    h.transfers.set("uid-alice/mig-op-1", PENDING_SCHEDULES);
    const refusal = '/schedules/gw-green: 500 {"error":"schedule transfer failed","message":"restore failed","retryable":false}';
    vi.mocked(h.client.schedules).mockRejectedValue(new MigrationRpcError(refusal, { status: 500, retryable: false }));

    const result = await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: deferred, attempts: 1, cutoverCommittedAt: 4_000 }), h.ctx);

    const error = "schedules were not restored after the cutover onto gw-green: 1 schedule not restored, 0 scheduler fences kept";
    expect(result).toEqual({
      steps: [], success: false, rolledBack: false, failedAfterCutover: true, error,
      output: { scheduleRestoreFailures: [{ gatewayId: "gw-green", agentId: STANDUP.agentId, sourceJobId: STANDUP.sourceJobId, job: "standup", error: refusal }] },
    });
    expect(h.order).toEqual(["unmount:gw-blue"]);
    expect(h.transfers.get("uid-alice/mig-op-1")?.restoredTo).toBeUndefined();
    expect(h.deps.log).toHaveBeenCalledWith(`[migrate-customer] ❌ alice: ${error} op=op-1`);
  });

  it("keeps a committed cutover in forward recovery while the VM lost its scheduler connection or a model's auth profile cooled down", async () => {
    const h = heldActivation({ sourceGatewayId: "gw-green" });
    const brief: ScheduleRecord = { sourceJobId: "job-brief", agentId: "octogee-alice-coach", job: { name: "brief", schedule: { kind: "cron", expr: "0 8 * * *" } } };
    h.transfers.set("uid-alice/mig-op-1", { ...PENDING_SCHEDULES, records: [STANDUP, brief] });
    const timeout = "cron.add response timed out after 30000ms";
    const cooldown = 'invalid cron.add params: Auth profile "platform-openai:default" is temporarily unavailable for platform-openai/gpt-6.1-terra.';
    vi.mocked(h.client.schedules).mockResolvedValue({
      migrationId: "mig-op-1", slug: "alice", op: "restore", created: 0, existing: 0, failed: [
        { name: "standup", agentId: STANDUP.agentId, sourceJobId: STANDUP.sourceJobId, error: timeout, retryable: true },
        { name: "brief", agentId: brief.agentId, sourceJobId: brief.sourceJobId, error: cooldown, retryable: true },
      ],
    } as never);
    const op = { schedulerHandoff: deferred, attempts: 1, cutoverCommittedAt: 4_000 };

    const result = await createMigrateUserHandler(h.deps)(mkOp(op), h.ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.failedAfterCutover).toBeUndefined();
    expect(result.error).toMatch(/^migration cutover committed; destination recovery pending: status 503: /u);
    expect(result.error).toContain(`2 of 2 unrestored schedules on gw-green may yet be restored: ${timeout}`);
    expect(buildOperationCompletionUpdate({ op: { kind: "migrate-user", ...op }, result, steps: [], now: 5_000 }))
      .toMatchObject({ status: "pending", attempts: 2 });
    expect(h.order).toEqual([]);
    expect(h.transfers.get("uid-alice/mig-op-1")?.restoredTo).toBeUndefined();
  });

  it("keeps native activation pending when the target cannot be reached for scheduler retirement", async () => {
    const h = heldActivation({ sourceGatewayId: "gw-green" });
    h.transfers.set("uid-alice/mig-op-1", PENDING_SCHEDULES);
    vi.mocked(h.deps.resolveGatewayUrl).mockImplementation(async (gatewayId) => {
      if (gatewayId === "gw-green") throw new Error("gateway not registered in glmGateways: gw-green");
      return `http://${gatewayId}.svc:3003`;
    });

    const result = await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: deferred, attempts: 1, cutoverCommittedAt: 4_000 }), h.ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toContain("status 503: gateway not registered in glmGateways: gw-green");
    expect(h.order).toEqual([]);
    expect(h.transfers.get("uid-alice/mig-op-1")?.restoredTo).toBeUndefined();
  });

  it("resumes only the source when a retry follows a pre-cutover failure: the held VM never received anything", async () => {
    const h = heldActivation();
    const scheduler = vi.mocked(h.client.scheduler).getMockImplementation()!;
    vi.mocked(h.client.scheduler).mockImplementation(async (request) => {
      h.order.push(`${request.gatewayId}:${request.phase}:${request.migrationId}`);
      return scheduler(request);
    });

    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: deferred, attempts: 1, startedAt: 6_000 }), h.ctx)).toMatchObject({ success: true });

    expect(h.order.filter((call) => call.includes(`:${deferred.migrationId}`))).toEqual([`gw-blue:resume:${deferred.migrationId}`]);
  });

  it("retries, never fails terminally, when a staged attempt's target cannot yet abort it", async () => {
    const h = mkDeps();
    const held = '/scheduler/gw-green: 500 {"error":"scheduler migration failed","message":"OpenClaw workspace identities are not initialized for this boot"}';
    const previous = { migrationId: "mig-op-1:scheduler:1:claim:4000", fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" };
    vi.mocked(h.client.scheduler).mockImplementation(async ({ gatewayId, phase }) => {
      if (gatewayId === "gw-green" && phase === "abort") throw new Error(held);
      throw new Error(`unexpected ${gatewayId}:${phase}`);
    });

    const result = await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: previous, attempts: 1, startedAt: 6_000 }), h.ctx);

    expect(result.success).toBe(false);
    expect(classifyOperationFailure(result.error)).toBe("transient");
    expect(h.client.quiesce).not.toHaveBeenCalled();
  });
});

describe("a returned VM's scheduler custody at the next activation", () => {
  const VM = "gw-blue", SHARED = "gw-green", COACH = "octogee-alice-coach", CHECK = "Proactive check", WATCH = "Inbox watch";
  const RETURN_ID = builderReturnOperationId(VM, 1);
  const RETURN_SCHEDULER = `mig-${RETURN_ID}:scheduler:1:claim:4000`;
  const ACTIVATION_ID = "op-activate", ACTIVATED_AT = 9_000;
  const RELEASE = `mig-${ACTIVATION_ID}:release:${COACH}`;
  const computer = { instanceName: "vm-alice", instanceId: "1234", zone: "us-central1-a" };
  const homeDisk = { id: "4321", source: "home-alice" };

  function retainedVm() {
    const records: Record<string, Record<string, unknown>> = {
      "users/uid-alice": { username: "alice", provisioning: { openclaw: { slug: "alice", gatewayId: VM }, homeDisk } },
      [`gateways/${VM}`]: {
        gatewayId: VM, gatewayClass: "isolated", ownerUid: "uid-alice", builderSlug: "alice", desiredStatus: "running",
        desiredRelease: 1, liveRelease: 1, latestRelease: 1,
      },
      [`glmGateways/${VM}`]: { docKind: "runtime", gatewayId: VM, release: 1, lifecycle: "serving", runtime: "gce-vm",
        vm: { ...computer, internalIp: "10.0.0.4", status: "RUNNING" } },
    };
    const store = createDocumentFixtureStore(records);
    const log = vi.fn();
    const vm = { describe: vi.fn(async () => ({ instanceId: computer.instanceId, gatewayId: VM, status: "RUNNING" })) };
    const retire: MigrateUserDeps["retireNativeSchedulerBeforeStage"] = (input, scheduler) =>
      retireNativeSchedulerBeforeStage({ store, vm: vm as never, log }, input, scheduler);
    const provisioning = () => records["users/uid-alice"].provisioning as Record<string, unknown>;
    return {
      store, records, log, retire,
      pending: () => provisioning().pendingNativeSchedulerRetirement,
      forgetPending: () => { delete provisioning().pendingNativeSchedulerRetirement; },
      park: (migrationId: string) => {
        provisioning().pendingNativeSchedulerRetirement = {
          uid: "uid-alice", slug: "alice", returnOperationId: RETURN_ID, migrationId, sourceGatewayId: VM, sharedGatewayId: SHARED,
          ...computer, homeDiskId: homeDisk.id, homeDiskSource: homeDisk.source,
        };
      },
      completeReturn: (cutoverCommittedAt: number) => {
        Object.assign(provisioning().pendingNativeSchedulerRetirement as object, { completedAt: cutoverCommittedAt + 100, cutoverCommittedAt });
      },
      journal: (id: string, row: Record<string, unknown>) => { records[`glmOperations/${id}`] = row; },
    };
  }
  type RetainedVm = ReturnType<typeof retainedVm>;

  function custodyGateways() {
    const custody = createCronCustodyGateways({ alice: [COACH] });
    custody.store(VM).add({ agentId: COACH, name: CHECK, enabled: true });
    const watch = custody.store(VM).add({ agentId: COACH, name: WATCH, enabled: true, schedule: { kind: "event" } });
    return { custody, watch };
  }

  function onCustody(h: ReturnType<typeof mkDeps>, custody: CronCustodyGateways, wrap = (client: MigrationClient) => client): void {
    vi.mocked(h.client.transferState).mockImplementation(async ({ migrationId, slug }) => ({ migrationId, slug, imported: true }));
    h.deps.buildClient = resolveGatewayUrl => wrap(custody.client(h.client, resolveGatewayUrl));
  }

  async function returnToShared(custody: CronCustodyGateways, vm: RetainedVm, source: "running" | "stopped" | "unmount-fails" = "running") {
    const h = mkDeps();
    onCustody(h, custody);
    const native = mockNativeReturn();
    h.deps.prepareNativeVmReturn = vi.fn(async () => native);
    if (source === "stopped") native.sourceVmStatus.mockResolvedValue("TERMINATED");
    if (source === "unmount-fails") vi.mocked(h.client.unmount).mockRejectedValue(new Error("unmount timed out"));
    let handoff: Operation["schedulerHandoff"];
    let cutoverCommittedAt = 0;
    vi.mocked(h.ctx.persistSchedulerHandoff!).mockImplementation(async state => { handoff = { ...state }; });
    vi.mocked(h.ctx.persistCutoverCommitted!).mockImplementation(async at => { cutoverCommittedAt = at; });
    const park = native.park.getMockImplementation()!;
    native.park.mockImplementation(async request => {
      vm.park(handoff!.migrationId);
      return park(request);
    });
    native.acknowledgeCompletedSchedulerHandoff.mockImplementation(async () => vm.completeReturn(cutoverCommittedAt));
    const op = mkOp({ id: RETURN_ID, input: { uid: "uid-alice", fromGatewayId: VM, toGatewayId: SHARED } });
    const result = await createMigrateUserHandler(h.deps)(op, h.ctx);
    expect(result).toMatchObject({ success: true });
    expect(handoff?.migrationId).toBe(RETURN_SCHEDULER);
    const { id: _id, ...row } = op;
    vm.journal(RETURN_ID, {
      ...row, origin: "automatic", inputUid: "uid-alice", gatewayId: SHARED, status: "succeeded", completedAt: cutoverCommittedAt + 100,
      cutoverCommittedAt, schedulerHandoff: handoff, schedulerHandoffReleased: true,
    });
    return result;
  }

  async function activateOntoVm(
    custody: CronCustodyGateways, vm: RetainedVm,
    options: { attempts?: number; wrap?: (client: MigrationClient) => MigrationClient; id?: string; at?: number } = {},
  ) {
    const { attempts, wrap, id = ACTIVATION_ID, at = ACTIVATED_AT } = options;
    const h = mkDeps({ sourceGatewayId: SHARED });
    onCustody(h, custody, wrap);
    vi.mocked(h.deps.now).mockReturnValue(at);
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "isolated" });
    vi.mocked(h.deps.commitCutover).mockImplementation(async () => {
      vi.mocked(h.deps.readUser).mockResolvedValue({ slug: "alice", currentGatewayId: VM });
    });
    h.deps.retireNativeSchedulerBeforeStage = vm.retire;
    h.deps.readOperation = vi.fn(async (operationId: string) => vm.store.journal.operations.get(operationId));
    h.deps.readUserAgentIds = vi.fn(async () => [COACH]);
    const op = mkOp({ id, input: { uid: "uid-alice", toGatewayId: VM }, ...(attempts === undefined ? {} : { attempts }) });
    const { id: _id, ...row } = op;
    vm.journal(id, { ...row, origin: "automatic", inputUid: "uid-alice", gatewayId: VM });
    vi.mocked(h.ctx.persistCutoverCommitted!).mockImplementation(async committedAt => {
      vm.records[`glmOperations/${id}`].cutoverCommittedAt = committedAt;
    });
    const result = await createMigrateUserHandler(h.deps)(op, h.ctx);
    const logs = [...vi.mocked(h.deps.log).mock.calls.flat(), ...vm.log.mock.calls.flat()].map(String);
    return { h, result, logs };
  }

  function restoredOnVm(custody: CronCustodyGateways, watch: CustodyJob): void {
    const onVm = custody.store(VM);
    expect(onVm.fences.has(COACH)).toBe(false);
    expect(onVm.agentJobs(COACH).map(job => job.name).sort()).toEqual([WATCH, CHECK].sort());
    expect(onVm.agentJobs(COACH).every(job => onVm.runnable(job.id))).toBe(true);
    expect(onVm.runnable(watch.id)).toBe(true);
    expect(custody.store(SHARED).agentJobs(COACH)).toEqual([]);
  }

  it.each(["running", "stopped", "unmount-fails"] as const)(
    "restores the agent's schedules on the VM and frees its host-bound job when it activates after a return from a %s source", async source => {
      const { custody, watch } = custodyGateways();
      const vm = retainedVm();
      await returnToShared(custody, vm, source);
      expect(custody.store(SHARED).agentJobs(COACH)).toEqual([expect.objectContaining({ name: CHECK, enabled: true })]);
      expect(custody.store(VM).fences.get(COACH)).toBe(RETURN_SCHEDULER);
      expect(custody.store(VM).status(RETURN_SCHEDULER)).toBe(source === "stopped" ? "exported" : "retired");
      expect(custody.store(VM).runnable(watch.id)).toBe(false);

      const { result, logs } = await activateOntoVm(custody, vm);

      expect(result).toMatchObject({ success: true, rolledBack: false });
      expect(result.output).toBeUndefined();
      restoredOnVm(custody, watch);
      expect(vm.pending()).toBeUndefined();
      expect(custody.store(VM).status(RELEASE)).toBe("activated");
      expect(logs).toContainEqual(`[migrate-customer] alice: retired exported native schedules ${RETURN_SCHEDULER} on retained VM 1234`);
      expect(logs).toContainEqual(`[scheduler-custody] alice: released the scheduler custody of ${COACH} on ${VM} with ${RELEASE} op=${ACTIVATION_ID}`);
      expect(logs.filter(line => /⚠|❌/.test(line))).toEqual([]);
    },
  );

  it.each([
    ["retired", "journaled"],
    ["retired", "pruned from the journal"],
    ["exported", "journaled"],
  ] as const)("releases a leftover %s fence whose return is %s, without a pending retirement", async (row, journal) => {
    const { custody, watch } = custodyGateways();
    const vm = retainedVm();
    await returnToShared(custody, vm, row === "retired" ? "running" : "stopped");
    vm.forgetPending();
    if (journal === "pruned from the journal") delete vm.records[`glmOperations/${RETURN_ID}`];

    const { result, logs } = await activateOntoVm(custody, vm);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(result.output).toBeUndefined();
    restoredOnVm(custody, watch);
    expect(custody.store(VM).status(RETURN_SCHEDULER)).toBe("retired");
    expect(logs).toContainEqual(expect.stringContaining(`released the scheduler custody of ${COACH} on ${VM}`));
    expect(logs.filter(line => /⚠|❌/.test(line))).toEqual([]);
  });

  it("releases a leftover retired fence when there is nothing to restore, and the host-bound job runs", async () => {
    const custody = createCronCustodyGateways({ alice: [COACH] });
    const onVm = custody.store(VM);
    const watch = onVm.add({ agentId: COACH, name: WATCH, enabled: true, schedule: { kind: "event" } });
    onVm.migrate({ operationId: RETURN_SCHEDULER, phase: "hold", agentIds: [COACH], retainNonportable: true });
    onVm.migrate({ operationId: RETURN_SCHEDULER, phase: "export", retainNonportable: true });
    onVm.migrate({ operationId: RETURN_SCHEDULER, phase: "retire" });
    const vm = retainedVm();

    const { result, logs } = await activateOntoVm(custody, vm);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(result.output).toBeUndefined();
    expect(logs).toContainEqual(expect.stringContaining(`released the scheduler custody of ${COACH} on ${VM}`));
    expect(onVm.fences.has(COACH)).toBe(false);
    expect(onVm.runnable(watch.id)).toBe(true);
  });

  it("keeps the jobs of a rolled-back return's exported fence once that return has left the journal", async () => {
    const custody = createCronCustodyGateways({ alice: [COACH] });
    const onVm = custody.store(VM);
    const check = onVm.add({ agentId: COACH, name: CHECK, enabled: true });
    const watch = onVm.add({ agentId: COACH, name: WATCH, enabled: true, schedule: { kind: "event" } });
    onVm.migrate({ operationId: RETURN_SCHEDULER, phase: "hold", agentIds: [COACH], retainNonportable: true });
    onVm.migrate({ operationId: RETURN_SCHEDULER, phase: "export", retainNonportable: true });
    const vm = retainedVm();
    const reason = `${RETURN_SCHEDULER} is not retired and ${RETURN_ID} has left the journal`;

    const { result, logs } = await activateOntoVm(custody, vm);

    expect(result).toMatchObject({
      success: false, rolledBack: false, failedAfterCutover: true,
      error: `schedules were not restored after the cutover onto ${VM}: 0 schedules not restored, 1 scheduler fence kept`,
    });
    expect(result.output).toEqual({ unreleasedSchedulerFences: [{ gatewayId: VM, agentId: COACH, holder: RETURN_SCHEDULER, reason }] });
    expect(custody.calls.filter(call => call.includes(":retire:"))).toEqual([]);
    expect(onVm.status(RETURN_SCHEDULER)).toBe("exported");
    expect(onVm.fences.get(COACH)).toBe(RETURN_SCHEDULER);
    expect([...onVm.jobs.keys()].sort()).toEqual([check.id, watch.id].sort());
    expect(logs).toContainEqual(
      `[scheduler-custody] ⚠ alice: kept the scheduler fence of ${COACH} on ${VM} held by ${RETURN_SCHEDULER}: ${reason} op=${ACTIVATION_ID}`);
  });

  it("leaves the transfer unrestored when the activation keeps a fence but every schedule restores, and a rerun creates nothing", async () => {
    const SITE = "octogee-alice-site", DIGEST = "Site digest";
    const custody = createCronCustodyGateways({ alice: [COACH, SITE] });
    const onVm = custody.store(VM);
    const watch = onVm.add({ agentId: COACH, name: WATCH, enabled: true, schedule: { kind: "event" } });
    onVm.migrate({ operationId: RETURN_SCHEDULER, phase: "hold", agentIds: [COACH], retainNonportable: true });
    onVm.migrate({ operationId: RETURN_SCHEDULER, phase: "export", retainNonportable: true });
    custody.store(SHARED).add({ agentId: SITE, name: DIGEST, enabled: true });
    const vm = retainedVm();
    const reason = `${RETURN_SCHEDULER} is not retired and ${RETURN_ID} has left the journal`;
    const transfer = `mig-${ACTIVATION_ID}`;
    const restores = () => custody.calls.filter(call => call === `schedules:${VM}:restore`).length;

    const { result, logs, h } = await activateOntoVm(custody, vm);

    expect(result).toMatchObject({
      success: false, rolledBack: false, failedAfterCutover: true,
      error: `schedules were not restored after the cutover onto ${VM}: 0 schedules not restored, 1 scheduler fence kept`,
    });
    expect(result.output).toEqual({ unreleasedSchedulerFences: [{ gatewayId: VM, agentId: COACH, holder: RETURN_SCHEDULER, reason }] });
    expect(onVm.fences.get(COACH)).toBe(RETURN_SCHEDULER);
    expect(onVm.runnable(watch.id)).toBe(false);
    expect(onVm.agentJobs(SITE).map(job => job.name)).toEqual([DIGEST]);
    expect(logs).toContainEqual(
      `[scheduler-custody] ⚠ alice: kept the scheduler fence of ${COACH} on ${VM} held by ${RETURN_SCHEDULER}: ${reason} op=${ACTIVATION_ID}`);
    expect(logs).toContainEqual(
      `[migrate-customer] ❌ alice: schedules were not restored after the cutover onto ${VM}: 0 schedules not restored, 1 scheduler fence kept op=${ACTIVATION_ID}`);
    expect(h.transfers.get(`uid-alice/${transfer}`)).toMatchObject({ restoreAttemptedTo: VM, restoreFailures: [] });
    expect(h.transfers.get(`uid-alice/${transfer}`)).not.toHaveProperty("restoredTo");
    expect(restores()).toBe(1);

    const rerun = {
      client: custody.client(h.client, gateway => `http://${gateway}.fixture:3003`),
      log: vi.fn(),
      now: () => ACTIVATED_AT + 1,
      readScheduleTransfer: (migrationId: string) => h.deps.readScheduleTransfer("uid-alice", migrationId),
      recordScheduleRestore: (migrationId: string, restore: ScheduleRestoreRecord) => h.deps.recordScheduleRestore("uid-alice", migrationId, restore),
    };
    expect(await restoreScheduleTransfer(rerun, { migrationId: transfer, slug: "alice", gatewayId: VM, custodyReleased: false })).toEqual([]);

    expect(restores()).toBe(1);
    expect(onVm.agentJobs(SITE)).toHaveLength(1);
    expect(h.transfers.get(`uid-alice/${transfer}`)).not.toHaveProperty("restoredTo");
  });

  function liveHold(custody: CronCustodyGateways, vm: RetainedVm) {
    const liveScheduler = "mig-op-live:scheduler:1:claim:3000";
    custody.store(VM).jobs.clear();
    custody.store(SHARED).add({ agentId: COACH, name: CHECK, enabled: true });
    custody.store(VM).migrate({ operationId: liveScheduler, phase: "hold", agentIds: [COACH] });
    vm.journal("op-live", { kind: "migrate-user", status: "running", createdBy: "admin@octogee.com", createdAt: 2_000, startedAt: 3_000,
      input: { uid: "uid-alice", fromGatewayId: VM, toGatewayId: SHARED }, steps: [] });
    return liveScheduler;
  }

  it("keeps a fence whose owning operation is still running, and records the schedule it blocked", async () => {
    const { custody } = custodyGateways();
    const vm = retainedVm();
    const liveScheduler = liveHold(custody, vm);

    const { result, logs, h } = await activateOntoVm(custody, vm);

    expect(result).toMatchObject({ success: false, rolledBack: false, failedAfterCutover: true });
    expect(custody.store(VM).fences.get(COACH)).toBe(liveScheduler);
    expect(custody.store(VM).status(liveScheduler)).toBe("held");
    expect(custody.store(VM).agentJobs(COACH)).toEqual([]);
    expect(custody.calls.filter(call => call.includes(liveScheduler))).toEqual([]);
    expect(result.output).toEqual({
      scheduleRestoreFailures: [{
        gatewayId: VM, agentId: COACH, sourceJobId: expect.any(String), job: CHECK,
        error: `CronAgentMigrationHeldError: Cron agent ${COACH} is held for migration ${liveScheduler} (fence kept: op-live is still running)`,
      }],
      unreleasedSchedulerFences: [{ gatewayId: VM, agentId: COACH, holder: liveScheduler, reason: "op-live is still running" }],
    });
    expect(logs).toContainEqual(
      `[scheduler-custody] ⚠ alice: kept the scheduler fence of ${COACH} on ${VM} held by ${liveScheduler}: op-live is still running op=${ACTIVATION_ID}`);
    expect(logs).toContainEqual(
      `[migrate-customer] ❌ alice: schedules were not restored after the cutover onto ${VM}: 1 schedule not restored, 1 scheduler fence kept op=${ACTIVATION_ID}`);
    expect(logs).toContainEqual(expect.stringMatching(
      new RegExp(`^\\[migration-runner\\] ⚠ schedule "${CHECK}" of ${COACH} was not restored on ${VM} migrationId=mig-${ACTIVATION_ID} slug=alice: CronAgentMigrationHeldError`),
    ));
    expect(h.transfers.get(`uid-alice/mig-${ACTIVATION_ID}`)).toMatchObject({
      restoreAttemptedTo: VM, restoreFailures: [{ name: CHECK, error: expect.stringContaining(liveScheduler) }],
    });
    expect(h.transfers.get(`uid-alice/mig-${ACTIVATION_ID}`)?.restoredTo).toBeUndefined();
  });

  function settledReturn(custody: CronCustodyGateways) {
    const onVm = custody.store(VM);
    onVm.jobs.clear();
    custody.store(SHARED).add({ agentId: COACH, name: CHECK, enabled: true });
    onVm.migrate({ operationId: RETURN_SCHEDULER, phase: "hold", agentIds: [COACH], retainNonportable: true });
    onVm.migrate({ operationId: RETURN_SCHEDULER, phase: "export", retainNonportable: true });
    onVm.migrate({ operationId: RETURN_SCHEDULER, phase: "retire" });
    return onVm;
  }

  it("fails the move after its cutover, recording the fence, when the VM refuses the release outright", async () => {
    const custody = createCronCustodyGateways({ alice: [COACH] });
    settledReturn(custody);
    const vm = retainedVm();
    const refusal = '/scheduler/gw-blue: 500 {"error":"scheduler migration failed","message":"Cron migration requires an explicit owner for legacy default-agent jobs","retryable":false}';
    const refusing = (base: MigrationClient): MigrationClient => ({
      ...base,
      scheduler: async request => {
        if (request.phase === "stage" && request.migrationId === RELEASE) throw new MigrationRpcError(refusal, { status: 500, retryable: false });
        return base.scheduler(request);
      },
    });

    const { result, logs, h } = await activateOntoVm(custody, vm, { wrap: refusing });

    expect(result).toMatchObject({ success: false, rolledBack: false, failedAfterCutover: true });
    expect(result.output?.unreleasedSchedulerFences).toEqual([{ gatewayId: VM, agentId: COACH, holder: null, reason: refusal }]);
    expect(result.output?.scheduleRestoreFailures).toEqual([expect.objectContaining({ agentId: COACH, job: CHECK })]);
    expect(logs).toContainEqual(
      `[migrate-customer] ❌ alice: could not release the scheduler fence of ${COACH} on ${VM}: ${refusal} op=${ACTIVATION_ID}`);
    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: SHARED }));
    const completion = buildOperationCompletionUpdate({
      op: { id: ACTIVATION_ID, kind: "migrate-user", attempts: 0, cutoverCommittedAt: ACTIVATED_AT, schedulerHandoff: vi.mocked(h.ctx.persistSchedulerHandoff!).mock.calls.at(-1)?.[0] },
      result, steps: [], now: ACTIVATED_AT + 1,
    });
    expect(completion).toMatchObject({ status: "failed", rolledBack: false, schedulerHandoffReleased: true, output: result.output });
  });

  it.each([0, 2, 9])("keeps the move in forward recovery while the VM may yet accept the release (prior attempts %i)", async (attempts) => {
    const custody = createCronCustodyGateways({ alice: [COACH] });
    const onVm = settledReturn(custody);
    onVm.runningAgents.add(COACH);
    const vm = retainedVm();

    const { result, logs, h } = await activateOntoVm(custody, vm, { attempts });

    expect(onVm.fences.get(COACH)).toBe(RETURN_SCHEDULER);
    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.failedAfterCutover).toBeUndefined();
    expect(result.error).toContain("migration cutover committed; destination recovery pending: status 503");
    expect(result.error).toContain("unsettled runs");
    expect(buildOperationCompletionUpdate({
      op: { kind: "migrate-user", attempts, cutoverCommittedAt: ACTIVATED_AT, schedulerHandoff: vi.mocked(h.ctx.persistSchedulerHandoff!).mock.calls.at(-1)?.[0] },
      result, steps: [], now: ACTIVATED_AT + 1,
    })).toMatchObject({ status: "pending", attempts: attempts + 1 });
    expect(h.transfers.get(`uid-alice/mig-${ACTIVATION_ID}`)?.restoreAttemptedTo).toBeUndefined();
    expect(logs.filter(line => line.includes("❌"))).toEqual([]);
  });

  it("keeps the move in forward recovery when the VM's scheduler connection closes during the release", async () => {
    const custody = createCronCustodyGateways({ alice: [COACH] });
    const onVm = settledReturn(custody);
    const vm = retainedVm();
    const closed = `/scheduler/${VM}: 500 {"error":"scheduler migration failed","message":"socket closed before cron.migration response","retryable":true}`;
    const closing = (base: MigrationClient): MigrationClient => ({
      ...base,
      scheduler: async request => {
        if (request.phase === "stage" && request.migrationId === RELEASE) throw new MigrationRpcError(closed, { status: 500, retryable: true });
        return base.scheduler(request);
      },
    });

    const { result, logs, h } = await activateOntoVm(custody, vm, { wrap: closing });

    expect(onVm.fences.get(COACH)).toBe(RETURN_SCHEDULER);
    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.failedAfterCutover).toBeUndefined();
    expect(result.error).toContain("migration cutover committed; destination recovery pending: status 503");
    expect(result.error).toContain("socket closed before cron.migration response");
    expect(buildOperationCompletionUpdate({
      op: { kind: "migrate-user", attempts: 0, cutoverCommittedAt: ACTIVATED_AT, schedulerHandoff: vi.mocked(h.ctx.persistSchedulerHandoff!).mock.calls.at(-1)?.[0] },
      result, steps: [], now: ACTIVATED_AT + 1,
    })).toMatchObject({ status: "pending", attempts: 1 });
    expect(logs.filter(line => line.includes("❌"))).toEqual([]);
  });

  describe("over a round trip from shared to the VM, back to shared, and onto the same retained VM", () => {
    const FIRST = "op-activate-1", SECOND = "op-activate-2";

    function failOnce(fails: (request: Record<string, unknown>) => boolean, error: () => Error) {
      let failed = false;
      return (request: Record<string, unknown>) => {
        if (failed || !fails(request)) return;
        failed = true;
        throw error();
      };
    }

    function ownership(custody: CronCustodyGateways) {
      const side = (gatewayId: string) => {
        const cron = custody.store(gatewayId);
        return {
          fence: cron.fences.get(COACH) ?? null,
          jobs: cron.agentJobs(COACH).map(job => `${job.name}${cron.runnable(job.id) ? "" : " (dormant)"}`).sort(),
        };
      };
      return { vm: side(VM), shared: side(SHARED) };
    }

    async function retryActivation(h: ReturnType<typeof mkDeps>, vm: RetainedVm, id: string, attempts: number) {
      const cutoverCommittedAt = vm.records[`glmOperations/${id}`].cutoverCommittedAt as number;
      const schedulerHandoff = vi.mocked(h.ctx.persistSchedulerHandoff!).mock.calls.at(-1)?.[0];
      const op = mkOp({ id, input: { uid: "uid-alice", toGatewayId: VM }, schedulerHandoff, cutoverCommittedAt, attempts });
      const result = await createMigrateUserHandler(h.deps)(op, h.ctx);
      if (result.success) Object.assign(vm.records[`glmOperations/${id}`], { status: "succeeded", completedAt: cutoverCommittedAt + 50 });
      return result;
    }

    async function returnWithRetry(custody: CronCustodyGateways, vm: RetainedVm) {
      const h = mkDeps();
      const activateFails = failOnce(
        request => request.gatewayId === SHARED && request.phase === "activate",
        () => new MigrationRpcError(`/scheduler/${SHARED}: 503 restarting`, { status: 503 }),
      );
      onCustody(h, custody, base => ({ ...base, scheduler: async request => {
        activateFails(request as unknown as Record<string, unknown>);
        return base.scheduler(request);
      } }));
      const native = mockNativeReturn();
      h.deps.prepareNativeVmReturn = vi.fn(async () => native);
      let handoff: Operation["schedulerHandoff"];
      let cutoverCommittedAt = 0;
      vi.mocked(h.ctx.persistSchedulerHandoff!).mockImplementation(async state => { handoff = { ...state }; });
      vi.mocked(h.ctx.persistCutoverCommitted!).mockImplementation(async at => { cutoverCommittedAt = at; });
      vi.mocked(h.deps.commitCutover).mockImplementation(async () => {
        vi.mocked(h.deps.readUser).mockResolvedValue({ slug: "alice", currentGatewayId: SHARED });
      });
      const park = native.park.getMockImplementation()!;
      native.park.mockImplementation(async request => {
        vm.park(handoff!.migrationId);
        return park(request);
      });
      native.acknowledgeCompletedSchedulerHandoff.mockImplementation(async () => vm.completeReturn(cutoverCommittedAt));
      const input = { uid: "uid-alice", fromGatewayId: VM, toGatewayId: SHARED };
      const first = await createMigrateUserHandler(h.deps)(mkOp({ id: RETURN_ID, input }), h.ctx);
      const afterFirst = ownership(custody);
      const retried = await createMigrateUserHandler(h.deps)(
        mkOp({ id: RETURN_ID, input, schedulerHandoff: handoff, attempts: 1, cutoverCommittedAt }), h.ctx);
      const { id: _id, ...row } = mkOp({ id: RETURN_ID, input });
      vm.journal(RETURN_ID, {
        ...row, origin: "automatic", inputUid: "uid-alice", gatewayId: SHARED, status: "succeeded", completedAt: cutoverCommittedAt + 100,
        cutoverCommittedAt, schedulerHandoff: handoff, schedulerHandoffReleased: true,
      });
      return { first, afterFirst, retried };
    }

    it("keeps every schedule on exactly one side, and never fails after a cutover, when each step fails once and retries", async () => {
      const custody = createCronCustodyGateways({ alice: [COACH] });
      custody.store(SHARED).add({ agentId: COACH, name: CHECK, enabled: true });
      const vm = retainedVm();
      const forwardRecovery = /^migration cutover committed; destination recovery pending: status 503: /u;

      const restoreFails = failOnce(
        request => request.gatewayId === VM && request.op === "restore",
        () => new MigrationRpcError(`/schedules/${VM}: 503 OpenClaw is starting`, { status: 503 }),
      );
      const moveIn = await activateOntoVm(custody, vm, { id: FIRST, at: 3_000, wrap: base => ({ ...base, schedules: (async request => {
        restoreFails(request as unknown as Record<string, unknown>);
        return base.schedules(request);
      }) as MigrationClient["schedules"] }) });
      expect(moveIn.result).toMatchObject({ success: false, rolledBack: false, error: expect.stringMatching(forwardRecovery) });
      expect(ownership(custody)).toEqual({ vm: { fence: null, jobs: [] }, shared: { fence: null, jobs: [] } });
      expect(moveIn.h.transfers.get(`uid-alice/mig-${FIRST}`)).toMatchObject({ restoreAttemptedTo: VM, records: [expect.objectContaining({ agentId: COACH })] });

      expect(await retryActivation(moveIn.h, vm, FIRST, 1)).toEqual({ steps: [], success: true, rolledBack: false });
      expect(ownership(custody)).toEqual({ vm: { fence: null, jobs: [CHECK] }, shared: { fence: null, jobs: [] } });
      expect(moveIn.h.transfers.get(`uid-alice/mig-${FIRST}`)).toMatchObject({ restoredTo: VM, restoreFailures: [] });
      custody.store(VM).add({ agentId: COACH, name: WATCH, enabled: true, schedule: { kind: "event" } });

      const back = await returnWithRetry(custody, vm);
      expect(back.first).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("503 restarting") });
      expect(classifyOperationFailure(back.first.error)).toBe("transient");
      expect(back.afterFirst).toEqual({
        vm: { fence: RETURN_SCHEDULER, jobs: [`${WATCH} (dormant)`] }, shared: { fence: RETURN_SCHEDULER, jobs: [`${CHECK} (dormant)`] },
      });
      expect(back.retried).toMatchObject({ success: true, rolledBack: false });
      expect(ownership(custody)).toEqual({ vm: { fence: RETURN_SCHEDULER, jobs: [`${WATCH} (dormant)`] }, shared: { fence: null, jobs: [CHECK] } });

      const releaseFails = failOnce(
        request => request.gatewayId === VM && request.phase === "stage",
        () => new MigrationRpcError(`/scheduler/${VM}: 503 restarting`, { status: 503 }),
      );
      const moveBack = await activateOntoVm(custody, vm, { id: SECOND, wrap: base => ({ ...base, scheduler: async request => {
        releaseFails(request as unknown as Record<string, unknown>);
        return base.scheduler(request);
      } }) });
      expect(moveBack.result).toMatchObject({ success: false, rolledBack: false, error: expect.stringMatching(forwardRecovery) });
      expect(vm.pending()).toBeUndefined();
      expect(ownership(custody)).toEqual({ vm: { fence: RETURN_SCHEDULER, jobs: [`${WATCH} (dormant)`] }, shared: { fence: null, jobs: [] } });
      expect(moveBack.h.transfers.get(`uid-alice/mig-${SECOND}`)?.restoreAttemptedTo).toBeUndefined();

      expect(await retryActivation(moveBack.h, vm, SECOND, 1)).toEqual({ steps: [], success: true, rolledBack: false });
      expect(ownership(custody)).toEqual({ vm: { fence: null, jobs: [WATCH, CHECK].sort() }, shared: { fence: null, jobs: [] } });
      expect(custody.store(VM).status(`mig-${SECOND}:release:${COACH}`)).toBe("activated");
      expect(moveBack.h.transfers.get(`uid-alice/mig-${SECOND}`)).toMatchObject({ restoredTo: VM, restoreFailures: [] });
    });
  });

  it("releases nothing once the user is no longer assigned to the VM", async () => {
    const custody = createCronCustodyGateways({ alice: [COACH] });
    const onVm = settledReturn(custody);
    const vm = retainedVm();
    const h = mkDeps({ sourceGatewayId: VM });
    onCustody(h, custody);
    h.deps.readOperation = vi.fn(async (operationId: string) => vm.store.journal.operations.get(operationId));
    h.deps.readUserAgentIds = vi.fn(async () => [COACH]);
    h.deps.retireNativeSchedulerBeforeStage = vi.fn(async () => {
      vi.mocked(h.deps.readUser).mockResolvedValue({ slug: "alice", currentGatewayId: SHARED });
    });
    h.transfers.set(`uid-alice/mig-${ACTIVATION_ID}`, { ...PENDING_SCHEDULES, migrationId: `mig-${ACTIVATION_ID}`, sourceGatewayId: SHARED, targetGatewayId: VM });
    const handoff = {
      migrationId: `mig-${ACTIVATION_ID}:scheduler:1:claim:4000`, fromGatewayId: SHARED, toGatewayId: VM, uid: "uid-alice", slug: "alice",
      stageAfterCutover: true as const, scheduleTransfer: true as const,
    };
    const op = mkOp({ id: ACTIVATION_ID, input: { uid: "uid-alice", toGatewayId: VM }, schedulerHandoff: handoff, attempts: 1, cutoverCommittedAt: 4_500 });

    const result = await createMigrateUserHandler(h.deps)(op, h.ctx);

    expect(custody.calls.filter(call => call.startsWith(`scheduler:${VM}:`))).toEqual([]);
    expect(onVm.fences.get(COACH)).toBe(RETURN_SCHEDULER);
    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.failedAfterCutover).toBeUndefined();
    expect(result.error).toBe(`migration cutover committed; destination recovery pending: status 503: alice is no longer assigned to ${VM}`);
    expect(h.transfers.get(`uid-alice/mig-${ACTIVATION_ID}`)?.restoreAttemptedTo).toBeUndefined();
  });
});

describe("migrate-customer — input validation", () => {
  it.each([
    [{ toGatewayId: "gw-green" }, /missing uid/u],
    [{ uid: "uid-alice" }, /missing toGatewayId/u],
  ])("rejects malformed input %j", async (input, message) => {
    const { deps, ctx } = mkDeps();
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({ input: input as Operation["input"] }), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(message);
  });

  it("rejects a migration whose declared source no longer matches the user's gateway", async () => {
    const { deps, ctx } = mkDeps();
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({
      input: { uid: "uid-alice", toGatewayId: "gw-green", fromGatewayId: "gw-stale" },
    }), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toMatch(/declared source gw-stale does not match resolved source gw-blue/u);
  });

  it("binds legacy source roster gates to the migration operation", async () => {
    const { deps, ctx } = mkDeps();
    const handler = createMigrateUserHandler(deps);

    await handler(mkOp({}), ctx);

    expect(deps.setAssignmentState).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "gw-blue",
      uid: "uid-alice",
      updatedByOperationId: "op-1",
    }));
  });

  it("rejects a same-gateway migration — simple-roll has one pod per gateway", async () => {
    const { deps, ctx } = mkDeps({ sourceGatewayId: "gw-green" });
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already on gw-green/u);
  });

  it("converges a stale user activation migration after another controller reaches its target", async () => {
    const { deps, ctx, client } = mkDeps({ sourceGatewayId: "gw-green" });
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({
      input: {
        uid: "uid-alice",
        fromGatewayId: "gw-blue",
        toGatewayId: "gw-green",
        source: "builder-activation-lease",
      },
    }), ctx);

    expect(result).toEqual({ steps: [], success: true, rolledBack: false });
    expect(client.calls).toEqual([]);
  });

  it("fails when the target placement is rejected", async () => {
    const { deps, ctx } = mkDeps();
    (deps.resolveTargetPlacement as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "revision-not-ready",
    });
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/placement rejected for gw-green: revision-not-ready/u);
  });

  it("names what blocks a rejected target", async () => {
    const { deps, ctx } = mkDeps();
    (deps.resolveTargetPlacement as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      reason: "no-live-revision",
      blocker: "home claim octogee-gateway-gw-green-data has been pending for 7 minutes",
    });
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.error).toBe(
      "placement rejected for gw-green: no-live-revision (home claim octogee-gateway-gw-green-data has been pending for 7 minutes)",
    );
  });
});

describe("migrate-customer — legacy data-plane migration (shared class)", () => {
  it("keeps the migration marker after final transfer failure", async () => {
    const h = mkDeps();
    h.deps.clearMigrationPreparation = vi.fn(async () => undefined);
    vi.mocked(h.client.transferState).mockImplementation(async request => {
      if (request.mode === "final") throw new Error("native maintenance required");
      return { migrationId: request.migrationId, slug: request.slug, imported: true };
    });
    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(h.deps.clearMigrationPreparation).not.toHaveBeenCalled();
  });
  it.each([true, false])("clears a failed idle probe only after target cleanup (%s)", async (cleanupConfirmed) => {
    const h = mkDeps();
    h.deps.clearMigrationPreparation = vi.fn(async () => undefined);
    vi.mocked(h.client.quiesce).mockRejectedValueOnce(new Error("agent startup inspection failed"));
    if (!cleanupConfirmed) vi.mocked(h.client.unmount).mockRejectedValue(new Error("target cleanup unknown"));
    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
    expect(result.success).toBe(false);
    expect(h.client.flushGateway).not.toHaveBeenCalled();
    if (cleanupConfirmed) expect(h.deps.clearMigrationPreparation).toHaveBeenCalledWith({ uid: "uid-alice", sourceGatewayId: "gw-blue", operationId: "op-1", sourceAssignmentMode: "assigned", sourceRelease: 1, sourceEpoch: 4 });
    else expect(h.deps.clearMigrationPreparation).not.toHaveBeenCalled();
  });

  it("clears preparation when key transfer fails before source quiescence", async () => {
    const h = mkDeps();
    h.deps.clearMigrationPreparation = vi.fn(async () => undefined);
    vi.mocked(h.client.transferState).mockRejectedValueOnce(new Error("key transfer failed"));
    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.deps.clearMigrationPreparation).toHaveBeenCalledWith({ uid: "uid-alice", sourceGatewayId: "gw-blue", operationId: "op-1", sourceAssignmentMode: "assigned", sourceRelease: 1, sourceEpoch: 4 });
  });

  it.each([true, false])("clears failed preparation only after target unmount is confirmed (%s)", async (cleanupConfirmed) => {
    const h = mkDeps();
    h.deps.clearMigrationPreparation = vi.fn(async () => undefined);
    vi.mocked(h.client.transferState).mockImplementation(async (request) => {
      if (request.mode === "pre") throw new Error("staged snapshot rejected");
      return { migrationId: request.migrationId, slug: request.slug, imported: true };
    });
    if (!cleanupConfirmed) vi.mocked(h.client.unmount).mockRejectedValue(new Error("target cleanup unknown"));
    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
    expect(result.success).toBe(false);
    expect(h.client.quiesce).not.toHaveBeenCalled();
    if (cleanupConfirmed) expect(h.deps.clearMigrationPreparation).toHaveBeenCalledWith({ uid: "uid-alice", sourceGatewayId: "gw-blue", operationId: "op-1", sourceAssignmentMode: "assigned", sourceRelease: 1, sourceEpoch: 4 });
    else expect(h.deps.clearMigrationPreparation).not.toHaveBeenCalled();
  });

  it("retains the unassigned live source fence when clearing a rolled-back preparation", async () => {
    const h = mkDeps();
    h.deps.clearMigrationPreparation = vi.fn(async () => undefined);
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, assignmentMode: "unassigned-live", rootUpdatedAt: 17 });
    vi.mocked(h.client.transferState).mockImplementation(async (request) => {
      if (request.mode === "pre") throw new Error("staged snapshot rejected");
      return { migrationId: request.migrationId, slug: request.slug, imported: true };
    });
    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
    expect(result).toMatchObject({ success: false, rolledBack: true, error: "staged snapshot rejected" });
    expect(h.deps.clearMigrationPreparation).toHaveBeenCalledWith({
      uid: "uid-alice", sourceGatewayId: "gw-blue", operationId: "op-1",
      sourceAssignmentMode: "unassigned-live", sourceRelease: 1, sourceEpoch: 0, sourceRootUpdatedAt: 17,
    });
    expect(h.client.quiesce).not.toHaveBeenCalled();
  });

  it("runs the full flow with the roster gate and no config steps", async () => {
    const { deps, ctx, client, events } = mkDeps();
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(client.calls).toEqual([
      "transfer:keys:gw-blue->gw-green",
      "transfer:pre:gw-blue->gw-green",
      "quiesce:gw-blue",
      "quiesce:gw-blue",
      "schedules:gw-blue:snapshot",
      "schedules:gw-blue:remove",
      "transfer:final:gw-blue->gw-green",
      "verify:gw-green",
      "schedules:gw-green:restore",
      "unmount:gw-blue",
    ]);
    expect(events).toContain("assignment:gw-blue:quiescing");
    expect(events).toContain("cutover:gw-blue->gw-green:mirror=true");
    expect(client.calls.every((call) => !/config/u.test(call))).toBe(true);
    expect(client.restoreTarget).not.toHaveBeenCalled();
    expect(deps.readUserSnapshot).toHaveBeenCalledWith("uid-alice", "gw-green");
  });

  it("records the committed cutover before source cleanup so the serial lock releases while cleanup runs", async () => {
    const { deps, ctx, client, events } = mkDeps();
    vi.mocked(client.unmount).mockImplementation(async ({ gatewayId, slug }) => {
      events.push(`unmount:${gatewayId}`);
      return { migrationId: "mig-op-1", slug, unmounted: true };
    });

    const result = await createMigrateUserHandler(deps)(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true });
    expect(events.slice(events.indexOf("cutover:gw-blue->gw-green:mirror=true"))).toEqual([
      "cutover:gw-blue->gw-green:mirror=true",
      "cutover-recorded:5000",
      "schedules-restored:uid-alice/mig-op-1:gw-green",
      "unmount:gw-blue",
    ]);
  });

  it("keeps the migration complete and the lock held when the cutover record cannot be written", async () => {
    const { deps, ctx, client } = mkDeps();
    vi.mocked(ctx.persistCutoverCommitted!).mockRejectedValue(new Error("journal unavailable"));

    const result = await createMigrateUserHandler(deps)(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(client.unmount).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.log).mock.calls.some(([message]) => /❌.*cutover.*journal unavailable/u.test(message))).toBe(true);
  });

  it("never re-drives a migration whose cutover already committed once the user has moved on", async () => {
    const { deps, ctx, client, events } = mkDeps({ sourceGatewayId: "gw-purple" });
    const schedulerHandoff = { migrationId: "mig-op-1:scheduler:1", fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" };

    const result = await createMigrateUserHandler(deps)(mkOp({ schedulerHandoff, attempts: 1, cutoverCommittedAt: 4_000 }), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toMatch(/cutover already committed to gw-green; customer now owned by gw-purple/u);
    expect(client.calls).toEqual([]);
    expect(client.scheduler).not.toHaveBeenCalled();
    expect(events.some((event) => event.startsWith("cutover:") || event.startsWith("assignment:"))).toBe(false);
  });

  it("moves a user with an active scheduled run without a cron.migration hold on the source", async () => {
    const client = happyClient();
    vi.mocked(client.scheduler).mockRejectedValue(new Error("scheduler hold did not prove a drained matching operation"));
    const { deps, ctx, events } = mkDeps({ client });

    const result = await createMigrateUserHandler(deps)(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(client.scheduler).not.toHaveBeenCalled();
    expect(vi.mocked(client.quiesce).mock.calls[1][0]).toEqual({ migrationId: "mig-op-1", gatewayId: "gw-blue", slug: "alice" });
    expect(events.some((event) => event.startsWith("cutover:"))).toBe(true);
  });

  it("moves a durable user with an active scheduled run: the source's quiesce owns the hold, so a 409 hold never reaches the runner", async () => {
    const client = happyClient();
    vi.mocked(client.scheduler).mockImplementation(async ({ migrationId, phase }) => {
      if (phase === "hold") throw new Error("scheduler hold did not prove a drained matching operation");
      return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: {} };
    });
    const { deps, ctx, events } = mkDeps({ client, durable: true });

    const result = await createMigrateUserHandler(deps)(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(vi.mocked(client.scheduler).mock.calls.map(([request]) => request.phase)).not.toContain("hold");
    expect(vi.mocked(client.quiesce).mock.calls[1][0]).toMatchObject({ gatewayId: "gw-blue", schedulerHandoff: true });
    expect(events.some((event) => event.startsWith("v2-cutover:"))).toBe(true);
  });

  it("reports failure with rollback when quiesce cannot drain", async () => {
    const client = happyClient();
    (client.quiesce as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 }).mockRejectedValue(new Error("agents busy"));
    const { deps, ctx, events } = mkDeps({ client });
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.error).toMatch(/agents busy/u);
    expect(events.some((event) => event.startsWith("cutover:"))).toBe(false);
    expect(events).toContain("assignment:gw-blue:serving");
  });
});

describe("migrate-customer — durable V2 migration", () => {
  it("initializes durable state from exact root fences and drives to complete", async () => {
    const { deps, ctx, client, events, persisted } = mkDeps({ durable: true });
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(persisted[0]).toMatchObject({
      phase: "initialized",
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned",
      targetGatewayId: "gw-green",
      targetRelease: 2,
    });
    expect(persisted.map((state) => state.phase)).toEqual([
      "initialized", "keysSynced", "preSynced", "sourceQuiesced",
      "finalSynced", "targetVerified", "cutover", "cutover", "sourceRetired", "complete",
    ]);
    expect(client.calls).toEqual([
      "transfer:keys:gw-blue->gw-green",
      "transfer:pre:gw-blue->gw-green",
      "quiesce:gw-blue",
      "quiesce:gw-blue",
      "transfer:final:gw-blue->gw-green",
      "verify:gw-green",
      "unmount:gw-blue",
    ]);
    expect(client.restoreTarget).not.toHaveBeenCalled();
    expect(events).toContain("v2-cutover:gw-blue->gw-green");
    expect(deps.readUserSnapshot).not.toHaveBeenCalled();
    expect(client.flushGateway).toHaveBeenLastCalledWith(expect.objectContaining({
      gatewayId: "gw-green",
      expectedSystemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
      reason: "migration-converge",
    }));
  });

  it("moves a user onto a held VM: nothing reaches its scheduler until cutover releases it", async () => {
    const h = mkDeps({ durable: true });
    let cutOver = false;
    const order: string[] = [];
    vi.mocked(h.deps.commitV2Cutover).mockImplementation(async () => { cutOver = true; order.push("cutover"); });
    vi.mocked(h.client.scheduler).mockImplementation(async ({ migrationId, phase, gatewayId }) => {
      if (gatewayId === "gw-green" && !cutOver) {
        throw new Error('/scheduler/gw-green: 500 {"message":"OpenClaw workspace identities are not initialized for this boot"}');
      }
      order.push(`${gatewayId}:${phase}`);
      return { operationId: migrationId, phase, agentIds: ["octogee-alice-coach"], drained: true, snapshot: {} };
    });

    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });

    expect(order).toEqual(["gw-blue:export", "cutover", "gw-blue:export", "gw-green:stage", "gw-blue:retire", "gw-green:activate"]);
    expect(h.persisted.find((state) => state.phase === "cutover" && state.schedulerStagedAt !== undefined)).toBeDefined();
  });

  it.each([false, true])("retires the completed native return before V2 stage (cleanup fails: %s)", async fails => {
    const h = mkDeps({ durable: true });
    const order: string[] = [];
    vi.mocked(h.deps.commitV2Cutover).mockImplementation(async () => { order.push("cutover"); });
    const scheduler = vi.mocked(h.client.scheduler).getMockImplementation()!;
    vi.mocked(h.client.scheduler).mockImplementation(async request => {
      order.push(`${request.gatewayId}:${request.phase}`);
      return scheduler(request);
    });
    vi.mocked(h.deps.retireNativeSchedulerBeforeStage).mockImplementation(async (input, retire) => {
      expect(input).toEqual({ uid: "uid-alice", slug: "alice", gatewayId: "gw-green", operationId: "op-1", claimedStartedAt: 4_000 });
      expect(order).toContain("cutover");
      order.push("retire-completed-return");
      if (fails) throw new Error("native scheduler retirement authority changed");
      await retire({ migrationId: "completed-return", slug: "alice", gatewayId: "gw-green", phase: "retire" });
    });

    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);

    expect(result).toMatchObject({ success: !fails, rolledBack: false });
    expect(h.deps.retireNativeSchedulerBeforeStage).toHaveBeenCalledOnce();
    if (fails) {
      expect(result.error).toContain("status 503");
      expect(order).not.toContain("gw-green:stage");
      expect(order).not.toContain("gw-green:activate");
      expect(h.client.unmount).not.toHaveBeenCalled();
      expect(h.persisted.at(-1)).toMatchObject({ phase: "cutover" });
      expect(h.persisted.at(-1)?.schedulerStagedAt).toBeUndefined();
      vi.mocked(h.deps.retireNativeSchedulerBeforeStage).mockResolvedValue(undefined);
      expect(await createMigrateUserHandler(h.deps)(mkOp({ userMigrationV2: h.persisted.at(-1), cutoverCommittedAt: 5_000 }), h.ctx))
        .toMatchObject({ success: true, rolledBack: false });
      expect(order.filter(value => value === "gw-green:stage")).toHaveLength(1);
      expect(order.filter(value => value === "cutover")).toHaveLength(1);
    } else {
      expect(order.indexOf("gw-green:retire")).toBeLessThan(order.indexOf("gw-green:stage"));
      expect(order.indexOf("gw-green:stage")).toBeLessThan(order.indexOf("gw-green:activate"));
    }
  });

  it("refuses initialization when the source root ownership changed", async () => {
    const { deps, ctx } = mkDeps({ durable: true });
    (deps.readGatewayRootFence as ReturnType<typeof vi.fn>).mockImplementation(
      async (gatewayId: string) => gatewayId === "gw-blue"
        ? { ...gatewayRootFence("gw-blue"), ownerUid: "someone-else" }
        : gatewayRootFence("gw-green", 2),
    );
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/source root ownership changed/u);
  });

  it("resumes a durable migration from its persisted phase without re-running earlier steps", async () => {
    const { deps, ctx, client } = mkDeps({ durable: true });
    const handler = createMigrateUserHandler(deps);
    const state = {
      phase: "sourceQuiesced" as const,
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned" as const,
      sourceSystemConfigCommit: SOURCE_SYSTEM_CONFIG_COMMIT,
      sourceRootFence: gatewayRootFence("gw-blue"),
      targetGatewayId: "gw-green",
      targetRelease: 2,
      targetRootFence: gatewayRootFence("gw-green", 2),
    };

    const result = await handler(mkOp({ userMigrationV2: state }), ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(client.calls).toEqual([
      "transfer:final:gw-blue->gw-green",
      "verify:gw-green",
      "unmount:gw-blue",
    ]);
  });

  it("re-checks the initial bindings when resuming from initialized and refuses drift", async () => {
    const { deps, ctx } = mkDeps({ durable: true });
    (deps.resolveSourcePlacement as ReturnType<typeof vi.fn>).mockResolvedValue({
      release: 9,
      epoch: 4,
      assignmentMode: "assigned",
    });
    const handler = createMigrateUserHandler(deps);
    const state = {
      phase: "initialized" as const,
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned" as const,
      sourceRootFence: gatewayRootFence("gw-blue"),
      targetGatewayId: "gw-green",
      targetRelease: 2,
      targetRootFence: gatewayRootFence("gw-green", 2),
    };

    const result = await handler(mkOp({ userMigrationV2: state }), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/source placement changed/u);
  });

  it("classifies a transport failure as a 503 retry without aborting durable state", async () => {
    const client = happyClient();
    (client.transferState as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("fetch failed"), { retryable: true }),
    );
    const { deps, ctx, persisted } = mkDeps({ durable: true, client });
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/retry pending: status 503/u);
    expect(persisted.map((state) => state.phase)).toEqual(["initialized"]);
  });

  it("retains the source fence after a transient final-sync failure", async () => {
    const client = happyClient();
    (client.transferState as ReturnType<typeof vi.fn>).mockImplementation(async ({ mode }) => {
      if (mode === "final") {
        throw Object.assign(
          new Error("system config mutation unavailable: writer-lock-busy"),
          { retryable: true },
        );
      }
      return { migrationId: "mig-op-1", slug: "alice", imported: true };
    });
    const { deps, ctx, events, persisted } = mkDeps({ durable: true, client });
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("status 503") });
    expect(persisted.map((state) => state.phase)).toEqual([
      "initialized", "keysSynced", "preSynced", "sourceQuiesced",
    ]);
    expect(client.calls.filter((call) => call.startsWith("unmount:"))).toEqual([]);
    expect(events).not.toContain("assignment:gw-blue:serving");
  });

  it("replays an ambiguous cutover commit instead of aborting the canonical target", async () => {
    const { deps, ctx, client, persisted } = mkDeps({ durable: true });
    const commitV2Cutover = deps.commitV2Cutover as ReturnType<typeof vi.fn>;
    commitV2Cutover.mockRejectedValueOnce(
      Object.assign(new Error("cutover response unavailable"), { retryable: true }),
    );
    const handler = createMigrateUserHandler(deps);

    const first = await handler(mkOp({}), ctx);

    expect(first).toMatchObject({ success: false, rolledBack: false });
    expect(first.error).toMatch(/retry pending: status 503/u);
    expect(persisted.at(-1)?.phase).toBe("targetVerified");
    expect(client.calls.filter((call) => call.startsWith("unmount:"))).toEqual([]);

    const replay = await handler(mkOp({
      userMigrationV2: persisted.at(-1),
    }), ctx);

    expect(replay).toMatchObject({ success: true, rolledBack: false });
    expect(commitV2Cutover).toHaveBeenCalledTimes(2);
    expect(client.calls.filter((call) => call.startsWith("unmount:"))).toEqual([
      "unmount:gw-blue",
    ]);
  });

  it("requires forward recovery after a terminal target verification failure", async () => {
    const client = happyClient();
    (client.verifyTarget as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("target verify failed"), { status: 409 }),
    );
    const { deps, ctx, client: c, events, persisted } = mkDeps({ durable: true, client });
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("status 503") });
    expect(persisted.map((state) => state.phase)).toEqual([
      "initialized", "keysSynced", "preSynced", "sourceQuiesced", "finalSynced",
    ]);
    expect(c.calls.filter((call) => call.startsWith("unmount:"))).toEqual([]);
    expect(events).not.toContain("assignment:gw-blue:serving");
  });

  it("replays a completed durable migration idempotently and refuses changed input", async () => {
    const { deps, ctx } = mkDeps({ durable: true });
    const handler = createMigrateUserHandler(deps);
    const state = {
      phase: "complete" as const,
      operationId: "op-1",
      migrationId: "mig-op-1",
      uid: "uid-alice",
      slug: "alice",
      sourceGatewayId: "gw-blue",
      sourceRelease: 1,
      sourceEpoch: 4,
      sourceAssignmentMode: "assigned" as const,
      sourceRootFence: gatewayRootFence("gw-blue"),
      targetGatewayId: "gw-green",
      targetRelease: 2,
      targetRootFence: gatewayRootFence("gw-green", 2),
    };

    await expect(handler(mkOp({ userMigrationV2: state }), ctx)).resolves.toMatchObject({
      success: true,
      rolledBack: false,
    });
    await expect(handler(mkOp({
      userMigrationV2: state,
      input: { uid: "uid-alice", toGatewayId: "gw-other" },
    }), ctx)).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/input changed/u),
    });
  });

  it("turns a cancellation request into a durable abort once transfer started", async () => {
    const { deps, client, events } = mkDeps({ durable: true });
    const persisted: Array<NonNullable<Operation["userMigrationV2"]>> = [];
    let cancelRequested = false;
    const ctx: OperationContext = {
      persistSchedulerHandoff: vi.fn(async () => undefined),
    reportStep: vi.fn(async () => undefined),
      persistUserMigrationV2: vi.fn(async (state) => {
        persisted.push(state);
        if (state.phase === "keysSynced") cancelRequested = true;
      }),
      cancellationRequested: vi.fn(async () => cancelRequested),
    } as unknown as OperationContext;
    const handler = createMigrateUserHandler(deps);

    const result = await handler(mkOp({}), ctx);

    expect(result).toMatchObject({ success: false, rolledBack: true });
    expect(result.error).toMatch(/superseded/u);
    expect(deps.reportMigrationProgress).toHaveBeenCalledWith("gw-green", expect.objectContaining({ phase: "keysSynced", status: "skipped" }));
    expect(deps.reportMigrationProgress).toHaveBeenCalledWith("gw-green", expect.objectContaining({ phase: "abortIntent", status: "running" }));
    expect(persisted.map((state) => state.phase)).toContain("abortIntent");
    expect(client.calls.filter((call) => call.startsWith("unmount:"))).toEqual(["unmount:gw-green"]);
    expect(events).toContain("assignment:gw-blue:serving");
  });
});

describe("scheduler handoff recovery", () => {
  const schedulerHandoff = { scheduleTransfer: true as const, migrationId: "mig-op-1:scheduler:1", fromGatewayId: "gw-blue", toGatewayId: "gw-green", uid: "uid-alice", slug: "alice" };

  it.each([true, false, undefined])("retries a retargeted return only after its old scheduler handoff is released (%s)", async (released) => {
    const h = mkDeps();
    const previous = { ...schedulerHandoff, toGatewayId: "shared-retired" };
    vi.mocked(h.deps.resolveGatewayUrl).mockImplementation(async (gatewayId) => {
      if (gatewayId === previous.toGatewayId) throw new Error(`gateway not registered in glmGateways: ${gatewayId}`);
      return `http://${gatewayId}.svc:3003`;
    });

    const result = await createMigrateUserHandler(h.deps)(mkOp({
      schedulerHandoff: previous,
      schedulerHandoffReleased: released,
      attempts: 2,
      input: { uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease" },
    }), h.ctx);

    if (released === true) {
      expect(result).toMatchObject({ success: true });
      expect(h.deps.resolveGatewayUrl).not.toHaveBeenCalledWith(previous.toGatewayId);
      expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledWith({ ...schedulerHandoff, migrationId: "mig-op-1:scheduler:3:claim:4000" });
      expect(h.deps.commitCutover).toHaveBeenCalledWith(expect.objectContaining({ toGatewayId: "gw-green" }));
    } else {
      expect(result).toMatchObject({ success: false, error: `gateway not registered in glmGateways: ${previous.toGatewayId}` });
      expect(h.ctx.persistSchedulerHandoff).not.toHaveBeenCalled();
      expect(h.client.quiesce).not.toHaveBeenCalled();
      expect(h.deps.commitCutover).not.toHaveBeenCalled();
    }
  });

  it("requires a current operation claim before creating scheduler custody", async () => {
    const h = mkDeps();
    await expect(createMigrateUserHandler(h.deps)(mkOp({ startedAt: null }), h.ctx))
      .rejects.toThrow("migration requires a current claim timestamp");
    expect(h.ctx.persistSchedulerHandoff).not.toHaveBeenCalled();
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.client.scheduler).not.toHaveBeenCalled();
  });

  it("persists its scheduler attempt before snapshotting the source's schedules", async () => {
    const h = mkDeps();
    const schedules = vi.mocked(h.client.schedules).getMockImplementation()!;
    vi.mocked(h.client.schedules).mockImplementation(async (request) => {
      expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledWith({ ...schedulerHandoff, migrationId: "mig-op-1:scheduler:1:claim:4000" });
      return schedules(request);
    });
    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ success: true });
    expect(h.client.schedules).toHaveBeenCalledTimes(3);
  });

  it("recovers committed cutover by restoring the persisted schedules instead of copying state again", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    h.transfers.set("uid-alice/mig-op-1", PENDING_SCHEDULES);
    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff, attempts: 1 }), h.ctx)).toMatchObject({ success: true });
    expect(h.client.calls).toEqual(["schedules:gw-green:restore", "unmount:gw-blue"]);
    expect(h.client.scheduler).not.toHaveBeenCalled();
    expect(h.client.transferState).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    expect(h.client.resume).not.toHaveBeenCalled();
  });

  it.each([false, true])("finishes an old native user handoff without blocking activation (stage fails=%s)", async fails => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    const legacy = { ...schedulerHandoff, scheduleTransfer: undefined, stageAfterCutover: true as const };
    if (fails) {
      const scheduler = vi.mocked(h.client.scheduler).getMockImplementation()!;
      vi.mocked(h.client.scheduler).mockImplementation(async request => {
        if (request.phase === "stage") throw new Error("target job already exists");
        return scheduler(request);
      });
    }
    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: legacy, attempts: 1 }), h.ctx))
      .toMatchObject({ success: true, rolledBack: false });
    expect(h.client.schedules).not.toHaveBeenCalled();
    expect(h.client.scheduler).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue", phase: "export" }));
    if (!fails) expect(h.client.scheduler).toHaveBeenLastCalledWith(expect.objectContaining({ gatewayId: "gw-green", phase: "activate" }));
    else expect(h.deps.log).toHaveBeenCalledWith(expect.stringContaining("legacy schedule transfer failed"));
    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue" }));
  });

  it("waits for a fresh user's first accepted commit before converging a Shared-sourced handoff", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    tickingClock(h);
    const fromShared = { ...schedulerHandoff, scheduleTransfer: undefined, stageAfterCutover: true as const, fromGatewayId: "shared-blue" };
    vi.mocked(h.deps.readGatewaySystemConfigCommit).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue(TARGET_SYSTEM_CONFIG_COMMIT);

    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: fromShared, attempts: 1 }), h.ctx))
      .toMatchObject({ success: true, rolledBack: false });

    expect(h.client.resume).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-green", role: "target" }));
    expect(h.deps.readGatewaySystemConfigCommit).toHaveBeenCalledTimes(3);
    expect(h.client.flushGateway).toHaveBeenCalledWith(expect.objectContaining({
      gatewayId: "gw-green", reason: "migration-converge", expectedSystemConfigCommit: TARGET_SYSTEM_CONFIG_COMMIT,
    }));
    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "shared-blue" }));
  });

  it("never converges a Shared-sourced handoff on an attempt that lost its claim during the commit read", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    const fromShared = { ...schedulerHandoff, scheduleTransfer: undefined, stageAfterCutover: true as const, fromGatewayId: "shared-blue" };
    loseClaimDuringCommitRead(h);

    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: fromShared, attempts: 1 }), h.ctx)).toMatchObject({
      success: false,
      rolledBack: false,
      error: expect.stringContaining("destination recovery pending: status 503: operation op-1 claim lost"),
    });
    expect(h.client.flushGateway).not.toHaveBeenCalled();
    expect(h.client.unmount).not.toHaveBeenCalled();
  });

  it("completes committed cutover when the schedule restore fails", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    h.transfers.set("uid-alice/mig-op-1", PENDING_SCHEDULES);
    vi.mocked(h.client.schedules).mockRejectedValue(new Error("timeout"));
    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff }), h.ctx)).toMatchObject({ success: true, rolledBack: false });
    expect(h.client.schedules).toHaveBeenCalledTimes(1);
    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue" }));
  });

  it("completes a cut-over handoff whose source unmount is refused on held agent files, leaving source cleanup to eviction", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    const heldOpen = "/unmount/gw-blue: 500 {\"error\":\"unmount failed\",\"message\":\"agent database files are still held open: /home/node/.openclaw/agents/octogee-alice-coach/openclaw-agent.sqlite\"}";
    vi.mocked(h.client.unmount).mockRejectedValue(new Error(heldOpen));

    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff, attempts: 6 }), h.ctx)).toMatchObject({ success: true, rolledBack: false });
    expect(h.client.scheduler).not.toHaveBeenCalled();
    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-blue", slug: "alice" }));
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringMatching(/unmount-source cleanup failed after durable cutover.*alice.*held open.*target remains serving op=op-1$/u));
  });

  it("closes a failed scheduler attempt before reusing the user on a new attempt", async () => {
    const h = mkDeps();
    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff, attempts: 1 }), h.ctx)).toMatchObject({ success: true });
    expect(vi.mocked(h.client.scheduler).mock.calls.map(([request]) => [request.gatewayId, request.phase, request.migrationId])).toEqual([
      ["gw-green", "abort", schedulerHandoff.migrationId], ["gw-blue", "resume", schedulerHandoff.migrationId],
    ]);
    expect(h.client.calls.filter((call) => call.startsWith("schedules:"))).toEqual(["schedules:gw-blue:snapshot", "schedules:gw-blue:remove", "schedules:gw-green:restore"]);
    expect(h.ctx.persistSchedulerHandoff).toHaveBeenCalledWith(expect.objectContaining({ migrationId: "mig-op-1:scheduler:2:claim:4000" }));
  });

  it("finishes handoff cleanup for a migration whose serial lock was already released", async () => {
    const h = mkDeps({ sourceGatewayId: "gw-green" });
    expect(await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff, attempts: 1, cutoverCommittedAt: 4_000 }), h.ctx)).toMatchObject({ success: true });
    expect(h.client.scheduler).not.toHaveBeenCalled();
    expect(h.client.unmount).toHaveBeenCalledTimes(1);
  });

  it("cannot start scheduling handoff when its durable identity cannot be saved", async () => {
    const h = mkDeps();
    vi.mocked(h.ctx.persistSchedulerHandoff!).mockRejectedValue(new Error("journal unavailable"));
    await expect(createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).rejects.toThrow("journal unavailable");
    expect(h.client.schedules).not.toHaveBeenCalled();
  });
});

describe("migrate-customer — preempted VMs", () => {
  const rsyncReset = "push-rsync-state: 500 rsync code=12 errno=104 Connection reset";

  function finalTransferFails(): MigrationClient & { calls: string[] } {
    const client = happyClient();
    const transfer = vi.mocked(client.transferState);
    const happy = transfer.getMockImplementation()!;
    transfer.mockImplementation(async (request) => {
      if (request.mode === "final") throw Object.assign(new Error(rsyncReset), { status: 500 });
      return happy(request);
    });
    return client;
  }

  const activation = () => mkOp({
    id: "builder-activate-gw-green-g1",
    startedAt: 7_000,
    firstStartedAt: 6_000,
    input: { uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "builder-activation-lease" },
  });

  it("retains the source fence and blames the target VM Compute preempted since the migration first started", async () => {
    const h = mkDeps({ durable: true, client: finalTransferFails() });
    (h.deps.findPreemptedVm as ReturnType<typeof vi.fn>).mockImplementation(async (gatewayId: string) =>
      gatewayId === "gw-green" ? "octogee-pool-44847785" : null);

    const result = await createMigrateUserHandler(h.deps)(activation(), h.ctx);

    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(result.error).toContain(`target computer octogee-pool-44847785 was preempted:`);
    expect(result.error).toContain(rsyncReset);
    expect(h.persisted.at(-1)?.phase).toBe("sourceQuiesced");
    expect(h.events).not.toContain("assignment:gw-blue:serving");
    expect(h.deps.findPreemptedVm).toHaveBeenCalledWith("gw-green", 6_000);
  });

  it("blames the source VM when the user's own VM was preempted mid-return", async () => {
    const h = mkDeps({ durable: true, client: finalTransferFails() });
    (h.deps.findPreemptedVm as ReturnType<typeof vi.fn>).mockImplementation(async (gatewayId: string) =>
      gatewayId === "gw-blue" ? "octogee-computer-prod-uida" : null);

    const result = await createMigrateUserHandler(h.deps)(activation(), h.ctx);

    expect(result.error).toContain(`source computer octogee-computer-prod-uida was preempted:`);
    expect(result.error).toContain(rsyncReset);
  });

  it("leaves the failure as it was when neither VM was preempted, and never asks on success", async () => {
    const failed = mkDeps({ durable: true, client: finalTransferFails() });
    const result = await createMigrateUserHandler(failed.deps)(activation(), failed.ctx);
    expect(result.error).toContain(rsyncReset);
    expect(failed.deps.findPreemptedVm).toHaveBeenCalledTimes(2);

    const succeeded = mkDeps({ durable: true });
    await createMigrateUserHandler(succeeded.deps)(activation(), succeeded.ctx);
    expect(succeeded.deps.findPreemptedVm).not.toHaveBeenCalled();
  });

  it("keeps the original failure and logs when Compute cannot say whether a VM was preempted", async () => {
    const h = mkDeps({ durable: true, client: finalTransferFails() });
    (h.deps.findPreemptedVm as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("http 403"));

    const result = await createMigrateUserHandler(h.deps)(activation(), h.ctx);

    expect(result.error).toContain(rsyncReset);
    expect(h.deps.log).toHaveBeenCalledWith(expect.stringMatching(/could not check whether gw-green's VM was preempted: http 403 op=builder-activate-gw-green-g1$/u));
  });
});


describe("retained source cancellation", () => {
  it("does not resume or advance a saved migration from a stale claim", async () => {
    const h=mkDeps({durable:true,sourceGatewayId:"shared-one"});
    h.ctx.assertActiveClaim=vi.fn(async()=>{throw new Error("operation claim changed");});
    h.deps.observeSourceTransfer=vi.fn(async()=>undefined);
    const state={phase:"sourceQuiesced",operationId:"op-1",migrationId:"mig-op-1",uid:"uid-alice",slug:"alice",sourceGatewayId:"shared-one",sourceRelease:1,sourceEpoch:4,sourceAssignmentMode:"assigned",sourceRootFence:gatewayRootFence("shared-one"),targetGatewayId:"gw-green",targetRelease:2,targetRootFence:gatewayRootFence("gw-green",2)} as NonNullable<Operation["userMigrationV2"]>;
    await expect(createMigrateUserHandler(h.deps)(mkOp({input:{uid:"uid-alice",fromGatewayId:"shared-one",toGatewayId:"gw-green",sourceTransferMode:"retained-pod"},userMigrationV2:state}),h.ctx)).rejects.toThrow("operation claim changed");
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.client.transferState).not.toHaveBeenCalled();
    expect(h.persisted).toEqual([]);
  });
  it("keeps source quiescent and skips abort when cancellation races an unobserved helper", async () => {
    const h=mkDeps({durable:true,sourceGatewayId:"shared-one"});
    h.ctx.assertActiveClaim=vi.fn(async()=>{});
    h.deps.observeSourceTransfer=vi.fn(async()=>({status:"reserved"} as NonNullable<Operation["sourceTransferExecution"]>));
    h.ctx.cancellationRequested=vi.fn(async()=>true);
    const state={phase:"sourceQuiesced",operationId:"op-1",migrationId:"mig-op-1",uid:"uid-alice",slug:"alice",sourceGatewayId:"shared-one",sourceRelease:1,sourceEpoch:4,sourceAssignmentMode:"assigned",sourceRootFence:gatewayRootFence("shared-one"),targetGatewayId:"gw-green",targetRelease:2,targetRootFence:gatewayRootFence("gw-green",2)} as NonNullable<Operation["userMigrationV2"]>;
    const result=await createMigrateUserHandler(h.deps)(mkOp({input:{uid:"uid-alice",fromGatewayId:"shared-one",toGatewayId:"gw-green",sourceTransferMode:"retained-pod"},userMigrationV2:state}),h.ctx);
    expect(result).toMatchObject({success:false,rolledBack:false,error:expect.stringContaining("observation pending")});
    expect(h.client.resume).not.toHaveBeenCalled();expect(h.client.unmount).not.toHaveBeenCalled();expect(h.deps.setAssignmentState).not.toHaveBeenCalled();
    expect(h.persisted).toEqual([]);
  });
});

describe("waiting for active user work", () => {
  it.each(["wait-for-active-work", "quiesce-source"])("keeps the isolated target held when reclaiming an activation deferred at %s", async step => {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    const target = "alice-s-12345678";
    const first = mkOp({
      id: `builder-activate-${target}-g1`,
      input: { uid: "uid-alice", userSlug: "alice", fromGatewayId: "shared-blue", toGatewayId: target, source: "builder-activation-lease" },
    });
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, epoch: 4, assignmentMode: "assigned", gatewayClass: "shared" });
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "isolated" });
    const quiesce = vi.mocked(h.client.quiesce);
    if (step === "quiesce-source") {
      quiesce.mockImplementationOnce(quiesce.getMockImplementation()!);
    }
    quiesce.mockRejectedValueOnce(new MigrationDrainPendingError("coach still active"));
    const released = new Set<string>();
    const unmount = h.client.unmount;
    h.client.unmount = vi.fn(async request => {
      if (request.gatewayId === target) released.add(request.migrationId);
      return unmount(request);
    });
    const transfer = h.client.transferState;
    h.client.transferState = vi.fn(async request => {
      if (request.mode === "pre" && released.has(request.migrationId)) {
        throw new Error("surge OpenClaw process gate target migration already released");
      }
      return transfer(request);
    });

    const handler = createMigrateUserHandler(h.deps);
    const waiting = await handler(first, h.ctx);
    expect(waiting).toMatchObject({ waitingForUserIdle: true });
    expect(h.steps.at(-1)).toMatchObject({ name: step, status: "skipped" });
    const update = buildOperationCompletionUpdate({ op: first, result: waiting, steps: [...h.steps], now: 5_000 });
    const previous = vi.mocked(h.ctx.persistSchedulerHandoff!).mock.calls.at(-1)![0];
    const next = { ...first, ...update, status: "running", startedAt: 6_000,
      schedulerHandoff: previous, schedulerHandoffReleased: false } as Operation;

    expect(await handler(next, h.ctx)).toMatchObject({ success: true });
    expect(released.size).toBe(0);
    expect(h.deps.commitCutover).toHaveBeenCalledOnce();
  });

  it("completes on the next claim after an idle deferral without consuming a failure attempt or snapshotting early", async () => {
    const h = mkDeps();
    vi.mocked(h.client.quiesce)
      .mockResolvedValueOnce({ migrationId: "mig-op-1", slug: "alice", drained: true, runningCount: 0 })
      .mockRejectedValueOnce(new MigrationDrainPendingError("coach still active"));
    const handler = createMigrateUserHandler(h.deps);
    const first = mkOp({ status: "running", startedAt: 4_000, attempts: 1 });
    const waiting = await handler(first, h.ctx);
    expect(waiting).toMatchObject({ waitingForUserIdle: true });
    expect(h.client.schedules).not.toHaveBeenCalled();
    const update = buildOperationCompletionUpdate({ op: first, result: waiting, steps: h.steps, now: 5_000 });
    expect(update).not.toHaveProperty("attempts");
    const previous = vi.mocked(h.ctx.persistSchedulerHandoff!).mock.calls.at(-1)![0];
    const next = { ...first, ...update, status: "running", startedAt: 6_000,
      schedulerHandoff: previous, schedulerHandoffReleased: false } as Operation;
    const result = await handler(next, h.ctx);
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ success: true });
    expect(h.client.calls.filter((call) => call.startsWith("schedules:"))).toEqual(["schedules:gw-blue:snapshot", "schedules:gw-blue:remove", "schedules:gw-green:restore"]);
  });

  it.each([false, true])("keeps prepared targets and resumes source ingress without failing migration (durable=%s)", async (durable) => {
    const h = mkDeps({ durable });
    vi.mocked(h.client.quiesce).mockRejectedValue(new MigrationDrainPendingError("coach still active"));
    const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
    expect(result).toMatchObject({ success: false, waitingForUserIdle: true, rolledBack: false });
    expect(h.client.unmount).not.toHaveBeenCalled();
    expect(h.client.resume).toHaveBeenCalled();
    expect(h.deps.setAssignmentState).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    expect(h.deps.commitV2Cutover).not.toHaveBeenCalled();
    if (durable) expect(h.persisted.at(-1)?.phase).toBe("preSynced");
  });
  it("defers native VM return before checkpointing or fencing an active voice call", async () => {
    const h = mkDeps();
    const native = mockNativeReturn();
    h.deps.prepareNativeVmReturn = vi.fn(async () => native);
    vi.mocked(h.client.quiesce).mockRejectedValue(new MigrationDrainPendingError("voice call active"));
    expect(await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx)).toMatchObject({ waitingForUserIdle: true, rolledBack: false });
    expect(native.requestCheckpoint).not.toHaveBeenCalled();
    expect(h.deps.setAssignmentState).not.toHaveBeenCalled();
    expect(h.client.resume).toHaveBeenCalled();
    expect(h.client.unmount).not.toHaveBeenCalled();
  });
});

it("migrates without reading version metadata or a release artifact for a fixed strategy", async () => {
  const h = mkDeps();
  Object.assign(h.deps, {
    readGatewayOpenclawVersion: vi.fn(async () => { throw new Error("version unavailable"); }),
    readGatewayReleaseArtifact: vi.fn(async () => { throw new Error("artifact unavailable"); }),
  });
  const result = await createMigrateUserHandler(h.deps)(mkOp({}), h.ctx);
  expect(result.success).toBe(true);
  expect(h.client.quiesce).toHaveBeenCalled();
});

describe("legacy migration forward recovery", () => {
  it.each(["released", "observed-release", "held", "committed", "source-moved", "other-target", "other-rpc"] as const)("settles a forward-only user activation only after its target released before cutover: %s", async scenario => {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    const target = "alice-s-12345678", id = `builder-activate-${target}-g1`;
    const op = mkOp({ id, attempts: 1,
      input: { uid: "uid-alice", userSlug: "alice", fromGatewayId: "shared-blue", toGatewayId: target, source: "builder-activation-lease" },
      schedulerHandoff: { migrationId: `mig-${id}:scheduler:1:claim:1000`, uid: "uid-alice", slug: "alice",
        fromGatewayId: "shared-blue", toGatewayId: target, stageAfterCutover: true,
        forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 4 } },
    });
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, epoch: 4, assignmentMode: "assigned", gatewayClass: "shared" });
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "isolated" });
    let saved: Operation["schedulerHandoff"];
    vi.mocked(h.ctx.persistSchedulerHandoff!).mockImplementation(async state => { saved = structuredClone(state); });
    const transfer = h.client.transferState;
    h.client.transferState = vi.fn(async request => {
      if (request.mode !== "final") return transfer(request);
      if (scenario === "committed") op.cutoverCommittedAt = 4_500;
      if (scenario === "source-moved") vi.mocked(h.deps.readUser).mockResolvedValue({ slug: "alice", currentGatewayId: "shared-other" });
      if (scenario === "observed-release") throw new Error(`target import already released for migration mig-${id} on ${target}`);
      const path = scenario === "other-rpc" ? "finish-rsync-import" : "prepare-rsync-import";
      const body = { error: "prepare-rsync-import failed", message: scenario === "held"
        ? "surge OpenClaw process gate is held for migration other" : "surge OpenClaw process gate target migration already released" };
      throw new Error(`/${path}/${scenario === "other-target" ? "other" : target}: 500 ${JSON.stringify(body)}`);
    });
    const handler = createMigrateUserHandler(h.deps);
    const result = await handler(op, h.ctx);
    expect(result).toMatchObject({ success: false, rolledBack: false });
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    const released = scenario === "released" || scenario === "observed-release";
    expect(classifyOperationFailure(result.error)).toBe(released || scenario === "source-moved" ? "terminal" : "transient");
    if (!released) return;
    expect(buildOperationCompletionUpdate({ op, result, steps: h.steps, now: 5_000 })).toMatchObject({ status: "failed" });
    expect(saved?.forwardRecovery).toMatchObject({ targetReleased: true });
    const transferCount = vi.mocked(h.client.transferState).mock.calls.length;
    expect(await handler({ ...op, schedulerHandoff: saved!, attempts: 50, startedAt: 5_500 }, h.ctx))
      .toMatchObject({ success: false, rolledBack: false, error: result.error });
    expect(h.client.transferState).toHaveBeenCalledTimes(transferCount);
    const recovery = mkOp({ ...op, startedAt: 6_000, attempts: 2, steps: [],
      input: { ...op.input, recoverSourceOnly: true },
      schedulerHandoff: { ...saved!, sourceRecovery: { migrationId: saved!.migrationId, sourceEpoch: 4, steps: h.steps } },
    });
    const order: string[] = [];
    h.deps.prepareMigrationAgentStores = vi.fn(async gatewayId => { order.push(`stores:${gatewayId}`); });
    h.client.scheduler = vi.fn(async ({ migrationId, phase }) => {
      order.push(`scheduler:${phase}`);
      return { operationId: migrationId, phase, agentIds: [], drained: true };
    });
    const resume = h.client.resume;
    h.client.resume = vi.fn(async request => { order.push("resume"); return resume(request); });
    expect(await handler(recovery, h.ctx)).toMatchObject({ success: false, rolledBack: true });
    expect(order).toEqual([`stores:${target}`, "stores:shared-blue", "scheduler:resume", "resume"]);
    expect(h.deps.completeMigrationRecovery).toHaveBeenCalledOnce();
    expect(vi.mocked(h.client.transferState).mock.calls.filter(([request]) => request.mode === "final")).toHaveLength(1);
  });

  it.each(["held", "committed", "epoch-changed", "cleanup-failed"] as const)("keeps the source fenced when released-target recovery is unsafe: %s", async scenario => {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    const target = "alice-s-12345678", id = `builder-activate-${target}-g1`;
    const migrationId = `mig-${id}:scheduler:1:claim:1000`;
    const op = mkOp({ id, attempts: 2, startedAt: 6_000,
      input: { uid: "uid-alice", userSlug: "alice", source: "builder-activation-lease", fromGatewayId: "shared-blue", toGatewayId: target, recoverSourceOnly: true },
      schedulerHandoff: { migrationId, uid: "uid-alice", slug: "alice", fromGatewayId: "shared-blue", toGatewayId: target, stageAfterCutover: true,
        forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 4, ...(scenario === "held" ? {} : { targetReleased: true }) },
        sourceRecovery: { migrationId, sourceEpoch: scenario === "epoch-changed" ? 5 : 4, steps: [{ name: "final-sync-state", status: "failed" }] } },
    });
    if (scenario === "committed") op.cutoverCommittedAt = 5_000;
    if (scenario === "cleanup-failed") vi.mocked(h.client.unmount).mockRejectedValue(new Error("target cleanup failed"));
    expect(await createMigrateUserHandler(h.deps)(op, h.ctx)).toMatchObject({ success: false, rolledBack: false });
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.client.scheduler).not.toHaveBeenCalled();
    expect(h.deps.completeMigrationRecovery).not.toHaveBeenCalled();
    expect(h.deps.prepareMigrationAgentStores).not.toHaveBeenCalledWith("shared-blue", expect.anything(), expect.anything());
    if (scenario !== "cleanup-failed") expect(h.deps.prepareIsolatedRecoveryTarget).not.toHaveBeenCalled();
  });

  it("keeps a fenced forward recovery retryable while its target is draining", async () => {
    const h = mkDeps();
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: false, reason: "revision-not-ready" });
    const result = await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: {
      migrationId: "mig-op-1:scheduler:1:claim:4000", uid: "uid-alice", slug: "alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green",
      forwardRecovery: { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 4 },
    } }), h.ctx);
    expect(result).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("status 503") });
  });

  it("restarts a lost final import response with the original scheduler ID and never reopens the old Native writer", async () => {
    const h = mkDeps();
    let saved: Operation["schedulerHandoff"];
    vi.mocked(h.ctx.persistSchedulerHandoff!).mockImplementation(async state => { saved = structuredClone(state); });
    const original = h.client.transferState;
    let upgradeAttempted = false;
    h.client.transferState = vi.fn(async request => {
      if (request.mode === "final" && !upgradeAttempted) {
        upgradeAttempted = true;
        expect(saved?.forwardRecovery).toMatchObject({ schemaVersion: 1, phase: "source-flushed", sourceEpoch: 4 });
        throw new MigrationTransportError("Native Doctor upgraded agent schema; response lost");
      }
      return original(request);
    });
    const handler = createMigrateUserHandler(h.deps);
    expect(await handler(mkOp({}), h.ctx)).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("status 503") });
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.client.unmount).not.toHaveBeenCalled();
    const schedulerId = saved!.migrationId;
    vi.mocked(h.client.transferState).mockClear();
    vi.mocked(h.client.quiesce).mockClear();
    vi.mocked(h.client.scheduler).mockClear();
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 3, epoch: 4, assignmentMode: "assigned" });
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 4, gatewayClass: "shared" });
    const result = await handler(mkOp({ schedulerHandoff: saved!, attempts: 1, startedAt: 6000, cancellationRequestedAt: 5500 }), h.ctx);
    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.client.transferState).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: "final" }));
    expect(vi.mocked(h.client.scheduler).mock.calls.every(([request]) => request.migrationId === schedulerId)).toBe(true);
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.client.unmount).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ gatewayId: "gw-blue" }));
    expect(h.ctx.assertActiveClaim).toHaveBeenCalledWith(true);
  });

  it("keeps an in-flight old-protocol move on its scheduler handoff and finishes it before unmounting the source", async () => {
    const h = mkDeps();
    const persisted: Array<Operation["schedulerHandoff"]> = [];
    vi.mocked(h.ctx.persistSchedulerHandoff!).mockImplementation(async state => { persisted.push(structuredClone(state)); });
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 3, epoch: 4, assignmentMode: "assigned" });
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 4, gatewayClass: "shared" });
    const legacy = { migrationId: "mig-op-1:scheduler:1:claim:4000", uid: "uid-alice", slug: "alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green",
      forwardRecovery: { schemaVersion: 1 as const, phase: "source-flushed" as const, sourceEpoch: 4 } };

    const result = await createMigrateUserHandler(h.deps)(mkOp({ schedulerHandoff: legacy, attempts: 1 }), h.ctx);

    expect(result).toMatchObject({ success: true, rolledBack: false });
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.every(state => state?.scheduleTransfer === undefined)).toBe(true);
    expect(h.client.schedules).not.toHaveBeenCalled();
    const scheduler = vi.mocked(h.client.scheduler).mock;
    expect(scheduler.calls.map(([request]) => `${request.phase}:${request.gatewayId}:${request.migrationId}`))
      .toEqual(["retire:gw-blue:mig-op-1:scheduler:1:claim:4000", "activate:gw-green:mig-op-1:scheduler:1:claim:4000"]);
    expect(scheduler.invocationCallOrder[1]).toBeLessThan(vi.mocked(h.client.unmount).mock.invocationCallOrder[0]!);
  });

  it.each(["sourceEpoch", "schemaVersion"] as const)("withholds cleanup and transfer when the durable %s fence changed", async field => {
    const h = mkDeps();
    const checkpoint = { schemaVersion: 1, phase: "source-flushed", sourceEpoch: 4, [field]: 9 };
    const op = mkOp({ schedulerHandoff: { migrationId: "mig-op-1:scheduler:1:claim:4000", uid: "uid-alice", slug: "alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", forwardRecovery: checkpoint } as NonNullable<Operation["schedulerHandoff"]> });
    expect(await createMigrateUserHandler(h.deps)(op, h.ctx)).toMatchObject({ success: false, rolledBack: false });
    expect(h.client.resume).not.toHaveBeenCalled();
    expect(h.client.unmount).not.toHaveBeenCalled();
    expect(h.client.transferState).not.toHaveBeenCalled();
  });
});

it.each(["final-transfer", "checkpoint-claim"])("keeps Native writers held across %s failure and replays the same durable handoff", async failureAt => {
  const h = mkDeps();
  const native = mockNativeReturn();
  h.deps.prepareNativeVmReturn = vi.fn(async () => native);
  let saved: Operation["schedulerHandoff"];
  vi.mocked(h.ctx.persistSchedulerHandoff!).mockImplementation(async state => { saved = structuredClone(state); });
  const transfer = h.client.transferState;
  let failed = false;
  h.client.transferState = vi.fn(async request => {
    if (failureAt === "final-transfer" && request.mode === "final" && !failed) {
      failed = true;
      expect(saved?.forwardRecovery?.schemaVersion).toBe(1);
      throw new MigrationTransportError("upgrade completed; final transfer response lost");
    }
    return transfer(request);
  });
  if (failureAt === "checkpoint-claim") native.requestCheckpoint.mockRejectedValueOnce(new Error("checkpoint claim response lost"));
  const handler = createMigrateUserHandler(h.deps);
  expect(await handler(mkOp({}), h.ctx)).toMatchObject({ success: false, rolledBack: false, error: expect.stringContaining("status 503") });
  expect(native.release).not.toHaveBeenCalled();
  expect(h.client.resume).not.toHaveBeenCalled();
  expect(h.client.unmount).not.toHaveBeenCalled();
  const originalSchedulerId = saved!.migrationId;
  vi.mocked(h.client.quiesce).mockClear();
  vi.mocked(h.client.transferState).mockClear();
  vi.mocked(h.client.scheduler).mockClear();
  expect(await handler(mkOp({ schedulerHandoff: saved!, attempts: 1, startedAt: 6000 }), h.ctx)).toMatchObject({ success: true, rolledBack: false });
  expect(h.client.quiesce).not.toHaveBeenCalled();
  expect(vi.mocked(h.client.transferState).mock.calls.map(([request]) => request.mode)).toEqual(["keys", "final"]);
  expect(vi.mocked(h.client.scheduler).mock.calls.every(([request]) => request.migrationId === originalSchedulerId)).toBe(true);
  expect(native.release).not.toHaveBeenCalled();
  expect(h.client.resume).not.toHaveBeenCalled();
});


describe("source-owned user activation", () => {
  function activation() {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, epoch: 4, assignmentMode: "assigned", gatewayClass: "shared" });
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "isolated" });
    const operation = mkOp({ id: "builder-activate-gw-green-g1", input: { uid: "uid-alice", userSlug: "alice", fromGatewayId: "shared-blue", toGatewayId: "gw-green", source: "builder-activation-lease" } });
    return { ...h, operation };
  }

  it("cleans the target and restores Shared after a failed final import without a forward-only checkpoint", async () => {
    const h = activation();
    h.deps.clearMigrationPreparation = vi.fn(async () => undefined);
    const transfer = vi.mocked(h.client.transferState).getMockImplementation()!;
    vi.mocked(h.client.transferState).mockImplementation(async request => {
      if (request.mode === "final") throw new Error("native agent creation failed");
      return transfer(request);
    });
    const result = await createMigrateUserHandler(h.deps)(h.operation, h.ctx);
    expect(result).toMatchObject({ success: false, rolledBack: true, error: "native agent creation failed" });
    expect(h.deps.completeMigrationRecovery).toHaveBeenCalledWith({
      uid: "uid-alice", sourceGatewayId: "shared-blue", operationId: h.operation.id,
      sourceEpoch: 4, claimStartedAt: 4_000,
    });
    expect(h.deps.clearMigrationPreparation).not.toHaveBeenCalled();
    expect(h.client.unmount).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "gw-green" }));
    expect(h.client.resume).toHaveBeenCalledWith(expect.objectContaining({ gatewayId: "shared-blue" }));
    expect(h.deps.setAssignmentState).toHaveBeenLastCalledWith(expect.objectContaining({ gatewayId: "shared-blue", state: "serving" }));
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
    expect(buildOperationCompletionUpdate({ op: h.operation, result: { ...result, error: "status 503: native agent creation failed" }, steps: h.steps, now: 5_000 })).toMatchObject({ status: "failed", rolledBack: true });
    expect(vi.mocked(h.client.transferState).mock.calls.find(([request]) => request.mode === "final")?.[0].preserveSource).toBe(true);
    expect(vi.mocked(h.ctx.persistSchedulerHandoff!).mock.calls.every(([state]) => !state.forwardRecovery)).toBe(true);
  });

  it("keeps Shared serving when the target uses another OpenClaw build", async () => {
    const h = activation();
    vi.mocked(h.deps.readOpenClawBuild!).mockImplementation(async gateway => gateway === "shared-blue" ? "a".repeat(40) : "b".repeat(40));
    expect(await createMigrateUserHandler(h.deps)(h.operation, h.ctx)).toMatchObject({ success: false, error: expect.stringContaining("same OpenClaw build") });
    expect(h.client.quiesce).not.toHaveBeenCalled();
    expect(h.deps.setAssignmentState).not.toHaveBeenCalled();
  });
});

describe("the move an operator's give starts", () => {
  const giveMove = (attempts: number) => mkOp({ id: "op-give", attempts, input: {
    uid: "uid-alice", fromGatewayId: "gw-blue", toGatewayId: "gw-green", source: "operator-isolated-gateway",
  } });

  const refused = "workspace migration recovery target authority changed";
  const sharedSource = () => {
    const h = mkDeps({ sourceGatewayId: "shared-blue" });
    vi.mocked(h.deps.resolveSourcePlacement).mockResolvedValue({ release: 1, epoch: 4, assignmentMode: "assigned", gatewayClass: "shared" });
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValue({ ok: true, release: 2, gatewayClass: "isolated" });
    h.deps.prepareMigrationAgentStores = vi.fn(async () => undefined);
    h.deps.clearMigrationPreparation = vi.fn(async () => undefined);
    h.deps.assertMigrationSourcePreparationAuthority = vi.fn(async () => { throw new Error(refused); });
    return h;
  };
  const fromShared = (op: Operation): Operation => ({ ...op, input: { ...op.input, fromGatewayId: "shared-blue" } });

  it("clears its preparation fence when source preparation fails, so a second give is not blocked by the first", async () => {
    const h = sharedSource();

    const failed = await createMigrateUserHandler(h.deps)(fromShared(giveMove(0)), h.ctx);

    expect(failed).toMatchObject({ success: false, error: refused });
    expect(h.deps.setMigrationPhase).toHaveBeenCalledWith(expect.objectContaining({ operationId: "op-give", phase: "preparing" }));
    expect(h.deps.clearMigrationPreparation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      uid: "uid-alice", sourceGatewayId: "shared-blue", operationId: "op-give", sourceEpoch: 4,
    }));
    expect(h.deps.commitCutover).not.toHaveBeenCalled();
  });

  it("clears the fence when the user's snapshot is missing after source preparation, and the second give then moves the user", async () => {
    const h = sharedSource();
    h.deps.assertMigrationSourcePreparationAuthority = vi.fn(async () => undefined);
    vi.mocked(h.deps.readUserSnapshot).mockResolvedValueOnce(null);
    const handler = createMigrateUserHandler(h.deps);

    const first = await handler(fromShared(giveMove(0)), h.ctx);

    expect(first).toMatchObject({ success: false, error: "durable snapshot not found for uid-alice" });
    expect(h.deps.clearMigrationPreparation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: "op-give", sourceGatewayId: "shared-blue" }));

    const second = await handler({ ...fromShared(giveMove(0)), id: "op-give-2" }, h.ctx);

    expect(second).toMatchObject({ success: true });
    expect(h.deps.commitCutover).toHaveBeenCalledOnce();
  });

  it.each([
    ["the gateway address cannot be resolved", (h: ReturnType<typeof sharedSource>) => { vi.mocked(h.deps.resolveGatewayUrl).mockRejectedValueOnce(new Error("no route to shared-blue")); }, "no route to shared-blue"],
    ["the run throws before its first step", (h: ReturnType<typeof sharedSource>) => { h.ctx.persistSchedulerHandoff = vi.fn(async () => { throw new Error("journal unavailable"); }); }, "journal unavailable"],
  ])("clears the fence when %s", async (_name, arrange, message) => {
    const h = sharedSource();
    h.deps.assertMigrationSourcePreparationAuthority = vi.fn(async () => undefined);
    arrange(h);

    const outcome = await createMigrateUserHandler(h.deps)(fromShared(giveMove(0)), h.ctx).catch((error: Error) => ({ success: false, error: error.message }));

    expect(outcome).toMatchObject({ success: false, error: expect.stringContaining(message) });
    expect(h.deps.clearMigrationPreparation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operationId: "op-give" }));
  });

  it("says so when the fence cannot be cleared", async () => {
    const h = sharedSource();
    h.deps.clearMigrationPreparation = vi.fn(async () => { throw new Error("workspace preparation cleanup authority changed"); });

    const failed = await createMigrateUserHandler(h.deps)(fromShared(giveMove(0)), h.ctx);

    expect(failed.error).toBe(`${refused}; the preparation fence could not be cleared: workspace preparation cleanup authority changed`);
  });

  it("leaves the fence of a move the product tagged with its lease source to the product's own cleanup", async () => {
    const h = sharedSource();
    const leaseMove = mkOp({ id: "builder-activate-gw-green-g1", attempts: 0, origin: "automatic", input: {
      uid: "uid-alice", fromGatewayId: "shared-blue", toGatewayId: "gw-green", source: "builder-activation-lease",
    } });

    expect(await createMigrateUserHandler(h.deps)(leaseMove, h.ctx)).toMatchObject({ success: false });
    expect(h.deps.setMigrationPhase).toHaveBeenCalledWith(expect.objectContaining({ phase: "preparing" }));
    expect(h.deps.clearMigrationPreparation).not.toHaveBeenCalled();
  });

  it("waits through several readiness checks, retries one transient failure in source preparation, then moves the user", async () => {
    const h = sharedSource();
    const transient = "connect ETIMEDOUT 10.0.0.9:8080";
    vi.mocked(h.deps.resolveTargetPlacement)
      .mockResolvedValueOnce({ ok: false, reason: "no-live-revision" })
      .mockResolvedValueOnce({ ok: false, reason: "no-live-revision" })
      .mockResolvedValueOnce({ ok: false, reason: "no-live-revision" });
    h.deps.assertMigrationSourcePreparationAuthority = vi.fn()
      .mockRejectedValueOnce(new Error(transient))
      .mockResolvedValue(undefined);
    const handler = createMigrateUserHandler(h.deps);
    let op = fromShared(giveMove(0));
    const settle = async (now: number) => {
      const result = await handler({ ...op, status: "running", startedAt: now }, h.ctx);
      const patch = buildOperationCompletionUpdate({ op, result, steps: [...h.steps], now }) as Record<string, unknown>;
      const kept = Object.fromEntries(Object.entries(patch).filter(([, value]) => !(value !== null && typeof value === "object" && "clear" in value)));
      op = { ...op, ...kept } as Operation;
      return patch;
    };

    for (const check of [1, 2, 3]) {
      expect(await settle(5_000 + check)).toMatchObject({ status: "pending", output: { isolatedGatewayReadinessChecks: check } });
    }
    expect(op.attempts).toBe(0);

    expect(await settle(6_000)).toMatchObject({ status: "pending", attempts: 1, error: expect.stringContaining(`attempt 1 failed (transient): ${transient}`) });
    expect(await settle(7_000)).toMatchObject({ status: "succeeded" });
    expect(h.deps.commitCutover).toHaveBeenCalledOnce();
  });

  it.each(["no-live-revision", "revision-not-ready"] as const)("is picked up while the new gateway is %s, waits, then moves the user once it is ready", async (reason) => {
    const h = mkDeps();
    vi.mocked(h.deps.resolveTargetPlacement).mockResolvedValueOnce({ ok: false, reason });
    const handler = createMigrateUserHandler(h.deps);

    const early = await handler(giveMove(0), h.ctx);
    const waiting = buildOperationCompletionUpdate({ op: giveMove(0), result: early, steps: [...h.steps], now: 5_000 });

    expect(early).toMatchObject({ success: false, error: `placement rejected for gw-green: ${reason}` });
    expect(waiting).toMatchObject({ status: "pending", nextAttemptAt: 5_000 + OPERATOR_ISOLATED_GATEWAY_WAIT_MS });
    expect(waiting.error).toContain("waiting for isolated gateway gw-green to become ready (check 1 of 30)");
    expect(h.deps.commitCutover).not.toHaveBeenCalled();

    const ready = await handler(giveMove(1), h.ctx);

    expect(ready).toMatchObject({ success: true });
    expect(h.deps.commitCutover).toHaveBeenCalledOnce();
  });
});
