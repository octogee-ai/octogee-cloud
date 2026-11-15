import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createChannelReadinessAuthorizationBrokerRoutes } from "./channel-agent-readiness-authorization-broker.js";

afterEach(() => vi.restoreAllMocks());

const gatewayId = "gateway-alice";
const channelId = "a".repeat(26);
const body = { gatewayId, channelId };
const endpoint = "/internal/channel-agent-readiness/authorize";

function setup(options: { bound?: "matching" | "different" | "none"; uid?: string | null } = {}) {
  const target = { ownerUid: "owner", workspaceSlug: "alice", projectId: undefined as string | undefined,
    agentId: "octogee-alice-coach", agentMmUserId: "b".repeat(26) };
  const client = { getJson: vi.fn(async () => ({ type: "P", delete_at: 0 })) };
  const authorize = vi.fn(async () => ({ forbidden: false as const, target, client, callerMmUserId: "c".repeat(26) }));
  const docs: Record<string, Record<string, unknown>> = { "users/owner": { provisioning: { openclaw: { gatewayId } } } };
  const store = createDocumentFixtureStore(docs);
  const get = vi.spyOn(store.users.records, "get");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use((req, _res, next) => {
    req.uid = options.uid === null ? undefined : options.uid ?? "member";
    if (options.bound !== "none") req.boundTenant = { kind: "gateway", gatewayId: options.bound === "different" ? "gateway-other" : gatewayId } as Express.Request["boundTenant"];
    next();
  });
  app.use("/internal/channel-agent-readiness", createChannelReadinessAuthorizationBrokerRoutes({ store, authorize: authorize as never }));
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(503).json({ error: "unavailable" }));
  return { app, authorize, target, client, docs, get };
}

describe("channel readiness authorization authority", () => {
  it.each(["none", "different"] as const)("refuses a gateway identity that is %s before looking up any channel", async (bound) => {
    const h = setup({ bound });
    expect((await request(h.app).post(endpoint).send(body)).status).toBe(403);
    expect(h.authorize).not.toHaveBeenCalled(); expect(h.get).not.toHaveBeenCalled();
  });
  it("requires the verified user even if the gateway supplies a caller UID", async () => {
    const h = setup({ uid: null });
    expect((await request(h.app).post(endpoint).send({ ...body, uid: "owner" })).status).toBe(401);
    expect(h.authorize).not.toHaveBeenCalled();
  });
  it.each([{}, { gatewayId, channelId: "../channel" }, { gatewayId: 42, channelId }, []])("rejects malformed requests before resolving access: %j", async (invalid) => {
    const h = setup();
    expect((await request(h.app).post(endpoint).send(invalid)).status).toBe(400);
    expect(h.authorize).not.toHaveBeenCalled();
  });
  it.each(["missing", "forbidden", "moved-owner", "archived", "D", "G", "unknown"])("does not disclose readiness scope for %s", async (failure) => {
    const h = setup();
    if (failure === "missing") h.authorize.mockResolvedValue(null as never);
    if (failure === "forbidden") h.authorize.mockResolvedValue({ forbidden: true } as never);
    if (failure === "moved-owner") h.docs["users/owner"] = { provisioning: { openclaw: { gatewayId: "gateway-other" } } };
    if (failure === "archived") h.client.getJson.mockResolvedValue({ type: "P", delete_at: 1 });
    if (["D", "G", "unknown"].includes(failure)) h.client.getJson.mockResolvedValue({ type: failure, delete_at: 0 });
    const r = await request(h.app).post(endpoint).send(body);
    expect(r.status).toBe(404); expect(r.body).toEqual({ error: "not_found" });
  });
  it.each(["O", "P"])("uses caller membership and canonical channel type %s; returns no credentials or caller overrides", async (type) => {
    const h = setup(); h.client.getJson.mockResolvedValue({ type, delete_at: 0 });
    h.target.projectId = "orbit"; h.target.agentId = "octogee-alice-proj-orbit-coach";
    const r = await request(h.app).post(endpoint).send({ ...body, uid: "owner", workspaceId: "mallory", agentId: "wrong", peerKind: "direct" });
    expect(r.status).toBe(200);
    expect(h.authorize).toHaveBeenCalledWith("member", channelId, undefined, { requireActiveLedger: true, includeDefaultAgentConversation: true, signal: expect.any(AbortSignal) });
    expect(h.get).toHaveBeenCalledWith("owner");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toEqual({ gatewayId, channelId, workspaceId: "alice", project: "orbit", agentId: h.target.agentId,
      agentMmUserId: h.target.agentMmUserId, peerKind: type === "P" ? "group" : "channel" });
  });
  it.each(["authorize", "get"] as const)("propagates %s outages without returning a denial or scope", async (dependency) => {
    const h = setup(); h[dependency].mockRejectedValue(new Error("unavailable"));
    const r = await request(h.app).post(endpoint).send(body);
    expect(r.status).toBe(503); expect(r.body).toEqual({ error: "channel_readiness_unavailable", retryable: true });
  });
});


describe("channel readiness authorization deadline", () => {
  it.each(["authorize", "get", "mattermost"] as const)("bounds a stalled %s dependency and returns a retryable 503", async (dependency) => {
    const h = setup();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const stalled = vi.fn(() => new Promise<never>(() => {}));
    if (dependency === "mattermost") h.client.getJson.mockImplementation(stalled);
    else h[dependency].mockImplementation(stalled);
    const response = request(h.app).post(endpoint).send(body).then((r) => r);
    await vi.waitFor(() => expect(stalled).toHaveBeenCalled());
    expect(timeout).toHaveBeenCalledWith(5_000);
    controller.abort(new DOMException("Deadline exceeded", "TimeoutError"));
    const r = await response;
    expect(r.status).toBe(503);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toEqual({ error: "channel_readiness_unavailable", retryable: true });
    if (dependency === "authorize") expect(h.get).not.toHaveBeenCalled();
    if (dependency !== "mattermost") expect(h.client.getJson).not.toHaveBeenCalled();
  });
});
