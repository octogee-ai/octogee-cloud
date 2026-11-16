import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import type { UserProvisioningSpec } from "@octogee/shared/types/provisioning-service";
import { startFakeProvisioningService, type FakeProvisioningService } from "./fixtures/provisioning-service-fake.js";
import { createAdminFleetMutationRunner } from "./admin-fleet-router.js";
import { addAdminProvisioningRoutes, type AdminProvisioningClient } from "./admin-provisioning-router.js";
import { createProvisioningServiceClient, type ProvisioningServiceClient } from "./provisioning-service-client.js";

type Data = Record<string, unknown>;

const SPEC: UserProvisioningSpec = {
  slug: "lin",
  displayName: { first: "lin", last: "" },
  email: "lin@example.test",
  avatarUrl: null,
  chat: { teamDisplayName: "lin", defaultAgent: { enabled: true } },
  git: { repositories: ["workspace", "project-coaches"], systemConfigRepository: true },
  agentIds: ["octogee-lin-coach"],
};

let records: Map<string, Data>;
let fake: FakeProvisioningService;
let client: ProvisioningServiceClient;
let warnings: Array<{ msg: string; meta?: Record<string, unknown> }>;

function app(configured = true, overrides: { provisioning?: AdminProvisioningClient; readDeadlineMs?: number } = {}) {
  const store = createDocumentFixtureStore(records, { serializeTransactions: true });
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as express.Request & { uid?: string }).uid = "operator@example.test";
    next();
  });
  addAdminProvisioningRoutes(server, {
    provisioning: configured ? overrides.provisioning ?? client : null,
    journal: createAdminFleetMutationRunner(store),
    logger: { warn: (msg, meta) => warnings.push({ msg, meta }) },
    sync: {
      specFailures: () => [{ uid: "u9", reason: "admitted user u9 has no account document", attempts: 3, since: "2026-11-15T18:00:00.000Z" }],
      mirrorRefusals: () => [{ uid: "u7", outcome: "chat-id-mismatch", reason: "the user record holds chat user mm-a, the provisioning service reports chat user mm-b", since: "2026-11-15T18:00:00.000Z" }],
    },
    ...(overrides.readDeadlineMs === undefined ? {} : { readDeadlineMs: overrides.readDeadlineMs }),
  });
  server.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return server;
}

const audits = () => [...records.entries()].filter(([path]) => path.startsWith("glmOperations/audit-")).map(([, row]) => row);

beforeEach(async () => {
  records = new Map();
  warnings = [];
  fake = await startFakeProvisioningService();
  client = createProvisioningServiceClient({
    baseUrl: fake.url,
    tokenPath: "/token",
    readToken: async () => "token",
    retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  });
  await client.putProvisioning("u1", SPEC);
});

afterEach(async () => {
  await fake.close();
});

describe("Admin API provisioning routes", () => {
  it("answers 501 on every route when no provisioning service is configured", async () => {
    const server = app(false);

    await request(server).get("/users/u1/provisioning").expect(501);
    await request(server).post("/users/u1/provisioning/retry").send({}).expect(501);
    await request(server).get("/provisioning").expect(501);
    expect(fake.requests.filter((entry) => entry.method !== "PUT")).toEqual([]);
  });

  it("reads one user's provisioning with its recent attempts", async () => {
    fake.setEvents("u1", [{ generation: 1, startedAt: "a", finishedAt: "b", durationMs: 3, result: "failed", reason: "GitOwnerFailed", steps: [] }]);

    const res = await request(app()).get("/users/u1/provisioning").expect(200);

    expect(res.body.provisioning).toMatchObject({ uid: "u1", spec: { slug: "lin" } });
    expect(res.body.events).toEqual([expect.objectContaining({ reason: "GitOwnerFailed" })]);
  });

  it("answers 404 for a user the service does not manage", async () => {
    const res = await request(app()).get("/users/nobody/provisioning").expect(404);

    expect(res.body.code).toBe("not-found");
  });

  it("answers 503 with a fixed message when the service fails, and logs the detail", async () => {
    fake.failNext(503, 2);

    const res = await request(app()).get("/users/u1/provisioning").expect(503);

    expect(res.body).toEqual({ code: "unavailable", error: "the provisioning service did not answer; see the fleet controller log" });
    expect(warnings).toEqual([expect.objectContaining({ meta: expect.objectContaining({ status: 503, error: "injected" }) })]);
  });

  it("answers 503 within the read deadline when the service hangs", async () => {
    const hanging: AdminProvisioningClient = {
      ...client,
      getProvisioning: () => new Promise(() => undefined),
      listProvisionings: () => new Promise(() => undefined),
    };
    const started = Date.now();

    await request(app(true, { provisioning: hanging, readDeadlineMs: 50 })).get("/users/u1/provisioning").expect(503);
    await request(app(true, { provisioning: hanging, readDeadlineMs: 50 })).get("/provisioning").expect(503);

    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("aborts the service requests it stops waiting for at the read deadline", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const hangUntilAborted = <T>(signal: AbortSignal | undefined) => {
      signals.push(signal);
      return new Promise<T>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    };
    const hanging: AdminProvisioningClient = {
      ...client,
      getProvisioning: (_uid, options) => hangUntilAborted(options?.signal),
      getProvisioningEvents: (_uid, options) => hangUntilAborted(options?.signal),
      listProvisionings: (_query, options) => hangUntilAborted(options?.signal),
    };

    await request(app(true, { provisioning: hanging, readDeadlineMs: 50 })).get("/users/u1/provisioning").expect(503);
    await request(app(true, { provisioning: hanging, readDeadlineMs: 50 })).get("/provisioning").expect(503);

    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
  });

  it("passes any uid the platform admits to the service as one path segment", async () => {
    const refused = await request(app()).get("/users/..%2F..%2Fprovisionings/provisioning").expect(400);
    await request(app()).get("/users/.hidden/provisioning").expect(400);

    expect(refused.body.code).toBe("invalid-request");

    expect(fake.requests.filter((entry) => entry.method === "GET").map((entry) => entry.path)).toEqual(expect.arrayContaining([
      "/v1/users/..%2F..%2Fprovisionings/provisioning",
      "/v1/users/.hidden/provisioning",
    ]));
  });

  it("refuses a dot-segment uid before any request or journal entry", async () => {
    const res = await request(app()).post("/users/%2E%2E/provisioning/retry").send({}).expect(400);

    expect(res.body.code).toBe("invalid-request");
    expect(fake.requests.filter((entry) => entry.method !== "PUT")).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it("journals a retry and passes the journal's idempotency key to the service", async () => {
    const res = await request(app()).post("/users/u1/provisioning/retry").set("Idempotency-Key", "k1").send({ expectedAttempts: 0 }).expect(202);

    expect(res.body).toEqual({ uid: "u1", due: true });
    const retry = fake.requests.find((entry) => entry.path === "/v1/users/u1/provisioning/retry");
    expect(retry?.idempotencyKey).toMatch(/^audit-/);
    expect(audits()).toEqual([expect.objectContaining({
      status: "completed",
      what: "retry user provisioning",
      actor: "operator@example.test",
      mutation: { kind: "retry-user-provisioning", uid: "u1", expectedAttempts: 0 },
    })]);
  });

  it("answers 409 precondition-failed when the attempts moved, and journals the refusal", async () => {
    const res = await request(app()).post("/users/u1/provisioning/retry").send({ expectedAttempts: 7 }).expect(409);

    expect(res.body.code).toBe("precondition-failed");
    expect(audits()).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("answers a classified 503 and logs unexpected-response when the service accepts a retry with a body that is not JSON", async () => {
    const unreadable = createProvisioningServiceClient({
      baseUrl: fake.url,
      tokenPath: "/token",
      readToken: async () => "token",
      retry: { attempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      fetch: async () => new Response("<html>accepted</html>", { status: 202 }),
    });

    const res = await request(app(true, { provisioning: unreadable })).post("/users/u1/provisioning/retry").send({}).expect(503);

    expect(res.body).toEqual({ code: "unavailable", error: "the provisioning service did not answer; see the fleet controller log" });
    expect(warnings).toEqual([expect.objectContaining({ meta: expect.objectContaining({ status: 202, code: "unexpected-response" }) })]);
  });

  it("plans a retry on dryRun without calling the service's retry or journaling", async () => {
    const res = await request(app()).post("/users/u1/provisioning/retry?dryRun=true").send({ expectedAttempts: 0 }).expect(200);

    expect(res.body.dryRun).toBe(true);
    expect(fake.requests.some((entry) => entry.path.endsWith("/retry"))).toBe(false);
    expect(audits()).toEqual([]);
  });

  it("refuses a dryRun whose precondition no longer holds", async () => {
    const res = await request(app()).post("/users/u1/provisioning/retry?dryRun=true").send({ expectedAttempts: 3 }).expect(409);

    expect(res.body.code).toBe("precondition-failed");
  });

  it("rejects a malformed retry body", async () => {
    const res = await request(app()).post("/users/u1/provisioning/retry").send({ expectedAttempts: -1 }).expect(400);

    expect(res.body.code).toBe("invalid-request");
    expect(fake.requests.some((entry) => entry.path.endsWith("/retry"))).toBe(false);
  });

  it("lists users that are not ready", async () => {
    const res = await request(app()).get("/provisioning?ready=false").expect(200);

    expect(res.body.items.map((item: Data) => item.uid)).toEqual(["u1"]);
    expect(res.body.specWriteFailures).toEqual([expect.objectContaining({ uid: "u9", reason: expect.stringContaining("no account document") })]);
    expect(res.body.mirrorRefusals).toEqual([expect.objectContaining({ uid: "u7", outcome: "chat-id-mismatch", reason: expect.stringContaining("mm-b") })]);
    expect(fake.requests.at(-1)?.query).toEqual({ ready: "false" });
  });

  it("rejects an unknown list filter value", async () => {
    await request(app()).get("/provisioning?workState=idle").expect(400);
    await request(app()).get("/provisioning?ready=maybe").expect(400);
  });
});
