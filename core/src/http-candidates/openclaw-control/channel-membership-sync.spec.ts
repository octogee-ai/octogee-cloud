import { describe, expect, it, vi } from "vitest";
import { synchronizeChannelMemberships, type ChannelMembershipRpc } from "./channel-membership-sync.js";

const key = (id: string) => `agent:octogee-alice-coach:mattermost:group:${id.repeat(26)}`;

function gateway(input: { keys?: string[]; members?: Record<string, unknown[]>; incomplete?: boolean; fail?: string } = {}) {
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === input.fail) return { ok: false as const, reason: "unavailable" };
    const result = method === "sessions.list"
      ? { sessions: (input.keys ?? []).map((sessionKey) => ({ key: sessionKey })), hasMore: input.incomplete ?? false }
      : method === "session.members.listEvidence"
        ? { members: input.members?.[String(params.sessionKey)] ?? [] }
        : { changed: true };
    return { ok: true as const, result };
  });
  return { rpc: { call: call as ChannelMembershipRpc["call"] }, call };
}

const member = { identityId: "member", addedBy: "service" };
const base = { profileId: "member", serviceProfileId: "service" };

describe("Mattermost native session membership projection", () => {
  it('preserves selected thread audiences when their exact current room is authorized', async () => {
    const threaded = `${key('a')}:thread:${'r'.repeat(26)}`;
    const { rpc, call } = gateway({ keys: [threaded], members: { [threaded]: [member] } });
    await synchronizeChannelMemberships({ ...base, rpc, authorized: [{ key: key('a') }] });
    expect(call.mock.calls.filter(([method]) => method === 'session.members.listEvidence')).toHaveLength(0);
    expect(call.mock.calls.filter(([method]) => method === 'sessions.channel.sync').map(([,params]) => params.member)).toEqual([true]);
  });
  it('revokes only source-owned exact thread memberships for a removed room', async () => {
    const selected = `${key('a')}:thread:${'r'.repeat(26)}`;
    const explicit = `${key('a')}:thread:${'s'.repeat(26)}`;
    const { rpc, call } = gateway({ keys: [selected, explicit], members: { [selected]: [member], [explicit]: [{ ...member, addedBy: 'owner' }] } });
    await synchronizeChannelMemberships({ ...base, rpc, authorized: [] });
    expect(call.mock.calls.filter(([method]) => method === 'sessions.channel.sync')).toEqual([['sessions.channel.sync', { agentId: 'octogee-alice-coach', channel: 'mattermost', peerKind: 'group', peerId: 'a'.repeat(26), threadRootPostId: 'r'.repeat(26), profileId: 'member', member: false }]]);
  });
  it("revokes removed channel membership before granting a newly joined channel", async () => {
    const { rpc, call } = gateway({ keys: [key("a")], members: { [key("a")]: [member] } });
    await synchronizeChannelMemberships({ ...base, rpc, authorized: [{ key: key("b"), displayName: "Project" }] });
    expect(call.mock.calls.filter(([method]) => method === "sessions.channel.sync").map(([, params]) => params))
      .toEqual([
        { agentId: "octogee-alice-coach", channel: "mattermost", peerKind: "group", peerId: "a".repeat(26), profileId: "member", member: false },
        { agentId: "octogee-alice-coach", channel: "mattermost", peerKind: "group", peerId: "b".repeat(26), profileId: "member", member: true, displayName: "Project" },
      ]);
  });

  it("does not remove another authority's grants or another person's membership", async () => {
    const { rpc, call } = gateway({ keys: [key("a"), "agent:main:dashboard:private"], members: {
      [key("a")]: [{ ...member, addedBy: "owner" }, { ...member, identityId: "someone-else" }],
    } });
    await synchronizeChannelMemberships({ ...base, rpc, authorized: [] });
    expect(call.mock.calls.map(([method]) => method)).toEqual(["sessions.list", "session.members.listEvidence"]);
  });

  it.each([
    { incomplete: true },
    { fail: "sessions.list" },
    { keys: [key("a")], fail: "session.members.listEvidence" },
  ])("does not grant from an incomplete native directory: %j", async (input) => {
    const { rpc, call } = gateway(input);
    await expect(synchronizeChannelMemberships({ ...base, rpc, authorized: [{ key: key("b") }] })).rejects.toThrow();
    expect(call.mock.calls.some(([method]) => method === "sessions.channel.sync")).toBe(false);
  });

  it("keeps a rejected channel closed and records only bounded provenance diagnostics", async () => {
    const call = vi.fn(async (method: string) => {
      if (method === "sessions.list") return { ok: true as const, result: { sessions: [] } };
      if (method === "sessions.channel.sync") return { ok: false as const, reason: "session does not match channel provenance" };
      return { ok: true as const, result: { session: { key: key("a"), createdVia: "operator", incognito: false, visibility: "private", origin: { provider: "mattermost", chatType: "group", nativeChannelId: "a".repeat(26) }, lastMessage: "private text" } } };
    });
    const rpc = { call: call as ChannelMembershipRpc["call"] };
    const failure = await synchronizeChannelMemberships({ ...base, rpc, authorized: [{ key: key("a") }, { key: key("b") }] }).catch(error => error);
    expect(failure.diagnostics).toEqual({ agentId: "octogee-alice-coach", channelId: "a".repeat(26), member: true,
      metadataAvailable: true, channelCreated: false, creationSource: "operator", incognito: false, draft: false, matchingOrigin: true });
    expect(failure.message).toBe("Native channel membership synchronization failed");
    expect(call.mock.calls.map(([method]) => method)).toEqual(["sessions.list", "sessions.channel.sync", "sessions.describe"]);
    expect(call).toHaveBeenLastCalledWith("sessions.describe", { key: key("a"), agentId: "octogee-alice-coach", includeDerivedTitles: false, includeLastMessage: false });
  });

  it.each([
    { createdVia: "talk", expected: "talk" },
    { createdVia: undefined, expected: "missing" },
    { createdVia: "private upstream details", expected: "other" },
  ])("distinguishes missing and Talk provenance without exposing unexpected metadata: $expected", async ({ createdVia, expected }) => {
    const call = vi.fn(async (method: string) => {
      if (method === "sessions.list") return { ok: true as const, result: { sessions: [] } };
      if (method === "sessions.channel.sync") return { ok: false as const, reason: "provenance mismatch" };
      return { ok: true as const, result: { session: { key: key("a"), createdVia } } };
    });
    const rpc = { call: call as ChannelMembershipRpc["call"] };
    const failure = await synchronizeChannelMemberships({ ...base, rpc, authorized: [{ key: key("a") }] }).catch(error => error);
    expect(failure.diagnostics.creationSource).toBe(expected);
    expect(JSON.stringify(failure.diagnostics)).not.toContain("private upstream details");
  });

  it.each([false, true])("does not expose upstream failures when metadata is unavailable (throws: %s)", async throws => {
    const call = vi.fn(async (method: string) => {
      if (method === "sessions.list") return { ok: true as const, result: { sessions: [] } };
      if (method === "sessions.describe" && throws) throw new Error("private upstream details");
      return { ok: false as const, reason: "private upstream details" };
    });
    const rpc = { call: call as ChannelMembershipRpc["call"] };
    const failure = await synchronizeChannelMemberships({ ...base, rpc, authorized: [{ key: key("a") }] }).catch(error => error);
    expect(failure.diagnostics).toEqual({ agentId: "octogee-alice-coach", channelId: "a".repeat(26), member: true, metadataAvailable: false });
    expect(failure.message).toBe("Native channel membership synchronization failed");
    expect(call.mock.calls.filter(([method]) => method === "sessions.channel.sync")).toHaveLength(1);
  });

  it("stops before grants if revocation fails", async () => {
    const { rpc, call } = gateway({ keys: [key("a")], members: { [key("a")]: [member] }, fail: "sessions.channel.sync" });
    await expect(synchronizeChannelMemberships({ ...base, rpc, authorized: [{ key: key("b") }] })).rejects.toThrow();
    expect(call.mock.calls.filter(([method]) => method === "sessions.channel.sync")).toHaveLength(1);
    expect(call.mock.calls.find(([method]) => method === "sessions.channel.sync")?.[1].member).toBe(false);
  });
});
