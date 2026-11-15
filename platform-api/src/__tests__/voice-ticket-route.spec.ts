import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FeaturePolicy } from "@octogee/shared/types/feature-flags";

const h = vi.hoisted(() => ({
  mintTicket: vi.fn(),
  resolveConversation: vi.fn(),
  resolveChannel: vi.fn(),
  evaluate: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@octogee/core/http/auth", () => ({
  requireActiveAccount: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuthenticatedUid: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("@octogee/core/http/logging", () => ({ logger: h.logger }));
vi.mock("../lib/gateway-ticket.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/gateway-ticket.js")>("../lib/gateway-ticket.js");
  return { ...actual, mintTicket: (...args: unknown[]) => h.mintTicket(...args) };
});

const { createVoiceRoutes } = await import("../routes/voice.js");
const { TicketCapExceededError, HourlyMintQuotaExceededError } = await import("../lib/gateway-ticket.js");

const featurePolicy = { evaluate: (...args: unknown[]) => h.evaluate(...args) } as unknown as FeaturePolicy;

const catalog = {
  list: vi.fn(),
  preview: vi.fn(),
};

function app(caller: { isAdmin?: boolean; gatewayId?: string | null; noPolicy?: boolean; noCatalog?: boolean } = {}) {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.uid = "uid-parent";
    req.isAdmin = caller.isAdmin ?? false;
    req.workspaceSlug = "mom";
    req.user = {
      selectedTier: "free",
      provisioning: caller.gatewayId === null ? {} : { openclaw: { gatewayId: caller.gatewayId ?? "gw-mom" } },
    };
    next();
  });
  instance.use(
    "/api/voice",
    createVoiceRoutes({
      resolveConversation: h.resolveConversation,
      resolveChannel: h.resolveChannel,
      ...(caller.noPolicy ? {} : { featurePolicy }),
      ...(caller.noCatalog ? {} : { catalog }),
    }),
  );
  return instance;
}

const threadRootPostId = 'r'.repeat(26);
const paul = { id: "en_paul_neutral", name: "Paul - Neutral", language: "en_us", gender: "male" };
const jane = { id: "gb_jane_confident", name: "Jane - Confident", language: "en_gb", gender: "female" };

beforeEach(() => {
  h.resolveChannel.mockReset().mockResolvedValue({ channelId: 'c'.repeat(26), gatewayId: 'gw-project-owner' });
  h.resolveConversation.mockReset().mockResolvedValue({ gatewayId: "gw-workspace", workspaceSlug: "workspace", ownerUid: "uid-owner", channelId: "c".repeat(26), threadRootPostId, sessionKey: `agent:octogee-workspace-coach:mattermost:channel:${"c".repeat(26)}` });
  h.mintTicket.mockReset().mockResolvedValue({ ticket: "t-1", uid: "uid-parent", gatewayId: "gw-mom", purpose: "voice-ws" });
  h.evaluate.mockReset().mockResolvedValue({ state: "enabled", value: true });
  catalog.list.mockReset().mockResolvedValue({ configured: true, default: paul, voices: [paul, jane] });
  catalog.preview.mockReset().mockResolvedValue(Buffer.from("RIFFfake"));
  process.env.API_PUBLIC_URL = "https://api-test.octogee.com";
});

describe('voice-only gateway lookup', () => {
  it('returns only the serving gateway for an authorized conversation without minting or creating a root', async () => {
    const result = await request(app()).get(`/api/voice/context/${'c'.repeat(26)}`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ channelId: 'c'.repeat(26), gatewayId: 'gw-project-owner' });
    expect(result.headers['cache-control']).toBe('no-store');
    expect(h.resolveChannel).toHaveBeenCalledWith('uid-parent', 'c'.repeat(26));
    expect(h.mintTicket).not.toHaveBeenCalled(); expect(h.resolveConversation).not.toHaveBeenCalled();
  });
  it('denies a channel without voice membership and respects the release flag', async () => {
    h.resolveChannel.mockResolvedValue(null);
    expect((await request(app()).get(`/api/voice/context/${'c'.repeat(26)}`)).status).toBe(403);
    h.resolveChannel.mockClear(); h.evaluate.mockResolvedValue({ state: 'disabled', value: false });
    expect((await request(app()).get(`/api/voice/context/${'c'.repeat(26)}`)).status).toBe(403);
    expect(h.resolveChannel).not.toHaveBeenCalled();
  });
});

describe("POST /api/voice/ticket", () => {
  it('bounds startup requests before they can create archive roots', async () => {
    const instance = app();
    for (let i = 0; i < 20; i++) {
      expect((await request(instance).post('/api/voice/ticket').send({ channelId: 'c'.repeat(26) })).status).toBe(200);
    }
    expect((await request(instance).post('/api/voice/ticket').send({ channelId: 'c'.repeat(26) })).status).toBe(429);
    expect(h.resolveConversation).toHaveBeenCalledTimes(20);
    expect(h.mintTicket).toHaveBeenCalledTimes(20);
  });
  it('resolves channel voice without requiring a thread selection and returns its archive thread', async () => {
    const channelId = 'c'.repeat(26);
    const result = await request(app()).post('/api/voice/ticket').send({ channelId });
    expect(result.status).toBe(200);
    expect(h.resolveConversation).toHaveBeenCalledWith('uid-parent', channelId, undefined);
    expect(result.body.threadRootPostId).toBe(threadRootPostId);
    expect(h.mintTicket.mock.calls[0][0].payload.threadRootPostId).toBe(threadRootPostId);
  });
  it('carries the exact server-verified selected thread in the voice ticket', async () => {
    const channelId = 'c'.repeat(26); const threadRootPostId = 'r'.repeat(26);
    const sessionKey = `agent:octogee-workspace-coach:mattermost:channel:${channelId}`;
    h.resolveConversation.mockResolvedValue({ gatewayId: 'gw-workspace', workspaceSlug: 'workspace', ownerUid: 'uid-owner', channelId, threadRootPostId, sessionKey });
    expect((await request(app()).post('/api/voice/ticket').send({ channelId, threadRootPostId })).status).toBe(200);
    expect(h.resolveConversation).toHaveBeenCalledWith('uid-parent', channelId, threadRootPostId);
    expect(h.mintTicket.mock.calls[0][0].payload).toMatchObject({ threadRootPostId, sessionKey });
  });
  it("mints a voice-ws ticket for the selected workspace gateway when the flag is enabled", async () => {
    const res = await request(app()).post("/api/voice/ticket").send({ channelId: "c".repeat(26), threadRootPostId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ wsTicket: "t-1", proxyUrl: "https://api-test.octogee.com", gatewayId: "gw-workspace", threadRootPostId });
    expect(h.mintTicket).toHaveBeenCalledWith({ uid: "uid-parent", gatewayId: "gw-workspace", purpose: "voice-ws", payload: { workspaceSlug: "workspace", ownerUid: "uid-owner", channelId: "c".repeat(26), threadRootPostId, sessionKey: `agent:octogee-workspace-coach:mattermost:channel:${"c".repeat(26)}` } });
    expect(h.resolveConversation).toHaveBeenCalledWith("uid-parent", "c".repeat(26), threadRootPostId);
    expect(h.evaluate).toHaveBeenCalledWith(
      "release-voice-talk",
      expect.objectContaining({ uid: "uid-parent", isAdmin: false, workspaceSlug: "mom" }),
      "voice-ticket",
    );
  });

  it("refuses with 403 when the flag is disabled and never mints", async () => {
    h.evaluate.mockResolvedValue({ state: "disabled", value: false });
    const res = await request(app()).post("/api/voice/ticket").send({ channelId: "c".repeat(26), threadRootPostId });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "voice_talk_disabled" });
    expect(h.mintTicket).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when flag evaluation is unavailable", async () => {
    h.evaluate.mockResolvedValue({ state: "unavailable", value: false, reason: "timeout" });
    const res = await request(app()).post("/api/voice/ticket").send({ channelId: "c".repeat(26), threadRootPostId });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "feature_evaluation_unavailable" });
  });

  it("lets admins through the bypass without consulting the policy", async () => {
    h.evaluate.mockResolvedValue({ state: "disabled", value: false });
    const res = await request(app({ isAdmin: true })).post("/api/voice/ticket").send({ channelId: "c".repeat(26), threadRootPostId });
    expect(res.status).toBe(200);
    expect(h.evaluate).not.toHaveBeenCalled();
  });

  it("is disabled when no policy is wired (the standalone cluster-route default)", async () => {
    const res = await request(app({ noPolicy: true })).post("/api/voice/ticket").send({ channelId: "c".repeat(26), threadRootPostId });
    expect(res.status).toBe(403);
  });

  it("refuses a channel the caller cannot access", async () => {
    h.resolveConversation.mockResolvedValue(null);
    const res = await request(app({ gatewayId: null })).post("/api/voice/ticket").send({ channelId: "c".repeat(26), threadRootPostId });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "voice_conversation_forbidden" });
    expect(h.mintTicket).not.toHaveBeenCalled();
  });

  it.each([{}, { channelId: "bad" }, { channelId: "c".repeat(26), threadRootPostId, gatewayId: "foreign" }, { channelId: "c".repeat(26), threadRootPostId, sessionKey: "forged" }])("refuses incomplete or client-assigned scope %j", async body => {
    expect((await request(app()).post("/api/voice/ticket").send(body)).status).toBe(400);
    expect(h.mintTicket).not.toHaveBeenCalled();
  });

  it("maps ticket caps and quotas to 429", async () => {
    h.mintTicket.mockRejectedValueOnce(new TicketCapExceededError("uid-parent", "voice-ws", 5));
    expect((await request(app()).post("/api/voice/ticket").send({ channelId: "c".repeat(26), threadRootPostId })).status).toBe(429);
    h.mintTicket.mockRejectedValueOnce(new HourlyMintQuotaExceededError("uid-parent", "voice-ws", 120, 3_600_000));
    const quota = await request(app()).post("/api/voice/ticket").send({ channelId: "c".repeat(26), threadRootPostId });
    expect(quota.status).toBe(429);
    expect(quota.headers["retry-after"]).toBe("300");
  });
});

describe("GET /api/voice/voices", () => {
  it("returns the engine's catalog for flagged callers and refuses when the flag is off", async () => {
    const res = await request(app()).get("/api/voice/voices");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, default: paul, voices: [paul, jane] });
    expect(h.evaluate).toHaveBeenCalledWith("release-voice-talk", expect.objectContaining({ uid: "uid-parent" }), "voice-catalog");

    h.evaluate.mockResolvedValue({ state: "disabled", value: false });
    expect((await request(app()).get("/api/voice/voices")).status).toBe(403);
    expect(catalog.list).toHaveBeenCalledTimes(1);
  });

  it("is 503 on hosts without the relay's catalog and passes through an unconfigured relay", async () => {
    expect((await request(app({ noCatalog: true })).get("/api/voice/voices")).body).toEqual({ error: "voice_catalog_unavailable" });
    catalog.list.mockResolvedValue({ configured: false, default: null, voices: [] });
    expect((await request(app()).get("/api/voice/voices")).body).toEqual({ configured: false, default: null, voices: [] });
  });
});

describe("POST /api/voice/preview", () => {
  it("speaks a sample in the requested voice as audio/wav, defaulting the voice and bounding the name", async () => {
    const res = await request(app()).post("/api/voice/preview").send({ voice: "gb_jane_confident", name: "Octo" }).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/wav/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect((res.body as Buffer).toString()).toBe("RIFFfake");
    expect(catalog.preview).toHaveBeenCalledWith({ voice: "gb_jane_confident", name: "Octo" }, expect.any(AbortSignal));

    await request(app()).post("/api/voice/preview").send({});
    expect(catalog.preview).toHaveBeenLastCalledWith({ voice: "" }, expect.any(AbortSignal));
    await request(app()).post("/api/voice/preview").send({ voice: "", name: "x".repeat(200) });
    expect((catalog.preview.mock.calls[2] as unknown as [{ name: string }])[0].name).toHaveLength(60);
  });

  it("rejects malformed voices, refuses when the flag is off, and maps catalog failures to their status", async () => {
    expect((await request(app()).post("/api/voice/preview").send({ voice: "<script>" })).status).toBe(400);
    h.evaluate.mockResolvedValueOnce({ state: "disabled", value: false });
    expect((await request(app()).post("/api/voice/preview").send({ voice: "" })).status).toBe(403);
    catalog.preview.mockRejectedValueOnce(Object.assign(new Error("voice_not_configured"), { status: 503 }));
    expect((await request(app()).post("/api/voice/preview").send({ voice: "" })).status).toBe(503);
    catalog.preview.mockRejectedValueOnce(Object.assign(new Error("speech upstream HTTP 500"), { status: 500 }));
    expect((await request(app()).post("/api/voice/preview").send({ voice: "" })).status).toBe(502);
    catalog.preview.mockRejectedValueOnce(new Error("boom"));
    expect((await request(app()).post("/api/voice/preview").send({ voice: "" })).status).toBe(502);
    expect(h.logger.warn).toHaveBeenCalledWith("[voice] preview failed", expect.objectContaining({ uid: "uid-parent" }));
  });
});
