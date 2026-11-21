import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendFailureError } from "../../errors.js";
import type { PlatformStateStore, WatchChange, WatchCursor, WatchEvent, WatchRequest } from "../../store.js";
import {
  createHarness,
  dsn,
  FAST_TIMINGS,
  gate,
  operation,
  recordingListener,
  type PlatformStateHarness,
  type RecordingListener,
} from "./fixtures/harness.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WAIT = { timeout: 20_000, interval: 20 };
const PENDING: WatchRequest<"operations"> = { aggregate: "operations", filter: { statuses: ["pending"] } };

type OperationsListener = RecordingListener<"operations">;

function changesOf(listener: OperationsListener): WatchChange<"operations">[] {
  return listener.events.flatMap((event) => (event.kind === "changes" ? [...event.changes] : []));
}

function snapshotIds(event: WatchEvent<"operations"> | undefined): string[] {
  if (event?.kind !== "snapshot") throw new Error(`expected a snapshot, got ${event?.kind}`);
  return event.records.map((record) => record.id).sort();
}

function cursorOf(event: WatchEvent<"operations"> | undefined): WatchCursor {
  if (event === undefined || event.kind === "resync") throw new Error("expected an event with a cursor");
  return event.cursor;
}

function kinds(listener: OperationsListener): string[] {
  return listener.events.map((event) => (event.kind === "resync" ? `resync:${event.reason}` : event.kind));
}

describe.skipIf(!dsn)("PostgreSQL platform state watch", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function listenBackends(): Promise<number> {
    const [row] = await harness.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name = $1::text AND query LIKE 'LISTEN %'",
      [harness.applicationName],
    );
    return row.count as number;
  }

  async function purgeEntireChangeLog(): Promise<void> {
    await vi.waitFor(async () => {
      await harness.store.sweepExpired(Date.now() + 2 * DAY_MS, 100);
      const [row] = await harness.query("SELECT count(*)::int AS count FROM $schema.change_log");
      expect(row.count).toBe(0);
    }, WAIT);
  }

  async function watched(store: PlatformStateStore = harness.store, request: WatchRequest<"operations"> = PENDING) {
    const listener = recordingListener<"operations">();
    const subscription = store.watch(request, listener);
    await vi.waitFor(() => expect(listener.events.length).toBeGreaterThan(0), WAIT);
    return { listener, subscription };
  }

  it("delivers a snapshot of the records that match the filter, with a cursor", async () => {
    await harness.store.journal.operations.create(operation({ id: "pending-a" }));
    await harness.store.journal.operations.create(operation({ id: "running-b", status: "running", startedAt: 1 }));

    const { listener } = await watched();

    expect(snapshotIds(listener.events[0])).toEqual(["pending-a"]);
    expect(cursorOf(listener.events[0])).toMatch(/^\d+$/);
    expect(listener.events[0]).toMatchObject({ records: [{ id: "pending-a", revision: expect.any(String) }] });
  });

  it("streams added, modified, and removed changes for the filter and ignores records outside it", async () => {
    await harness.store.journal.operations.create(operation({ id: "a" }));
    const { listener } = await watched();

    await harness.store.journal.operations.create(operation({ id: "outside", status: "running", startedAt: 1 }));
    await harness.store.journal.operations.create(operation({ id: "b" }));
    await vi.waitFor(() => expect(changesOf(listener)).toContainEqual(expect.objectContaining({ type: "added", key: "b" })), WAIT);

    await harness.store.journal.operations.patch("a", { waitingOn: "b" });
    await vi.waitFor(
      () => expect(changesOf(listener)).toContainEqual({ type: "modified", key: "a", record: expect.objectContaining({ waitingOn: "b" }) }),
      WAIT,
    );

    await harness.store.journal.operations.patch("b", { status: "running", startedAt: 2 });
    await vi.waitFor(() => expect(changesOf(listener)).toContainEqual({ type: "removed", key: "b", record: null }), WAIT);

    await harness.store.journal.operations.delete("a");
    await vi.waitFor(() => expect(changesOf(listener)).toContainEqual({ type: "removed", key: "a", record: null }), WAIT);

    expect(changesOf(listener).map((change) => change.key)).not.toContain("outside");
    const cursors = listener.events.map((event) => BigInt(cursorOf(event)));
    expect(cursors).toEqual([...cursors].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  });

  it("does not replay a snapshot revision when an older transaction holds the change horizon", async () => {
    const held = await harness.pool.connect();
    try {
      await held.query("BEGIN");
      await held.query("SELECT pg_current_xact_id()");
      await harness.store.journal.operations.create(operation({ id: "visible" }));
      const { listener } = await watched();
      expect(snapshotIds(listener.events[0])).toEqual(["visible"]);
      await held.query("COMMIT");
      await harness.store.journal.operations.create(operation({ id: "later" }));
      await vi.waitFor(() => expect(changesOf(listener)).toContainEqual(expect.objectContaining({ key: "later" })), WAIT);
      expect(changesOf(listener).map(({ type, key }) => `${type}:${key}`)).toEqual(["added:later"]);
    } finally {
      await held.query("ROLLBACK");
      held.release();
    }
  });

  it("wakes on a change notification instead of waiting for the poll interval", async () => {
    const store = harness.openStore({ ...FAST_TIMINGS, watchTiming: { pollIntervalMs: 60_000, initialRetryDelayMs: 20, maxRetryDelayMs: 200 } });
    const { listener } = await watched(store);
    await vi.waitFor(async () => expect(await listenBackends()).toBe(1), WAIT);

    await harness.store.journal.operations.create(operation({ id: "notified" }));

    await vi.waitFor(() => expect(changesOf(listener)).toContainEqual(expect.objectContaining({ type: "added", key: "notified" })), WAIT);
  });

  it("notifies placement of a retry requested on a terminal migration without including ordinary failures", async () => {
    const store = harness.openStore({
      ...FAST_TIMINGS,
      watchTiming: { pollIntervalMs: 60_000, initialRetryDelayMs: 20, maxRetryDelayMs: 200 },
    });
    await harness.store.journal.operations.create(operation({ id: "return", kind: "migrate-user", status: "failed" }));
    await harness.store.journal.operations.create(operation({ id: "unrelated", status: "failed" }));
    const { listener } = await watched(store, { aggregate: "operations", filter: { statuses: ["pending"], includeMigrationRecovery: true } });
    expect(snapshotIds(listener.events[0])).toEqual([]);
    await vi.waitFor(async () => expect(await listenBackends()).toBe(1), WAIT);

    await harness.store.journal.operations.patch("unrelated", { retryRequestedAt: 10 });
    await harness.store.journal.operations.patch("return", { retryRequestedAt: 11 });

    await vi.waitFor(() => expect(changesOf(listener)).toMatchObject([
      { type: "added", key: "return", record: { status: "failed", retryRequestedAt: 11 } },
    ]), WAIT);
  });

  it("keeps delivering by polling while the notification connection is down", async () => {
    const store = harness.openStore({
      ...FAST_TIMINGS,
      notificationTiming: { initialReconnectDelayMs: 60_000, maxReconnectDelayMs: 60_000 },
    });
    const { listener } = await watched(store);
    await vi.waitFor(async () => expect(await listenBackends()).toBe(1), WAIT);

    expect(await harness.terminate("listen")).toBe(1);
    await vi.waitFor(() => expect(harness.logs).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringMatching(/connection lost/) })), WAIT);
    await harness.store.journal.operations.create(operation({ id: "polled" }));

    await vi.waitFor(() => expect(changesOf(listener)).toContainEqual(expect.objectContaining({ type: "added", key: "polled" })), WAIT);
    expect(await listenBackends()).toBe(0);
  });

  it("reconnects the notification connection after losing it", async () => {
    const store = harness.openStore({ ...FAST_TIMINGS, watchTiming: { pollIntervalMs: 60_000, initialRetryDelayMs: 20, maxRetryDelayMs: 200 } });
    const { listener } = await watched(store);
    await vi.waitFor(async () => expect(await listenBackends()).toBe(1), WAIT);

    await harness.terminate("listen");
    await vi.waitFor(() => expect(harness.logs.some((entry) => /connection lost/.test(entry.message))).toBe(true), WAIT);
    await vi.waitFor(async () => expect(await listenBackends()).toBe(1), WAIT);
    await harness.store.journal.operations.create(operation({ id: "after-reconnect" }));

    await vi.waitFor(
      () => expect(changesOf(listener)).toContainEqual(expect.objectContaining({ type: "added", key: "after-reconnect" })),
      WAIT,
    );
  });

  it("resyncs with cursor-expired and a fresh snapshot when the change log is purged past its cursor", async () => {
    await harness.store.journal.operations.create(operation({ id: "before" }));
    const held = gate();
    const listener = recordingListener<"operations">(async (_event, index) => {
      if (index === 0) await held.opened;
    });
    harness.store.watch(PENDING, listener);
    await vi.waitFor(() => expect(listener.events).toHaveLength(1), WAIT);

    await harness.store.journal.operations.create(operation({ id: "during-gap" }));
    await purgeEntireChangeLog();
    held.open();

    await vi.waitFor(() => expect(listener.events).toHaveLength(3), WAIT);
    expect(kinds(listener)).toEqual(["snapshot", "resync:cursor-expired", "snapshot"]);
    expect(snapshotIds(listener.events[2])).toEqual(["before", "during-gap"]);
    expect(changesOf(listener)).toEqual([]);
  });

  it("resumes from a live cursor with a snapshot and no resync", async () => {
    const first = await watched();
    const cursor = cursorOf(first.listener.events[0]);
    await first.subscription.close();

    const { listener } = await watched(harness.store, { ...PENDING, resumeFrom: cursor });

    expect(kinds(listener)).toEqual(["snapshot"]);
  });

  it("resumes from a purged cursor with cursor-expired and a fresh snapshot", async () => {
    const first = await watched();
    const cursor = cursorOf(first.listener.events[0]);
    await first.subscription.close();
    await harness.store.journal.operations.create(operation({ id: "missed" }));
    await purgeEntireChangeLog();

    const listener = recordingListener<"operations">();
    harness.store.watch({ ...PENDING, resumeFrom: cursor }, listener);

    await vi.waitFor(() => expect(listener.events).toHaveLength(2), WAIT);
    expect(kinds(listener)).toEqual(["resync:cursor-expired", "snapshot"]);
    expect(snapshotIds(listener.events[1])).toEqual(["missed"]);
  });

  it.each([
    ["a cursor ahead of the database", "backend-restart", "999999999999"],
    ["a numeric cursor beyond the xid8 range", "cursor-expired", "99999999999999999999"],
    ["a cursor it did not issue", "cursor-expired", "not-a-cursor"],
  ])("resumes from %s with a %s resync and a fresh snapshot", async (_case, reason, resumeFrom) => {
    const listener = recordingListener<"operations">();
    harness.store.watch({ ...PENDING, resumeFrom: resumeFrom as WatchCursor }, listener);

    await vi.waitFor(() => expect(listener.events).toHaveLength(2), WAIT);
    expect(kinds(listener)).toEqual([`resync:${reason}`, "snapshot"]);
  });

  it("reports a backend failure, then resyncs with backend-restart once it recovers", async () => {
    const { listener } = await watched();

    await harness.query("ALTER TABLE $schema.change_log RENAME TO change_log_offline");
    await vi.waitFor(() => expect(listener.errors.length).toBeGreaterThan(0), WAIT);
    await harness.query("ALTER TABLE $schema.change_log_offline RENAME TO change_log");

    expect(listener.errors[0]).toBeInstanceOf(BackendFailureError);
    expect(listener.errors[0]).toMatchObject({ backend: "postgresql", operation: "watch operations" });
    await vi.waitFor(() => expect(kinds(listener).slice(1, 3)).toEqual(["resync:backend-restart", "snapshot"]), WAIT);
    await harness.store.journal.operations.create(operation({ id: "recovered" }));
    await vi.waitFor(() => expect(changesOf(listener)).toContainEqual(expect.objectContaining({ type: "added", key: "recovered" })), WAIT);
  });

  it("stops and rejects closed with the listener's error when the listener throws", async () => {
    const failure = new Error("listener broke");
    const subscription = harness.store.watch(PENDING, {
      onEvent() {
        throw failure;
      },
      onError() {},
    });

    await expect(subscription.closed).rejects.toBe(failure);
  });

  it("delivers nothing after close and resolves closed", async () => {
    const { listener, subscription } = await watched();

    await subscription.close();
    await harness.store.journal.operations.create(operation({ id: "after-close" }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    await expect(subscription.closed).resolves.toBeUndefined();
    expect(listener.events).toHaveLength(1);
  });

  it("closes its watches and its notification connection when the store closes", async () => {
    const store = harness.openStore();
    const { subscription } = await watched(store);
    await vi.waitFor(async () => expect(await listenBackends()).toBe(1), WAIT);

    await store.close();

    await expect(subscription.closed).resolves.toBeUndefined();
    await vi.waitFor(async () => expect(await listenBackends()).toBe(0), WAIT);
  });
});
