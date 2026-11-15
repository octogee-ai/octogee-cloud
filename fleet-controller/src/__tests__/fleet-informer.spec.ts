import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BackendFailureError,
  MalformedRecordError,
  type Stored,
  type WatchRecords,
} from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import {
  assignedSlugsFromUserMirror,
  createFleetInformer,
  FLEET_INFORMER_REATTACH_MS_DEFAULT,
  type FleetInformer,
  type MirroredAggregate,
  type MirrorDelivery,
} from "../fleet-informer.js";
import { createScriptedWatches, storeWithScriptedWatches, type ScriptedWatches } from "./fixtures/scripted-watches.js";

function startInformer(options: { reattachMs?: number; log?: (message: string) => void } = {}) {
  const watches = createScriptedWatches();
  const store = storeWithScriptedWatches(createDocumentFixtureStore({}), watches);
  const informer = createFleetInformer({ store, log: options.log ?? vi.fn(), reattachMs: options.reattachMs });
  return { informer, watches };
}

function record<A extends MirroredAggregate>(fields: Record<string, unknown>): Stored<WatchRecords[A]> {
  return { revision: "r1", ...fields } as unknown as Stored<WatchRecords[A]>;
}

const MIRRORS = [
  ["gateways", (informer: FleetInformer) => informer.gateways()],
  ["fleetRegistry", (informer: FleetInformer) => informer.fleetRegistry()],
  ["assignments", (informer: FleetInformer) => informer.assignments()],
] as const;

function gatewayRecord(gatewayId: string, fields: Record<string, unknown> = {}) {
  return record<"fleetRegistry">({ gatewayId, lifecycle: "serving", ...fields });
}

function malformed(gatewayId: string): MalformedRecordError {
  return new MalformedRecordError({ aggregate: "fleet-registry", key: gatewayId }, "is not this gateway's runtime record");
}

function listenerFailure(): BackendFailureError {
  return new BackendFailureError("firestore", "watch fleetRegistry", { cause: new Error("listen stream broke") });
}

function user(uid: string, fields: Record<string, unknown> = {}): Stored<WatchRecords["builders"]> {
  return record<"builders">({
    uid,
    slug: uid,
    admitted: true,
    accountLifecycle: null,
    provisioning: { status: "in_progress" },
    openclaw: {},
    gateway: null,
    activationLease: null,
    fences: {},
    ...fields,
  });
}

describe("fleet informer — User records mirror", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wakes placement only when the eligible unassigned users change", () => {
    const { informer, watches } = startInformer();
    const wake = vi.fn();
    const stop = informer.subscribeUnassignedUsers!(wake);

    watches.latest("builders").snapshot([user("alice")]);
    expect(wake).toHaveBeenCalledOnce();

    watches.latest("builders").changes([
      { type: "modified", key: "alice", record: user("alice", { persona: { vibe: "calm" } }) },
    ]);
    expect(wake).toHaveBeenCalledOnce();

    watches.latest("builders").changes([
      { type: "modified", key: "alice", record: user("alice", { gateway: { gatewayId: "shared-a" } }) },
    ]);
    expect(wake).toHaveBeenCalledTimes(2);
    stop();
    informer.stop();
  });

  it("does not wake placement for a user the operator manages", () => {
    const { informer, watches } = startInformer();
    const wake = vi.fn();
    informer.subscribeUnassignedUsers!(wake);

    watches.latest("builders").snapshot([user("alice", { openclaw: { managedBy: "operator" } })]);

    expect(wake).not.toHaveBeenCalled();
    informer.stop();
  });

  it("serves null before the first snapshot and users sorted by uid after it", () => {
    const { informer, watches } = startInformer();
    expect(informer.users()).toBeNull();

    watches.latest("builders").snapshot([user("uid-b"), user("uid-a")]);

    expect(informer.users()?.map((stored) => stored.uid)).toEqual(["uid-a", "uid-b"]);
    informer.stop();
  });

  it("drops a removed user from the mirror", () => {
    const { informer, watches } = startInformer();
    watches.latest("builders").snapshot([user("uid-a"), user("uid-b")]);

    watches.latest("builders").changes([{ type: "removed", key: "uid-a", record: null }]);

    expect(informer.users()?.map((stored) => stored.uid)).toEqual(["uid-b"]);
    informer.stop();
  });

  it("keeps the healthy users readable when one record is malformed", () => {
    const { informer, watches } = startInformer();
    watches.latest("builders").snapshot([user("uid-a"), user("uid-b")]);

    watches.latest("builders").error(
      new MalformedRecordError({ aggregate: "builder", key: "uid-b" }, "provisioning.status is not a string"),
    );

    expect(informer.users()).toBeNull();
    expect(informer.usersWithoutMalformed()?.records.map((stored) => stored.uid)).toEqual(["uid-a"]);
    expect(informer.usersWithoutMalformed()?.malformedKeys).toEqual(["uid-b"]);
    informer.stop();
  });

  it("discards the mirror when the watch dies and re-attaches after the delay", async () => {
    const log = vi.fn();
    const { informer, watches } = startInformer({ log, reattachMs: 5_000 });
    watches.latest("builders").snapshot([user("uid-a")]);

    watches.latest("builders").reject(new Error("listen stream broke"));
    await vi.advanceTimersByTimeAsync(0);

    expect(informer.users()).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("listen stream broke"));
    vi.advanceTimersByTime(4_999);
    expect(watches.attachCount("builders")).toBe(1);
    vi.advanceTimersByTime(1);
    expect(watches.attachCount("builders")).toBe(2);
    informer.stop();
  });
});

describe("fleet informer — store watch mirrors", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("watches gateways, the fleet registry and assignments across the whole fleet", () => {
    const { informer, watches } = startInformer();

    for (const [aggregate] of MIRRORS) {
      expect(watches.attachCount(aggregate)).toBe(1);
      expect(watches.latest(aggregate).filter).toEqual({});
    }
    expect(watches.attachCount("builders")).toBe(1);
    expect(watches.latest("builders").filter).toEqual({});
    informer.stop();
  });

  it.each(MIRRORS)("serves null before the first %s snapshot and records sorted by key after it", (aggregate, read) => {
    const { informer, watches } = startInformer();
    expect(read(informer)).toBeNull();

    watches.latest(aggregate).snapshot([
      record<typeof aggregate>({ gatewayId: "shared-b", uid: "uid-a" }),
      record<typeof aggregate>({ gatewayId: "shared-a", uid: "uid-a" }),
    ]);

    expect(read(informer)?.map((stored) => stored.gatewayId)).toEqual(["shared-a", "shared-b"]);
    informer.stop();
  });

  it("applies added, modified and removed changes as deltas", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.snapshot([gatewayRecord("shared-blue"), gatewayRecord("walter")]);

    watch.changes([
      { type: "modified", key: "walter", record: gatewayRecord("walter", { lifecycle: "failed" }) },
      { type: "removed", key: "shared-blue", record: null },
      { type: "added", key: "alice-b", record: gatewayRecord("alice-b") },
    ]);

    expect(informer.fleetRegistry()?.map((stored) => [stored.gatewayId, stored.lifecycle])).toEqual([
      ["alice-b", "serving"],
      ["walter", "failed"],
    ]);
    informer.stop();
  });

  it("keys assignments by gateway and uid, so one user's assignments on two gateways both stay mirrored", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("assignments");
    watch.snapshot([
      record<"assignments">({ gatewayId: "shared-blue", uid: "uid-a", state: "quiescing" }),
      record<"assignments">({ gatewayId: "shared-green", uid: "uid-a", state: "serving" }),
    ]);
    watch.changes([{ type: "removed", key: "shared-blue/uid-a", record: null }]);

    expect(informer.assignments()?.map((stored) => [stored.gatewayId, stored.uid, stored.state])).toEqual([
      ["shared-green", "uid-a", "serving"],
    ]);
    informer.stop();
  });

  it("goes stale on a backend failure and recovers on the store's own resubscribe without re-attaching", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.snapshot([gatewayRecord("shared-blue")]);

    watch.error(listenerFailure());
    expect(informer.fleetRegistry()).toBeNull();
    watch.changes([{ type: "added", key: "walter", record: gatewayRecord("walter") }]);
    expect(informer.fleetRegistry()).toBeNull();
    watch.resync();
    expect(informer.fleetRegistry()).toBeNull();
    watch.snapshot([gatewayRecord("walter")]);

    expect(informer.fleetRegistry()?.map((stored) => stored.gatewayId)).toEqual(["walter"]);
    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT * 2);
    expect(watches.attachCount("fleetRegistry")).toBe(1);
    informer.stop();
  });

  it("stays stale through a snapshot that dropped a malformed record and re-attaches once after the delay", () => {
    const log = vi.fn();
    const { informer, watches } = startInformer({ log, reattachMs: 5_000 });
    const first = watches.latest("fleetRegistry");

    first.error(malformed("broken"));
    first.error(malformed("broken-too"));
    first.snapshot([gatewayRecord("shared-blue")]);
    expect(informer.fleetRegistry()).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`fleet-registry "broken" is malformed`));

    vi.advanceTimersByTime(4_999);
    expect(watches.attachCount("fleetRegistry")).toBe(1);
    vi.advanceTimersByTime(1);
    expect(watches.attachCount("fleetRegistry")).toBe(2);
    expect(first.open).toBe(false);

    watches.latest("fleetRegistry").snapshot([gatewayRecord("shared-blue")]);
    expect(informer.fleetRegistry()?.map((stored) => stored.gatewayId)).toEqual(["shared-blue"]);
    informer.stop();
  });

  it("goes stale when a record already mirrored turns malformed and re-attaches", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.snapshot([gatewayRecord("shared-blue"), gatewayRecord("walter")]);

    watch.error(malformed("walter"));
    watch.changes([{ type: "removed", key: "walter", record: null }]);

    expect(informer.fleetRegistry()).toBeNull();
    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT);
    expect(watches.attachCount("fleetRegistry")).toBe(2);
    informer.stop();
  });

  it("serves the valid runtime records and the malformed keys while malformed records are the only staleness", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.error(malformed("broken"));
    watch.snapshot([gatewayRecord("shared-blue"), gatewayRecord("walter")]);
    watch.changes([{ type: "added", key: "alice-b", record: gatewayRecord("alice-b") }]);
    watch.error(malformed("walter"));
    watch.changes([{ type: "removed", key: "walter", record: null }]);

    expect(informer.fleetRegistry()).toBeNull();
    expect(informer.fleetRegistryWithoutMalformed()).toEqual({
      records: [gatewayRecord("alice-b"), gatewayRecord("shared-blue")],
      malformedKeys: ["broken", "walter"],
    });
    informer.stop();
  });

  it("serves the strict mirror again once a valid record replaces the only malformed one", () => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.snapshot([gatewayRecord("shared-blue")]);
    watch.error(malformed("walter"));
    expect(informer.fleetRegistry()).toBeNull();

    watch.changes([{ type: "added", key: "walter", record: gatewayRecord("walter") }]);

    expect(informer.fleetRegistry()?.map((stored) => stored.gatewayId)).toEqual(["shared-blue", "walter"]);
    expect(informer.fleetRegistryWithoutMalformed()?.malformedKeys).toEqual([]);
    informer.stop();
  });

  it("carries the valid runtime records across a malformed-record re-attach until the new snapshot", () => {
    const { informer, watches } = startInformer({ reattachMs: 5_000 });
    const first = watches.latest("fleetRegistry");
    first.error(malformed("broken"));
    first.snapshot([gatewayRecord("shared-blue")]);
    vi.advanceTimersByTime(5_000);
    const second = watches.latest("fleetRegistry");
    second.error(malformed("broken"));

    expect(watches.attachCount("fleetRegistry")).toBe(2);
    expect(informer.fleetRegistryWithoutMalformed()).toEqual({ records: [gatewayRecord("shared-blue")], malformedKeys: ["broken"] });

    second.snapshot([gatewayRecord("walter")]);
    expect(informer.fleetRegistryWithoutMalformed()).toEqual({ records: [gatewayRecord("walter")], malformedKeys: ["broken"] });
    informer.stop();
  });

  it.each([
    ["a backend failure", (watch: ReturnType<ScriptedWatches["latest"]>) => watch.error(listenerFailure())],
    ["a resync", (watch: ReturnType<ScriptedWatches["latest"]>) => watch.resync()],
    ["a closed watch", (watch: ReturnType<ScriptedWatches["latest"]>) => watch.reject(new Error("listener threw"))],
  ])("serves no valid runtime records after %s", async (_label, interrupt) => {
    const { informer, watches } = startInformer();
    const watch = watches.latest("fleetRegistry");
    watch.error(malformed("broken"));
    watch.snapshot([gatewayRecord("shared-blue")]);

    interrupt(watch);
    await vi.advanceTimersByTimeAsync(0);

    expect(informer.fleetRegistryWithoutMalformed()).toBeNull();
    expect(informer.fleetRegistry()).toBeNull();
    informer.stop();
  });

  it("re-attaches after the watch closes with an error", async () => {
    const log = vi.fn();
    const { informer, watches } = startInformer({ log });
    const watch = watches.latest("gateways");
    watch.snapshot([record<"gateways">({ gatewayId: "shared-blue" })]);

    watch.reject(new Error("listener threw"));
    await vi.advanceTimersByTimeAsync(0);

    expect(informer.gateways()).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("gateways watch closed: listener threw"));
    await vi.advanceTimersByTimeAsync(FLEET_INFORMER_REATTACH_MS_DEFAULT);
    expect(watches.attachCount("gateways")).toBe(2);
    informer.stop();
  });

  it("logs a staleness transition once, not per error or read", () => {
    const log = vi.fn();
    const { informer, watches } = startInformer({ log });
    const watch = watches.latest("gateways");
    watch.snapshot([]);

    watch.error(listenerFailure());
    watch.error(listenerFailure());
    informer.gateways();
    informer.gateways();

    expect(log.mock.calls.filter(([message]) => String(message).includes("gateways mirror stale"))).toHaveLength(1);
    informer.stop();
  });

  it("delivers each snapshot as a reset and each changes event as changes to subscribers", () => {
    const { informer, watches } = startInformer();
    const deliveries: MirrorDelivery<"gateways">[] = [];
    const unsubscribe = informer.subscribe("gateways", (delivery) => deliveries.push(delivery));
    const watch = watches.latest("gateways");
    const root = record<"gateways">({ gatewayId: "shared-blue" });

    watch.snapshot([root]);
    watch.changes([{ type: "removed", key: "shared-blue", record: null }]);
    unsubscribe();
    watch.snapshot([]);

    expect(deliveries).toEqual([
      { kind: "reset", records: [root] },
      { kind: "changes", changes: [{ type: "removed", key: "shared-blue", record: null }] },
    ]);
    informer.stop();
  });

  it("keeps mirroring and delivering when one subscriber throws", () => {
    const log = vi.fn();
    const { informer, watches } = startInformer({ log });
    const delivered = vi.fn();
    informer.subscribe("fleetRegistry", () => {
      throw new Error("subscriber broke");
    });
    informer.subscribe("fleetRegistry", delivered);

    watches.latest("fleetRegistry").snapshot([gatewayRecord("shared-blue")]);

    expect(delivered).toHaveBeenCalledOnce();
    expect(informer.fleetRegistry()).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("fleetRegistry subscriber failed: subscriber broke"));
    informer.stop();
  });

  it("stop() closes every watch and cancels pending re-attaches", () => {
    const { informer, watches } = startInformer();
    watches.latest("fleetRegistry").error(malformed("broken"));
    watches.latest("builders").error(new BackendFailureError("firestore", "watch users", { cause: new Error("boom") }));

    informer.stop();

    for (const [aggregate] of MIRRORS) expect(watches.latest(aggregate).open).toBe(false);
    expect(watches.latest("builders").open).toBe(false);
    vi.advanceTimersByTime(FLEET_INFORMER_REATTACH_MS_DEFAULT * 2);
    expect(watches.attachCount("fleetRegistry")).toBe(1);
    expect(watches.attachCount("builders")).toBe(1);
  });
});

describe("assignedSlugsFromUserMirror", () => {
  const users = [
    { uid: "uid-a", slug: "alice", gateway: { gatewayId: "shared-blue" } },
    { uid: "uid-b", slug: "bob", gateway: { gatewayId: "shared-blue" } },
    { uid: "uid-c", slug: "carol", gateway: { gatewayId: "walter" } },
    { uid: "uid-d", slug: "dave", gateway: null },
    { uid: "uid-e", slug: null, gateway: { gatewayId: "walter" } },
  ];

  it("lists the slugs of the users mirrored on the gateway", () => {
    expect(assignedSlugsFromUserMirror(users, "shared-blue").sort()).toEqual(["alice", "bob"]);
    expect(assignedSlugsFromUserMirror(users, "walter")).toEqual(["carol"]);
    expect(assignedSlugsFromUserMirror(users, "ghost")).toEqual([]);
  });
});
