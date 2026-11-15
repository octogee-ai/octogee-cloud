import { describe, expect, it, vi } from "vitest";
import { createBrokeredMattermostAccess } from "./mattermost-broker.js";
import type { OpenClawControlSession } from "./session.js";
import { watchMattermostChannelEvents } from "./mattermost-events.js";

vi.mock("./mattermost-events.js", () => ({ watchMattermostChannelEvents: vi.fn().mockResolvedValue(undefined) }));

const session = {
  sessionId: "7f9b8a1e-429d-4c43-9e1a-9f3bd49d9a70", uid: "owner", gatewayId: "builder", revisionId: "builder",
  workspaceSlug: "alice",
  idleExpiresAt: 10000, absoluteExpiresAt: 20000,
} satisfies OpenClawControlSession;
const channelId = "a".repeat(26);
const env = { OPENCLAW_CONTROL_BROKER_URL: "https://broker.test", MM_INTERNAL_URL: "http://mattermost.octogee-test.svc.cluster.local:8065" };
const access = { forbidden: false, token: "personal-token-123456", callerMmUserId: "m".repeat(26), target: { ownerUid: "owner", workspaceSlug: "alice", agentId: "ws-alice-coach", agentMmUserId: "b".repeat(26) } };

describe("Mattermost Control UI credential broker", () => {
  it.each([
    { status: 403, body: {} },
    { status: 200, body: { ...access, target: { ...access.target, workspaceSlug: "victim" } } },
    { status: 200, body: { ...access, target: { ...access.target, agentId: "victim" } } },
  ])("opens no change feed for denied or mismatched broker credentials ($status)", async ({ status, body }) => {
    vi.mocked(watchMattermostChannelEvents).mockClear();
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(body, { status }));
    await expect(createBrokeredMattermostAccess(session, { env, fetchImpl }).watchChannel(
      channelId, access.target.agentId, vi.fn(), new AbortController().signal,
    )).rejects.toThrow(/broker/);
    expect(watchMattermostChannelEvents).not.toHaveBeenCalled();
  });
  it("binds the change feed to the freshly authorized caller and channel", async () => {
    vi.mocked(watchMattermostChannelEvents).mockClear();
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(access));
    const signal = new AbortController().signal;
    const onChange = vi.fn();
    await createBrokeredMattermostAccess(session, { env, fetchImpl }).watchChannel(channelId, access.target.agentId, onChange, signal);
    expect(watchMattermostChannelEvents).toHaveBeenCalledWith({ baseUrl: env.MM_INTERNAL_URL, token: access.token, channelId, onChange, signal });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ sessionId: session.sessionId, channelId, requireActiveLedger: true });
  });
  it("uses the opaque control session to obtain directory and caller credentials without Firestore", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(Response.json([{ channelId }])).mockResolvedValueOnce(Response.json(access));
    const broker = createBrokeredMattermostAccess(session, { env, fetchImpl });
    expect(await broker.listWorkspaceChannels("alice")).toEqual([{ channelId }]);
    const result = await broker.authorize("owner", channelId, "alice", { requireActiveLedger: true });
    expect(result).toMatchObject({ forbidden: false, callerMmUserId: access.callerMmUserId, client: { getJson: expect.any(Function) } });
    expect(result).not.toHaveProperty("token");
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      gatewayId: "builder", revisionId: "builder", sessionId: session.sessionId, channelId, requireActiveLedger: true,
    });
  });
  it("rejects credentials for a different workspace", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ ...access, target: { ...access.target, workspaceSlug: "victim" } }));
    await expect(createBrokeredMattermostAccess(session, { env, fetchImpl }).authorize("owner", channelId, "alice"))
      .rejects.toThrow(/invalid/i);
  });
  it("retains forbidden channel and unavailable broker failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 })).mockResolvedValueOnce(new Response(null, { status: 503 }));
    const broker = createBrokeredMattermostAccess(session, { env, fetchImpl });
    expect(await broker.authorize("owner", channelId, "alice")).toEqual({ forbidden: true });
    await expect(broker.listWorkspaceChannels("alice")).rejects.toThrow(/503/);
  });
});
