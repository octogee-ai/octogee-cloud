import request from "supertest";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Characterization spec for the Mattermost token route. Pins the
// current behaviour (status codes, response shapes, branch selection) so the
// handlers can be decomposed safely. Uses a mocked db + mocked auth/context
// (service-route convention; not the Firestore emulator).

const authState = vi.hoisted(() => ({ uid: "caller-uid", user: {} as Record<string, unknown> }));

const dbState = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  collections: new Map<string, Array<{ id: string; data: Record<string, unknown> }>>(),
  writes: [] as Array<{ op: string; path?: string; collection?: string; data: unknown }>,
  addCounter: 0,
}));

vi.mock("../middleware/auth", () => ({
  requireAuth: (req: Record<string, unknown>, _res: unknown, next: () => void) => {
    req.uid = authState.uid;
    req.user = authState.user;
    next();
  },
}));

vi.mock("../lib/mattermost-context", () => ({
  getWorkspaceMmContext: vi.fn(),
}));

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(dbState.docs) };
});

vi.mock("../lib/db", () => {
  type Pred = (d: Record<string, unknown>) => boolean;
  function makeQuery(coll: string, preds: Pred[]) {
    return {
      where(field: string, op: string, val: unknown) {
        const pred: Pred = (d) => {
          const fv = d[field];
          if (op === "==") return fv === val;
          if (op === "in") return Array.isArray(val) && val.includes(fv);
          return true;
        };
        return makeQuery(coll, [...preds, pred]);
      },
      limit() {
        return makeQuery(coll, preds);
      },
      async get() {
        const rows = (dbState.collections.get(coll) ?? []).filter((r) => preds.every((p) => p(r.data)));
        return { empty: rows.length === 0, docs: rows.map((r) => ({ id: r.id, data: () => r.data })) };
      },
    };
  }
  return {
    db: {
      doc: (path: string) => ({
        async get() {
          const d = dbState.docs.get(path);
          return { exists: d !== undefined, data: () => d };
        },
        async set(data: Record<string, unknown>) {
          dbState.docs.set(path, data);
          dbState.writes.push({ op: "set", path, data });
        },
        async update(data: Record<string, unknown>) {
          dbState.docs.set(path, { ...(dbState.docs.get(path) ?? {}), ...data });
          dbState.writes.push({ op: "update", path, data });
        },
      }),
      collection: (name: string) => ({
        where: (f: string, o: string, v: unknown) => makeQuery(name, []).where(f, o, v),
        async add(data: Record<string, unknown>) {
          const id = `gen-${++dbState.addCounter}`;
          const arr = dbState.collections.get(name) ?? [];
          arr.push({ id, data });
          dbState.collections.set(name, arr);
          dbState.writes.push({ op: "add", collection: name, data });
          return { id };
        },
      }),
    },
    FieldValue: { serverTimestamp: () => "SERVER_TS", increment: (n: number) => ({ __increment: n }) },
    Timestamp: { fromDate: (d: Date) => ({ toDate: () => d }) },
  };
});

import router from "../routes/mattermost.js";
import { getWorkspaceMmContext } from "../lib/mattermost-context.js";

import { installAgentIdentity, NO_AGENT_IDENTITY } from "../lib/agent-identity.js";

const ctxMock = vi.mocked(getWorkspaceMmContext);

const app = express();
app.use(express.json());
app.use("/api/mattermost", router);

beforeEach(() => {
  dbState.docs.clear();
  dbState.collections.clear();
  dbState.writes.length = 0;
  dbState.addCounter = 0;
  authState.uid = "caller-uid";
  authState.user = {};
  ctxMock.mockReset();
  installAgentIdentity({
    ...NO_AGENT_IDENTITY,
    read: async (uid) => {
      const name = dbState.docs.get(`agents/${uid}`)?.name;
      return { name: typeof name === "string" ? name : null, persona: null, emoji: null };
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  installAgentIdentity(NO_AGENT_IDENTITY);
});

describe("GET /token", () => {
  it("202 provisioning when the MM context has no userId/dmChannelId", async () => {
    ctxMock.mockResolvedValue({ userId: undefined, coachDmChannelId: undefined } as never);
    const res = await request(app).get("/api/mattermost/token");
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("provisioning");
  });

  it("202 provisioning when the personalToken secret is absent", async () => {
    ctxMock.mockResolvedValue({ userId: "mm-1", coachDmChannelId: "dm-1" } as never);
    // no users/<uid>/secrets/mattermost doc
    const res = await request(app).get("/api/mattermost/token");
    expect(res.status).toBe(202);
  });

  it("200 with the connection payload + validated gatewayId when fully provisioned", async () => {
    authState.user = {
      onboarding: { coachName: "Octo" },
      provisioning: { openclaw: { gatewayId: "christopher" } },
    };
    ctxMock.mockResolvedValue({
      userId: "mm-1",
      coachDmChannelId: "dm-1",
      coachUserId: "coach-1",
    } as never);
    dbState.docs.set("users/caller-uid/secrets/mattermost", { personalToken: "tok-xyz" });
    dbState.docs.set("agents/caller-uid", { id: "caller-uid", name: "Scout" });

    const res = await request(app).get("/api/mattermost/token");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mmUserId: "mm-1",
      dmChannelId: "dm-1",
      gatewayId: "christopher",
      coachMmUserId: "coach-1",
      coachName: "Scout",
    });
  });

  it.each([
    ["has no name", { id: "caller-uid" }],
    ["has an empty name", { id: "caller-uid", name: "" }],
    ["does not exist", undefined],
  ])("names no agent when the agent identity %s, whatever the account's onboarding fields say", async (_label, agent) => {
    authState.user = { onboarding: { coachName: "Octo" } };
    ctxMock.mockResolvedValue({ userId: "mm-1", coachDmChannelId: "dm-1" } as never);
    dbState.docs.set("users/caller-uid/secrets/mattermost", { personalToken: "tok" });
    if (agent) dbState.docs.set("agents/caller-uid", agent);

    const res = await request(app).get("/api/mattermost/token");

    expect(res.status).toBe(200);
    expect(res.body.coachName).toBeNull();
  });

  it("blanks an invalid gatewayId rather than echoing it", async () => {
    authState.user = { provisioning: { openclaw: { gatewayId: "Bad GW!" } } };
    ctxMock.mockResolvedValue({ userId: "mm-1", coachDmChannelId: "dm-1" } as never);
    dbState.docs.set("users/caller-uid/secrets/mattermost", { personalToken: "tok" });

    const res = await request(app).get("/api/mattermost/token");
    expect(res.body.gatewayId).toBe("");
  });
});
