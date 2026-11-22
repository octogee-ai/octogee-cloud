import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  presentationCreates: [] as Array<{ workspaceSlug: string; projectSlug: string }>,
  pendingDeletions: [] as Array<{ workspaceSlug: string; projectSlug: string; pending: unknown }>,
  mmContext: null as Record<string, unknown> | null,
  mmApi: vi.fn(),
  provisionProjectRepoResult: vi.fn(),
  provisionProjectRepo: vi.fn(),
  deleteProjectRepo: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});
vi.mock("@octogee/core/http/logging", () => ({ logger: h.logger }));
vi.mock("@octogee/core/http/security", () => ({
  strictRateLimit: (_req: unknown, _res: unknown, next: () => void) => {
    next();
  },
}));
vi.mock("../lib/mattermost.js", () => ({ mmApi: (...args: unknown[]) => h.mmApi(...args) }));
vi.mock("../lib/mattermost-context.js", () => ({
  getWorkspaceMmContext: async () => h.mmContext,
}));
vi.mock("../routes/projects/provisioning.js", () => ({
  provisionProjectRepoResult: (...args: unknown[]) => h.provisionProjectRepoResult(...args),
  provisionProjectRepo: (...args: unknown[]) => h.provisionProjectRepo(...args),
  deleteProjectRepo: (...args: unknown[]) => h.deleteProjectRepo(...args),
}));
vi.mock("../lib/project-agent-service.js", () => ({
  provisionProjectAgent: async () => ({ status: 200, body: { success: true } }),
}));
vi.mock("../lib/withProject.js", async () => {
  const { readProject } = await import("@octogee/core/workspace/firestoreReads");
  return {
    withProject: async (
      req: { uid?: string },
      res: { status(code: number): { json(body: unknown): void } },
      wid: string,
      pid: string,
      _opts: unknown,
      handler: (ctx: Record<string, unknown>) => Promise<void>,
    ) => {
      const project = await readProject(wid, pid);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      req.uid = "owner-1";
      await handler({ projectPath: `workspaces/${wid}/projects/${pid}`, project, uid: "owner-1", wid, pid });
    },
  };
});

const { createProjectForActor } = await import("../lib/project-create-service.js");
const { default: retryRoutes } = await import("../routes/projects/retry.js");
const { installProjectPresentation, NO_PROJECT_PRESENTATION } = await import("@octogee/core/identity/project-presentation");
const { installProjectStarterFiles, PLATFORM_RECIPE_STARTER_FILES } = await import("../lib/project-starter-files.js");

const PROJECT = "workspaces/mira/projects/orbit";
const READY_CHAT = { teamId: "team-1", userId: "owner-mm", coachUserId: "coach-mm" };

function create() {
  return createProjectForActor(
    { uid: "owner-1", userData: { username: "mira" }, workspaceId: "mira", source: "agent" },
    { name: "Orbit", slug: "orbit", tagline: "Ship it", visibility: "private", recipe: "static-site" },
  );
}

function storedProjectPaths(): string[] {
  return [...h.docs.keys()].filter(path => path === PROJECT || path.startsWith(`${PROJECT}/`));
}

function retryApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects", retryRoutes);
  return app;
}

beforeEach(() => {
  h.docs.clear();
  h.presentationCreates.length = 0;
  h.pendingDeletions.length = 0;
  vi.clearAllMocks();
  h.mmContext = READY_CHAT;
  installProjectStarterFiles(PLATFORM_RECIPE_STARTER_FILES);
  installProjectPresentation({
    ...NO_PROJECT_PRESENTATION,
    createProject: async (workspaceSlug, projectSlug) => {
      h.presentationCreates.push({ workspaceSlug, projectSlug });
    },
    markProjectPendingDeletion: async (workspaceSlug, projectSlug, pending) => {
      h.pendingDeletions.push({ workspaceSlug, projectSlug, pending });
    },
  });
  h.provisionProjectRepoResult.mockResolvedValue({ created: true, error: null });
  h.provisionProjectRepo.mockResolvedValue(null);
  h.deleteProjectRepo.mockResolvedValue(undefined);
  h.mmApi.mockImplementation(async (path: string, method?: string) => {
    if (method === "POST" && path === "/channels") return { id: "channel-1" };
    if (method === undefined && path === "/channels/channel-1") {
      return { id: "channel-1", name: "mira-proj-orbit-general", team_id: "team-1", type: "P", delete_at: 1 };
    }
    if (method === undefined && path.startsWith("/teams/")) {
      const error = new Error("not found") as Error & { status: number };
      error.status = 404;
      throw error;
    }
    return { ok: true };
  });
});

describe("creating a project while the workspace chat is not ready", () => {
  it.each([
    ["no chat context", null],
    ["no chat team", { ...READY_CHAT, teamId: null }],
  ])("answers a retryable 503 and writes nothing when there is %s", async (_label, mmContext) => {
    h.mmContext = mmContext;

    const result = await create();

    expect(result).toEqual({ status: 503, body: { error: "workspace_chat_not_ready" } });
    expect(storedProjectPaths()).toEqual([]);
    expect(h.presentationCreates).toEqual([]);
    expect(h.mmApi).not.toHaveBeenCalled();
    expect(h.provisionProjectRepoResult).not.toHaveBeenCalled();
  });

  it("admits the same create once the workspace chat is ready", async () => {
    h.mmContext = null;
    await create();
    h.mmContext = READY_CHAT;

    const result = await create();

    expect(result.status).toBe(200);
    expect(h.docs.get(PROJECT)).toMatchObject({ provisioningState: "active" });
  });
});

describe("a create that fails after the project is reserved", () => {
  it("removes the record, owner member and presentation document when cleanup completes, so a retry is admitted", async () => {
    h.provisionProjectRepoResult.mockResolvedValueOnce({ created: true, error: "seed push failed" });

    const failed = await create();

    expect(failed).toEqual({
      status: 502,
      body: {
        error: "Project provisioning failed - could not create code repo",
        workspaceId: "mira",
        slug: "orbit",
        cleanupState: "complete",
      },
    });
    expect(h.deleteProjectRepo).toHaveBeenCalledWith({ workspaceId: "mira", slug: "orbit" });
    expect(storedProjectPaths()).toEqual([]);
    expect(h.pendingDeletions).toEqual([
      { workspaceSlug: "mira", projectSlug: "orbit", pending: { ownerUid: "owner-1", repoProvider: "gitea" } },
    ]);

    const retried = await create();

    expect(retried.status).toBe(200);
    expect(h.docs.get(PROJECT)).toMatchObject({ provisioningState: "active" });
  });

  it("keeps the failed record when cleanup does not complete, and the retry route finishes it", async () => {
    h.provisionProjectRepoResult.mockResolvedValueOnce({ created: true, error: "seed push failed" });
    h.deleteProjectRepo.mockRejectedValueOnce(new Error("gitea unavailable"));

    const failed = await create();

    expect(failed.body).toMatchObject({ cleanupState: "failed" });
    expect(h.pendingDeletions).toEqual([]);
    expect(h.docs.get(PROJECT)).toMatchObject({
      provisioningState: "failed",
      provisioningCleanup: { status: "failed", error: "Gitea cleanup: gitea unavailable" },
    });
    expect(h.docs.has(`${PROJECT}/members/owner-1`)).toBe(true);
    expect((await create()).status).toBe(409);

    const retried = await request(retryApp()).post("/api/projects/mira/orbit/retry-provisioning");

    expect(retried.status).toBe(200);
    expect(h.docs.get(PROJECT)).toMatchObject({ provisioningState: "active" });
  });
});
