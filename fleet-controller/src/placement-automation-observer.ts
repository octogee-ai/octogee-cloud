import {
  readPlacementAutomationState,
  type PlacementAutomationGate,
  type PlacementAutomationState,
} from "@octogee/core/placement-automation-handoff";
import type { PlatformStateStore } from "@octogee/core/platform-state";

export const PLACEMENT_AUTOMATION_OBSERVE_MS = 15_000;
export const PLACEMENT_HANDOFF_STUCK_AFTER_OBSERVATIONS = 8;

export interface PlacementAutomationSample extends PlacementAutomationState {
  readonly pendingObservations: number;
}

export interface PlacementAutomationObserverDeps {
  store: PlatformStateStore;
  gate: PlacementAutomationGate;
  runsPlatformPass: boolean;
  stuckAfterObservations: number;
  log(message: string): void;
  error(message: string): void;
  record(sample: PlacementAutomationSample): void;
}

function runningPasses(count: number): string {
  return count === 1 ? "1 in-process pass is running here" : `${count} in-process passes are running here`;
}

export function createPlacementAutomationObserver(deps: PlacementAutomationObserverDeps): { observe(): Promise<void> } {
  let last: PlacementAutomationState | null = null;
  let pending = 0;
  return {
    async observe() {
      if (deps.runsPlatformPass) await deps.gate.pass(async () => undefined);
      const state = await readPlacementAutomationState(deps.store);
      if (last === null || last.owner !== state.owner || last.yieldedAt !== state.yieldedAt) {
        deps.log(`[placement-automation] owner=${state.owner} yieldedAt=${state.yieldedAt ?? "none"} phase=${state.phase}`);
      }
      last = state;
      pending = state.phase === "handoff-pending" ? pending + 1 : 0;
      deps.record({ ...state, pendingObservations: pending });
      const stuckAfter = deps.stuckAfterObservations;
      if (pending >= stuckAfter && (pending - stuckAfter) % stuckAfter === 0) {
        deps.error(
          `[placement-automation] handoff stuck: the owner is the client but the fleet controller has not yielded after ${pending} observations; ` +
            runningPasses(deps.gate.passesInFlight()),
        );
      }
    },
  };
}

export function startPlacementAutomationObserver(
  deps: PlacementAutomationObserverDeps,
  intervalMs = PLACEMENT_AUTOMATION_OBSERVE_MS,
): () => void {
  const observer = createPlacementAutomationObserver(deps);
  let stopped = false;
  let inFlight = false;
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await observer.observe();
    } catch (error) {
      deps.error(`[placement-automation] observation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
