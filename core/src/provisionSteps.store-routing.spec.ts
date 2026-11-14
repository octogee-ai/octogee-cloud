import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const write = () => vi.fn(async (..._args: unknown[]): Promise<void> => undefined);
  const records = {
    get: vi.fn(async () => ({ role: "user" })),
    patch: write(),
    addAgents: write(),
    setActivatedAgents: write(),
  };
  const workspaces = {
    records: { get: vi.fn(async (): Promise<unknown> => null), put: write(), patch: write() },
    channels: { get: vi.fn(async (): Promise<unknown> => null), put: write(), patch: write() },
    members: { get: vi.fn(async (): Promise<unknown> => null), put: write() },
    agentIdentities: { put: write() },
  };
  const store = {
    users: { records },
    workspaces,
    transaction: (_options: unknown, body: (transaction: unknown) => Promise<unknown>) => body(store),
  };
  return { records, workspaces, store };
});

vi.mock("./provisioner-platform-state.js", () => ({ platformStateStore: h.store }));

import {
  buildProvisioningContext,
  markProvisioningComplete,
  noProvisioningProjection,
  type ProvisioningProjection,
} from "./provisionSteps.js";

const SERVER_NOW = { serverNow: true };
const ctx = buildProvisioningContext("u1", { username: "acme", tier: "pro" });
const mmUpdate = {
  "mattermost.userId": "mm-user",
  "mattermost.username": "acme",
  "mattermost.teamId": "mm-team",
  "mattermost.channelId": "mm-coach-dm",
  "mattermost.channelName": "octogee-acme-coach",
  "mattermost.generalChannelId": "mm-general",
  "mattermost.coachUserId": "mm-coach",
};

function recordingProjection() {
  const projection = {
    storedMattermostNames: vi.fn(noProvisioningProjection.storedMattermostNames),
    systemConfig: vi.fn(noProvisioningProjection.systemConfig),
    user: vi.fn(noProvisioningProjection.user),
    workspace: vi.fn(noProvisioningProjection.workspace),
    channel: vi.fn(noProvisioningProjection.channel),
    agent: vi.fn(noProvisioningProjection.agent),
    workspaceEntry: vi.fn(noProvisioningProjection.workspaceEntry),
  } satisfies ProvisioningProjection;
  return projection;
}

let projection = recordingProjection();

describe("markProvisioningComplete store routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projection = recordingProjection();
  });

  it("records the user's platform provisioning state through the store", async () => {
    await markProvisioningComplete(ctx, mmUpdate, ["octogee-acme-coach", "octogee-second"], projection);

    expect(h.records.patch).toHaveBeenCalledWith("u1", {
      slug: "acme",
      workspaceId: "acme",
      mattermostUserId: "mm-user",
      openclaw: { version: "v1", customerDir: ctx.customerDir, provisionedAt: SERVER_NOW },
    });
    expect(h.records.addAgents).toHaveBeenCalledWith("u1", ["octogee-acme-coach", "octogee-second"]);
    expect(h.records.setActivatedAgents).toHaveBeenCalledWith("u1", ["coach"]);
  });

  it("records the same platform state without a product projection", async () => {
    await markProvisioningComplete(ctx, mmUpdate, ["octogee-acme-coach"], noProvisioningProjection);

    expect(h.records.patch).toHaveBeenCalledWith("u1", expect.objectContaining({ slug: "acme", mattermostUserId: "mm-user" }));
    expect(h.records.addAgents).toHaveBeenCalledWith("u1", ["octogee-acme-coach"]);
    expect(h.workspaces.records.put).toHaveBeenCalledWith(expect.objectContaining({ slug: "acme", mattermostTeamId: "mm-team" }));
    expect(h.workspaces.channels.put).toHaveBeenCalledTimes(2);
    expect(h.workspaces.members.put).toHaveBeenCalledWith(expect.objectContaining({ uid: "u1", role: "owner" }));
    expect(h.workspaces.agentIdentities.put).toHaveBeenCalledWith(expect.objectContaining({ uid: "u1", mattermostUserId: "mm-coach" }));
  });

  it("hands the product projection each provisioned record", async () => {
    await markProvisioningComplete(ctx, mmUpdate, ["octogee-acme-coach"], projection);

    expect(projection.systemConfig).toHaveBeenCalledWith(ctx);
    expect(projection.user).toHaveBeenCalledWith(ctx, mmUpdate);
    expect(projection.workspace).toHaveBeenCalledWith(ctx);
    expect(projection.agent).toHaveBeenCalledWith(ctx);
    expect(projection.workspaceEntry).toHaveBeenCalledWith(ctx, ["octogee-acme-coach"]);
  });

  it("records the workspace and owner through the store", async () => {
    await markProvisioningComplete(ctx, mmUpdate, [], projection);

    expect(h.workspaces.records.put).toHaveBeenCalledWith({
      slug: "acme",
      id: "acme",
      ownerUid: "u1",
      ownerActive: null,
      mattermostTeamId: "mm-team",
      giteaOrgName: "acme",
      giteaRepoName: expect.any(String),
      createdAt: SERVER_NOW,
      updatedAt: SERVER_NOW,
    });
    expect(h.workspaces.members.put).toHaveBeenCalledWith({
      workspaceSlug: "acme",
      uid: "u1",
      role: "owner",
      joinedAt: SERVER_NOW,
      mattermostUserId: "mm-user",
    });
  });

  it("does not clear a workspace's team when the update carries none", async () => {
    h.workspaces.records.get.mockResolvedValueOnce({ slug: "acme", mattermostTeamId: "mm-existing" });

    await markProvisioningComplete(ctx, { "mattermost.generalChannelId": "mm-general" }, [], projection);

    expect(h.workspaces.records.put).not.toHaveBeenCalled();
    expect(h.workspaces.records.patch).toHaveBeenCalledTimes(1);
    expect(h.workspaces.records.patch.mock.calls[0]?.[1]).not.toHaveProperty("mattermostTeamId");
  });

  it("replaces a workspace's team when the update carries one", async () => {
    h.workspaces.records.get.mockResolvedValueOnce({ slug: "acme", mattermostTeamId: "mm-existing" });

    await markProvisioningComplete(ctx, mmUpdate, [], projection);

    expect(h.workspaces.records.patch).toHaveBeenCalledWith("acme", expect.objectContaining({ mattermostTeamId: "mm-team" }));
  });

  it("seeds each primary channel through the store and hands the product its name", async () => {
    await markProvisioningComplete(ctx, mmUpdate, [], projection);

    const scope = { workspaceSlug: "acme", projectSlug: null };
    const channel = { scope, archivedAt: null, createdBy: null, createdAt: SERVER_NOW };
    expect(h.workspaces.channels.put).toHaveBeenCalledWith({
      ...channel,
      channelId: "general",
      kind: "general",
      mattermostChannelId: "mm-general",
    });
    expect(h.workspaces.channels.put).toHaveBeenCalledWith({
      ...channel,
      channelId: "coach-dm",
      kind: "coach-dm",
      mattermostChannelId: "mm-coach-dm",
    });
    expect(projection.channel).toHaveBeenCalledWith(ctx, "general", "general");
    expect(projection.channel).toHaveBeenCalledWith(ctx, "coach-dm", "octogee-acme-coach");
  });

  it("seeds only the channels the update carries", async () => {
    await markProvisioningComplete(ctx, { "mattermost.generalChannelId": "mm-general" }, [], projection);

    expect(h.workspaces.channels.put).toHaveBeenCalledTimes(1);
    expect(h.workspaces.channels.put).toHaveBeenCalledWith(expect.objectContaining({ channelId: "general" }));
    expect(projection.channel).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing channel's creation record and updates only its Mattermost channel", async () => {
    h.workspaces.channels.get.mockResolvedValueOnce({ channelId: "general" });

    await markProvisioningComplete(ctx, { "mattermost.generalChannelId": "mm-general" }, [], projection);

    expect(h.workspaces.channels.put).not.toHaveBeenCalled();
    expect(h.workspaces.channels.patch).toHaveBeenCalledWith(
      { workspaceSlug: "acme", projectSlug: null },
      "general",
      { mattermostChannelId: "mm-general" },
    );
  });

  it("leaves an existing owner membership alone", async () => {
    h.workspaces.members.get.mockResolvedValueOnce({ uid: "u1", role: "owner" });

    await markProvisioningComplete(ctx, mmUpdate, [], projection);

    expect(h.workspaces.members.put).not.toHaveBeenCalled();
  });

  it("records the agent's identity through the store", async () => {
    await markProvisioningComplete(ctx, mmUpdate, [], projection);

    expect(h.workspaces.agentIdentities.put).toHaveBeenCalledWith({
      uid: "u1",
      mattermostUserId: "mm-coach",
      at: SERVER_NOW,
    });
  });

  it("writes no agent identity when the update has no agent user", async () => {
    await markProvisioningComplete(ctx, { "mattermost.generalChannelId": "mm-general" }, [], projection);

    expect(h.workspaces.agentIdentities.put).not.toHaveBeenCalled();
    expect(projection.agent).not.toHaveBeenCalled();
  });
});

describe("stored Mattermost names", () => {
  it("has no stored names without a product projection", async () => {
    await expect(noProvisioningProjection.storedMattermostNames("u1", "acme"))
      .resolves.toEqual({ username: null, coachChannelName: null });
  });
});
