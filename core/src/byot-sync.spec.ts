import {
  CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS,
  claudeCliRuntimeConfig,
  codexRuntimeConfig,
} from "./model-credential-materializer.js";

const CODEX_DEFAULT_MODEL = codexRuntimeConfig().model;
const CLAUDE_CLI_DEFAULT_MODEL = claudeCliRuntimeConfig().model;
import { describe, it, test, expect, beforeEach, afterEach, vi } from "vitest";

const { gatewayRestartRequestSpy, secretsReloadSpy, modelsAuthRefreshSpy, closeSpy, createGatewayRpcSpy } = vi.hoisted(() => {
  const gatewayRestartRequestSpy = vi.fn(async () => ({ status: "requested" }));
  const secretsReloadSpy = vi.fn(async () => ({ ok: true, warningCount: 0 }));
  const modelsAuthRefreshSpy = vi.fn(async () => ({ refreshed: true }));
  const closeSpy = vi.fn(async () => {});
  const createGatewayRpcSpy = vi.fn(() => ({
    gatewayRestartRequest: gatewayRestartRequestSpy,
    secretsReload: secretsReloadSpy,
    modelsAuthRefresh: modelsAuthRefreshSpy,
    close: closeSpy,
    configGet: vi.fn(),
    configPatch: vi.fn(),
    channelsStatus: vi.fn(),
    isGatewayUp: vi.fn(async () => true),
  }));
  return { gatewayRestartRequestSpy, secretsReloadSpy, modelsAuthRefreshSpy, closeSpy, createGatewayRpcSpy };
});

vi.mock("./gateway-rpc", () => ({
  OpenclawWireError: class OpenclawWireError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = "OpenclawWireError";
    }
  },
  createGatewayRpc: createGatewayRpcSpy,
}));

// Hoisted: byot-sync's import graph reaches openclaw-secrets-apply, whose
// top-level `child_process` import evaluates the mock factory below before a
// plain module const would be initialized.
const SUBPROCESS_GUARD = vi.hoisted(() => (name: string) => () => {
  throw new Error(
    `byot-sync must not shell out (called ${name}) — use the in-process gateway-rpc client.`,
  );
});
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: vi.fn(SUBPROCESS_GUARD("spawn")),
    spawnSync: vi.fn(SUBPROCESS_GUARD("spawnSync")),
    exec: vi.fn(SUBPROCESS_GUARD("exec")),
    execSync: vi.fn(SUBPROCESS_GUARD("execSync")),
    execFile: vi.fn(SUBPROCESS_GUARD("execFile")),
    execFileSync: vi.fn(SUBPROCESS_GUARD("execFileSync")),
    fork: vi.fn(SUBPROCESS_GUARD("fork")),
  };
});

vi.mock("./internal-fetch", () => ({ internalFetch: vi.fn() }));

import {
  ISOLATED_CODEX_APP_SERVER,
  applyByotState,
  deriveDesiredByotState,
  byosDefaultAgentConfigPatch,
  defaultAgentFullAgentList,
  HOUSE_MODEL_DEFAULT_AGENT_TOOLS,
  STANDARD_CODEX_APP_SERVER,
} from "./byot-sync.js";
import {
  triggerSecretsReload,
  restoreOauthStoreForSlug,
  brokerFetchByosubCreds,
  applyDefaultAgentModelPatch,
  applyDefaultAgentToolsConvergence,
  applyOauthRuntimeModelAllowlist,
  requestGatewayRestartForRuntimeChange,
  syncByotForUser,
  applyAgentModelOverrides,
  agentIdsForSlug,
  userOauthRuntimeConfigPatch,
  userMountConfigPatch,
  purgeUserOauthRuntime,
  refreshDefaultAgentRuntimeSessions,
} from "./byot-sync-runtime.js";
import { internalFetch } from "./internal-fetch.js";
import type { ApplyConfigPatchOptions } from "./apply-config-patch.js";
import type { SyncByotForUserDeps } from "./byot-sync-runtime.js";
import { codexAuthJsonPath, codexAgentDir, sharedAuthAgentDir } from "./byosub-restore.js";
import { readAuthProfileStore, writeAuthProfileStore } from "./auth-profile-sqlite.js";
import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ON = {
  byotActive: true,
  username: "tester-70",
  planInputs: {},
  provisioning: { openclaw: { status: "complete" } },
};

const LIVE_SIGNUP_OFFER = {
  schemaVersion: 3 as const,
  offerId: "builder-signup",
  offerVersion: 1,
  personalTier: "personal" as const,
  builderTier: "hobby" as const,
  configHash: "config-a",
  claimedAt: new Date(),
  endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
};

const jwt = (claims: Record<string, unknown>) =>
  "e30." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".s";
const codexBlob = () =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt({ email: "u@example.com" }),
      access_token: "acc-1",
      refresh_token: "ref-1",
      account_id: "acct-1",
    },
  });
const noUserOauthRuntimePurge = vi.fn(async () => ({ changed: false, resetCount: 0 }));

describe("user mount configuration projection", () => {
  it("publishes and preserves only env-owned authless broker declarations during user projection", () => {
    vi.stubEnv("OPENROUTER_BASE_URL", "https://broker.example/openrouter");
    vi.stubEnv("PLATFORM_OPENAI_BASE_URL", undefined);
    vi.stubEnv("PLATFORM_VERTEX_BASE_URL", undefined);
    try {
      const expected = { baseUrl: "https://broker.example/openrouter", models: [] };
      const fresh = userMountConfigPatch({}, {}, "alice", "platform-openrouter/z-ai/glm-5.2");
      expect(fresh).toHaveProperty("models.providers.platform-openrouter", expected);
      const retained = userMountConfigPatch({ models: { providers: { "platform-openrouter": expected } } }, {}, "alice", "platform-openrouter/z-ai/glm-5.2");
      expect(retained).toHaveProperty("models.providers.platform-openrouter", expected);
      const poisoned = userMountConfigPatch({ models: { providers: { "platform-openrouter": { ...expected, apiKey: "foreign" } } } }, {}, "alice", "platform-openrouter/z-ai/glm-5.2");
      expect(poisoned).toHaveProperty("models.providers.platform-openrouter.apiKey", null);
    } finally { vi.unstubAllEnvs(); }
  });

  it("keeps the native voice event publisher enabled when a new user is attached", () => {
    const patch = userMountConfigPatch({ plugins: {
      allow: ["octogee-activity-tools"],
      entries: { "octogee-activity-tools": { enabled: true, config: { activityEnabled: false, heartbeatMs: 5000 } } },
    } }, {}, "sep30", "platform-openrouter/z-ai/glm-5.2") as any;
    expect(patch.plugins.allow).toContain("octogee-broker-tools");
    expect(patch.plugins.entries["octogee-broker-tools"]).toMatchObject({ enabled: true });
    expect(patch.plugins.allow).toContain("octogee-activity-tools");
    expect(patch.plugins.entries["octogee-activity-tools"]).not.toBeNull();
    const fresh = userMountConfigPatch({ plugins: { allow: [], entries: {} } }, {}, "sep30", "platform-openrouter/z-ai/glm-5.2") as any;
    expect(fresh.plugins.entries["octogee-activity-tools"]).toEqual({ enabled: true, config: { heartbeatMs: 5000 } });
  });

  it("leaves a plugin token path that already resolves to its placeholder untouched", () => {
    vi.stubEnv("OCTOGEE_API_SA_TOKEN_PATH", "/var/run/secrets/octogee-gateway-broker/token");
    try {
      const resolved = { config: { tokenPath: "/var/run/secrets/octogee-gateway-broker/token" } };
      const drifted = { config: { tokenPath: "/tmp/other-token" } };
      const current = { plugins: { entries: { "octogee-chat-tools": resolved, "octogee-board-tools": drifted } } };
      const patch = userMountConfigPatch(current, {}, "alice", "platform-openrouter/z-ai/glm-5.2", { gatewayEnv: process.env }) as any;
      expect(patch.plugins.entries["octogee-chat-tools"].config).not.toHaveProperty("tokenPath");
      expect(patch.plugins.entries["octogee-board-tools"].config.tokenPath).toBe("${OCTOGEE_API_SA_TOKEN_PATH}");
      const withoutGatewayEnv = userMountConfigPatch(current, {}, "alice", "platform-openrouter/z-ai/glm-5.2") as any;
      expect(withoutGatewayEnv.plugins.entries["octogee-chat-tools"].config.tokenPath).toBe("${OCTOGEE_API_SA_TOKEN_PATH}");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the shared agent-store connection reference when a new user is attached", () => {
    const connection = { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" };
    const database = { families: { agent: { engine: "postgres" } }, postgres: { connection, schemaPrefix: "octogee" } };
    const patch = userMountConfigPatch({ database }, {}, "alice", "platform-openrouter/z-ai/glm-5.2") as any;
    expect(patch).not.toHaveProperty("database");

    const redacted = { ...database, postgres: { ...database.postgres, connection: { ...connection, id: "__OPENCLAW_REDACTED__" } } };
    const fromRedactedRead = userMountConfigPatch({ database: redacted }, {}, "alice", "platform-openrouter/z-ai/glm-5.2") as any;
    expect(fromRedactedRead.database?.postgres?.connection ?? connection).toEqual(connection);
  });

  it("does not restore an unsafe model or direct runtime from the mount candidate", () => {
    const id = "octogee-alice-coach";
    const patch = userMountConfigPatch({}, { agents: { entries: {
      [id]: { model: "openai-codex/unsafe-model", agentRuntime: { id: "codex" } },
    } } }, "alice", "platform-openrouter/z-ai/glm-5.2") as any;
    expect(patch.agents.entries[id].model).toEqual({ primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] });
    expect(patch.agents.entries[id].agentRuntime).toBeNull();
  });

  it.each(["entries", "list"])("combines security cleanup and the final model without losing siblings (%s)", (shape) => {
    const id = "octogee-alice-coach";
    const model = { primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: ["platform-openrouter/openai/gpt-5.6-luna"] };
    const defaultAgent = { id, model, tools: { fs: { workspaceOnly: true } } };
    const sibling = { id: "octogee-bob-coach", name: "Bob", model: "platform-openrouter/z-ai/glm-5.2" };
    const agents = shape === "list" ? { list: [defaultAgent, sibling] } : { entries: {
      [id]: { model, tools: defaultAgent.tools }, [sibling.id]: { name: sibling.name, model: sibling.model },
    } };
    const current = { agents, plugins: { allow: ["codex"], entries: { codex: { enabled: true } } }, models: { providers: { "openai-codex": { api: "openai-responses" } } } };
    const patch = userMountConfigPatch(current, { agents, bindings: [{ agentId: id }] }, "alice", model.primary) as any;
    const projectedDefaultAgent = shape === "list" ? patch.agents.list.find((entry: any) => entry.id === id) : patch.agents.entries[id];
    const projectedSibling = shape === "list" ? patch.agents.list.find((entry: any) => entry.id === sibling.id) : patch.agents.entries[sibling.id];
    expect(projectedDefaultAgent.model).toEqual(model);
    expect(projectedDefaultAgent.tools.fs.workspaceOnly).toBe(true);
    expect(projectedSibling).toMatchObject({ name: "Bob", model: sibling.model });
    expect(patch.plugins.allow).not.toContain("codex");
    expect(patch.plugins.entries.codex).toBeNull();
    expect(patch.models.providers["openai-codex"]).toBeNull();
    expect(patch.bindings).toEqual([{ agentId: id }]);
  });
});

describe("deriveDesiredByotState — gating (characterization)", () => {
  it("disabled unless byotActive + username + status=complete", () => {
    expect(deriveDesiredByotState({ ...ON, byotActive: false }).enabled).toBe(false);
    expect(deriveDesiredByotState({ ...ON, username: undefined }).enabled).toBe(false);
    expect(
      deriveDesiredByotState({ ...ON, provisioning: { openclaw: { status: "in_progress" } } })
        .enabled,
    ).toBe(false);
  });

  it("BYOK agent input carries the dial ref so the fallback chain follows the operator", () => {
    const desired = deriveDesiredByotState({
      ...ON,
      freeTierModelRef: "platform-openai/gpt-6-luna",
    });
    expect(desired.defaultAgentModelInput).toMatchObject({
      slug: "tester-70",
      houseModelRef: "platform-openai/gpt-6-luna",
    });
  });

  it("non-BYOK trial agent keeps the template Sonnet default (no patch)", () => {
    const desired = deriveDesiredByotState({
      ...ON,
      byotActive: false,
      planInputs: { selectedTier: "personal_free", trialGrant: LIVE_SIGNUP_OFFER },
    });
    expect(desired.enabled).toBe(false);
    expect(desired.input).toBeNull();
    expect(desired.defaultAgentModelInput).toBeNull();
  });

  it("trial grant personal pro + user pro keeps the inherited tool surface", () => {
    const desired = deriveDesiredByotState({
      ...ON,
      byotActive: false,
      planInputs: {
        tier: "trial",
        trialGrant: {
          schemaVersion: 3,
          offerId: "builder-pro-preview",
          offerVersion: 1,
          personalTier: "personal_pro",
          builderTier: "pro",
          configHash: "trial-config",
          claimedAt: new Date(),
          endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      },
    });
    expect(desired.enabled).toBe(false);
    expect(desired.input).toBeNull();
    expect(desired.defaultAgentModelInput).toBeNull();
  });

  it("paid non-BYOK user leaves the config default model in place (no cohort pin)", () => {
    const desired = deriveDesiredByotState({
      ...ON,
      byotActive: false,
      planInputs: { selectedTier: "personal" },
      provisioning: { openclaw: { status: "complete" } },
    });
    expect(desired.enabled).toBe(false);
    expect(desired.input).toBeNull();
    expect(desired.defaultAgentModelInput).toBeNull();
  });

  it("a builderSubscription owner (no paid Personal plan) gets no house pin — catalog agent", () => {
    const desired = deriveDesiredByotState({
      ...ON,
      byotActive: false,
      planInputs: { selectedTier: "personal_free", builderSubscription: { tier: "hobby", status: "active" } },
      provisioning: { openclaw: { status: "complete" } },
    });
    expect(desired.enabled).toBe(false);
    expect(desired.input).toBeNull();
    // catalog access = no free-tier house-model pin (the split-brain bug: this
    // was pinned to the house model before resolveBillingProfile).
    expect(desired.defaultAgentModelInput).toBeNull();
  });

  it("unknown/absent provider falls back to anthropic (api_key default)", () => {
    expect(deriveDesiredByotState({ ...ON }).input).toEqual({
      slug: "tester-70",
      provider: "anthropic",
      baseUrl: undefined,
      model: undefined,
    });
    expect(
      deriveDesiredByotState({ ...ON, systemConfig: { byot: { provider: "bogus" } } }).input!
        .provider,
    ).toBe("anthropic");
  });
});

describe("deriveDesiredByotState — recognizes every PROVIDERS-registry provider", () => {
  it.each(["openai", "openai-compatible", "anthropic"] as const)(
    "BYOT api_key provider %s is recognized (regression)",
    (provider) => {
      expect(
        deriveDesiredByotState({ ...ON, systemConfig: { byot: { provider } } }).input!.provider,
      ).toBe(provider);
    },
  );

  it("BYOS oauth provider openai-codex is recognized (rides the SAME sync path as BYOT)", () => {
    const { enabled, input } = deriveDesiredByotState({
      ...ON,
      systemConfig: { byot: { provider: "openai-codex" } },
    });
    expect(enabled).toBe(true);
    expect(input).toEqual({
      slug: "tester-70",
      provider: "openai-codex",
      baseUrl: undefined,
      model: undefined,
    });
  });

  it("BYOS oauth provider claude-cli (Claude subscription) is recognized — rides the same sync path", () => {
    const { enabled, input } = deriveDesiredByotState({
      ...ON,
      systemConfig: { byot: { provider: "claude-cli" } },
    });
    expect(enabled).toBe(true);
    expect(input).toEqual({
      slug: "tester-70",
      provider: "claude-cli",
      baseUrl: undefined,
      model: undefined,
    });
  });
});

describe("triggerSecretsReload — in-process RPC, no subprocess", () => {
  beforeEach(() => {
    gatewayRestartRequestSpy.mockClear();
    secretsReloadSpy.mockClear();
    closeSpy.mockClear();
    createGatewayRpcSpy.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("calls gateway-rpc.secretsReload() and closes the client", async () => {
    secretsReloadSpy.mockResolvedValueOnce({ ok: true, warningCount: 0 });
    await triggerSecretsReload();
    expect(createGatewayRpcSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowLegacyGatewayTokenFallback: true,
        callTimeoutMs: 10_000,
        connectTimeoutMs: 10_000,
      }),
    );
    expect(secretsReloadSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test("never throws on a transport failure — best-effort contract preserved", async () => {
    secretsReloadSpy.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(triggerSecretsReload()).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test("still closes the client when the RPC throws (no resource leak)", async () => {
    secretsReloadSpy.mockRejectedValueOnce(new Error("auth-failed"));
    await triggerSecretsReload();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("requestGatewayRestartForRuntimeChange — in-process RPC, no subprocess", () => {
  beforeEach(() => {
    gatewayRestartRequestSpy.mockClear();
    closeSpy.mockClear();
    createGatewayRpcSpy.mockClear();
  });

  test("requests an OpenClaw-aware restart and closes the client", async () => {
    gatewayRestartRequestSpy.mockResolvedValueOnce({ status: "requested" });
    await expect(requestGatewayRestartForRuntimeChange()).resolves.toBe(true);
    expect(createGatewayRpcSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        allowLegacyGatewayTokenFallback: true,
        callTimeoutMs: 10_000,
        connectTimeoutMs: 10_000,
      }),
    );
    expect(gatewayRestartRequestSpy).toHaveBeenCalledWith({
      reason: "byosub.oauth-runtime",
      skipDeferral: true,
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  test("returns false on restart failure so sync can fall back to secrets.reload", async () => {
    gatewayRestartRequestSpy.mockRejectedValueOnce(new Error("restart disabled"));
    await expect(requestGatewayRestartForRuntimeChange()).resolves.toBe(false);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

import { seedOpenClawAgentDbForId } from "./fixtures/openclaw-agent-db.js";

// openclaw owns creating an agent database; these restore paths only update
// one. Fixtures stand up the store the gateway would already have made.
const seedAgent = (openclawDir: string, agentId: string) =>
  seedOpenClawAgentDbForId(path.join(openclawDir, "agents"), agentId);

describe("restoreOauthStoreForSlug — post-boot-mount oauth-store materialization", () => {
  const tmps: string[] = [];
  const mk = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "byot-oauth-"));
    tmps.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("restores the per-agent Codex profile for a mounted oauth user without writing a codex-home auth.json", async () => {
    const oc = mk();
    seedAgent(oc, "octogee-tester-70-coach");
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => [
        {
          provider: "openai",
          secretName: "byosub-uid-openai",
          credential: codexBlob(),
        },
      ],
      openclawDir: oc,
    });
    expect(r.restored).toBe(true);
    expect(r.present).toBe(true);
    expect(fs.existsSync(codexAuthJsonPath(oc, "octogee-tester-70-coach"))).toBe(false);

    const agentDir = codexAgentDir(oc, "octogee-tester-70-coach");
    const prof = readAuthProfileStore(agentDir) as {
      version: number;
      profiles: Record<string, unknown>;
    };
    expect(prof.version).toBe(1);
    expect(prof.profiles["openai:octogee-chatgpt"]).toMatchObject({
      type: "oauth",
      provider: "openai",
      access: "acc-1",
      refresh: "ref-1",
      expires: 0,
      copyToAgents: true,
    });
  });

  it("restores the subscription once into OpenClaw's shared store so every agent inherits one refresher", async () => {
    const oc = mk();
    fs.mkdirSync(path.join(oc, "state"), { recursive: true });
    const stateDb = new DatabaseSync(path.join(oc, "state", "openclaw.sqlite"));
    stateDb.exec(
      "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
    );
    stateDb.prepare("INSERT INTO config_machine_state VALUES ('auth.sharedStore', ?, 1)").run(
      JSON.stringify({ location: "state-db" }),
    );
    stateDb.close();
    const defaultAgent = "octogee-tester-70-coach";
    const project = "octogee-tester-70-proj-golf-coach";
    seedAgent(oc, defaultAgent);
    seedAgent(oc, project);
    writeAuthProfileStore(codexAgentDir(oc, defaultAgent), {
      version: 1,
      profiles: {
        "openai:octogee-chatgpt": { type: "oauth", provider: "openai", access: "stale" },
        "platform-openrouter:default": { type: "api_key", provider: "platform-openrouter" },
      },
    });
    for (const agentId of [defaultAgent, project]) {
      const stale = codexAuthJsonPath(oc, agentId);
      fs.mkdirSync(path.dirname(stale), { recursive: true });
      fs.writeFileSync(stale, JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "stale" } }));
    }

    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => [
        { provider: "openai", secretName: "byosub-uid-openai", credential: codexBlob() },
      ],
      openclawDir: oc,
      agentIds: [defaultAgent, project],
    });

    expect(r).toMatchObject({ restored: true, present: true });
    const shared = readAuthProfileStore(sharedAuthAgentDir(oc)) as { profiles: Record<string, unknown> };
    expect(shared.profiles["openai:octogee-chatgpt"]).toMatchObject({ access: "acc-1", refresh: "ref-1" });
    const defaultAgentStore = readAuthProfileStore(codexAgentDir(oc, defaultAgent)) as { profiles: Record<string, unknown> };
    expect(defaultAgentStore.profiles["openai:octogee-chatgpt"]).toBeUndefined();
    expect(defaultAgentStore.profiles["platform-openrouter:default"]).toBeDefined();
    expect(readAuthProfileStore(codexAgentDir(oc, project))).toBeNull();
    expect(fs.existsSync(codexAuthJsonPath(oc, defaultAgent))).toBe(false);
    expect(fs.existsSync(codexAuthJsonPath(oc, project))).toBe(false);
  });

  it("drops a disconnected subscription from the shared store when another stays connected", async () => {
    const oc = mk();
    fs.mkdirSync(path.join(oc, "state"), { recursive: true });
    const stateDb = new DatabaseSync(path.join(oc, "state", "openclaw.sqlite"));
    stateDb.exec(
      "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
    );
    stateDb.prepare("INSERT INTO config_machine_state VALUES ('auth.sharedStore', ?, 1)").run(
      JSON.stringify({ location: "state-db" }),
    );
    stateDb.close();
    writeAuthProfileStore(sharedAuthAgentDir(oc), {
      version: 1,
      profiles: {
        "anthropic:claude-cli": { type: "oauth", provider: "claude-cli", access: "disconnected" },
      },
    });

    await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => [
        { provider: "openai", secretName: "byosub-uid-openai", credential: codexBlob() },
      ],
      openclawDir: oc,
      agentIds: [],
    });

    const shared = readAuthProfileStore(sharedAuthAgentDir(oc)) as { profiles: Record<string, unknown> };
    expect(shared.profiles["anthropic:claude-cli"]).toBeUndefined();
    expect(shared.profiles["openai:octogee-chatgpt"]).toMatchObject({ access: "acc-1" });
  });

  it("materializes Claude and Codex from one hosted-agent broker response", async () => {
    const oc = mk();
    seedAgent(oc, "octogee-tester-70-coach");
    const home = mk();
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => [
        {
          provider: "openai",
          secretName: "byosub-uid-openai",
          credential: codexBlob(),
        },
        {
          provider: "anthropic",
          secretName: "byosub-uid-anthropic",
          credential: JSON.stringify({
            claudeAiOauth: {
              accessToken: "claude-access-1",
              refreshToken: "claude-refresh-1",
              expiresAt: Date.now() + 24 * 60 * 60 * 1000,
            },
          }),
        },
      ],
      openclawDir: oc,
      claudeCliNativeHomeDir: home,
    });

    expect(r).toEqual({ restored: true, present: true, providers: ["openai", "anthropic"] });
    expect(fs.existsSync(codexAuthJsonPath(oc, "octogee-tester-70-coach"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude", ".credentials.json"))).toBe(true);
    const prof = readAuthProfileStore(codexAgentDir(oc, "octogee-tester-70-coach")) as {
      profiles: Record<string, { provider?: string; access?: string }>;
    };
    expect(prof.profiles["openai:octogee-chatgpt"]).toMatchObject({
      provider: "openai",
      access: "acc-1",
    });
    expect(prof.profiles["anthropic:claude-cli"]).toMatchObject({
      provider: "anthropic",
      access: "claude-access-1",
    });
  });

  it("Copilot #2: a FAILED restore does NOT activate (not restored, not present)", async () => {
    const oc = mk();
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => {
        throw new Error("transient broker failure");
      },
      openclawDir: oc,
      logFn: () => {},
    });
    expect(r.restored).toBe(false);
    expect(r.present).toBe(false);
    const ap = path.join(oc, "agents", "octogee-tester-70-coach", "agent", "auth-profiles.json");
    expect(fs.existsSync(ap)).toBe(false); 
  });

  it("not restored / not present when this user has no byosub ref (nothing to restore)", async () => {
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => null,
      openclawDir: mk(),
    });
    expect(r.restored).toBe(false);
    expect(r.present).toBe(false);
  });

  it("never throws — a fetch failure is neither restored nor present (mount continues)", async () => {
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds: async () => {
        throw new Error("glmGateways read failed");
      },
      openclawDir: mk(),
      logFn: () => {},
    });
    expect(r.restored).toBe(false);
    expect(r.present).toBe(false);
  });

  it("re-mount over a healthy on-disk cred → conservative skip → NOT restored but present", async () => {
    const oc = mk();
    seedAgent(oc, "octogee-tester-70-coach");
    const opts = {
      fetchByosubCreds: async () => [
        {
          provider: "openai" as const,
          secretName: "byosub-uid-openai",
          credential: codexBlob(),
        },
      ],
      openclawDir: oc,
      logFn: () => {},
    };
    
    const first = await restoreOauthStoreForSlug("tester-70", opts);
    expect(first.restored).toBe(true);
    expect(first.present).toBe(true);

    const second = await restoreOauthStoreForSlug("tester-70", opts);
    expect(second.restored).toBe(false);
    expect(second.present).toBe(true);
    expect(second.providers).toEqual(["openai"]);
  });
});

describe("brokerFetchByosubCreds — gateway-side broker client (no silent failures)", () => {
  beforeEach(() => vi.mocked(internalFetch).mockReset());

  it("returns the materialized credentials on 200", async () => {
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          credentials: [
            {
              provider: "anthropic",
              secretName: "byosub-uid-anthropic",
              credential: "tok",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    expect(await brokerFetchByosubCreds("octogee-tester5-coach")).toEqual([
      {
        provider: "anthropic",
        secretName: "byosub-uid-anthropic",
        credential: "tok",
      },
    ]);
  });

  it("returns null on 404 (no byosub ref for this agent — nothing to restore)", async () => {
    vi.mocked(internalFetch).mockResolvedValue(new Response("{}", { status: 404 }));
    expect(await brokerFetchByosubCreds("octogee-tester5-coach")).toBeNull();
  });

  it("throws on a non-ok, non-404 status (fail loud, never a silent skip)", async () => {
    vi.mocked(internalFetch).mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(brokerFetchByosubCreds("octogee-tester5-coach")).rejects.toThrow(/500/);
  });

  it("throws on a malformed broker response (never a half-materialized cred)", async () => {
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({ provider: "anthropic" }), { status: 200 }),
    );
    await expect(brokerFetchByosubCreds("octogee-tester5-coach")).rejects.toThrow(/malformed/);
  });
});

// Every BYOK agent model is a primary+fallback chain to the platform house
// model baseline (B6) — the operator's free-tier dial, compiled default
// Errands (GPT-6 Luna) on the OpenAI platform key.
const HOUSE_REF = "platform-openai/gpt-6-luna";
const HOUSE_DEFAULTS = { [HOUSE_REF]: {} };
const withFallback = (primary: string) => ({
  primary,
  fallbacks: [HOUSE_REF],
});

const claudeCliDefaultModels = {
  ...Object.fromEntries(CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS.map((ref) => [ref, {}])),
};

describe("byosDefaultAgentConfigPatch — durable default-agent-model patch (#1001 core)", () => {
  const id = "octogee-tester-70-coach";
  it("null input / no-override providers → null (keep gateway default, no per-agent model)", () => {
    expect(byosDefaultAgentConfigPatch(null)).toBeNull();
    expect(byosDefaultAgentConfigPatch({ slug: "tester-70", provider: "anthropic" })).toBeNull();
  });

  it("free-tier anthropic pin → bare primary, no fallback, no defaults entry", () => {
    expect(
      byosDefaultAgentConfigPatch({
        slug: "tester-70",
        model: "anthropic/claude-haiku-4-5",
        source: "house-model",
      }),
    ).toEqual({
      agents: {
        list: [
          {
            id,
            model: { primary: "anthropic/claude-haiku-4-5", fallbacks: [] },
            tools: HOUSE_MODEL_DEFAULT_AGENT_TOOLS,
          },
        ],
      },
    });
  });

  it("free-tier openai pin → declares the platform-openai ref in agents.defaults.models", () => {
    expect(
      byosDefaultAgentConfigPatch({
        slug: "tester-70",
        model: "platform-openai/gpt-5.4-mini",
        source: "house-model",
      }),
    ).toEqual({
      agents: {
        defaults: { models: { "platform-openai/gpt-5.4-mini": {} } },
        list: [
          {
            id,
            model: { primary: "platform-openai/gpt-5.4-mini", fallbacks: [] },
            tools: HOUSE_MODEL_DEFAULT_AGENT_TOOLS,
          },
        ],
      },
    });
  });

  it("free-tier vertex pin → declares the platform-vertex ref in agents.defaults.models", () => {
    expect(
      byosDefaultAgentConfigPatch({
        slug: "tester-70",
        model: "platform-vertex/claude-haiku-4-5",
        source: "house-model",
      }),
    ).toEqual({
      agents: {
        defaults: { models: { "platform-vertex/claude-haiku-4-5": {} } },
        list: [
          {
            id,
            model: { primary: "platform-vertex/claude-haiku-4-5", fallbacks: [] },
            tools: HOUSE_MODEL_DEFAULT_AGENT_TOOLS,
          },
        ],
      },
    });
  });

  it("BYOK fallback on an openai dial declares the platform-openai ref in defaults", () => {
    expect(
      byosDefaultAgentConfigPatch({
        slug: "tester-70",
        provider: "openai",
        houseModelRef: "platform-openai/gpt-5.4-mini",
      }),
    ).toEqual({
      agents: {
        defaults: { models: { "platform-openai/gpt-5.4-mini": {} } },
        list: [
          {
            id,
            model: { primary: "openai/gpt-5", fallbacks: ["platform-openai/gpt-5.4-mini"] },
          },
        ],
      },
    });
  });

  it("free-tier openrouter pin → declares the ref in agents.defaults.models so a dial outside the boot template resolves", () => {
    expect(
      byosDefaultAgentConfigPatch({
        slug: "tester-70",
        model: "platform-openai/gpt-6-luna",
        source: "house-model",
      }),
    ).toEqual({
      agents: {
        defaults: { models: { "platform-openai/gpt-6-luna": {} } },
        list: [
          {
            id,
            model: { primary: "platform-openai/gpt-6-luna", fallbacks: [] },
            tools: HOUSE_MODEL_DEFAULT_AGENT_TOOLS,
          },
        ],
      },
    });
  });

  it("BYOK fallback follows the input's dial ref and declares an openrouter ref in defaults", () => {
    expect(
      byosDefaultAgentConfigPatch({
        slug: "tester-70",
        provider: "openai",
        houseModelRef: "platform-openai/gpt-6-luna",
      }),
    ).toEqual({
      agents: {
        defaults: { models: { "platform-openai/gpt-6-luna": {} } },
        list: [
          {
            id,
            model: {
              primary: "openai/gpt-5",
              fallbacks: ["platform-openai/gpt-6-luna"],
            },
          },
        ],
      },
    });
  });

  it("a non-catalog houseModelRef on a BYOK input falls back to the compiled default", () => {
    expect(
      byosDefaultAgentConfigPatch({
        slug: "tester-70",
        provider: "openai",
        houseModelRef: "platform-openrouter/evil/model",
      }),
    ).toEqual({
      agents: {
        defaults: { models: HOUSE_DEFAULTS },
        list: [{ id, model: withFallback("openai/gpt-5") }],
      },
    });
  });

  it("openai-codex → agent model + agentRuntime:codex; runtime allowlist owns codex plugin config", () => {
    expect(byosDefaultAgentConfigPatch({ slug: "tester-70", provider: "openai-codex" })).toEqual({
      agents: {
        list: [{ id, model: withFallback(CODEX_DEFAULT_MODEL) }],
        defaults: {
          models: { ...codexRuntimeConfig().modelsDef, ...HOUSE_DEFAULTS },
        },
      },
    });
  });

  it("claude-cli (Claude subscription) → default model plus the Claude CLI provider catalog", () => {
    expect(byosDefaultAgentConfigPatch({ slug: "tester-70", provider: "claude-cli" })).toEqual({
      agents: {
        list: [{ id, model: withFallback(CLAUDE_CLI_DEFAULT_MODEL) }],
        defaults: {
          models: { ...claudeCliDefaultModels, ...HOUSE_DEFAULTS },
        },
      },
    });
  });

  it("openai (api_key) → agent model + the house fallback's defaults entry, NO agentRuntime pin", () => {
    expect(byosDefaultAgentConfigPatch({ slug: "tester-70", provider: "openai" })).toEqual({
      agents: {
        defaults: { models: HOUSE_DEFAULTS },
        list: [{ id, model: withFallback("openai/gpt-5") }],
      },
    });
  });

  it("openai-compatible → namespaced custom model, no agentRuntime pin", () => {
    expect(
      byosDefaultAgentConfigPatch({
        slug: "tester-70",
        provider: "openai-compatible",
        baseUrl: "https://llm.example.com",
        model: "llama-3.1-70b",
      }),
    ).toEqual({
      agents: {
        defaults: { models: HOUSE_DEFAULTS },
        list: [{ id, model: withFallback("custom-tester-70/llama-3.1-70b") }],
      },
    });
  });
});

describe("defaultAgentFullAgentList — full-list upsert (defaultAgent model updated, every sibling preserved)", () => {
  it("updates only the agent's model, preserving its other fields + every sibling (incl. an id-less one)", () => {
    const current = {
      agents: {
        list: [
          { name: "legacy", model: "x/y" }, // id-less: this is what flips the array to wholesale
          { id: "octogee-tester-70-coach", name: "coach", model: "old", mmAccount: "a" },
          { id: "octogee-zed-coach", model: "z/y" },
        ],
      },
    };
    expect(defaultAgentFullAgentList(current, "octogee-tester-70-coach", withFallback("openai/gpt-5"))).toEqual([
      { name: "legacy", model: "x/y" },
      { id: "octogee-tester-70-coach", name: "coach", model: withFallback("openai/gpt-5"), mmAccount: "a" },
      { id: "octogee-zed-coach", model: "z/y" },
    ]);
  });

  it("no agents.list (empty/missing) → [] (a no-op patch, never a destructive replace)", () => {
    expect(defaultAgentFullAgentList(undefined, "octogee-tester-70-coach", withFallback("m"))).toEqual([]);
    expect(defaultAgentFullAgentList({ agents: {} }, "octogee-tester-70-coach", withFallback("m"))).toEqual([]);
  });
});

describe("tier-derived agent tools — house_only trims the model-visible tool surface", () => {
  const id = "octogee-tester-70-coach";

  it("pins the keep-list: minimal profile + the free-coach alsoAllow set", () => {
    expect(HOUSE_MODEL_DEFAULT_AGENT_TOOLS).toEqual({
      profile: "minimal",
      alsoAllow: [
        "read",
        "write",
        "edit",
        "apply_patch",
        "web_search",
        "web_fetch",
        "brave_search",
        "tavily_search",
        "tavily_extract",
        "memory_search",
        "memory_get",
        "octogee_chat_search",
        "octogee_chat_history",
        "octogee_chat_set_identity",
        "octogee_connection_request",
        "octogee_ask_ops",
        "octogee_google_calendar_events",
        "octogee_google_calendar_create",
        "octogee_google_calendar_create_approved",
        "octogee_google_calendar_update",
        "octogee_google_calendar_update_approved",
        "octogee_google_calendar_delete",
        "octogee_google_calendar_delete_approved",
        "octogee_google_gmail_search",
        "octogee_google_gmail_get",
        "octogee_google_gmail_triage",
        "octogee_google_gmail_triage_approved",
        "octogee_google_gmail_draft_create",
        "octogee_google_gmail_draft_create_approved",
        "octogee_google_gmail_draft_send",
        "octogee_google_gmail_draft_send_approved",
        "octogee_google_drive_read",
        "octogee_google_docs_read",
        "octogee_google_docs_write",
        "octogee_google_contacts_read",
        "octogee_google_tasks_lists",
        "octogee_google_tasks_list",
        "octogee_google_tasks_add",
        "octogee_google_tasks_add_approved",
        "octogee_google_tasks_update",
        "octogee_google_tasks_update_approved",
        "octogee_google_sheets_read",
        "octogee_google_sheets_write",
        "octogee_obsidian_read",
        "octogee_obsidian_write",
        "octogee_owner_automations",
        "octogee_project_create",
        "octogee_project_list",
        "workspace_commit",
        "octogee_project_commit",
        "octogee_project_capability",
        "octogee_project_build",
        "octogee_project_test",
        "octogee_project_preview",
        "octogee_project_run_status",
        "octogee_project_publish",
        "octogee_project_services",
        "octogee_project_attach_services",
        "octogee_project_deploy_rules",
        "octogee_project_enable_database",
        "octogee_project_deploy_database",
        "octogee_project_restore_database",
        "octogee_project_set_recipe",
        "octogee_board_list",
        "octogee_board_card_read",
        "octogee_board_card_create",
        "octogee_board_card_update",
        "octogee_board_card_move",
        "octogee_board_card_comment",
      ],
    });
  });

  it("never lists a globally-denied user host-code tool", () => {
    for (const denied of [
      "exec",
      "process",
      "subagents",
      "sessions_spawn",
      "terminal",
      "preview_start",
      "octogee_publish",
    ]) {
      expect(HOUSE_MODEL_DEFAULT_AGENT_TOOLS.alsoAllow).not.toContain(denied);
    }
  });

  it("house_only (free-tier source) entry carries the tools block", () => {
    const patch = byosDefaultAgentConfigPatch({
      slug: "tester-70",
      model: "anthropic/claude-haiku-4-5",
      source: "house-model",
    });
    expect(patch?.agents.list[0].tools).toEqual(HOUSE_MODEL_DEFAULT_AGENT_TOOLS);
  });

  it("catalog-access (BYOK) entry carries NO tools override — inherits the gateway default", () => {
    const patch = byosDefaultAgentConfigPatch({ slug: "tester-70", provider: "openai" });
    expect(patch?.agents.list[0]).not.toHaveProperty("tools");
  });

  it("defaultAgentFullAgentList merges the block over existing entry tools (fs.workspaceOnly preserved), siblings untouched", () => {
    const current = {
      agents: {
        list: [
          { id, name: "coach", model: "old", tools: { fs: { workspaceOnly: true } } },
          { id: "octogee-zed-coach", model: "z/y", tools: { fs: { workspaceOnly: true } } },
        ],
      },
    };
    expect(
      defaultAgentFullAgentList(current, id, withFallback("m"), HOUSE_MODEL_DEFAULT_AGENT_TOOLS),
    ).toEqual([
      {
        id,
        name: "coach",
        model: withFallback("m"),
        tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS },
      },
      { id: "octogee-zed-coach", model: "z/y", tools: { fs: { workspaceOnly: true } } },
    ]);
  });

  it("defaultAgentFullAgentList with tools:null strips profile/alsoAllow but keeps fs — upgrade restores the inherited surface", () => {
    const current = {
      agents: {
        list: [
          {
            id,
            model: "old",
            tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS },
          },
        ],
      },
    };
    expect(defaultAgentFullAgentList(current, id, withFallback("m"), null)).toEqual([
      { id, model: withFallback("m"), tools: { fs: { workspaceOnly: true } } },
    ]);
  });

  it("defaultAgentFullAgentList with model:null converges tools without touching the model (plan-only reassert)", () => {
    const current = {
      agents: { list: [{ id, model: "keep-me", tools: { fs: { workspaceOnly: true } } }] },
    };
    expect(defaultAgentFullAgentList(current, id, null, HOUSE_MODEL_DEFAULT_AGENT_TOOLS)).toEqual([
      {
        id,
        model: "keep-me",
        tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS },
      },
    ]);
  });

  it("stripping the only tools keys drops the tools field entirely rather than shipping tools:{}", () => {
    const current = {
      agents: { list: [{ id, model: "old", tools: { ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS } }] },
    };
    expect(defaultAgentFullAgentList(current, id, null, null)).toEqual([{ id, model: "old" }]);
  });

  it("tools:undefined leaves the entry's tools untouched (pure model update, legacy call shape)", () => {
    const current = {
      agents: {
        list: [{ id, model: "old", tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS } }],
      },
    };
    expect(defaultAgentFullAgentList(current, id, withFallback("m"))).toEqual([
      { id, model: withFallback("m"), tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS } },
    ]);
  });

  it("strip is fingerprint-gated: a user-authored profile/alsoAllow that is NOT the platform block survives the catalog convergence", () => {
    const authored = { profile: "full", alsoAllow: ["browser"] };
    const current = {
      agents: { list: [{ id, model: "old", tools: { fs: { workspaceOnly: true }, ...authored } }] },
    };
    expect(defaultAgentFullAgentList(current, id, withFallback("m"), null)).toEqual([
      { id, model: withFallback("m"), tools: { fs: { workspaceOnly: true }, ...authored } },
    ]);
  });

  it("strip is fingerprint-gated: a partially-matching block (same profile, different alsoAllow) survives too", () => {
    const legacy = { profile: "minimal", alsoAllow: ["read", "write"] };
    const current = { agents: { list: [{ id, model: "old", tools: legacy }] } };
    expect(defaultAgentFullAgentList(current, id, null, null)).toEqual([
      { id, model: "old", tools: legacy },
    ]);
  });

  it("the house_only merge still overwrites a user-authored block — the free plan is platform-tuned (accepted tradeoff)", () => {
    const current = {
      agents: { list: [{ id, model: "old", tools: { profile: "full", alsoAllow: ["browser"] } }] },
    };
    expect(defaultAgentFullAgentList(current, id, null, HOUSE_MODEL_DEFAULT_AGENT_TOOLS)).toEqual([
      { id, model: "old", tools: { ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS } },
    ]);
  });
});

describe("applyDefaultAgentToolsConvergence — plan-gated tools reassert when no model patch ships", () => {
  const id = "octogee-tester-70-coach";
  const CURRENT = {
    agents: {
      list: [
        { id, model: "picked/model", tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS } },
        { id: "octogee-zed-coach", model: "z/y" },
      ],
    },
  };

  it("catalog (houseOnly:false) strips a lingering trim on the next re-assert without touching the model", async () => {
    const calls: object[] = [];
    let replacePaths: string[] | undefined;
    let skipIfAlreadyApplied: boolean | undefined;
    const r = await applyDefaultAgentToolsConvergence("tester-70", false, {
      applyConfigPatch: async (args) => {
        calls.push(args.buildPatch(CURRENT));
        replacePaths = args.buildReplacePaths?.(CURRENT);
        skipIfAlreadyApplied = args.skipIfAlreadyApplied;
        return { mode: "rpc", attempts: 1 };
      },
    });
    expect(r).toBe(true);
    expect(skipIfAlreadyApplied).toBe(true);
    expect(replacePaths).toEqual([
      "agents.list",
      "agents.list[].model.fallbacks",
      "agents.list[].tools.alsoAllow",
    ]);
    expect(calls).toEqual([
      {
        agents: {
          list: [
            { id, model: "picked/model", tools: { fs: { workspaceOnly: true } } },
            { id: "octogee-zed-coach", model: "z/y" },
          ],
        },
      },
    ]);
  });

  it("houseOnly:true re-asserts the trim (model untouched)", async () => {
    const calls: object[] = [];
    const r = await applyDefaultAgentToolsConvergence("tester-70", true, {
      applyConfigPatch: async (args) => {
        calls.push(args.buildPatch({ agents: { list: [{ id, model: "house/pin" }] } }));
        return { mode: "rpc", attempts: 1 };
      },
    });
    expect(r).toBe(true);
    expect(calls).toEqual([
      { agents: { list: [{ id, model: "house/pin", tools: { ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS } }] } },
    ]);
  });

  it("updates a beta keyed agent entry without sending the retired agents.list field", async () => {
    const calls: object[] = [];
    const paths: Array<string[] | undefined> = [];
    const current = {
      agents: {
        entries: {
          [id]: {
            model: "picked/model",
            tools: { fs: { workspaceOnly: true }, alsoAllow: ["stale-tool"] },
          },
          "octogee-zed-coach": { model: "z/y" },
        },
      },
    };

    await expect(applyDefaultAgentToolsConvergence("tester-70", true, {
      applyConfigPatch: async (args) => {
        calls.push(args.buildPatch(current));
        paths.push(args.buildReplacePaths?.(current));
        return { mode: "rpc", attempts: 1 };
      },
    })).resolves.toBe(true);

    expect(paths).toEqual([[
      `agents.entries.${id}.model.fallbacks`,
      `agents.entries.${id}.tools.alsoAllow`,
    ]]);
    expect(calls).toEqual([
      {
        agents: {
          entries: {
            [id]: {
              model: "picked/model",
              tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS },
            },
          },
        },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('"list"');
  });

  it("returns false and logs loudly when the agent entry is absent — never a silent success on the repair path", async () => {
    const logs: string[] = [];
    const r = await applyDefaultAgentToolsConvergence("tester-70", false, {
      applyConfigPatch: async (args) => {
        args.buildPatch({ agents: { list: [{ id: "octogee-zed-coach", model: "z/y" }] } });
        return { mode: "rpc", attempts: 1 };
      },
      logFn: (m) => logs.push(m),
    });
    expect(r).toBe(false);
    expect(logs.join("\n")).toMatch(/⚠.*octogee-tester-70-coach.*missing/);
    expect(logs.join("\n")).not.toMatch(/converged/);
  });

  it("never throws — a failed apply returns false (retried next sync)", async () => {
    const r = await applyDefaultAgentToolsConvergence("tester-70", false, {
      applyConfigPatch: async () => {
        throw new Error("config.patch hash-mismatch exhausted");
      },
      logFn: () => {},
    });
    expect(r).toBe(false);
  });
});

describe("applyDefaultAgentModelPatch — applies the durable patch, best-effort", () => {
  const CURRENT = {
    agents: {
      list: [
        { id: "octogee-tester-70-coach", name: "coach", model: "old", mmAccount: "a" },
        { id: "octogee-zed-coach", model: "z/y" },
      ],
    },
  };

  it("openai api_key input → ships the FULL agents.list + the full-agent-list replacePaths set (incl. per-entry shrink confirmations), only the agent's model updated", async () => {
    const calls: object[] = [];
    let replacePaths: string[] | undefined;
    const r = await applyDefaultAgentModelPatch(
      { slug: "tester-70", provider: "openai" },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(CURRENT));
          replacePaths = args.buildReplacePaths?.(CURRENT);
          return { mode: "rpc", attempts: 1 };
        },
      },
    );
    expect(r).toBe(true);
    // Load-bearing: an id-less base agent flips agents.list to wholesale, where
    // the guard (arrayPreservesBaseEntries) flags the re-modeled agent entry as
    // "removed" unless this exact path is confirmed. The per-entry wildcard paths
    // cover the id-keyed case, where the guard descends INTO the agent entry and
    // names its shrunk arrays individually. Without them applyConfigPatch rejects
    // the patch permanently and the agent silently stays on the platform key.
    expect(replacePaths).toEqual([
      "agents.list",
      "agents.list[].model.fallbacks",
      "agents.list[].tools.alsoAllow",
    ]);
    expect(calls).toEqual([
      {
        agents: {
          defaults: { models: HOUSE_DEFAULTS },
          list: [
            { id: "octogee-tester-70-coach", name: "coach", model: withFallback("openai/gpt-5"), mmAccount: "a" },
            { id: "octogee-zed-coach", model: "z/y" },
          ],
        },
      },
    ]);
  });

  it("updates a beta keyed agent entry without writing the rejected agents.list field", async () => {
    const calls: object[] = [];
    const paths: Array<string[] | undefined> = [];
    const current = {
      agents: {
        entries: {
          "octogee-tester-70-coach": { name: "coach", model: "old", mmAccount: "a" },
          "octogee-zed-coach": { model: "z/y" },
        },
      },
    };

    await expect(applyDefaultAgentModelPatch(
      { slug: "tester-70", provider: "openai" },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(current));
          paths.push(args.buildReplacePaths?.(current));
          return { mode: "rpc", attempts: 1 };
        },
      },
    )).resolves.toBe(true);

    expect(paths).toEqual([[
      "agents.entries.octogee-tester-70-coach.model.fallbacks",
      "agents.entries.octogee-tester-70-coach.tools.alsoAllow",
    ]]);
    expect(calls).toEqual([
      {
        agents: {
          defaults: { models: HOUSE_DEFAULTS },
          entries: {
            "octogee-tester-70-coach": {
              name: "coach",
              model: withFallback("openai/gpt-5"),
              mmAccount: "a",
            },
          },
        },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('"list"');
  });

  it("BYOK-override → house-pin transition (fallbacks [house] → []) confirms the per-entry shrink via agents.list[].model.fallbacks (incident 2026-07-09)", async () => {
    const overriddenDefaultAgent = {
      agents: {
        list: [
          {
            id: "octogee-tester-70-coach",
            name: "coach",
            model: withFallback("openai/gpt-5"),
            mmAccount: "a",
          },
          { id: "octogee-zed-coach", model: "z/y" },
        ],
      },
    };
    const calls: Array<{ agents: { list: Array<{ id: string; model?: unknown }> } }> = [];
    let replacePaths: string[] | undefined;
    const r = await applyDefaultAgentModelPatch(
      { slug: "tester-70", model: HOUSE_REF, source: "house-model" },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(overriddenDefaultAgent) as (typeof calls)[number]);
          replacePaths = args.buildReplacePaths?.(overriddenDefaultAgent);
          return { mode: "rpc", attempts: 1 };
        },
      },
    );
    expect(r).toBe(true);
    const defaultAgent = calls[0].agents.list.find((a) => a.id === "octogee-tester-70-coach");
    expect(defaultAgent?.model).toEqual({ primary: HOUSE_REF, fallbacks: [] });
    // The guard descends into id-keyed entries: the shrunk fallbacks array is
    // reported as agents.list[].model.fallbacks and "agents.list" alone does
    // NOT confirm it — the exact refusal observed live on every reconcile tick.
    expect(replacePaths).toContain("agents.list[].model.fallbacks");
    expect(replacePaths).toContain("agents.list[].tools.alsoAllow");
    expect(replacePaths).toContain("agents.list");
  });

  it("free-tier input ships the tools trim merged into the agent's existing entry tools", async () => {
    const withTools = {
      agents: {
        list: [
          { id: "octogee-tester-70-coach", model: "old", tools: { fs: { workspaceOnly: true } } },
          { id: "octogee-zed-coach", model: "z/y" },
        ],
      },
    };
    const calls: object[] = [];
    const r = await applyDefaultAgentModelPatch(
      { slug: "tester-70", model: HOUSE_REF, source: "house-model" },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(withTools));
          return { mode: "rpc", attempts: 1 };
        },
      },
    );
    expect(r).toBe(true);
    expect(calls).toEqual([
      {
        agents: {
          defaults: { models: HOUSE_DEFAULTS },
          list: [
            {
              id: "octogee-tester-70-coach",
              model: { primary: HOUSE_REF, fallbacks: [] },
              tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS },
            },
            { id: "octogee-zed-coach", model: "z/y" },
          ],
        },
      },
    ]);
  });

  it("a catalog (BYOK) model patch strips a lingering free-tier trim — upgrade removes it on the next re-assert", async () => {
    const trimmed = {
      agents: {
        list: [
          {
            id: "octogee-tester-70-coach",
            model: "old",
            tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS },
          },
        ],
      },
    };
    const calls: object[] = [];
    const r = await applyDefaultAgentModelPatch(
      { slug: "tester-70", provider: "openai" },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(trimmed));
          return { mode: "rpc", attempts: 1 };
        },
      },
    );
    expect(r).toBe(true);
    expect(calls).toEqual([
      {
        agents: {
          defaults: { models: HOUSE_DEFAULTS },
          list: [
            {
              id: "octogee-tester-70-coach",
              model: withFallback("openai/gpt-5"),
              tools: { fs: { workspaceOnly: true } },
            },
          ],
        },
      },
    ]);
  });

  it("shell-runtime BYOS providers (codex / claude-cli) patch the full list + model defaults", async () => {
    const codexCalls: object[] = [];
    const rc = await applyDefaultAgentModelPatch(
      { slug: "tester-70", provider: "openai-codex" },
      {
        applyConfigPatch: async (args) => {
          codexCalls.push(args.buildPatch(CURRENT));
          return { mode: "rpc", attempts: 1 };
        },
      },
    );
    expect(rc).toBe(true);
    expect(codexCalls).toEqual([
      {
        agents: {
          list: [
            { id: "octogee-tester-70-coach", name: "coach", model: withFallback(CODEX_DEFAULT_MODEL), mmAccount: "a" },
            { id: "octogee-zed-coach", model: "z/y" },
          ],
          defaults: {
            models: { ...codexRuntimeConfig().modelsDef, ...HOUSE_DEFAULTS },
          },
        },
      },
    ]);

    const claudeCalls: object[] = [];
    const ra = await applyDefaultAgentModelPatch(
      { slug: "tester-70", provider: "claude-cli" },
      {
        applyConfigPatch: async (args) => {
          claudeCalls.push(args.buildPatch(CURRENT));
          return { mode: "rpc", attempts: 1 };
        },
      },
    );
    expect(ra).toBe(true);
    // claude-cli is an openclaw CORE runtime — no plugin to enable.
    expect(claudeCalls).toEqual([
      {
        agents: {
          list: [
            { id: "octogee-tester-70-coach", name: "coach", model: withFallback(CLAUDE_CLI_DEFAULT_MODEL), mmAccount: "a" },
            { id: "octogee-zed-coach", model: "z/y" },
          ],
          defaults: { models: { ...claudeCliDefaultModels, ...HOUSE_DEFAULTS } },
        },
      },
    ]);
  });

  it("no-override / null → does NOT apply, returns false", async () => {
    let calls = 0;
    expect(
      await applyDefaultAgentModelPatch(null, {
        applyConfigPatch: async () => { calls += 1; return { mode: "rpc", attempts: 1 }; },
      }),
    ).toBe(false);
    expect(
      await applyDefaultAgentModelPatch(
        { slug: "tester-70", provider: "anthropic" },
        { applyConfigPatch: async () => { calls += 1; return { mode: "rpc", attempts: 1 }; } },
      ),
    ).toBe(false);
    expect(calls).toBe(0);
  });

  it("never throws — a failed apply returns false (sync continues → retried next sync)", async () => {
    const r = await applyDefaultAgentModelPatch(
      { slug: "tester-70", provider: "openai" },
      {
        applyConfigPatch: async () => {
          throw new Error("config.patch hash-mismatch exhausted");
        },
        logFn: () => {},
      },
    );
    expect(r).toBe(false);
  });

  it("applies the runtime model patch independently of gateway class", async () => {
    let calls = 0;
    const r = await applyDefaultAgentModelPatch(
      { slug: "tester-70", provider: "openai-codex" },
      {
        applyConfigPatch: async () => { calls += 1; return { mode: "rpc", attempts: 1 }; },
      },
    );
    expect(r).toBe(true);
    expect(calls).toBe(1);
  });

  it("waits for the booting runtime: deadline-bounded retries, not a 3-shot budget (byot fires at pod boot before openclaw listens on :18789)", async () => {
    const opts: ApplyConfigPatchOptions[] = [];
    const r = await applyDefaultAgentModelPatch(
      { slug: "tester-70", provider: "openai" },
      {
        applyConfigPatch: async (_args, o) => {
          opts.push(o ?? {});
          return { mode: "rpc", attempts: 1 };
        },
      },
    );
    expect(r).toBe(true);
    expect(opts).toHaveLength(1);
    expect(opts[0].maxRetries).toBe(Number.POSITIVE_INFINITY);
    expect(opts[0].totalDeadlineMs as number).toBeGreaterThanOrEqual(60_000);
  });
});

describe("applyOauthRuntimeModelAllowlist — provider-set runtime defaults", () => {
  it("allowlists every restored BYOSUB runtime without changing the agent primary model", async () => {
    const calls: object[] = [];
    const r = await applyOauthRuntimeModelAllowlist(["openai", "anthropic"], STANDARD_CODEX_APP_SERVER, {
      applyConfigPatch: async (args) => {
        calls.push(args.buildPatch({}));
        return { mode: "rpc", attempts: 1 };
      },
    });

    expect(r).toEqual({ patched: true, changed: true, restartRequired: true });
    expect(calls).toEqual([
      {
        agents: {
          defaults: {
            models: {
              ...codexRuntimeConfig().modelsDef,
              ...claudeCliDefaultModels,
            },
          },
        },
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: { appServer: { sandbox: "workspace-write", approvalPolicy: "never" } },
            },
          },
        },
      },
    ]);
  });

  it("stamps the gateway class's Codex sandbox over an existing one while adding runtime defaults", async () => {
    const calls: object[] = [];
    const r = await applyOauthRuntimeModelAllowlist(["openai"], ISOLATED_CODEX_APP_SERVER, {
      applyConfigPatch: async (args) => {
        calls.push(args.buildPatch({
          plugins: {
            entries: {
              codex: {
                config: {
                  appServer: {
                    sandbox: "workspace-write",
                    approvalPolicy: "never",
                  },
                },
              },
            },
          },
        }));
        return { mode: "rpc", attempts: 1 };
      },
    });

    expect(r).toEqual({ patched: true, changed: true, restartRequired: false });
    expect(calls).toEqual([
      {
        agents: {
          defaults: {
            models: {
              ...codexRuntimeConfig().modelsDef,
            },
          },
        },
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: {
                  sandbox: "danger-full-access",
                  approvalPolicy: "never",
                },
              },
            },
          },
        },
      },
    ]);
  });

  it("does nothing when no OAuth providers were restored", async () => {
    const applyConfigPatchFn = vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 }));
    await expect(
      applyOauthRuntimeModelAllowlist([], STANDARD_CODEX_APP_SERVER, {
        applyConfigPatch: applyConfigPatchFn,
      }),
    ).resolves.toEqual({ patched: false, changed: false, restartRequired: false });
    expect(applyConfigPatchFn).not.toHaveBeenCalled();
  });

  it("does not require a restart when config.patch reports a no-op", async () => {
    const r = await applyOauthRuntimeModelAllowlist(["anthropic"], STANDARD_CODEX_APP_SERVER, {
      applyConfigPatch: async () => ({ mode: "rpc", attempts: 1, noop: true }),
    });
    expect(r).toEqual({ patched: true, changed: false, restartRequired: false });
  });
});

describe("user OAuth runtime purge", () => {
  it("keeps a secret-ref repair scoped away from safe runtime siblings", () => {
    const patch = userOauthRuntimeConfigPatch(
      {
        channels: {
          mattermost: {
            baseUrl: "${MM_URL}",
            interactions: {
              callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
              allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
            },
            accounts: {
              "tester-70-coach": {
                botToken: {
                  source: "file",
                  provider: "octogee-mattermost",
                  id: "/another-account",
                },
              },
            },
          },
        },
        hooks: {
          transformsDir: null,
          internal: { handlers: null, load: { extraDirs: null } },
        },
        memory: { qmd: { command: null } },
        security: { installPolicy: { exec: null } },
      },
      "tester-70",
      "platform-openrouter/deepseek/deepseek-v4-pro",
    ) as any;

    expect(patch.channels).toEqual({
      mattermost: {
        accounts: {
          "tester-70-coach": {
            botToken: {
              source: "file",
              provider: "octogee-mattermost",
              id: "/tester-70-coach",
            },
          },
        },
      },
    });
    expect(patch).not.toHaveProperty("hooks");
    expect(patch).not.toHaveProperty("memory");
    expect(patch).not.toHaveProperty("security");
  });

  it("disables DMs on already-mounted platform-agent accounts and leaves other accounts alone", () => {
    const botToken = (accountId: string) => ({
      source: "file",
      provider: "octogee-mattermost",
      id: `/${accountId}`,
    });
    const patch = userOauthRuntimeConfigPatch(
      {
        agents: {
          list: [{ id: "octogee-tester-70-coach" }, { id: "octogee-tester-70-proj-golf-coach" }],
        },
        channels: {
          mattermost: {
            accounts: {
              "tester-70-coach": {
                botToken: botToken("tester-70-coach"),
                dmPolicy: "allowlist",
                allowFrom: ["aaaaaaaaaaaaaaaaaaaaaaaaaa"],
              },
              "tester-70-proj-golf": { botToken: botToken("tester-70-proj-golf"), dmPolicy: "disabled" },
              "someone-else-coach": { botToken: botToken("someone-else-coach"), dmPolicy: "allowlist" },
            },
          },
        },
      },
      "tester-70",
      "platform-openrouter/deepseek/deepseek-v4-pro",
    ) as any;

    expect(patch.channels).toEqual({
      mattermost: {
        accounts: {
          "tester-70-coach": { dmPolicy: "disabled" },
        },
      },
    });
  });

  it("keeps gateway token references when synchronization runs in the sidecar", () => {
    vi.stubEnv("MM_SITE_URL", "https://mattermost-test.octogee.com");
    vi.stubEnv("FLEET_BROKER_URL", "http://127.0.0.1:3003");
    vi.stubEnv("OCTOGEE_API_SA_TOKEN_PATH", "/var/run/secrets/octogee-api/token");
    vi.stubEnv("CUSTOMERS_DIR", "/home/node/customers");
    vi.stubEnv("GATEWAY_CLASS", "shared");
    vi.stubEnv("GATEWAY_ID", "shared-b");

    try {
      const patch = userOauthRuntimeConfigPatch(
        {},
        "tester-70",
        "platform-openrouter/deepseek/deepseek-v4-pro",
      ) as any;

      expect(patch.plugins.entries["octogee-chat-tools"].config).toEqual({
        siteUrl: "https://mattermost-test.octogee.com",
        brokerUrl: "http://127.0.0.1:3003",
        tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
        customersRoot: "/home/node/customers",
      });
      for (const entry of Object.values(patch.plugins.entries) as Array<{ config?: { tokenPath?: string } }>) {
        if (entry.config?.tokenPath) {
          expect(entry.config.tokenPath).toBe("${OCTOGEE_API_SA_TOKEN_PATH}");
        }
      }
      const repaired = userOauthRuntimeConfigPatch(
        { plugins: { entries: { "octogee-chat-tools": { config: {
          tokenPath: "/var/run/secrets/octogee-api/token",
        } } } } },
        "tester-70",
        "platform-openrouter/deepseek/deepseek-v4-pro",
      ) as any;
      expect(repaired.plugins.entries["octogee-chat-tools"].config.tokenPath).toBe(
        "${OCTOGEE_API_SA_TOKEN_PATH}",
      );
      expect(patch.plugins.entries["octogee-status-tools"].config.gatewayClass).toBe("shared");
      expect(patch.plugins.entries["octogee-web-tools"].config.gatewayId).toBe("shared-b");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("builds a fail-closed patch for direct runtime definitions, defaults, and every owned agent shape", () => {
    const safeModel = "platform-openrouter/deepseek/deepseek-v4-pro";
    const patch = userOauthRuntimeConfigPatch(
      {
        auth: {
          profiles: {
            "openai-codex:default": { provider: "openai-codex" },
            "anthropic:claude-cli": { provider: "claude-cli" },
            "platform:default": { provider: "anthropic" },
          },
        },
        models: {
          providers: {
            "openai-codex": {},
            "claude-cli": {},
            anthropic: {},
          },
        },
        agents: {
          defaults: {
            model: "anthropic/runtime-claude",
            agentRuntime: { id: "claude-cli" },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              "anthropic/runtime-claude": { agentRuntime: { id: "claude-cli" } },
              "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            },
          },
          list: [
            {
              id: "octogee-tester-70-coach",
              model: "openai/gpt-5.5",
              agentRuntime: { id: "codex" },
            },
            { id: "octogee-someone-else-coach", model: "claude-cli/claude-opus-4-8" },
          ],
          entries: {
            "octogee-tester-70-proj-web-coach": {
              model: "claude-cli/claude-opus-4-8",
              models: {
                "anthropic/local-runtime": { agentRuntime: { id: "claude-cli" } },
                "anthropic/claude-haiku-4-5": { alias: "haiku" },
              },
            },
          },
        },
      },
      "tester-70",
      safeModel,
    ) as any;

    expect(patch.agents.defaults).toEqual({
      model: { primary: safeModel, fallbacks: [] },
      agentRuntime: null,
      models: {
        "openai/gpt-5.5": null,
        "anthropic/runtime-claude": null,
        "anthropic/claude-sonnet-4-6": {
          alias: "sonnet",
          params: { cacheRetention: "short" },
        },
        [safeModel]: { alias: "deepseek" },
      },
    });
    expect(patch.agents.list).toEqual([
      {
        id: "octogee-tester-70-coach",
        model: { primary: safeModel, fallbacks: [] },
        agentRuntime: null,
      },
    ]);
    expect(patch.agents.entries).toEqual({
      "octogee-tester-70-proj-web-coach": {
        model: { primary: safeModel, fallbacks: [] },
        models: {
          "anthropic/local-runtime": null,
          "anthropic/claude-haiku-4-5": {
            alias: "haiku",
            params: { cacheRetention: "short" },
          },
        },
      },
    });
    expect(patch.auth.profiles).toEqual({
      "openai-codex:default": null,
      "anthropic:claude-cli": null,
    });
    expect(patch.models.providers).toEqual({
      "openai-codex": null,
      "claude-cli": null,
      anthropic: null,
    });
    expect(patch.plugins.allow).toEqual([
      "mattermost",
      "anthropic",
      "memory-core",
      "octogee-chat-tools",
      "octogee-activity-tools",
      "octogee-connector-tools",
      "octogee-access-tools",
      "octogee-project-tools",
      "octogee-board-tools",
      "octogee-status-tools",
      "octogee-broker-tools",
      "octogee-ops-tools",
      "octogee-web-tools",
      "octogee-workspace-tools",
      "parallel",
      "openai",
    ]);
    expect(patch.plugins.entries.codex).toBeUndefined();
    expect(patch.plugins.entries).not.toHaveProperty("octogee-preview-tools");
    expect(patch.plugins.entries).not.toHaveProperty("octogee-publish-tools");
    expect(patch.plugins.entries["octogee-board-tools"].config).toEqual({
      brokerUrl: "${FLEET_BROKER_URL}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
    });
    expect(patch.plugins.entries["octogee-connector-tools"].config).toEqual({
      brokerUrl: "${FLEET_BROKER_URL}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
    });
  });

  it("clears the subscription credential from OpenClaw's shared store and keeps everything else there", async () => {
    const oc = fs.mkdtempSync(path.join(os.tmpdir(), "user-oauth-shared-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "user-oauth-home-"));
    fs.mkdirSync(path.join(oc, "state"), { recursive: true });
    const stateDb = new DatabaseSync(path.join(oc, "state", "openclaw.sqlite"));
    stateDb.exec(
      "CREATE TABLE config_machine_state (state_key TEXT NOT NULL PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL) STRICT",
    );
    stateDb.prepare("INSERT INTO config_machine_state VALUES ('auth.sharedStore', ?, 1)").run(
      JSON.stringify({ location: "state-db" }),
    );
    stateDb.close();
    seedAgent(oc, "octogee-tester-70-coach");
    writeAuthProfileStore(sharedAuthAgentDir(oc), {
      version: 1,
      profiles: {
        "openai:octogee-chatgpt": { type: "oauth", provider: "openai", access: "a" },
        "anthropic:claude-cli": { type: "oauth", provider: "claude-cli", access: "c" },
        "operator:default": { type: "api_key", provider: "operator" },
      },
    });
    const rpc = {
      sessionsList: vi.fn(async () => ({ sessions: [] })),
      sessionsReset: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => {}),
    };
    try {
      const result = await purgeUserOauthRuntime("tester-70", "platform-openrouter/z-ai/glm-5.2", {
        config: { agents: { list: [] } },
        openclawDir: oc,
        homeDir: home,
        rpc,
        applyConfigPatch: async () => ({ mode: "rpc", attempts: 1, noop: true }),
      });
      expect(result.changed).toBe(true);
      expect(readAuthProfileStore(sharedAuthAgentDir(oc))).toEqual({
        version: 1,
        profiles: { "operator:default": { type: "api_key", provider: "operator" } },
      });
    } finally {
      fs.rmSync(oc, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves plugin token paths that already resolve to their placeholder out of the purge patch", async () => {
    vi.stubEnv("OCTOGEE_API_SA_TOKEN_PATH", "/var/run/secrets/octogee-gateway-broker/token");
    const oc = fs.mkdtempSync(path.join(os.tmpdir(), "customer-oauth-purge-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "user-oauth-home-"));
    seedAgent(oc, "octogee-tester-70-coach");
    const config = {
      agents: { list: [] },
      plugins: { entries: {
        "octogee-chat-tools": { config: { tokenPath: "/var/run/secrets/octogee-gateway-broker/token" } },
        "octogee-board-tools": { config: { tokenPath: "/tmp/other-token" } },
      } },
    };
    const patches: any[] = [];
    try {
      await purgeUserOauthRuntime("tester-70", "platform-openrouter/z-ai/glm-5.2", {
        config,
        openclawDir: oc,
        homeDir: home,
        rpc: {
          sessionsList: vi.fn(async () => ({ sessions: [] })),
          sessionsReset: vi.fn(async () => ({ ok: true as const })),
          close: vi.fn(async () => {}),
        },
        applyConfigPatch: async (args) => {
          patches.push(args.buildPatch(config));
          return { mode: "rpc", attempts: 1, noop: true };
        },
      });
      expect(patches[0].plugins.entries["octogee-chat-tools"].config).not.toHaveProperty("tokenPath");
      expect(patches[0].plugins.entries["octogee-board-tools"].config.tokenPath).toBe("${OCTOGEE_API_SA_TOKEN_PATH}");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(oc, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("purges owned disk artifacts, patches config, and resets agent plus project sessions", async () => {
    const oc = fs.mkdtempSync(path.join(os.tmpdir(), "customer-oauth-purge-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "user-oauth-home-"));
    const userDefaultAgentId = "octogee-tester-70-coach";
    const projectId = "octogee-tester-70-proj-web-coach";
    const native = path.join(home, ".claude", ".credentials.json");
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.writeFileSync(native, "secret");
    for (const agentId of [userDefaultAgentId, projectId]) {
      seedAgent(oc, agentId);
      const auth = codexAuthJsonPath(oc, agentId);
      fs.mkdirSync(path.dirname(auth), { recursive: true });
      fs.writeFileSync(auth, "secret");
    }
    const config = {
      agents: { list: [{ id: userDefaultAgentId }, { id: projectId }, { id: "octogee-other-coach" }] },
    };
    const rpc = {
      sessionsList: vi.fn(async ({ agentId }: { agentId: string }) => ({
        sessions: [
          { key: `agent:${agentId}:mattermost:group:one`, agentId },
          { key: "agent:octogee-other-coach:mattermost:group:two", agentId: "octogee-other-coach" },
        ],
      })),
      sessionsReset: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => {}),
    };
    const patches: object[] = [];
    const replacePaths: string[][] = [];
    try {
      await expect(
        purgeUserOauthRuntime("tester-70", "platform-openrouter/z-ai/glm-5.2", {
          config,
          openclawDir: oc,
          homeDir: home,
          rpc,
          forceSafeAll: true,
          applyConfigPatch: async (args) => {
            patches.push(args.buildPatch(config));
            replacePaths.push(args.buildReplacePaths?.(config) ?? []);
            return { mode: "rpc", attempts: 1 };
          },
        }),
      ).resolves.toEqual({ changed: true, resetCount: 2 });
      expect(fs.existsSync(native)).toBe(false);
      expect(fs.existsSync(codexAuthJsonPath(oc, userDefaultAgentId))).toBe(false);
      expect(fs.existsSync(codexAuthJsonPath(oc, projectId))).toBe(false);
      expect(patches).toHaveLength(1);
      expect((patches[0] as any).agents.list).toEqual([
        { id: userDefaultAgentId, model: { primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] } },
        { id: projectId, model: { primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] } },
      ]);
      expect(replacePaths[0]).toEqual(expect.arrayContaining([
        "plugins.allow",
        "secrets.providers.gcp-secret-manager.passEnv",
        "agents.defaults.model.fallbacks",
        "agents.list[].model.fallbacks",
      ]));
      expect(rpc.sessionsReset).toHaveBeenCalledTimes(2);
      expect(rpc.close).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(oc, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("durably removes stale user plugin, provider, secret, model, and spawn/load state", () => {
    const safeModel = "platform-openrouter/deepseek/deepseek-v4-pro";
    const patch = userOauthRuntimeConfigPatch(
      {
        plugins: {
          enabled: false,
          allow: ["parallel", "acpx", "octogee-chat-tools"],
          load: { paths: ["/tmp/evil"] },
          installs: { acpx: { path: "/tmp/acpx" } },
          entries: {
            acpx: { enabled: true, config: { command: ["sh"] } },
            parallel: { enabled: true },
            "octogee-chat-tools": {
              enabled: true,
              config: { siteUrl: "https://attacker.invalid", tokenPath: "/ksa" },
            },
            "octogee-connector-tools": {
              enabled: true,
              config: { brokerUrl: "https://attacker.invalid", tokenPath: "/ksa" },
            },
          },
        },
        secrets: {
          providers: {
            evil: { source: "exec", command: ["sh"] },
            "gcp-secret-manager": { source: "exec", command: "/tmp/evil", passEnv: ["PATH"] },
            "octogee-mattermost": { source: "file", path: "/tmp/evil", mode: "text" },
          },
          staleRef: { source: "exec", provider: "evil", id: "ksa" },
        },
        cron: {
          webhookToken: {
            source: "file",
            provider: "octogee-mattermost",
            id: "/another-account",
          },
          webhookAuth: { enabled: true },
          failureAlert: {
            token: { source: "exec", provider: "gcp-secret-manager", id: "another-mm-pat" },
          },
        },
        channels: {
          mattermost: {
            accounts: {
              "tester-70-coach": {
                botToken: {
                  source: "file",
                  provider: "octogee-mattermost",
                  id: "/someone-else-coach",
                },
              },
              "tester-70-proj-web": {
                botToken: {
                  source: "file",
                  provider: "octogee-mattermost",
                  id: "/tester-70-coach",
                },
              },
            },
          },
        },
        hooks: {
          transformsDir: "/tmp/transforms",
          mappings: [{ transform: "/tmp/transform.mjs", keep: true }],
          internal: { handlers: ["/tmp/hook.mjs"], load: { extraDirs: ["/tmp"], keep: true } },
        },
        memory: { qmd: { command: ["sh"], keep: true } },
        security: { installPolicy: { exec: ["sh"], keep: true } },
        models: {
          providers: {
            evil: {
              baseUrl: "https://attacker.invalid",
              headers: { Authorization: "ksa" },
              localService: { command: ["sh"] },
              agentRuntime: { id: "acpx" },
            },
          },
        },
        tools: {
          media: { models: [{ type: "cli", command: "curl" }, { type: "provider", id: "safe" }] },
          links: { models: [{ id: "evil", command: ["sh"] }, { id: "safe" }] },
        },
        agents: {
          defaults: {
            model: { primary: "evil/model", fallbacks: ["anthropic/claude-sonnet-4-6"] },
            models: {
              "evil/model": { baseUrl: "https://attacker.invalid" },
              "anthropic/claude-sonnet-4-6": { headers: { x: "y" } },
            },
          },
          list: [{ id: "octogee-tester-70-coach", model: "evil/model" }],
          entries: {
            "octogee-tester-70-proj-web-coach": {
              model: "evil/model",
              models: { "evil/model": { agentRuntime: { id: "acpx" } } },
            },
          },
        },
      },
      "tester-70",
      safeModel,
    ) as any;

    expect(patch.plugins.enabled).toBe(true);
    expect(patch.plugins.allow).toContain("parallel");
    expect(patch.plugins.entries.acpx).toBeNull();
    expect(patch.plugins.entries.parallel).toEqual({ enabled: true });
    expect(patch.plugins.load).toBeNull();
    expect(patch.plugins.installs).toBeNull();
    expect(patch.plugins.entries["octogee-chat-tools"].config).toEqual({
      siteUrl: "${MM_SITE_URL}",
      brokerUrl: "${FLEET_BROKER_URL}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
      customersRoot: "${CUSTOMERS_DIR}",
    });
    expect(patch.plugins.entries["octogee-chat-tools"].hooks.timeouts).toEqual({
      before_dispatch: 3000,
      before_prompt_build: 3000,
      before_agent_run: 3000,
    });
    expect(patch.plugins.entries["octogee-connector-tools"].config).toEqual({
      brokerUrl: "${FLEET_BROKER_URL}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
    });
    expect(patch.secrets.providers.evil).toBeNull();
    expect(patch.secrets.providers["gcp-secret-manager"]).toEqual({
      command: "/octogee/scripts/secret-resolver.mjs",
      passEnv: [
        "FLEET_BROKER_URL",
        "OCTOGEE_API_URL",
        "OCTOGEE_API_SA_TOKEN_PATH",
        "INTERNAL_SERVICE_KEY",
        "OPENCLAW_AGENTS_DIR",
        "HOME",
      ],
      jsonOnly: true,
      timeoutMs: 45000,
      source: "exec",
    });
    expect(patch.secrets.staleRef).toBeNull();
    expect(patch.cron).toEqual({
      webhookToken: null,
      webhookAuth: null,
      failureAlert: null,
      failureAlerts: null,
    });
    expect(patch.channels.mattermost.accounts["tester-70-coach"].botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/tester-70-coach",
    });
    expect(patch.channels.mattermost.accounts["tester-70-proj-web"].botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/tester-70-proj-web",
    });
    expect(patch.hooks.transformsDir).toBeNull();
    expect(patch.hooks.mappings).toEqual([{ keep: true }]);
    expect(patch.hooks.internal.handlers).toBeNull();
    expect(patch.hooks.internal.load.extraDirs).toBeNull();
    expect(patch.memory.qmd.command).toBeNull();
    expect(patch.security.installPolicy.exec).toBeNull();
    expect(patch.tools.media.models).toEqual([{ type: "provider", id: "safe" }]);
    expect(patch.tools.links.models).toEqual([{ id: "safe" }]);
    expect(patch.models.providers.evil).toBeNull();
    expect(patch.agents.defaults.model).toEqual({ primary: safeModel, fallbacks: [] });
    expect(patch.agents.defaults.models).toEqual({
      "evil/model": null,
      "anthropic/claude-sonnet-4-6": {
        headers: null,
        alias: "sonnet",
        params: { cacheRetention: "short" },
      },
      [safeModel]: { alias: "deepseek" },
    });
    expect(patch.agents.list[0].model).toEqual({ primary: safeModel, fallbacks: [] });
    expect(patch.agents.entries["octogee-tester-70-proj-web-coach"].model).toEqual({
      primary: safeModel,
      fallbacks: [],
    });
  });

  it("leaves a catalog-valid agent selection alone when a suppressed byosub forces safe, and pins only a non-catalog one", () => {
    const platformDefault = {
      primary: "platform-openrouter/openai/gpt-5.6-luna",
      fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
    };
    const patch = userOauthRuntimeConfigPatch(
      {
        agents: {
          entries: {
            "octogee-tester-70-coach": { model: platformDefault },
            "octogee-tester-70-proj-web-coach": { model: { primary: "openai-codex/gpt-5", fallbacks: [] } },
            "octogee-tester-70-proj-blank-coach": { name: "no selection yet" },
          },
        },
      },
      "tester-70",
      platformDefault.primary,
      { forceSafeAll: true },
    ) as any;

    expect(patch.agents.entries["octogee-tester-70-coach"]).toBeUndefined();
    expect(patch.agents.entries["octogee-tester-70-proj-web-coach"]).toEqual({
      model: { primary: platformDefault.primary, fallbacks: [] },
    });
    expect(patch.agents.entries["octogee-tester-70-proj-blank-coach"]).toEqual({
      model: { primary: platformDefault.primary, fallbacks: [] },
    });
  });

  it("retains the exact env-owned Anthropic broker provider without forcing safe agent resets", () => {
    const brokerUrl = "http://llm-broker.octogee-test.svc.cluster.local:3010";
    vi.stubEnv("ANTHROPIC_BASE_URL", brokerUrl);
    try {
      const patch = userOauthRuntimeConfigPatch(
        {
          models: { providers: { anthropic: { baseUrl: brokerUrl } } },
          agents: {
            defaults: {
              models: {
                "anthropic/claude-sonnet-4-6": {
                  alias: "sonnet",
                  params: { cacheRetention: "short" },
                },
                "platform-openrouter/deepseek/deepseek-v4-pro": { alias: "deepseek" },
              },
            },
            list: [{ id: "octogee-tester-70-coach", model: "anthropic/claude-sonnet-4-6" }],
          },
        },
        "tester-70",
        "platform-openrouter/deepseek/deepseek-v4-pro",
      ) as any;

      expect(patch.models.providers).toEqual({ anthropic: { baseUrl: brokerUrl } });
      expect(patch.agents.list).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("coach runtime session policy refresh", () => {
  it("resets only this agent's sessions once for each policy transition, including upgrade and downgrade", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-coach-runtime-policy-"));
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const userDefaultAgentId = "octogee-tester-70-coach";
    const rpc = {
      sessionsList: vi.fn(async () => ({
        sessions: [
          { key: `agent:${userDefaultAgentId}:mattermost:group:one`, agentId: userDefaultAgentId },
          { key: "agent:octogee-someone-else-coach:mattermost:group:two", agentId: "octogee-someone-else-coach" },
        ],
      })),
      sessionsReset: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => {}),
    };
    const free = {
      tools: { profile: "minimal", alsoAllow: ["octogee_ask_ops"] },
      agents: { list: [{ id: userDefaultAgentId, model: "platform-openrouter/deepseek/deepseek-v4-pro" }] },
    };
    const trial = {
      tools: { profile: "coding", alsoAllow: ["octogee_ask_ops"] },
      agents: { list: [{ id: userDefaultAgentId, model: "platform-openrouter/z-ai/glm-5.2" }] },
    };

    try {
      await expect(refreshDefaultAgentRuntimeSessions("tester-70", { agentDir, config: free, rpc })).resolves.toEqual({
        refreshed: true,
        resetCount: 1,
      });
      await expect(refreshDefaultAgentRuntimeSessions("tester-70", { agentDir, config: free, rpc })).resolves.toEqual({
        refreshed: false,
        resetCount: 0,
      });
      await expect(refreshDefaultAgentRuntimeSessions("tester-70", { agentDir, config: trial, rpc })).resolves.toEqual({
        refreshed: true,
        resetCount: 1,
      });
      await expect(refreshDefaultAgentRuntimeSessions("tester-70", { agentDir, config: free, rpc })).resolves.toEqual({
        refreshed: true,
        resetCount: 1,
      });

      expect(rpc.sessionsReset).toHaveBeenCalledTimes(3);
      expect(rpc.sessionsReset).toHaveBeenCalledWith({
        key: `agent:${userDefaultAgentId}:mattermost:group:one`, agentId: userDefaultAgentId, reason: "reset",
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves its marker unchanged when an active agent session cannot safely reset", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-coach-runtime-policy-"));
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const userDefaultAgentId = "octogee-tester-70-coach";
    const rpc = {
      sessionsList: vi.fn(async () => ({
        sessions: [{ key: `agent:${userDefaultAgentId}:mattermost:group:one`, agentId: userDefaultAgentId, hasActiveRun: true }],
      })),
      sessionsReset: vi.fn(async () => ({ ok: true as const })),
      close: vi.fn(async () => {}),
    };
    const config = { agents: { list: [{ id: userDefaultAgentId }] } };

    try {
      await expect(refreshDefaultAgentRuntimeSessions("tester-70", { agentDir, config, rpc })).rejects.toThrow(
        "active runtime session",
      );
      expect(rpc.sessionsReset).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(agentDir, ".octogee-session-policy.json"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("standard gateway — BYOS materialization", () => {
  it("threads an injected config writer through the default agent model patch", async () => {
    const configWriter = vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 }));

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        planInputs: { selectedTier: "free" },
      },
      {
        usesLlmBrokerToken: () => true,
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        applyByotState: async () => false,
        applyConfigPatch: configWriter,
        triggerSecretsReload: vi.fn(async () => {}),
      },
    );

    expect(configWriter).toHaveBeenCalledTimes(1);
  });

  it("trial non-BYOK user leaves the template model untouched — but tools convergence still runs (catalog strip)", async () => {
    const applyByotStateFn = vi.fn(async () => false);
    const applyDefaultAgentModelPatchFn = vi.fn(async () => true);
    const applyDefaultAgentToolsConvergenceFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});
    const refreshDefaultAgentRuntimeSessionsFn = vi.fn(async () => ({ refreshed: true, resetCount: 1 }));

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        planInputs: { selectedTier: "personal_free", trialGrant: LIVE_SIGNUP_OFFER },
      },
      {
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        applyByotState: applyByotStateFn,
        applyDefaultAgentModelPatch: applyDefaultAgentModelPatchFn,
        applyDefaultAgentToolsConvergence: applyDefaultAgentToolsConvergenceFn,
        triggerSecretsReload: triggerSecretsReloadFn,
        refreshDefaultAgentRuntimeSessions: refreshDefaultAgentRuntimeSessionsFn,
      },
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null);
    expect(applyDefaultAgentModelPatchFn).not.toHaveBeenCalled();
    expect(applyDefaultAgentToolsConvergenceFn).toHaveBeenCalledWith("tester-70", false);
    expect(triggerSecretsReloadFn).not.toHaveBeenCalled();
    expect(refreshDefaultAgentRuntimeSessionsFn).toHaveBeenCalledWith("tester-70");
  });

  it("broker-token gateway: anthropic BYOT is broker-resolved, not materialized locally", async () => {
    const applyByotStateFn = vi.fn(async () => false);
    const restoreOauthFn = vi.fn<typeof restoreOauthStoreForSlug>(async () => ({ restored: true, present: true }));
    const applyDefaultAgentModelPatchFn = vi.fn(async () => true);
    const applyDefaultAgentToolsConvergenceFn = vi.fn(async () => false);
    const materializeFn = vi.fn(() => false);
    const purgeUserOauthRuntimeFn = vi.fn(async () => ({ changed: true, resetCount: 1 }));
    const requestGatewayRestartFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        planInputs: {},
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "anthropic" } },
      },
      {
        usesLlmBrokerToken: () => true,
        purgeUserOauthRuntime: purgeUserOauthRuntimeFn,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyDefaultAgentModelPatch: applyDefaultAgentModelPatchFn,
        applyDefaultAgentToolsConvergence: applyDefaultAgentToolsConvergenceFn,
        materializePlatformBrokerSurfaces: materializeFn,
        requestGatewayRestart: requestGatewayRestartFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null);
    expect(materializeFn).toHaveBeenCalledWith("tester-70");
    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(applyDefaultAgentModelPatchFn).not.toHaveBeenCalled();
    expect(requestGatewayRestartFn).not.toHaveBeenCalled();
    // anthropic BYOK ships no model patch → the standalone convergence covers
    // the BYOK carve-out (inherited surface) on this path too.
    expect(applyDefaultAgentToolsConvergenceFn).toHaveBeenCalledWith("tester-70", false);
    expect(triggerSecretsReloadFn).toHaveBeenCalledTimes(1);
  });

  it("suppresses claude-cli BYOS without restarting every user on the gateway", async () => {
    const applyByotStateFn = vi.fn(async () => true);
    const restoreOauthFn = vi.fn<typeof restoreOauthStoreForSlug>(async () => ({ restored: true, present: true }));
    const applyDefaultAgentModelPatchFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});
    const purgeUserOauthRuntimeFn = vi.fn(async () => ({ changed: true, resetCount: 2 }));
    const requestGatewayRestartFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        planInputs: { selectedTier: "personal" },
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "claude-cli" } },
      },
      {
        purgeUserOauthRuntime: purgeUserOauthRuntimeFn,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyDefaultAgentModelPatch: applyDefaultAgentModelPatchFn,
        requestGatewayRestart: requestGatewayRestartFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null, undefined, {
      preserveAuthProfileStore: false,
    });
    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(applyDefaultAgentModelPatchFn).not.toHaveBeenCalled();
    expect(purgeUserOauthRuntimeFn).toHaveBeenCalledWith(
      "tester-70",
      "platform-openai/gpt-6-luna",
      { forceSafeAll: true },
    );
    expect(requestGatewayRestartFn).not.toHaveBeenCalled();
    expect(triggerSecretsReloadFn).toHaveBeenCalledTimes(1);
  });

  it("purges disconnected stale OAuth runtime state on every user convergence", async () => {
    const purgeUserOauthRuntimeFn = vi.fn(async () => ({ changed: true, resetCount: 1 }));
    const requestGatewayRestartFn = vi.fn(async () => true);
    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        planInputs: { selectedTier: "personal" },
        provisioning: { openclaw: { status: "complete" } },
      },
      {
        purgeUserOauthRuntime: purgeUserOauthRuntimeFn,
        applyByotState: vi.fn(async () => false),
        applyDefaultAgentModelPatch: vi.fn(async () => false),
        applyDefaultAgentToolsConvergence: vi.fn(async () => false),
        requestGatewayRestart: requestGatewayRestartFn,
        triggerSecretsReload: vi.fn(async () => {}),
      },
    );

    expect(purgeUserOauthRuntimeFn).toHaveBeenCalledWith(
      "tester-70",
      "platform-openai/gpt-6-luna",
      { forceSafeAll: false },
    );
    expect(requestGatewayRestartFn).not.toHaveBeenCalled();
  });

});

describe("Isolated gateway — native subscription runtime", () => {
  it("restores OAuth and preserves direct runtime model selections", async () => {
    const applyByotStateFn = vi.fn(async () => false);
    const restoreOauthFn = vi.fn<typeof restoreOauthStoreForSlug>(async () => ({
      restored: true,
      present: true,
      providers: ["openai"],
    }));
    const applyOauthRuntimeModelAllowlistFn = vi.fn(async () => ({
      patched: true,
      changed: true,
      restartRequired: false,
    }));
    const applyDefaultAgentModelPatchFn = vi.fn(async () => true);
    const applyAgentModelOverridesFn = vi.fn(async () => true);
    const purgeUserOauthRuntimeFn = vi.fn(async () => ({ changed: true, resetCount: 1 }));
    const requestGatewayRestartFn = vi.fn(async () => false);
    const triggerSecretsReloadFn = vi.fn(async () => {});
    const agentModels = {
      "octogee-tester-70-coach": {
        primary: "openai-codex/gpt-5.3-codex",
        fallbacks: ["claude-cli/claude-opus-4-8"],
      },
    };

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        planInputs: { selectedTier: "personal" },
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: {
          byot: { provider: "openai-codex" },
          agentModels,
        },
      },
      {
        isIsolatedGateway: () => true,
        isSharedGateway: () => false,
        purgeUserOauthRuntime: purgeUserOauthRuntimeFn,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyOauthRuntimeModelAllowlist: applyOauthRuntimeModelAllowlistFn,
        applyDefaultAgentModelPatch: applyDefaultAgentModelPatchFn,
        applyAgentModelOverrides: applyAgentModelOverridesFn,
        materializePlatformBrokerSurfaces: vi.fn(() => false),
        hasPendingPlatformCatalogRestart: () => false,
        requestGatewayRestart: requestGatewayRestartFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(purgeUserOauthRuntimeFn).not.toHaveBeenCalled();
    expect(applyByotStateFn).not.toHaveBeenCalled();
    expect(restoreOauthFn).toHaveBeenCalledWith("tester-70");
    expect(applyOauthRuntimeModelAllowlistFn).toHaveBeenCalledWith(["openai"], ISOLATED_CODEX_APP_SERVER);
    expect(applyDefaultAgentModelPatchFn).toHaveBeenCalledTimes(1);
    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith("tester-70", agentModels, {
      houseOnly: false,
    });
    expect(requestGatewayRestartFn).not.toHaveBeenCalled();
    expect(triggerSecretsReloadFn).toHaveBeenCalledTimes(1);
  });
});

describe("shared gateway — per-user broker-token materialization", () => {
  const PRESERVE = { preserveAuthProfileStore: true };
  const baseDeps = (overrides: Record<string, unknown>) => {
    let restartPending = false;
    return {
      isSharedGateway: () => true,
      purgeUserOauthRuntime: noUserOauthRuntimePurge,
      applyDefaultAgentModelPatch: vi.fn(async () => false),
      applyDefaultAgentToolsConvergence: vi.fn(async () => false),
      requestGatewayRestart: vi.fn(async () => false),
      triggerSecretsReload: vi.fn(async () => {}),
      hasPendingPlatformCatalogRestart: () => restartPending,
      markPlatformCatalogRestartPending: () => {
        restartPending = true;
      },
      clearPlatformCatalogRestartPending: () => {
        restartPending = false;
      },
      ...overrides,
    };
  };

  it("platform user hot-reloads a materialized model catalog on a shared gateway, never a gateway restart", async () => {
    const applyByotStateFn = vi.fn(async () => false);
    const materializeFn = vi.fn(() => true);
    const restoreOauthFn = vi.fn<typeof restoreOauthStoreForSlug>(async () => ({ restored: false, present: true }));
    const reloadFn = vi.fn(async () => {});
    const requestGatewayRestartFn = vi.fn(async () => true);
    const markPendingFn = vi.fn();

    await syncByotForUser(
      { byotActive: false, username: "tester-70", planInputs: {}, provisioning: { openclaw: { status: "complete" } } },
      baseDeps({
        applyByotState: applyByotStateFn,
        materializePlatformBrokerSurfaces: materializeFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        triggerSecretsReload: reloadFn,
        requestGatewayRestart: requestGatewayRestartFn,
        markPlatformCatalogRestartPending: markPendingFn,
      }),
    );

    expect(materializeFn).toHaveBeenCalledWith("tester-70");
    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null, undefined, PRESERVE);
    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(requestGatewayRestartFn).not.toHaveBeenCalled();
    expect(markPendingFn).not.toHaveBeenCalled();
    expect(reloadFn).toHaveBeenCalledTimes(1);
  });

  it("ignores a pending platform-catalog restart marker on a shared gateway", async () => {
    const reloadFn = vi.fn(async () => {});
    const requestGatewayRestartFn = vi.fn(async () => true);

    await syncByotForUser(
      { byotActive: false, username: "tester-70", planInputs: {}, provisioning: { openclaw: { status: "complete" } } },
      baseDeps({
        applyByotState: vi.fn(async () => false),
        materializePlatformBrokerSurfaces: vi.fn(() => false),
        restoreOauthStoreForSlug: vi.fn(async () => ({ restored: false, present: true })),
        triggerSecretsReload: reloadFn,
        requestGatewayRestart: requestGatewayRestartFn,
        hasPendingPlatformCatalogRestart: () => true,
      }),
    );

    expect(requestGatewayRestartFn).not.toHaveBeenCalled();
    expect(reloadFn).not.toHaveBeenCalled();
  });

  it("anthropic BYOK: no local key (broker resolves per-owner), but the broker profile is still materialized", async () => {
    const applyByotStateFn = vi.fn(async () => false);
    const materializeFn = vi.fn(() => true);

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        planInputs: {},
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "anthropic" } },
      },
      baseDeps({ applyByotState: applyByotStateFn, materializePlatformBrokerSurfaces: materializeFn }),
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null, undefined, PRESERVE);
    expect(materializeFn).toHaveBeenCalledWith("tester-70");
  });

  it("claude-cli BYOS on shared: suppressed — no OAuth restore, purged broker profiles preserved", async () => {
    const applyByotStateFn = vi.fn(async () => false);
    const materializeFn = vi.fn(() => true);
    const restoreOauthFn = vi.fn<typeof restoreOauthStoreForSlug>(async () => ({ restored: true, present: true }));
    const applyDefaultAgentModelPatchFn = vi.fn(async () => false);
    const reloadFn = vi.fn(async () => {});
    const logLines: string[] = [];

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        planInputs: { selectedTier: "personal" },
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "claude-cli" } },
      },
      baseDeps({
        applyByotState: applyByotStateFn,
        materializePlatformBrokerSurfaces: materializeFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyDefaultAgentModelPatch: applyDefaultAgentModelPatchFn,
        triggerSecretsReload: reloadFn,
        logFn: (m: string) => logLines.push(m),
      }),
    );

    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(materializeFn).toHaveBeenCalledWith("tester-70");
    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null, undefined, PRESERVE);
    // no cohort model configured → agent stays on the pod default; never the byos model
    expect(applyDefaultAgentModelPatchFn).not.toHaveBeenCalled();
    expect(reloadFn).toHaveBeenCalledTimes(1);
    expect(logLines.join("\n")).toContain("byosub (claude-cli) suppressed on a shared gateway");
  });

  it("codex BYOS on shared (paid plan): suppressed to the platform rail, config default model stands", async () => {
    const applyByotStateFn = vi.fn(async () => false);
    const materializeFn = vi.fn(() => true);
    const restoreOauthFn = vi.fn<typeof restoreOauthStoreForSlug>(async () => ({ restored: true, present: true }));
    const applyDefaultAgentModelPatchFn = vi.fn(async () => true);
    const reloadFn = vi.fn(async () => {});

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        planInputs: { selectedTier: "personal" },
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "openai-codex" } },
      },
      baseDeps({
        applyByotState: applyByotStateFn,
        materializePlatformBrokerSurfaces: materializeFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyDefaultAgentModelPatch: applyDefaultAgentModelPatchFn,
        triggerSecretsReload: reloadFn,
      }),
    );

    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(materializeFn).toHaveBeenCalledWith("tester-70");
    // same models + budgets as any paying platform user on shared — the
    // paid plan has no house pin, so no default-agent-model patch is forced.
    expect(applyDefaultAgentModelPatchFn).not.toHaveBeenCalled();
    expect(reloadFn).toHaveBeenCalledTimes(1);
  });
  it.each(["anthropic", "openai", "grok", "openrouter", "minimax", "openai-compatible", "claude-cli", "openai-codex"])("keeps %s credentials off a shared gateway and uses platform selections for agent and projects", async provider => {
    const applyByotStateFn = vi.fn(async () => true);
    const materializeFn = vi.fn(() => false);
    const restoreOauthFn = vi.fn<typeof restoreOauthStoreForSlug>(async () => ({ restored: true, present: true }));
    const overrides = vi.fn(async () => true);
    const purge = vi.fn(async () => ({ changed: true, resetCount: 0 }));
    const defaultAgent = "octogee-tester-70-coach";
    const project = "octogee-tester-70-proj-web-coach";
    const safe = { primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] };
    await syncByotForUser({
      byotActive: true,
      username: "tester-70",
      planInputs: { selectedTier: "personal" },
      provisioning: { openclaw: { status: "complete" } },
      builderAgentDefault: safe,
      systemConfig: {
        byot: { provider, model: "user-model", baseUrl: "https://synthetic-provider.example/v1" },
        agentModels: {
          [defaultAgent]: { primary: "custom-tester-70/user-model", fallbacks: [] },
          [project]: { primary: "openai/gpt-5", fallbacks: [safe.primary] },
        },
      },
    }, baseDeps({
      isIsolatedGateway: () => false,
      applyByotState: applyByotStateFn,
      materializePlatformBrokerSurfaces: materializeFn,
      restoreOauthStoreForSlug: restoreOauthFn,
      purgeUserOauthRuntime: purge,
      applyAgentModelOverrides: overrides,
      logFn: () => {},
    }));
    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null, undefined, PRESERVE);
    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(purge).toHaveBeenCalledWith("tester-70", safe.primary, { forceSafeAll: true });
    expect(materializeFn).toHaveBeenCalledWith("tester-70");
    expect(overrides).toHaveBeenCalledWith("tester-70", { [defaultAgent]: safe, [project]: safe }, { houseOnly: false, projectAgentDefault: safe });
  });

  it.each([false, true])("converges owned credentials and routing without changing history (dedicated=%s)", async dedicated => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-gateway-credentials-"));
    const home = path.join(root, "home");
    const defaultAgent = "octogee-tester-70-coach";
    const project = "octogee-tester-70-proj-web-coach";
    const foreign = "octogee-other-coach";
    const ids = [defaultAgent, project, foreign];
    const brokerProfiles = (id: string) => Object.fromEntries([
      ["anthropic", `agent-model-token-${id}`],
      ["platform-openrouter", `agent-model-token-openrouter-${id}`],
      ["platform-openai", `agent-model-token-openai-${id}`],
    ].map(([provider, secret]) => [`${provider}:default`, {
      type: "api_key", provider, keyRef: { source: "exec", provider: "gcp-secret-manager", id: secret },
    }]));
    const userProfiles = (id: string) => ({ profiles: {
      ...brokerProfiles(id),
      "openai:default": { type: "api_key", provider: "openai", key: "synthetic-user-key" },
    } });
    const userModels = { providers: { "custom-tester-70": { apiKey: "synthetic-user-key", models: [] } } };
    const config = { agents: { entries: Object.fromEntries(ids.map(id => [id, { model: "custom-tester-70/user-model" }])) } };
    const patches: unknown[] = [];
    const rpc = { sessionsList: vi.fn(async () => ({ sessions: [] })), sessionsReset: vi.fn(async () => ({ ok: true as const })), close: vi.fn(async () => {}) };
    try {
      for (const id of ids) {
        seedAgent(root, id);
        const dir = codexAgentDir(root, id);
        await writeAuthProfileStore(dir, userProfiles(id));
        fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify(userModels));
        fs.writeFileSync(path.join(dir, ".byot-managed"), "managed");
        fs.writeFileSync(path.join(dir, "history.jsonl"), "synthetic preserved conversation\n");
      }
      await syncByotForUser({
        byotActive: true, username: "tester-70", planInputs: { selectedTier: "personal" },
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "grok", model: "user-model" } },
      }, baseDeps({
        isIsolatedGateway: () => dedicated,
        isSharedGateway: () => !dedicated,
        usesLlmBrokerToken: () => dedicated,
        applyByotState: (slug: string, input: Parameters<typeof applyByotState>[1], _agents: unknown, options: Parameters<typeof applyByotState>[3]) => applyByotState(slug, input, path.join(root, "agents"), options),
        purgeUserOauthRuntime: (slug: string, model: string, options: { forceSafeAll?: boolean }) => purgeUserOauthRuntime(slug, model, {
          ...options, config, openclawDir: root, homeDir: home, rpc,
          applyConfigPatch: async args => { patches.push(args.buildPatch(config)); return { mode: "rpc", attempts: 1, noop: true }; },
        }),
        materializePlatformBrokerSurfaces: vi.fn(async () => false),
        applyAgentModelOverrides: vi.fn(async () => false),
        logFn: () => {},
      }));
      for (const id of ids) {
        const dir = codexAgentDir(root, id);
        expect(fs.readFileSync(path.join(dir, "history.jsonl"), "utf8")).toBe("synthetic preserved conversation\n");
        const profiles = await readAuthProfileStore(dir);
        if (dedicated || id === foreign) {
          expect(profiles).toEqual(userProfiles(id));
          expect(JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"))).toEqual(userModels);
        } else {
          expect(profiles).toEqual({ profiles: brokerProfiles(id) });
          const modelsFile = path.join(dir, "models.json");
          expect(fs.existsSync(modelsFile) ? fs.readFileSync(modelsFile, "utf8") : "").not.toMatch(/synthetic-user-key|custom-tester-70|byok-/);
          if (id === defaultAgent) expect(fs.existsSync(path.join(dir, ".byot-managed"))).toBe(false);
        }
      }
      expect(patches).toHaveLength(dedicated ? 0 : 1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("operator gateway — runtime sync stays narrow", () => {
  it("refreshes native OpenAI auth after restore and on a retry that preserves the already restored credential", async () => {
    modelsAuthRefreshSpy.mockClear();
    modelsAuthRefreshSpy.mockRejectedValueOnce(new Error("native auth refresh unavailable"));
    const requestGatewayRestart = vi.fn(async () => true);
    const restoreOauthStoreForSlug = vi.fn()
      .mockResolvedValueOnce({ restored: true, present: true, providers: ["openai"] })
      .mockResolvedValue({ restored: false, present: true, providers: ["openai"] });
    const deps = {
      isIsolatedGateway: () => true,
      restoreOauthStoreForSlug,
      materializePlatformBrokerSurfaces: vi.fn(async () => false),
      applyOauthRuntimeModelAllowlist: vi.fn(async () => ({ patched: false, changed: false, restartRequired: false })),
      applyDefaultAgentModelPatch: vi.fn(async () => false),
      applyAgentModelOverrides: vi.fn(async () => false),
      requestGatewayRestart,
      triggerSecretsReload: vi.fn(async () => {}),
      hasPendingPlatformCatalogRestart: () => false,
    };
    const user = { ...ON, systemConfig: { byot: { provider: "openai-codex" } } };

    await expect(syncByotForUser(user, deps)).rejects.toThrow("native auth refresh unavailable");
    expect(modelsAuthRefreshSpy).toHaveBeenCalledWith({ agentId: "octogee-tester-70-coach" });
    expect(requestGatewayRestart).not.toHaveBeenCalled();

    await syncByotForUser(user, deps);
    expect(modelsAuthRefreshSpy).toHaveBeenCalledTimes(2);
    expect(requestGatewayRestart).not.toHaveBeenCalled();
  });

  it("restoreOauthStoreForSlug: materializes owner BYOS credentials on operator gateways", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-byos-"));
    seedAgent(openclawDir, "octogee-tester-70-coach");
    const fetchByosubCreds = vi.fn(async () => [
      {
        provider: "anthropic" as const,
        secretName: "byosub-uid-anthropic",
        credential: "sk-ant-oat01-operator-token",
      },
    ]);
    const r = await restoreOauthStoreForSlug("tester-70", {
      fetchByosubCreds,
      openclawDir,
      logFn: () => {},
    });
    expect(r).toEqual({ restored: true, present: true, providers: ["anthropic"] });
    expect(fetchByosubCreds).toHaveBeenCalledWith("octogee-tester-70-coach");

    const store = readAuthProfileStore(codexAgentDir(openclawDir, "octogee-tester-70-coach")) as {
      profiles: Record<string, { provider?: string; access?: string }>;
    };
    expect(store.profiles["anthropic:claude-cli"]).toMatchObject({
      provider: "anthropic",
      access: "sk-ant-oat01-operator-token",
    });
  });

  it("syncByotForUser: restores OAuth credentials and patches the operator runtime model after the credential is present", async () => {
    const applyByotStateFn = vi.fn(async () => true);
    const restoreOauthFn = vi.fn<typeof restoreOauthStoreForSlug>(async () => ({
      restored: true,
      present: true,
      providers: ["openai", "anthropic"],
    }));
    const applyDefaultAgentModelPatchFn = vi.fn(async () => true);
    const applyOauthRuntimeModelAllowlistFn = vi.fn(async () => ({
      patched: true,
      changed: true,
      restartRequired: true,
    }));
    const requestGatewayRestartFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        planInputs: {},
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "openai-codex" } },
      },
      {
        isIsolatedGateway: () => true,
        materializePlatformBrokerSurfaces: vi.fn(async () => false),
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyDefaultAgentModelPatch: applyDefaultAgentModelPatchFn,
        applyOauthRuntimeModelAllowlist: applyOauthRuntimeModelAllowlistFn,
        requestGatewayRestart: requestGatewayRestartFn,
        triggerSecretsReload: triggerSecretsReloadFn,
      },
    );

    expect(applyByotStateFn).not.toHaveBeenCalled();
    expect(restoreOauthFn).toHaveBeenCalledWith("tester-70");
    expect(applyOauthRuntimeModelAllowlistFn).toHaveBeenCalledWith(
      ["openai", "anthropic"],
      ISOLATED_CODEX_APP_SERVER,
    );
    expect(applyDefaultAgentModelPatchFn).toHaveBeenCalledWith({
      slug: "tester-70",
      provider: "openai-codex",
      baseUrl: undefined,
      model: undefined,
      houseModelRef: "platform-openai/gpt-6-luna",
    });
    expect(requestGatewayRestartFn).toHaveBeenCalledTimes(1);
    expect(triggerSecretsReloadFn).not.toHaveBeenCalled();
  });

  it("syncByotForUser: materializes the platform catalog for an operator user without OAuth", async () => {
    let restartPending = false;
    const materializeBrokerFn = vi.fn(() => true);
    const requestGatewayRestartFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});

    await syncByotForUser(
      {
        username: "tester-70",
        planInputs: { selectedTier: "personal" },
        provisioning: { openclaw: { status: "complete" } },
      },
      {
        isIsolatedGateway: () => true,
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        materializePlatformBrokerSurfaces: materializeBrokerFn,
        requestGatewayRestart: requestGatewayRestartFn,
        triggerSecretsReload: triggerSecretsReloadFn,
        hasPendingPlatformCatalogRestart: () => restartPending,
        markPlatformCatalogRestartPending: () => {
          restartPending = true;
        },
        clearPlatformCatalogRestartPending: () => {
          restartPending = false;
        },
      },
    );

    expect(materializeBrokerFn).toHaveBeenCalledWith("tester-70");
    expect(requestGatewayRestartFn).toHaveBeenCalledWith("platform-model-catalog");
    expect(triggerSecretsReloadFn).not.toHaveBeenCalled();
  });

  it("syncByotForUser: retries a rejected platform-catalog restart after transitioning to the standard path", async () => {
    let restartPending = false;
    let operatorGateway = true;
    const materializeBrokerFn = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const requestGatewayRestartFn = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const triggerSecretsReloadFn = vi.fn(async () => {});
    const deps = {
      isIsolatedGateway: () => operatorGateway,
      purgeUserOauthRuntime: noUserOauthRuntimePurge,
      applyByotState: vi.fn(async () => false),
      applyDefaultAgentModelPatch: vi.fn(async () => false),
      applyDefaultAgentToolsConvergence: vi.fn(async () => false),
      materializePlatformBrokerSurfaces: materializeBrokerFn,
      requestGatewayRestart: requestGatewayRestartFn,
      triggerSecretsReload: triggerSecretsReloadFn,
      hasPendingPlatformCatalogRestart: () => restartPending,
      markPlatformCatalogRestartPending: () => {
        restartPending = true;
      },
      clearPlatformCatalogRestartPending: () => {
        restartPending = false;
      },
    };
    const user = {
      username: "tester-70",
      planInputs: { selectedTier: "personal" as const },
      provisioning: { openclaw: { status: "complete" as const } },
    };

    await syncByotForUser(user, deps);
    expect(restartPending).toBe(true);
    expect(triggerSecretsReloadFn).toHaveBeenCalledTimes(1);

    operatorGateway = false;
    await syncByotForUser(user, deps);
    expect(requestGatewayRestartFn).toHaveBeenCalledTimes(2);
    expect(restartPending).toBe(false);
    expect(materializeBrokerFn).toHaveBeenCalledTimes(1);
  });

  it("agentIdsForSlug includes every mounted project agent and excludes foreign agents", () => {
    expect(agentIdsForSlug("tester-70", {
      agents: {
        list: [
          { id: "octogee-tester-70-coach" },
          { id: "octogee-tester-70-proj-web-coach" },
          { id: "octogee-tester-70-proj-api-coach" },
          { id: "octogee-other-coach" },
          { name: "missing-id" },
        ],
      },
    })).toEqual([
      "octogee-tester-70-coach",
      "octogee-tester-70-proj-web-coach",
      "octogee-tester-70-proj-api-coach",
    ]);
  });

  it("syncByotForUser: a user OAuth restore runs Codex without the bwrap sandbox", async () => {
    const currentConfig = {
      agents: {
        list: [
          { id: "octogee-tester-70-coach", model: "anthropic/claude-haiku-4-5" },
        ],
      },
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              appServer: {
                sandbox: "workspace-write",
                approvalPolicy: "never",
              },
            },
          },
        },
      },
    };
    const patches: object[] = [];

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        planInputs: {},
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "openai-codex" } },
      },
      {
        isIsolatedGateway: () => true,
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        applyByotState: vi.fn(async () => true),
        restoreOauthStoreForSlug: vi.fn<typeof restoreOauthStoreForSlug>(async () => ({
          restored: true,
          present: true,
          providers: ["openai"],
        })),
        materializePlatformBrokerSurfaces: vi.fn(async () => false),
        applyOauthRuntimeModelAllowlist: (providers, codexAppServer) =>
          applyOauthRuntimeModelAllowlist(providers, codexAppServer, {
            applyConfigPatch: async (args) => {
              patches.push(args.buildPatch(currentConfig));
              return { mode: "rpc", attempts: 1 };
            },
          }),
        applyDefaultAgentModelPatch: (input) =>
          applyDefaultAgentModelPatch(input, {
            applyConfigPatch: async (args) => {
              patches.push(args.buildPatch(currentConfig));
              return { mode: "rpc", attempts: 1 };
            },
          }),
        triggerSecretsReload: vi.fn(async () => {}),
      },
    );

    expect(patches).toEqual([
      {
        agents: {
          defaults: {
            models: {
              ...codexRuntimeConfig().modelsDef,
            },
          },
        },
        plugins: {
          entries: {
            codex: {
              enabled: true,
              config: {
                appServer: {
                  sandbox: "danger-full-access",
                  approvalPolicy: "never",
                },
              },
            },
          },
        },
      },
      {
        agents: {
          list: [
            {
              id: "octogee-tester-70-coach",
              model: withFallback(CODEX_DEFAULT_MODEL),
            },
          ],
          defaults: {
            models: {
              ...codexRuntimeConfig().modelsDef,
              ...HOUSE_DEFAULTS,
            },
          },
        },
      },
    ]);
  });

  it("anthropic BYOT cleanup still runs on operator broker-token gateways", async () => {
    let restartPending = false;
    const applyByotStateFn = vi.fn(async () => true);
    const restoreOauthFn = vi.fn<typeof restoreOauthStoreForSlug>(async () => ({ restored: true, present: true }));
    const applyDefaultAgentModelPatchFn = vi.fn(async () => true);
    const triggerSecretsReloadFn = vi.fn(async () => {});
    const materializeBrokerFn = vi.fn(() => true);
    const requestGatewayRestartFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        planInputs: {},
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: { byot: { provider: "anthropic" } },
      },
      {
        isIsolatedGateway: () => true,
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        usesLlmBrokerToken: () => true,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: restoreOauthFn,
        applyDefaultAgentModelPatch: applyDefaultAgentModelPatchFn,
        applyDefaultAgentToolsConvergence: vi.fn(async () => false),
        materializePlatformBrokerSurfaces: materializeBrokerFn,
        requestGatewayRestart: requestGatewayRestartFn,
        triggerSecretsReload: triggerSecretsReloadFn,
        hasPendingPlatformCatalogRestart: () => restartPending,
        markPlatformCatalogRestartPending: () => {
          restartPending = true;
        },
        clearPlatformCatalogRestartPending: () => {
          restartPending = false;
        },
      },
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null);
    expect(restoreOauthFn).not.toHaveBeenCalled();
    expect(applyDefaultAgentModelPatchFn).not.toHaveBeenCalled();
    expect(requestGatewayRestartFn).toHaveBeenCalledWith("platform-model-catalog");
    expect(triggerSecretsReloadFn).not.toHaveBeenCalled();
  });
});

describe("applyAgentModelOverrides — per-agent model picks (PWA catalog picker)", () => {
  const CURRENT = {
    agents: {
      list: [
        { id: "octogee-tester-70-coach", name: "coach", model: "old", mmAccount: "a" },
        { id: "octogee-tester-70-proj-web-coach", model: "old" },
        { id: "octogee-zed-coach", model: "z/y" },
      ],
    },
  };

  it("patches each owned agent's full list; openrouter refs get a defaults.models allowlist entry", async () => {
    const calls: object[] = [];
    const paths: (string[] | undefined)[] = [];
    const skipIfAlreadyApplied: Array<boolean | undefined> = [];
    const r = await applyAgentModelOverrides(
      "tester-70",
      {
        "octogee-tester-70-coach": {
          primary: "platform-openrouter/z-ai/glm-5.2",
          fallbacks: ["anthropic/claude-haiku-4-5"],
        },
        "octogee-tester-70-proj-web-coach": {
          primary: "anthropic/claude-sonnet-4-6",
          fallbacks: [],
        },
      },
      { houseOnly: false },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(CURRENT));
          paths.push(args.buildReplacePaths?.(CURRENT));
          skipIfAlreadyApplied.push(args.skipIfAlreadyApplied);
          return { mode: "rpc", attempts: 1 };
        },
        logFn: () => {},
      },
    );
    expect(r).toBe(true);
    expect(skipIfAlreadyApplied).toEqual([true, true]);
    const fullListPaths = [
      "agents.list",
      "agents.list[].model.fallbacks",
      "agents.list[].tools.alsoAllow",
    ];
    expect(paths).toEqual([fullListPaths, fullListPaths]);
    expect(calls[0]).toEqual({
      agents: {
        defaults: { models: { "platform-openrouter/z-ai/glm-5.2": {} } },
        list: [
          {
            id: "octogee-tester-70-coach",
            name: "coach",
            model: {
              primary: "platform-openrouter/z-ai/glm-5.2",
              fallbacks: ["anthropic/claude-haiku-4-5"],
            },
            mmAccount: "a",
          },
          { id: "octogee-tester-70-proj-web-coach", model: "old" },
          { id: "octogee-zed-coach", model: "z/y" },
        ],
      },
    });
    expect(calls[1]).toEqual({
      agents: {
        list: [
          { id: "octogee-tester-70-coach", name: "coach", model: "old", mmAccount: "a" },
          {
            id: "octogee-tester-70-proj-web-coach",
            model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
          },
          { id: "octogee-zed-coach", model: "z/y" },
        ],
      },
    });
  });

  it("strips the platform trim ONLY on the agent — a project agent's tools keys are untouched by its own override", async () => {
    const withBlocks = {
      agents: {
        list: [
          {
            id: "octogee-tester-70-coach",
            model: "old",
            tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS },
          },
          {
            id: "octogee-tester-70-proj-web-coach",
            model: "old",
            tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS },
          },
        ],
      },
    };
    const calls: object[] = [];
    const r = await applyAgentModelOverrides(
      "tester-70",
      {
        "octogee-tester-70-coach": { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
        "octogee-tester-70-proj-web-coach": { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
      },
      { houseOnly: false },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(withBlocks));
          return { mode: "rpc", attempts: 1 };
        },
        logFn: () => {},
      },
    );
    expect(r).toBe(true);
    const pick = { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] };
    expect(calls[0]).toEqual({
      agents: {
        list: [
          { id: "octogee-tester-70-coach", model: pick, tools: { fs: { workspaceOnly: true } } },
          {
            id: "octogee-tester-70-proj-web-coach",
            model: "old",
            tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS },
          },
        ],
      },
    });
    expect(calls[1]).toEqual({
      agents: {
        list: [
          {
            id: "octogee-tester-70-coach",
            model: "old",
            tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS },
          },
          {
            id: "octogee-tester-70-proj-web-coach",
            model: pick,
            tools: { fs: { workspaceOnly: true }, ...HOUSE_MODEL_DEFAULT_AGENT_TOOLS },
          },
        ],
      },
    });
  });

  it("declares a platform-openai pick in defaults.models like an openrouter one", async () => {
    const calls: object[] = [];
    const r = await applyAgentModelOverrides(
      "tester-70",
      {
        "octogee-tester-70-coach": {
          primary: "platform-openai/gpt-5.4-mini",
          fallbacks: [],
        },
      },
      { houseOnly: false },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(CURRENT));
          return { mode: "rpc", attempts: 1 };
        },
        logFn: () => {},
      },
    );
    expect(r).toBe(true);
    expect(calls[0]).toMatchObject({
      agents: {
        defaults: { models: { "platform-openai/gpt-5.4-mini": {} } },
      },
    });
  });

  it("updates a beta keyed project agent without writing agents.list", async () => {
    const calls: object[] = [];
    const paths: Array<string[] | undefined> = [];
    const current = {
      agents: {
        entries: {
          "octogee-tester-70-coach": { model: "old" },
          "octogee-tester-70-proj-web-coach": { name: "web", model: "old" },
        },
      },
    };
    await expect(applyAgentModelOverrides(
      "tester-70",
      {
        "octogee-tester-70-proj-web-coach": {
          primary: "anthropic/claude-sonnet-4-6",
          fallbacks: [],
        },
      },
      { houseOnly: false },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(current));
          paths.push(args.buildReplacePaths?.(current));
          return { mode: "rpc", attempts: 1 };
        },
        logFn: () => {},
      },
    )).resolves.toBe(true);

    expect(paths).toEqual([[
      "agents.entries.octogee-tester-70-proj-web-coach.model.fallbacks",
      "agents.entries.octogee-tester-70-proj-web-coach.tools.alsoAllow",
    ]]);
    expect(calls).toEqual([
      {
        agents: {
          entries: {
            "octogee-tester-70-proj-web-coach": {
              name: "web",
              model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
            },
          },
        },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('"list"');
  });

  it("ignores foreign agent ids (cross-tenant safety) and no-ops on empty input", async () => {
    const applyConfigPatchFn = vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 }));
    const logs: string[] = [];
    const r = await applyAgentModelOverrides(
      "tester-70",
      { "octogee-zed-coach": { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] } },
      { houseOnly: false },
      { applyConfigPatch: applyConfigPatchFn, logFn: (m) => logs.push(m) },
    );
    expect(r).toBe(false);
    expect(applyConfigPatchFn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("octogee-zed-coach");

    expect(
      await applyAgentModelOverrides("tester-70", undefined, { houseOnly: false }, {
        applyConfigPatch: applyConfigPatchFn,
        logFn: () => {},
      }),
    ).toBe(false);
  });

  it("defers all overrides on a house-only plan (free pins the house model)", async () => {
    const applyConfigPatchFn = vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 }));
    const r = await applyAgentModelOverrides(
      "tester-70",
      { "octogee-tester-70-coach": { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] } },
      { houseOnly: true },
      { applyConfigPatch: applyConfigPatchFn, logFn: () => {} },
    );
    expect(r).toBe(false);
    expect(applyConfigPatchFn).not.toHaveBeenCalled();
  });

  const PLATFORM_DEFAULT = {
    primary: "platform-openai/gpt-6.1-terra",
    fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
  };

  it("gives every owned project agent without a pick the platform default and its fallbacks", async () => {
    const current = {
      agents: {
        list: [
          { id: "octogee-tester-70-coach", model: "platform-openai/gpt-6-luna" },
          {
            id: "octogee-tester-70-proj-web-coach",
            model: { primary: "platform-openai/gpt-6.1-terra", fallbacks: [] },
          },
          { id: "octogee-tester-70-proj-api-coach", model: "anthropic/claude-sonnet-4-6" },
          { id: "octogee-zed-proj-web-coach", model: "z/y" },
        ],
      },
    };
    const calls: object[] = [];
    const paths: Array<string[] | undefined> = [];
    const skipIfAlreadyApplied: Array<boolean | undefined> = [];
    const r = await applyAgentModelOverrides(
      "tester-70",
      {
        "octogee-tester-70-proj-api-coach": {
          primary: "anthropic/claude-sonnet-4-6",
          fallbacks: [],
        },
      },
      { houseOnly: false, projectAgentDefault: PLATFORM_DEFAULT },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(current));
          paths.push(args.buildReplacePaths?.(current));
          skipIfAlreadyApplied.push(args.skipIfAlreadyApplied);
          return { mode: "rpc", attempts: 1 };
        },
        logFn: () => {},
      },
    );

    expect(r).toBe(true);
    expect(calls).toHaveLength(2);
    expect(skipIfAlreadyApplied[1]).toBe(true);
    expect(paths[1]).toEqual([
      "agents.list",
      "agents.list[].model.fallbacks",
      "agents.list[].tools.alsoAllow",
    ]);
    expect(calls[1]).toEqual({
      agents: {
        defaults: {
          models: {
            "platform-openai/gpt-6.1-terra": {},
            "platform-openrouter/z-ai/glm-5.2": {},
          },
        },
        list: [
          { id: "octogee-tester-70-coach", model: "platform-openai/gpt-6-luna" },
          { id: "octogee-tester-70-proj-web-coach", model: PLATFORM_DEFAULT },
          { id: "octogee-tester-70-proj-api-coach", model: "anthropic/claude-sonnet-4-6" },
          { id: "octogee-zed-proj-web-coach", model: "z/y" },
        ],
      },
    });
  });

  it("gives keyed project agents the platform default and confirms their fallbacks may shrink", async () => {
    const current = {
      agents: {
        entries: {
          "octogee-tester-70-coach": { model: "platform-openai/gpt-6-luna" },
          "octogee-tester-70-proj-web-coach": {
            name: "web",
            model: {
              primary: "platform-openai/gpt-6.1-terra",
              fallbacks: ["anthropic/claude-sonnet-4-6", "anthropic/claude-haiku-4-5"],
            },
          },
          "octogee-zed-proj-web-coach": { model: "z/y" },
        },
      },
    };
    const calls: object[] = [];
    const paths: Array<string[] | undefined> = [];
    await applyAgentModelOverrides(
      "tester-70",
      undefined,
      { houseOnly: false, projectAgentDefault: PLATFORM_DEFAULT },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(current));
          paths.push(args.buildReplacePaths?.(current));
          return { mode: "rpc", attempts: 1 };
        },
        logFn: () => {},
      },
    );

    expect(paths).toEqual([["agents.entries.octogee-tester-70-proj-web-coach.model.fallbacks"]]);
    expect(calls).toEqual([
      {
        agents: {
          defaults: {
            models: {
              "platform-openai/gpt-6.1-terra": {},
              "platform-openrouter/z-ai/glm-5.2": {},
            },
          },
          entries: {
            "octogee-tester-70-proj-web-coach": { name: "web", model: PLATFORM_DEFAULT },
          },
        },
      },
    ]);
  });

  it("leaves the config untouched when every project agent has a pick", async () => {
    const calls: object[] = [];
    const r = await applyAgentModelOverrides(
      "tester-70",
      { "octogee-tester-70-proj-web-coach": { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] } },
      { houseOnly: false, projectAgentDefault: PLATFORM_DEFAULT },
      {
        applyConfigPatch: async (args) => {
          calls.push(args.buildPatch(CURRENT));
          return { mode: "rpc", attempts: 1 };
        },
        logFn: () => {},
      },
    );

    expect(r).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({});
  });

  it("never gives a house-only plan's project agents the platform default", async () => {
    const applyConfigPatchFn = vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 }));
    const r = await applyAgentModelOverrides(
      "tester-70",
      undefined,
      { houseOnly: true, projectAgentDefault: PLATFORM_DEFAULT },
      { applyConfigPatch: applyConfigPatchFn, logFn: () => {} },
    );
    expect(r).toBe(false);
    expect(applyConfigPatchFn).not.toHaveBeenCalled();
  });

  it("a failed patch on one agent does not abort the rest", async () => {
    const applyConfigPatchFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway busy"))
      .mockResolvedValueOnce({ mode: "rpc", attempts: 1 });
    const r = await applyAgentModelOverrides(
      "tester-70",
      {
        "octogee-tester-70-coach": { primary: "anthropic/claude-sonnet-4-6", fallbacks: [] },
        "octogee-tester-70-proj-web-coach": {
          primary: "anthropic/claude-haiku-4-5",
          fallbacks: [],
        },
      },
      { houseOnly: false },
      { applyConfigPatch: applyConfigPatchFn, logFn: () => {} },
    );
    expect(r).toBe(true);
    expect(applyConfigPatchFn).toHaveBeenCalledTimes(2);
  });
});

describe("syncByotForUser — agent-model overrides ride every class path", () => {
  it("standard gateway: overrides applied after the default-agent-model sync with the plan's houseOnly", async () => {
    const applyAgentModelOverridesFn = vi.fn(async () => true);
    const agentModels = {
      "octogee-tester-70-coach": {
        primary: "platform-openrouter/z-ai/glm-5.2",
        fallbacks: [] as string[],
      },
    };

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        planInputs: { selectedTier: "personal" },
        systemConfig: { agentModels },
      },
      {
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        applyByotState: vi.fn(async () => false),
        applyDefaultAgentModelPatch: vi.fn(async () => false),
        applyDefaultAgentToolsConvergence: vi.fn(async () => false),
        triggerSecretsReload: vi.fn(async () => {}),
        applyAgentModelOverrides: applyAgentModelOverridesFn,
      },
    );

    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith("tester-70", agentModels, {
      houseOnly: false,
    });
  });

  it("user OAuth suppression uses the effective platform state and replaces stale runtime refs", async () => {
    const applyByotStateFn = vi.fn(async () => false);
    const applyDefaultAgentToolsConvergenceFn = vi.fn(async () => false);
    const applyAgentModelOverridesFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        planInputs: { selectedTier: "personal" },
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: {
          byot: { provider: "claude-cli" },
          agentModels: {
            "octogee-tester-70-coach": {
              primary: "claude-cli/claude-opus-4-8",
              fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
            },
            "octogee-tester-70-proj-web-coach": {
              primary: "claude-cli/claude-opus-4-8",
              fallbacks: [],
            },
          },
        },
      },
      {
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        applyByotState: applyByotStateFn,
        restoreOauthStoreForSlug: vi.fn(async () => ({ restored: true, present: true })),
        applyDefaultAgentModelPatch: vi.fn(async () => false),
        applyDefaultAgentToolsConvergence: applyDefaultAgentToolsConvergenceFn,
        triggerSecretsReload: vi.fn(async () => {}),
        applyAgentModelOverrides: applyAgentModelOverridesFn,
        logFn: () => {},
      },
    );

    expect(applyByotStateFn).toHaveBeenCalledWith("tester-70", null, undefined, {
      preserveAuthProfileStore: false,
    });
    expect(applyDefaultAgentToolsConvergenceFn).toHaveBeenCalledWith("tester-70", false);
    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith(
      "tester-70",
      {
        "octogee-tester-70-coach": {
          primary: "platform-openrouter/z-ai/glm-5.2",
          fallbacks: [],
        },
        "octogee-tester-70-proj-web-coach": {
          primary: "platform-openai/gpt-6-luna",
          fallbacks: [],
        },
      },
      { houseOnly: false },
    );
  });

  it("user OAuth suppression forces the compiled safe agent model when no safe pick remains", async () => {
    const applyAgentModelOverridesFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        planInputs: { selectedTier: "personal" },
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: {
          byot: { provider: "openai-codex" },
          agentModels: {
            "octogee-tester-70-coach": {
              primary: "openai/gpt-5.5",
              fallbacks: [],
            },
            "octogee-tester-70-proj-web-coach": {
              primary: "claude-cli/claude-opus-4-8",
              fallbacks: [],
            },
          },
        },
      },
      {
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        applyByotState: vi.fn(async () => false),
        applyDefaultAgentModelPatch: vi.fn(async () => false),
        applyDefaultAgentToolsConvergence: vi.fn(async () => false),
        triggerSecretsReload: vi.fn(async () => {}),
        applyAgentModelOverrides: applyAgentModelOverridesFn,
        logFn: () => {},
      },
    );

    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith(
      "tester-70",
      {
        "octogee-tester-70-coach": {
          primary: "platform-openai/gpt-6-luna",
          fallbacks: [],
        },
        "octogee-tester-70-proj-web-coach": {
          primary: "platform-openai/gpt-6-luna",
          fallbacks: [],
        },
      },
      { houseOnly: false },
    );
  });

  it("user sync resets malformed owned selections instead of leaving a prior runtime pin", async () => {
    const applyAgentModelOverridesFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        planInputs: { selectedTier: "personal" },
        provisioning: { openclaw: { status: "complete" } },
        systemConfig: {
          agentModels: {
            "octogee-tester-70-proj-web-coach": {
              primary: "invalid",
              fallbacks: [],
            },
          } as never,
        },
      },
      {
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        applyByotState: vi.fn(async () => false),
        applyDefaultAgentModelPatch: vi.fn(async () => false),
        applyDefaultAgentToolsConvergence: vi.fn(async () => false),
        triggerSecretsReload: vi.fn(async () => {}),
        applyAgentModelOverrides: applyAgentModelOverridesFn,
        logFn: () => {},
      },
    );

    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith(
      "tester-70",
      {
        "octogee-tester-70-proj-web-coach": {
          primary: "platform-openai/gpt-6-luna",
          fallbacks: [],
        },
      },
      { houseOnly: false },
    );
  });


  const userDefaultDeps = (applyAgentModelOverridesFn: NonNullable<SyncByotForUserDeps["applyAgentModelOverrides"]>) => ({
    purgeUserOauthRuntime: noUserOauthRuntimePurge,
    applyByotState: vi.fn(async () => false),
    applyDefaultAgentModelPatch: vi.fn(async () => false),
    applyDefaultAgentToolsConvergence: vi.fn(async () => false),
    triggerSecretsReload: vi.fn(async () => {}),
    applyAgentModelOverrides: applyAgentModelOverridesFn,
  });
  const userAgentDefault = {
    primary: "platform-openai/gpt-6-luna",
    fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
  };

  it("catalog plan with no pick: the platform user agent default fills in for the agent and its project agents", async () => {
    const applyAgentModelOverridesFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        planInputs: { selectedTier: "personal" },
        builderAgentDefault: userAgentDefault,
      },
      userDefaultDeps(applyAgentModelOverridesFn),
    );

    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith(
      "tester-70",
      { "octogee-tester-70-coach": userAgentDefault },
      { houseOnly: false, projectAgentDefault: userAgentDefault },
    );
  });

  it.each([
    { gateway: "isolated", isIsolatedGateway: true, isSharedGateway: false },
    { gateway: "shared", isIsolatedGateway: false, isSharedGateway: true },
  ])("$gateway gateway: project agents get the platform default's fallbacks", async ({ isIsolatedGateway, isSharedGateway }) => {
    const applyAgentModelOverridesFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        planInputs: { selectedTier: "personal" },
        builderAgentDefault: userAgentDefault,
      },
      {
        ...userDefaultDeps(applyAgentModelOverridesFn),
        isIsolatedGateway: () => isIsolatedGateway,
        isSharedGateway: () => isSharedGateway,
        usesLlmBrokerToken: () => isIsolatedGateway,
        restoreOauthStoreForSlug: vi.fn(async () => ({ restored: false, present: false })),
        materializePlatformBrokerSurfaces: vi.fn(() => false),
        logFn: () => {},
      },
    );

    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith(
      "tester-70",
      expect.anything(),
      expect.objectContaining({ projectAgentDefault: userAgentDefault }),
    );
  });

  it("an explicit agent pick beats the platform default", async () => {
    const applyAgentModelOverridesFn = vi.fn(async () => true);
    const agentModels = {
      "octogee-tester-70-coach": {
        primary: "anthropic/claude-sonnet-4-6",
        fallbacks: [] as string[],
      },
    };

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        planInputs: { selectedTier: "personal" },
        builderAgentDefault: userAgentDefault,
        systemConfig: { agentModels },
      },
      userDefaultDeps(applyAgentModelOverridesFn),
    );

    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith("tester-70", agentModels, {
      houseOnly: false,
      projectAgentDefault: userAgentDefault,
    });
  });

  it("a malformed platform-default stamp is discarded, not applied", async () => {
    const applyAgentModelOverridesFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        planInputs: { selectedTier: "personal" },
        builderAgentDefault: { primary: "not-a-catalog-ref", fallbacks: [] },
      },
      userDefaultDeps(applyAgentModelOverridesFn),
    );

    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith("tester-70", undefined, {
      houseOnly: false,
    });
  });

  it("a user still provisioning gets no project agent default", async () => {
    const applyAgentModelOverridesFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "provisioning" } },
        planInputs: { selectedTier: "personal" },
        builderAgentDefault: userAgentDefault,
      },
      userDefaultDeps(applyAgentModelOverridesFn),
    );

    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith("tester-70", undefined, {
      houseOnly: false,
    });
  });

  it("a builderSubscription owner (no paid Personal plan) is NOT house-only — catalog picks apply", async () => {
    const applyAgentModelOverridesFn = vi.fn(async () => true);
    const agentModels = {
      "octogee-tester-70-coach": {
        primary: "platform-openrouter/z-ai/glm-5.2",
        fallbacks: [] as string[],
      },
    };

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        planInputs: { selectedTier: "personal_free", builderSubscription: { tier: "hobby", status: "active" } },
        systemConfig: { agentModels },
      },
      {
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        applyByotState: vi.fn(async () => false),
        applyDefaultAgentModelPatch: vi.fn(async () => false),
        applyDefaultAgentToolsConvergence: vi.fn(async () => false),
        triggerSecretsReload: vi.fn(async () => {}),
        applyAgentModelOverrides: applyAgentModelOverridesFn,
      },
    );

    expect(applyAgentModelOverridesFn).toHaveBeenCalledWith("tester-70", agentModels, {
      houseOnly: false,
    });
  });
});

describe("syncByotForUser — tools convergence wiring", () => {

  it("paid catalog user with no model pick: the standalone convergence strips a lingering trim (upgrade path)", async () => {
    const applyDefaultAgentModelPatchFn = vi.fn(async () => true);
    const applyDefaultAgentToolsConvergenceFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        planInputs: { selectedTier: "personal", subscription: { tier: "personal", status: "active" } },
      },
      {
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        applyByotState: vi.fn(async () => false),
        applyDefaultAgentModelPatch: applyDefaultAgentModelPatchFn,
        applyDefaultAgentToolsConvergence: applyDefaultAgentToolsConvergenceFn,
        triggerSecretsReload: vi.fn(async () => {}),
      },
    );

    expect(applyDefaultAgentModelPatchFn).not.toHaveBeenCalled();
    expect(applyDefaultAgentToolsConvergenceFn).toHaveBeenCalledWith("tester-70", false);
  });

  it("house_only + anthropic BYOK (no default-agent-model patch ships): tools convergence still runs and targets the inherited surface", async () => {
    const applyDefaultAgentModelPatchFn = vi.fn(async () => false);
    const applyDefaultAgentToolsConvergenceFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: true,
        username: "tester-70",
        provisioning: { openclaw: { status: "complete" } },
        planInputs: { selectedTier: "free" },
        systemConfig: { byot: { provider: "anthropic" } },
      },
      {
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        usesLlmBrokerToken: () => false,
        applyByotState: vi.fn(async () => false),
        restoreOauthStoreForSlug: vi.fn(async () => ({ restored: false, present: true })),
        applyDefaultAgentModelPatch: applyDefaultAgentModelPatchFn,
        applyDefaultAgentToolsConvergence: applyDefaultAgentToolsConvergenceFn,
        triggerSecretsReload: vi.fn(async () => {}),
      },
    );

    // anthropic BYOK produces no per-agent model override (byosDefaultAgentConfigPatch
    // → null), so without the standalone convergence the stale trim would
    // outlive the documented BYOK carve-out forever.
    expect(applyDefaultAgentToolsConvergenceFn).toHaveBeenCalledWith("tester-70", false);
  });

  it("incomplete provisioning: no tools convergence — the agent entry may not exist yet", async () => {
    const applyDefaultAgentToolsConvergenceFn = vi.fn(async () => true);

    await syncByotForUser(
      {
        byotActive: false,
        username: "tester-70",
        provisioning: { openclaw: { status: "in_progress" } },
        planInputs: { selectedTier: "personal" },
      },
      {
        purgeUserOauthRuntime: noUserOauthRuntimePurge,
        applyByotState: vi.fn(async () => false),
        applyDefaultAgentModelPatch: vi.fn(async () => false),
        applyDefaultAgentToolsConvergence: applyDefaultAgentToolsConvergenceFn,
        triggerSecretsReload: vi.fn(async () => {}),
      },
    );

    expect(applyDefaultAgentToolsConvergenceFn).not.toHaveBeenCalled();
  });
});


it("rewrites platform catalogs without credential markers during user OAuth cleanup", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "authless-purge-catalog-"));
  const id = "octogee-tester-70-coach";
  vi.stubEnv("OPENROUTER_BASE_URL", "http://broker.invalid/openrouter/v1");
  vi.stubEnv("PLATFORM_OPENAI_BASE_URL", "http://broker.invalid/openai/v1");
  vi.stubEnv("PLATFORM_VERTEX_BASE_URL", "http://broker.invalid/vertex");
  try {
    seedAgent(root, id);
    const file = path.join(codexAgentDir(root, id), "models.json");
    fs.writeFileSync(file, JSON.stringify({ providers: Object.fromEntries(["platform-openrouter", "platform-openai", "platform-vertex"].map(provider => [provider, { apiKey: provider + ":default", models: [] }])) }));
    await purgeUserOauthRuntime("tester-70", "platform-openrouter/z-ai/glm-5.2", {
      config: { agents: { entries: { [id]: {} } } }, openclawDir: root, homeDir: path.join(root, "home"),
      rpc: { sessionsList: async () => ({ sessions: [] }), sessionsReset: async () => ({ ok: true }), close: async () => {} } as never,
      applyConfigPatch: async () => ({ mode: "rpc", attempts: 1, noop: true }),
    });
    const providers = JSON.parse(fs.readFileSync(file, "utf8")).providers;
    for (const provider of ["platform-openrouter", "platform-openai", "platform-vertex"]) {
      expect(providers[provider]).not.toHaveProperty("apiKey");
      expect(providers[provider].models.length).toBeGreaterThan(0);
    }
    expect(providers["platform-vertex"]).toMatchObject({ api: "anthropic-messages", baseUrl: "http://broker.invalid/vertex" });
    expect(providers["platform-vertex"].models).toContainEqual(expect.objectContaining({ id: "claude-sonnet-5" }));
  } finally { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
});
