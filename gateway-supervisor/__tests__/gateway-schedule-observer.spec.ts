import type { SchedulerMigrationRequest } from "@octogee/shared/types/fleet-controller";
import { workspaceDefaultAgentId } from "@octogee/shared/types/identity";
import { expect, it, vi } from "vitest";
import type { GatewayInventoryEvent } from "../lib/gateway-rpc.js";
import { startGatewayScheduleObserver } from "../lib/gateway-schedule-observer.js";

it("refreshes on connect, publishes changes and removals per owner, and never mutates live cron", async () => {
  const alice = workspaceDefaultAgentId("alice"), bob = workspaceDefaultAgentId("bob");
  let jobs = [
    { id: "a", agentId: alice, enabled: true, name: "Alice", schedule: { kind: "cron", expr: "* * * * *" } },
    { id: "b", agentId: bob, enabled: true, name: "Bob", schedule: { kind: "cron", expr: "* * * * *" } },
  ];
  const onConfigChange = vi.fn();
  let notify: ((event: GatewayInventoryEvent) => void) | undefined;
  const watchScheduleInventory = vi.fn(async (listener: (event: GatewayInventoryEvent) => void, signal: AbortSignal) => {
    notify = listener;
    listener("connected");
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
  const schedulerMigration = vi.fn(async ({ phase, operationId, agentIds = [] }: SchedulerMigrationRequest) => ({
    operationId, phase, agentIds, drained: true,
    snapshot: { version: 1, operationId, agentIds, jobs: jobs.filter(job => agentIds.includes(job.agentId)), scratch: [] },
  }));
  const recordScheduleCheckpoint = vi.fn(async () => {});
  const stop = startGatewayScheduleObserver({
    rpc: {
      schedulerMigration, watchScheduleInventory,
      configGet: async () => ({ config: { agents: { list: [{ id: alice }, { id: bob }] } }, hash: "hash", appliedConfigHash: "hash", configRevisionHash: "hash" }),
    },
    broker: {
      assignmentRoster: async () => [{ uid: "u-a", epoch: 2, state: "serving" }, { uid: "u-b", epoch: 4, state: "serving" }],
      assignedUsers: async () => [{ uid: "u-a", slug: "alice" }, { uid: "u-b", slug: "bob" }] as never,
      recordScheduleCheckpoint,
    },
    log: vi.fn(),
    onConfigChange,
  });
  try {
    await vi.waitFor(() => expect(recordScheduleCheckpoint).toHaveBeenCalledTimes(2));
    expect(recordScheduleCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      uid: "u-a", assignmentEpoch: 2, snapshot: expect.objectContaining({ jobs: [expect.objectContaining({ agentId: alice })] }),
    }));

    jobs = jobs.filter(job => job.id !== "a");
    notify?.("cron.inventory.changed");
    await vi.waitFor(() => expect(recordScheduleCheckpoint).toHaveBeenCalledTimes(4));
    expect(recordScheduleCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ uid: "u-a", assignmentEpoch: 2, snapshot: expect.objectContaining({ jobs: [] }) }));
    expect(onConfigChange).toHaveBeenCalledTimes(1);
    notify?.("config.changed");
    expect(onConfigChange).toHaveBeenCalledTimes(2);
    expect(new Set(schedulerMigration.mock.calls.map(([request]) => request.phase))).toEqual(new Set(["checkpoint"]));
  } finally {
    stop();
  }
});
