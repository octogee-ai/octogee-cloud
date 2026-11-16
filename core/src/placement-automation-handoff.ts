import type { PlacementOwnerFence } from "./isolated-gateway-lifecycle/inputs.js";
import {
  assertFleetControllerOwnsPlacementAutomation,
  placementAutomationOwnership,
  readPlacementAutomationOwnership,
  type PlacementAutomationOwner,
  type PlacementAutomationOwnership,
} from "./placement-automation-owner.js";
import type { PlatformStateStore, PlatformStateTransaction } from "./platform-state/store.js";

export type PlacementAutomationPhase = "fleet-controller" | "handoff-pending" | "client";

export interface PlacementAutomationState extends PlacementAutomationOwnership {
  readonly phase: PlacementAutomationPhase;
}

function placementAutomationPhase(ownership: PlacementAutomationOwnership): PlacementAutomationPhase {
  if (ownership.owner === "fleet-controller") return "fleet-controller";
  return ownership.yieldedAt === null ? "handoff-pending" : "client";
}

export function placementAutomationState(ownership: PlacementAutomationOwnership): PlacementAutomationState {
  return { owner: ownership.owner, yieldedAt: ownership.yieldedAt, phase: placementAutomationPhase(ownership) };
}

export async function readPlacementAutomationState(store: PlatformStateStore): Promise<PlacementAutomationState> {
  const ownership = await store.transaction({ label: "placement-automation.read", readOnly: true }, readPlacementAutomationOwnership);
  return placementAutomationState(ownership);
}

export interface PlacementAutomationOwnerChange {
  readonly previous: PlacementAutomationOwnership;
  readonly current: PlacementAutomationOwnership;
  readonly changed: boolean;
}

export async function setPlacementAutomationOwnerInTransaction(
  transaction: PlatformStateTransaction,
  owner: PlacementAutomationOwner,
): Promise<PlacementAutomationOwnerChange> {
  const stored = await transaction.config.orchestrator.get();
  const previous = placementAutomationOwnership(stored);
  if (previous.owner === owner) return { previous, current: previous, changed: false };
  await transaction.config.orchestrator.patch(
    { placementAutomationOwner: owner, placementAutomationYieldedAt: { clear: true } },
    stored === null ? undefined : { revision: stored.revision },
  );
  return { previous, current: { owner, yieldedAt: null }, changed: true };
}

export type PlacementYieldOutcome =
  | { readonly kind: "not-requested"; readonly ownership: PlacementAutomationOwnership }
  | { readonly kind: "already-yielded"; readonly ownership: PlacementAutomationOwnership }
  | { readonly kind: "yielded"; readonly ownership: PlacementAutomationOwnership };

export async function yieldPlacementAutomationInTransaction(
  transaction: PlatformStateTransaction,
  now: number,
): Promise<PlacementYieldOutcome> {
  const stored = await transaction.config.orchestrator.get();
  const ownership = placementAutomationOwnership(stored);
  if (stored === null || ownership.owner !== "client") return { kind: "not-requested", ownership };
  if (ownership.yieldedAt !== null) return { kind: "already-yielded", ownership };
  await transaction.config.orchestrator.patch({ placementAutomationYieldedAt: now }, { revision: stored.revision });
  return { kind: "yielded", ownership: { owner: "client", yieldedAt: now } };
}

export interface PlacementAutomationTurn {
  readonly decides: boolean;
  readonly ownership: PlacementAutomationOwnership;
}

export interface PlacementAutomationGate {
  pass<T>(run: (turn: PlacementAutomationTurn) => Promise<T>): Promise<T>;
  readonly requireOwner: PlacementOwnerFence;
  passesInFlight(): number;
}

export interface PlacementAutomationGateDeps {
  store: PlatformStateStore;
  now(): number;
  log(message: string): void;
  warn(message: string): void;
}

const requireFleetControllerOwner: PlacementOwnerFence = async (transaction) => {
  await assertFleetControllerOwnsPlacementAutomation(transaction);
};

function passCount(count: number): string {
  return count === 1 ? "1 running pass" : `${count} running passes`;
}

export function createPlacementAutomationGate(deps: PlacementAutomationGateDeps): PlacementAutomationGate {
  let inFlight = 0;

  async function yieldToClient(ownership: PlacementAutomationOwnership): Promise<PlacementAutomationTurn> {
    let outcome: PlacementYieldOutcome;
    try {
      outcome = await deps.store.transaction({ label: "placement-automation.yield" }, (transaction) =>
        yieldPlacementAutomationInTransaction(transaction, deps.now()));
    } catch (error) {
      deps.warn(`[placement-automation] the fleet controller could not record its yield: ${error instanceof Error ? error.message : String(error)}`);
      return { decides: false, ownership };
    }
    if (outcome.kind === "yielded") {
      deps.log(`[placement-automation] the fleet controller yielded placement automation to the client at ${outcome.ownership.yieldedAt}`);
    }
    return { decides: outcome.ownership.owner === "fleet-controller", ownership: outcome.ownership };
  }

  async function begin(): Promise<PlacementAutomationTurn> {
    const ownership = await deps.store.transaction({ label: "placement-automation.pass-start", readOnly: true }, readPlacementAutomationOwnership);
    if (ownership.owner === "fleet-controller") return { decides: true, ownership };
    if (ownership.yieldedAt !== null) return { decides: false, ownership };
    const others = inFlight - 1;
    if (others > 0) {
      deps.log(`[placement-automation] the owner is the client; waiting for ${passCount(others)} to finish before yielding`);
      return { decides: false, ownership };
    }
    return yieldToClient(ownership);
  }

  return {
    async pass(run) {
      inFlight += 1;
      try {
        return await run(await begin());
      } finally {
        inFlight -= 1;
      }
    },
    requireOwner: requireFleetControllerOwner,
    passesInFlight: () => inFlight,
  };
}
