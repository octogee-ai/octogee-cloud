import { beforeEach, describe, expect, it, vi } from "vitest";

const channelId = "c".repeat(26);

const h = vi.hoisted(() => ({
  activeProjectReads: 0,
  maxActiveProjectReads: 0,
  projectReadsStarted: 0,
  holdProjectReads: false,
  releaseProjectReads: (() => undefined) as () => void,
  projectReadGate: Promise.resolve() as Promise<void>,
  documents: new Map<string, Record<string, unknown>>(),
  createClientCalls: 0,
  denyMembership: false,
}));

function resetProjectGate(): void {
  h.projectReadGate = new Promise<void>((resolve) => {
    h.releaseProjectReads = () => {
      h.holdProjectReads = false;
      resolve();
    };
  });
}

vi.mock("../identity/platform-state-store.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.documents) };
});

vi.mock("../workspace/workspace-resolution.js", () => ({
  resolveWorkspaceUid: async () => "owner-uid",
}));

vi.mock("./channel-session-model-control.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./channel-session-model-control.js")>();
  return {
    ...actual,
    createChannelSessionMattermostClient: () => {
      h.createClientCalls += 1;
      return {
        getCurrentUserId: async () => "u".repeat(26),
        getJson: async () => {
          if (h.denyMembership) throw new actual.ChannelSessionMattermostError("Forbidden", 403);
          return {};
        },
      };
    },
  };
});

const {
  authorizeChannel,
  listWorkspaceChannelCandidates,
} = await import("./channel-session-authorization.js");
const { platformStateStore } = await import("../identity/platform-state-store.js");

const listChannels = platformStateStore.workspaces.channels.list;
const findChannel = vi.spyOn(platformStateStore.workspaces.channels, "findByMattermostChannelId");
vi.spyOn(platformStateStore.workspaces.channels, "list").mockImplementation(async (scope) => {
  if (scope.projectSlug === null) return listChannels(scope);
  h.activeProjectReads += 1;
  h.projectReadsStarted += 1;
  h.maxActiveProjectReads = Math.max(h.maxActiveProjectReads, h.activeProjectReads);
  if (h.holdProjectReads) await h.projectReadGate;
  h.activeProjectReads -= 1;
  return listChannels(scope);
});

const ledger = {
  path: "workspaces/alice/channels/general",
};

function setLedger(path: string, data: Record<string, unknown>): void {
  h.documents.delete(ledger.path);
  ledger.path = path;
  h.documents.set(path, data);
}

function patchLedger(fields: Record<string, unknown>): void {
  h.documents.set(ledger.path, { ...h.documents.get(ledger.path), ...fields });
}

function seedProjects(count: number): void {
  for (let index = 0; index < count; index += 1) {
    h.documents.set(`workspaces/alice/projects/project-${index}`, { ownerUid: "owner-uid" });
  }
}

function seedProjectChannels(project: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    h.documents.set(`workspaces/alice/projects/${project}/channels/task-${index}`, {});
  }
}

beforeEach(() => {
  h.activeProjectReads = 0;
  h.maxActiveProjectReads = 0;
  h.projectReadsStarted = 0;
  h.holdProjectReads = false;
  h.documents.clear();
  h.documents.set("users/caller", { mattermost: { userId: "u".repeat(26) } });
  h.documents.set("users/caller/secrets/mattermost", { personalToken: "t".repeat(32) });
  h.documents.set("users/owner-uid/secrets/coachMattermost", {
    personalToken: "coach-token",
    coachMmUserId: "a".repeat(26),
  });
  setLedger("workspaces/alice/channels/general", { kind: "general", mattermost: { channelId } });
  h.createClientCalls = 0;
  h.denyMembership = false;
  findChannel.mockClear();
  resetProjectGate();
});

describe("channel session authorization discovery", () => {
  it("bounds project channel ledger reads and stops launching work after cancellation", async () => {
    seedProjects(24);
    h.holdProjectReads = true;
    const controller = new AbortController();
    const discovery = listWorkspaceChannelCandidates("alice", controller.signal);

    await vi.waitFor(() => expect(h.projectReadsStarted).toBe(8));
    expect(h.maxActiveProjectReads).toBe(8);

    controller.abort(new Error("RPC deadline expired"));
    await expect(discovery).rejects.toThrow("RPC deadline expired");
    expect(h.projectReadsStarted).toBe(8);
    h.releaseProjectReads();
  });

  it("rejects an archived ledger binding when active discovery is required", async () => {
    patchLedger({ archivedAt: 100 });

    await expect(authorizeChannel(
      "caller",
      channelId,
      "alice",
      { requireActiveLedger: true },
    )).resolves.toBeNull();
    expect(h.createClientCalls).toBe(0);
    expect(findChannel).toHaveBeenCalledWith(channelId);
  });

  it("rejects reserved and malformed ledger bindings when active discovery is required", async () => {
    setLedger("workspaces/alice/channels/coach-dm", { kind: "session", mattermost: { channelId } });
    await expect(authorizeChannel(
      "caller",
      channelId,
      "alice",
      { requireActiveLedger: true },
    )).resolves.toBeNull();

    setLedger("workspaces/alice/channels/general", { kind: "session", mattermost: { channelId } });
    await expect(authorizeChannel(
      "caller",
      channelId,
      "alice",
      { requireActiveLedger: true },
    )).rejects.toThrow("Workspace channel ledger was invalid");
    expect(h.createClientCalls).toBe(0);
  });

  it("denies a Mattermost channel that two channel ledgers claim", async () => {
    h.documents.set("workspaces/mallory/channels/general", { kind: "general", mattermost: { channelId } });

    await expect(authorizeChannel("caller", channelId, "alice")).resolves.toBeNull();
    expect(h.createClientCalls).toBe(0);
  });

  it("stops reading later project ledgers as soon as the global channel bound is exceeded", async () => {
    seedProjects(24);
    seedProjectChannels("project-0", 513);

    await expect(listWorkspaceChannelCandidates("alice")).rejects.toThrow(
      "Workspace channel directory exceeded its limit",
    );
    expect(h.projectReadsStarted).toBe(8);
  });

  it("rejects an archived parent project for an otherwise active channel binding", async () => {
    setLedger("workspaces/alice/projects/orbit/channels/general", { kind: "general", mattermost: { channelId } });
    h.documents.set("workspaces/alice/projects/orbit", {
      ownerUid: "owner-uid",
      commercialLifecycle: { status: "archived" },
      agent: { mode: "scoped", enabled: true },
    });
    h.documents.set("users/owner-uid/secrets/projectAgentMattermost-orbit", {
      mmUserId: "a".repeat(26),
      personalToken: "t".repeat(32),
    });

    await expect(authorizeChannel(
      "caller",
      channelId,
      "alice",
      { requireActiveLedger: true },
    )).resolves.toBeNull();
    expect(h.createClientCalls).toBe(0);
  });
});


describe("workspace conversation channel authority", () => {
  it.each([["general", "general"], ["coach-dm", "coach-dm"], ["planning", "session"]])("accepts workspace %s with its exact channel identity", async (id, kind) => {
    setLedger(`workspaces/alice/channels/${id}`, { kind, mattermost: { channelId } });
    await expect(authorizeChannel("caller", channelId, "alice", { workspaceConversation: true })).resolves.toMatchObject({ target: { workspaceSlug: "alice", agentId: "octogee-alice-coach" } });
  });
  it.each([
    ["admin", "workspaces/alice/channels/admin", "admin"],
    ["general", "workspaces/alice/projects/project/channels/general", "general"],
    ["general", "community/channels/general", "general"],
    ["coach-dm", "workspaces/alice/channels/coach-dm", "session"],
  ])("rejects unrelated or malformed workspace conversations %s %s", async (id, path, kind) => {
    setLedger(path, { kind, mattermost: { channelId } });
    await expect(authorizeChannel("caller", channelId, "alice", { workspaceConversation: true })).resolves.toBeNull();
    expect(h.createClientCalls).toBe(0);
  });
  it("rejects archived workspace conversation ledgers", async () => {
    patchLedger({ archivedAt: 100 });
    await expect(authorizeChannel("caller", channelId, "alice", { workspaceConversation: true })).resolves.toBeNull();
  });
});


describe("readiness active Agent conversation authority", () => {
  const options = { requireActiveLedger: true, includeDefaultAgentConversation: true };
  function defaultAgentLedger(): void {
    setLedger("workspaces/alice/channels/coach-dm", { kind: "coach-dm", mattermost: { channelId } });
  }
  it("authorizes the canonical private Agent conversation without making it discoverable", async () => {
    defaultAgentLedger();
    await expect(authorizeChannel("caller", channelId, "alice", options)).resolves.toMatchObject({
      target: { workspaceSlug: "alice", agentId: "octogee-alice-coach" },
    });
    await expect(authorizeChannel("caller", channelId, "alice", { requireActiveLedger: true })).resolves.toBeNull();
  });
  it("still requires live Mattermost membership for the Agent conversation", async () => {
    defaultAgentLedger(); h.denyMembership = true;
    await expect(authorizeChannel("caller", channelId, "alice", options)).resolves.toEqual({ forbidden: true });
  });
  it.each(["archived", "wrong-kind", "admin"])("rejects %s Agent ledger bindings", async (failure) => {
    defaultAgentLedger();
    if (failure === "archived") patchLedger({ archivedAt: 100 });
    if (failure === "wrong-kind") patchLedger({ kind: "session" });
    if (failure === "admin") setLedger("workspaces/alice/channels/admin", { kind: "admin", mattermost: { channelId } });
    await expect(authorizeChannel("caller", channelId, "alice", options)).resolves.toBeNull();
    expect(h.createClientCalls).toBe(0);
  });
  it("still rejects archived parent projects when Agent conversations are included", async () => {
    setLedger("workspaces/alice/projects/orbit/channels/general", { kind: "general", mattermost: { channelId } });
    h.documents.set("workspaces/alice/projects/orbit", { ownerUid: "owner-uid", commercialLifecycle: { status: "archived" } });
    await expect(authorizeChannel("caller", channelId, "alice", options)).resolves.toBeNull();
  });
});

describe('project voice channel authority', () => {
  function project() {
    setLedger('workspaces/alice/projects/orbit/channels/general', { kind: 'general', mattermost: { channelId } });
    h.documents.set('workspaces/alice/projects/orbit', { ownerUid: 'owner-uid', agent: { status: 'ready' } });
    h.documents.set('users/owner-uid/secrets/projectAgentMattermost-orbit', { mmUserId: 'p'.repeat(26), personalToken: 'project-token' });
  }
  it('resolves the project agent under live channel membership', async () => {
    project();
    await expect(authorizeChannel('caller', channelId, 'alice', { voiceConversation: true })).resolves.toMatchObject({ target: { projectId: 'orbit', agentId: 'octogee-alice-proj-orbit-coach' } });
    await expect(authorizeChannel('caller', channelId, 'alice', { workspaceConversation: true })).resolves.toBeNull();
  });
  it.each(['missing-agent', 'missing-credential', 'archived-project', 'archived-channel', 'revoked-member'])('rejects %s without routing to the workspace agent', async failure => {
    project();
    if (failure === 'missing-agent') h.documents.set('workspaces/alice/projects/orbit', { ownerUid: 'owner-uid' });
    if (failure === 'missing-credential') h.documents.delete('users/owner-uid/secrets/projectAgentMattermost-orbit');
    if (failure === 'archived-project') h.documents.set('workspaces/alice/projects/orbit', { ownerUid: 'owner-uid', agent: {}, commercialLifecycle: { status: 'archived' } });
    if (failure === 'archived-channel') patchLedger({ archivedAt: 1 });
    if (failure === 'revoked-member') h.denyMembership = true;
    const result = await authorizeChannel('caller', channelId, 'alice', { voiceConversation: true });
    expect(result === null || result.forbidden).toBe(true);
  });
});
