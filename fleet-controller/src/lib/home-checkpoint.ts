import type { PlatformStateRepositories, PlatformStateStore } from "@octogee/core/platform-state";
import { homeCheckpointOutstanding, type GatewayVmHomeState } from "@octogee/shared/types/glm";

export const HOME_CHECKPOINT_TIMEOUT_MS = 15 * 60_000;
export const HOME_CHECKPOINT_POLL_MS = 10_000;

export type HomeCheckpointWaitResult =
  | { outcome: "completed"; completedAt: number }
  | { outcome: "timeout" }
  | { outcome: "cancelled" };

export interface HomeCheckpointWaitDeps {
  readHomeCheckpointCompletedAt: (gatewayId: string) => Promise<number | null>;
  wait: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs?: number;
  pollMs?: number;
}

export async function awaitHomeCheckpoint(
  deps: HomeCheckpointWaitDeps,
  input: { gatewayId: string; requestedAt: number; cancellationRequested?: () => Promise<boolean> },
): Promise<HomeCheckpointWaitResult> {
  const timeoutMs = deps.timeoutMs ?? HOME_CHECKPOINT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? HOME_CHECKPOINT_POLL_MS;
  while (true) {
    const completedAt = await deps.readHomeCheckpointCompletedAt(input.gatewayId);
    if (completedAt !== null && completedAt >= input.requestedAt) return { outcome: "completed", completedAt };
    if (await input.cancellationRequested?.()) return { outcome: "cancelled" };
    if (deps.now() - input.requestedAt >= timeoutMs) return { outcome: "timeout" };
    await deps.wait(pollMs);
  }
}

export function homeCheckpointCompletedAt(home: Partial<GatewayVmHomeState> | undefined): number | null {
  const completedAt = home?.lastCheckpoint?.completedAt;
  return typeof completedAt === "number" ? completedAt : null;
}

export async function requestHomeCheckpoint(store: PlatformStateStore, gatewayId: string, requestedAt: number): Promise<void> {
  await store.transaction({ label: "home-checkpoint.request" }, async tx => {
    const runtime = await tx.fleetRegistry.get(gatewayId);
    if (runtime === null) throw new Error(`gateway ${gatewayId}: home checkpoint requires a runtime record`);
    await tx.fleetRegistry.patch(gatewayId, { vmHome: { ...runtime.vmHome, checkpointRequestedAt: requestedAt } }, { revision: runtime.revision });
  });
}

export async function clearHomeCheckpointRequest(store: PlatformStateStore, gatewayId: string): Promise<void> {
  await store.transaction({ label: "home-checkpoint.clear-request" }, async tx => {
    const runtime = await tx.fleetRegistry.get(gatewayId);
    if (runtime === null) throw new Error(`gateway ${gatewayId}: home checkpoint requires a runtime record`);
    if (runtime.vmHome?.checkpointRequestedAt === undefined) return;
    const { checkpointRequestedAt: _requestedAt, ...vmHome } = runtime.vmHome;
    await tx.fleetRegistry.patch(gatewayId, { vmHome }, { revision: runtime.revision });
  });
}

export async function readHomeCheckpointCompletedAt(state: Pick<PlatformStateRepositories, "fleetRegistry">, gatewayId: string): Promise<number | null> {
  const home = (await state.fleetRegistry.get(gatewayId))?.vmHome;
  return homeCheckpointOutstanding(home) ? null : homeCheckpointCompletedAt(home);
}
