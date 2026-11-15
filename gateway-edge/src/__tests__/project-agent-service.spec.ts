import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  mmApi: vi.fn(),
  addChannelMember: vi.fn(),
  createProjectAgentBot: vi.fn(),
  retireProjectAgentBot: vi.fn(),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@octogee/core/identity/platform-state-store", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

vi.mock("@octogee/core/http/logging", () => ({ logger: h.logger }));

vi.mock("../lib/mattermost.js", () => ({
  mmApi: (...args: unknown[]) => h.mmApi(...args),
}));

vi.mock("../lib/channel-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/channel-lifecycle.js")>();
  return {
    ...actual,
    addChannelMember: (...args: unknown[]) => h.addChannelMember(...args),
  };
});

vi.mock("@octogee/core/mattermost/project-agent", () => ({
  createProjectAgentBot: (...args: unknown[]) => h.createProjectAgentBot(...args),
  retireProjectAgentBot: (...args: unknown[]) => h.retireProjectAgentBot(...args),
  projectAgentSecretDocId: (pid: string) => `projectAgentMattermost-${pid}`,
}));

const { provisionProjectAgent, retireProjectAgentForDeletion } = await import(
  "../lib/project-agent-service.js"
);

function actor(overrides: Record<string, unknown> = {}) {
  return { uid: "owner-1", workspaceId: "mira", ...overrides };
}

const PROJECT_PATH = "workspaces/mira/projects/orbit";
const USER_PATH = "users/owner-1";
const PROJECT_AGENT_ID = "octogee-mira-proj-orbit-coach";
const PROVISION_FAILED = "Project Agent provisioning failed - retry from project settings";

let documentWrites: MockInstance<(path: string, data: Record<string, unknown>) => Map<string, Record<string, unknown>>>;

function agentWrites() {
  return documentWrites.mock.calls
    .filter(([path]) => path === PROJECT_PATH)
    .map(([, data]) => data.agent as Record<string, unknown>);
}

function agentStateWrite(
  status: "provisioning" | "ready" | "error",
  { lastError = null, activationId = null }: { lastError?: string | null; activationId?: unknown } = {},
) {
  return { status, activationId, lastError, updatedAt: expect.any(Number) };
}

function rosteredAgentIds() {
  const provisioning = h.docs.get(USER_PATH)?.provisioning as { openclaw?: { agentIds?: string[] } } | undefined;
  return provisioning?.openclaw?.agentIds;
}

function seedOwner(agentIds: string[] = ["octogee-mira-coach"]) {
  h.docs.set(USER_PATH, { provisioning: { openclaw: { slug: "mira", agentIds } } });
}

function seedProject(extra: Record<string, unknown> = {}) {
  h.docs.set(PROJECT_PATH, { id: "orbit", ownerUid: "owner-1", ...extra });
  h.docs.set("workspaces/mira", { id: "mira", ownerUid: "owner-1", mattermost: { teamId: "team-1" } });
  h.docs.set("agents/owner-1", { name: "BenderEcho", avatarEmoji: "🤖" });
  h.docs.set(`${PROJECT_PATH}/channels/general`, {
    id: "general",
    kind: "general",
    mattermost: { channelId: "po-1" },
  });
  seedOwner();
  documentWrites.mockClear();
}

beforeEach(() => {
  h.docs.clear();
  documentWrites = vi.spyOn(h.docs, "set");
  h.mmApi.mockReset();
  h.addChannelMember.mockReset().mockResolvedValue(undefined);
  h.createProjectAgentBot.mockReset().mockResolvedValue({ mmUserId: "bot-1", token: "pat-1" });
  h.retireProjectAgentBot.mockReset().mockResolvedValue(undefined);
  h.logger.error.mockReset();
  h.logger.info.mockReset();
  h.logger.warn.mockReset();
});

afterEach(() => {
  documentWrites.mockRestore();
});

describe("provisionProjectAgent", () => {
  it("502s when the workspace has no MM teamId, recording the error for retry", async () => {
    seedProject();
    h.docs.set("workspaces/mira", { id: "mira", ownerUid: "owner-1" });

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(result).toEqual({
      status: 502,
      body: { error: PROVISION_FAILED },
    });
    expect(agentWrites()).toEqual([
      agentStateWrite("provisioning"),
      agentStateWrite("error", { lastError: PROVISION_FAILED }),
    ]);
    expect(h.createProjectAgentBot).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("403s when the caller is not the project owner", async () => {
    seedProject({ ownerUid: "someone-else" });

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(result).toEqual({
      status: 403,
      body: { error: "Only the project owner can manage its agent" },
    });
    expect(documentWrites).not.toHaveBeenCalled();
    expect(h.createProjectAgentBot).not.toHaveBeenCalled();
  });

  it("does not materialize a project Agent for an archived project", async () => {
    seedProject({ commercialLifecycle: { status: "archived" } });

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(result).toEqual({
      status: 409,
      body: { error: "Project is archived" },
    });
    expect(documentWrites).not.toHaveBeenCalled();
    expect(h.createProjectAgentBot).not.toHaveBeenCalled();
  });

  it("404s for a missing project and 400s for an invalid id", async () => {
    await expect(provisionProjectAgent(actor(), "orbit")).resolves.toEqual({
      status: 404,
      body: { error: "Project not found" },
    });
    await expect(provisionProjectAgent(actor(), "Bad!")).resolves.toEqual({
      status: 400,
      body: { error: "Invalid project" },
    });
  });

  it("mints the bot and keeps the agent provisioning until the runtime reports readiness", async () => {
    seedProject();

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(agentWrites()).toEqual([
      agentStateWrite("provisioning"),
      agentStateWrite("provisioning", { activationId: expect.stringMatching(/^[a-f0-9-]{36}$/) }),
    ]);
    expect(h.createProjectAgentBot).toHaveBeenCalledWith(expect.anything(), {
      uid: "owner-1",
      username: "mira",
      project: "orbit",
      teamId: "team-1",
      displayName: "orbit",
      projectChannelIds: ["po-1"],
    });
    expect(h.addChannelMember).toHaveBeenCalledWith(
      `${PROJECT_PATH}/channels/general`,
      "bot-1",
    );
    expect(result).toEqual({
      status: 200,
      body: { success: true, status: "provisioning", provisioned: true },
    });
  });

  it("names the bot after the project agent's identity and keeps the rest of its agent state", async () => {
    seedProject({ agent: { status: "ready", identity: { name: "Beacon", emoji: "🛰️" } } });

    await provisionProjectAgent(actor(), "orbit");

    expect(h.createProjectAgentBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ displayName: "Beacon" }),
    );
    expect(h.docs.get(PROJECT_PATH)?.agent).toEqual({
      ...agentStateWrite("provisioning", { activationId: expect.any(String) }),
      identity: { name: "Beacon", emoji: "🛰️" },
    });
  });

  it("invalidates prior readiness before minting and assigns a new activation to each successful provision", async () => {
    seedProject({ agent: { status: "ready", activationId: "previous" } });
    let finishMint!: (value: { mmUserId: string; token: string }) => void;
    h.createProjectAgentBot.mockImplementationOnce(() => new Promise((resolve) => { finishMint = resolve; }));
    const enabling = provisionProjectAgent(actor(), "orbit");
    await vi.waitFor(() => expect(h.createProjectAgentBot).toHaveBeenCalled());
    expect(agentWrites()).toEqual([agentStateWrite("provisioning")]);
    finishMint({ mmUserId: "bot-1", token: "new-pat" });
    await enabling;
    const first = agentWrites().at(-1)?.activationId;
    await provisionProjectAgent(actor(), "orbit");
    const second = agentWrites().at(-1)?.activationId;
    expect(first).toEqual(expect.any(String));
    expect(second).not.toBe(first);
  });

  it("registers the agent id in the owner's provisioning roster so the byok broker will issue its tokens", async () => {
    seedProject();

    await provisionProjectAgent(actor(), "orbit");

    expect(rosteredAgentIds()).toEqual(["octogee-mira-coach", PROJECT_AGENT_ID]);
  });

  it("records the error without minting when the owner's roster cannot be updated", async () => {
    seedProject();
    h.docs.delete(USER_PATH);

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(result).toEqual({ status: 502, body: { error: PROVISION_FAILED } });
    expect(agentWrites()).toEqual([
      agentStateWrite("provisioning"),
      agentStateWrite("error", { lastError: PROVISION_FAILED }),
    ]);
    expect(h.createProjectAgentBot).not.toHaveBeenCalled();
  });

  it("reports 502 when minting fails (retry re-mints idempotently)", async () => {
    seedProject();
    h.createProjectAgentBot.mockRejectedValue(new Error("MM down"));

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(agentWrites()).toEqual([
      agentStateWrite("provisioning"),
      agentStateWrite("error", { lastError: PROVISION_FAILED }),
    ]);
    expect(rosteredAgentIds()).toEqual(["octogee-mira-coach", PROJECT_AGENT_ID]);
    expect(result).toEqual({
      status: 502,
      body: { error: PROVISION_FAILED },
    });
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("reports 502 when primary membership cannot converge", async () => {
    seedProject();
    h.addChannelMember.mockRejectedValue(new Error("primary membership mismatch"));

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(h.createProjectAgentBot).toHaveBeenCalled();
    expect(result).toEqual({
      status: 502,
      body: { error: PROVISION_FAILED },
    });
    expect(agentWrites().at(-1)).toEqual(agentStateWrite("error", { lastError: PROVISION_FAILED }));
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("maps a MattermostIdentityMissingError from primary membership to the sanitized 422 instead of the generic 502", async () => {
    seedProject();
    const { MattermostIdentityMissingError } = await import("../lib/channel-lifecycle.js");
    h.addChannelMember.mockRejectedValue(
      new MattermostIdentityMissingError("Mattermost user bot-1 was not found"),
    );

    const result = await provisionProjectAgent(actor(), "orbit");

    expect(h.createProjectAgentBot).toHaveBeenCalled();
    expect(result).toEqual({
      status: 422,
      body: { error: "Your chat account could not be found. Please contact support to restore access." },
    });
    expect(agentWrites().at(-1)).toEqual(agentStateWrite("error", {
      lastError: "Your chat account could not be found. Please contact support to restore access.",
    }));
    expect(h.logger.error).toHaveBeenCalled();
  });
});

const SECRET_PATH = "users/owner-1/secrets/projectAgentMattermost-orbit";

describe("retireProjectAgentForDeletion", () => {
  beforeEach(() => {
    seedOwner(["octogee-mira-coach", PROJECT_AGENT_ID]);
  });

  it("retires the minted bot, then removes the roster id", async () => {
    h.docs.set(SECRET_PATH, { mmUserId: "bot-1", personalToken: "pat-1" });

    await retireProjectAgentForDeletion("owner-1", "mira", "orbit");

    expect(h.retireProjectAgentBot).toHaveBeenCalledWith(expect.anything(), {
      uid: "owner-1",
      project: "orbit",
      mmUserId: "bot-1",
    });
    expect(rosteredAgentIds()).toEqual(["octogee-mira-coach"]);
  });

  it("removes a stale roster id even when no bot secret exists", async () => {
    await retireProjectAgentForDeletion("owner-1", "mira", "orbit");

    expect(h.retireProjectAgentBot).not.toHaveBeenCalled();
    expect(rosteredAgentIds()).toEqual(["octogee-mira-coach"]);
  });

  it("drops a secret without an mmUserId so config demand cannot outlive the project", async () => {
    h.docs.set(SECRET_PATH, { personalToken: "pat-1" });

    await retireProjectAgentForDeletion("owner-1", "mira", "orbit");

    expect(h.retireProjectAgentBot).not.toHaveBeenCalled();
    expect(h.docs.has(SECRET_PATH)).toBe(false);
    expect(h.logger.warn).toHaveBeenCalled();
    expect(rosteredAgentIds()).toEqual(["octogee-mira-coach"]);
  });

  it("keeps the roster id when retiring fails — the roster must stay a superset of config demand", async () => {
    h.docs.set(SECRET_PATH, { mmUserId: "bot-1", personalToken: "pat-1" });
    h.retireProjectAgentBot.mockRejectedValue(new Error("MM down"));

    await expect(retireProjectAgentForDeletion("owner-1", "mira", "orbit")).rejects.toThrow(
      "MM down",
    );

    expect(rosteredAgentIds()).toEqual(["octogee-mira-coach", PROJECT_AGENT_ID]);
  });
});
