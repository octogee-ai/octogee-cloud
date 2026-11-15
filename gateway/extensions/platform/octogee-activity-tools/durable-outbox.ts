import type { AgentActivityAppend } from "./activity-types.js";

export type ActivityStoreEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
};

export interface ActivityKeyedStore<T> {
  registerIfAbsent(key: string, value: T): Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  entries(): Promise<Array<ActivityStoreEntry<T>>>;
}

export class ActivityDeliveryError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export interface ActivityOutbox {
  enqueue(item: AgentActivityAppend): Promise<void>;
  start(): Promise<void>;
  drain(): Promise<void>;
  stop(): void;
}

type ActivityOutboxParams = {
  store: ActivityKeyedStore<AgentActivityAppend>;
  deliver(item: AgentActivityAppend): Promise<void>;
  log?: (message: string, fields: Record<string, unknown>) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function orderedEntries(
  entries: Array<ActivityStoreEntry<AgentActivityAppend>>,
): Array<ActivityStoreEntry<AgentActivityAppend>> {
  const runs = new Map<string, Array<ActivityStoreEntry<AgentActivityAppend>>>();
  for (const entry of entries) {
    const runId = entry.value.envelope.ref.runId;
    const run = runs.get(runId) ?? [];
    run.push(entry);
    runs.set(runId, run);
  }
  const groups = [...runs.values()];
  for (const group of groups) {
    group.sort((left, right) =>
      left.value.envelope.ref.ordinal - right.value.envelope.ref.ordinal
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

export function createActivityOutbox(params: ActivityOutboxParams): ActivityOutbox {
  const log = params.log ?? (() => undefined);
  const retryBaseMs = Math.max(1, params.retryBaseMs ?? 1_000);
  const retryMaxMs = Math.max(retryBaseMs, params.retryMaxMs ?? 60_000);
  const setTimeoutImpl = params.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = params.clearTimeoutImpl ?? clearTimeout;
  let draining: Promise<void> | null = null;
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
      void drain().catch((error) => {
        log("activity outbox drain failed", { message: errorMessage(error) });
        scheduleRetry();
      });
    }, delay);
    retryTimer.unref?.();
  };

  const drain = async (): Promise<void> => {
    if (draining) return draining;
    if (stopped) return;
    draining = (async () => {
      const blockedRuns = new Set<string>();
      for (const entry of orderedEntries(await params.store.entries())) {
        if (stopped) return;
        const runId = entry.value.envelope.ref.runId;
        if (blockedRuns.has(runId)) continue;
        try {
          await params.deliver(entry.value);
          await params.store.delete(entry.key);
          retryAttempt = 0;
        } catch (error) {
          if (error instanceof ActivityDeliveryError && !error.retryable) {
            await params.store.delete(entry.key);
            log("activity delivery rejected", {
              eventKey: entry.key,
              message: error.message,
            });
            continue;
          }
          blockedRuns.add(runId);
          log("activity delivery deferred", {
            eventKey: entry.key,
            message: errorMessage(error),
          });
          scheduleRetry();
        }
      }
      if (blockedRuns.size === 0) clearRetry();
    })().finally(() => {
      draining = null;
    });
    return draining;
  };

  return {
    async enqueue(item) {
      await params.store.registerIfAbsent(item.envelope.eventKey, item);
      await drain();
    },
    async start() {
      stopped = false;
      await drain();
    },
    drain,
    stop() {
      stopped = true;
      clearRetry();
    },
  };
}
