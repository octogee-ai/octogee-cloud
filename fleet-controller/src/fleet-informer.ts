import { resolveDefaultPlacementEligibility } from "@octogee/shared/types/orchestrator-placement";
import type {
  PlatformUserRecord,
  PlatformStateError,
  PlatformStateStore,
  Stored,
  WatchChange,
  WatchEvent,
  WatchFilters,
  WatchRecords,
  WatchSubscription,
} from "@octogee/core/platform-state";
import { userPlacementDocument } from "./user-placement-document.js";

export const FLEET_INFORMER_REATTACH_MS_DEFAULT = 60_000;

export type MirroredAggregate = "gateways" | "fleetRegistry" | "assignments" | "builders";

export type MirrorDelivery<A extends MirroredAggregate> =
  | { readonly kind: "reset"; readonly records: readonly Stored<WatchRecords[A]>[] }
  | { readonly kind: "changes"; readonly changes: readonly WatchChange<A>[] };

export type MirrorSubscriber<A extends MirroredAggregate> = (delivery: MirrorDelivery<A>) => void;

export interface MirrorWithoutMalformed<A extends MirroredAggregate> {
  readonly records: readonly Stored<WatchRecords[A]>[];
  readonly malformedKeys: readonly string[];
}

export interface FleetInformer {
  gateways(): readonly Stored<WatchRecords["gateways"]>[] | null;
  fleetRegistry(): readonly Stored<WatchRecords["fleetRegistry"]>[] | null;
  fleetRegistryWithoutMalformed(): MirrorWithoutMalformed<"fleetRegistry"> | null;
  assignments(): readonly Stored<WatchRecords["assignments"]>[] | null;
  users(): readonly Stored<PlatformUserRecord>[] | null;
  usersWithoutMalformed(): MirrorWithoutMalformed<"builders"> | null;
  subscribe<A extends MirroredAggregate>(aggregate: A, subscriber: MirrorSubscriber<A>): () => void;
  subscribeUnassignedUsers?(wake: () => void): () => void;
  stop(): void;
}

export interface FleetInformerDeps {
  store: PlatformStateStore;
  log: (message: string) => void;
  reattachMs?: number;
}

const RECORD_KEYS: { readonly [A in MirroredAggregate]: (record: Stored<WatchRecords[A]>) => string } = {
  gateways: (record) => record.gatewayId,
  fleetRegistry: (record) => record.gatewayId,
  assignments: (record) => `${record.gatewayId}/${record.uid}`,
  builders: (record) => record.uid,
};

interface MirrorView<A extends MirroredAggregate> {
  readonly records: Map<string, Stored<WatchRecords[A]>>;
  readonly malformed: Map<string, string>;
}

function sortedByKey<T>(entries: Iterable<[string, T]>): T[] {
  return [...entries].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

class RecordMirror<A extends MirroredAggregate> {
  private view: MirrorView<A> | null = null;
  private live = false;
  private incomingMalformed = new Map<string, string>();
  private strictlyFresh = false;

  constructor(
    private readonly name: A,
    private readonly log: (message: string) => void,
  ) {}

  read(): readonly Stored<WatchRecords[A]>[] | null {
    if (this.view === null || !this.isStrictlyFresh()) return null;
    return sortedByKey(this.view.records.entries());
  }

  readWithoutMalformed(): MirrorWithoutMalformed<A> | null {
    if (this.view === null) return null;
    const malformedKeys = new Set([...this.view.malformed.keys(), ...this.incomingMalformed.keys()]);
    return { records: sortedByKey(this.view.records.entries()), malformedKeys: [...malformedKeys].sort() };
  }

  beginSubscription(carryView: boolean, reason: string): void {
    this.live = false;
    this.incomingMalformed = new Map();
    if (!carryView) this.view = null;
    this.settle(reason);
  }

  replace(records: readonly Stored<WatchRecords[A]>[]): void {
    const key: (record: Stored<WatchRecords[A]>) => string = RECORD_KEYS[this.name];
    this.view = { records: new Map(records.map((record) => [key(record), record])), malformed: this.incomingMalformed };
    this.incomingMalformed = new Map();
    this.live = true;
    this.refresh();
  }

  apply(changes: readonly WatchChange<A>[]): void {
    if (!this.live || this.view === null) return;
    for (const change of changes) {
      if (change.record === null) {
        this.view.records.delete(change.key);
        continue;
      }
      this.view.records.set(change.key, change.record);
      this.view.malformed.delete(change.key);
    }
    this.refresh();
  }

  rejectRecord(key: string, reason: string): void {
    if (this.live && this.view !== null) {
      this.view.records.delete(key);
      this.view.malformed.set(key, reason);
    } else {
      this.incomingMalformed.set(key, reason);
    }
    this.settle(reason);
  }

  discard(reason: string): void {
    this.live = false;
    this.view = null;
    this.incomingMalformed = new Map();
    this.settle(reason);
  }

  private isStrictlyFresh(): boolean {
    return this.live && this.view !== null && this.view.malformed.size === 0;
  }

  private settle(reason: string): void {
    if (this.strictlyFresh && !this.isStrictlyFresh()) {
      this.log(`[fleet-informer] ⚠ ${this.name} mirror stale — ${reason}; readers fall back to a direct read`);
    }
    this.refresh();
  }

  private refresh(): void {
    this.strictlyFresh = this.isStrictlyFresh();
  }
}

export function assignedSlugsFromUserMirror(
  users: readonly Pick<PlatformUserRecord, "uid" | "slug" | "gateway">[],
  gatewayId: string,
): string[] {
  return users.flatMap((user) => (user.gateway?.gatewayId === gatewayId && user.slug ? [user.slug] : []));
}

function placementIsPending(user: Stored<PlatformUserRecord>): boolean {
  return user.gateway === null && resolveDefaultPlacementEligibility(userPlacementDocument(user, {})).eligible;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createFleetInformer(deps: FleetInformerDeps): FleetInformer {
  const { store, log } = deps;
  const reattachMs = deps.reattachMs ?? FLEET_INFORMER_REATTACH_MS_DEFAULT;
  const mirrors: { readonly [A in MirroredAggregate]: RecordMirror<A> } = {
    gateways: new RecordMirror("gateways", log),
    fleetRegistry: new RecordMirror("fleetRegistry", log),
    assignments: new RecordMirror("assignments", log),
    builders: new RecordMirror("builders", log),
  };
  const subscribers: { readonly [A in MirroredAggregate]: Set<MirrorSubscriber<A>> } = {
    gateways: new Set(),
    fleetRegistry: new Set(),
    assignments: new Set(),
    builders: new Set(),
  };

  const placementListeners = new Set<() => void>();
  let pendingUsers = "";
  const notifyUnassignedChanges = () => {
    const users = mirrors.builders.readWithoutMalformed();
    if (users === null) return;
    const pending = users.records.filter(placementIsPending).map((user) => user.uid).join("\n");
    if (pending === pendingUsers) return;
    pendingUsers = pending;
    for (const wake of placementListeners) wake();
  };

  let stopped = false;
  const watchTokens = new Map<MirroredAggregate, object>();
  const subscriptions = new Map<MirroredAggregate, WatchSubscription>();
  const reattachTimers = new Map<string, NodeJS.Timeout>();

  const scheduleReattach = (name: string, reason: string, reattach: () => void) => {
    if (stopped || reattachTimers.has(name)) return;
    const timer = setTimeout(() => {
      reattachTimers.delete(name);
      log(`[fleet-informer] re-attaching the ${name} watch after: ${reason}`);
      reattach();
    }, reattachMs);
    reattachTimers.set(name, timer);
  };

  const deliver = <A extends MirroredAggregate>(aggregate: A, delivery: MirrorDelivery<A>) => {
    const registered: Set<MirrorSubscriber<A>> = subscribers[aggregate];
    for (const subscriber of registered) {
      try {
        subscriber(delivery);
      } catch (error) {
        log(`[fleet-informer] ⚠ ${aggregate} subscriber failed: ${errorMessage(error)}`);
      }
    }
  };

  const watchRecords = <A extends MirroredAggregate>(aggregate: A, carryView = false): void => {
    if (stopped) return;
    const mirror: RecordMirror<A> = mirrors[aggregate];
    const reattach = () => watchRecords(aggregate);
    const reattachCarryingView = () => watchRecords(aggregate, true);
    const token = {};
    const current = () => !stopped && watchTokens.get(aggregate) === token;
    watchTokens.set(aggregate, token);
    void subscriptions.get(aggregate)?.close();
    mirror.beginSubscription(carryView, "watch restarting");
    const subscription = store.watch<A>(
      { aggregate, filter: {} as WatchFilters[A] },
      {
        onEvent: (event: WatchEvent<A>) => {
          if (!current()) return;
          if (event.kind === "resync") {
            mirror.beginSubscription(false, `watch resync after ${event.reason}`);
            return;
          }
          if (event.kind === "snapshot") {
            mirror.replace(event.records);
            deliver(aggregate, { kind: "reset", records: event.records });
            if (aggregate === "builders") notifyUnassignedChanges();
            return;
          }
          mirror.apply(event.changes);
          deliver(aggregate, { kind: "changes", changes: event.changes });
          if (aggregate === "builders") notifyUnassignedChanges();
        },
        onError: (error: PlatformStateError) => {
          if (!current()) return;
          log(`[fleet-informer] ⚠ ${aggregate} watch error: ${error.message}`);
          if (error.code === "backend-failure") {
            mirror.discard(error.message);
            return;
          }
          if (error.code === "malformed-record") {
            mirror.rejectRecord(error.record.key, error.message);
            scheduleReattach(aggregate, error.message, reattachCarryingView);
            return;
          }
          mirror.discard(error.message);
          scheduleReattach(aggregate, error.message, reattach);
        },
      },
    );
    subscriptions.set(aggregate, subscription);
    subscription.closed.catch((error: unknown) => {
      if (!current()) return;
      log(`[fleet-informer] ⚠ ${aggregate} watch closed: ${errorMessage(error)}`);
      mirror.discard(errorMessage(error));
      scheduleReattach(aggregate, errorMessage(error), reattach);
    });
  };

  watchRecords("gateways");
  watchRecords("fleetRegistry");
  watchRecords("assignments");
  watchRecords("builders");

  return {
    gateways: () => mirrors.gateways.read(),
    fleetRegistry: () => mirrors.fleetRegistry.read(),
    fleetRegistryWithoutMalformed: () => mirrors.fleetRegistry.readWithoutMalformed(),
    assignments: () => mirrors.assignments.read(),
    users: () => mirrors.builders.read(),
    usersWithoutMalformed: () => mirrors.builders.readWithoutMalformed(),
    subscribe: <A extends MirroredAggregate>(aggregate: A, subscriber: MirrorSubscriber<A>) => {
      const registered: Set<MirrorSubscriber<A>> = subscribers[aggregate];
      registered.add(subscriber);
      return () => { registered.delete(subscriber); };
    },
    subscribeUnassignedUsers: (wake) => {
      placementListeners.add(wake);
      return () => { placementListeners.delete(wake); };
    },
    stop: () => {
      stopped = true;
      placementListeners.clear();
      subscribers.gateways.clear();
      subscribers.fleetRegistry.clear();
      subscribers.assignments.clear();
      subscribers.builders.clear();
      for (const timer of reattachTimers.values()) clearTimeout(timer);
      reattachTimers.clear();
      for (const subscription of subscriptions.values()) void subscription.close();
      subscriptions.clear();
      watchTokens.clear();
    },
  };
}
