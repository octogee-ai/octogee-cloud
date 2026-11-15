const WAIT_TIMEOUT_MS = 60_000;

export type OpenClawRuntimeUpdateOptions = { signal?: AbortSignal; timeoutMs?: number } & (
  | { slug?: undefined; evicting?: undefined; holdUntil?: undefined; ignorePublications?: true }
  | { slug: string; evicting?: readonly string[]; holdUntil?: Promise<void>; ignorePublications?: undefined }
);

export class OpenClawRuntimeUpdateGuard {
  private active: Promise<void> | null = null;
  private waiting = 0;
  private readonly publications = new Map<string, Promise<void>>();

  tryRun<T>(operation: () => Promise<T>): Promise<T> | undefined {
    if (this.active || this.waiting > 0 || this.publications.size > 0) return undefined;
    return this.start(operation);
  }

  async run<T>(operation: () => Promise<T>, options: OpenClawRuntimeUpdateOptions = {}): Promise<T> {
    const deadline = Date.now() + (options.timeoutMs ?? WAIT_TIMEOUT_MS);
    this.waiting += 1;
    try {
      options.signal?.throwIfAborted();
      for (let blocker = this.blocker(options); blocker; blocker = this.blocker(options)) {
        await this.wait(blocker, deadline, options.signal);
      }
      options.signal?.throwIfAborted();
      if (options.holdUntil) this.holdPublication(options.slug, options.holdUntil);
      return this.start(operation);
    } finally {
      this.waiting -= 1;
    }
  }

  private blocker(options: OpenClawRuntimeUpdateOptions): Promise<void> | undefined {
    if (this.active) return this.active;
    if (options.ignorePublications) return undefined;
    if (options.slug === undefined) return this.publications.values().next().value;
    for (const slug of [options.slug, ...(options.evicting ?? [])]) {
      const publication = this.publications.get(slug);
      if (publication) return publication;
    }
    return undefined;
  }

  private holdPublication(slug: string, until: Promise<void>): void {
    const held: Promise<void> = until.then(() => undefined, () => undefined).then(() => {
      if (this.publications.get(slug) === held) this.publications.delete(slug);
    });
    this.publications.set(slug, held);
  }

  private start<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    this.active = active;
    return Promise.resolve().then(operation).finally(() => {
      if (this.active === active) this.active = null;
      release();
    });
  }

  private wait(active: Promise<void>, deadline: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal?.reason ?? new Error("OpenClaw runtime update cancelled"));
      const timer = setTimeout(() => finish(new Error("Timed out waiting for an OpenClaw runtime update")),
        Math.max(0, deadline - Date.now()));
      signal?.addEventListener("abort", abort, { once: true });
      void active.then(() => finish());
    });
  }
}

export const openClawRuntimeUpdateGuard = new OpenClawRuntimeUpdateGuard();
