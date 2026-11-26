const WAIT_TIMEOUT_MS = 60_000;
export const RUNTIME_UPDATE_AGING_MS = 20_000;

export type OpenClawRuntimeUpdatePriority = "migration";

export type OpenClawRuntimeUpdateOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  label?: string;
  priority?: OpenClawRuntimeUpdatePriority;
} & (
  | { slug?: undefined; evicting?: undefined; holdUntil?: undefined; ignorePublications?: true }
  | { slug: string; evicting?: readonly string[]; holdUntil?: Promise<void>; ignorePublications?: undefined }
);

interface Waiter {
  sequence: number;
  enqueuedAt: number;
  label: string;
  options: OpenClawRuntimeUpdateOptions;
  begin: () => void;
}

export class OpenClawRuntimeUpdateGuard {
  private active: Promise<void> | null = null;
  private activeLabel = "";
  private readonly queue: Waiter[] = [];
  private nextSequence = 0;
  private readonly publications = new Map<string, Promise<void>>();

  tryRun<T>(operation: () => Promise<T>, label = "background runtime repair"): Promise<T> | undefined {
    if (this.active || this.queue.length > 0 || this.publications.size > 0) return undefined;
    return this.start(operation, label);
  }

  run<T>(operation: () => Promise<T>, options: OpenClawRuntimeUpdateOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(options.signal.reason);
        return;
      }
      const startedAt = Date.now();
      const label = options.label ?? (options.slug ? `runtime update for ${options.slug}` : "runtime update");
      const wait: { timer?: ReturnType<typeof setTimeout> } = {};
      const leave = () => {
        clearTimeout(wait.timer);
        options.signal?.removeEventListener("abort", abort);
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
      };
      const fail = (error: unknown) => {
        leave();
        reject(error);
        this.dispatch();
      };
      const abort = () => fail(options.signal?.reason ?? new Error("OpenClaw runtime update cancelled"));
      const waiter: Waiter = {
        sequence: this.nextSequence++,
        enqueuedAt: startedAt,
        label,
        options,
        begin: () => {
          leave();
          if (options.holdUntil) this.holdPublication(options.slug, options.holdUntil);
          this.start(operation, label).then(resolve, reject);
        },
      };
      this.queue.push(waiter);
      this.dispatch();
      if (!this.queue.includes(waiter)) return;
      wait.timer = setTimeout(() => fail(new Error(this.timeoutMessage(waiter, startedAt))),
        Math.max(0, startedAt + (options.timeoutMs ?? WAIT_TIMEOUT_MS) - Date.now()));
      options.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private ranked(now: number): Waiter[] {
    const lane = (waiter: Waiter) =>
      waiter.options.priority === "migration" || now - waiter.enqueuedAt >= RUNTIME_UPDATE_AGING_MS ? 0 : 1;
    return [...this.queue].sort((a, b) => lane(a) - lane(b) || a.sequence - b.sequence);
  }

  private dispatch(): void {
    if (this.active) return;
    this.ranked(Date.now()).find((waiter) => this.publicationBlocking(waiter.options) === undefined)?.begin();
  }

  private publicationBlocking(options: OpenClawRuntimeUpdateOptions): string | undefined {
    if (options.ignorePublications) return undefined;
    const slugs = options.slug === undefined ? [...this.publications.keys()] : [options.slug, ...(options.evicting ?? [])];
    return slugs.find((slug) => this.publications.has(slug));
  }

  private timeoutMessage(waiter: Waiter, startedAt: number): string {
    const ranked = this.ranked(Date.now());
    return `Timed out waiting for an OpenClaw runtime update: ${waiter.label} waited ${Date.now() - startedAt}ms ` +
      `behind ${this.blockerOf(waiter, ranked)}; queued: ${ranked.map((other) => other.label).join(", ")}`;
  }

  private blockerOf(waiter: Waiter, ranked: readonly Waiter[]): string {
    if (this.active) return this.activeLabel;
    const publication = this.publicationBlocking(waiter.options);
    if (publication !== undefined) return `the runtime publication of ${publication}`;
    const ahead = ranked.slice(0, ranked.indexOf(waiter)).find((other) => this.publicationBlocking(other.options) === undefined);
    return ahead ? `the queued ${ahead.label}` : "the runtime update queue";
  }

  private holdPublication(slug: string, until: Promise<void>): void {
    const held: Promise<void> = until.then(() => undefined, () => undefined).then(() => {
      if (this.publications.get(slug) === held) this.publications.delete(slug);
      this.dispatch();
    });
    this.publications.set(slug, held);
  }

  private start<T>(operation: () => Promise<T>, label: string): Promise<T> {
    const active = Promise.resolve().then(operation);
    const settled = active.then(() => undefined, () => undefined);
    this.active = settled;
    this.activeLabel = label;
    void settled.then(() => {
      if (this.active === settled) this.active = null;
      this.dispatch();
    });
    return active;
  }
}

export const openClawRuntimeUpdateGuard = new OpenClawRuntimeUpdateGuard();
