import { describe, expect, it, vi } from "vitest";
import { createMigrationProgress } from "./migration-progress.js";

type MigrationProgressDeps = Parameters<typeof createMigrationProgress>[0];

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("createMigrationProgress persistence", () => {
  it("persists every report with its timestamp and elapsed time, independent of the destination send", async () => {
    const t = clock();
    const persist = vi.fn<NonNullable<MigrationProgressDeps["persist"]>>(async () => undefined);
    const send = vi.fn<MigrationProgressDeps["send"]>(async () => undefined);
    const progress = createMigrationProgress({ now: t.now, log: vi.fn(), send, persist });

    await progress.report("gate-source", "running");
    t.advance(2_500);
    await progress.report("gate-source", "done");

    expect(persist.mock.calls.map(([event]) => event)).toEqual([
      { phase: "gate-source", status: "running", elapsedMs: 0, at: 1_000 },
      { phase: "gate-source", status: "done", elapsedMs: 2_500, at: 3_500 },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual({ phase: "gate-source", status: "done", elapsedMs: 2_500 });
  });

  it("keeps persisting after the destination stops accepting progress", async () => {
    const t = clock();
    const persist = vi.fn<NonNullable<MigrationProgressDeps["persist"]>>(async () => undefined);
    const log = vi.fn();
    const send = vi.fn(async () => { throw new Error("pod gone"); });
    const progress = createMigrationProgress({ now: t.now, log, send, persist });

    await progress.report("transfer-and-verify", "running");
    await progress.report("transfer-and-verify", "done");

    expect(persist).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map(([line]) => line).join("\n")).toContain("destination progress unavailable");
  });

  it("logs and continues when persisting fails, so a journal outage never fails the migration", async () => {
    const t = clock();
    const log = vi.fn();
    const persist = vi.fn(async () => { throw new Error("firestore down"); });
    const send = vi.fn<MigrationProgressDeps["send"]>(async () => undefined);
    const progress = createMigrationProgress({ now: t.now, log, send, persist });

    await expect(progress.run("serving-handoff", async () => "ok")).resolves.toBe("ok");

    expect(persist).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map(([line]) => line).join("\n")).toContain("progress journal write failed: Error: firestore down");
  });

  it("reports unchanged without a persist sink", async () => {
    const t = clock();
    const send = vi.fn<MigrationProgressDeps["send"]>(async () => undefined);
    const progress = createMigrationProgress({ now: t.now, log: vi.fn(), send });
    await progress.report("gate-source", "running");
    expect(send).toHaveBeenCalledWith({ phase: "gate-source", status: "running", elapsedMs: 0 });
  });
});
