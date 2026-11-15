export interface StartAfterSurgeReadinessOptions {
  released: () => Promise<boolean>;
  start: () => () => void;
  schedule?: (callback: () => void) => () => void;
  log: (message: string) => void;
}

const READINESS_CHECK_INTERVAL_MS = 1_000;

function defaultSchedule(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearTimeout(timer);
}

export function startAfterSurgeReadiness(
  opts: StartAfterSurgeReadinessOptions,
): () => void {
  const schedule = opts.schedule ?? defaultSchedule;
  let stopped = false;
  let checking = false;
  let cancelCheck: (() => void) | null = null;
  let stopStarted: (() => void) | null = null;

  const check = async (): Promise<void> => {
    if (stopped || checking || stopStarted) return;
    checking = true;
    try {
      if (await opts.released()) {
        if (!stopped) stopStarted = opts.start();
        return;
      }
    } catch (error) {
      opts.log(
        `[surge-handoff] readiness marker check failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      checking = false;
    }
    if (!stopped && !stopStarted) {
      cancelCheck = schedule(() => void check(), READINESS_CHECK_INTERVAL_MS);
    }
  };

  void check();
  return () => {
    stopped = true;
    cancelCheck?.();
    stopStarted?.();
  };
}
