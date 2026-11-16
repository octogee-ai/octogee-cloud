import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { PlacementOwnerRefusedError } from "./placement-automation-owner.js";
import {
  createPlacementAutomationGate,
  placementAutomationState,
  readPlacementAutomationState,
  setPlacementAutomationOwnerInTransaction,
  yieldPlacementAutomationInTransaction,
  type PlacementAutomationGate,
  type PlacementAutomationTurn,
} from "./placement-automation-handoff.js";
import type { PlatformStateStore } from "./platform-state/store.js";

const NOW = 1_762_500_000_000;

type Data = Record<string, unknown>;

function fixture(orchestrator: Data | null = null) {
  const documents = new Map<string, Data>(orchestrator === null ? [] : [["config/orchestrator", orchestrator]]);
  const store = createDocumentFixtureStore(documents, { serializeTransactions: true });
  return { documents, store };
}

function gateOn(store: PlatformStateStore, logs: string[] = [], now = () => NOW): PlacementAutomationGate {
  return createPlacementAutomationGate({ store, now, log: (message) => logs.push(message), warn: (message) => logs.push(`warn ${message}`) });
}

function setOwner(store: PlatformStateStore, owner: "client" | "fleet-controller") {
  return store.transaction({ label: "test.set-owner" }, (transaction) => setPlacementAutomationOwnerInTransaction(transaction, owner));
}

function inProcessWrite(store: PlatformStateStore, gate: PlacementAutomationGate) {
  return store.transaction({ label: "test.in-process-write" }, async (transaction) => {
    await gate.requireOwner(transaction);
    return "committed";
  });
}

function stored(documents: Map<string, Data>) {
  return documents.get("config/orchestrator");
}

function deferred() {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { release, released };
}

async function heldPass(gate: PlacementAutomationGate) {
  const hold = deferred();
  let turn!: PlacementAutomationTurn;
  const started = deferred();
  const finished = gate.pass(async (given) => {
    turn = given;
    started.release();
    await hold.released;
  });
  await started.released;
  return { turn: () => turn, finish: async () => { hold.release(); await finished; } };
}

describe("placementAutomationState", () => {
  it("names the phase that decides who acts", () => {
    expect(placementAutomationState({ owner: "fleet-controller", yieldedAt: null }))
      .toEqual({ owner: "fleet-controller", yieldedAt: null, phase: "fleet-controller" });
    expect(placementAutomationState({ owner: "client", yieldedAt: null }))
      .toEqual({ owner: "client", yieldedAt: null, phase: "handoff-pending" });
    expect(placementAutomationState({ owner: "client", yieldedAt: NOW }))
      .toEqual({ owner: "client", yieldedAt: NOW, phase: "client" });
  });
});

describe("setPlacementAutomationOwnerInTransaction", () => {
  it("defaults to the fleet controller, so setting it again changes nothing", async () => {
    const { store, documents } = fixture();

    expect(await setOwner(store, "fleet-controller")).toEqual({
      previous: { owner: "fleet-controller", yieldedAt: null },
      current: { owner: "fleet-controller", yieldedAt: null },
      changed: false,
    });
    expect(stored(documents)).toBeUndefined();
  });

  it("switches to the client without a yield, which the fleet controller must still write", async () => {
    const { store, documents } = fixture({ defaultGatewayId: "shared-a" });

    expect(await setOwner(store, "client")).toMatchObject({ current: { owner: "client", yieldedAt: null }, changed: true });
    expect(stored(documents)).toMatchObject({ defaultGatewayId: "shared-a", placementAutomationOwner: "client" });
    expect(stored(documents)?.placementAutomationYieldedAt ?? null).toBeNull();
  });

  it("never carries a yield recorded before the switch into a new handoff", async () => {
    const { store, documents } = fixture({ placementAutomationOwner: "fleet-controller", placementAutomationYieldedAt: NOW - 1 });

    await setOwner(store, "client");

    expect(stored(documents)?.placementAutomationYieldedAt ?? null).toBeNull();
    expect(await readPlacementAutomationState(store)).toEqual({ owner: "client", yieldedAt: null, phase: "handoff-pending" });
  });

  it("hands back to the fleet controller and clears the yield in one write", async () => {
    const { store, documents } = fixture({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });

    expect(await setOwner(store, "fleet-controller")).toEqual({
      previous: { owner: "client", yieldedAt: NOW },
      current: { owner: "fleet-controller", yieldedAt: null },
      changed: true,
    });
    expect(stored(documents)).toMatchObject({ placementAutomationOwner: "fleet-controller" });
    expect(stored(documents)?.placementAutomationYieldedAt ?? null).toBeNull();
  });

  it("leaves a pending or completed handoff to the client untouched when set to the client again", async () => {
    const { store, documents } = fixture({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });

    expect(await setOwner(store, "client")).toMatchObject({ current: { owner: "client", yieldedAt: NOW }, changed: false });
    expect(stored(documents)).toMatchObject({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });
  });
});

describe("yieldPlacementAutomationInTransaction", () => {
  const yieldAt = (store: PlatformStateStore, at: number) =>
    store.transaction({ label: "test.yield" }, (transaction) => yieldPlacementAutomationInTransaction(transaction, at));

  it("writes nothing while the fleet controller owns placement automation", async () => {
    const { store, documents } = fixture();

    expect(await yieldAt(store, NOW)).toEqual({ kind: "not-requested", ownership: { owner: "fleet-controller", yieldedAt: null } });
    expect(stored(documents)).toBeUndefined();
  });

  it("records the yield once the owner is the client", async () => {
    const { store, documents } = fixture({ placementAutomationOwner: "client" });

    expect(await yieldAt(store, NOW)).toEqual({ kind: "yielded", ownership: { owner: "client", yieldedAt: NOW } });
    expect(stored(documents)).toMatchObject({ placementAutomationYieldedAt: NOW });
  });

  it("keeps the first yield time when it has already yielded", async () => {
    const { store, documents } = fixture({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });

    expect(await yieldAt(store, NOW + 5)).toEqual({ kind: "already-yielded", ownership: { owner: "client", yieldedAt: NOW } });
    expect(stored(documents)).toMatchObject({ placementAutomationYieldedAt: NOW });
  });
});

describe("the in-process pass gate", () => {
  it("lets every pass decide and writes nothing when no one flips the owner, which is today's behavior", async () => {
    const { store, documents } = fixture();
    const gate = gateOn(store);

    const turns = [await gate.pass(async (turn) => turn), await gate.pass(async (turn) => turn)];

    expect(turns).toEqual([
      { decides: true, ownership: { owner: "fleet-controller", yieldedAt: null } },
      { decides: true, ownership: { owner: "fleet-controller", yieldedAt: null } },
    ]);
    await expect(inProcessWrite(store, gate)).resolves.toBe("committed");
    expect(stored(documents)).toBeUndefined();
  });

  it("stops deciding and yields at the start of the first pass that sees the client", async () => {
    const { store, documents } = fixture({ placementAutomationOwner: "client" });
    const logs: string[] = [];
    const gate = gateOn(store, logs);

    const turn = await gate.pass(async (given) => given);

    expect(turn).toEqual({ decides: false, ownership: { owner: "client", yieldedAt: NOW } });
    expect(stored(documents)).toMatchObject({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });
    expect(logs).toContain(`[placement-automation] the fleet controller yielded placement automation to the client at ${NOW}`);
    await expect(inProcessWrite(store, gate)).rejects.toBeInstanceOf(PlacementOwnerRefusedError);
  });

  it("finishes a pass already running when the owner changes, and yields only once it has finished", async () => {
    const { store, documents } = fixture();
    const logs: string[] = [];
    const gate = gateOn(store, logs);
    const running = await heldPass(gate);
    expect(running.turn().decides).toBe(true);

    await setOwner(store, "client");
    const overlapping = await gate.pass(async (turn) => turn);

    expect(overlapping).toEqual({ decides: false, ownership: { owner: "client", yieldedAt: null } });
    expect(logs).toContain("[placement-automation] the owner is the client; waiting for 1 running pass to finish before yielding");
    await expect(inProcessWrite(store, gate)).resolves.toBe("committed");
    expect(stored(documents)?.placementAutomationYieldedAt ?? null).toBeNull();

    await running.finish();
    expect(await gate.pass(async (turn) => turn)).toEqual({ decides: false, ownership: { owner: "client", yieldedAt: NOW } });
    await expect(inProcessWrite(store, gate)).rejects.toBeInstanceOf(PlacementOwnerRefusedError);
  });

  it("yields from a restarted fleet controller whose predecessor never did", async () => {
    const { store } = fixture();
    const before = gateOn(store);
    const lost = await heldPass(before);
    await setOwner(store, "client");

    const restarted = gateOn(store);

    expect(await restarted.pass(async (turn) => turn)).toEqual({ decides: false, ownership: { owner: "client", yieldedAt: NOW } });
    await expect(inProcessWrite(store, before)).rejects.toBeInstanceOf(PlacementOwnerRefusedError);
    await lost.finish();
  });

  it("does not yield again after a restart that follows the yield", async () => {
    const { store, documents } = fixture({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW - 60_000 });

    expect(await gateOn(store, [], () => NOW).pass(async (turn) => turn))
      .toEqual({ decides: false, ownership: { owner: "client", yieldedAt: NOW - 60_000 } });
    expect(stored(documents)).toMatchObject({ placementAutomationYieldedAt: NOW - 60_000 });
  });

  it("refuses the writes of a second replica's running pass once the first replica yields", async () => {
    const { store } = fixture();
    const incoming = gateOn(store);
    const outgoing = gateOn(store);
    const outgoingPass = await heldPass(outgoing);
    expect(outgoingPass.turn().decides).toBe(true);
    await expect(inProcessWrite(store, outgoing)).resolves.toBe("committed");

    await setOwner(store, "client");
    expect(await incoming.pass(async (turn) => turn)).toEqual({ decides: false, ownership: { owner: "client", yieldedAt: NOW } });

    await expect(inProcessWrite(store, outgoing)).rejects.toMatchObject({ code: "placement-owner", refused: "fleet-controller" });
    await outgoingPass.finish();
  });

  it("resumes deciding only on the first pass after the hand-back is committed", async () => {
    const { store } = fixture({ placementAutomationOwner: "client", placementAutomationYieldedAt: NOW });
    const gate = gateOn(store);
    const yielded = await heldPass(gate);
    expect(yielded.turn().decides).toBe(false);

    await setOwner(store, "fleet-controller");

    await expect(inProcessWrite(store, gate)).resolves.toBe("committed");
    expect(await gate.pass(async (turn) => turn)).toEqual({ decides: true, ownership: { owner: "fleet-controller", yieldedAt: null } });
    await yielded.finish();
  });

  it("cancels a pending handoff without a yield when the owner is set back before any pass sees it", async () => {
    const { store, documents } = fixture();
    const gate = gateOn(store);
    await setOwner(store, "client");
    await setOwner(store, "fleet-controller");

    expect(await gate.pass(async (turn) => turn)).toEqual({ decides: true, ownership: { owner: "fleet-controller", yieldedAt: null } });
    expect(stored(documents)?.placementAutomationYieldedAt ?? null).toBeNull();
  });

  it("counts a pass as running until it settles, even when it fails, and remembers when the last one started", async () => {
    const { store } = fixture();
    let clock = NOW;
    const gate = gateOn(store, [], () => clock);
    expect(gate.lastPassStartedAt()).toBeNull();

    const running = await heldPass(gate);
    expect(gate.passesInFlight()).toBe(1);
    await running.finish();
    expect(gate.passesInFlight()).toBe(0);

    clock = NOW + 5;
    let during = -1;
    await expect(gate.pass(async () => {
      during = gate.passesInFlight();
      throw new Error("pass failed");
    })).rejects.toThrow("pass failed");

    expect(during).toBe(1);
    expect(gate.passesInFlight()).toBe(0);
    expect(gate.lastPassStartedAt()).toBe(NOW + 5);
  });

  it("reports a failed yield and leaves the handoff pending for the next pass", async () => {
    const { store } = fixture({ placementAutomationOwner: "client" });
    const logs: string[] = [];
    const failing: PlatformStateStore = {
      ...store,
      transaction: (options, body) => options.readOnly === true ? store.transaction(options, body) : Promise.reject(new Error("contention")),
    } as PlatformStateStore;

    expect(await gateOn(failing, logs).pass(async (turn) => turn)).toEqual({ decides: false, ownership: { owner: "client", yieldedAt: null } });
    expect(logs).toContain("warn [placement-automation] the fleet controller could not record its yield: contention");
    expect(await readPlacementAutomationState(store)).toMatchObject({ phase: "handoff-pending" });
  });
});
