import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audit, createHarness, dsn, operation, type PlatformStateHarness } from "./fixtures/harness.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WAIT = { timeout: 20_000, interval: 20 };

describe.skipIf(!dsn)("PostgreSQL platform state expiry sweep", { timeout: 30_000 }, () => {
  let harness: PlatformStateHarness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function remaining(table: string, key: string): Promise<string[]> {
    const rows = await harness.query(`SELECT ${key} AS key FROM $schema.${table} ORDER BY ${key}`);
    return rows.map((row) => row.key as string);
  }

  async function changeLogCount(): Promise<number> {
    const [row] = await harness.query("SELECT count(*)::int AS count FROM $schema.change_log");
    return row.count as number;
  }

  it("deletes expired operations, earliest expiry first, up to the limit", async () => {
    await harness.store.journal.operations.create(operation({ id: "expired-late", expireAt: 200 }));
    await harness.store.journal.operations.create(operation({ id: "expired-early", expireAt: 100 }));
    await harness.store.journal.operations.create(operation({ id: "not-yet", expireAt: 300 }));
    await harness.store.journal.operations.create(operation({ id: "forever" }));

    expect(await harness.store.sweepExpired(250, 1)).toEqual({ operations: 1, operationAudits: 0, accessGrants: 0, modelBrokerUsageEvents: 0, subscriptionFlows: 0, connectFlows: 0 });
    expect(await remaining("operations", "id")).toEqual(["expired-late", "forever", "not-yet"]);

    expect(await harness.store.sweepExpired(250, 10)).toEqual({ operations: 1, operationAudits: 0, accessGrants: 0, modelBrokerUsageEvents: 0, subscriptionFlows: 0, connectFlows: 0 });
    expect(await remaining("operations", "id")).toEqual(["forever", "not-yet"]);
  });

  it("deletes expired operation audits", async () => {
    const expired = audit({ expireAt: 100 });
    const kept = audit({ expireAt: 900 });
    await harness.store.journal.audits.create(expired);
    await harness.store.journal.audits.create(kept);

    expect(await harness.store.sweepExpired(500, 10)).toEqual({ operations: 0, operationAudits: 1, accessGrants: 0, modelBrokerUsageEvents: 0, subscriptionFlows: 0, connectFlows: 0 });
    expect(await harness.store.journal.audits.get(expired.id)).toBeNull();
    expect(await harness.store.journal.audits.get(kept.id)).not.toBeNull();
  });

  it("deletes expired access grants across the ticket and session tables under one shared limit", async () => {
    await harness.query(
      `INSERT INTO $schema.gateway_tickets (ticket_id, uid, gateway_id, expires_at, access_grant)
       VALUES ('t-expired', 'uid-1', 'g1', 100, '{}'), ('t-live', 'uid-1', 'g1', 900, '{}')`,
    );
    await harness.query(
      `INSERT INTO $schema.control_tickets (ticket_hash, gateway_id, uid, created_at, expires_at, access_grant)
       VALUES ('c-expired-1', 'g1', 'uid-1', 1, 100, '{}'), ('c-expired-2', 'g1', 'uid-1', 1, 110, '{}')`,
    );
    await harness.query(
      `INSERT INTO $schema.control_sessions (session_hash, gateway_id, uid, expires_at, access_grant)
       VALUES ('s-expired', 'g1', 'uid-1', 100, '{}')`,
    );

    expect(await harness.store.sweepExpired(500, 2)).toEqual({ operations: 0, operationAudits: 0, accessGrants: 2, modelBrokerUsageEvents: 0, subscriptionFlows: 0, connectFlows: 0 });
    expect(await remaining("gateway_tickets", "ticket_id")).toEqual(["t-live"]);
    expect(await remaining("control_tickets", "ticket_hash")).toEqual(["c-expired-2"]);
    expect(await remaining("control_sessions", "session_hash")).toEqual(["s-expired"]);

    expect(await harness.store.sweepExpired(500, 2)).toEqual({ operations: 0, operationAudits: 0, accessGrants: 2, modelBrokerUsageEvents: 0, subscriptionFlows: 0, connectFlows: 0 });
    expect(await remaining("control_tickets", "ticket_hash")).toEqual([]);
    expect(await remaining("control_sessions", "session_hash")).toEqual([]);
  });

  it("deletes expired model broker usage events up to the limit", async () => {
    await harness.query(
      `INSERT INTO $schema.model_broker_usage_events (event_id, owner_key, created_at, expires_at, event)
       VALUES ('e-expired-1', 'shared-1:uid-1', 1, 100, '{}'), ('e-expired-2', 'shared-1:uid-1', 1, 110, '{}'),
              ('e-live', 'shared-1:uid-1', 1, 900, '{}')`,
    );

    expect(await harness.store.sweepExpired(500, 1)).toEqual({ operations: 0, operationAudits: 0, accessGrants: 0, modelBrokerUsageEvents: 1, subscriptionFlows: 0, connectFlows: 0 });
    expect(await remaining("model_broker_usage_events", "event_id")).toEqual(["e-expired-2", "e-live"]);
  });

  it("purges change log entries older than a day and records the purge watermark", async () => {
    await harness.store.journal.operations.create(operation());
    await harness.store.journal.operations.create(operation());
    const [logged] = await harness.query("SELECT count(*)::int AS count, max(txid)::text AS latest FROM $schema.change_log");
    expect(logged.count).toBe(2);

    await harness.store.sweepExpired(Date.now(), 10);
    expect(await changeLogCount()).toBe(2);
    expect(await harness.query("SELECT purged_through FROM $schema.change_log_retention")).toEqual([]);

    await vi.waitFor(async () => {
      await harness.store.sweepExpired(Date.now() + 2 * DAY_MS, 10);
      expect(await changeLogCount()).toBe(0);
    }, WAIT);
    const [watermark] = await harness.query("SELECT purged_through::text AS purged_through FROM $schema.change_log_retention");
    expect(watermark.purged_through).toBe(logged.latest);

    await harness.store.sweepExpired(Date.now() + 2 * DAY_MS, 10);
    const [unchanged] = await harness.query("SELECT purged_through::text AS purged_through FROM $schema.change_log_retention");
    expect(unchanged.purged_through).toBe(logged.latest);
  });

  it("keeps change log entries that a transaction still open could precede", async () => {
    const holder = await harness.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_current_xact_id()");
      await harness.store.journal.operations.create(operation());

      await harness.store.sweepExpired(Date.now() + 2 * DAY_MS, 10);

      expect(await changeLogCount()).toBe(1);
      expect(await harness.query("SELECT purged_through FROM $schema.change_log_retention")).toEqual([]);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    await vi.waitFor(async () => {
      await harness.store.sweepExpired(Date.now() + 2 * DAY_MS, 10);
      expect(await changeLogCount()).toBe(0);
    }, WAIT);
  });
});
