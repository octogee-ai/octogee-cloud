import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installDocumentPresentation } from "./helpers/project-presentation.js";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  updates: [] as { path: string; data: Record<string, unknown> }[],
  project: {} as Record<string, unknown>,
  addChannelMember: vi.fn(),
  removeChannelMember: vi.fn(),
  ensureActiveMattermostUser: vi.fn(),
  mmApi: vi.fn(),
  giteaApi: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../middleware/security.js", () => ({
  strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../middleware/logging.js", () => ({ logger: h.logger }));
const documentFake = (path: string) => ({
      get: async () => ({ data: () => h.docs.get(path) }),
      update: async (data: Record<string, unknown>) => {
        h.updates.push({ path, data });
      },
    });
vi.mock("../lib/db.js", () => ({ db: { doc: (path: string) => documentFake(path) } }));
vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});
vi.mock("../lib/withProject.js", () => ({
  withProject: async (req: { uid?: string }, _res: unknown, wid: string, pid: string, _options: unknown, run: (ctx: unknown) => Promise<void>) => {
    req.uid = "joiner-1";
    await run({
      uid: "joiner-1",
      wid,
      pid,
      project: h.project,
      projectRef: { path: `workspaces/${wid}/projects/${pid}` },
    });
  },
}));
vi.mock("../lib/mattermost.js", () => ({ mmApi: (...args: unknown[]) => h.mmApi(...args) }));
vi.mock("../lib/gitea.js", () => ({ giteaApi: (...args: unknown[]) => h.giteaApi(...args) }));
vi.mock("../lib/mattermost-context.js", () => ({
  getWorkspaceMmContext: async () => ({ teamId: "team-1" }),
}));
vi.mock("../lib/channel-lifecycle.js", () => ({
  addChannelMember: (...args: unknown[]) => h.addChannelMember(...args),
  removeChannelMember: (...args: unknown[]) => h.removeChannelMember(...args),
  ensureActiveMattermostUser: (...args: unknown[]) => h.ensureActiveMattermostUser(...args),
}));

const { default: joinLeaveRoutes } = await import("../routes/projects/join-leave.js");

installDocumentPresentation(documentFake);
const { platformStateStore } = await import("../lib/platform-state.js");

const PROJECT = "workspaces/mira/projects/orbit";
const CHANNEL = `${PROJECT}/channels/general`;
const MEMBER = `${PROJECT}/members/joiner-1`;

function app() {
  const server = express();
  server.use(express.json());
  server.use("/api/projects", joinLeaveRoutes);
  return server;
}

beforeEach(() => {
  h.docs.clear();
  h.updates.length = 0;
  h.project = { ownerUid: "owner-1", visibility: "public", giteaRepoName: "orbit" };
  h.docs.set(PROJECT, { ownerUid: "owner-1", visibility: "public", provisioningState: "active" });
  h.docs.set("users/joiner-1", { username: "joiner", mattermost: { userId: "mm-joiner" } });
  h.addChannelMember.mockReset().mockResolvedValue(undefined);
  h.removeChannelMember.mockReset().mockResolvedValue(undefined);
  h.ensureActiveMattermostUser.mockReset().mockResolvedValue(undefined);
  h.mmApi.mockReset().mockResolvedValue({});
  h.giteaApi.mockReset().mockResolvedValue({});
});

describe("POST /api/projects/:wid/:pid/join", () => {
  it("records the member and repairs the count after chat access succeeds", async () => {
    await request(app()).post("/api/projects/mira/orbit/join").expect(200, { success: true });

    expect(h.addChannelMember).toHaveBeenCalledWith(CHANNEL, "mm-joiner");
    expect(h.docs.get(MEMBER)).toMatchObject({ role: "member", joinedAt: expect.any(Number) });
    expect(h.updates).toEqual([{ path: PROJECT, data: { memberCount: 2 } }]);
  });

  it("removes the chat member and refuses when the project went private after the route loaded it", async () => {
    h.docs.set(PROJECT, { ownerUid: "owner-1", visibility: "private", provisioningState: "active" });

    await request(app())
      .post("/api/projects/mira/orbit/join")
      .expect(403, { error: "This project is private. You need an invite to join." });

    expect(h.addChannelMember).toHaveBeenCalledWith(CHANNEL, "mm-joiner");
    expect(h.removeChannelMember).toHaveBeenCalledWith(CHANNEL, "mm-joiner");
    expect(h.docs.has(MEMBER)).toBe(false);
    expect(h.updates).toEqual([]);
    expect(h.giteaApi).not.toHaveBeenCalled();
  });

  it("keeps the chat member and reports already-member when a concurrent join committed first", async () => {
    h.docs.set(MEMBER, { role: "member", joinedAt: 5 });
    const precheck = vi.spyOn(platformStateStore.workspaces.projectMembers, "get").mockResolvedValueOnce(null);

    await request(app()).post("/api/projects/mira/orbit/join").expect(200, { success: true, alreadyMember: true });

    expect(h.removeChannelMember).not.toHaveBeenCalled();
    expect(h.docs.get(MEMBER)).toMatchObject({ joinedAt: 5 });
    expect(h.updates).toEqual([{ path: PROJECT, data: { memberCount: 2 } }]);
    precheck.mockRestore();
  });

  it("repairs the count on retry after the member committed but the recount was interrupted", async () => {
    h.docs.set(MEMBER, { role: "member", joinedAt: 5 });

    await request(app()).post("/api/projects/mira/orbit/join").expect(200, { success: true, alreadyMember: true });

    expect(h.addChannelMember).not.toHaveBeenCalled();
    expect(h.updates).toEqual([{ path: PROJECT, data: { memberCount: 2 } }]);
  });
});

describe("POST /api/projects/:wid/:pid/leave", () => {
  it("repairs the count on retry after the member was already removed", async () => {
    await request(app()).post("/api/projects/mira/orbit/leave").expect(200, { success: true, notAMember: true });

    expect(h.updates).toEqual([{ path: PROJECT, data: { memberCount: 1 } }]);
  });
});
