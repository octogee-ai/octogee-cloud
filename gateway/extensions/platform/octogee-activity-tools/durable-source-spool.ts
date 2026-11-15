import { createHash } from "node:crypto";
import type { ActivityKeyedStore } from "./durable-outbox.js";

export type ActivitySourceSpoolRecord<TPayload> = {
  schemaVersion: 1;
  laneId: string;
  seq: number;
  payload: TPayload;
};

export type ActivitySourceSpoolOutcome =
  | { kind: "completed"; cleanupKey?: string }
  | { kind: "failed"; reason: string; message: string };

export type ActivitySourceSpoolConsumer<TPayload> = {
  process(record: ActivitySourceSpoolRecord<TPayload>, spoolId: string): Promise<ActivitySourceSpoolOutcome>;
  completed(cleanupKey: string): Promise<void>;
  reconcile(pendingLaneIds: ReadonlySet<string>): Promise<void>;
};

export interface ActivitySourceSpool<TPayload> {
  enqueue(laneId: string, seq: number, payload: TPayload): Promise<string>;
  start(consumer: ActivitySourceSpoolConsumer<TPayload>): Promise<void>;
  drain(): Promise<void>;
  inspect(id: string): Promise<{ status: "pending" } | null>;
  stop(): void;
}

type ActivitySourceSpoolParams<TPayload> = {
  store: ActivityKeyedStore<ActivitySourceSpoolRecord<TPayload>>;
  retryBaseMs?: number;
  retryMaxMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function orderedEntries<TPayload>(
  entries: Array<{ key: string; value: ActivitySourceSpoolRecord<TPayload>; createdAt: number }>,
): Array<{ key: string; value: ActivitySourceSpoolRecord<TPayload>; createdAt: number }> {
  const lanes = new Map<string, typeof entries>();
  for (const entry of entries) {
    const lane = lanes.get(entry.value.laneId) ?? [];
    lane.push(entry);
    lanes.set(entry.value.laneId, lane);
  }
  const groups = [...lanes.values()];
  for (const group of groups) {
    group.sort((left, right) =>
      left.value.seq - right.value.seq
      || left.createdAt - right.createdAt
      || left.key.localeCompare(right.key));
  }
  groups.sort((left, right) => {
    const leftFirst = Math.min(...left.map((entry) => entry.createdAt));
    const rightFirst = Math.min(...right.map((entry) => entry.createdAt));
    return leftFirst - rightFirst || (left[0]?.key ?? "").localeCompare(right[0]?.key ?? "");
  });
  return groups.flat();
}

export function activitySourceSpoolId(laneId: string, seq: number): string {
  return createHash("sha256")
    .update(`octogee-activity-source-v1\n${laneId}\n${seq}`)
    .digest("hex");
}

export function createActivitySourceSpool<TPayload>(
  params: ActivitySourceSpoolParams<TPayload>,
): ActivitySourceSpool<TPayload> {
  const retryBaseMs = Math.max(1, params.retryBaseMs ?? 1_000);
  const retryMaxMs = Math.max(retryBaseMs, params.retryMaxMs ?? 60_000);
  const setTimeoutImpl = params.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = params.clearTimeoutImpl ?? clearTimeout;
  const log = params.log ?? (() => undefined);
  let consumer: ActivitySourceSpoolConsumer<TPayload> | undefined;
  let draining: Promise<void> | null = null;
  let drainRequested = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;
  let stopped = false;

  const clearRetry = () => {
    if (retryTimer) clearTimeoutImpl(retryTimer);
    retryTimer = undefined;
  };

  const scheduleRetry = () => {
    if (stopped || retryTimer) return;
    const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** retryAttempt);
    retryAttempt += 1;
    retryTimer = setTimeoutImpl(() => {
      retryTimer = undefined;
      void drain();
    }, delay);
    retryTimer.unref?.();
  };

  const processEntry = async (
    activeConsumer: ActivitySourceSpoolConsumer<TPayload>,
    entry: { key: string; value: ActivitySourceSpoolRecord<TPayload> },
    blockedLanes: Set<string>,
  ): Promise<void> => {
    const record = entry.value;
    if (stopped || blockedLanes.has(record.laneId)) return;
    try {
      const outcome = await activeConsumer.process(record, entry.key);
      if (outcome.kind === "failed") {
        log("activity source event rejected", {
          spoolId: entry.key,
          reason: outcome.reason,
          message: outcome.message,
        });
      }
      await params.store.delete(entry.key);
      if (outcome.kind === "completed" && outcome.cleanupKey) {
        await activeConsumer.completed(outcome.cleanupKey);
      }
      retryAttempt = 0;
    } catch (error) {
      blockedLanes.add(record.laneId);
      log("activity source event deferred", {
        spoolId: entry.key,
        message: errorMessage(error),
      });
      scheduleRetry();
    }
  };

  const reconcile = async (
    activeConsumer: ActivitySourceSpoolConsumer<TPayload>,
    blockedLanes: ReadonlySet<string>,
  ): Promise<void> => {
    if (blockedLanes.size === 0) clearRetry();
    else scheduleRetry();
    try {
      await activeConsumer.reconcile(await pendingLaneIds());
    } catch (error) {
      log("activity source reconciliation deferred", {
        message: errorMessage(error),
      });
      scheduleRetry();
    }
  };

  const runDrain = async (activeConsumer: ActivitySourceSpoolConsumer<TPayload>): Promise<void> => {
    try {
      const blockedLanes = new Set<string>();
      while (!stopped) {
        drainRequested = false;
        const entries = orderedEntries(await params.store.entries());
        for (const entry of entries) {
          await processEntry(activeConsumer, entry, blockedLanes);
        }
        if (stopped) return;
        if (drainRequested) continue;
        await reconcile(activeConsumer, blockedLanes);
        if (!drainRequested) return;
      }
    } finally {
      draining = null;
    }
  };

  const drain = (): Promise<void> => {
    if (stopped || !consumer) return Promise.resolve();
    drainRequested = true;
    if (draining) return draining;
    draining = runDrain(consumer);
    return draining;
  };

  const pendingLaneIds = async (): Promise<ReadonlySet<string>> => new Set(
    (await params.store.entries()).map((entry) => entry.value.laneId),
  );

  return {
    async enqueue(laneId, seq, payload) {
      if (stopped) throw new Error("activity source spool is stopped");
      const id = activitySourceSpoolId(laneId, seq);
      await params.store.registerIfAbsent(id, { schemaVersion: 1, laneId, seq, payload });
      await drain();
      return id;
    },
    async start(nextConsumer) {
      if (consumer && consumer !== nextConsumer) {
        throw new Error("activity source spool consumer is already registered");
      }
      consumer = nextConsumer;
      stopped = false;
      await drain();
    },
    drain,
    async inspect(id) {
      return await params.store.lookup(id) ? { status: "pending" } : null;
    },
    stop() {
      stopped = true;
      clearRetry();
    },
  };
}
