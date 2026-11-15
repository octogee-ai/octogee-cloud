import type { ChangeNotifier } from "../store/change-notifier.js";
import type { ProvisioningStore } from "../store/provisioning-store.js";
import { runAttempt, type AttemptDependencies } from "./attempt.js";

export const ATTEMPT_CONCURRENCY = 4;
const PRUNE_INTERVAL_MS = 10 * 60 * 1_000;

export class Worker {
  private readonly running = new Set<Promise<void>>();
  private stopped = false;
  private loop: Promise<void> | null = null;
  private readonly stopSignal = new AbortController();
  private lastPrune = 0;

  constructor(
    private readonly deps: AttemptDependencies & { notifier: ChangeNotifier; store: ProvisioningStore },
    private readonly concurrency = ATTEMPT_CONCURRENCY,
  ) {}

  start(): void {
    this.loop = this.run();
  }

  async drain(): Promise<void> {
    while (this.running.size > 0) await Promise.race(this.running);
  }

  async tick(): Promise<number> {
    const claims = await this.deps.queue.claim(this.concurrency - this.running.size);
    const takeovers = claims.filter((claim) => claim.takeover).length;
    if (takeovers > 0) {
      this.deps.metrics.leaseExpiredSeen(takeovers);
      this.deps.log.error("took over expired provisioning leases", { count: takeovers, uids: claims.filter((claim) => claim.takeover).map((claim) => claim.uid) });
    }
    for (const claim of claims) {
      const attempt: Promise<void> = runAttempt(this.deps, claim)
        .then(() => undefined)
        .catch((error: unknown) => {
          this.deps.log.error("provisioning attempt crashed", { uid: claim.uid, error: error instanceof Error ? error.message : String(error) });
        })
        .finally(() => {
          this.running.delete(attempt);
          this.deps.metrics.setLeasesHeld(this.running.size);
          this.deps.notifier.wakeAll();
        });
      this.running.add(attempt);
    }
    this.deps.metrics.setLeasesHeld(this.running.size);
    if (Date.now() - this.lastPrune > Math.min(PRUNE_INTERVAL_MS, this.deps.store.changeRetentionMs / 2)) {
      this.lastPrune = Date.now();
      const pruned = await this.deps.store.pruneChangeLog();
      if (pruned > 0) this.deps.log.info("pruned the change log", { pruned });
    }
    return claims.length;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        if (this.running.size < this.concurrency) await this.tick();
      } catch (error) {
        this.deps.log.error("claiming provisioning work failed", { error: error instanceof Error ? error.message : String(error) });
      }
      await this.deps.notifier.wait(Number.POSITIVE_INFINITY, this.stopSignal.signal);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopSignal.abort();
    await this.loop;
    await this.drain();
  }
}
