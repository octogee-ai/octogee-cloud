import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { OPENCLAW_FULL_OPERATOR_SCOPES, OPENCLAW_EDGE_SERVICE_IDENTITY } from "@octogee/shared/types/openclaw-proxy-identity";
import { openNativeUserClient, openNativeUserSocket } from "./native-user-client.js";

const { authority, channelAuthority, voiceAuthority } = vi.hoisted(() => ({ authority: vi.fn(), channelAuthority: vi.fn(), voiceAuthority: vi.fn() }));
vi.mock('@octogee/core/voice-conversation', () => ({ resolveVoiceConversation: voiceAuthority }));
vi.mock('../lib/tool-conversation.js', () => ({ resolveToolConversationForUid: authority, resolveToolChannelForUid: channelAuthority }));
const root = 'r'.repeat(26);
const isEmailAddress = (alias: string) => /^[^\s@/:]+@[^\s@/:]+$/u.test(alias);
const projected = ({ aliases, ...profile }: { id: string; aliases: string[] }) => ({ ...profile, emails: aliases.filter(isEmailAddress) });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });

async function gateway() {
  voiceAuthority.mockReset().mockImplementation(async args => ({ ...args, sessionKey: `agent:${args.expectedAgentId}:mattermost:group:${args.channelId}` }));
  authority.mockReset().mockImplementation(async args => ({ ...args, sessionKey: `agent:${args.expectedAgentId}:mattermost:group:${args.channelId}` }));
  channelAuthority.mockReset().mockImplementation(async args => ({ ...args, sessionKey: `agent:${args.expectedAgentId}:mattermost:group:${args.channelId}` }));
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const state = {
    scopes: ["operator.read", "operator.write"] as string[] | undefined,
    connectDelayMs: 0,
    syncDelayMs: 0,
    calls: [] as Array<{ uid: string; method: string; params: Record<string, unknown> }>,
    closed: [] as string[],
    profiles: [{ id: "native-alice", aliases: ["alice"] }],
    rejectSync: false,
    closeUserOnServiceConnect: false,
    userSocket: null as import("ws").WebSocket | null,
    connects: [] as Array<{ uid: string; device: { id: string }; scopes: string[]; caps?: string[] }>,
  };
  const responseTimers = new Set<ReturnType<typeof setTimeout>>();
  wss.on("connection", (ws, req) => {
    if (req.headers["x-octogee-user"] === "alice") state.userSocket = ws;
    ws.on("close", () => state.closed.push(String(req.headers["x-octogee-user"])));
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.method === "connect") {
        state.connects.push({ uid: String(req.headers["x-octogee-user"]), device: frame.params.device, scopes: frame.params.scopes, ...(frame.params.caps ? { caps: frame.params.caps } : {}) });
        const reply = () => ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok", auth: { scopes: state.scopes } } }));
        if (state.closeUserOnServiceConnect && req.headers["x-octogee-user"] === OPENCLAW_EDGE_SERVICE_IDENTITY && state.userSocket) {
          state.userSocket.once("close", reply);
          state.userSocket.close();
        } else if (state.connectDelayMs > 0) {
          const timer = setTimeout(() => { responseTimers.delete(timer); reply(); }, state.connectDelayMs);
          responseTimers.add(timer);
        } else reply();
      } else {
        state.calls.push({ uid: String(req.headers["x-octogee-user"]), method: frame.method, params: frame.params });
        if (frame.method === "users.list") {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { profiles: state.profiles.map(projected) } }));
        } else if (frame.method === "users.self") {
          const profile = state.profiles.find(entry => entry.aliases.includes(String(req.headers["x-octogee-user"]).toLowerCase()));
          ws.send(JSON.stringify(profile
            ? { type: "res", id: frame.id, ok: true, payload: { profile: projected(profile) } }
            : { type: "res", id: frame.id, ok: false, error: { message: "profile unavailable" } }));
        } else if (frame.method === "sessions.channel.sync" && !state.rejectSync) {
          const reply = () => ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { changed: true } }));
          if (state.syncDelayMs > 0) {
            const timer = setTimeout(() => { responseTimers.delete(timer); reply(); }, state.syncDelayMs);
            responseTimers.add(timer);
          } else reply();
        } else {
          ws.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: "native role denied" } }));
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => {
    for (const timer of responseTimers) clearTimeout(timer);
    for (const client of wss.clients) client.terminate();
    wss.close(() => server.close(() => resolve()));
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-user-ready-"));
  fs.writeFileSync(path.join(dir, "workspace-identity-boot"), "test-boot");
  fs.writeFileSync(path.join(dir, "workspace-identity-ready"), "test-boot");
  cleanup.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
  const env = { OPENCLAW_DIR: dir, GATEWAY_CLASS: "isolated", GATEWAY_ID: "b-alice", OPENCLAW_CONTROL_IDENTITY: "per-user",
    OPENCLAW_GATEWAY_TOKEN: "pod-secret", API_PUBLIC_URL: "https://api.octogee.com",
    OPENCLAW_GATEWAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  return { state, env };
}

describe("native user RPC identity", () => {
  it('authorizes project voice separately from workspace tool access and rechecks before membership sync', async () => {
    const { state, env } = await gateway();
    const channelId = 'a'.repeat(26);
    const agentId = 'octogee-alice-proj-orbit-coach';
    const native = await openNativeUserSocket('alice', 'b-alice', env, { purpose: 'voice', channelSessionKey: `agent:${agentId}:mattermost:group:${channelId}`, threadRootPostId: root });
    expect(voiceAuthority).toHaveBeenCalledTimes(2);
    expect(authority).not.toHaveBeenCalled(); expect(channelAuthority).not.toHaveBeenCalled();
    expect(state.calls[1].params).toMatchObject({ agentId, peerId: channelId, profileId: 'native-alice' });
    native.ws.close();
  });
  it("prepares the authorized channel without selecting or creating a reply thread", async () => {
    const { state, env } = await gateway();
    const channelId = 'a'.repeat(26);
    const channelSessionKey = `agent:octogee-alice-coach:mattermost:group:${channelId}`;
    const native = await openNativeUserSocket('alice', 'b-alice', env, { channelSessionKey });
    expect(authority).not.toHaveBeenCalled();
    expect(channelAuthority).toHaveBeenCalledTimes(2);
    expect(channelAuthority).toHaveBeenLastCalledWith({ uid: 'alice', gatewayId: 'b-alice', channelId, expectedAgentId: 'octogee-alice-coach', env });
    expect(state.calls.map(call => call.method)).toEqual(['users.self', 'sessions.channel.sync']);
    expect(state.calls[1].params).toEqual({ agentId: 'octogee-alice-coach', channel: 'mattermost', peerKind: 'group', peerId: channelId, profileId: 'native-alice', member: true });
    native.ws.close();
  });
  it("rechecks root-free channel authority after profile work and closes both sockets on revocation", async () => {
    const { state, env } = await gateway();
    const channelSessionKey = `agent:octogee-alice-coach:mattermost:group:${'a'.repeat(26)}`;
    channelAuthority.mockResolvedValueOnce({ sessionKey: channelSessionKey }).mockRejectedValueOnce(new Error('Channel access revoked'));
    await expect(openNativeUserSocket('alice', 'b-alice', env, { channelSessionKey })).rejects.toThrow('Channel access revoked');
    expect(authority).not.toHaveBeenCalled();
    expect(state.calls.map(call => call.method)).toEqual(['users.self']);
    await vi.waitFor(() => expect(state.closed).toEqual(expect.arrayContaining(['alice', OPENCLAW_EDGE_SERVICE_IDENTITY])));
  });
  it("waits for native profile acquisition beyond five seconds before accepting effective scopes", async () => {
    const { state, env } = await gateway();
    state.connectDelayMs = 6_000;
    state.scopes = [...OPENCLAW_FULL_OPERATOR_SCOPES];
    const native = await openNativeUserClient("alice", "b-alice", env);
    expect(native.scopes.has("operator.admin")).toBe(true);
    expect(state.connects).toHaveLength(1);
    native.close();
  });

  it("keeps one device per user while native role changes update effective scopes", async () => {
    const { state, env } = await gateway();
    const first = await openNativeUserClient("alice", "b-alice", env);
    expect(first.scopes.has("operator.admin")).toBe(false);
    first.close();
    state.scopes = [...OPENCLAW_FULL_OPERATOR_SCOPES];
    const promoted = await openNativeUserClient("alice", "b-alice", env);
    expect(promoted.scopes.has("operator.admin")).toBe(true);
    expect(await promoted.call("users.setRole", {})).toEqual({ ok: false, reason: "native role denied" });
    promoted.close();
    const other = await openNativeUserClient("bob", "b-alice", env);
    other.close();
    expect(state.connects[0].device.id).toBe(state.connects[1].device.id);
    expect(state.connects[0].device.id).not.toBe(state.connects[2].device.id);
    expect(state.connects.map(connect => connect.uid)).toEqual(["alice", "alice", "bob"]);
    expect(state.connects.every(connect => JSON.stringify(connect.scopes) === JSON.stringify(OPENCLAW_FULL_OPERATOR_SCOPES))).toBe(true);
  });

  it("initializes exactly one authorized channel using the service identity and native profile mapping", async () => {
    const { state, env } = await gateway();
    const channelSessionKey = `agent:octogee-alice-coach:mattermost:group:${"a".repeat(26)}`;
    const native = await openNativeUserSocket("alice", "b-alice", env, { channelSessionKey, threadRootPostId: root });
    expect(state.calls).toEqual([
      { uid: "alice", method: "users.self", params: {} },
      { uid: OPENCLAW_EDGE_SERVICE_IDENTITY, method: "sessions.channel.sync", params: {
        agentId: "octogee-alice-coach", channel: "mattermost", peerKind: "group", peerId: "a".repeat(26), profileId: "native-alice", member: true,
      } },
    ]);
    await vi.waitFor(() => expect(state.closed).toContain(OPENCLAW_EDGE_SERVICE_IDENTITY));
    expect(native.ws.readyState).toBe(1);
    native.ws.close();
  });

  it("accepts cold channel membership synchronization within the native preparation budget without retrying", async () => {
    const { state, env } = await gateway();
    state.syncDelayMs = 6_000;
    const channelSessionKey = `agent:octogee-alice-coach:mattermost:group:${"a".repeat(26)}`;
    const native = await openNativeUserSocket("alice", "b-alice", env, { channelSessionKey, threadRootPostId: root });
    expect(state.calls.map(call => call.method)).toEqual(["users.self", "sessions.channel.sync"]);
    expect(state.connects.map(connect => connect.uid)).toEqual(["alice", OPENCLAW_EDGE_SERVICE_IDENTITY]);
    await vi.waitFor(() => expect(state.closed).toContain(OPENCLAW_EDGE_SERVICE_IDENTITY));
    expect(native.ws.readyState).toBe(1);
    native.ws.close();
  });

  it("does not adopt rejected provenance or retain either connection after native synchronization fails", async () => {
    const { state, env } = await gateway();
    state.rejectSync = true;
    const channelSessionKey = `agent:octogee-alice-coach:mattermost:group:${"a".repeat(26)}`;
    await expect(openNativeUserSocket("alice", "b-alice", env, { channelSessionKey, threadRootPostId: root })).rejects.toThrow("membership synchronization failed");
    expect(state.calls.map(call => call.method)).toEqual(["users.self", "sessions.channel.sync", "sessions.describe"]);
    await vi.waitFor(() => expect(state.closed).toEqual(expect.arrayContaining(["alice", OPENCLAW_EDGE_SERVICE_IDENTITY])));
  });

  it("closes the service connection without granting membership after the user disconnects during synchronization", async () => {
    const { state, env } = await gateway();
    state.closeUserOnServiceConnect = true;
    const channelSessionKey = `agent:octogee-alice-coach:mattermost:group:${"a".repeat(26)}`;
    await expect(openNativeUserSocket("alice", "b-alice", env, { channelSessionKey, threadRootPostId: root })).rejects.toThrow("connection closed during channel synchronization");
    expect(state.calls.map(call => call.method)).toEqual(["users.self"]);
    await vi.waitFor(() => expect(state.closed).toEqual(expect.arrayContaining(["alice", OPENCLAW_EDGE_SERVICE_IDENTITY])));
  });

  it("does not guess a native profile ID when the connected user's profile is unavailable", async () => {
    const { state, env } = await gateway();
    state.profiles = [];
    const channelSessionKey = `agent:octogee-alice-coach:mattermost:group:${"a".repeat(26)}`;
    await expect(openNativeUserSocket("alice", "b-alice", env, { channelSessionKey, threadRootPostId: root })).rejects.toThrow("users.self failed: profile unavailable");
    expect(state.calls.map(call => call.method)).toEqual(["users.self"]);
    expect(state.connects.map(connect => connect.uid)).toEqual(["alice"]);
    await vi.waitFor(() => expect(state.closed).toContain("alice"));
  });

  it.each(["agent:main:main", `agent:octogee-alice-coach:mattermost:direct:${"a".repeat(26)}:thread:${root}`, `agent:octogee-alice-coach:mattermost:group:${"a".repeat(26)}:thread:${root}`])("rejects unsupported native channel identity %s before connecting", async channelSessionKey => {
    const { state, env } = await gateway();
    await expect(openNativeUserSocket("alice", "b-alice", env, { channelSessionKey, threadRootPostId: root })).rejects.toThrow("channel identity");
    expect(state.connects).toEqual([]);
  });
  it.each([
    { threadRootPostId: root },
    { channelSessionKey: `agent:octogee-alice-coach:mattermost:group:${'a'.repeat(26)}`, threadRootPostId: 'bad' },
  ])('rejects an unbound or malformed reply-root claim %j', async options => {
    const { state, env } = await gateway();
    await expect(openNativeUserSocket('alice', 'b-alice', env, options)).rejects.toThrow('channel identity');
    expect(state.connects).toEqual([]);
    expect(channelAuthority).not.toHaveBeenCalled();
  });

  it("rechecks the selected thread after profile work before granting its audience", async () => {
    const { state, env } = await gateway();
    authority.mockResolvedValueOnce({ sessionKey: `agent:octogee-alice-coach:mattermost:group:${"a".repeat(26)}` }).mockRejectedValueOnce(new Error('Thread access revoked'));
    await expect(openNativeUserSocket('alice', 'b-alice', env, { channelSessionKey: `agent:octogee-alice-coach:mattermost:group:${"a".repeat(26)}`, threadRootPostId: root })).rejects.toThrow('Thread access revoked');
    expect(state.calls.map(call => call.method)).toEqual(['users.self']);
    await vi.waitFor(() => expect(state.closed).toEqual(expect.arrayContaining(['alice', OPENCLAW_EDGE_SERVICE_IDENTITY])));
  });
  it("advertises explicit native observation capabilities without changing identity", async () => {
    const { state, env } = await gateway();
    const native = await openNativeUserSocket("alice", "b-alice", env, { caps: ["session-scoped-events"] });
    expect(state.connects[0]).toMatchObject({ uid: "alice", caps: ["session-scoped-events"] });
    native.ws.close();
  });

  it("fails closed when native effective scopes are unavailable", async () => {
    const { state, env } = await gateway();
    state.scopes = undefined;
    await expect(openNativeUserClient("alice", "b-alice", env)).rejects.toThrow("effective scopes");
  });

  it("does not open a user connection until the current boot is initialized", async () => {
    const { state, env } = await gateway();
    fs.rmSync(path.join(env.OPENCLAW_DIR, "workspace-identity-ready"));
    await expect(openNativeUserClient("alice", "b-alice", env)).rejects.toThrow("not initialized");
    expect(state.connects).toEqual([]);
  });

  it("does not connect across gateway identities or on shared gateways", async () => {
    const { state, env } = await gateway();
    await expect(openNativeUserClient("alice", "other", env)).rejects.toThrow("local per-user isolated gateway");
    await expect(openNativeUserClient("alice", "b-alice", { ...env, GATEWAY_CLASS: "shared" })).rejects.toThrow("local per-user isolated gateway");
    expect(state.connects).toEqual([]);
  });
});
