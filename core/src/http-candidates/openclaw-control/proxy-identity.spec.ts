import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import {
  createOpenClawControlProxyIdentity,
  openClawControlClientAddress,
} from "./proxy-identity.js";

interface ConnectRecord {
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, unknown>;
}

interface StoredProfile { id: string; aliases: string[]; role: string | null; displayName?: string | null; hasAvatar?: boolean; updatedAt?: number }

interface MockGateway {
  base: URL;
  connects: ConnectRecord[];
  calls: Array<{ method: string; params: Record<string, unknown>; user: string | undefined }>;
  profiles: StoredProfile[];
  rejectMethod?: string;
  close(): Promise<void>;
}

const isEmailAddress = (alias: string) => /^[^\s@/:]+@[^\s@/:]+$/u.test(alias);
const projected = ({ aliases, ...profile }: StoredProfile) => ({ ...profile, emails: aliases.filter(isEmailAddress) });

const servers: MockGateway[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function mockGateway(
  profiles: MockGateway["profiles"] = [],
): Promise<MockGateway> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const state: MockGateway = {
    base: new URL("http://127.0.0.1"),
    connects: [],
    calls: [],
    profiles,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => server.close(() => resolve()));
    }),
  };
  wss.on("connection", (ws, req) => {
    const user = req.headers["x-octogee-user"];
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { id: string; method: string; params: Record<string, unknown> };
      if (frame.method === "connect") {
        state.connects.push({ headers: req.headers, params: frame.params });
        if (typeof user === "string" && !user.startsWith("svc:") &&
          !state.profiles.some((profile) => profile.aliases.includes(user.toLowerCase()))) {
          state.profiles.push({ id: `profile-${state.profiles.length + 1}`, aliases: [user.toLowerCase()], role: null });
        }
        ws.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { type: "hello-ok", features: { methods: ["users.list", "users.self", "users.setRole"] } },
        }));
        return;
      }
      state.calls.push({ method: frame.method, params: frame.params, user: typeof user === "string" ? user : undefined });
      if (frame.method === state.rejectMethod) {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: "refused" } }));
        return;
      }
      if (frame.method === "users.setDisplayName" || frame.method === "users.setAvatar") {
        const profile = state.profiles.find((entry) => entry.id === frame.params.profileId)!;
        if (frame.method === "users.setDisplayName") profile.displayName = frame.params.displayName as string;
        else profile.hasAvatar = true;
        profile.updatedAt = (profile.updatedAt ?? 0) + 1;
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { profile: projected(profile) } }));
        return;
      }
      if (frame.method === "sessions.list" || frame.method === "sessions.channel.sync") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true,
          payload: frame.method === "sessions.list" ? { sessions: [], hasMore: false } : { changed: true } }));
        return;
      }
      if (frame.method === "users.list") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { profiles: state.profiles.map(projected) } }));
        return;
      }
      if (frame.method === "users.self") {
        const profile = typeof user === "string" && state.profiles.find((entry) => entry.aliases.includes(user.toLowerCase()));
        ws.send(JSON.stringify(profile
          ? { type: "res", id: frame.id, ok: true, payload: { profile: projected(profile) } }
          : { type: "res", id: frame.id, ok: false, error: { message: "profile unavailable" } }));
        return;
      }
      if (frame.method === "users.setRole") {
        const profile = state.profiles.find((entry) => entry.id === frame.params.profileId);
        const accepted = Boolean(profile) && profile!.id !== "ghost";
        if (accepted) profile!.role = frame.params.role as string;
        ws.send(JSON.stringify(accepted
          ? { type: "res", id: frame.id, ok: true, payload: { profile: projected(profile!) } }
          : { type: "res", id: frame.id, ok: false, error: { message: "role assignment refused" } }));
        return;
      }
      ws.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: "unknown" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  servers.push(state);
  return state;
}

function identityFor(gateway: MockGateway, env: NodeJS.ProcessEnv = {}) {
  return createOpenClawControlProxyIdentity({
    env: { OPENCLAW_CONTROL_IDENTITY: "per-user", OPENCLAW_GATEWAY_TOKEN: "pod-secret", API_PUBLIC_URL: "https://api-test.octogee.com/", ...env },
    upstreamBase: () => gateway.base,
    timeoutMs: 2_000,
    podAddress: () => "10.8.0.4",
    loadAppearance: async () => ({ displayName: null, avatar: null }),
  });
}

const helper = { uid: "uid-Helper", gatewayId: "walter", revisionId: "walter", sessionId: "session-id"};

describe("OpenClaw control proxy identity", () => {
  it.each([false, true].map(firstVisit => ({ firstVisit })))(
    "synchronizes native channel access on admission (first visit: $firstVisit)", async ({ firstVisit }) => {
    const gateway = await mockGateway([
      ...(firstVisit ? [] : [{ id: "member-profile", aliases: ["uid-helper"], role: "admin" }]),
      { id: "service-profile", aliases: ["svc:gateway-edge"], role: "service" },
    ]);
    const key = `agent:octogee-alice-coach:mattermost:group:${"a".repeat(26)}`;
    const load = vi.fn(async () => [{ key, displayName: "General" }]);
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", API_PUBLIC_URL: "https://api-test.octogee.com" }, upstreamBase: () => gateway.base,
      podAddress: () => "10.8.0.4", loadChannelMemberships: load,
      loadAppearance: async () => ({ displayName: null, avatar: null }),
    });
    const session = { ...helper,  workspaceSlug: "alice",
      idleExpiresAt: 1, absoluteExpiresAt: 2 };
    await identity.syncChannelMemberships(session, { force: true });
    expect(gateway.calls).toContainEqual({ method: "sessions.channel.sync", user: "svc:gateway-edge",
      params: { agentId: "octogee-alice-coach", channel: "mattermost", peerKind: "group",
        peerId: "a".repeat(26), profileId: firstVisit ? "profile-2" : "member-profile", member: true, displayName: "General" } });
    expect(gateway.calls.filter((call) => call.method === "users.self").map((call) => call.user))
      .toEqual(["svc:gateway-edge", "uid-Helper"]);
    await identity.syncChannelMemberships(session);
    expect(load).toHaveBeenCalledTimes(1);
    await identity.syncChannelMemberships(session, { force: true });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("is disabled unless the pod runs per-user control identity", () => {
    const identity = createOpenClawControlProxyIdentity({
      env: {},
      upstreamBase: () => new URL("http://127.0.0.1:18789"),
    });
    expect(identity.enabled).toBe(false);
  });

  it("initializes a new guest with OpenClaw's default and never assigns a second role", async () => {
    const gateway = await mockGateway();
    await identityFor(gateway).syncProfile(helper);
    expect(gateway.profiles[0].role).toBeNull();
    expect(gateway.calls.some(call => call.method === "users.setRole")).toBe(false);
  });

  it("preserves the initialized owner when first encountered as a chat author and after native edits", async () => {
    const gateway = await mockGateway([{ id: "owner-profile", aliases: ["owner"], role: "admin" }]);
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", API_PUBLIC_URL: "https://api-test.octogee.com" },
      upstreamBase: () => gateway.base, podAddress: () => "10.8.0.4",
      loadAppearance: async () => ({ displayName: "Owner", avatar: null }),
      loadChatAppearance: async () => ({ uid: "owner", username: "owner", mattermostUserId: "m".repeat(26), appearance: { displayName: "Owner", avatar: null } }),
    });
    await identity.resolveChatProfile(helper, { channelId: "general", postId: "owner-post" });
    expect(gateway.profiles[0].role).toBe("admin");
    gateway.profiles[0].role = null;
    await identity.syncProfile({ ...helper, uid: "owner" });
    expect(gateway.profiles[0].role).toBeNull();
    expect(gateway.calls.filter(call => call.method === "users.setRole")).toHaveLength(0);
  });

  it("reuses the profile/avatar sync for chat authors without assigning the viewer's role", async () => {
    const gateway = await mockGateway([{ id: "author-profile", aliases: ["uid-author"], role: "member", displayName: "Author" }]);
    const read = vi.fn(async () => Buffer.from("avatar"));
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", API_PUBLIC_URL: "https://api-test.octogee.com" },
      upstreamBase: () => gateway.base, podAddress: () => "10.8.0.4",
      loadChatAppearance: async () => ({ uid: "uid-author", username: "builder-slug", mattermostUserId: "m".repeat(26), appearance: { displayName: "Author", avatar: { revision: "one", read } } }),
    });
    const source = { channelId: "channel", postId: "post" };
    expect(await identity.resolveChatProfile(helper, source)).toMatchObject({ profileId: "author-profile", username: "builder-slug", avatarUrl: expect.stringContaining("/api/users/author-profile/avatar") });
    await identity.resolveChatProfile(helper, source);
    expect(gateway.profiles[0]!.role).toBe("member");
    expect(gateway.calls.some(call => call.method === "users.setRole")).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("syncs Octogee appearance through the service even when the role is unchanged", async () => {
    const gateway = await mockGateway([{ id: "person", aliases: ["uid-helper"], role: "admin" }]);
    const read = vi.fn(async () => Buffer.from("avatar"));
    const appearance = { displayName: "Chris", avatar: { revision: "upload-1", read } };
    const loadAppearance = vi.fn(async () => appearance);
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", API_PUBLIC_URL: "https://api-test.octogee.com" },
      upstreamBase: () => gateway.base, podAddress: () => "10.8.0.4", loadAppearance,
    });
    await identity.syncProfile(helper);
    expect(loadAppearance).toHaveBeenCalledWith(helper);
    expect(gateway.calls).toEqual([
      { method: "users.self", params: {}, user: "uid-Helper" },
      { method: "users.setDisplayName", params: { profileId: "person", displayName: "Chris" }, user: "svc:gateway-edge" },
      { method: "users.setAvatar", params: { profileId: "person", mime: "image/jpeg", avatarBase64: Buffer.from("avatar").toString("base64") }, user: "svc:gateway-edge" },
    ]);
    await identity.syncProfile(helper);
    expect(read).toHaveBeenCalledTimes(1);
    appearance.displayName = "Christopher";
    appearance.avatar.revision = "upload-2";
    await identity.syncProfile(helper);
    expect(gateway.profiles[0]!.displayName).toBe("Christopher");
    expect(read).toHaveBeenCalledTimes(2);
    gateway.profiles[0]!.updatedAt! += 1;
    await identity.syncProfile(helper);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("refreshes appearance without reassigning roles on an established connection", async () => {
    const gateway = await mockGateway([{ id: "person", aliases: ["uid-helper"], role: "member" }]);
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", API_PUBLIC_URL: "https://api-test.octogee.com" },
      upstreamBase: () => gateway.base, podAddress: () => "10.8.0.4",
      loadAppearance: async () => ({ displayName: "Chris", avatar: null }),
    });
    await identity.syncProfile(helper);
    expect(gateway.profiles[0]).toMatchObject({ displayName: "Chris", role: "member" });
    expect(gateway.calls.map((call) => call.method)).toEqual(["users.self", "users.setDisplayName"]);
  });

  it("shares concurrent profile syncs for the same user and keeps other users separate", async () => {
    const gateway = await mockGateway();
    const loadAppearance = vi.fn(async (session: { uid: string }) => ({ displayName: session.uid, avatar: null }));
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", API_PUBLIC_URL: "https://api-test.octogee.com" },
      upstreamBase: () => gateway.base, podAddress: () => "10.8.0.4", loadAppearance,
    });
    await Promise.all([identity.syncProfile(helper), identity.syncProfile(helper),
      identity.syncProfile({ ...helper, uid: "another-user" })]);
    expect(loadAppearance).toHaveBeenCalledTimes(2);
    expect(gateway.profiles.map((profile) => profile.displayName).sort()).toEqual(["another-user", "uid-Helper"]);
  });

  it("retries refused avatar writes instead of caching them as synchronized", async () => {
    const gateway = await mockGateway([{ id: "person", aliases: ["uid-helper"], role: "admin" }]);
    const read = vi.fn(async () => Buffer.from("avatar"));
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", API_PUBLIC_URL: "https://api-test.octogee.com" },
      upstreamBase: () => gateway.base, podAddress: () => "10.8.0.4",
      loadAppearance: async () => ({ displayName: null, avatar: { revision: "one", read } }),
    });
    gateway.rejectMethod = "users.setAvatar";
    await expect(identity.syncProfile(helper)).rejects.toThrow("users.setAvatar failed");
    gateway.rejectMethod = undefined;
    await identity.syncProfile(helper);
    expect(gateway.profiles[0]!.hasAvatar).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("uses the configured API origin for user and service connections", async () => {
    const identity = identityFor(await mockGateway());
    expect(identity.serviceHeaders().origin).toBe("https://api-test.octogee.com");
    expect(identity.userHeaders(helper, { socket: { remoteAddress: "10.1.2.3" } as never }).origin)
      .toBe("https://api-test.octogee.com");
  });

  it("preserves native role changes, including an explicit default, on reconnect", async () => {
    const gateway = await mockGateway([{ id: "profile", aliases: ["uid-helper"], role: "admin" }]);
    const identity = identityFor(gateway);
    for (const role of ["admin", "member", null]) {
      gateway.profiles[0].role = role;
      await identity.syncProfile(helper);
      expect(gateway.profiles[0].role).toBe(role);
    }
    expect(gateway.calls.some(call => call.method === "users.setRole")).toBe(false);
  });
  it("keeps devices stable across native role changes and leaves scope capping to OpenClaw", () => {
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", OPENCLAW_GATEWAY_TOKEN: "pod-secret", API_PUBLIC_URL: "https://api.octogee.com" },
      upstreamBase: () => new URL("http://127.0.0.1:18789"),
    });
    expect(identity.deviceIdentity(helper)).toEqual(identity.deviceIdentity(helper));
    expect(identity.deviceIdentity({ ...helper, uid: "other" }).deviceId).not.toBe(identity.deviceIdentity(helper).deviceId);
    expect(identity.connectScopes(helper)).toContain("operator.admin");
    expect(identity.userHeaders(helper, {} as never)).not.toHaveProperty("x-openclaw-scopes");
  });

  it("refuses to derive devices without the pod secret", () => {
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user" },
      upstreamBase: () => new URL("http://127.0.0.1:18789"),
    });
    expect(() => identity.deviceIdentity(helper)).toThrow(/OPENCLAW_GATEWAY_TOKEN is required/);
  });

  it("attributes a loopback peer to the pod address and keeps a real peer address", () => {
    const fallback = () => "10.8.0.4";
    expect(openClawControlClientAddress({ socket: { remoteAddress: "127.0.0.1" } as never }, fallback)).toBe("10.8.0.4");
    expect(openClawControlClientAddress({ socket: { remoteAddress: "::ffff:10.1.2.3" } as never }, fallback)).toBe("10.1.2.3");
    expect(openClawControlClientAddress({ socket: undefined } as never, () => undefined)).toBeUndefined();
  });
});
