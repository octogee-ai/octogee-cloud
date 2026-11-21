import { createHash } from "node:crypto";
import type { FleetRegistryRecord, PlatformStateStore, WatchEvent, WatchSubscription } from "@octogee/core/platform-state";
import { homeCheckpointOutstanding, type GatewayVmRuntimeResponse } from "@octogee/shared/types/glm";

export const CHECKPOINT_CURSOR_HEADER = "x-octogee-checkpoint-cursor";
export const CHECKPOINT_WAIT_MS = 24_000;

export function vmRuntimeCheckpointSignal(home: FleetRegistryRecord["vmHome"]): GatewayVmRuntimeResponse["homeCheckpoint"] {
  return {
    requestedAt: typeof home?.checkpointRequestedAt === "number" ? home.checkpointRequestedAt : null,
    completedAt: !homeCheckpointOutstanding(home) && typeof home?.lastCheckpoint?.completedAt === "number" ? home.lastCheckpoint.completedAt : null,
  };
}

export function vmCheckpointCursor(runtime: FleetRegistryRecord | null | undefined, instanceId: string | undefined): string | null {
  if (!instanceId || runtime?.runtime !== "gce-vm" || runtime.vm?.instanceId !== instanceId) return null;
  const { requestedAt, completedAt } = vmRuntimeCheckpointSignal(runtime.vmHome);
  const checkpoint = [runtime.vmHome?.returnOperationId, requestedAt, requestedAt === null ? null : completedAt];
  return createHash("sha256").update(JSON.stringify([runtime.gatewayId, instanceId, checkpoint])).digest("hex");
}

type CheckpointWait = { gatewayId: string; instanceId: string; cursor: string; signal: AbortSignal };
type WaitResult = "changed" | "unchanged" | "unbound";
type Watcher = {
  onRecord(runtime: FleetRegistryRecord | null | undefined): void;
  onError(error: unknown): void;
};

function dispatchRecords(watchers: Map<string, Set<Watcher>>, event: WatchEvent<"fleetRegistry">): void {
  if (event.kind === "resync") return;
  if (event.kind === "changes") {
    for (const { key, record } of event.changes) {
      for (const watcher of watchers.get(key) ?? []) watcher.onRecord(record);
    }
    return;
  }
  const snapshot = new Map(event.records.map(record => [record.gatewayId, record]));
  for (const [gatewayId, entries] of watchers) {
    for (const watcher of entries) watcher.onRecord(snapshot.get(gatewayId));
  }
}

export function createVmCheckpointWaiter(
  store: Pick<PlatformStateStore, "watch"> & { fleetRegistry: Pick<PlatformStateStore["fleetRegistry"], "get"> },
): (input: CheckpointWait) => Promise<WaitResult> {
  const watchers = new Map<string, Set<Watcher>>();
  let active: WatchSubscription | undefined;

  const onError = (error: unknown) => {
    for (const entries of watchers.values()) {
      for (const watcher of entries) watcher.onError(error);
    }
  };

  function ensureWatch(): void {
    if (active) return;
    const subscription = store.watch({ aggregate: "fleetRegistry", filter: {} }, {
      onEvent: event => dispatchRecords(watchers, event),
      onError,
    });
    active = subscription;
    const closed = (error: unknown) => {
      if (active !== subscription) return;
      active = undefined;
      onError(error);
    };
    void subscription.closed.then(() => closed(new Error("VM checkpoint watch closed before delivery")), closed);
  }

  return async input => {
    let wake!: () => void;
    let fail!: (error: unknown) => void;
    const change = new Promise<void>((resolve, reject) => { wake = resolve; fail = reject; });
    const subscriber: Watcher = {
      onRecord: runtime => {
        if (vmCheckpointCursor(runtime, input.instanceId) !== input.cursor) wake();
      },
      onError: fail,
    };
    const entries = watchers.get(input.gatewayId) ?? new Set<Watcher>();
    entries.add(subscriber);
    watchers.set(input.gatewayId, entries);
    let timeout: NodeJS.Timeout | undefined;
    input.signal.addEventListener("abort", wake, { once: true });
    try {
      if (input.signal.aborted) return "unchanged";
      ensureWatch();
      timeout = setTimeout(wake, CHECKPOINT_WAIT_MS);
      const read = () => store.fleetRegistry.get(input.gatewayId);
      void read().then(subscriber.onRecord, fail);
      await change;
      if (input.signal.aborted) return "unchanged";
      const current = vmCheckpointCursor(await read(), input.instanceId);
      if (current === null) return "unbound";
      return current === input.cursor ? "unchanged" : "changed";
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", wake);
      entries.delete(subscriber);
      if (entries.size === 0) watchers.delete(input.gatewayId);
      if (watchers.size === 0 && active) {
        const subscription = active;
        active = undefined;
        await subscription.close();
      }
    }
  };
}
