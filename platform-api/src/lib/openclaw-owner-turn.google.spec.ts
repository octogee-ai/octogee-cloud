import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import { DuplicateRecordError, MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";

import { createGoogleTurnVerifier, type OwnerTurnUser } from "./openclaw-owner-turn.js";

const REQUESTER_ID = "u".repeat(26);
const CHANNEL_ID = "c".repeat(26);

interface FakeChannel {
  path: string;
  data?: Record<string, unknown>;
}

interface FakeMember {
  mattermostUserId?: string;
  canonicalSource?: string;
  canonicalState?: string;
  mattermostChannelId?: string;
}

const MEMBER_ID = "m".repeat(26);

function activeMember(overrides: FakeMember = {}): FakeMember {
  return {
    mattermostUserId: MEMBER_ID,
    canonicalSource: "mattermost-general",
    canonicalState: "active",
    mattermostChannelId: CHANNEL_ID,
    ...overrides,
  };
}

function turnStore(input: {
  workspaceOwner?: string;
  defaultAgentDm?: Record<string, unknown>;
  channels?: FakeChannel[];
  members?: FakeMember[];
} = {}) {
  const docs: Record<string, Record<string, unknown>> = {};
  if (input.workspaceOwner !== undefined) {
    docs["workspaces/eggman"] = { id: "eggman", ownerUid: input.workspaceOwner, ownerActive: true };
  }
  if (input.defaultAgentDm !== undefined) docs["workspaces/eggman/channels/coach-dm"] = input.defaultAgentDm;
  for (const channel of input.channels ?? []) {
    docs[channel.path] = { mattermost: { channelId: CHANNEL_ID }, ...channel.data };
  }
  (input.members ?? []).forEach((member, index) => {
    docs[`workspaces/eggman/members/uid-member-${index}`] = { role: "member", ...member };
  });
  const store = createDocumentFixtureStore(docs);
  return {
    store,
    findChannel: vi.spyOn(store.workspaces.channels, "findByMattermostChannelId"),
    listMembers: vi.spyOn(store.workspaces.members, "list"),
  };
}

function input(
  requestContext: Record<string, unknown> | undefined,
  overrides: Partial<{
    agentId: string;
    ownerUid: string;
    owner: OwnerTurnUser;
  }> = {},
) {
  return {
    req: { body: { requestContext } } as Request,
    gatewayId: "isolated-gateway",
    agentId: overrides.agentId ?? "octogee-eggman-coach",
    ownerUid: overrides.ownerUid ?? "uid-eggman",
    owner: overrides.owner ?? {
      workspaceId: "eggman",
      mattermostUserId: REQUESTER_ID,
    },
  };
}

function context(to: string, overrides: Record<string, unknown> = {}) {
  return {
    channel: "mattermost",
    accountId: "eggman-coach",
    requesterSenderId: REQUESTER_ID,
    nativeChannelId: CHANNEL_ID,
    to,
    ...overrides,
  };
}

describe("createGoogleTurnVerifier", () => {
  it("allows the assigned user's direct Agent DM only through the canonical coach-dm channel", async () => {
    const harness = turnStore({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/coach-dm" }],
    });
    const verify = createGoogleTurnVerifier(harness.store);

    await expect(verify(input(context(`user:${REQUESTER_ID}`)))).resolves.toBe(true);
    expect(harness.findChannel).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it.each(["general", "coach-dm", "launchroom"])(
    "allows the assigned user in an active direct workspace %s channel",
    async (channelName) => {
      const harness = turnStore({
        workspaceOwner: "uid-eggman",
        channels: [{ path: `workspaces/eggman/channels/${channelName}` }],
      });
      const verify = createGoogleTurnVerifier(harness.store);

      await expect(verify(input(context(`channel:${CHANNEL_ID}`)))).resolves.toBe(true);
      expect(harness.findChannel).toHaveBeenCalledWith(CHANNEL_ID);
    },
  );

  it("allows an active workspace member in a workspace channel under the owner's grant", async () => {
    const harness = turnStore({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
      members: [activeMember()],
    });
    const verify = createGoogleTurnVerifier(harness.store);

    await expect(verify(input(context(`channel:${CHANNEL_ID}`, { requesterSenderId: MEMBER_ID })))).resolves.toBe(true);
    expect(harness.listMembers).toHaveBeenCalledWith("eggman");
  });

  it("does not consult the member mirror for the assigned user", async () => {
    const harness = turnStore({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
    });
    const verify = createGoogleTurnVerifier(harness.store);

    await expect(verify(input(context(`channel:${CHANNEL_ID}`)))).resolves.toBe(true);
    expect(harness.listMembers).not.toHaveBeenCalled();
  });

  it.each([
    ["non-member", []],
    ["revoking member", [activeMember({ canonicalState: "revoking" })]],
    ["member without a canonical Mattermost source", [activeMember({ canonicalSource: "manual" })]],
    ["member missing the canonical channel", [activeMember({ mattermostChannelId: undefined })]],
    ["ambiguous member mapping", [activeMember(), activeMember()]],
  ])("rejects a %s in a workspace channel", async (_label, members) => {
    const harness = turnStore({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
      members,
    });
    const verify = createGoogleTurnVerifier(harness.store);

    await expect(verify(input(context(`channel:${CHANNEL_ID}`, { requesterSenderId: MEMBER_ID })))).resolves.toBe(false);
  });

  it("keeps the coach-dm direct lane for the assigned user only", async () => {
    const harness = turnStore({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/coach-dm" }],
      members: [activeMember()],
    });
    const verify = createGoogleTurnVerifier(harness.store);

    await expect(verify(input(context(`user:${MEMBER_ID}`, { requesterSenderId: MEMBER_ID })))).resolves.toBe(false);
  });

  it("accepts the same exact trusted context from a read-only broker query", async () => {
    const harness = turnStore({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
    });
    const verify = createGoogleTurnVerifier(harness.store);
    const turn = input(undefined);
    turn.req = {
      body: {},
      query: { requestContext: JSON.stringify(context(`channel:${CHANNEL_ID}`)) },
    } as unknown as Request;

    await expect(verify(turn)).resolves.toBe(true);
  });

  it("rejects an ambiguous request with contexts in both the body and query", async () => {
    const harness = turnStore({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
    });
    const verify = createGoogleTurnVerifier(harness.store);
    const turn = input(context(`channel:${CHANNEL_ID}`));
    turn.req.query = {
      requestContext: JSON.stringify(context(`channel:${CHANNEL_ID}`)),
    };

    await expect(verify(turn)).resolves.toBe(false);
  });

  it.each([
    ["missing context", undefined, {}],
    ["wrong provider", context(`user:${REQUESTER_ID}`, { channel: "slack" }), {}],
    ["wrong account", context(`user:${REQUESTER_ID}`, { accountId: "victim-coach" }), {}],
    ["unassigned sender", context(`user:${REQUESTER_ID}`), {
      owner: { workspaceId: "eggman", mattermostUserId: "v".repeat(26) },
    }],
    ["foreign assigned workspace", context(`user:${REQUESTER_ID}`), {
      owner: { workspaceId: "victim", mattermostUserId: REQUESTER_ID },
    }],
    ["wrong DM recipient", context(`user:${"v".repeat(26)}`), {}],
    ["missing native channel", context(`user:${REQUESTER_ID}`, { nativeChannelId: undefined }), {}],
    ["invalid native channel", context(`user:${REQUESTER_ID}`, { nativeChannelId: "NOT-A-MM-ID" }), {}],
    ["project agent", context(`user:${REQUESTER_ID}`), { agentId: "octogee-eggman-proj-orbit-coach" }],
    ["claimed owner mismatch", context(`user:${REQUESTER_ID}`), { ownerUid: "uid-victim" }],
    ["invalid requester id", context(`user:${REQUESTER_ID}`, { requesterSenderId: "NOT-A-MM-ID" }), {}],
    ["forged owner flag", context(`user:${REQUESTER_ID}`, { requesterSenderId: "v".repeat(26), senderIsOwner: true }), {}],
    ["extra owner flag", context(`user:${REQUESTER_ID}`, { senderIsOwner: true }), {}],
  ])("rejects %s", async (_label, requestContext, overrides) => {
    const harness = turnStore({ workspaceOwner: "uid-eggman" });
    const verify = createGoogleTurnVerifier(harness.store);

    await expect(verify(input(requestContext, overrides))).resolves.toBe(false);
  });

  it("rejects when the workspace is missing or belongs to another owner", async () => {
    for (const workspaceOwner of [undefined, "uid-victim"]) {
      const harness = turnStore({ workspaceOwner });
      const verify = createGoogleTurnVerifier(harness.store);
      await expect(verify(input(context(`user:${REQUESTER_ID}`)))).resolves.toBe(false);
    }
  });

  it("rejects a direct-message route that does not map to coach-dm", async () => {
    const harness = turnStore({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
    });
    const verify = createGoogleTurnVerifier(harness.store);

    await expect(verify(input(context(`user:${REQUESTER_ID}`)))).resolves.toBe(false);
  });

  it("rejects a channel route that does not match the trusted native channel", async () => {
    const harness = turnStore({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/general" }],
    });
    const verify = createGoogleTurnVerifier(harness.store);

    await expect(verify(input(context(`channel:${"d".repeat(26)}`)))).resolves.toBe(false);
  });

  it.each([
    ["admin", [{ path: "workspaces/eggman/channels/admin" }]],
    ["project", [{ path: "workspaces/eggman/projects/orbit/channels/general" }]],
    ["foreign", [{ path: "workspaces/victim/channels/general" }]],
    ["community", [{ path: "communities/friends/channels/general" }]],
    ["archived", [{ path: "workspaces/eggman/channels/launchroom", data: { archivedAt: 1_800_000_000_000 } }]],
  ])("rejects a %s channel mapping", async (_label, channels) => {
    const harness = turnStore({ workspaceOwner: "uid-eggman", channels });
    const verify = createGoogleTurnVerifier(harness.store);

    await expect(verify(input(context(`channel:${CHANNEL_ID}`)))).resolves.toBe(false);
  });

  it("refuses an ambiguous channel mapping as a duplicate record", async () => {
    const harness = turnStore({
      workspaceOwner: "uid-eggman",
      channels: [
        { path: "workspaces/eggman/channels/general" },
        { path: "workspaces/eggman/channels/launchroom" },
      ],
    });
    const verify = createGoogleTurnVerifier(harness.store);

    await expect(verify(input(context(`channel:${CHANNEL_ID}`)))).rejects.toBeInstanceOf(DuplicateRecordError);
  });

  it("fails closed on a channel whose archive time is not a time", async () => {
    const harness = turnStore({
      workspaceOwner: "uid-eggman",
      channels: [{ path: "workspaces/eggman/channels/launchroom", data: { archivedAt: true } }],
    });
    const verify = createGoogleTurnVerifier(harness.store);

    await expect(verify(input(context(`channel:${CHANNEL_ID}`)))).rejects.toBeInstanceOf(MalformedRecordError);
  });

  describe("scheduled turns", () => {
    function scheduled(overrides: Record<string, unknown> = {}) {
      return {
        origin: "scheduled",
        channel: "mattermost",
        accountId: "eggman-coach",
        requesterSenderId: REQUESTER_ID,
        to: `user:${REQUESTER_ID}`,
        ...overrides,
      };
    }

    it("allows the assigned user's own scheduled job delivering to their Agent DM", async () => {
      const harness = turnStore({ workspaceOwner: "uid-eggman" });
      const verify = createGoogleTurnVerifier(harness.store);

      await expect(verify(input(scheduled()))).resolves.toBe(true);
      expect(harness.findChannel).not.toHaveBeenCalled();
      expect(harness.listMembers).not.toHaveBeenCalled();
    });

    it.each([
      ["a collaborator's job", scheduled({ requesterSenderId: MEMBER_ID, to: `user:${MEMBER_ID}` }), {}],
      ["a channel route", scheduled({ to: `channel:${CHANNEL_ID}` }), {}],
      ["a DM to someone other than the creator", scheduled({ to: `user:${MEMBER_ID}` }), {}],
      ["a creator who is not the gateway's owner", scheduled(), {
        owner: { workspaceId: "eggman", mattermostUserId: "v".repeat(26) },
      }],
      ["another agent account", scheduled({ accountId: "victim-coach" }), {}],
      ["a project agent", scheduled(), { agentId: "octogee-eggman-proj-orbit-coach" }],
      ["a native channel claim", scheduled({ nativeChannelId: CHANNEL_ID }), {}],
      ["an unknown origin", scheduled({ origin: "replay" }), {}],
      ["an owner flag", scheduled({ senderIsOwner: true }), {}],
    ])("rejects %s", async (_label, requestContext, overrides) => {
      const harness = turnStore({
        workspaceOwner: "uid-eggman",
        channels: [{ path: "workspaces/eggman/channels/general" }],
        members: [activeMember()],
      });
      const verify = createGoogleTurnVerifier(harness.store);

      await expect(verify(input(requestContext, overrides))).resolves.toBe(false);
    });

    it("allows the assigned user's own scheduled job delivering to their Agent channel", async () => {
      const harness = turnStore({
        workspaceOwner: "uid-eggman",
        defaultAgentDm: { mattermost: { channelId: CHANNEL_ID } },
      });
      const verify = createGoogleTurnVerifier(harness.store);

      await expect(verify(input(scheduled({ to: `channel:${CHANNEL_ID}` })))).resolves.toBe(true);
    });

    it.each([
      ["another channel", { mattermost: { channelId: "o".repeat(26) } }, {}],
      ["an archived Agent channel", { mattermost: { channelId: CHANNEL_ID }, archivedAt: 1 }, {}],
      ["a collaborator's job", { mattermost: { channelId: CHANNEL_ID } }, { requesterSenderId: MEMBER_ID }],
    ])("rejects a scheduled channel route to %s", async (_label, defaultAgentDm, contextOverrides) => {
      const harness = turnStore({ workspaceOwner: "uid-eggman", defaultAgentDm, members: [activeMember()] });
      const verify = createGoogleTurnVerifier(harness.store);

      await expect(verify(input(scheduled({ to: `channel:${CHANNEL_ID}`, ...contextOverrides })))).resolves.toBe(false);
    });

    it("rejects a scheduled job when the workspace belongs to another owner", async () => {
      const harness = turnStore({ workspaceOwner: "uid-victim" });
      const verify = createGoogleTurnVerifier(harness.store);

      await expect(verify(input(scheduled()))).resolves.toBe(false);
    });
  });
});
