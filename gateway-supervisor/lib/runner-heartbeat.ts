/* eslint-disable sonarjs/publicly-writable-directories -- /tmp is an in-pod heartbeat cache with fixed filenames, not user-controlled temp input. */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceFileAtomically } from "./atomic-file.js";

// One heartbeat per supervised in-pod runner. The supervisor writes it on
// every state change AND on a periodic tick while the child runs, so `ts`
// doubles as a liveness signal: a stale file means the supervisor itself is
// gone (the runner is not actually being kept alive), even if `running` was
// last true.
export interface RunnerHeartbeat {
  name: string;
  running: boolean;
  // ms epoch of the current child's most recent start.
  startedAt: number;
  // How many times the child has been (re)started after the first launch.
  restarts: number;
  // Exit code of the last child exit, or null while the first run is live.
  lastExitCode: number | null;
  // ms epoch of this write — freshness/liveness anchor for the exporter.
  ts: number;
}

export const DEFAULT_HEARTBEAT_DIR =
  process.env.OCTOGEE_RUNNER_HEARTBEAT_DIR ?? "/tmp/octogee-runners";

// up=0 once a heartbeat is older than this — catches a dead supervisor whose
// last write said running:true. Must exceed the supervisor's write interval.
export const DEFAULT_STALE_MS = 45_000;

export function writeHeartbeat(dir: string, hb: RunnerHeartbeat): void {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${hb.name}.json`);
  replaceFileAtomically(path, JSON.stringify(hb), 0o644);
}

export function readHeartbeats(dir: string): RunnerHeartbeat[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // dir not created yet — no runners have started
  }
  const out: RunnerHeartbeat[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(join(dir, entry), "utf8")) as RunnerHeartbeat;
      if (typeof hb.name === "string" && typeof hb.running === "boolean") out.push(hb);
    } catch {
      // Half-written or junk file — skip; the next tick rewrites it.
    }
  }
  return out;
}

function labelEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// Render the Prometheus text-exposition format. up=1 only when the runner is
// both flagged running and fresh (supervisor alive). Counters/gauges carry a
// `runner` label.
export function renderPrometheus(
  heartbeats: RunnerHeartbeat[],
  now: number,
  staleMs: number = DEFAULT_STALE_MS,
): string {
  const lines: string[] = [];
  lines.push("# HELP octogee_runner_up Whether the in-pod runner is currently alive (supervisor running + fresh heartbeat).");
  lines.push("# TYPE octogee_runner_up gauge");
  for (const hb of heartbeats) {
    const fresh = now - hb.ts < staleMs;
    const up = hb.running && fresh ? 1 : 0;
    lines.push(`octogee_runner_up{runner="${labelEscape(hb.name)}"} ${up}`);
  }
  lines.push("# HELP octogee_runner_restart_total Times the runner child has been restarted by its supervisor.");
  lines.push("# TYPE octogee_runner_restart_total counter");
  for (const hb of heartbeats) {
    lines.push(`octogee_runner_restart_total{runner="${labelEscape(hb.name)}"} ${hb.restarts}`);
  }
  lines.push("# HELP octogee_runner_last_start_timestamp_seconds Unix time of the runner child's most recent start.");
  lines.push("# TYPE octogee_runner_last_start_timestamp_seconds gauge");
  for (const hb of heartbeats) {
    lines.push(
      `octogee_runner_last_start_timestamp_seconds{runner="${labelEscape(hb.name)}"} ${(hb.startedAt / 1000).toFixed(3)}`,
    );
  }
  return lines.join("\n") + "\n";
}
