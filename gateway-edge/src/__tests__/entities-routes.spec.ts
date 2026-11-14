import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDocumentPresentation } from "./helpers/project-presentation.js";

type DocData = Record<string, unknown>;

interface Write {
  method: "set" | "update" | "delete";
  path: string;
  data?: unknown;
}

const h = vi.hoisted(() => ({
  uid: "caller-1",
  docs: new Map<string, DocData>(),
  writes: [] as Write[],
  mmApi: vi.fn(),
  resolveWorkspaceUid: vi.fn(),
  getWorkspaceMmContext: vi.fn(),
  readChannel: vi.fn(),
  readProject: vi.fn(),
  removeChannelMember: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  increment: vi.fn((value: number) => ({ __increment: value })),
  serverTimestamp: vi.fn(() => ({ __serverTimestamp: true })),
}));

function snap(path: string) {
  const data = h.docs.get(path);
  return { id: path.split("/").at(-1)!, ref: { path }, exists: data !== undefined, data: () => data };
}

function docRef(path: string) {
  return {
    id: path.split("/").at(-1),
    path,
    get: async () => snap(path),
    set: async (data: unknown) => {
      h.writes.push({ method: "set", path, data });
      h.docs.set(path, data as DocData);
    },
    update: async (data: unknown) => {
      h.writes.push({ method: "update", path, data });
      h.docs.set(path, { ...(h.docs.get(path) ?? {}), ...(data as DocData) });
    },
    delete: async () => {
      h.writes.push({ method: "delete", path });
      h.docs.delete(path);
    },
    collection: (sub: string) => colRef(`${path}/${sub}`),
  };
}

function userDocsMatchingMattermost(field: "in" | "==", value: unknown) {
  const candidates = Array.from(h.docs.entries()).filter(([path]) => {
    const parts = path.split("/");
    return parts.length === 2 && parts[0] === "users";
  });
  const matches = candidates.filter(([, data]) => {
    const mmUserId = (data.mattermost as { userId?: unknown } | undefined)?.userId;
    return field === "in"
      ? Array.isArray(value) && value.includes(mmUserId)
      : mmUserId === value;
  });
  return {
    empty: matches.length === 0,
    docs: matches.map(([path, data]) => ({ id: path.split("/")[1], data: () => data })),
  };
}

function colRef(path: string) {
  return {
    limit: () => ({ get: async () => ({ docs: [...h.docs.keys()].filter((key) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes("/")).map(snap) }) }),
    doc: (id: string) => docRef(`${path}/${id}`),
    where: (field: string, op: string, value: unknown) => ({
      limit: (_limit: number) => ({
        get: async () => {
          if (path === "users" && field === "mattermost.userId" && op === "==") {
            return userDocsMatchingMattermost("==", value);
          }
          return { empty: true, docs: [] };
        },
      }),
      get: async () => {
        if (path === "users" && field === "mattermost.userId" && op === "in") {
          return userDocsMatchingMattermost("in", value);
        }
        return { empty: true, docs: [] };
      },
    }),
  };
}

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: { uid?: string }, _res: unknown, next: () => void) => {
    req.uid = h.uid;
    next();
  },
}));

vi.mock("../lib/db.js", () => ({
  db: {
    doc: (path: string) => docRef(path),
    collection: (path: string) => colRef(path),
  },
  FieldValue: {
    increment: h.increment,
    serverTimestamp: h.serverTimestamp,
  },
}));

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

vi.mock("../lib/mattermost.js", () => ({
  mmApi: h.mmApi,
}));

vi.mock("../lib/workspace-resolution.js", () => ({
  resolveWorkspaceUid: h.resolveWorkspaceUid,
}));

vi.mock("../lib/mattermost-context.js", () => ({
  getWorkspaceMmContext: h.getWorkspaceMmContext,
}));

vi.mock("../lib/firestoreReads.js", () => ({
  readChannel: h.readChannel,
  readProject: h.readProject,
}));

vi.mock("../middleware/logging.js", () => ({
  logger: h.logger,
}));

vi.mock("../lib/channel-lifecycle.js", () => ({
  removeChannelMember: (...args: unknown[]) => h.removeChannelMember(...args),
}));

const { default: entitiesRoutes } = await import("../routes/entities.js");

installDocumentPresentation(docRef);

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/entities", entitiesRoutes);
  return a;
}

describe("entities routes", () => {
  beforeEach(() => {
    h.uid = "caller-1";
    h.docs.clear();
    h.writes.length = 0;
    h.mmApi.mockReset();
    h.resolveWorkspaceUid.mockReset();
    h.getWorkspaceMmContext.mockReset();
    h.readChannel.mockReset();
    h.readProject.mockReset();
    h.removeChannelMember.mockReset().mockResolvedValue(undefined);
    h.logger.info.mockReset();
    h.logger.warn.mockReset();
    h.logger.error.mockReset();
    h.increment.mockClear();
    h.serverTimestamp.mockClear();
    h.docs.set("users/caller-1/secrets/mattermost", { personalToken: "caller-mm-token" });
  });

  it("lists workspace channel members with owner first and Firestore profile data hydrated", async () => {
    h.resolveWorkspaceUid.mockResolvedValue("owner-1");
    h.getWorkspaceMmContext.mockResolvedValue({ generalChannelId: "general-ch" });
    h.docs.set("users/owner-1", {
      mattermost: { userId: "mm-owner" },
      firstName: "Owner",
    });
    h.docs.set("users/member-1", {
      mattermost: { userId: "mm-member" },
      displayName: "Member From Firestore",
    });
    h.docs.set("users/member-1/profile/public", { avatarUrl: "https://example.test/avatar.png" });
    h.mmApi.mockImplementation(async (path: string) => {
      if (path === "/channels/general-ch/members") {
        return [
          { user_id: "mm-member", channel_id: "general-ch", roles: "" },
          { user_id: "mm-owner", channel_id: "general-ch", roles: "" },
        ];
      }
      if (path === "/users/ids") {
        return [
          { id: "mm-member", username: "member-mm", first_name: "", last_name: "" },
          { id: "mm-owner", username: "owner-mm", first_name: "Owner From MM", last_name: "" },
        ];
      }
      throw new Error(`unexpected mmApi path: ${path}`);
    });

    const res = await request(app()).get("/api/entities/workspace/acme/members");

    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([
      {
        uid: "owner-1",
        mmUserId: "mm-owner",
        username: "owner-mm",
        displayName: "Owner",
        avatarUrl: null,
        role: "owner",
      },
      {
        uid: "member-1",
        mmUserId: "mm-member",
        username: "member-mm",
        displayName: "Member From Firestore",
        avatarUrl: "https://example.test/avatar.png",
        role: "member",
      },
    ]);
  });

  it("fails the members list when two users claim the same Mattermost user", async () => {
    h.resolveWorkspaceUid.mockResolvedValue("owner-1");
    h.getWorkspaceMmContext.mockResolvedValue({ generalChannelId: "general-ch" });
    h.docs.set("users/owner-1", { mattermost: { userId: "mm-owner" } });
    h.docs.set("users/member-1", { mattermost: { userId: "mm-member" } });
    h.docs.set("users/member-2", { mattermost: { userId: "mm-member" } });
    h.mmApi.mockImplementation(async (path: string) => {
      if (path === "/channels/general-ch/members") return [{ user_id: "mm-member", channel_id: "general-ch", roles: "" }];
      if (path === "/users/ids") return [{ id: "mm-member", username: "member-mm", first_name: "", last_name: "" }];
      throw new Error(`unexpected mmApi path: ${path}`);
    });

    const res = await request(app()).get("/api/entities/workspace/acme/members");

    expect(res.status).toBe(500);
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("excludes deactivated MM users — a retired project-agent bot must not linger in Members", async () => {
    // MM's DELETE /users/{id} only deactivates; deactivated users stay channel
    // members. The multi-agent toggle-off retires the project bot this way, so the
    // members list must drop delete_at>0 users or the bot appears still-active.
    h.resolveWorkspaceUid.mockResolvedValue("owner-1");
    h.getWorkspaceMmContext.mockResolvedValue({ generalChannelId: "general-ch" });
    h.docs.set("users/owner-1", { mattermost: { userId: "mm-owner" }, firstName: "Owner" });
    h.mmApi.mockImplementation(async (path: string) => {
      if (path === "/channels/general-ch/members") {
        return [
          { user_id: "mm-owner", channel_id: "general-ch", roles: "" },
          { user_id: "mm-retired-bot", channel_id: "general-ch", roles: "" },
        ];
      }
      if (path === "/users/ids") {
        return [
          { id: "mm-owner", username: "owner-mm", first_name: "Owner", last_name: "" },
          {
            id: "mm-retired-bot",
            username: "acme-proj-camp-coach",
            first_name: "Buddy",
            last_name: "",
            delete_at: 1_783_500_000_000,
          },
        ];
      }
      throw new Error(`unexpected mmApi path: ${path}`);
    });

    const res = await request(app()).get("/api/entities/workspace/acme/members");

    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { mmUserId: string }) => m.mmUserId)).toEqual(["mm-owner"]);
  });

  it("keeps members whose /users/ids hydration is missing — the filter fails OPEN, never vanishing members", async () => {
    // The deactivated filter keys off delete_at from /users/ids. A member absent
    // from that response (partial hydration) must be KEPT — memberResponse already
    // renders a user_id fallback for exactly this case; dropping them would make
    // real members silently vanish on an MM hiccup.
    h.resolveWorkspaceUid.mockResolvedValue("owner-1");
    h.getWorkspaceMmContext.mockResolvedValue({ generalChannelId: "general-ch" });
    h.docs.set("users/owner-1", { mattermost: { userId: "mm-owner" }, firstName: "Owner" });
    h.mmApi.mockImplementation(async (path: string) => {
      if (path === "/channels/general-ch/members") {
        return [
          { user_id: "mm-owner", channel_id: "general-ch", roles: "" },
          { user_id: "mm-unhydrated", channel_id: "general-ch", roles: "" },
        ];
      }
      if (path === "/users/ids") {
        return [{ id: "mm-owner", username: "owner-mm", first_name: "Owner", last_name: "" }];
      }
      throw new Error(`unexpected mmApi path: ${path}`);
    });

    const res = await request(app()).get("/api/entities/workspace/acme/members");

    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { mmUserId: string }) => m.mmUserId).sort()).toEqual([
      "mm-owner",
      "mm-unhydrated",
    ]);
  });

  it("removes a project member from Mattermost and the project member document", async () => {
    h.uid = "owner-1";
    h.docs.set("workspaces/acme/projects/project", { ownerUid: "owner-1" });
    h.docs.set("workspaces/acme/projects/project/channels/general", { mattermost: { channelId: "project-ch" } });
    h.docs.set("users/owner-1", { mattermost: { userId: "mm-owner" } });
    h.docs.set("users/member-1", { mattermost: { userId: "mmmember" } });
    h.docs.set("workspaces/acme/projects/project/members/member-1", { role: "member" });
    h.mmApi.mockResolvedValue({});

    const res = await request(app()).delete("/api/entities/project/acme_project/members/mmmember");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(h.removeChannelMember).toHaveBeenCalledWith(
      "workspaces/acme/projects/project/channels/general",
      "mmmember",
    );
    expect(h.docs.has("workspaces/acme/projects/project/members/member-1")).toBe(false);
    expect(h.docs.get("workspaces/acme/projects/project")?.updatedAt).toEqual(expect.any(Number));
    expect(h.writes).toContainEqual({
      method: "update",
      path: "workspaces/acme/projects/project",
      data: { memberCount: 1 },
    });
  });

  it("marks workspace membership revoking before Mattermost removal", async () => {
    h.uid = "owner-1";
    h.resolveWorkspaceUid.mockResolvedValue("owner-1");
    h.getWorkspaceMmContext.mockResolvedValue({ generalChannelId: "general-ch" });
    h.docs.set("users/owner-1", { mattermost: { userId: "mm-owner" } });
    h.docs.set("users/member-1", { mattermost: { userId: "mmmember" } });
    h.docs.set("workspaces/acme/members/member-1", {
      id: "member-1",
      role: "member",
      canonicalSource: "mattermost-general",
      canonicalState: "active",
    });
    h.removeChannelMember.mockRejectedValueOnce(new Error("chat unavailable"));

    const res = await request(app()).delete("/api/entities/workspace/acme/members/mmmember");

    expect(res.status).toBe(500);
    expect(h.docs.get("workspaces/acme/members/member-1")).toEqual({
      id: "member-1",
      role: "member",
      canonicalSource: "mattermost-general",
      canonicalState: "revoking",
    });
  });

  it("workspace settings removal cleans up all group channels before deleting membership", async () => {
  h.resolveWorkspaceUid.mockResolvedValue("caller-1");
  h.getWorkspaceMmContext.mockResolvedValue({ generalChannelId: "general" });
  h.docs.set("users/caller-1", { mattermost: { userId: "mmowner" } });
  h.docs.set("users/member", { mattermost: { userId: "mmmember" } });
  h.docs.set("workspaces/acme/members/member", { role: "member", canonicalState: "active" });
  h.docs.set("workspaces/acme/channels/planning", { kind: "session" });
  h.docs.set("workspaces/acme/channels/coach-dm", { kind: "coach-dm" });
  const res = await request(app()).delete("/api/entities/workspace/acme/members/mmmember");
  expect(res.status).toBe(200);
  expect(h.removeChannelMember.mock.calls).toEqual([
    ["workspaces/acme/channels/general", "mmmember"],
    ["workspaces/acme/channels/planning", "mmmember"],
  ]);
  expect(h.docs.has("workspaces/acme/members/member")).toBe(false);
});

});
