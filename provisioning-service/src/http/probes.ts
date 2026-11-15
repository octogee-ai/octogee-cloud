import type { Logger } from "../logger.js";
import type { WorkSnapshot } from "../metrics.js";
import type { Database } from "../store/database.js";
import type { WorkQueue } from "../worker/queue.js";

export const PROBE_REFRESH_MS = 5_000;

export class ProbeState {
  ready = false;
  snapshot: WorkSnapshot | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly db: Database, private readonly queue: WorkQueue, private readonly log: Logger) {}

  async refresh(): Promise<void> {
    try {
      await this.db.pool.query("SELECT 1");
      this.snapshot = await this.queue.snapshot();
      this.ready = true;
    } catch (error) {
      this.ready = false;
      this.log.error("readiness check failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  start(intervalMs = PROBE_REFRESH_MS): void {
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
