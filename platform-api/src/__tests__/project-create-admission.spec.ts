import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, any>>(),
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
const {
  ADMIT_EVERY_PROJECT_CREATE,
  installProjectCreateAdmission,
} = await import("../lib/project-create-admission.js");

const PROJECT = "workspaces/mira/projects/orbit";

function create(source: "ui" | "agent" = "ui") {
  return createProjectForActor(
    { uid: "owner-1", userData: { username: "mira" }, workspaceId: "mira", source },
    { name: "Orbit", slug: "orbit", tagline: "Ship it", category: "games", projectType: "web", status: "building", visibility: "private" },
  );
}

function expectNothingCreated() {
  expect(h.docs.has(PROJECT)).toBe(false);
  expect(h.mmApi).not.toHaveBeenCalled();
  expect(h.provisionProjectRepoResult).not.toHaveBeenCalled();
}

beforeEach(() => {
  h.docs.clear();
  vi.clearAllMocks();
  installProjectCreateAdmission(ADMIT_EVERY_PROJECT_CREATE);
  h.provisionProjectRepoResult.mockResolvedValue({ created: true, error: null });
  h.mmApi.mockImplementation(async (path: string, method?: string) => {
    if (method === "POST" && path === "/channels") return { id: "channel-1" };
    if (method === undefined && path === "/channels/channel-1") {
      return { id: "channel-1", name: "mira-proj-orbit-general", team_id: "team-1", type: "P", delete_at: 0 };
    }
    return { ok: true };
  });
});

it("creates the project when no admission is installed", async () => {
  const result = await create();

  expect(result.status).toBe(200);
  expect(h.docs.get(PROJECT)).toMatchObject({ provisioningState: "active" });
});

it("passes the authenticated user, workspace, slug and source to the admission", async () => {
  const admit = vi.fn(async () => ({ allowed: true as const }));
  installProjectCreateAdmission(admit);

  const result = await create("agent");

  expect(result.status).toBe(200);
  expect(admit).toHaveBeenCalledWith({
    uid: "owner-1",
    workspaceId: "mira",
    projectSlug: "orbit",
    source: "agent",
  });
});

it("sends the refusal status and body as is and creates nothing", async () => {
  installProjectCreateAdmission(async () => ({
    allowed: false,
    status: 403,
    body: { error: "refused_by_admission", detail: ["a"] },
  }));

  const result = await create();

  expect(result).toEqual({ status: 403, body: { error: "refused_by_admission", detail: ["a"] } });
  expectNothingCreated();
});

it("fails closed with a logged 500 when the admission throws", async () => {
  installProjectCreateAdmission(async () => {
    throw new Error("admission store down");
  });

  const result = await create();

  expect(result).toEqual({ status: 500, body: { error: "Project creation could not be admitted" } });
  expect(h.logger.error).toHaveBeenCalledWith(
    "[projects] Create admission failed for mira/orbit",
    expect.objectContaining({ uid: "owner-1", error: expect.any(Error) }),
  );
  expectNothingCreated();
});

it("does not consult the admission for invalid input", async () => {
  const admit = vi.fn(async () => ({ allowed: true as const }));
  installProjectCreateAdmission(admit);

  const result = await createProjectForActor(
    { uid: "owner-1", userData: {}, workspaceId: "mira" },
    { name: "", slug: "orbit" },
  );

  expect(result.status).toBe(400);
  expect(admit).not.toHaveBeenCalled();
});
