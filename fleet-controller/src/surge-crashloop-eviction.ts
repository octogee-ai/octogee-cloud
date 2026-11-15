import type { PlatformStateStore } from "@octogee/core/platform-state";
import type { SurgePod } from "./surge-user-handoff.js";

export const CRASH_LOOP_EVICTION_BUDGET = 3;

export interface CrashLoopEvictionClaim {
  allowed: boolean;
  count: number;
  budget: number;
}

export function crashLoopEvictionDecision(record: unknown, imageTag: string): { allowed: boolean; count: number } {
  const current = record && typeof record === "object" && !Array.isArray(record)
    ? (record as { imageTag?: unknown; count?: unknown })
    : undefined;
  const spent = current?.imageTag === imageTag && typeof current.count === "number" && Number.isFinite(current.count)
    ? current.count
    : 0;
  return spent < CRASH_LOOP_EVICTION_BUDGET ? { allowed: true, count: spent + 1 } : { allowed: false, count: spent };
}

export async function claimCrashLoopEviction(
  store: PlatformStateStore,
  input: { gatewayId: string; imageTag: string; pod: SurgePod; now: number },
): Promise<CrashLoopEvictionClaim> {
  return store.transaction({ label: "surge-crashloop-eviction.claim" }, async (transaction) => {
    const runtime = await transaction.fleetRegistry.get(input.gatewayId);
    const decision = crashLoopEvictionDecision(runtime?.surgeCrashLoopEvictions, input.imageTag);
    if (decision.allowed) {
      await transaction.fleetRegistry.patch(input.gatewayId, {
        surgeCrashLoopEvictions: { imageTag: input.imageTag, count: decision.count, lastAt: input.now, lastPod: input.pod.name },
      });
    }
    return { ...decision, budget: CRASH_LOOP_EVICTION_BUDGET };
  });
}
