import type { MigrationProgressRequestBody } from "@octogee/shared/types/fleet-controller";
import { withLogContext } from "@octogee/shared/server/service-logger";

type ProgressEvent = Pick<MigrationProgressRequestBody, "phase" | "status" | "elapsedMs">;
export type ProgressJournalEvent = ProgressEvent & { at: number };

export function createMigrationProgress(deps: {
  send: (event: ProgressEvent) => Promise<unknown>;
  persist?: (event: ProgressJournalEvent) => Promise<unknown>;
  log: (message: string) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let forwarding = true;
  const started = new Map<string, number>();
  const journal = async (event: ProgressEvent, at: number): Promise<void> => {
    if (!deps.persist) return;
    try {
      await deps.persist({ ...event, at });
    } catch (error) {
      deps.log(`🔴 [migration] progress journal write failed: ${String(error)}; ${JSON.stringify(event)}`);
    }
  };
  const report = async (phase: string, status: ProgressEvent["status"], at = now()): Promise<void> => {
    if (status === "running") started.set(phase, at);
    const start = started.get(phase);
    if (status !== "running") started.delete(phase);
    const event = { phase, status, ...(start === undefined ? {} : { elapsedMs: Math.max(0, at - start) }) };
    await withLogContext({
      phase, status, ...(status === "running" || event.elapsedMs === undefined ? {} : { durationMs: event.elapsedMs }),
    }, async () => {
      deps.log(status === "failed" ? "🔴 [migration] Phase failed" : "[migration] Phase progress");
      await journal(event, at);
      if (!forwarding) return;
      try {
        await deps.send(event);
      } catch (error) {
        forwarding = false;
        deps.log(`🔴 [migration] destination progress unavailable: ${String(error)}; continuing progress in the fleet controller logs`);
      }
    });
  };
  return {
    report,
    async run<T>(phase: string, action: () => Promise<T>): Promise<T> {
      await report(phase, "running");
      let result: T;
      try {
        result = await action();
      } catch (error) {
        await report(phase, "failed");
        throw error;
      }
      await report(phase, "done");
      return result;
    },
  };
}
