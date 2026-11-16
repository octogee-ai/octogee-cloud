import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LeaseLostError } from "../hosts/credential-store.js";
import { createHarness, dsn, spec, TOKENS, type Harness } from "../__tests__/harness.js";
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
    const other = new WorkQueue(harness.service.db, { holder: "replica-2", log: harness.log });
    const [first, second] = await Promise.all([queue.claim(10), other.claim(10)]);
    const uids = [...first, ...second].map((claim) => claim.uid).sort();
    expect(uids).toEqual(["u1", "u2"]);
    expect(await queue.claim(10)).toEqual([]);
  });

  it("lets another replica take over an expired lease with one more attempt, and fences the old holder out", async () => {
    await put("u1");
    const [stale] = await queue.claim(1);
    await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("provisioning_work")} SET lease_expires_at = now() - interval '1 second'`);
    const [taken] = await new WorkQueue(harness.service.db, { holder: "replica-2", log: harness.log }).claim(1);
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

  it("parks work at claim time instead of running it again when an expired lease would bring attempts to the maximum", async () => {
    await put("u1");
    await queue.claim(1);
    await harness.service.db.pool.query(
      `UPDATE ${harness.service.db.table("provisioning_work")} SET lease_expires_at = now() - interval '1 second', attempts = $1`, [MAX_TRANSIENT_ATTEMPTS - 1]);
    expect(await queue.claim(1)).toEqual([]);
    expect(await work("u1")).toMatchObject({ state: "parked", attempts: MAX_TRANSIENT_ATTEMPTS });
    const events = await harness.request("GET", "/v1/users/u1/provisioning/events");
    expect(events.body.items[0]).toMatchObject({ result: "parked", steps: [] });
    expect(harness.log.lines.some((line) => line.level === "error" && line.message === "provisioning work parked at claim after repeated unfinished attempts")).toBe(true);
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

  it("leaves parked work parked with its attempts when a git key is written or released, and makes retrying work due without resetting attempts", async () => {
    const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA gateway-a";
    await put("u1");
    const [parked] = await queue.claim(1);
    await finish("u1", parked.leaseToken, { ...FAILED, errorKind: "terminal" });
    expect((await harness.request("PUT", "/v1/users/u1/git-keys/gw-1%2Fpod-s", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY } } })).status).toBe(201);
    expect(await work("u1")).toMatchObject({ state: "parked", attempts: 1 });
    expect((await harness.request("DELETE", "/v1/users/u1/git-keys/gw-1%2Fpod-s", { token: TOKENS.platformApi })).status).toBe(202);
    expect(await work("u1")).toMatchObject({ state: "parked", attempts: 1 });
    const [release] = await queue.claim(1);
    expect(release).toMatchObject({ uid: "u1", releaseOnly: true, takeover: false });
    expect(await work("u1")).toMatchObject({ state: "running", attempts: 1 });
    expect(await queue.finishRelease("u1", release.leaseToken)).toEqual({ state: "parked", attempts: 1 });

    await put("u2");
    const [retrying] = await queue.claim(1);
    await finish("u2", retrying.leaseToken, FAILED);
    expect((await harness.request("PUT", "/v1/users/u2/git-keys/gw-1%2Fpod-s", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY } } })).status).toBe(201);
    const row = await work("u2");
    expect(row).toMatchObject({ state: "queued", attempts: 1 });
    expect(row.due_in).toBeLessThanOrEqual(0);
  });

  it("queues parked work after its release pass when an operator retried it during the pass", async () => {
    const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA gateway-a";
    await put("u1");
    await harness.request("PUT", "/v1/users/u1/git-keys/gw-1%2Fpod-s", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY } } });
    const [parked] = await queue.claim(1);
    await finish("u1", parked.leaseToken, { ...FAILED, errorKind: "terminal" });
    await harness.request("DELETE", "/v1/users/u1/git-keys/gw-1%2Fpod-s", { token: TOKENS.platformApi });
    const [release] = await queue.claim(1);
    expect(release.releaseOnly).toBe(true);

    expect((await harness.request("POST", "/v1/users/u1/provisioning/retry", { body: {} })).status).toBe(202);
    expect(await queue.finishRelease("u1", release.leaseToken)).toEqual({ state: "queued", attempts: 0 });
    expect(await queue.claim(1)).toEqual([expect.objectContaining({ uid: "u1", releaseOnly: false })]);
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

  it("stops an attempt locally once its lease runs out without a confirmed heartbeat, and starts no further host call", async () => {
    const slow = await createHarness({ queue: { leaseMs: 400 }, heartbeatMs: 50 });
    try {
      slow.service.queue.heartbeat = async () => { throw new Error("connection terminated"); };
      slow.chat.host.setDelay(150);
      await slow.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      await slow.service.worker.tick();
      await slow.service.worker.drain();
      const callsAtEnd = slow.chat.host.calls.length;
      expect(callsAtEnd).toBeLessThan(6);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(slow.chat.host.calls).toHaveLength(callsAtEnd);
      const events = (await slow.request("GET", "/v1/users/u1/provisioning/events")).body.items;
      expect(events[0]).toMatchObject({ result: "lease-lost" });
      expect(slow.log.lines.some((line) => line.level === "error" && line.message === "provisioning lease ran out without a confirmed heartbeat; attempt stopped")).toBe(true);
    } finally {
      await slow.dispose();
    }
  });

  it("stops an attempt whose lease is taken over mid-flight and records it as lease-lost", async () => {
    const slow = await createHarness({ queue: { leaseMs: 300 }, heartbeatMs: 10_000 });
    try {
      slow.chat.host.setDelay(150);
      await slow.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      await slow.service.worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const [taken] = await new WorkQueue(slow.service.db, { holder: "replica-2", log: slow.log }).claim(1);
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
