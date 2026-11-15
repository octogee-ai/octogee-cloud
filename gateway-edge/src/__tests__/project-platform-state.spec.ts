import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDocumentPresentation } from "./helpers/project-presentation.js";
import { installProjectPresentation, NO_PROJECT_PRESENTATION } from "@octogee/core/identity/project-presentation";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  updates: [] as { path: string; data: Record<string, unknown> }[],
  sets: [] as { path: string; data: Record<string, unknown>; projectStillStored: boolean }[],
  onUpdate: null as (() => void) | null,
}));

const documentFake = (path: string) => ({
      update: async (data: Record<string, unknown>) => {
        h.updates.push({ path, data });
        h.onUpdate?.();
      },
      set: async (data: Record<string, unknown>) => {
        h.sets.push({ path, data, projectStillStored: h.docs.has(path) });
      },
    });

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

const {
  addProjectMember,
  deleteProjectPlatformState,
  removeProjectMember,
  syncProjectMemberCount,
} = await import("../lib/project-platform-state.js");

installDocumentPresentation(documentFake);

const PROJECT = "workspaces/mira/projects/orbit";

beforeEach(() => {
  h.docs.clear();
  h.updates.length = 0;
  h.sets.length = 0;
  h.onUpdate = null;
  h.docs.set(PROJECT, { ownerUid: "owner-1", provisioningState: "active" });
});

describe("syncProjectMemberCount", () => {
  it("counts the owner once, whether or not the owner has a member record", async () => {
    h.docs.set(`${PROJECT}/members/owner-1`, { role: "owner" });
    h.docs.set(`${PROJECT}/members/member-1`, { role: "member" });

    await syncProjectMemberCount("mira", "orbit");

    expect(h.updates).toEqual([{ path: PROJECT, data: { memberCount: 2 } }]);
  });

  it("publishes again when a membership change lands behind the count it just wrote", async () => {
    h.docs.set(`${PROJECT}/members/member-1`, { role: "member" });
    h.onUpdate = () => {
      h.onUpdate = null;
      h.docs.set(`${PROJECT}/members/member-2`, { role: "member" });
    };

    await syncProjectMemberCount("mira", "orbit");

    expect(h.updates.map((update) => update.data.memberCount)).toEqual([2, 3]);
  });

  it("stops publishing and warns when membership never settles", async () => {
    let added = 0;
    h.onUpdate = () => {
      added += 1;
      h.docs.set(`${PROJECT}/members/member-${added}`, { role: "member" });
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await syncProjectMemberCount("mira", "orbit");

    expect(h.updates).toHaveLength(5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("kept changing"));
    warn.mockRestore();
  });

  it("writes nothing when the project is gone", async () => {
    h.docs.delete(PROJECT);

    await syncProjectMemberCount("mira", "orbit");

    expect(h.updates).toEqual([]);
  });
});

describe("addProjectMember", () => {
  it("adds the member, stamps the project, and repairs the count", async () => {
    await addProjectMember("mira", "orbit", "member-1");

    expect(h.docs.get(`${PROJECT}/members/member-1`)).toMatchObject({ role: "member", joinedAt: expect.any(Number) });
    expect(h.docs.get(PROJECT)?.updatedAt).toEqual(expect.any(Number));
    expect(h.updates).toEqual([{ path: PROJECT, data: { memberCount: 2 } }]);
  });

  it("keeps the original record and still repairs the count on a retried add", async () => {
    h.docs.set(`${PROJECT}/members/member-1`, { role: "member", joinedAt: 5 });

    await addProjectMember("mira", "orbit", "member-1");

    expect(h.docs.get(`${PROJECT}/members/member-1`)).toMatchObject({ joinedAt: 5 });
    expect(h.docs.get(PROJECT)).not.toHaveProperty("updatedAt");
    expect(h.updates).toEqual([{ path: PROJECT, data: { memberCount: 2 } }]);
  });

  it("refuses to add a member to a project that no longer exists", async () => {
    h.docs.delete(PROJECT);

    await expect(addProjectMember("mira", "orbit", "member-1")).rejects.toThrow("not found");

    expect(h.docs.has(`${PROJECT}/members/member-1`)).toBe(false);
    expect(h.updates).toEqual([]);
  });
});

describe("removeProjectMember", () => {
  it("removes the member, stamps the project, and repairs the count", async () => {
    h.docs.set(`${PROJECT}/members/member-1`, { role: "member" });

    await removeProjectMember("mira", "orbit", "member-1");

    expect(h.docs.has(`${PROJECT}/members/member-1`)).toBe(false);
    expect(h.docs.get(PROJECT)?.updatedAt).toEqual(expect.any(Number));
    expect(h.updates).toEqual([{ path: PROJECT, data: { memberCount: 1 } }]);
  });

  it("repairs the count on a retried removal without stamping the project", async () => {
    await removeProjectMember("mira", "orbit", "member-1");

    expect(h.docs.get(PROJECT)).not.toHaveProperty("updatedAt");
    expect(h.updates).toEqual([{ path: PROJECT, data: { memberCount: 1 } }]);
  });
});

describe("deleteProjectPlatformState", () => {
  it("removes the project with its members and channels and leaves sibling projects alone", async () => {
    h.docs.set(`${PROJECT}/members/member-1`, { role: "member" });
    h.docs.set(`${PROJECT}/channels/general`, { mattermost: { channelId: "ch" } });
    h.docs.set("workspaces/mira/projects/sibling", { ownerUid: "owner-1" });
    h.docs.set("workspaces/mira/projects/sibling/members/member-1", { role: "member" });

    await deleteProjectPlatformState("mira", "orbit", { ownerUid: "owner-1", repoProvider: "gitea" });

    expect(h.sets).toEqual([{
      path: PROJECT,
      data: { pendingDeletion: { ownerUid: "owner-1", repoProvider: "gitea" } },
      projectStillStored: true,
    }]);
    expect(h.docs.has(PROJECT)).toBe(false);
    expect(h.docs.has(`${PROJECT}/members/member-1`)).toBe(false);
    expect(h.docs.has(`${PROJECT}/channels/general`)).toBe(false);
    expect(h.docs.has("workspaces/mira/projects/sibling")).toBe(true);
    expect(h.docs.has("workspaces/mira/projects/sibling/members/member-1")).toBe(true);
  });
});

describe("project platform state without a product presentation store", () => {
  beforeEach(() => installProjectPresentation(NO_PROJECT_PRESENTATION));
  afterEach(() => installDocumentPresentation(documentFake));

  it("adds a member to the platform record without publishing a count", async () => {
    await addProjectMember("mira", "orbit", "member-1");

    expect(h.docs.has(`${PROJECT}/members/member-1`)).toBe(true);
    expect(h.updates).toEqual([]);
  });

  it("deletes the project, its members and channels", async () => {
    h.docs.set(`${PROJECT}/members/member-1`, { role: "member" });
    h.docs.set(`${PROJECT}/channels/general`, { mattermost: { channelId: "ch" } });

    await deleteProjectPlatformState("mira", "orbit", { ownerUid: "owner-1", repoProvider: "gitea" });

    expect(h.docs.has(PROJECT)).toBe(false);
    expect(h.docs.has(`${PROJECT}/members/member-1`)).toBe(false);
    expect(h.docs.has(`${PROJECT}/channels/general`)).toBe(false);
    expect(h.sets).toEqual([]);
  });
});
