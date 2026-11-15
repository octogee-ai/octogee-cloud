import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_STALE_MS,
  readHeartbeats,
  renderPrometheus,
  writeHeartbeat,
  type RunnerHeartbeat,
} from "../lib/runner-heartbeat";

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "rhb-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const hb = (over: Partial<RunnerHeartbeat> = {}): RunnerHeartbeat => ({
  name: "provisioner",
  running: true,
  startedAt: 1_700_000_000_000,
  restarts: 0,
  lastExitCode: null,
  ts: 1_700_000_000_000,
  ...over,
});

describe("runner-heartbeat write/read", () => {
  it("round-trips a heartbeat through the dir", () => {
    const dir = tmpDir();
    writeHeartbeat(dir, hb({ name: "site-build", restarts: 2 }));
    const all = readHeartbeats(dir);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "site-build", restarts: 2, running: true });
  });

  it("returns [] when the dir does not exist yet", () => {
    expect(readHeartbeats(join(tmpdir(), "rhb-does-not-exist-xyz"))).toEqual([]);
  });

  it("publishes a heartbeat without touching a pre-existing temporary sibling", () => {
    const dir = tmpDir();
    const sibling = join(dir, "provisioner.json.tmp");
    writeFileSync(sibling, "existing data");
    writeHeartbeat(dir, hb());
    expect(readFileSync(sibling, "utf8")).toBe("existing data");
    expect(readHeartbeats(dir)).toEqual([hb()]);
  });

  it("skips non-json and unparseable files without throwing", () => {
    const dir = tmpDir();
    writeHeartbeat(dir, hb({ name: "good" }));
    writeFileSync(join(dir, "notes.txt"), "ignore me");
    writeFileSync(join(dir, "broken.json"), "{ half-written");
    const all = readHeartbeats(dir);
    expect(all.map((h) => h.name)).toEqual(["good"]);
  });
});

describe("renderPrometheus", () => {
  it("emits up=1 for a running, fresh heartbeat", () => {
    const now = 1_700_000_010_000;
    const out = renderPrometheus([hb({ ts: now - 1000 })], now);
    expect(out).toContain('octogee_runner_up{runner="provisioner"} 1');
  });

  it("emits up=0 when running but the heartbeat is stale (dead supervisor)", () => {
    const now = 1_700_000_000_000;
    const out = renderPrometheus([hb({ ts: now - (DEFAULT_STALE_MS + 1) })], now);
    expect(out).toContain('octogee_runner_up{runner="provisioner"} 0');
  });

  it("emits up=0 when the runner is between restarts (running=false)", () => {
    const now = 1_700_000_000_000;
    const out = renderPrometheus([hb({ running: false, ts: now })], now);
    expect(out).toContain('octogee_runner_up{runner="provisioner"} 0');
  });

  it("exposes restart_total and last_start, with TYPE lines", () => {
    const now = 1_700_000_000_000;
    const out = renderPrometheus([hb({ restarts: 5, startedAt: 1_700_000_000_000 })], now);
    expect(out).toContain("# TYPE octogee_runner_restart_total counter");
    expect(out).toContain('octogee_runner_restart_total{runner="provisioner"} 5');
    expect(out).toContain('octogee_runner_last_start_timestamp_seconds{runner="provisioner"} 1700000000.000');
  });

  it("escapes label values", () => {
    const now = 1_700_000_000_000;
    const out = renderPrometheus([hb({ name: 'we"ird' })], now);
    expect(out).toContain('runner="we\\"ird"');
  });
});
