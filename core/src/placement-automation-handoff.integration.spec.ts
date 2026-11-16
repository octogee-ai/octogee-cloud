import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertClientOwnsPlacementAutomation,
  assertFleetControllerOwnsPlacementAutomation,
  placementOwnerRefusalBody,
} from "./placement-automation-owner.js";
import {
  readPlacementAutomationState,
  setPlacementAutomationOwnerInTransaction,
  yieldPlacementAutomationInTransaction,
} from "./placement-automation-handoff.js";
import { createHarness, dsn, gate, operation, type PlatformStateHarness } from "./platform-state/postgres/__tests__/fixtures/harness.js";
import type { PlatformStateTransaction } from "./platform-state/store.js";

const NOW = 1_762_500_000_000;

type OwnerCheck = (transaction: PlatformStateTransaction) => Promise<unknown>;

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error);
}

describe.skipIf(!dsn)("PostgreSQL placement automation handoff", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  const setOwner = (owner: "client" | "fleet-controller") =>
    harness.store.transaction({ label: "test.set-owner" }, (transaction) => setPlacementAutomationOwnerInTransaction(transaction, owner));

  const yieldNow = () =>
    harness.store.transaction({ label: "test.yield" }, (transaction) => yieldPlacementAutomationInTransaction(transaction, NOW));

  const runningOperationIds = async () =>
    (await harness.store.journal.operations.listByStatus(["running"])).map((stored) => stored.id).sort();

  function claimRunning(id: string, check: OwnerCheck, pause?: { read: () => void; resume: Promise<void> }) {
    return harness.store.transaction({ label: `test.claim ${id}` }, async (transaction) => {
      await check(transaction);
      const running = await transaction.journal.operations.listByStatus(["running"]);
      if (pause !== undefined && transaction.attempt === 1) {
        pause.read();
        await pause.resume;
      }
      if (running.length > 0) return "skipped";
      await transaction.journal.operations.create(operation({ id, status: "running", startedAt: NOW }));
      return "claimed";
    });
  }

  it("records the yield through the fenced update path and inserts nothing while the fleet controller owns placement", async () => {
    expect(await yieldNow()).toMatchObject({ kind: "not-requested" });
    expect(await harness.store.config.orchestrator.get()).toBeNull();

    await setOwner("client");
    expect(await yieldNow()).toEqual({ kind: "yielded", ownership: { owner: "client", yieldedAt: NOW } });
    expect(await readPlacementAutomationState(harness.store)).toEqual({ owner: "client", yieldedAt: NOW, phase: "client" });

    await setOwner("fleet-controller");
    expect(await readPlacementAutomationState(harness.store)).toEqual({ owner: "fleet-controller", yieldedAt: null, phase: "fleet-controller" });
  });

  it("refuses an in-process write that read the owner before the yield once a client verb has acted after it", async () => {
    await setOwner("client");
    const read = gate();
    const resume = gate();
    const inProcess = failure(claimRunning("in-process", assertFleetControllerOwnsPlacementAutomation, { read: read.open, resume: resume.opened }));
    await read.opened;

    expect(await yieldNow()).toMatchObject({ kind: "yielded" });
    expect(await claimRunning("client", assertClientOwnsPlacementAutomation)).toBe("claimed");
    resume.open();

    expect(placementOwnerRefusalBody(await inProcess)).toMatchObject({ code: "placement-owner" });
    expect(await runningOperationIds()).toEqual(["client"]);
  });

  it("refuses a client verb that read the owner before the hand-back once the in-process pass has acted after it", async () => {
    await setOwner("client");
    await yieldNow();
    const read = gate();
    const resume = gate();
    const client = failure(claimRunning("client", assertClientOwnsPlacementAutomation, { read: read.open, resume: resume.opened }));
    await read.opened;

    await setOwner("fleet-controller");
    expect(await claimRunning("in-process", assertFleetControllerOwnsPlacementAutomation)).toBe("claimed");
    resume.open();

    expect(placementOwnerRefusalBody(await client)).toMatchObject({ code: "placement-owner" });
    expect(await runningOperationIds()).toEqual(["in-process"]);
  });

  function paused<T>(label: string, body: (transaction: PlatformStateTransaction) => Promise<T>) {
    const read = gate();
    const resume = gate();
    const attempts: number[] = [];
    const run = harness.store.transaction({ label }, async (transaction) => {
      attempts.push(transaction.attempt);
      await transaction.config.orchestrator.get();
      if (transaction.attempt === 1) {
        read.open();
        await resume.opened;
      }
      return body(transaction);
    });
    return { read: read.opened, resume: resume.open, run, attempts };
  }

  it("commits a disjoint in-process write that read the owner before the yield, serialized ahead of it", async () => {
    await setOwner("client");
    const write = paused("test.disjoint-write", async (transaction) => {
      await assertFleetControllerOwnsPlacementAutomation(transaction);
      await transaction.journal.operations.create(operation({ id: "in-process", status: "running", startedAt: NOW }));
      return "claimed";
    });
    await write.read;

    expect(await yieldNow()).toMatchObject({ kind: "yielded" });
    write.resume();

    expect(await write.run).toBe("claimed");
    expect(write.attempts).toEqual([1]);
    expect(await runningOperationIds()).toEqual(["in-process"]);
  });

  it("drops a yield that read the owner before a hand-back committed, leaving no yield", async () => {
    await setOwner("client");
    const pending = paused("test.yield", (transaction) => yieldPlacementAutomationInTransaction(transaction, NOW));
    await pending.read;

    await setOwner("fleet-controller");
    pending.resume();

    expect(await pending.run).toEqual({ kind: "not-requested", ownership: { owner: "fleet-controller", yieldedAt: null } });
    expect(pending.attempts.length).toBeGreaterThanOrEqual(2);
    expect(await readPlacementAutomationState(harness.store)).toEqual({ owner: "fleet-controller", yieldedAt: null, phase: "fleet-controller" });
  });

  it("clears a yield that committed while a hand-back was reading the owner", async () => {
    await setOwner("client");
    const handBack = paused("test.hand-back", (transaction) => setPlacementAutomationOwnerInTransaction(transaction, "fleet-controller"));
    await handBack.read;

    expect(await yieldNow()).toEqual({ kind: "yielded", ownership: { owner: "client", yieldedAt: NOW } });
    handBack.resume();

    expect(await handBack.run).toEqual({
      previous: { owner: "client", yieldedAt: NOW },
      current: { owner: "fleet-controller", yieldedAt: null },
      changed: true,
    });
    expect(handBack.attempts.length).toBeGreaterThanOrEqual(2);
    expect(await readPlacementAutomationState(harness.store)).toEqual({ owner: "fleet-controller", yieldedAt: null, phase: "fleet-controller" });
  });
});
