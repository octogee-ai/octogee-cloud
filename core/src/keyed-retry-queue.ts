export interface KeyedRetryQueueOptions {
  readonly concurrency: number;
  readonly process: (key: string) => Promise<void>;
  readonly onError: (key: string, error: unknown, attempts: number) => void;
  readonly retryDelayMs: (attempts: number) => number;
  readonly now?: () => number;
}

export interface KeyedRetryQueue {
  enqueue(key: string): void;
  exclusive<T>(key: string, body: () => Promise<T>): Promise<T>;
  open(): void;
  stop(): void;
  settled(keys: readonly string[]): Promise<void>;
  attempted(keys: readonly string[]): Promise<void>;
  pendingCount(): number;
}

interface Entry {
  attempts: number;
  dueAt: number;
}

export function createKeyedRetryQueue(options: KeyedRetryQueueOptions): KeyedRetryQueue {
  const now = options.now ?? Date.now;
  const pending = new Map<string, Entry>();
  const running = new Set<string>();
  const runs = new Map<string, number>();
  const listeners = new Set<() => void>();
  let opened = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function nextDue(): string | null {
    let chosen: string | null = null;
    let chosenDue = Infinity;
    for (const [key, entry] of pending) {
      if (running.has(key) || entry.dueAt >= chosenDue) continue;
      chosen = key;
      chosenDue = entry.dueAt;
    }
    return chosen;
  }

  function schedule(): void {
    if (!opened || stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (running.size >= options.concurrency) return;
    const key = nextDue();
    if (key === null) return;
    timer = setTimeout(drain, Math.max(0, (pending.get(key)?.dueAt ?? now()) - now()));
    timer.unref?.();
  }

  function drain(): void {
    timer = null;
    while (!stopped && running.size < options.concurrency) {
      const key = nextDue();
      if (key === null) break;
      const entry = pending.get(key)!;
      if (entry.dueAt > now()) break;
      pending.delete(key);
      running.add(key);
      void run(key, entry.attempts);
    }
    schedule();
  }

  async function run(key: string, attempts: number): Promise<void> {
    try {
      await options.process(key);
    } catch (error) {
      options.onError(key, error, attempts + 1);
      pending.set(key, { attempts: attempts + 1, dueAt: now() + options.retryDelayMs(attempts) });
    } finally {
      running.delete(key);
      runs.set(key, (runs.get(key) ?? 0) + 1);
      notify();
      schedule();
    }
  }

  function until(condition: () => boolean): Promise<void> {
    const done = () => stopped || condition();
    if (done()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const listener = () => {
        if (!done()) return;
        listeners.delete(listener);
        resolve();
      };
      listeners.add(listener);
    });
  }

  function released(key: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const listener = () => {
        if (running.has(key)) return;
        listeners.delete(listener);
        resolve();
      };
      listeners.add(listener);
    });
  }

  return {
    enqueue(key) {
      if (stopped || pending.has(key)) return;
      pending.set(key, { attempts: 0, dueAt: now() });
      schedule();
    },
    async exclusive(key, body) {
      while (running.has(key)) await released(key);
      running.add(key);
      try {
        return await body();
      } finally {
        running.delete(key);
        notify();
        schedule();
      }
    },
    open() {
      opened = true;
      schedule();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      notify();
    },
    settled(keys) {
      return until(() => keys.every((key) => !pending.has(key) && !running.has(key)));
    },
    attempted(keys) {
      const before = new Map(keys.map((key) => [key, runs.get(key) ?? 0]));
      return until(() => keys.every((key) => (runs.get(key) ?? 0) > (before.get(key) ?? 0)));
    },
    pendingCount() {
      return pending.size + running.size;
    },
  };
}
