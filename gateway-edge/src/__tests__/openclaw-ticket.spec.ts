import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ documents: new Map<string, Record<string, unknown>>() }));

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.documents) };
});

const { platformStateStore } = await import("../lib/platform-state.js");
const { installBearerUids } = await import("./helpers/user-bearer.js");
const { default: openclawRouter } = await import("../routes/openclaw.js");

const CALLER = "caller-uid";

installBearerUids(
  async (token) => {
    if (!token.startsWith("token-")) throw new Error("unknown bearer");
    return token.slice("token-".length);
  },
  () => ({ accountLifecycle: { status: "active" } }),
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/openclaw", openclawRouter);
  return app;
}

function postTicket(uid = CALLER) {
  return request(buildApp()).post("/api/openclaw/ticket").set("Authorization", `Bearer token-${uid}`);
}

async function seedGatewayUser(gatewayId: string): Promise<void> {
  await platformStateStore.users.records.create({ uid: CALLER, createdAt: 1 });
  await platformStateStore.users.records.setGatewayMirror(CALLER, { gatewayId });
}

describe("POST /api/openclaw/ticket", () => {
  beforeEach(() => {
    h.documents.clear();
    vi.stubEnv("API_PUBLIC_URL", "https://chat-proxy.test.octogee.com");
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(buildApp()).post("/api/openclaw/ticket");
    expect(res.status).toBe(401);
  });

  it("rejects a bearer the identity provider rejects with 401", async () => {
    const res = await request(buildApp()).post("/api/openclaw/ticket").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("returns a ticket and the proxy URL for a verified active user", async () => {
    const res = await postTicket();
    expect(res.status).toBe(200);
    expect(res.body.wsTicket).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.proxyUrl).toBe("https://chat-proxy.test.octogee.com");
  });

  it("stores an openclaw-ws ticket for the caller that expires in about 30 seconds", async () => {
    const before = Date.now();
    const res = await postTicket();
    const after = Date.now();
    expect(res.status).toBe(200);

    const stored = await platformStateStore.access.gatewayTickets.get(res.body.wsTicket);
    expect(stored).toMatchObject({ uid: CALLER, grant: { purpose: "openclaw-ws" } });
    expect(stored!.expiresAt).toBeGreaterThanOrEqual(before + 29_000);
    expect(stored!.expiresAt).toBeLessThanOrEqual(after + 31_000);
  });

  it("issues distinct tickets across calls", async () => {
    const a = await postTicket();
    const b = await postTicket();
    expect(a.body.wsTicket).not.toBe(b.body.wsTicket);
  });

  it("returns the gatewayId of the caller's gateway mirror", async () => {
    await seedGatewayUser("gw-walter");
    const res = await postTicket();
    expect(res.status).toBe(200);
    expect(res.body.gatewayId).toBe("gw-walter");
  });

  it("returns an empty gatewayId when the caller has no platform record", async () => {
    const res = await postTicket("no-provisioning-uid");
    expect(res.status).toBe(200);
    expect(res.body.gatewayId).toBe("");
  });

  it("never records runtime demand: an open tab cannot summon or hold the runtime", async () => {
    await seedGatewayUser("default");
    const res = await postTicket().send({});

    expect(res.status).toBe(200);
    expect(res.body.gatewayId).toBe("default");
    expect(res.body.wsTicket).toMatch(/^[0-9a-f-]{36}$/);
    expect((await platformStateStore.users.records.get(CALLER))?.activationLease).toBeNull();
  });
});
