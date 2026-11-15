import pg from "pg";
import type { Logger } from "../logger.js";
import type { Database } from "./database.js";

export const POLL_INTERVAL_MS = 2_000;

export class ChangeNotifier {
  private readonly waiters = new Set<() => void>();
  private client: pg.Client | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly db: Database, private readonly log: Logger) {}

  async start(): Promise<void> {
    const client = new pg.Client({ ...this.db.connection, application_name: "provisioning-service-listen" });
    client.on("notification", () => this.wakeAll());
    client.on("error", (error) => {
      this.log.error("change listener connection failed; waiters fall back to polling", { error: error.message });
      this.client = null;
      client.end().catch(() => undefined);
      this.scheduleReconnect();
    });
    await client.connect();
    await client.query("LISTEN provisioning_service_changes");
    this.client = client;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((error: unknown) => {
        this.log.error("change listener reconnect failed", { error: error instanceof Error ? error.message : String(error) });
        this.scheduleReconnect();
      });
    }, POLL_INTERVAL_MS);
  }

  wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }

  wait(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, Math.min(timeoutMs, POLL_INTERVAL_MS)));
      this.waiters.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.wakeAll();
    const client = this.client;
    this.client = null;
    if (client) await client.end();
  }
}
