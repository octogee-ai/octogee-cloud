import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeaseLostError } from "../hosts/credential-store.js";
import { createHarness, dsn, spec, type Harness } from "../__tests__/harness.js";
import { MAX_TRANSIENT_ATTEMPTS, WorkQueue, backoffMs, type FinishInput } from "./queue.js";

const FAILED: FinishInput["outcome"] = { kind: "failed", errorKind: "transient", reason: "ChatUserFailed", message: "503 from chat host" };

describe("backoff", () => {
  it("doubles from 5 s, caps at 10 min and jitters within 20 %", () => {
    expect([1, 2, 3, 4].map((attempts) => backoffMs(attempts, () => 0.5))).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(backoffMs(12, () => 0.5)).toBe(600_000);
    expect(backoffMs(1, () => 0)).toBe(4_000);
    expect(backoffMs(1, () => 1)).toBe(6_000);
  });
});

describe.skipIf(!dsn)("the work queue", { timeout: 30_000 }, () => {
  let harness: Harness;
  let queue: WorkQueue;

  beforeEach(async () => {
    harness = await createHarness({ queue: { leaseMs: 1_000 } });
    queue = harness.service.queue;
  });

  afterEach(async () => {
    await harness.dispose();
  });

  const work = async (uid: string) => (await harness.service.db.pool.query(
    `SELECT state, attempts, dirty, EXTRACT(EPOCH FROM due_at - now())::float AS due_in FROM ${harness.service.db.table("provisioning_work")} WHERE uid = $1`, [uid])).rows[0];

  const finish = (uid: string, token: string, outcome: FinishInput["outcome"]) => queue.finish(uid, token, {
    generation: 1, conditions: [], outcome,
    attempt: { generation: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: [] },
  });

  async function put(uid: string, slug = uid) {
    return harness.request("PUT", `/v1/users/${uid}/provisioning`, { body: { spec: spec(slug) } });
  }

  it("coalesces several spec writes into one claim, and two replicas never claim the same user", async () => {
    await put("u1", "a");
    await put("u1", "b");
    await put("u2");
    const other = new WorkQueue(harness.service.db, { holder: "replica-2" });
    const [first, second] = await Promise.all([queue.claim(10), other.claim(10)]);
    const uids = [...first, ...second].map((claim) => claim.uid).sort();
    expect(uids).toEqual(["u1", "u2"]);
    expect(await queue.claim(10)).toEqual([]);
  });

  it("lets another replica take over an expired lease with one more attempt, and fences the old holder out", async () => {
    await put("u1");
    const [stale] = await queue.claim(1);
    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET lease_expires_at = now() - interval '1 second'`);
    const [taken] = await new WorkQueue(harness.service.db, { holder: "replica-2" }).claim(1);
    expect(taken).toMatchObject({ uid: "u1", takeover: true });
    expect((await work("u1")).attempts).toBe(1);

    expect(await queue.heartbeat("u1", stale.leaseToken)).toBe(false);
    await expect(finish("u1", stale.leaseToken, { kind: "succeeded" })).rejects.toBeInstanceOf(LeaseLostError);
    await expect(harness.service.credentials.write("u1", "user-chat-token", "value", stale.leaseToken)).rejects.toBeInstanceOf(LeaseLostError);
    expect(await queue.heartbeat("u1", taken.leaseToken)).toBe(true);
  });

  it("schedules a transient failure with backoff and parks after the twelfth", async () => {
    await put("u1");
    for (let attempt = 1; attempt < MAX_TRANSIENT_ATTEMPTS; attempt += 1) {
      await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET due_at = now()`);
      const [claim] = await queue.claim(1);
      expect(await finish("u1", claim.leaseToken, FAILED)).toEqual({ state: "retrying", attempts: attempt });
    }
    const row = await work("u1");
    expect(row.due_in).toBeGreaterThan(400);
    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET due_at = now()`);
    const [last] = await queue.claim(1);
    expect(await finish("u1", last.leaseToken, FAILED)).toEqual({ state: "parked", attempts: MAX_TRANSIENT_ATTEMPTS });
    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET due_at = now() - interval '1 day'`);
    expect(await queue.claim(1)).toEqual([]);
  });

  it("parks a terminal failure at once and a spec change makes it due again", async () => {
    await put("u1", "a");
    const [claim] = await queue.claim(1);
    expect(await finish("u1", claim.leaseToken, { ...FAILED, errorKind: "terminal" })).toEqual({ state: "parked", attempts: 1 });
    await put("u1", "b");
    expect(await work("u1")).toMatchObject({ state: "queued", attempts: 0 });
    expect(await queue.claim(1)).toHaveLength(1);
  });

  it("requeues work at once when the spec changed while an attempt was running", async () => {
    await put("u1", "a");
    const [claim] = await queue.claim(1);
    expect((await put("u1", "b")).status).toBe(202);
    expect(await work("u1")).toMatchObject({ state: "running", dirty: true });
    expect(await queue.claim(1)).toEqual([]);
    expect(await finish("u1", claim.leaseToken, { kind: "succeeded" })).toEqual({ state: "queued", attempts: 0 });
    expect(await queue.claim(1)).toHaveLength(1);
  });

  it("makes a successful user idle and due for resync six hours later", async () => {
    await put("u1");
    const [claim] = await queue.claim(1);
    expect(await finish("u1", claim.leaseToken, { kind: "succeeded" })).toEqual({ state: "idle", attempts: 0 });
    const row = await work("u1");
    expect(row.due_in).toBeGreaterThan(6 * 3600 - 60);
    expect(await queue.claim(1)).toEqual([]);
    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET due_at = now()`);
    expect(await queue.claim(1)).toHaveLength(1);
  });

  it("stops an attempt whose lease is taken over mid-flight and records it as lease-lost", async () => {
    const slow = await createHarness({ queue: { leaseMs: 300 }, heartbeatMs: 10_000 });
    try {
      slow.chat.host.setDelay(150);
      await slow.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      await slow.service.worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const [taken] = await new WorkQueue(slow.service.db, { holder: "replica-2" }).claim(1);
      expect(taken).toMatchObject({ uid: "u1", takeover: true });
      await slow.service.worker.drain();
      const events = (await slow.request("GET", "/v1/users/u1/provisioning/events")).body.items;
      expect(events[0]).toMatchObject({ result: "lease-lost" });
      expect(slow.log.lines.some((line) => line.level === "error" && line.message === "provisioning lease lost; attempt stopped")).toBe(true);
    } finally {
      await slow.dispose();
    }
  });
});
