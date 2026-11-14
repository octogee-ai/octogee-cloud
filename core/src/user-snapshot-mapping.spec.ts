import { describe, it, expect, vi } from "vitest";
import {
  byotSnapshotProjectionFromSystemConfig,
  byotSystemConfigFromDoc,
  deriveSlug,
  mapUserDocToSnapshot,
  mapWorkspaceChannelDoc,
  mapProjectChannelDoc,
  mapProjectAgentState,
  collectStoredProjectAgentStates,
  readAgentModelSelections,
} from "./user-snapshot-mapping.js";
import { MalformedRecordError } from "./platform-state/errors.js";
import type { Revision } from "./platform-state/store.js";
import { createDocumentFixtureStore } from "./testing/journal-store.js";

describe("deriveSlug", () => {
  it("prefers provisioning.openclaw.slug, falls back to username", () => {
    expect(deriveSlug("u", { provisioning: { openclaw: { slug: "fromOC" } }, username: "fromName" })).toBe("fromOC");
    expect(deriveSlug("u", { username: "fromName" })).toBe("fromName");
  });
  it("throws (identifiable message) when neither is set — orchestrator must not proceed", () => {
    expect(() => deriveSlug("u9", { tier: "pro" })).toThrow(
      /\[load:u9\] cannot derive slug/,
    );
  });
});

describe("mapUserDocToSnapshot — users/{uid} doc → UserSnapshot", () => {
  const ch: never[] = [];

  it("byotActive mirrors Boolean(data.byotActive) — the mount re-assert reads it to avoid clobbering BYOT", () => {
    expect(mapUserDocToSnapshot("u", { username: "a", byotActive: true }, ch).byotActive).toBe(true);
    expect(mapUserDocToSnapshot("u", { username: "a", byotActive: false }, ch).byotActive).toBe(false);
    expect(mapUserDocToSnapshot("u", { username: "a" }, ch).byotActive).toBe(false);
  });

  it("ownerName fallback: displayName → username → slug", () => {
    expect(mapUserDocToSnapshot("u", { username: "acme", displayName: "Acme" }, ch).ownerName).toBe("Acme");
    expect(mapUserDocToSnapshot("u", { username: "acme" }, ch).ownerName).toBe("acme");
    expect(mapUserDocToSnapshot("u", { provisioning: { openclaw: { slug: "sluggy" } } }, ch).ownerName).toBe("sluggy");
  });

  it("defaults: gatewayId '', status '', agentIds [], repoUrl '', mattermostUserId null", () => {
    const s = mapUserDocToSnapshot("u", { username: "a" }, ch);
    expect(s.gatewayId).toBe("");
    expect(s.status).toBe("");
    expect(s.agentIds).toEqual([]);
    expect(s.repoUrl).toBe("");
    expect(s.mattermostUserId).toBeNull();
  });


  it("passes channels through unchanged and throws on no-slug", () => {
    const channels = [{ scope: "workspace" as const, kind: "general", channelId: "C1" }];
    expect(mapUserDocToSnapshot("u", { username: "a" }, channels).channels).toBe(channels);
    expect(() => mapUserDocToSnapshot("u2", {}, ch)).toThrow(/cannot derive slug/);
  });

  it("carries plan inputs only inside the bag and leaves an account without any with an empty one", () => {
    const snap = mapUserDocToSnapshot(
      "u",
      { username: "a", tier: "pro", selectedTier: "personal", subscription: { tier: "personal" } },
      ch,
    );
    for (const key of ["tier", "selectedTier", "subscription", "builderSubscription", "trialGrant", "signupOfferConvertedAt"]) {
      expect(key in snap).toBe(false);
    }
    expect(mapUserDocToSnapshot("u", { username: "a" }, ch).planInputs).toEqual({});
  });
});

describe("channel-doc shaping (workspaces/{slug} producer → UserSnapshot.channels consumer)", () => {
  it("workspace channel: requires mattermost.channelId; kind defaults to 'general'", () => {
    expect(mapWorkspaceChannelDoc({ kind: "files", mattermost: { channelId: "C1" } })).toEqual({
      scope: "workspace",
      kind: "files",
      channelId: "C1",
    });
    expect(mapWorkspaceChannelDoc({ mattermost: { channelId: "C2" } })).toEqual({
      scope: "workspace",
      kind: "general",
      channelId: "C2",
    });
    expect(mapWorkspaceChannelDoc({ kind: "files" })).toBeNull(); 
  });

  it("project channel: requires mattermost.channelId; carries projectId; kind defaults to 'default'", () => {
    expect(mapProjectChannelDoc("p1", { mattermost: { channelId: "C3" } })).toEqual({
      scope: "project",
      projectId: "p1",
      kind: "default",
      channelId: "C3",
    });
    expect(mapProjectChannelDoc("p1", { kind: "x" })).toBeNull();
  });
});

describe("byotSystemConfigFromDoc — users/{uid}/system/config → snapshot.systemConfig", () => {
  it("projects active modelCredential into the byot-shaped mount snapshot", () => {
    expect(
      byotSystemConfigFromDoc({
        modelCredential: {
          active: true,
          provider: "openai-codex",
          mode: "oauth",
          status: "active",
          reasonCode: "ok",
          secretName: "byosub-uid-openai",
          model: "openai/gpt-5.5",
        },
      }, {}),
    ).toEqual({ byot: { provider: "openai-codex", model: "openai/gpt-5.5" } });
  });

  it("reports active from modelCredential so callers no longer need users/{uid}.byotActive", () => {
    expect(
      byotSnapshotProjectionFromSystemConfig({
        modelCredential: {
          active: true,
          provider: "anthropic",
          mode: "api_key",
          status: "active",
          reasonCode: "ok",
          secretName: "byok-acme-anthropic",
          fingerprint: "sk-ant...1234",
        },
      }, {}),
    ).toEqual({
      byotActive: true,
      systemConfig: { byot: { provider: "anthropic" } },
    });
  });

  it("treats inactive modelCredential as authoritative over stale legacy byot", () => {
    expect(
      byotSnapshotProjectionFromSystemConfig({
        modelCredential: {
          active: false,
          provider: "openai",
          mode: "api_key",
          status: "missing",
          reasonCode: "missing_credential",
          secretName: "byok-acme-openai",
        },
        byot: { provider: "openai", model: "gpt-4o" },
      }, {}),
    ).toEqual({ byotActive: false });
  });

  it("projects the byot provider/baseUrl/model the in-pod re-assert needs", () => {
    expect(
      byotSystemConfigFromDoc({ byot: { provider: "openai", baseUrl: "https://x", model: "gpt-4o" } }, {}),
    ).toEqual({ byot: { provider: "openai", baseUrl: "https://x", model: "gpt-4o" } });
  });

  it("drops non-string fields and keeps only what is present", () => {
    expect(byotSystemConfigFromDoc({ byot: { provider: "anthropic", model: 123 } }, {})).toEqual({
      byot: { provider: "anthropic" },
    });
  });

  it("returns undefined when there is no usable byot config (so the snapshot stays lean)", () => {
    expect(byotSystemConfigFromDoc(undefined, {})).toBeUndefined();
    expect(byotSystemConfigFromDoc({}, {})).toBeUndefined();
    expect(byotSystemConfigFromDoc({ byot: {} }, {})).toBeUndefined();
    expect(byotSystemConfigFromDoc({ byot: null as unknown as Record<string, unknown> }, {})).toBeUndefined();
  });
});

describe("mapProjectAgentState", () => {
  it("maps a project agent with its minted secret", () => {
    expect(
      mapProjectAgentState(
        "orbit",
        { agent: { activationId: "activation-1", status: "provisioning" } },
        { mattermostUserId: "bot-1", personalToken: "pat-1" },
      ),
    ).toEqual({ projectId: "orbit", enabled: true, mmUserId: "bot-1", token: "pat-1", activationId: "activation-1", status: "provisioning" });
  });

  it("maps an unminted agent with null credentials", () => {
    expect(mapProjectAgentState("orbit", { agent: {} }, null)).toEqual({
      projectId: "orbit",
      enabled: true,
      mmUserId: null,
      token: null, activationId: null, status: null,
    });
  });

  it.each(["commercial", "project-status"])("projects an archived project's agent as retire-pending instead of runnable: %s", archive => {
    expect(
      mapProjectAgentState(
        "orbit",
        {
          agent: {},
          ...(archive === "commercial" ? { commercialLifecycle: { status: "archived" } } : { status: "archived" }),
        },
        { mattermostUserId: "bot-1", personalToken: "pat-1" },
      ),
    ).toEqual({
      projectId: "orbit",
      enabled: false,
      mmUserId: "bot-1",
      token: "pat-1", activationId: null, status: null,
    });
  });

  it("keeps an archived entry while a secret lingers (retire pending)", () => {
    expect(
      mapProjectAgentState("orbit", { agent: {}, commercialLifecycle: { status: "archived" } }, { mattermostUserId: "bot-1", personalToken: "pat-1" }),
    ).toEqual({ projectId: "orbit", enabled: false, mmUserId: "bot-1", token: "pat-1", activationId: null, status: null });
  });

  it("returns null when the project has no agent state at all (snapshot stays lean)", () => {
    expect(mapProjectAgentState("orbit", {}, null)).toBeNull();
    expect(mapProjectAgentState("orbit", { agent: {}, commercialLifecycle: { status: "archived" } }, null)).toBeNull();
  });

  it("treats a malformed agent shape and empty credentials as absent", () => {
    expect(mapProjectAgentState("orbit", { agent: "yes" }, null)).toBeNull();
    expect(
      mapProjectAgentState("orbit", { agent: {} }, { mattermostUserId: "", personalToken: "" }),
    ).toEqual({ projectId: "orbit", enabled: true, mmUserId: null, token: null, activationId: null, status: null });
  });
});

function projectAgentFixture(
  projects: Array<{ id: string; data: Record<string, unknown> }>,
  secrets: Record<string, Record<string, unknown>>,
) {
  return createDocumentFixtureStore({
    ...Object.fromEntries(projects.map((project) => [`workspaces/alice/projects/${project.id}`, { ownerUid: "uid-1", ...project.data }])),
    ...Object.fromEntries(Object.entries(secrets).map(([secretId, row]) => [`users/uid-1/secrets/${secretId}`, row])),
  });
}

describe("collectStoredProjectAgentStates: project agents", () => {
  it("collects live and retire-pending agents, skipping untouched projects", async () => {
    const store = projectAgentFixture(
      [
        { id: "orbit", data: { agent: {} } },
        { id: "plain", data: {} },
        { id: "old", data: { agent: {}, commercialLifecycle: { status: "archived" } } },
      ],
      {
        "projectAgentMattermost-orbit": { mmUserId: "bot-1", personalToken: "pat-1" },
        "projectAgentMattermost-old": { mmUserId: "bot-2", personalToken: "pat-2" },
      },
    );

    const states = await collectStoredProjectAgentStates(store, "uid-1", "alice");

    expect(states).toEqual([
      { projectId: "orbit", enabled: true, mmUserId: "bot-1", token: "pat-1", activationId: null, status: null },
      { projectId: "old", enabled: false, mmUserId: "bot-2", token: "pat-2", activationId: null, status: null },
    ]);
  });

  it("quarantines a malformed identity without blocking healthy projects or retiring its bot", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = projectAgentFixture([
      { id: "broken", data: { agent: { identity: { name: "Broken" }, kickoff: { status: "pending" } } } },
      { id: "healthy", data: { agent: { identity: { name: "Chip", emoji: "⛳", persona: "Caddie" } } } },
    ], {
      "projectAgentMattermost-broken": { mmUserId: "bot-broken", personalToken: "pat-broken" },
      "projectAgentMattermost-healthy": { mmUserId: "bot-healthy", personalToken: "pat-healthy" },
    });
    try {
      const states = await collectStoredProjectAgentStates(store, "uid-1", "alice");
      expect(states).toHaveLength(2);
      expect(states[0]).toEqual({ projectId: "broken", enabled: true, mmUserId: "bot-broken", token: "pat-broken", status: "error", activationId: null });
      expect(states[1]).toMatchObject({ projectId: "healthy", identity: { name: "Chip", emoji: "⛳", persona: "Caddie" } });
      expect(JSON.parse(String(error.mock.calls[0][0]))).toMatchObject({ severity: "ERROR", message: "Project agent identity rejected", projectId: "broken", error: "Invalid project agent identity" });
    } finally { error.mockRestore(); }
  });

  it("drops fully-settled archived agents (no secret left)", async () => {
    const store = projectAgentFixture([{ id: "old", data: { agent: {}, commercialLifecycle: { status: "archived" } } }], {});

    expect(await collectStoredProjectAgentStates(store, "uid-1", "alice")).toEqual([]);
  });

  it("fails closed on a malformed project agent secret", async () => {
    const store = projectAgentFixture([{ id: "orbit", data: { agent: {} } }], {
      "projectAgentMattermost-orbit": { mmUserId: 7, personalToken: "pat-1" },
    });

    await expect(collectStoredProjectAgentStates(store, "uid-1", "alice")).rejects.toBeInstanceOf(MalformedRecordError);
  });
});

describe("collectStoredProjectAgentStates", () => {
  it("maps project records from the store the same way as project documents", async () => {
    const store = createDocumentFixtureStore({
      "workspaces/alice/projects/orbit": { ownerUid: "uid-1", agent: { activationId: "a1", status: "ready" }, status: "building", repoSource: { provider: "github", repo: "acme/orbit" } },
      "workspaces/alice/projects/plain": { ownerUid: "uid-1", status: "building" },
      "workspaces/alice/projects/old": { ownerUid: "uid-1", agent: {}, status: "building", commercialLifecycle: { status: "archived" } },
      "users/uid-1/secrets/projectAgentMattermost-orbit": { mmUserId: "bot-1", personalToken: "pat-1" },
      "users/uid-1/secrets/projectAgentMattermost-old": { mmUserId: "bot-2", personalToken: "pat-2" },
      "users/uid-1/secrets/projectAgentMattermost-gone": { mmUserId: "bot-3", personalToken: "pat-3" },
    });

    const states = await collectStoredProjectAgentStates(store, "uid-1", "alice");

    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: "orbit", enabled: true, mmUserId: "bot-1", token: "pat-1", activationId: "a1", status: "ready" }),
      expect.objectContaining({ projectId: "old", enabled: false, mmUserId: "bot-2" }),
      expect.objectContaining({ projectId: "gone", enabled: false, mmUserId: "bot-3" }),
    ]));
    expect(states).toHaveLength(3);
    expect(states.find((state) => state.projectId === "plain")).toBeUndefined();
  });
});

describe("collectStoredProjectAgentStates: orphaned secrets (deleted projects)", () => {
  it("emits a retire-pending state for a projectAgentMattermost-* secret whose project doc is gone", async () => {
    const store = projectAgentFixture([], {
      "projectAgentMattermost-ghost": { mmUserId: "bot-ghost", personalToken: "pat-ghost" },
      coachMattermost: { personalToken: "default-agent-pat" },
    });

    const states = await collectStoredProjectAgentStates(store, "uid-1", "alice");

    expect(states).toEqual([
      { projectId: "ghost", enabled: false, mmUserId: "bot-ghost", token: "pat-ghost", activationId: null, status: null },
    ]);
  });
});

describe("agent-model selections ride the snapshot regardless of byot state", () => {
  const AGENT_MODELS = {
    "octogee-acme-coach": {
      primary: "platform-openrouter/z-ai/glm-5.2",
      fallbacks: ["anthropic/claude-haiku-4-5"],
    },
  };

  it("projects agentModels alongside an active modelCredential", () => {
    expect(
      byotSnapshotProjectionFromSystemConfig({ modelCredential: { active: true, provider: "anthropic" } }, AGENT_MODELS).systemConfig,
    ).toEqual({ byot: { provider: "anthropic" }, agentModels: AGENT_MODELS });
  });

  it("projects agentModels even when no credential exists (platform user picks)", () => {
    expect(byotSystemConfigFromDoc(undefined, AGENT_MODELS)).toEqual({ agentModels: AGENT_MODELS });
    expect(
      byotSnapshotProjectionFromSystemConfig({ modelCredential: { active: false, provider: "openai" } }, AGENT_MODELS).systemConfig,
    ).toEqual({ agentModels: AGENT_MODELS });
  });

  it("ignores agent model picks left in the system config document", () => {
    expect(byotSystemConfigFromDoc({ agentModels: AGENT_MODELS }, {})).toBeUndefined();
  });

  it("reads a user's agent model picks from the platform store", async () => {
    const list = vi.fn(async () => [
      { uid: "acme", agentId: "octogee-acme-coach", primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: ["anthropic/claude-haiku-4-5"], updatedAt: 1, revision: "1" as Revision },
    ]);

    await expect(readAgentModelSelections({ agentModels: { list, put: vi.fn(), delete: vi.fn() } }, "acme")).resolves.toEqual(AGENT_MODELS);
    expect(list).toHaveBeenCalledWith("acme");
  });
});
