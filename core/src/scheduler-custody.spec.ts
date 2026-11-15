import { describe, expect, it, vi } from "vitest";
import { MigrationRpcError, type MigrationClient } from "./fleet-migration-client.js";
import { releaseSchedulerCustody, type SchedulerCustodyOwner } from "./scheduler-custody.js";
import { createCronCustodyGateways, type CronCustodyGateways } from "@octogee/core-testing/cron-custody";

const VM = "alice-vm", COACH = "octogee-alice-coach";
const RETURN = "builder-return-alice-vm-g1", RETURN_HOLD = `mig-${RETURN}:scheduler:1:claim:100`;
const ACTIVATION = "builder-activate-alice-vm-g2", CUTOVER = 5_000;
const returned: SchedulerCustodyOwner = {
  kind: "migrate-user", status: "succeeded", input: { uid: "uid-alice", fromGatewayId: VM, toGatewayId: "shared-1" },
  cutoverCommittedAt: 1_000, completedAt: 1_200,
};

function returnedVm(row: "retired" | "exported") {
  const custody = createCronCustodyGateways({ alice: [COACH] });
  const vm = custody.store(VM);
  const check = vm.add({ agentId: COACH, name: "Proactive check", enabled: true });
  const watch = vm.add({ agentId: COACH, name: "Inbox watch", enabled: true, schedule: { kind: "event" } });
  vm.migrate({ operationId: RETURN_HOLD, phase: "hold", agentIds: [COACH], retainNonportable: true });
  vm.migrate({ operationId: RETURN_HOLD, phase: "export", retainNonportable: true });
  if (row === "retired") vm.migrate({ operationId: RETURN_HOLD, phase: "retire" });
  return { custody, vm, check, watch };
}

function releaser(custody: CronCustodyGateways, operations: Record<string, SchedulerCustodyOwner> = {}) {
  const log = vi.fn();
  const client = custody.client({ transferState: vi.fn() } as unknown as MigrationClient, () => `http://${VM}.fixture:3003`);
  const deps = {
    scheduler: vi.fn(client.scheduler),
    readOperation: vi.fn(async (operationId: string) => operations[operationId] ?? null),
    assertOwner: vi.fn(async () => undefined),
    log,
  };
  const scope = { uid: "uid-alice", slug: "alice", gatewayId: VM, operationId: ACTIVATION, ownedSince: CUTOVER };
  return { deps, log, run: (agentIds: string[] = [COACH]) => releaseSchedulerCustody(deps, scope, agentIds) };
}

const lines = (log: ReturnType<typeof vi.fn>) => log.mock.calls.flat().map(String);

describe("releaseSchedulerCustody", () => {
  it("releases a retired fence whatever operation retired it, and the host-bound job the return retained runs again", async () => {
    const { custody, vm, check, watch } = returnedVm("retired");
    expect(vm.runnable(watch.id)).toBe(false);
    const h = releaser(custody);

    expect(await h.run()).toEqual([{ agentId: COACH, outcome: "released", holder: null }]);

    expect(vm.fences.has(COACH)).toBe(false);
    expect(vm.jobs.has(check.id)).toBe(false);
    expect(vm.runnable(watch.id)).toBe(true);
    expect(h.deps.readOperation).not.toHaveBeenCalled();
    expect(lines(h.log)).toContainEqual(expect.stringContaining(`released the scheduler custody of ${COACH} on ${VM}`));
  });

  it("retires, then releases, an exported fence whose return moved the user off this gateway before this activation", async () => {
    const { custody, vm, check, watch } = returnedVm("exported");
    const h = releaser(custody, { [RETURN]: returned });

    expect(await h.run()).toEqual([{ agentId: COACH, outcome: "released", holder: RETURN_HOLD }]);

    expect(vm.status(RETURN_HOLD)).toBe("retired");
    expect(vm.fences.has(COACH)).toBe(false);
    expect(vm.jobs.has(check.id)).toBe(false);
    expect(vm.runnable(watch.id)).toBe(true);
  });

  it("keeps an exported fence whose owner has left the journal, and every job under it", async () => {
    const { custody, vm, check, watch } = returnedVm("exported");
    const h = releaser(custody);

    expect(await h.run()).toEqual([{
      agentId: COACH, outcome: "kept", holder: RETURN_HOLD, reason: `${RETURN_HOLD} is not retired and ${RETURN} has left the journal`,
    }]);

    expect(custody.calls.filter(call => call.includes(":retire:"))).toEqual([]);
    expect(vm.fences.get(COACH)).toBe(RETURN_HOLD);
    expect(vm.status(RETURN_HOLD)).toBe("exported");
    expect([...vm.jobs.keys()].sort()).toEqual([check.id, watch.id].sort());
    expect(lines(h.log)).toContainEqual(expect.stringMatching(
      new RegExp(`⚠ alice: kept the scheduler fence of ${COACH} on ${VM} held by ${RETURN_HOLD}`)));
  });

  it.each([
    ["still running", { ...returned, status: "running" as const, completedAt: null }, `${RETURN} is still running`],
    ["finished after this activation's cutover", { ...returned, completedAt: CUTOVER + 1 }, `${RETURN} succeeded at ${CUTOVER + 1}, after ${VM} took the user back at ${CUTOVER}`],
    ["rolled back without a cutover", { ...returned, status: "failed" as const, cutoverCommittedAt: undefined, completedAt: 1_200 },
      `${RETURN} failed without moving the user off ${VM}`],
    ["another user's move", { ...returned, input: { ...returned.input, uid: "uid-bob" } }, `${RETURN} succeeded without moving the user off ${VM}`],
  ])("keeps an exported fence whose owner is %s", async (_case, owner, reason) => {
    const { custody, vm, check } = returnedVm("exported");
    const h = releaser(custody, { [RETURN]: owner as SchedulerCustodyOwner });

    expect(await h.run()).toEqual([{ agentId: COACH, outcome: "kept", holder: RETURN_HOLD, reason }]);

    expect(vm.status(RETURN_HOLD)).toBe("exported");
    expect(vm.jobs.has(check.id)).toBe(true);
  });

  it("keeps a fence held by the operation doing the release, and one whose holder names no operation", async () => {
    const custody = createCronCustodyGateways({ alice: [COACH] });
    const own = `mig-${ACTIVATION}:scheduler:1:claim:4000`;
    custody.store(VM).migrate({ operationId: own, phase: "hold", agentIds: [COACH] });
    custody.store("other-vm").migrate({ operationId: "legacy-hold", phase: "hold", agentIds: [COACH] });

    expect(await releaser(custody).run()).toEqual([{ agentId: COACH, outcome: "kept", holder: own, reason: `${own} belongs to ${ACTIVATION} itself` }]);
    const other = releaser(custody);
    const scope = { uid: "uid-alice", slug: "alice", gatewayId: "other-vm", operationId: ACTIVATION, ownedSince: CUTOVER };
    expect(await releaseSchedulerCustody(other.deps, scope, [COACH]))
      .toEqual([{ agentId: COACH, outcome: "kept", holder: "legacy-hold", reason: "legacy-hold names no operation" }]);
  });

  it("finishes a release that an earlier operation staged but never activated", async () => {
    const { custody, vm } = returnedVm("retired");
    const earlier = `mig-builder-activate-alice-vm-g1:release:${COACH}`;
    vm.migrate({ operationId: earlier, phase: "stage", agentIds: [COACH], retainNonportable: true,
      snapshot: { version: 1, operationId: earlier, agentIds: [COACH], jobs: [], scratch: [] } });
    const h = releaser(custody, { "builder-activate-alice-vm-g1": { kind: "migrate-user", status: "failed", input: {}, completedAt: 1_500 } });

    expect(await h.run()).toEqual([{ agentId: COACH, outcome: "released", holder: earlier }]);
    expect(vm.status(earlier)).toBe("activated");
    expect(vm.fences.has(COACH)).toBe(false);
  });

  it("reports a clear agent whose jobs are outside any custody without fencing it", async () => {
    const custody = createCronCustodyGateways({ alice: [COACH] });
    const job = custody.store(VM).add({ agentId: COACH, name: "Proactive check", enabled: true });

    expect(await releaser(custody).run()).toEqual([{ agentId: COACH, outcome: "clear" }]);
    expect(custody.store(VM).fences.has(COACH)).toBe(false);
    expect(custody.store(VM).runnable(job.id)).toBe(true);
  });

  it("touches nothing once the user is no longer assigned to the gateway", async () => {
    const { custody, vm } = returnedVm("retired");
    const h = releaser(custody);
    h.deps.assertOwner.mockRejectedValue(new Error("alice is no longer assigned to alice-vm"));

    await expect(h.run()).rejects.toThrow("alice is no longer assigned to alice-vm");
    expect(h.deps.scheduler).not.toHaveBeenCalled();
    expect(vm.fences.get(COACH)).toBe(RETURN_HOLD);
  });

  it("stops before retiring a fence's holder once the user is no longer assigned to the gateway", async () => {
    const { custody, vm } = returnedVm("exported");
    const h = releaser(custody, { [RETURN]: returned });
    h.deps.assertOwner.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("alice is no longer assigned to alice-vm"));

    await expect(h.run()).rejects.toThrow("alice is no longer assigned to alice-vm");
    expect(h.deps.scheduler.mock.calls.map(([request]) => request.phase)).toEqual(["stage"]);
    expect(vm.status(RETURN_HOLD)).toBe("exported");
    expect(vm.fences.get(COACH)).toBe(RETURN_HOLD);
  });

  it("stops before activating a staged release once the user is no longer assigned to the gateway, and says so", async () => {
    const { custody, vm, watch } = returnedVm("retired");
    const h = releaser(custody);
    h.deps.assertOwner.mockResolvedValueOnce(undefined).mockRejectedValue(new Error("alice is no longer assigned to alice-vm"));

    await expect(h.run()).rejects.toThrow("alice is no longer assigned to alice-vm");

    expect(h.deps.scheduler.mock.calls.map(([request]) => request.phase)).toEqual(["stage"]);
    expect(vm.fences.has(COACH)).toBe(true);
    expect(vm.runnable(watch.id)).toBe(false);
    expect(lines(h.log)).toEqual([
      `[scheduler-custody] ❌ alice: stopped before activating mig-${ACTIVATION}:release:${COACH} on ${VM}: alice is no longer assigned to alice-vm op=${ACTIVATION}`,
    ]);
  });

  it("tells a release the gateway may yet accept from one it refuses", async () => {
    const { custody, vm } = returnedVm("retired");
    vm.runningAgents.add(COACH);
    const h = releaser(custody);
    expect(await h.run()).toEqual([expect.objectContaining({ outcome: "failed", transient: true, error: expect.stringContaining("unsettled runs") })]);

    h.deps.scheduler.mockRejectedValueOnce(new MigrationRpcError(`/scheduler/${VM}: 503 restarting`, { status: 503 }));
    expect(await h.run()).toEqual([expect.objectContaining({ outcome: "failed", transient: true })]);

    h.deps.scheduler.mockRejectedValueOnce(new MigrationRpcError(
      `/scheduler/${VM}: 500 {"error":"scheduler migration failed","message":"socket closed before cron.migration response","retryable":true}`,
      { status: 500, retryable: true },
    ));
    expect(await h.run()).toEqual([expect.objectContaining({ outcome: "failed", transient: true, error: expect.stringContaining("socket closed") })]);

    h.deps.scheduler.mockRejectedValueOnce(new MigrationRpcError(`/scheduler/${VM}: 500 Internal Server Error`, { status: 500 }));
    expect(await h.run()).toEqual([expect.objectContaining({ outcome: "failed", transient: true })]);

    h.deps.scheduler.mockRejectedValueOnce(new Error("scheduler activate did not prove a drained matching operation"));
    expect(await h.run()).toEqual([expect.objectContaining({ outcome: "failed", transient: true })]);

    h.deps.scheduler.mockRejectedValueOnce(new MigrationRpcError(
      `/scheduler/${VM}: 500 {"error":"scheduler migration failed","message":"Cron migration snapshot contains unsettled runs","retryable":false}`,
      { status: 500, retryable: false },
    ));
    expect(await h.run()).toEqual([expect.objectContaining({ outcome: "failed", transient: false })]);

    h.deps.scheduler.mockRejectedValueOnce(new MigrationRpcError(
      `/scheduler/${VM}: 500 {"error":"scheduler migration failed","message":"Cron migration requires an explicit owner for legacy default-agent jobs","retryable":false}`,
      { status: 500, retryable: false },
    ));
    expect(await h.run()).toEqual([expect.objectContaining({ outcome: "failed", transient: false, error: expect.stringContaining("explicit owner") })]);

    h.deps.scheduler.mockRejectedValueOnce(new MigrationRpcError(`/scheduler/${VM}: 400 {"error":"invalid scheduler migration request"}`, { status: 400 }));
    expect(await h.run()).toEqual([expect.objectContaining({ outcome: "failed", transient: false })]);
  });
});
