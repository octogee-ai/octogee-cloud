import { describe, expect, it, vi } from "vitest";
import { createServiceLogger, withLogContext } from "@octogee/shared/server/service-logger";
import { createMigrationProgress } from "../migration-progress.js";

describe("destination migration progress", () => {
  it("reports source work on the destination with elapsed time and propagates work failures", async () => {
    let now = 10;
    const send = vi.fn();
    const progress = createMigrationProgress({ send, log: vi.fn(), now: () => now });
    await progress.run("quiesce-source", async () => { now = 37; });
    expect(send.mock.calls.map(([event]) => event)).toEqual([
      { phase: "quiesce-source", status: "running", elapsedMs: 0 },
      { phase: "quiesce-source", status: "done", elapsedMs: 27 },
    ]);
    const error = new Error("source did not drain");
    await expect(progress.run("copy-state", async () => { throw error; })).rejects.toBe(error);
    expect(send).toHaveBeenLastCalledWith({ phase: "copy-state", status: "failed", elapsedMs: 0 });
  });
  it("keeps working and logs progress locally after one forwarding failure", async () => {
    const send = vi.fn().mockRejectedValue(new Error("destination offline"));
    const log = vi.fn();
    const action = vi.fn().mockResolvedValue("copied");
    const progress = createMigrationProgress({ send, log, now: () => 1 });
    await expect(progress.run("copy-state", action)).resolves.toBe("copied");
    expect(action).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("destination offline"));
    expect(log).toHaveBeenLastCalledWith("[migration] Phase progress");
  });

  it("logs forwarded progress and uses the occurrence time for each attempt", async () => {
    const send = vi.fn();
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const scope = { operationId: "op-one", migrationId: "mig-builder-activate-b-profile-alice-20261112-g12", sourceGateway: "gw-from", targetGateway: "gw-to" };
    try {
      const logger = createServiceLogger("migration-test");
      const progress = createMigrationProgress({ send, log: logger.info, now: () => 1_000 });
      await withLogContext({ ...scope, attempt: 1 }, async () => {
        await progress.report("checkpoint-native-computer", "running", 10);
        await progress.report("checkpoint-native-computer", "failed", 40);
      });
      await withLogContext({ ...scope, attempt: 2 }, async () => {
        await progress.report("checkpoint-native-computer", "running", 70);
        await progress.report("checkpoint-native-computer", "done", 90);
      });

      expect(send.mock.calls.map(([event]) => event.elapsedMs)).toEqual([0, 30, 0, 20]);
      const records = output.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(records).toHaveLength(4);
      expect(records[1]).toMatchObject({ ...scope, attempt: 1, status: "failed", durationMs: 30 });
      expect(records[3]).toMatchObject({ ...scope, attempt: 2, status: "done", durationMs: 20 });
    } finally {
      output.mockRestore();
    }
  });
});
