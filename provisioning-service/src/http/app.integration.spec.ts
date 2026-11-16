import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CALLERS, createHarness, dsn, ROLE_TABLE, spec, TOKENS, untilSettled, type Harness } from "../__tests__/harness.js";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA gateway-a";

describe.skipIf(!dsn)("the provisioning HTTP API", { timeout: 30_000 }, () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  describe("authentication and roles", () => {
    it("answers 401 without a token or with a token the review rejects, and 403 for an unknown or foreign service account", async () => {
      expect((await harness.request("GET", "/v1/provisionings", { token: null })).body).toEqual({ code: "unauthenticated", error: expect.any(String) });
      expect((await harness.request("GET", "/v1/provisionings", { token: TOKENS.invalid })).status).toBe(401);
      expect((await harness.request("GET", "/v1/provisionings", { token: TOKENS.stranger })).body.code).toBe("forbidden");
      expect((await harness.request("GET", "/v1/provisionings", { token: TOKENS.otherNamespace })).status).toBe(403);
    });

    it("limits the platform API to git keys, reads and credentials, and the fleet controller to provisioning and credentials", async () => {
      const body = { spec: spec("lin") };
      expect((await harness.request("PUT", "/v1/users/u1/provisioning", { token: TOKENS.platformApi, body })).status).toBe(403);
      expect((await harness.request("PUT", "/v1/users/u1/provisioning", { body })).status).toBe(201);
      expect((await harness.request("GET", "/v1/users/u1/provisioning", { token: TOKENS.platformApi })).status).toBe(200);
      expect((await harness.request("POST", "/v1/users/u1/provisioning/retry", { token: TOKENS.platformApi, body: {} })).status).toBe(403);
      expect((await harness.request("DELETE", "/v1/users/u1/provisioning", { token: TOKENS.platformApi })).status).toBe(403);
      expect((await harness.request("PUT", "/v1/users/u1/git-keys/gw-1", { body: { spec: { publicKey: KEY } } })).status).toBe(403);
      expect((await harness.request("PUT", "/v1/users/u1/git-keys/gw-1", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY } } })).status).toBe(201);
      expect((await harness.request("GET", "/v1/users/u1/credentials/user-chat-token")).body.code).toBe("not-issued");
      expect((await harness.request("GET", "/v1/users/u1/credentials/user-chat-token", { token: TOKENS.platformApi })).body.code).toBe("not-issued");
    });

    it("refuses credentials to a caller holding only key-writer or only reader", async () => {
      const scoped = await createHarness({ roleTable: { ...ROLE_TABLE, "key-writer-only": ["key-writer"], "reader-only": ["reader"] } });
      try {
        expect((await scoped.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } })).status).toBe(201);
        expect((await scoped.request("GET", "/v1/users/u1/credentials/user-chat-token", { token: TOKENS.keyWriterOnly })).body.code).toBe("forbidden");
        expect((await scoped.request("GET", "/v1/users/u1/credentials/user-chat-token", { token: TOKENS.readerOnly })).body.code).toBe("forbidden");
        expect((await scoped.request("GET", "/v1/users/u1/provisioning", { token: TOKENS.readerOnly })).status).toBe(200);
      } finally {
        await scoped.dispose();
      }
    });

    it("answers 403 to a service account whose name is an object property, such as constructor", async () => {
      expect((await harness.request("GET", "/v1/provisionings", { token: TOKENS.constructorName })).body.code).toBe("forbidden");
    });

    it("answers 429 rate-limited with Retry-After once one caller exceeds its requests per minute, while other callers and probes go on", async () => {
      const limited = await createHarness({ limits: { requestsPerMinute: 2 } });
      try {
        expect((await limited.request("GET", "/v1/provisionings")).status).toBe(200);
        expect((await limited.request("GET", "/v1/provisionings")).status).toBe(200);
        const refused = await limited.request("GET", "/v1/provisionings");
        expect(refused).toMatchObject({ status: 429, body: { code: "rate-limited", error: expect.any(String) } });
        expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
        expect((await limited.request("GET", "/v1/provisionings")).status).toBe(429);
        expect((await limited.request("GET", "/v1/provisionings", { token: TOKENS.platformApi })).status).toBe(200);
        for (const path of ["/healthz", "/readyz", "/metrics", "/readyz"]) {
          expect((await fetch(`${limited.service.url}${path}`)).status).toBe(200);
        }
        const warnings = limited.log.lines.filter((line) => line.message === "caller exceeded its request limit");
        expect(warnings).toEqual([expect.objectContaining({ level: "warn", fields: expect.objectContaining({ serviceAccount: CALLERS.fleetController }) })]);
      } finally {
        await limited.dispose();
      }
    });

    it("writes nothing for a request refused by the rate limit", async () => {
      const limited = await createHarness({ limits: { requestsPerMinute: 1 } });
      try {
        expect((await limited.request("GET", "/v1/provisionings")).status).toBe(200);
        expect((await limited.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } })).status).toBe(429);
        expect((await limited.request("GET", "/v1/users/u1/provisioning", { token: TOKENS.platformApi })).status).toBe(404);
      } finally {
        await limited.dispose();
      }
    });

    it("bounds each caller's held waits and watches, and frees the slot when the held request ends", async () => {
      const limited = await createHarness({ limits: { concurrentWaits: 1 } });
      const held = new AbortController();
      try {
        expect((await limited.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } })).status).toBe(201);
        const holding = fetch(`${limited.service.url}/v1/users/u1/provisioning?waitForGeneration=1&timeoutSeconds=30`, {
          headers: { authorization: `Bearer ${TOKENS.writer}` }, signal: held.signal,
        }).catch((error: unknown) => error);
        let second = await limited.request("GET", "/v1/provisionings?watch=true&resourceVersion=0&timeoutSeconds=0");
        for (let tries = 0; second.status !== 429 && tries < 50; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          second = await limited.request("GET", "/v1/provisionings?watch=true&resourceVersion=0&timeoutSeconds=0");
        }
        expect(second).toMatchObject({ status: 429, body: { code: "rate-limited" } });
        expect(second.headers.get("retry-after")).toBe("1");
        expect((await limited.request("GET", "/v1/users/u1/provisioning")).status).toBe(200);
        expect((await limited.request("GET", "/v1/users/u1/provisioning?waitForGeneration=1&timeoutSeconds=0", { token: TOKENS.platformApi })).status).toBe(200);
        held.abort();
        await holding;
        let freed = await limited.request("GET", "/v1/users/u1/provisioning?waitForGeneration=1&timeoutSeconds=0");
        for (let tries = 0; freed.status !== 200 && tries < 50; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          freed = await limited.request("GET", "/v1/users/u1/provisioning?waitForGeneration=1&timeoutSeconds=0");
        }
        expect(freed.status).toBe(200);
      } finally {
        held.abort();
        await limited.dispose();
      }
    });

    it("answers 503 with Retry-After when the token review cannot be reached", async () => {
      const failing = await createHarness({ reviewer: async () => { throw new Error("connect ECONNREFUSED"); } });
      try {
        const response = await failing.request("GET", "/v1/provisionings");
        expect(response).toMatchObject({ status: 503, body: { code: "unavailable" } });
        expect(response.headers.get("retry-after")).toBe("5");
        expect(failing.log.lines.some((line) => line.level === "error" && line.message === "token review failed")).toBe(true);
      } finally {
        await failing.dispose();
      }
    });

    it("serves health, readiness and metrics without a token", async () => {
      expect((await harness.request("GET", "/healthz", { token: null })).status).toBe(200);
      expect((await harness.request("GET", "/readyz", { token: null })).status).toBe(200);
      const metrics = await fetch(`${harness.service.url}/metrics`);
      const text = await metrics.text();
      expect(text).toContain('provisioning_work{state="queued"} 0');
      expect(text).toContain("provisioning_generation_lag_seconds");
    });

    it("answers readiness and metrics from the last background check, which reports a failed database check as not ready", async () => {
      await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      await harness.service.probes.refresh();
      expect(await (await fetch(`${harness.service.url}/metrics`)).text()).toContain('provisioning_work{state="queued"} 1');
      const query = harness.service.db.pool.query.bind(harness.service.db.pool);
      harness.service.db.pool.query = (async () => { throw new Error("connection refused"); }) as unknown as typeof harness.service.db.pool.query;
      try {
        await harness.service.probes.refresh();
        expect((await fetch(`${harness.service.url}/readyz`)).status).toBe(503);
        expect(harness.log.lines.some((line) => line.level === "error" && line.message === "readiness check failed")).toBe(true);
      } finally {
        harness.service.db.pool.query = query;
      }
      await harness.service.probes.refresh();
      expect((await fetch(`${harness.service.url}/readyz`)).status).toBe(200);
    });
  });

  describe("PUT and GET provisioning", () => {
    it("creates with 201, answers an identical spec with 200 and no new generation, and a changed spec with 202", async () => {
      const created = await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ uid: "u1", generation: 1, status: { observedGeneration: 0, work: { state: "queued" } } });
      expect(created.body.status.conditions.map((condition: { reason: string }) => condition.reason)).toEqual(["Pending", "Pending", "Pending", "Pending"]);

      const same = await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: { ...spec("lin"), unknownField: true } } });
      expect(same.status).toBe(200);
      expect(same.body).toMatchObject({ generation: 1, resourceVersion: created.body.resourceVersion });

      const changed = await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin", { email: "" }) } });
      expect(changed.status).toBe(202);
      expect(changed.body.generation).toBe(2);
      expect(BigInt(changed.body.resourceVersion)).toBeGreaterThan(BigInt(created.body.resourceVersion));
    });

    it("answers 409 precondition-failed and writes nothing when expectedResourceVersion no longer holds", async () => {
      const created = await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin", { agentIds: ["main", "second"] }) } });
      const stale = await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("other"), expectedResourceVersion: created.body.resourceVersion } });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("precondition-failed");
      expect((await harness.request("GET", "/v1/users/u1/provisioning")).body.spec.slug).toBe("lin");
      expect((await harness.request("PUT", "/v1/users/u2/provisioning", { body: { spec: spec("new"), expectedResourceVersion: "1" } })).status).toBe(409);
    });

    it("rejects an invalid spec with 400 invalid-request", async () => {
      for (const bad of [spec("Not A Slug"), { ...spec("lin"), git: { repositories: ["unknown"], systemConfigRepository: false } }, { ...spec("lin"), agentIds: "main" }]) {
        const response = await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: bad } });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe("invalid-request");
      }
      expect((await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin"), expectedResourceVersion: 4 } })).status).toBe(400);
    });

    it("answers 404 for an unknown user", async () => {
      expect((await harness.request("GET", "/v1/users/nobody/provisioning")).body.code).toBe("not-found");
      expect((await harness.request("GET", "/v1/users/nobody/provisioning/events")).status).toBe(404);
    });

    it("holds a waitForGeneration read until the generation is observed", async () => {
      await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      const waiting = harness.request("GET", "/v1/users/u1/provisioning?waitForGeneration=1&timeoutSeconds=10");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await untilSettled(harness);
      const resource = (await waiting).body;
      expect(resource.status.observedGeneration).toBe(1);
      const timedOut = await harness.request("GET", "/v1/users/u1/provisioning?waitForGeneration=5&timeoutSeconds=0");
      expect(timedOut.body.status.observedGeneration).toBe(1);
    });
  });

  describe("list and watch", () => {
    it("filters and pages, with the list's resource version", async () => {
      for (const uid of ["u1", "u2", "u3"]) await harness.request("PUT", `/v1/users/${uid}/provisioning`, { body: { spec: spec(uid) } });
      harness.chat.host.failNext("ensureUser", "terminal");
      await untilSettled(harness);

      const first = await harness.request("GET", "/v1/provisionings?limit=2");
      expect(first.body.items.map((item: { uid: string }) => item.uid)).toEqual(["u1", "u2"]);
      const second = await harness.request("GET", `/v1/provisionings?limit=2&pageToken=${first.body.nextPageToken}`);
      expect(second.body.items.map((item: { uid: string }) => item.uid)).toEqual(["u3"]);
      expect(second.body.nextPageToken).toBeUndefined();

      expect((await harness.request("GET", "/v1/provisionings?ready=false")).body.items).toHaveLength(1);
      expect((await harness.request("GET", "/v1/provisionings?ready=true")).body.items).toHaveLength(2);
      expect((await harness.request("GET", "/v1/provisionings?workState=parked")).body.items).toHaveLength(1);
      expect((await harness.request("GET", "/v1/provisionings?reason=ChatUserFailed")).body.items).toHaveLength(1);
      expect((await harness.request("GET", "/v1/provisionings?reason=NotAReason")).status).toBe(400);
    });

    it("returns changes after a version at once, holds when there are none, and answers 410 for a version outside the window", async () => {
      const listed = await harness.request("GET", "/v1/provisionings");
      const from = listed.body.resourceVersion;
      const held = harness.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=10`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      const changed = (await held).body;
      expect(changed.items.map((item: { uid: string }) => item.uid)).toEqual(["u1"]);
      expect(BigInt(changed.resourceVersion)).toBeGreaterThan(BigInt(from));

      const quiet = await harness.request("GET", `/v1/provisionings?watch=true&resourceVersion=${changed.resourceVersion}&timeoutSeconds=0`);
      expect(quiet.body).toEqual({ items: [], resourceVersion: changed.resourceVersion });

      await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("version_log")} SET written_at = now() - interval '25 hours'`);
      await harness.service.store.pruneChangeLog();
      const expired = await harness.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=0`);
      expect(expired.status).toBe(410);
      expect(expired.body.code).toBe("resource-version-expired");
      expect((await harness.request("GET", "/v1/provisionings?watch=true&resourceVersion=999999&timeoutSeconds=0")).status).toBe(410);
    });

    it("pages a watch by limit, oldest change first, and continues from the returned version", async () => {
      const from = (await harness.request("GET", "/v1/provisionings")).body.resourceVersion;
      for (const uid of ["w1", "w2", "w3"]) await harness.request("PUT", `/v1/users/${uid}/provisioning`, { body: { spec: spec(uid) } });
      const first = (await harness.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=0&limit=2`)).body;
      expect(first.items.map((item: { uid: string }) => item.uid)).toEqual(["w1", "w2"]);
      expect(first.resourceVersion).toBe(first.items[1].resourceVersion);
      const rest = (await harness.request("GET", `/v1/provisionings?watch=true&resourceVersion=${first.resourceVersion}&timeoutSeconds=0&limit=2`)).body;
      expect(rest.items.map((item: { uid: string }) => item.uid)).toEqual(["w3"]);
      expect(rest.resourceVersion).toBe((await harness.request("GET", "/v1/provisionings")).body.resourceVersion);
      expect((await harness.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=0&limit=501`)).status).toBe(400);
    });

    it("reports a delete in the watch after the version it was given, and a re-create after it, in version order", async () => {
      await harness.request("PUT", "/v1/users/d1/provisioning", { body: { spec: spec("d1") } });
      const from = (await harness.request("GET", "/v1/provisionings")).body.resourceVersion;
      expect((await harness.request("DELETE", "/v1/users/d1/provisioning")).status).toBe(204);
      const deleted = (await harness.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=0`)).body;
      expect(deleted.items).toEqual([]);
      expect(deleted.deleted).toEqual([{ uid: "d1", resourceVersion: deleted.resourceVersion }]);
      expect(BigInt(deleted.resourceVersion)).toBeGreaterThan(BigInt(from));

      await harness.request("PUT", "/v1/users/d1/provisioning", { body: { spec: spec("d1") } });
      const both = (await harness.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=0`)).body;
      expect(both.deleted.map((entry: { uid: string }) => entry.uid)).toEqual(["d1"]);
      expect(both.items.map((item: { uid: string }) => item.uid)).toEqual(["d1"]);
      expect(BigInt(both.deleted[0].resourceVersion)).toBeLessThan(BigInt(both.items[0].resourceVersion));

      const firstOnly = (await harness.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=0&limit=1`)).body;
      expect(firstOnly).toEqual({ items: [], deleted: [both.deleted[0]], resourceVersion: both.deleted[0].resourceVersion });
    });

    it("wakes a held watch and answers a held waitForGeneration with 404 as soon as the user is deleted", async () => {
      await harness.request("PUT", "/v1/users/d2/provisioning", { body: { spec: spec("d2") } });
      const from = (await harness.request("GET", "/v1/provisionings")).body.resourceVersion;
      const began = Date.now();
      const waiting = harness.request("GET", "/v1/users/d2/provisioning?waitForGeneration=1&timeoutSeconds=30");
      const watching = harness.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=30`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await harness.request("DELETE", "/v1/users/d2/provisioning");
      const [waited, watched] = await Promise.all([waiting, watching]);
      expect(Date.now() - began).toBeLessThan(1_500);
      expect(waited).toMatchObject({ status: 404, body: { code: "not-found" } });
      expect(watched.body.deleted.map((entry: { uid: string }) => entry.uid)).toEqual(["d2"]);
    });

    it("prunes deletion markers with the change log, and answers 410 for a version before the retained window", async () => {
      await harness.request("PUT", "/v1/users/d3/provisioning", { body: { spec: spec("d3") } });
      const from = (await harness.request("GET", "/v1/provisionings")).body.resourceVersion;
      await harness.request("DELETE", "/v1/users/d3/provisioning");
      await harness.service.db.pool.query(`UPDATE ${harness.service.db.table("version_log")} SET written_at = now() - interval '25 hours'`);
      await harness.service.store.pruneChangeLog();
      expect((await harness.service.db.pool.query(`SELECT count(*)::int AS count FROM ${harness.service.db.table("deletions")}`)).rows[0].count).toBe(0);
      expect((await harness.request("GET", `/v1/provisionings?watch=true&resourceVersion=${from}&timeoutSeconds=0`)).status).toBe(410);
    });

    it("assigns versions in commit order with no gap under concurrent writes", async () => {
      const from = (await harness.request("GET", "/v1/provisionings")).body.resourceVersion;
      await Promise.all(Array.from({ length: 40 }, (_, index) =>
        harness.request("PUT", `/v1/users/c${index}/provisioning`, { body: { spec: spec(`c${index}`) } })));
      const { rows } = await harness.service.db.pool.query<{ version: string }>(`SELECT version FROM ${harness.service.db.table("version_log")} WHERE version > $1 ORDER BY version`, [from]);
      const versions = rows.map((row) => Number(row.version));
      expect(versions).toEqual(Array.from({ length: 40 }, (_, index) => Number(from) + index + 1));
    });
  });

  describe("retry, delete, events and credentials", () => {
    it("retries parked work, checks expectedAttempts, refuses idle work, and replays an Idempotency-Key", async () => {
      harness.chat.host.failNext("ensureUser", "terminal");
      await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      await untilSettled(harness);

      expect((await harness.request("POST", "/v1/users/u1/provisioning/retry", { body: { expectedAttempts: 7 } })).body.code).toBe("precondition-failed");
      const first = await harness.request("POST", "/v1/users/u1/provisioning/retry", { body: { expectedAttempts: 1 }, headers: { "idempotency-key": "k1" } });
      expect(first.status).toBe(202);
      expect(first.body.status.work.state).toBe("queued");
      const replay = await harness.request("POST", "/v1/users/u1/provisioning/retry", { body: { expectedAttempts: 1 }, headers: { "idempotency-key": "k1" } });
      expect(replay).toMatchObject({ status: 202, body: first.body });
      expect((await harness.request("POST", "/v1/users/u1/provisioning/retry", { body: { expectedAttempts: 2 }, headers: { "idempotency-key": "k1" } })).body.code).toBe("idempotency-conflict");

      await untilSettled(harness);
      expect((await harness.request("POST", "/v1/users/u1/provisioning/retry", { body: {} })).body.code).toBe("not-retryable");
      expect((await harness.request("POST", "/v1/users/nobody/provisioning/retry", { body: {} })).status).toBe(404);
    });

    it("refuses delete while an attempt runs, then deletes with 204 and is idempotent", async () => {
      await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      const [claim] = await harness.service.queue.claim(1);
      expect((await harness.request("DELETE", "/v1/users/u1/provisioning")).body.code).toBe("work-running");
      await harness.service.queue.finish("u1", claim.leaseToken, { generation: 1, conditions: [], outcome: { kind: "succeeded" }, attempt: { generation: 1, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: [] } });
      expect((await harness.request("DELETE", "/v1/users/u1/provisioning")).status).toBe(204);
      expect((await harness.request("DELETE", "/v1/users/u1/provisioning")).status).toBe(204);
      expect((await harness.request("GET", "/v1/users/u1/provisioning")).status).toBe(404);
      expect(harness.chat.users.size).toBe(0);
    });

    it("answers git key writes for an unknown user with 404 and a release of an unknown key with 202", async () => {
      expect((await harness.request("PUT", "/v1/users/nobody/git-keys/gw-1", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY } } })).status).toBe(404);
      expect((await harness.request("PUT", "/v1/users/nobody/git-keys/gw-1", { token: TOKENS.platformApi, body: { spec: { publicKey: "not a key" } } })).status).toBe(400);
      expect((await harness.request("DELETE", "/v1/users/nobody/git-keys/gw-1", { token: TOKENS.platformApi })).status).toBe(202);
    });

    it("releases a git key only while it still holds the expected public key", async () => {
      const newer = KEY.replace("gateway-a", "gateway-b").replace("IAAAA", "IBBBB");
      await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      await harness.request("PUT", "/v1/users/u1/git-keys/gw-1", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY } } });
      await harness.request("PUT", "/v1/users/u1/git-keys/gw-1", { token: TOKENS.platformApi, body: { spec: { publicKey: newer } } });

      const stale = await harness.request("DELETE", "/v1/users/u1/git-keys/gw-1", { token: TOKENS.platformApi, body: { expectedPublicKey: KEY } });

      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("precondition-failed");
      const kept = await harness.request("PUT", "/v1/users/u1/git-keys/gw-1", { token: TOKENS.platformApi, body: { spec: { publicKey: newer } } });
      expect(kept.status).toBe(200);
      expect(kept.body.deletionRequestedAt).toBeNull();
      expect((await harness.request("DELETE", "/v1/users/u1/git-keys/gw-1", { token: TOKENS.platformApi, body: { expectedPublicKey: newer } })).status).toBe(202);
      expect((await harness.request("DELETE", "/v1/users/u1/git-keys/gw-1", { token: TOKENS.platformApi, body: { expectedPublicKey: "not a key" } })).status).toBe(400);
    });

    it("releases a git key by its key material, whatever comment the release carries", async () => {
      await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      await harness.request("PUT", "/v1/users/u1/git-keys/gw-1", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY } } });

      const released = await harness.request("DELETE", "/v1/users/u1/git-keys/gw-1", { token: TOKENS.platformApi, body: { expectedPublicKey: KEY.replace("gateway-a", "renamed-on-the-pod") } });

      expect(released.status).toBe(202);
      const reRegistered = await harness.request("PUT", "/v1/users/u1/git-keys/gw-1", { token: TOKENS.platformApi, body: { spec: { publicKey: KEY } } });
      expect(reRegistered.status).toBe(202);
      expect(reRegistered.body.generation).toBe(2);
    });

    it("answers credentials with 404 for an unknown user or name, 409 before issue and the value with no-store after", async () => {
      expect((await harness.request("GET", "/v1/users/nobody/credentials/user-chat-token", { token: TOKENS.platformApi })).status).toBe(404);
      await harness.request("PUT", "/v1/users/u1/provisioning", { body: { spec: spec("lin") } });
      expect((await harness.request("GET", "/v1/users/u1/credentials/other", { token: TOKENS.platformApi })).status).toBe(404);
      const early = await harness.request("GET", "/v1/users/u1/credentials/user-chat-token", { token: TOKENS.platformApi });
      expect(early.body.code).toBe("not-issued");
      await untilSettled(harness);
      const issued = await harness.request("GET", "/v1/users/u1/credentials/agent-chat-token", { token: TOKENS.platformApi });
      expect(issued.status).toBe(200);
      expect(issued.headers.get("cache-control")).toBe("no-store");
      expect(issued.body).toEqual({ name: "agent-chat-token", value: harness.chat.tokens[0].token, version: 1 });
      const { rows } = await harness.service.db.pool.query(`SELECT ciphertext FROM ${harness.service.db.table("credentials")}`);
      for (const row of rows) expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(harness.chat.tokens[0].token);
    });
  });
});
