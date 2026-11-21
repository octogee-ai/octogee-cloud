import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, any>>(),
  presentation: [] as Array<{ workspaceSlug: string; projectSlug: string; fields: Record<string, unknown> }>,
  mmApi: vi.fn(),
  provisionProjectRepoResult: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});
vi.mock("@octogee/core/http/logging", () => ({ logger: h.logger }));
vi.mock("../lib/mattermost.js", () => ({ mmApi: (...args: unknown[]) => h.mmApi(...args) }));
vi.mock("../lib/mattermost-context.js", () => ({
  getWorkspaceMmContext: async () => ({ teamId: "team-1", userId: "owner-mm", coachUserId: "coach-mm" }),
}));
vi.mock("../routes/projects/provisioning.js", () => ({
  provisionProjectRepoResult: (...args: unknown[]) => h.provisionProjectRepoResult(...args),
  deleteProjectRepo: async () => undefined,
}));
vi.mock("../lib/project-agent-service.js", () => ({
  provisionProjectAgent: async () => ({ status: 200, body: { success: true } }),
}));

const { createProjectForActor } = await import("../lib/project-create-service.js");
const { installProjectPresentation, NO_PROJECT_PRESENTATION } = await import("@octogee/core/identity/project-presentation");
const {
  installProjectStarterFiles,
  PLATFORM_RECIPE_STARTER_FILES,
} = await import("../lib/project-starter-files.js");

const PROJECT = "workspaces/mira/projects/orbit";
const STARTER_FILES = [
  { path: "package.json", content: "{\"name\":\"orbit\"}\n" },
  { path: "src/main.ts", content: "export {};\n" },
];

function create(input: Record<string, unknown> = {}, actor: Record<string, unknown> = {}) {
  return createProjectForActor(
    { uid: "owner-1", userData: { username: "mira" }, workspaceId: "mira", source: "ui", ...actor },
    { name: "Orbit", slug: "orbit", tagline: "Ship it", visibility: "private", recipe: "vite-static", ...input },
  );
}

beforeEach(() => {
  h.docs.clear();
  h.presentation.length = 0;
  vi.clearAllMocks();
  installProjectStarterFiles(PLATFORM_RECIPE_STARTER_FILES);
  installProjectPresentation({
    ...NO_PROJECT_PRESENTATION,
    createProject: async (workspaceSlug, projectSlug, fields) => {
      h.presentation.push({ workspaceSlug, projectSlug, fields });
    },
  });
  h.provisionProjectRepoResult.mockResolvedValue({ created: true, error: null });
  h.mmApi.mockImplementation(async (path: string, method?: string) => {
    if (method === "POST" && path === "/channels") return { id: "channel-1" };
    if (method === undefined && path === "/channels/channel-1") {
      return { id: "channel-1", name: "mira-proj-orbit-general", team_id: "team-1", type: "P", delete_at: 0 };
    }
    return { ok: true };
  });
});

it("seeds the platform recipe starter when the product supplies no starter files", async () => {
  const result = await create();

  expect(result.status).toBe(200);
  expect(h.provisionProjectRepoResult).toHaveBeenCalledWith(expect.not.objectContaining({
    starterFiles: expect.anything(),
  }));
});

it("asks the product for starter files with the create facts and seeds what it returns", async () => {
  const provide = vi.fn(async () => STARTER_FILES);
  installProjectStarterFiles(provide);

  const result = await create({ starter: "phone", projectType: "game" });

  expect(result.status).toBe(200);
  expect(provide).toHaveBeenCalledWith({
    uid: "owner-1",
    workspaceId: "mira",
    projectSlug: "orbit",
    projectType: "game",
    recipe: "vite-static",
    starter: "phone",
  });
  expect(h.provisionProjectRepoResult).toHaveBeenCalledWith(expect.objectContaining({
    slug: "orbit",
    recipe: "vite-static",
    starterFiles: STARTER_FILES,
  }));
});

it("answers a taken slug without asking the product for starter files", async () => {
  h.docs.set(PROJECT, { ownerUid: "owner-1" });
  const provide = vi.fn(async (): Promise<never> => {
    throw new Error("templates unavailable");
  });
  installProjectStarterFiles(provide);

  const result = await create({ starter: "phone" });

  expect(result.status).toBe(409);
  expect(provide).not.toHaveBeenCalled();
});

it("passes a null starter when the request names none", async () => {
  const provide = vi.fn(async () => null);
  installProjectStarterFiles(provide);

  await create();

  expect(provide).toHaveBeenCalledWith(expect.objectContaining({ starter: null }));
});

it("keeps the starter on the product's project record", async () => {
  await create({ starter: "phone" });

  expect(h.presentation).toEqual([
    expect.objectContaining({
      workspaceSlug: "mira",
      projectSlug: "orbit",
      fields: expect.objectContaining({ starter: "phone", recipe: "vite-static" }),
    }),
  ]);
});

it.each([["Phone"], ["../x"], [""], [7]])("refuses the starter %j before anything is created", async (starter) => {
  const provide = vi.fn(async () => STARTER_FILES);
  installProjectStarterFiles(provide);

  const result = await create({ starter });

  expect(result).toEqual({ status: 400, body: { error: "Invalid starter" } });
  expect(provide).not.toHaveBeenCalled();
  expect(h.docs.has(PROJECT)).toBe(false);
});

it("fails with a logged 500 and creates nothing when the product's starter files fail", async () => {
  installProjectStarterFiles(async () => {
    throw new Error("templates missing");
  });

  const result = await create({ starter: "phone" });

  expect(result).toEqual({ status: 500, body: { error: "Project starter files could not be prepared" } });
  expect(h.logger.error).toHaveBeenCalledWith(
    "[projects] Starter files failed for mira/orbit",
    expect.objectContaining({ starter: "phone", error: "starter files could not be prepared: templates missing" }),
  );
  expect(h.docs.has(PROJECT)).toBe(false);
  expect(h.mmApi).not.toHaveBeenCalled();
  expect(h.provisionProjectRepoResult).not.toHaveBeenCalled();
});

it("refuses product starter files that break the path rules", async () => {
  installProjectStarterFiles(async () => [{ path: ".git/config", content: "x" }]);

  const result = await create({ starter: "phone" });

  expect(result.status).toBe(500);
  expect(h.provisionProjectRepoResult).not.toHaveBeenCalled();
});

it("does not ask for starter files for a project backed by an existing GitHub repository", async () => {
  const provide = vi.fn(async () => STARTER_FILES);
  installProjectStarterFiles(provide);

  const result = await create(
    { starter: "phone", repoSource: { provider: "github", owner: "mira", repo: "orbit" } },
    { repoSourceAccess: "enabled", proveRepoSource: async () => null },
  );

  expect(result.status).toBe(200);
  expect(provide).not.toHaveBeenCalled();
  expect(h.provisionProjectRepoResult).toHaveBeenCalledWith(expect.objectContaining({ githubBacked: true }));
  expect(h.provisionProjectRepoResult).toHaveBeenCalledWith(expect.not.objectContaining({
    starterFiles: expect.anything(),
  }));
});
