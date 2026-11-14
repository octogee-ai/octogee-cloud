import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  mmApi: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  verifiedId: vi.fn(),
}));
vi.mock("../lib/mattermost.js", () => ({ mmApi: h.mmApi }));
vi.mock("../lib/channel-lifecycle.js", () => ({
  addChannelMember: h.add,
  addActiveChannelMember: h.add,
  removeChannelMember: h.remove,
  verifiedPrimaryChannelIdFor: h.verifiedId,
}));

const { enrollWorkspaceChannelMembers } = await import("../lib/workspace-channel-membership.js");

beforeEach(() => {
  vi.resetAllMocks();
  h.add.mockResolvedValue(true);
  h.verifiedId.mockResolvedValue("general-mm");
  h.mmApi.mockImplementation(async (path: string) => {
    if (path.includes("?")) return [{ user_id: "owner" }, { user_id: "guest" }];
    return { user_id: path.split("/").at(-1), channel_id: "general-mm" };
  });
});

describe("enrollWorkspaceChannelMembers", () => {
  it("enrolls General members in a new workspace group using verified channel bindings", async () => {
    await enrollWorkspaceChannelMembers("mira", "planning");
    expect(h.verifiedId).toHaveBeenCalledWith("workspaces/mira/channels/general");
    expect(h.add.mock.calls).toEqual([
      ["workspaces/mira/channels/planning", "owner"],
      ["workspaces/mira/channels/planning", "guest"],
    ]);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it.each(["coach-dm", "admin", "general", "../other"])("refuses enrollment into %s", async (name) => {
    await expect(enrollWorkspaceChannelMembers("mira", name)).rejects.toThrow();
    expect(h.add).not.toHaveBeenCalled();
  });

  it("removes a stale member who leaves General while new-channel enrollment is in flight", async () => {
    h.mmApi.mockImplementation(async (path: string) => {
      if (path.includes("?")) return [{ user_id: "guest" }];
      throw Object.assign(new Error("membership not found"), { status: 404 });
    });
    await enrollWorkspaceChannelMembers("mira", "planning");
    expect(h.add).toHaveBeenCalledWith("workspaces/mira/channels/planning", "guest");
    expect(h.remove).toHaveBeenCalledWith("workspaces/mira/channels/planning", "guest");
  });

  it("does not turn a failed authorization read into successful enrollment", async () => {
    h.mmApi.mockImplementation(async (path: string) => {
      if (path.includes("?")) return [{ user_id: "guest" }];
      throw Object.assign(new Error("Mattermost unavailable"), { status: 503 });
    });
    await expect(enrollWorkspaceChannelMembers("mira", "planning")).rejects.toThrow("Mattermost unavailable");
    expect(h.remove).toHaveBeenCalledWith("workspaces/mira/channels/planning", "guest");
  });

  it("paginates General membership", async () => {
    const firstPage = Array.from({ length: 200 }, (_, i) => ({ user_id: `member-${i}` }));
    h.mmApi.mockImplementation(async (path: string) => {
      if (path.includes("page=0")) return firstPage;
      if (path.includes("page=1")) return [{ user_id: "last-member" }];
      return { user_id: path.split("/").at(-1), channel_id: "general-mm" };
    });
    await enrollWorkspaceChannelMembers("mira", "planning");
    expect(h.add).toHaveBeenCalledTimes(201);
    expect(h.add).toHaveBeenLastCalledWith("workspaces/mira/channels/planning", "last-member");
  });
});
