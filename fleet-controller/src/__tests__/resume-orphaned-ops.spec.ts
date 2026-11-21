import { describe, it, expect, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { resumeOrphanedRunningOps, type ResumeOrphanedOpsDeps } from "../resume-orphaned-ops.js";
import type { Operation } from "@octogee/shared/types/glm";
import { operationNeedsDurableUserMigrationV2Resume } from "../operation-retry.js";

interface FakeOpDoc {
  id: string;
  data: Partial<Operation> & { status?: string; kind?: string; recordType?: string };
}

function makeStore(ops: FakeOpDoc[]) {
  return createDocumentFixtureStore(Object.fromEntries(ops.map((op) => [`glmOperations/${op.id}`, op.data as Record<string, unknown>])));
}

const RESUMABLE = new Set(["rollout"]);

describe("resumeOrphanedRunningOps", () => {
  it("does not re-drive a running audit record", async () => {
    const redrive = vi.fn<ResumeOrphanedOpsDeps["redrive"]>(async () => undefined);
    const result = await resumeOrphanedRunningOps({
      store: makeStore([
        {
          id: "audit-running",
          data: { recordType: "audit", status: "running", kind: "rollout" },
        },
      ]),
      log: vi.fn(),
      resumableKinds: RESUMABLE,
      redrive,
    });

    expect(result).toEqual({ scanned: 0, resumed: 0 });
    expect(redrive).not.toHaveBeenCalled();
  });

  it("re-drives a running rollout op (orphaned by a restart)", async () => {
    const redrive = vi.fn<ResumeOrphanedOpsDeps["redrive"]>(async () => undefined);
    const ops: FakeOpDoc[] = [
      { id: "op-roll", data: { status: "running", kind: "rollout" } },
    ];
    const result = await resumeOrphanedRunningOps({
      store: makeStore(ops),
      log: vi.fn(),
      resumableKinds: RESUMABLE,
      redrive,
    });
    expect(result).toEqual({ scanned: 1, resumed: 1 });
    expect(redrive).toHaveBeenCalledTimes(1);
    expect(redrive.mock.calls[0][0]).toMatchObject({ id: "op-roll", kind: "rollout" });
  });

  it("re-adopts all three independent prewarms while the first handler is still waiting", async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>(resolve => { finishFirst = resolve; });
    const started: string[] = [];
    const operations = ["a", "b", "c", "overflow"].map<FakeOpDoc>(id => ({
      id,
      data: { status: "running", kind: "prewarm-gateway", input: { uid: id, gatewayId: `computer-${id}` } },
    }));
    const sweep = resumeOrphanedRunningOps({
      store: makeStore(operations),
      log: vi.fn(),
      resumableKinds: new Set(["prewarm-gateway"]),
      redrive: async op => {
        started.push(op.id);
        if (op.id === "a") await first;
      },
    });
    try {
      await vi.waitFor(() => expect(started).toEqual(["a", "b", "c"]), { timeout: 250 });
    } finally {
      finishFirst();
      await sweep;
    }
    await expect(sweep).resolves.toEqual({ scanned: 4, resumed: 4 });
    expect(started).toEqual(["a", "b", "c", "overflow"]);
  });

  it.each([
    ["same owner", { uid: "owner-a", gatewayId: "computer-b" }],
    ["same gateway", { uid: "owner-b", gatewayId: "computer-a" }],
  ])("keeps orphaned prewarms with the %s sequential", async (_scope, input) => {
    let finishFirst!: () => void;
    const first = new Promise<void>(resolve => { finishFirst = resolve; });
    const redrive = vi.fn<ResumeOrphanedOpsDeps["redrive"]>(async op => {
      if (op.id === "a") await first;
    });
    const sweep = resumeOrphanedRunningOps({
      store: makeStore([
        { id: "a", data: { status: "running", kind: "prewarm-gateway", input: { uid: "owner-a", gatewayId: "computer-a" } } },
        { id: "b", data: { status: "running", kind: "prewarm-gateway", input } },
        { id: "c", data: { status: "running", kind: "rollout" } },
      ]),
      log: vi.fn(),
      resumableKinds: new Set(["prewarm-gateway", "rollout"]),
      redrive,
    });
    try {
      await vi.waitFor(() => expect(redrive).toHaveBeenCalledOnce());
      expect(redrive).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
    } finally {
      finishFirst();
      await sweep;
    }
    expect(redrive.mock.calls.map(([operation]) => operation.id)).toEqual(["a", "b", "c"]);
  });

  it("skips non-resumable running kinds (migrate-customer sub-ops, add-gateway) — the rollout re-drive re-issues those", async () => {
    const redrive = vi.fn<ResumeOrphanedOpsDeps["redrive"]>(async () => undefined);
    const ops: FakeOpDoc[] = [
      { id: "op-mig", data: { status: "running", kind: "migrate-user" } },
      { id: "op-add", data: { status: "running", kind: "add-gateway" } },
    ];
    const result = await resumeOrphanedRunningOps({
      store: makeStore(ops),
      log: vi.fn(),
      resumableKinds: RESUMABLE,
      redrive,
    });
    expect(result).toEqual({ scanned: 2, resumed: 0 });
    expect(redrive).not.toHaveBeenCalled();
  });

  it("resumes only migrate-customer operations carrying active durable V2 state", async () => {
    const active = {
      id: "op-v2",
      data: {
        status: "running",
        kind: "migrate-user",
        userMigrationV2: { phase: "checkpointed" },
      },
    };
    const legacy = { id: "op-v1", data: { status: "running", kind: "migrate-user" } };
    const redrive = vi.fn<ResumeOrphanedOpsDeps["redrive"]>(async () => undefined);

    await resumeOrphanedRunningOps({
      store: makeStore([active, legacy] as FakeOpDoc[]),
      log: vi.fn(),
      resumableKinds: new Set(["rollout", "migrate-user"]),
      resumableOperation: (op) => op.kind !== "migrate-user" || !!op.userMigrationV2,
      redrive,
    });

    expect(redrive).toHaveBeenCalledOnce();
    expect(redrive).toHaveBeenCalledWith(expect.objectContaining({ id: "op-v2" }));
  });

  it.each(["complete", "aborted"] as const)(
    "re-drives a terminal %s phase until the operation result is durably persisted",
    async (phase) => {
      const terminal = {
        id: `op-${phase}`,
        data: {
          status: "running",
          kind: "migrate-user",
          userMigrationV2: { phase },
        },
      };
      const redrive = vi.fn<ResumeOrphanedOpsDeps["redrive"]>(async () => undefined);

      await resumeOrphanedRunningOps({
        store: makeStore([terminal] as FakeOpDoc[]),
        log: vi.fn(),
        resumableKinds: new Set(["rollout", "migrate-user"]),
        resumableOperation: operationNeedsDurableUserMigrationV2Resume,
        redrive,
      });

      expect(redrive).toHaveBeenCalledOnce();
    },
  );

  it("only scans `running` ops (pending/succeeded are left to the normal worker)", async () => {
    const redrive = vi.fn<ResumeOrphanedOpsDeps["redrive"]>(async () => undefined);
    const ops: FakeOpDoc[] = [
      { id: "op-pending", data: { status: "pending", kind: "rollout" } },
      { id: "op-done", data: { status: "succeeded", kind: "rollout" } },
      { id: "op-run", data: { status: "running", kind: "rollout" } },
    ];
    const result = await resumeOrphanedRunningOps({
      store: makeStore(ops),
      log: vi.fn(),
      resumableKinds: RESUMABLE,
      redrive,
    });
    expect(result).toEqual({ scanned: 1, resumed: 1 });
    expect(redrive).toHaveBeenCalledTimes(1);
  });

  it("a re-drive that throws is logged and does not abort the sweep", async () => {
    const redrive = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    const ops: FakeOpDoc[] = [
      { id: "op-a", data: { status: "running", kind: "rollout" } },
      { id: "op-b", data: { status: "running", kind: "rollout" } },
    ];
    const result = await resumeOrphanedRunningOps({
      store: makeStore(ops),
      log,
      resumableKinds: RESUMABLE,
      redrive,
    });
    expect(result).toEqual({ scanned: 2, resumed: 1 });
    expect(redrive).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("op-a"));
  });
});
