import { describe, expect, it, vi } from "vitest";
import { isRetryableSchedulerFailure } from "../lib/scheduler-failure.js";
import { migrateUserScheduler, setUserChannelsRunning } from "../lib/user-channel-quiesce.js";

function runtime() {
  return {
    configGet: vi.fn(async () => ({ config: { channels: { mattermost: { accounts: {
      "alice-coach": {}, "alice-proj-app": {}, "alice2-coach": {}, "bob-coach": {},
    } } } } })),
    channelsStop: vi.fn(async () => ({ stopped: true })),
    channelsStart: vi.fn(async () => ({ started: true })),
  };
}

describe("user migration channel admission", () => {
  it("stops only the migrating user's agent and project accounts", async () => {
    const rpc = runtime();
    await setUserChannelsRunning(rpc as never, "alice", false);
    expect(rpc.channelsStop.mock.calls).toEqual([
      [{ channel: "mattermost", accountId: "alice-coach" }],
      [{ channel: "mattermost", accountId: "alice-proj-app" }],
    ]);
    expect(rpc.channelsStart).not.toHaveBeenCalled();
  });
  it("resumes the same accounts after rollback", async () => {
    const rpc = runtime();
    await setUserChannelsRunning(rpc as never, "alice", true);
    expect(rpc.channelsStart).toHaveBeenCalledTimes(2);
    expect(rpc.channelsStop).not.toHaveBeenCalled();
  });
  it("fails the migration when an account cannot stop", async () => {
    const rpc = runtime();
    rpc.channelsStop.mockRejectedValueOnce(new Error("stop failed"));
    await expect(setUserChannelsRunning(rpc as never, "alice", false)).rejects.toThrow("stop failed");
  });
});

describe("scheduled migration handoff scope", () => {
  it("holds the exact union of local and roster agents for one user", async () => {
    const rpc = {
      configGet: vi.fn(async () => ({ config: { agents: { entries: {
        "octogee-alice-coach": {}, "octogee-alice-proj-app-coach": {}, "octogee-alice2-coach": {},
      } } } })),
      schedulerMigration: vi.fn(async (request) => ({ ...request, drained: true })),
    };
    await migrateUserScheduler(rpc as never, "alice", ["octogee-alice-coach"], { operationId: "handoff-1", phase: "hold" });
    expect(rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "handoff-1", phase: "hold", agentIds: ["octogee-alice-coach", "octogee-alice-proj-app-coach"] });
  });
  it("recovers later phases using the durable runtime scope without loading a removed roster", async () => {
    const rpc = { configGet: vi.fn(), schedulerMigration: vi.fn(async (request) => ({ ...request, drained: true })) };
    await migrateUserScheduler(rpc as never, "alice", [], { operationId: "handoff-1", phase: "retire" });
    expect(rpc.configGet).not.toHaveBeenCalled();
    expect(rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "handoff-1", phase: "retire" });
  });
  it("refuses an empty hold scope, for good", async () => {
    const rpc = { configGet: vi.fn(async () => ({ config: {} })), schedulerMigration: vi.fn() };
    const refused = migrateUserScheduler(rpc as never, "alice", [], { operationId: "handoff-1", phase: "hold" });
    await expect(refused).rejects.toThrow("no user agents");
    expect(isRetryableSchedulerFailure(await refused.catch((error: unknown) => error))).toBe(false);
    expect(rpc.schedulerMigration).not.toHaveBeenCalled();
  });
});


it("refuses a foreign held fence without inferring that its earlier attempt failed", async () => {
  const foreignFence = new Error('/scheduler/shared-0: 500 {"error":"scheduler migration failed","message":"Cron agent octogee-alice-coach is held for migration mig-placement-190929cbf8f86906bee813bffa1a4157:scheduler:1"}');
  const rpc = {
    configGet: vi.fn(async () => ({ config: {} })),
    schedulerMigration: vi.fn()
      .mockRejectedValueOnce(foreignFence)
      .mockResolvedValueOnce({ operationId: "mig-placement-190929cbf8f86906bee813bffa1a4157:scheduler:1", phase: "resume", agentIds: ["octogee-alice-coach"], drained: true })
      .mockResolvedValueOnce({ operationId: "handoff-2", phase: "hold", agentIds: ["octogee-alice-coach"], drained: true }),
  };
  await expect(migrateUserScheduler(rpc as never, "alice", ["octogee-alice-coach"], { operationId: "handoff-2", phase: "hold" })).rejects.toBe(foreignFence);
  expect(rpc.schedulerMigration.mock.calls.map(([request]) => request)).toEqual([
    { operationId: "handoff-2", phase: "hold", agentIds: ["octogee-alice-coach"] },
  ]);
});

it("preserves the original foreign-fence failure without probing whether Native would resume it", async () => {
  const foreignFence = new Error("Cron agent octogee-alice-coach is held for migration other-op:scheduler:1");
  const rpc = {
    configGet: vi.fn(async () => ({ config: {} })),
    schedulerMigration: vi.fn()
      .mockRejectedValueOnce(foreignFence)
      .mockRejectedValueOnce(new Error("Cannot resume staged cron migration")),
  };
  await expect(migrateUserScheduler(rpc as never, "alice", ["octogee-alice-coach"], { operationId: "handoff-2", phase: "hold" }))
    .rejects.toBe(foreignFence);
  expect(rpc.schedulerMigration).toHaveBeenCalledExactlyOnceWith({ operationId: "handoff-2", phase: "hold", agentIds: ["octogee-alice-coach"] });
});

it("returns Native's undrained hold receipt without a second polling loop", async () => {
  const request = { operationId: "handoff-1", phase: "hold" as const };
  const receipt = { ...request, agentIds: ["octogee-alice-coach"], drained: false };
  const rpc = {
    configGet: vi.fn(async () => ({ config: {} })),
    schedulerMigration: vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce({ ...receipt, drained: true }),
  };
  await expect(migrateUserScheduler(rpc as never, "alice", ["octogee-alice-coach"], request)).resolves.toBe(receipt);
  expect(rpc.schedulerMigration).toHaveBeenCalledExactlyOnceWith({ ...request, agentIds: ["octogee-alice-coach"] });
});

it("begins a Native export with the complete user scope while excluding service agents", async () => {
  const rpc = {
    configGet: vi.fn(async () => ({ config: { agents: { entries: {
      "octogee-alice-coach": {}, "octogee-alice-proj-demo-coach": {}, "octogee-bob-coach": {},
    } } } })),
    schedulerMigration: vi.fn(async request => ({ ...request, drained: true })),
  };
  await migrateUserScheduler(rpc as never, "alice", ["main", "octogee-unmatched-route", "octogee-alice-coach"], {
    operationId: "initial-export", phase: "export", resolveAgentScope: true,
  });
  expect(rpc.schedulerMigration).toHaveBeenCalledExactlyOnceWith({
    operationId: "initial-export", phase: "export", agentIds: ["octogee-alice-coach", "octogee-alice-proj-demo-coach"],
  });
});

it("resumes a Native export from its durable scope after the roster was removed", async () => {
  const rpc = { configGet: vi.fn(), schedulerMigration: vi.fn(async request => ({ ...request, drained: true })) };
  await migrateUserScheduler(rpc as never, "alice", [], { operationId: "retained-export", phase: "export" });
  expect(rpc.configGet).not.toHaveBeenCalled();
  expect(rpc.schedulerMigration).toHaveBeenCalledExactlyOnceWith({ operationId: "retained-export", phase: "export" });
});
