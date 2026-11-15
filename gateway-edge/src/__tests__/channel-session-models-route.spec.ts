import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  uid: "caller-uid",
  liveUserId: "a".repeat(26),
  postUserId: "a".repeat(26),
  postError: null as Error | null,
  membershipError: null as Error | null,
  docs: new Map<string, Record<string, unknown>>(),
  posts: [] as Array<{ segments: readonly string[]; body: unknown }>,
  store: null as unknown as import("@octogee/core/platform-state").PlatformStateStore,
  logs: [] as Array<{ message: string; context: Record<string, unknown> }>,
  threadPosts: {} as Record<string, unknown>,
}));

vi.mock("@octogee/core/http/auth", () => ({
  requireActiveAccount: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAuthenticatedUid: (req: { uid?: string }, _res: unknown, next: () => void) => { req.uid = h.uid; next(); },
}));
vi.mock("@octogee/core/http/security", () => ({ strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("@octogee/core/http/logging", () => ({
  logger: { error: (message: string, context: Record<string, unknown>) => h.logs.push({ message, context }) },
}));
vi.mock("@octogee/core/workspace/workspace-resolution", () => ({ resolveWorkspaceUid: async () => "owner-uid" }));
vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  h.store = createDocumentFixtureStore(h.docs);
  return { platformStateStore: h.store };
});
vi.mock("@octogee/core/channels/channel-session-model-control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octogee/core/channels/channel-session-model-control")>();
  return {
    ...actual,
    createChannelSessionMattermostClient: () => ({
      getCurrentUserId: async () => h.liveUserId,
      getJson: async (segments: readonly string[]) => {
        if (segments[0] === "channels" && segments[2] === "members") {
          if (h.membershipError) throw h.membershipError;
          return { channel_id: segments[1], user_id: segments[3] };
        }
        return { posts: h.threadPosts };
      },
      postJson: async (segments: readonly string[], body: unknown) => {
        if (h.postError) throw h.postError;
        h.posts.push({ segments, body });
        return { id: "p".repeat(26), type: "", root_id: "", channel_id: "c".repeat(26), user_id: h.postUserId, create_at: 100, message: (body as { message: string }).message };
      },
    }),
  };
});

const { ChannelSessionMattermostError } = await import("@octogee/core/channels/channel-session-model-control");
const { default: routes } = await import("../routes/channel-session-models.js");

const CHANNEL_LEDGER = { mattermost: { channelId: "c".repeat(26) } };

function bindChannel(path: string): void {
  h.docs.delete("workspaces/alice/channels/coach-dm");
  h.docs.set(path, CHANNEL_LEDGER);
}

function app() {
  const value = express();
  value.use(express.json());
  value.use("/api/channel-session-models", routes);
  value.use((error: Error, _req: unknown, res: express.Response, _next: unknown) => res.status(500).json({ error: error.message }));
  return value;
}

function auditCalls() {
  return {
    created: vi.mocked(h.store.users.sessionModelAudit.create).mock.calls.map(([entry]) => entry),
    completed: vi.mocked(h.store.users.sessionModelAudit.complete).mock.calls.map(([auditId, completion]) => ({ auditId, ...completion })),
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(h.store.users.sessionModelAudit, "create");
  vi.spyOn(h.store.users.sessionModelAudit, "complete");
  h.liveUserId = "a".repeat(26);
  h.postUserId = "a".repeat(26);
  h.postError = null;
  h.membershipError = null;
  h.posts.length = 0;
  h.logs.length = 0;
  h.threadPosts = {
    ["r".repeat(26)]: { id: "r".repeat(26), type: "", root_id: "p".repeat(26), channel_id: "c".repeat(26), user_id: "g".repeat(26), create_at: 101, message: "Model set to platform-openrouter/z-ai/glm-5.2 for this session." },
  };
  h.docs.clear();
  h.docs.set("users/caller-uid", { mattermost: { userId: "a".repeat(26) } });
  h.docs.set("users/caller-uid/secrets/mattermost", { personalToken: "t".repeat(32) });
  h.docs.set("users/owner-uid/secrets/coachMattermost", { personalToken: "coach-token", coachMmUserId: "g".repeat(26) });
  h.docs.set("workspaces/alice/channels/coach-dm", CHANNEL_LEDGER);
  await h.store.users.agentModels.put({ uid: "owner-uid", agentId: "octogee-alice-coach", primary: "openai/gpt-5", fallbacks: [], updatedAt: 1 });
});

describe("channel session model routes", () => {
  it("returns the bound Agent default only after proving live PAT identity and exact membership", async () => {
    const response = await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(200);
    expect(response.body).toMatchObject({ agentId: "octogee-alice-coach", defaultModel: { primary: "openai/gpt-5" } });
  });

  it("rejects a stored Mattermost identity that does not match the PAT", async () => {
    h.liveUserId = "z".repeat(26);
    await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(403);
  });

  it("maps missing exact-channel membership to 403", async () => {
    h.membershipError = new ChannelSessionMattermostError("Mattermost HTTP 404", 404);
    await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(403);
  });

  it("audits before posting the exact native command and returns parsed native choices", async () => {
    const response = await request(app()).post(`/api/channel-session-models/${"c".repeat(26)}`).send({ operation: "setSessionModel", agentId: "octogee-alice-coach", modelRef: "platform-openrouter/z-ai/glm-5.2" }).expect(200);
    const { created, completed } = auditCalls();
    expect(created).toEqual([{
      auditId: expect.any(String),
      actorUid: "caller-uid",
      channelId: "c".repeat(26),
      workspaceSlug: "alice",
      projectId: null,
      agentId: "octogee-alice-coach",
      operation: "setSessionModel",
      requestedModel: "platform-openrouter/z-ai/glm-5.2",
      createdAt: { serverNow: true },
    }]);
    expect(h.posts).toEqual([{ segments: ["posts"], body: { channel_id: "c".repeat(26), message: "/model platform-openrouter/z-ai/glm-5.2" } }]);
    expect(response.body).toMatchObject({ outcome: "applied", currentModel: "platform-openrouter/z-ai/glm-5.2" });
    expect(await h.store.users.sessionModelAudit.get(created[0]!.auditId)).toMatchObject({
      outcome: "applied",
      commandPostId: "p".repeat(26),
      replyPostId: "r".repeat(26),
      resultingModel: "platform-openrouter/z-ai/glm-5.2",
      completedAt: expect.any(Number),
    });
    expect(completed).toHaveLength(1);
  });

  it("uses a scoped project Agent only when it has a complete minted credential", async () => {
    bindChannel("workspaces/alice/projects/orbit/channels/general");
    h.docs.set("workspaces/alice/projects/orbit", { ownerUid: "owner-uid", agent: { mode: "scoped", enabled: false } });
    h.docs.set("users/owner-uid/secrets/projectAgentMattermost-orbit", { personalToken: "", mmUserId: "q".repeat(26) });
    const fallback = await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(200);
    expect(fallback.body.agentId).toBe("octogee-alice-coach");
    h.docs.set("users/owner-uid/secrets/projectAgentMattermost-orbit", { personalToken: "u".repeat(32) });
    const unbound = await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(200);
    expect(unbound.body.agentId).toBe("octogee-alice-coach");
    h.docs.set("users/owner-uid/secrets/projectAgentMattermost-orbit", { mmUserId: "q".repeat(26), personalToken: "u".repeat(32) });
    const project = await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(200);
    expect(project.body.agentId).toBe("octogee-alice-proj-orbit-coach");
  });

  it("fails closed on a project Agent credential that has no token", async () => {
    bindChannel("workspaces/alice/projects/orbit/channels/general");
    h.docs.set("workspaces/alice/projects/orbit", { ownerUid: "owner-uid", agent: { mode: "scoped", enabled: false } });
    h.docs.set("users/owner-uid/secrets/projectAgentMattermost-orbit", { mmUserId: "q".repeat(26) });

    await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(500);
  });

  it("uses the workspace agent for a project channel without an agent record", async () => {
    bindChannel("workspaces/alice/projects/orbit/channels/general");
    h.docs.set("workspaces/alice/projects/orbit", { ownerUid: "owner-uid" });
    h.docs.set("users/owner-uid/secrets/projectAgentMattermost-orbit", {
      mmUserId: "q".repeat(26),
      personalToken: "u".repeat(32),
    });

    const response = await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(200);
    expect(response.body.agentId).toBe("octogee-alice-coach");
  });

  it("fails closed on duplicate channel bindings and stale Agent preconditions", async () => {
    h.docs.set("workspaces/mallory/channels/general", CHANNEL_LEDGER);
    await request(app()).get(`/api/channel-session-models/${"c".repeat(26)}`).expect(404);
    h.docs.delete("workspaces/mallory/channels/general");
    await request(app()).post(`/api/channel-session-models/${"c".repeat(26)}`).send({
      operation: "resetSessionModel",
      agentId: "octogee-bob-coach",
    }).expect(409);
    expect(h.posts).toHaveLength(0);
  });

  it("rejects command injection before Mattermost or audit writes", async () => {
    await request(app()).post(`/api/channel-session-models/${"c".repeat(26)}`).send({
      operation: "setSessionModel",
      agentId: "octogee-alice-coach",
      modelRef: "openai/gpt-5\n/stop",
    }).expect(400);
    expect(h.posts).toHaveLength(0);
    expect(auditCalls().created).toHaveLength(0);
  });

  it("rejects a command post not authored by the proven caller identity", async () => {
    h.postUserId = "x".repeat(26);
    await request(app()).post(`/api/channel-session-models/${"c".repeat(26)}`).send({
      operation: "resetSessionModel",
      agentId: "octogee-alice-coach",
    }).expect(502);
    const { created } = auditCalls();
    expect(await h.store.users.sessionModelAudit.get(created[0]!.auditId)).toMatchObject({ outcome: "failed", commandPostId: null });
  });

  it("finishes and correlates the audit when native command dispatch fails", async () => {
    h.postError = new ChannelSessionMattermostError("Mattermost HTTP 503", 503);
    await request(app()).post(`/api/channel-session-models/${"c".repeat(26)}`).send({
      operation: "resetSessionModel",
      agentId: "octogee-alice-coach",
    }).expect(502);
    const { created } = auditCalls();
    expect(created).toHaveLength(1);
    expect(await h.store.users.sessionModelAudit.get(created[0]!.auditId)).toMatchObject({ outcome: "failed", completedAt: expect.any(Number) });
    expect(h.logs).toContainEqual({
      message: "channel session model command failed",
      context: expect.objectContaining({ auditId: created[0]!.auditId, channelId: "c".repeat(26), operation: "resetSessionModel" }),
    });
  });
});
