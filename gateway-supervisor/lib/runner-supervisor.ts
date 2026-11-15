import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("runner-supervisor");
import {
  DEFAULT_HEARTBEAT_DIR,
  writeHeartbeat,
  type RunnerHeartbeat,
} from "./runner-heartbeat.js";

export interface SupervisedChild {
  // Resolves with the process exit code (or a synthetic non-zero on spawn
  // failure) when the child exits.
  waitForExit(): Promise<number>;
}

export interface IntervalScheduler {
  set(cb: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SuperviseOptions {
  name: string;
  // Spawns one run of the runner child. Injected so the loop is testable.
  spawn: () => SupervisedChild;
  heartbeatDir?: string;
  // Delay before relaunching after a child exit.
  restartDelayMs?: number;
  // Periodic re-write while the child runs, so the heartbeat `ts` stays fresh
  // (liveness). Must be well under runner-heartbeat's DEFAULT_STALE_MS.
  heartbeatIntervalMs?: number;
  // Injection seams (default to real implementations).
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  scheduler?: IntervalScheduler;
  writeHb?: (dir: string, hb: RunnerHeartbeat) => void;
  log?: (line: string) => void;
  // Loop guard. Returns true to stop before the next spawn — false forever in
  // production (the supervisor lives as long as the pod), bounded in tests.
  shouldStop?: () => boolean;
}

const realScheduler: IntervalScheduler = {
  set: (cb, ms) => setInterval(cb, ms),
  clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Supervise one in-pod runner: (re)spawn it forever, count restarts, and keep
// a heartbeat file fresh so the metrics exporter can report up / restart_total
// / last_start. Replaces the bare `while true; tsx X || true; sleep N` loops
// in entrypoint.sh, adding the observability the loops never had.
export async function superviseRunner(opts: SuperviseOptions): Promise<void> {
  const {
    name,
    spawn,
    heartbeatDir = DEFAULT_HEARTBEAT_DIR,
    restartDelayMs = 5_000,
    heartbeatIntervalMs = 15_000,
    now = Date.now,
    sleep = defaultSleep,
    scheduler = realScheduler,
    writeHb = writeHeartbeat,
    log = (line) => runtimeLogger.warn(line),
    shouldStop = () => false,
  } = opts;

  let restarts = -1; // ++ at the top of each iteration → 0 on first launch
  while (!shouldStop()) {
    restarts += 1;
    const startedAt = now();
    const base = { name, startedAt, restarts };
    writeHb(heartbeatDir, { ...base, running: true, lastExitCode: null, ts: now() });

    const child = spawn();
    // Keep the heartbeat fresh while the child runs so a long-lived healthy
    // runner doesn't read as stale (and a dead supervisor DOES).
    const ticker = scheduler.set(() => {
      writeHb(heartbeatDir, { ...base, running: true, lastExitCode: null, ts: now() });
    }, heartbeatIntervalMs);

    let code: number;
    try {
      code = await child.waitForExit();
    } finally {
      scheduler.clear(ticker);
    }

    writeHb(heartbeatDir, { ...base, running: false, lastExitCode: code, ts: now() });
    log(
      JSON.stringify({
        severity: "WARNING",
        runner: name,
        event: "restart",
        exitCode: code,
        restarts: restarts + 1,
        backoffMs: restartDelayMs,
      }),
    );
    if (shouldStop()) break;
    await sleep(restartDelayMs);
  }
}
