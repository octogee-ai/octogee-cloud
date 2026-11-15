import type {
  PlatformStateError,
  PlatformStateStore,
  Stored,
  WatchAggregate,
  WatchChange,
  WatchCursor,
  WatchEvent,
  WatchListener,
  WatchRecords,
  WatchRequest,
  WatchSubscription,
} from "@octogee/core/platform-state";

const SCRIPTED_CURSOR = "scripted-cursor" as WatchCursor;

export interface ScriptedWatch<A extends WatchAggregate> {
  readonly filter: WatchRequest<A>["filter"];
  readonly open: boolean;
  snapshot(records: readonly Stored<WatchRecords[A]>[]): void;
  changes(changes: readonly WatchChange<A>[]): void;
  resync(): void;
  error(error: PlatformStateError): void;
  reject(error: Error): void;
}

export interface ScriptedWatches {
  readonly watch: PlatformStateStore["watch"];
  latest<A extends WatchAggregate>(aggregate: A): ScriptedWatch<A>;
  attachCount(aggregate: WatchAggregate): number;
}

export function createScriptedWatches(): ScriptedWatches {
  const attached = new Map<WatchAggregate, ScriptedWatch<WatchAggregate>[]>();
  const watch = (<A extends WatchAggregate>(request: WatchRequest<A>, listener: WatchListener<A>): WatchSubscription => {
    let open = true;
    let settle!: { resolve: () => void; reject: (error: Error) => void };
    const closed = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const emit = (event: WatchEvent<A>) => {
      if (open) void listener.onEvent(event);
    };
    const scripted: ScriptedWatch<A> = {
      filter: request.filter,
      get open() {
        return open;
      },
      snapshot: (records) => emit({ kind: "snapshot", records, cursor: SCRIPTED_CURSOR }),
      changes: (changes) => emit({ kind: "changes", changes, cursor: SCRIPTED_CURSOR }),
      resync: () => emit({ kind: "resync", reason: "backend-restart" }),
      error: (error) => {
        if (open) listener.onError(error);
      },
      reject: (error) => {
        if (!open) return;
        open = false;
        settle.reject(error);
      },
    };
    const forAggregate = attached.get(request.aggregate) ?? [];
    forAggregate.push(scripted as unknown as ScriptedWatch<WatchAggregate>);
    attached.set(request.aggregate, forAggregate);
    return {
      closed,
      close: async () => {
        if (open) {
          open = false;
          settle.resolve();
        }
        await closed.catch(() => undefined);
      },
    };
  }) as PlatformStateStore["watch"];
  return {
    watch,
    latest: <A extends WatchAggregate>(aggregate: A) => {
      const scripted = attached.get(aggregate)?.at(-1);
      if (scripted === undefined) throw new Error(`no ${aggregate} watch attached`);
      return scripted as unknown as ScriptedWatch<A>;
    },
    attachCount: (aggregate) => attached.get(aggregate)?.length ?? 0,
  };
}

export function storeWithScriptedWatches(store: PlatformStateStore, watches: ScriptedWatches): PlatformStateStore {
  return new Proxy(store, {
    get: (target, property) => (property === "watch" ? watches.watch : Reflect.get(target, property)),
  });
}
