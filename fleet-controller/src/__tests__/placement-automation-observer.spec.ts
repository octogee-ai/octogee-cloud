import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import {
  createPlacementAutomationGate,
  setPlacementAutomationOwnerInTransaction,
} from "@octogee/core/placement-automation-handoff";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import {
  createPlacementAutomationObserver,
  type PlacementAutomationSample,
} from "../placement-automation-observer.js";

const NOW = 1_762_500_000_000;
const STUCK_AFTER = 3;

type Data = Record<string, unknown>;

function harness(orchestrator: Data | null, runsPlatformPass: boolean) {
  const documents = new Map<string, Data>(orchestrator === null ? [] : [["config/orchestrator", orchestrator]]);
  const store = createDocumentFixtureStore(documents, { serializeTransactions: true });
  const logs: string[] = [];
  const errors: string[] = [];
  const samples: PlacementAutomationSample[] = [];
  const gate = createPlacementAutomationGate({ store, now: () => NOW, log: (message) => logs.push(message), warn: (message) => logs.push(message) });
  const observer = createPlacementAutomationObserver({
    store,
    gate,
    runsPlatformPass,
    stuckAfterObservations: STUCK_AFTER,
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    record: (sample) => samples.push(sample),
  });
  return { documents, store, gate, observer, logs, errors, samples };
}

function setOwner(store: PlatformStateStore, owner: "client" | "fleet-controller") {
  return store.transaction({ label: "test.set-owner" }, (transaction) => setPlacementAutomationOwnerInTransaction(transaction, owner));
}

async function observeTimes(observer: { observe(): Promise<void> }, times: number) {
  for (let index = 0; index < times; index += 1) await observer.observe();
}

describe("placement automation observer", () => {
  it("logs the owner once and records the default phase, writing nothing, when no one flips it", async () => {
    const { observer, logs, errors, samples, documents } = harness(null, true);

    await observeTimes(observer, 5);

    expect(logs).toEqual(["[placement-automation] owner=fleet-controller yieldedAt=none phase=fleet-controller"]);
    expect(errors).toEqual([]);
    expect(samples.at(-1)).toEqual({ owner: "fleet-controller", yieldedAt: null, phase: "fleet-controller", pendingObservations: 0 });
    expect(documents.has("config/orchestrator")).toBe(false);
  });

  it("yields on a platform-only install, where no in-process pass decides anything, and logs each change", async () => {
    const { observer, store, logs, samples } = harness(null, true);
    await observer.observe();

    await setOwner(store, "client");
    await observer.observe();

    expect(logs).toEqual([
      "[placement-automation] owner=fleet-controller yieldedAt=none phase=fleet-controller",
      `[placement-automation] the fleet controller yielded placement automation to the client at ${NOW}`,
      `[placement-automation] owner=client yieldedAt=${NOW} phase=client`,
    ]);
    expect(samples.at(-1)).toEqual({ owner: "client", yieldedAt: NOW, phase: "client", pendingObservations: 0 });

    await setOwner(store, "fleet-controller");
    await observer.observe();
    expect(logs.at(-1)).toBe("[placement-automation] owner=fleet-controller yieldedAt=none phase=fleet-controller");
  });

  it("leaves the yield to the installed in-process pass", async () => {
    const { observer, documents, samples } = harness({ placementAutomationOwner: "client" }, false);

    await observer.observe();

    expect(documents.get("config/orchestrator")?.placementAutomationYieldedAt ?? null).toBeNull();
    expect(samples.at(-1)).toEqual({ owner: "client", yieldedAt: null, phase: "handoff-pending", pendingObservations: 1 });
  });

  it("logs a stuck handoff at error level after N observations without a yield, and again every N", async () => {
    const { observer, errors } = harness({ placementAutomationOwner: "client" }, false);

    await observeTimes(observer, STUCK_AFTER - 1);
    expect(errors).toEqual([]);

    await observer.observe();
    expect(errors).toEqual([
      "[placement-automation] handoff stuck: the owner is the client but the fleet controller has not yielded after 3 observations; 0 in-process passes are running here",
    ]);

    await observeTimes(observer, STUCK_AFTER - 1);
    expect(errors).toHaveLength(1);
    await observer.observe();
    expect(errors).toHaveLength(2);
  });

  it("names the running pass that holds a stuck handoff, and clears once the pass yields", async () => {
    const { observer, gate, store, errors, samples } = harness(null, false);
    let release!: () => void;
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const held = gate.pass(async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await running;
    await setOwner(store, "client");

    await observeTimes(observer, STUCK_AFTER);
    expect(errors.at(-1)).toContain("1 in-process pass is running here");

    release();
    await held;
    await gate.pass(async () => undefined);
    await observer.observe();
    expect(samples.at(-1)).toEqual({ owner: "client", yieldedAt: NOW, phase: "client", pendingObservations: 0 });
  });
});
