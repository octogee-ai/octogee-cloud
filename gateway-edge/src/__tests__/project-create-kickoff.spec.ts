import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, any>>(),
  mmApi: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../lib/platform-state.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});
vi.mock("../middleware/logging.js", () => ({ logger: h.logger }));
vi.mock("../lib/mattermost.js", () => ({ mmApi: (...args: unknown[]) => h.mmApi(...args) }));
vi.mock("../lib/mattermost-context.js", () => ({
  getWorkspaceMmContext: async () => ({ teamId: "team-1", userId: "owner-mm", coachUserId: "coach-mm" }),
}));
vi.mock("../routes/projects/provisioning.js", () => ({
  provisionProjectRepoResult: async () => ({ created: true, error: null }),
  deleteProjectRepo: async () => undefined,
}));
vi.mock("../lib/project-agent-service.js", () => ({
  provisionProjectAgent: async () => ({ status: 200, body: { success: true } }),
}));

const { createProjectForActor } = await import("../lib/project-create-service.js");
const {
  installProjectAgentDeliveryIntents,
  NO_PROJECT_AGENT_DELIVERY_INTENTS,
} = await import("../lib/project-agent-delivery-intents.js");

const PROJECT = "workspaces/mira/projects/orbit";
const recordingIntents = { ...NO_PROJECT_AGENT_DELIVERY_INTENTS, recordsIntents: true };

function create(source: "ui" | "agent" = "ui") {
  return createProjectForActor(
    { uid: "owner-1", userData: { username: "mira" }, workspaceId: "mira", source },
    { name: "Orbit", slug: "orbit", tagline: "Ship it", category: "games", projectType: "web", status: "building", visibility: "private" },
  );
}

beforeEach(() => {
  h.docs.clear();
  vi.clearAllMocks();
  installProjectAgentDeliveryIntents(NO_PROJECT_AGENT_DELIVERY_INTENTS);
  h.mmApi.mockImplementation(async (path: string, method?: string) => {
    if (method === "POST" && path === "/channels") return { id: "channel-1" };
    if (method === undefined && path === "/channels/channel-1") {
      return { id: "channel-1", name: "mira-proj-orbit-general", team_id: "team-1", type: "P", delete_at: 0 };
    }
    return { ok: true };
  });
});

it("creates a UI project without a kickoff and logs the skip when no delivery intent store is installed", async () => {
  const result = await create();

  expect(result.status).toBe(200);
  expect(h.docs.get(PROJECT)!.agent).not.toHaveProperty("kickoff");
  expect(h.logger.warn).toHaveBeenCalledWith(
    "[projects] Kickoff skipped for mira/orbit: no project agent delivery intent store is installed",
  );
});

it("queues the kickoff of a UI project when a delivery intent store is installed", async () => {
  installProjectAgentDeliveryIntents(recordingIntents);

  await create();

  expect(h.docs.get(PROJECT)!.agent).toMatchObject({ kickoff: { status: "pending" } });
  expect(h.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("Kickoff skipped"));
});

it("never queues a kickoff or logs a skip for a project an agent created", async () => {
  await create("agent");

  expect(h.docs.get(PROJECT)!.agent).not.toHaveProperty("kickoff");
  expect(h.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("Kickoff skipped"));
});
