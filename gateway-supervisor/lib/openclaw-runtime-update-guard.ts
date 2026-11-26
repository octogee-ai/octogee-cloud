const WAIT_TIMEOUT_MS = 60_000;

export type OpenClawRuntimeUpdateOptions = { signal?: AbortSignal; timeoutMs?: number; label?: string } & (
  | { slug?: undefined; evicting?: undefined; holdUntil?: undefined; ignorePublications?: true }
  | { slug: string; evicting?: readonly string[]; holdUntil?: Promise<void>; ignorePublications?: undefined }
);

interface Blocker {
  settled: Promise<void>;
  description: string;
}

export class OpenClawRuntimeUpdateGuard {
  private active: Promise<void> | null = null;
  private activeLabel = "";
  private readonly waiting: Array<{ label: string }> = [];
  private readonly publications = new Map<string, Promise<void>>();

  tryRun<T>(operation: () => Promise<T>, label = "background runtime repair"): Promise<T> | undefined {
    if (this.active || this.waiting.length > 0 || this.publications.size > 0) return undefined;
    return this.start(operation, label);
  }

  async run<T>(operation: () => Promise<T>, options: OpenClawRuntimeUpdateOptions = {}): Promise<T> {
    const startedAt = Date.now();
    const deadline = startedAt + (options.timeoutMs ?? WAIT_TIMEOUT_MS);
    const ticket = { label: options.label ?? (options.slug ? `runtime update for ${options.slug}` : "runtime update") };
    this.waiting.push(ticket);
    try {
      options.signal?.throwIfAborted();
      for (let blocker = this.blocker(options); blocker; blocker = this.blocker(options)) {
        const { description } = blocker;
        await this.wait(blocker, deadline, options.signal, () =>
          `Timed out waiting for an OpenClaw runtime update: ${ticket.label} waited ${Date.now() - startedAt}ms behind ${description}; ` +
          `queued: ${this.waiting.map((waiter) => waiter.label).join(", ")}`);
      }
      options.signal?.throwIfAborted();
      if (options.holdUntil) this.holdPublication(options.slug, options.holdUntil);
      return this.start(operation, ticket.label);
    } finally {
      this.waiting.splice(this.waiting.indexOf(ticket), 1);
    }
  }

  private blocker(options: OpenClawRuntimeUpdateOptions): Blocker | undefined {
    if (this.active) return { settled: this.active, description: this.activeLabel };
    if (options.ignorePublications) return undefined;
    const slugs = options.slug === undefined ? [...this.publications.keys()] : [options.slug, ...(options.evicting ?? [])];
    for (const slug of slugs) {
      const publication = this.publications.get(slug);
      if (publication) return { settled: publication, description: `the runtime publication of ${slug}` };
    }
    return undefined;
  }

  private holdPublication(slug: string, until: Promise<void>): void {
    const held: Promise<void> = until.then(() => undefined, () => undefined).then(() => {
      if (this.publications.get(slug) === held) this.publications.delete(slug);
    });
    this.publications.set(slug, held);
  }

  private start<T>(operation: () => Promise<T>, label: string): Promise<T> {
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    this.active = active;
    this.activeLabel = label;
    return Promise.resolve().then(operation).finally(() => {
      if (this.active === active) this.active = null;
      release();
    });
  }

  private wait(blocker: Blocker, deadline: number, signal: AbortSignal | undefined, timeoutMessage: () => string): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal?.reason ?? new Error("OpenClaw runtime update cancelled"));
      const timer = setTimeout(() => finish(new Error(timeoutMessage())),
        Math.max(0, deadline - Date.now()));
      signal?.addEventListener("abort", abort, { once: true });
      void blocker.settled.then(() => finish());
    });
  }
}

export const openClawRuntimeUpdateGuard = new OpenClawRuntimeUpdateGuard();
