import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { modelCatalogForProvider } from "@octogee/shared/types/model-catalog";
import { buildMattermostAccounts } from "../lib/openclaw-config-users.js";
import {
  applyAgentStoreDatabasePatch,
  applyAnthropicBaseUrlPatch,
  applyOpenClawBeta5CompatibilityPatch,
  applyPreBootPatches,
  platformBrokerCatalogOpts,
  applyTypingModeDefault,
  applyVerboseDefault,
  shouldMaterializeAnthropicBrokerProfiles,
  applyMattermostPreBootPatches,
  applyMemorySearchSchemaPatch,
  applySharedMattermostRoutingSafetyPatch,
  buildGitconfigContent,
  hydrateGitIdentity,
  materializeBrokerProfilesBeforeBoot,
  pickSoleTenantSlug,
  slugFromManagedAgentId,
  writeConfigAtomically,
} from "../entrypoints/pre-boot-config.js";

function emptyConfig(): any {
  return {};
}

describe("workspace identity bootstrap policy", () => {
  it.each(["shared", "isolated"])("preserves optional-file choices while leaving restored identity to its owner on %s", gatewayClass => {
    const config = { agents: { defaults: { skipOptionalBootstrapFiles: ["USER.md"] } } };
    applyPreBootPatches(config, { GATEWAY_CLASS: gatewayClass });
    expect(config.agents.defaults.skipOptionalBootstrapFiles).toEqual(["USER.md", "IDENTITY.md"]);
    applyPreBootPatches(config, { GATEWAY_CLASS: gatewayClass });
    expect(config.agents.defaults.skipOptionalBootstrapFiles).toEqual(["USER.md", "IDENTITY.md"]);
  });

  it("keeps unrelated runtimes and invalid optional-file configuration unchanged", () => {
    const unrelated = { agents: { defaults: { skipOptionalBootstrapFiles: ["USER.md"] } } };
    applyPreBootPatches(unrelated, { GATEWAY_CLASS: "ops" });
    expect(unrelated.agents.defaults.skipOptionalBootstrapFiles).toEqual(["USER.md"]);
    const invalid = { agents: { defaults: { skipOptionalBootstrapFiles: "USER.md" } } };
    applyPreBootPatches(invalid, { GATEWAY_CLASS: "shared" });
    expect(invalid.agents.defaults.skipOptionalBootstrapFiles).toBe("USER.md");
  });
});

describe("shared Mattermost routing safety", () => {
  it("creates the quarantine roster when a shared config has no explicit agents", () => {
    const config: any = {};

    expect(
      applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, vi.fn()),
    ).toBe(true);
    expect(config.agents.ownership).toBe("explicit");
    expect(config.agents.list).toEqual([
      expect.objectContaining({ id: "octogee-unmatched-route" }),
    ]);
    expect(config.agents.list[0]).not.toHaveProperty("default");
  });

  it.each([
    ["unset", {}],
    ["empty", { GATEWAY_CLASS: "" }],
    ["a misspelling of shared", { GATEWAY_CLASS: "shraed" }],
    ["a retired operator class", { GATEWAY_CLASS: "operator" }],
  ])("quarantines unmatched routes when GATEWAY_CLASS is %s", (_label, env) => {
    const config: any = {};

    expect(applySharedMattermostRoutingSafetyPatch(config, env, vi.fn())).toBe(true);
    expect(config.agents.ownership).toBe("explicit");
    expect(config.agents.list).toEqual([
      expect.objectContaining({ id: "octogee-unmatched-route" }),
    ]);
    expect(config.agents.list[0]).not.toHaveProperty("default");
  });

  it("leaves an isolated gateway pinned to its own agent", () => {
    const config: any = { agents: { list: [{ id: "octogee-ceckert-coach", default: true }] } };

    expect(
      applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "isolated" }, vi.fn()),
    ).toBe(false);
    expect(config.agents.list).toEqual([{ id: "octogee-ceckert-coach", default: true }]);
  });

  it("repairs an explicit keyed shared roster that still carries a legacy default marker", () => {
    const config: any = {
      agents: {
        ownership: "explicit",
        entries: {
          "octogee-unmatched-route": { default: true },
          "octogee-ceckert-test-coach": {},
        },
      },
    };

    expect(
      applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, vi.fn()),
    ).toBe(true);
    expect(config.agents).toEqual({
      ownership: "explicit",
      entries: expect.objectContaining({
        "octogee-unmatched-route": expect.not.objectContaining({ default: expect.anything() }),
        "octogee-ceckert-test-coach": {},
      }),
    });
  });

  it("installs an explicit quarantine roster and deterministic stable account routes", () => {
    const config: any = {
      agents: {
        list: [
          { id: "octogee-mike-coach", default: true },
          { id: "octogee-ceckert-coach" },
        ],
      },
      channels: {
        mattermost: {
          accounts: {
            "mike-coach": {},
            "ceckert-coach": {},
          },
        },
      },
      bindings: [
        {
          agentId: "octogee-mike-coach",
          match: {
            channel: "mattermost",
            accountId: "mike-coach",
            peer: { kind: "group", id: "mmmmmmmmmmmmmmmmmmmmmmmmmm" },
          },
        },
        {
          agentId: "octogee-ceckert-coach",
          match: {
            channel: "mattermost",
            accountId: "ceckert-coach",
            peer: { kind: "group", id: "cccccccccccccccccccccccccc" },
          },
        },
      ],
    };

    expect(
      applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, vi.fn()),
    ).toBe(true);
    expect(config.agents.ownership).toBe("explicit");
    expect(config.agents.list[0]).toMatchObject({
      id: "octogee-unmatched-route",
    });
    expect(config.agents.list[0]).not.toHaveProperty("default");
    expect(config.agents.list[1]).not.toHaveProperty("default");
    expect(config.bindings).toEqual(expect.arrayContaining([
      {
        agentId: "octogee-mike-coach",
        match: { channel: "mattermost", accountId: "mike-coach" },
      },
      {
        agentId: "octogee-ceckert-coach",
        match: { channel: "mattermost", accountId: "ceckert-coach" },
      },
    ]));
  });

  it("removes foreign peer routes without discarding the managed owner's routes", () => {
    const config: any = {
      agents: { list: [{ id: "octogee-mike-coach" }, { id: "octogee-jack-coach" }] },
      channels: { mattermost: { accounts: { "mike-coach": {} } } },
      bindings: [
        {
          agentId: "octogee-mike-coach",
          match: {
            channel: "mattermost",
            accountId: "mike-coach",
            peer: { kind: "group", id: "aaaaaaaaaaaaaaaaaaaaaaaaaa" },
          },
        },
        {
          agentId: "octogee-jack-coach",
          match: {
            channel: "mattermost",
            accountId: "mike-coach",
            peer: { kind: "group", id: "bbbbbbbbbbbbbbbbbbbbbbbbbb" },
          },
        },
        {
          agentId: "octogee-mike-coach",
          match: { channel: "mattermost", accountId: "mike-coach" },
        },
      ],
    };
    const log = vi.fn();

    applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, log);

    expect(config.bindings).toContainEqual({
      agentId: "octogee-mike-coach",
      match: { channel: "mattermost", accountId: "mike-coach" },
    });
    expect(config.bindings).not.toContainEqual({
      agentId: "octogee-jack-coach",
      match: {
        channel: "mattermost",
        accountId: "mike-coach",
        peer: { kind: "group", id: "bbbbbbbbbbbbbbbbbbbbbbbbbb" },
      },
    });
    expect(log).toHaveBeenCalledWith(
      "converged Mattermost account routes (stable=1, quarantined=0)",
    );
  });

  it("removes every account route when the deterministic managed agent is absent", () => {
    const config: any = {
      agents: { list: [{ id: "octogee-mike-coach", default: true }] },
      channels: { mattermost: { accounts: { "ceckert-coach": {} } } },
      bindings: [
        {
          agentId: "octogee-mike-coach",
          match: { channel: "mattermost", accountId: "ceckert-coach" },
        },
      ],
    };
    const log = vi.fn();

    applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, log);

    expect(config.bindings).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "refused account route without managed agent for ceckert-coach",
    );
  });

  it("never promotes a foreign peer into the deterministic account route", () => {
    const config: any = {
      agents: {
        list: [{ id: "octogee-mike-coach" }, { id: "octogee-ceckert-coach" }],
      },
      channels: { mattermost: { accounts: { "ceckert-coach": {} } } },
      bindings: [{
        agentId: "octogee-mike-coach",
        match: {
          channel: "mattermost",
          accountId: "ceckert-coach",
          peer: { kind: "group", id: "cccccccccccccccccccccccccc" },
        },
      }],
    };

    applySharedMattermostRoutingSafetyPatch(config, { GATEWAY_CLASS: "shared" }, vi.fn());

    expect(config.bindings).toEqual([{
      agentId: "octogee-ceckert-coach",
      match: { channel: "mattermost", accountId: "ceckert-coach" },
    }]);
  });

  it("converges stable routes from the beta keyed agent roster", () => {
    const config: any = {
      agents: {
        entries: {
          "octogee-ceckert-coach": { model: "platform/one" },
        },
      },
      channels: { mattermost: { accounts: { "ceckert-coach": {} } } },
      bindings: [],
    };

    applySharedMattermostRoutingSafetyPatch(
      config,
      { GATEWAY_CLASS: "shared" },
      vi.fn(),
    );

    expect(config.bindings).toEqual([{
      agentId: "octogee-ceckert-coach",
      match: { channel: "mattermost", accountId: "ceckert-coach" },
    }]);
  });
});

describe("pre-boot config persistence", () => {
  it.each(["shared", "isolated"])("materializes shared channel memory without changing reply placement on %s gateways", (gatewayClass) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preboot-thread-scope-"));
    const configPath = path.join(dir, "openclaw.json");
    const account = {
      ...buildMattermostAccounts(
        [{ uid: "existing", slug: "existing", customerMmUserId: "u".repeat(26) }],
        new Map([["existing", "coach-token"]]),
      )["existing-coach"],
      replyToMode: "first",
      replyToModeByChatType: { direct: "off" },
      streaming: { mode: "off", preview: { toolProgress: false } },
    };
    const channelPolicy = {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
      streaming: { mode: "partial", preview: { toolProgress: false } },
      requireMention: true,
      commands: { native: false },
    };
    try {
      writeConfigAtomically(configPath, {
        agents: { list: [{ id: "octogee-existing-coach" }] },
        channels: { mattermost: {
          ...channelPolicy,
          threadSessionScope: "channel",
          accounts: { "existing-coach": { ...account, threadSessionScope: "channel" } },
        } },
      });
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const log = vi.fn();

      expect(applyPreBootPatches(config, { GATEWAY_CLASS: gatewayClass }, log)).toBe(true);
      writeConfigAtomically(configPath, config);

      const materialized = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(materialized.channels.mattermost.threadSessionScope).toBe("channel");
      expect(materialized.channels.mattermost).toMatchObject(channelPolicy);
      expect(materialized.channels.mattermost.accounts["existing-coach"]).toEqual(account);
      expect(materialized.channels.mattermost.accounts["existing-coach"].threadSessionScope).toBe("channel");
      expect(applyPreBootPatches(materialized, { GATEWAY_CLASS: gatewayClass }, vi.fn())).toBe(false);
      expect(fs.readdirSync(dir)).toEqual(["openclaw.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomically replaces the config without leaving a partial file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preboot-config-"));
    const configPath = path.join(dir, "openclaw.json");
    try {
      fs.writeFileSync(configPath, "{\"old\":true}\n");
      writeConfigAtomically(configPath, { safe: true });

      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({ safe: true });
      expect(fs.readdirSync(dir)).toEqual(["openclaw.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applyPreBootPatches — platform model catalog", () => {
  it.each(["shared", "isolated"])("declares env-owned broker transports before %s startup without global credentials", (gatewayClass) => {
    const config: { models: { providers: Record<string, unknown> } } = { models: { providers: { "platform-openrouter": { apiKey: "foreign", models: [{ id: "foreign" }] } } } };
    applyPreBootPatches(config, { GATEWAY_CLASS: gatewayClass, OPENROUTER_BASE_URL: "https://broker.example/openrouter", PLATFORM_OPENAI_BASE_URL: "https://broker.example/openai" });
    expect(config.models.providers["platform-openrouter"]).toEqual({ baseUrl: "https://broker.example/openrouter", models: [] });
    expect(config.models.providers["platform-openai"]).toEqual({ baseUrl: "https://broker.example/openai", models: [] });
    expect(config.models.providers).not.toHaveProperty("platform-vertex");
  });

  it("allowlists every broker-backed platform model for an isolated gateway", () => {
    const config: any = { agents: { defaults: { models: {} } } };

    const changed = applyPreBootPatches(config, {
      GATEWAY_CLASS: "isolated",
      OPENROUTER_BASE_URL: "http://llm-broker/v1",
      PLATFORM_OPENAI_BASE_URL: "http://llm-broker/v1",
    });

    expect(changed).toBe(true);
    expect(config.agents.defaults.models).toMatchObject({
      "anthropic/claude-sonnet-4-6": {},
      "anthropic/claude-haiku-4-5": {},
      "platform-openrouter/z-ai/glm-5.2": {},
      "platform-openrouter/minimax/minimax-m3": {},
      "platform-openrouter/deepseek/deepseek-v4-pro": {},
      "platform-openrouter/openai/gpt-5.6-luna": {},
      "platform-openai/gpt-5.4-mini": {},
    });
    expect(config.agents.defaults.models).not.toHaveProperty("platform-vertex/claude-sonnet-5");
  });

  it.each([undefined, "http://llm-broker/v1"])("exposes Ember only on gateways with a Meta route (%s)", (baseUrl) => {
    const config = { agents: { defaults: { models: {} } } };
    applyPreBootPatches(config, { GATEWAY_CLASS: "shared", PLATFORM_META_BASE_URL: baseUrl });
    expect(Object.hasOwn(config.agents.defaults.models, "platform-meta/muse-ember-1.0")).toBe(Boolean(baseUrl));
  });

  it("declares the platform-vertex refs only when the pod carries the Vertex rail", () => {
    const config: any = { agents: { defaults: { models: {} } } };

    applyPreBootPatches(config, {
      GATEWAY_CLASS: "isolated",
      PLATFORM_VERTEX_BASE_URL: "http://llm-broker",
    });

    expect(config.agents.defaults.models).toMatchObject({
      "platform-vertex/claude-sonnet-5": {},
      "platform-vertex/claude-haiku-4-5": {},
    });
    expect(config.agents.defaults.models).not.toHaveProperty("platform-openai/gpt-5.4-mini");
    expect(platformBrokerCatalogOpts({ PLATFORM_VERTEX_BASE_URL: "http://llm-broker" }).vertex).toMatchObject({
      baseUrl: "http://llm-broker",
      models: expect.arrayContaining([expect.objectContaining({ model: "claude-haiku-4-5" })]),
    });
    expect(platformBrokerCatalogOpts({})).not.toHaveProperty("vertex");
  });
});

describe("applyOpenClawBeta5CompatibilityPatch", () => {
  it("migrates the root-owned Node SecretRef command to the node-owned resolver executable", () => {
    const config: any = {
      meta: { lastTouchedVersion: "2026.4.14", lastTouchedAt: "2026-04-17T01:04:39.966Z" },
      commands: { native: "auto", ownerDisplay: "raw" },
      secrets: {
        providers: {
          "gcp-secret-manager": {
            source: "exec",
            command: "/usr/local/bin/node",
            args: ["/octogee/scripts/secret-resolver.mjs"],
            passEnv: ["HOME"],
            jsonOnly: true,
            timeoutMs: 5000,
            allowInsecurePath: true,
          },
        },
      },
    };

    expect(applyOpenClawBeta5CompatibilityPatch(config)).toBe(true);
    expect(config).toEqual({
      meta: { lastTouchedVersion: "2026.4.14" },
      commands: { native: "auto" },
      secrets: {
        providers: {
          "gcp-secret-manager": {
            source: "exec",
            command: "/octogee/scripts/secret-resolver.mjs",
            passEnv: ["HOME"],
            jsonOnly: true,
            timeoutMs: 5000,
          },
        },
      },
    });
  });
});

describe("applyPreBootPatches — tools.profile (new)", () => {
  it("sets tools.profile=coding on a config with no tools field", () => {
    const config = emptyConfig();
    const changed = applyPreBootPatches(config, {});
    expect(config.tools).toEqual({ profile: "coding" });
    expect(changed).toBe(true);
  });

  it("sets tools.profile=coding when tools exists but profile is missing", () => {
    const config: any = { tools: { something: "else" } };
    applyPreBootPatches(config, {});
    expect(config.tools.profile).toBe("coding");
    expect(config.tools.something).toBe("else");
  });

  it("reconciles a drifted profile back to coding (gateway policy wins)", () => {
    const config: any = { tools: { profile: "research" } };
    const changed = applyPreBootPatches(config, {});
    expect(config.tools.profile).toBe("coding");
    expect(changed).toBe(true);
  });

  it("is idempotent: a config already at coding reports no change", () => {
    const config: any = { tools: { profile: "coding" } };
    applyPreBootPatches(config, {});
    const changed = applyPreBootPatches(config, {});
    expect(changed).toBe(false);
    expect(config.tools.profile).toBe("coding");
  });
});

describe("applyPreBootPatches — MM commands.native", () => {
  it("forces commands.native=false at the channel level when missing", () => {
    const config: any = { channels: { mattermost: {} } };
    const changed = applyPreBootPatches(config, {});
    expect(config.channels.mattermost.commands.native).toBe(false);
    expect(changed).toBe(true);
  });

  it("forces commands.native=false at the channel level when set to true", () => {
    const config: any = {
      channels: { mattermost: { commands: { native: true } } },
    };
    applyPreBootPatches(config, {});
    expect(config.channels.mattermost.commands.native).toBe(false);
  });

  it("forces commands.native=false on every per-account entry", () => {
    const config: any = {
      channels: {
        mattermost: {
          accounts: {
            default: { commands: { native: true } },
            secondary: { commands: { native: "auto" } },
            tertiary: {},
          },
        },
      },
    };
    applyPreBootPatches(config, {});
    expect(config.channels.mattermost.accounts.default.commands.native).toBe(false);
    expect(config.channels.mattermost.accounts.secondary.commands.native).toBe(false);
    expect(config.channels.mattermost.accounts.tertiary.commands.native).toBe(false);
  });

  it("does no MM work when channels.mattermost is absent", () => {
    const config: any = {};
    applyPreBootPatches(config, {});
    expect(config.channels).toBeUndefined();
  });
});

describe("applyPreBootPatches — MM env sync", () => {
  it("does not manufacture a permanent default Mattermost account", () => {
    const config: any = { channels: { mattermost: { accounts: {} } } };
    applyPreBootPatches(config, { MM_BOT_TOKEN: "legacy-token-must-not-be-used" });
    expect(config.channels.mattermost.accounts).toEqual({});
  });

  it("moves the platform endpoint into configured Mattermost accounts without replacing owner endpoints", () => {
    const config: any = { channels: { mattermost: {
      baseUrl: "${MM_URL}",
      accounts: { coach: {}, custom: { baseUrl: "${OWNER_MM_URL}" } },
    } } };
    applyMattermostPreBootPatches(config, { GATEWAY_CLASS: "isolated", MM_URL: "https://chat.example.com" }, vi.fn());
    expect(config.channels.mattermost).not.toHaveProperty("baseUrl");
    expect(config.channels.mattermost.accounts.coach.baseUrl).toBe("${MM_URL}");
    expect(config.channels.mattermost.accounts.custom.baseUrl).toBe("${OWNER_MM_URL}");
  });

  it("keeps a root bot token on the platform endpoint", () => {
    const config: any = { channels: { mattermost: {
      baseUrl: "https://attacker.example", botToken: "${OWNER_MM_TOKEN}",
    } } };
    applyMattermostPreBootPatches(config, { GATEWAY_CLASS: "isolated" }, vi.fn());
    expect(config.channels.mattermost).toMatchObject({
      baseUrl: "${MM_URL}", botToken: "${OWNER_MM_TOKEN}",
    });
  });

  it("does not turn a bare platform endpoint into an isolated gateway default account", () => {
    const config: any = { channels: { mattermost: { baseUrl: "${MM_URL}", accounts: {} } } };
    applyPreBootPatches(config, { GATEWAY_CLASS: "isolated", MM_URL: "https://chat.example.com" });
    expect(config.channels.mattermost).not.toHaveProperty("baseUrl");
    expect(config.channels.mattermost.accounts).toEqual({});
  });
});

describe("applyPreBootPatches — Mattermost runtime", () => {
  it.each([undefined, "steer", "collect", "followup", "interrupt"])("uses native Mattermost steering without changing other channel policy (%s)", (mattermostMode) => {
    const config: any = {
      channels: { mattermost: {
        replyToMode: "all", threadSessionScope: "channel",
        streaming: { mode: "progress", preview: { toolProgress: true }, progress: { toolProgress: true } },
        actions: { messages: true, messageWrites: true, fileDownloads: true, pins: true, search: true, memberInfo: true },
        reactionNotifications: "own",
        joinIntro: true,
        commands: { native: false },
      } },
      messages: { ackReactionScope: "all", queue: { mode: "steer", debounceMs: 250, byChannel: { slack: "collect", ...(mattermostMode ? { mattermost: mattermostMode } : {}) } } },
    };
    expect(applyMattermostPreBootPatches(config, {}, vi.fn())).toBe(mattermostMode !== "steer");
    expect(config.messages.queue).toEqual({ mode: "steer", debounceMs: 250, byChannel: { slack: "collect", mattermost: "steer" } });
    expect(applyMattermostPreBootPatches(config, {}, vi.fn())).toBe(false);
  });

  it("selects native Mattermost steering and ack reactions for an existing channel without message settings", () => {
    const config: any = { channels: { mattermost: { commands: { native: false } } } };
    expect(applyMattermostPreBootPatches(config, {}, vi.fn())).toBe(true);
    expect(config.messages).toEqual({ ackReactionScope: "all", queue: { byChannel: { mattermost: "steer" } } });
    expect(config.channels.mattermost.actions.messages).toBe(true);
  });

  it("keeps an explicit ack reaction scope", () => {
    const config: any = { channels: { mattermost: {} }, messages: { ackReactionScope: "off" } };
    applyMattermostPreBootPatches(config, {}, vi.fn());
    expect(config.messages.ackReactionScope).toBe("off");
  });

  it("enables Mattermost message actions, own-post reaction forwarding, and the join introduction when unset", () => {
    const config: any = { channels: { mattermost: { actions: { reactions: true, messages: true } } } };
    const log = vi.fn();
    expect(applyMattermostPreBootPatches(config, {}, log)).toBe(true);
    expect(config.channels.mattermost.actions).toEqual({
      reactions: true,
      messages: true,
      messageWrites: true,
      fileDownloads: true,
      pins: true,
      search: true,
      memberInfo: true,
    });
    expect(config.channels.mattermost.reactionNotifications).toBe("own");
    expect(config.channels.mattermost.joinIntro).toBe(true);
    for (const gate of ["messageWrites", "fileDownloads", "pins", "search", "memberInfo"]) {
      expect(log).toHaveBeenCalledWith(`set channels.mattermost.actions.${gate}=true`);
    }
    expect(log).toHaveBeenCalledWith("set channels.mattermost.reactionNotifications=own");
    expect(log).toHaveBeenCalledWith("set channels.mattermost.joinIntro=true");
    expect(applyMattermostPreBootPatches(config, {}, vi.fn())).toBe(false);
  });

  it("preserves explicit Mattermost write and download gates independently of messages", () => {
    const config: any = { channels: { mattermost: { actions: { messages: false, messageWrites: true, fileDownloads: false } } } };
    applyMattermostPreBootPatches(config, {}, vi.fn());
    expect(config.channels.mattermost.actions).toEqual({ messages: false, messageWrites: true, fileDownloads: false, pins: true, search: true, memberInfo: true });
    expect(applyMattermostPreBootPatches(config, {}, vi.fn())).toBe(false);
  });

  it.each([undefined, true, false])("inherits absent write and download gates from messages=%s", messages => {
    const config: any = { channels: { mattermost: { actions: { ...(messages === undefined ? {} : { messages }) } } } };
    applyMattermostPreBootPatches(config, {}, vi.fn());
    expect(config.channels.mattermost.actions).toMatchObject({
      messages: messages !== false,
      messageWrites: messages !== false,
      fileDownloads: messages !== false,
    });
    expect(applyMattermostPreBootPatches(config, {}, vi.fn())).toBe(false);
  });

  it("does not broaden explicit write or download refusals while messages are enabled", () => {
    const config: any = { channels: { mattermost: { actions: { messages: true, messageWrites: false, fileDownloads: false } } } };
    applyMattermostPreBootPatches(config, {}, vi.fn());
    expect(config.channels.mattermost.actions).toMatchObject({ messages: true, messageWrites: false, fileDownloads: false });
  });

  it.each([[true, false], [false, true]])("preserves account messages=%s against provider messages=%s", (accountMessages, providerMessages) => {
    const config: any = { channels: { mattermost: {
      actions: { messages: providerMessages },
      accounts: { coach: { actions: { messages: accountMessages } } },
    } } };
    applyMattermostPreBootPatches(config, {}, vi.fn());
    expect(config.channels.mattermost.actions).toMatchObject({ messageWrites: providerMessages, fileDownloads: providerMessages });
    expect(config.channels.mattermost.accounts.coach.actions).toEqual({ messages: accountMessages, messageWrites: accountMessages, fileDownloads: accountMessages });
    expect(applyMattermostPreBootPatches(config, {}, vi.fn())).toBe(false);
  });

  it("retains authored provider download refusal over an old account messages override", () => {
    const config: any = { channels: { mattermost: {
      actions: { messages: false, fileDownloads: false },
      accounts: { coach: { actions: { messages: true } } },
    } } };
    applyMattermostPreBootPatches(config, {}, vi.fn());
    const account = config.channels.mattermost.accounts.coach.actions;
    expect(account).toEqual({ messages: true, messageWrites: true });
    expect({ ...config.channels.mattermost.actions, ...account }).toMatchObject({ messageWrites: true, fileDownloads: false });
    expect(applyMattermostPreBootPatches(config, {}, vi.fn())).toBe(false);
  });

  it("retains an explicit account write refusal and download override", () => {
    const config: any = { channels: { mattermost: {
      actions: { messages: true, fileDownloads: false },
      accounts: { coach: { actions: { messages: true, messageWrites: false, fileDownloads: true } } },
    } } };
    applyMattermostPreBootPatches(config, {}, vi.fn());
    expect(config.channels.mattermost.accounts.coach.actions).toEqual({ messages: true, messageWrites: false, fileDownloads: true });
    expect(applyMattermostPreBootPatches(config, {}, vi.fn())).toBe(false);
  });

  it("keeps explicit Mattermost action gates, reaction notification, and join introduction choices", () => {
    const config: any = { channels: { mattermost: {
      actions: { messages: false, messageWrites: false, fileDownloads: false, pins: false, search: false, memberInfo: false },
      reactionNotifications: "all",
      joinIntro: false,
    } } };
    const log = vi.fn();
    applyMattermostPreBootPatches(config, {}, log);
    expect(config.channels.mattermost.actions).toEqual({
      messages: false,
      messageWrites: false,
      fileDownloads: false,
      pins: false,
      search: false,
      memberInfo: false,
    });
    expect(config.channels.mattermost.reactionNotifications).toBe("all");
    expect(config.channels.mattermost.joinIntro).toBe(false);
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("channels.mattermost.actions"));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("reactionNotifications"));
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("joinIntro"));
  });

  it("leaves native reply and streaming preferences untouched", () => {
    const config: any = {
      agents: { defaults: { verboseDefault: "off" } },
      channels: { mattermost: { replyToMode: "off", streaming: { mode: "partial" } } },
    };
    applyPreBootPatches(config, { MM_REPLY_TO_MODE: "all", MM_STREAMING_MODE: "progress" });
    expect(config.channels.mattermost).toMatchObject({ replyToMode: "off", streaming: { mode: "partial" } });
    expect(config.channels.mattermost.threadSessionScope).toBe("channel");
    expect(config.channels.mattermost).not.toHaveProperty("replyToModeByChatType");
    expect(config.agents.defaults.verboseDefault).toBe("off");
  });

  it("fills the configured reply and streaming modes without direct-message overrides", () => {
    const config: any = { channels: { mattermost: {} } };
    applyPreBootPatches(config, { MM_REPLY_TO_MODE: "off", MM_STREAMING_MODE: "partial" });
    expect(config.channels.mattermost.replyToMode).toBe("off");
    expect(config.channels.mattermost).not.toHaveProperty("replyToModeByChatType");
    expect(config.channels.mattermost.streaming).toEqual({
      mode: "partial",
      preview: { toolProgress: true },
      progress: { toolProgress: true },
    });
    expect(config.channels.mattermost.threadSessionScope).toBe("channel");
  });

  it("leaves the reply and streaming modes to OpenClaw when none is configured", () => {
    const config: any = { channels: { mattermost: {} } };
    applyPreBootPatches(config, {});
    expect(config.channels.mattermost).not.toHaveProperty("replyToMode");
    expect(config.channels.mattermost.streaming).toEqual({
      preview: { toolProgress: true },
      progress: { toolProgress: true },
    });
  });

  it.each([
    [{ MM_REPLY_TO_MODE: "thread" }, "MM_REPLY_TO_MODE"],
    [{ MM_STREAMING_MODE: "live" }, "MM_STREAMING_MODE"],
  ])("refuses a mode the Mattermost channel does not support (%o)", (env, name) => {
    const config: any = { channels: { mattermost: { replyToMode: "off", streaming: { mode: "partial" } } } };
    expect(() => applyMattermostPreBootPatches(config, env, vi.fn())).toThrow(name);
  });

  it("defaults inherited replies while preserving account and chat-type choices, idempotently", () => {
    const config: any = { channels: { mattermost: {
      replyToModeByChatType: { direct: "first", group: "off" },
      accounts: { inherited: {}, optedOut: { replyToMode: "off" }, first: { replyToMode: "first" } },
    } } };
    const log = vi.fn();
    const env = { MM_REPLY_TO_MODE: "first" };
    expect(applyMattermostPreBootPatches(config, env, log)).toBe(true);
    expect(config.channels.mattermost.replyToMode).toBe("first");
    expect(config.channels.mattermost.replyToModeByChatType).toEqual({ direct: "first", group: "off" });
    expect(config.channels.mattermost.accounts.inherited).not.toHaveProperty("replyToMode");
    expect(config.channels.mattermost.accounts.optedOut.replyToMode).toBe("off");
    expect(config.channels.mattermost.accounts.first.replyToMode).toBe("first");
    expect(log).toHaveBeenCalledWith("set channels.mattermost.replyToMode=first");
    expect(applyMattermostPreBootPatches(config, env, log)).toBe(false);
  });

  it.each(["shared", "isolated"])("fills missing streaming preferences on %s gateways without pinning account overrides", (gatewayClass) => {
    const config: any = { channels: { mattermost: {
      streaming: { chunkMode: "newline", preview: { commandText: "status" } },
      accounts: { inherited: {}, custom: { streaming: { mode: "off", preview: { toolProgress: false } } } },
    } } };
    const log = vi.fn();
    const env = { GATEWAY_CLASS: gatewayClass, MM_STREAMING_MODE: "partial" };
    expect(applyMattermostPreBootPatches(config, env, log)).toBe(true);
    expect(config.channels.mattermost.streaming).toEqual({
      mode: "partial",
      chunkMode: "newline",
      preview: { toolProgress: true, commandText: "status" },
      progress: { toolProgress: true },
    });
    expect(config.channels.mattermost.accounts.inherited).not.toHaveProperty("streaming");
    expect(config.channels.mattermost.accounts.custom.streaming).toEqual({ mode: "off", preview: { toolProgress: false } });
    expect(log).toHaveBeenCalledWith("set channels.mattermost.streaming.mode=partial");
    expect(log).toHaveBeenCalledWith("set channels.mattermost.streaming.progress.toolProgress=true");
    expect(log).toHaveBeenCalledWith("set channels.mattermost.streaming.preview.toolProgress=true");
    expect(applyMattermostPreBootPatches(config, env, log)).toBe(false);
  });

  it.each(["off", "partial", "progress", "block"])("preserves user streaming mode %s and disabled tool progress", (mode) => {
    const config: any = { channels: { mattermost: { streaming: { mode, preview: { toolProgress: false } } } } };
    applyMattermostPreBootPatches(config, { GATEWAY_CLASS: "isolated" }, vi.fn());
    expect(config.channels.mattermost.streaming).toEqual({ mode, preview: { toolProgress: false } });
    expect(applyMattermostPreBootPatches(config, { GATEWAY_CLASS: "isolated" }, vi.fn())).toBe(false);
  });

  it("removes unsupported fork settings while retaining native account policy and SecretRefs", () => {
    const token = { source: "file", provider: "octogee-mattermost", id: "/coach" };
    const config: any = { channels: { mattermost: {
      threadSessionScope: "channel", agentActivity: true, threadDirectMessages: true,
      accounts: { coach: { threadSessionScope: "thread", agentActivity: true, threadDirectMessages: true, replyToMode: "first", botToken: token } },
    } } };
    const log = vi.fn();
    expect(applyMattermostPreBootPatches(config, {}, log)).toBe(true);
    for (const field of ["agentActivity", "threadDirectMessages"]) {
      expect(config.channels.mattermost).not.toHaveProperty(field);
      expect(config.channels.mattermost.accounts.coach).not.toHaveProperty(field);
    }
    expect(config.channels.mattermost.accounts.coach).toMatchObject({ replyToMode: "first", botToken: token, threadSessionScope: "channel" });
    expect(log).toHaveBeenCalled();
    expect(applyMattermostPreBootPatches(config, {}, log)).toBe(false);
  });
});

describe("applyPreBootPatches — Anthropic broker base URL", () => {
  it("syncs ANTHROPIC_BASE_URL into the Anthropic model provider config", () => {
    const config: any = {
      auth: {
        profiles: {
          "anthropic:default": {
            provider: "anthropic",
            mode: "api_key",
          },
        },
      },
    };

    const changed = applyPreBootPatches(config, {
      ANTHROPIC_BASE_URL: "http://llm-broker.shared-test.svc.cluster.local:3010",
    });

    expect(changed).toBe(true);
    expect(config.auth.profiles["anthropic:default"]).toMatchObject({
      provider: "anthropic",
      mode: "api_key",
    });
    expect(config.auth.profiles["anthropic:default"].baseUrl).toBeUndefined();
    expect(config.models.providers.anthropic.baseUrl).toBe(
      "http://llm-broker.shared-test.svc.cluster.local:3010",
    );
  });

  it("removes stale auth-profile baseUrl because OpenClaw validates provider URLs under models.providers", () => {
    const config: any = {
      auth: {
        profiles: {
          "anthropic:default": {
            provider: "anthropic",
            mode: "api_key",
            baseUrl: "https://api.anthropic.com",
          },
        },
      },
    };

    const changed = applyPreBootPatches(config, {
      ANTHROPIC_BASE_URL: "http://llm-broker.shared-test.svc.cluster.local:3010",
    });

    expect(changed).toBe(true);
    expect(config.auth.profiles["anthropic:default"].baseUrl).toBeUndefined();
    expect(config.models.providers.anthropic.baseUrl).toBe(
      "http://llm-broker.shared-test.svc.cluster.local:3010",
    );
  });

  it("does not add Anthropic baseUrl when the broker env is absent", () => {
    const config: any = {
      auth: {
        profiles: {
          "anthropic:default": {
            provider: "anthropic",
            mode: "api_key",
          },
        },
      },
    };

    applyPreBootPatches(config, {});

    expect(config.auth.profiles["anthropic:default"].baseUrl).toBeUndefined();
    expect(config.models?.providers?.anthropic?.baseUrl).toBeUndefined();
  });

  it("preserves an existing non-object Anthropic provider entry", () => {
    const config: any = {
      auth: {
        profiles: {
          "anthropic:default": {
            provider: "anthropic",
            mode: "api_key",
          },
        },
      },
      models: { providers: { anthropic: "legacy-provider-shape" } },
    };

    const changed = applyAnthropicBaseUrlPatch(config, {
      ANTHROPIC_BASE_URL: "http://llm-broker.shared-test.svc.cluster.local:3010",
    }, () => {});

    expect(changed).toBe(false);
    expect(config.models.providers.anthropic).toBe("legacy-provider-shape");
  });
});

describe("applyPreBootPatches — user overlay", () => {
  it("wires the platform broker into a user config while leaving user-owned tools, routes, and plugins intact", () => {
    const config: any = {
      tools: {
        profile: "research",
        allow: ["read", "discord_send"],
        alsoAllow: ["discord_admin"],
      },
      agents: {
        defaults: {
          models: { "builder/provider-model": { label: "User model" } },
        },
        list: [{
          id: "discord-helper",
          tools: {
            profile: "research",
            allow: ["read", "discord_send"],
            alsoAllow: ["discord_admin"],
          },
        }],
      },
      bindings: [
        { agentId: "discord-helper", match: { channel: "mattermost", accountId: "*" } },
        { agentId: "discord-helper", match: { channel: "discord", accountId: "user-discord" } },
      ],
      channels: {
        discord: {
          accounts: {
            "user-discord": {
              tokenRef: { source: "exec", provider: "gcp-secret-manager", id: "byok-user-openai" },
              guildId: "user-guild",
            },
          },
        },
      },
      plugins: {
        allow: ["discord-bridge"],
        entries: {
          "discord-bridge": {
            enabled: true,
            config: { guildId: "user-guild", relayMentions: true },
          },
        },
      },
      models: {
        providers: {
          "user-provider": { baseUrl: "https://user.example/v1", keep: true },
        },
      },
    };
    const before = structuredClone(config);

    expect(applyPreBootPatches(config, {
      GATEWAY_CLASS: "isolated",
      OPENROUTER_BASE_URL: "http://llm-broker/v1",
      PLATFORM_OPENAI_BASE_URL: "http://llm-broker/v1",
      ANTHROPIC_BASE_URL: "http://llm-broker",
    })).toBe(true);

    expect(config.tools).toEqual(before.tools);
    expect(config.agents.list).toEqual(before.agents.list);
    expect(config.bindings).toEqual(before.bindings);
    expect(config.channels).toEqual(before.channels);
    expect(config.plugins).toEqual(before.plugins);
    expect(config.models.providers["user-provider"]).toEqual(before.models.providers["user-provider"]);
    expect(config.models.providers.anthropic.baseUrl).toBe("http://llm-broker");
    expect(config.agents.defaults.models).toMatchObject({
      "builder/provider-model": { label: "User model" },
      "anthropic/claude-sonnet-4-6": {},
    });
  });
});

describe("applyPreBootPatches — memory search embeddings", () => {
  it("moves legacy memorySearch into memory.search for stable and keyed rosters", () => {
    const stableSearch = { provider: "stable" };
    const keyedSearch = { provider: "keyed" };
    const config: any = {
      agents: {
        list: [{
          id: "octogee-stable-coach",
          memory: { citations: "auto" },
          memorySearch: stableSearch,
        }],
        entries: {
          "octogee-keyed-coach": {
            memorySearch: keyedSearch,
          },
        },
      },
    };

    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(true);
    expect(config.agents.list[0]).toEqual({
      id: "octogee-stable-coach",
      memory: { citations: "auto", search: stableSearch },
    });
    expect(config.agents.entries["octogee-keyed-coach"]).toEqual({
      memory: { search: keyedSearch },
    });
    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(false);
  });

  it("keeps canonical memory.search on collisions and ignores malformed legacy fields", () => {
    const legacySecretRef = {
      source: "exec",
      provider: "gcp-secret-manager",
      id: "agent-embedding-token-openai-octogee-collision-coach",
    };
    const config: any = {
      agents: {
        list: [
          {
            id: "octogee-collision-coach",
            memory: {
              search: {
                provider: "canonical",
                remote: {
                  baseUrl: "https://canonical.example/v1",
                  headers: { canonical: "yes" },
                },
              },
              citations: "auto",
            },
            memorySearch: {
              provider: "legacy",
              model: "legacy-model",
              remote: {
                baseUrl: "https://legacy.example/v1",
                apiKey: legacySecretRef,
                headers: { canonical: "no", legacy: "yes" },
              },
            },
          },
          {
            id: "octogee-malformed-legacy-coach",
            memorySearch: "legacy-string",
          },
          {
            id: "octogee-malformed-memory-coach",
            memory: "legacy-string",
            memorySearch: { provider: "legacy" },
          },
          null,
        ],
        entries: {
          malformed: "legacy-entry",
        },
      },
    };

    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(true);
    expect(config.agents.list[0]).toEqual({
      id: "octogee-collision-coach",
      memory: {
        search: {
          provider: "canonical",
          model: "legacy-model",
          remote: {
            baseUrl: "https://canonical.example/v1",
            apiKey: legacySecretRef,
            headers: { canonical: "yes", legacy: "yes" },
          },
        },
        citations: "auto",
      },
    });
    expect(config.agents.list[1].memorySearch).toBe("legacy-string");
    expect(config.agents.list[2]).toEqual({
      id: "octogee-malformed-memory-coach",
      memory: "legacy-string",
      memorySearch: { provider: "legacy" },
    });
    expect(config.agents.list[3]).toBeNull();
    expect(config.agents.entries.malformed).toBe("legacy-entry");
  });

  it("replaces malformed canonical memory.search with a clone of valid legacy config", () => {
    const legacySearch = {
      provider: "openai-compatible",
      remote: {
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-embedding-token-openai-octogee-malformed-coach",
        },
      },
    };
    const config: any = {
      agents: {
        entries: {
          "octogee-malformed-coach": {
            memory: { search: "malformed", citations: "auto" },
            memorySearch: legacySearch,
          },
        },
      },
    };

    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(true);
    const entry = config.agents.entries["octogee-malformed-coach"];
    expect(entry).toEqual({
      memory: { search: legacySearch, citations: "auto" },
    });
    expect(entry.memory.search).not.toBe(legacySearch);
    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(false);
  });

  it.each([
    ["absent", undefined],
    ["malformed", "malformed"],
  ])("recursively removes hostile keys when canonical memory.search is %s", (_label, search) => {
    const legacySearch = JSON.parse(`{
      "provider": "openai-compatible",
      "__proto__": { "polluted": "root" },
      "remote": {
        "apiKey": {
          "source": "exec",
          "provider": "gcp-secret-manager",
          "id": "agent-embedding-token-openai-octogee-hostile-coach"
        },
        "constructor": { "polluted": "nested" },
        "headers": {
          "safe": "yes",
          "prototype": { "polluted": "deep" }
        }
      },
      "sources": [{ "safe": true, "__proto__": { "polluted": "array" } }]
    }`);
    const entry: any = {
      ...(search === undefined ? {} : { memory: { search } }),
      memorySearch: legacySearch,
    };
    const config: any = { agents: { entries: { "octogee-hostile-coach": entry } } };

    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(true);

    const migrated = entry.memory.search;
    expect(migrated).not.toBe(legacySearch);
    expect(migrated.remote.apiKey.id).toBe(
      "agent-embedding-token-openai-octogee-hostile-coach",
    );
    expect(migrated.remote.headers.safe).toBe("yes");
    expect(migrated.sources[0].safe).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(migrated, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(migrated.remote, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(migrated.remote.headers, "prototype")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(migrated.sources[0], "__proto__")).toBe(false);
    expect(({} as any).polluted).toBeUndefined();
  });

  it("adds legacy fields without traversing an inherited canonical search property", () => {
    const inherited = { nested: { inherited: true } };
    const search = Object.create(inherited);
    const config = { agents: { entries: { "octogee-alice-coach": {
      memory: { search }, memorySearch: { nested: { migrated: true } },
    } } } };

    expect(applyMemorySearchSchemaPatch(config, vi.fn())).toBe(true);
    expect(Object.hasOwn(search, "nested")).toBe(true);
    expect(search.nested).toEqual({ migrated: true });
    expect(inherited.nested).toEqual({ inherited: true });
  });

  it("does not add memory search SecretRefs unless embeddings are enabled", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: { list: [{ id: "octogee-tester20-coach", name: "Gene" }] },
    };

    applyPreBootPatches(config, {});

    const defaultAgent = config.agents.list.find(
      (agent: any) => agent.id === "octogee-tester20-coach",
    );
    expect(defaultAgent.memorySearch).toBeUndefined();
    expect(defaultAgent.memory).toBeUndefined();
  });

  it("configures a keyed agent entry without reviving legacy memorySearch", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: {
        entries: {
          "octogee-keyed-coach": { name: "Keyed" },
        },
      },
    };

    expect(applyPreBootPatches(config, {
      GATEWAY_CLASS: "isolated",
      OPENAI_EMBEDDINGS_ENABLED: "true",
    })).toBe(true);
    expect(config.agents.entries["octogee-keyed-coach"].memory.search).toMatchObject({
      provider: "openai-compatible",
      model: "text-embedding-3-small",
    });
    expect(config.agents.entries["octogee-keyed-coach"].memorySearch).toBeUndefined();
  });

  it("configures agents with a platform OpenAI-compatible embedding SecretRef", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: {
        list: [
          { id: "octogee-tester20-coach", name: "Gene" },
          { id: "utility-agent", name: "Utility" },
          {
            id: "octogee-custom-coach",
            memorySearch: { enabled: false },
          },
        ],
      },
    };

    const changed = applyPreBootPatches(config, {
      GATEWAY_CLASS: "isolated",
      OPENAI_EMBEDDINGS_ENABLED: "true",
    });

    expect(changed).toBe(true);
    expect(config.agents.list[0].memory.search).toEqual({
      provider: "openai-compatible",
      remote: {
        baseUrl: "http://llm-broker:3010/v1",
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-embedding-token-openai-octogee-tester20-coach",
        },
      },
      model: "text-embedding-3-small",
    });
    expect(config.agents.list[1].memorySearch).toBeUndefined();
    expect(config.agents.list[2]).toMatchObject({ memory: { search: { enabled: false } } });
    expect(config.agents.list[2].memorySearch).toBeUndefined();
  });

  it("uses operator-selected embedding endpoint and model when provided", () => {
    const config: any = {
      tools: { profile: "coding" },
      agents: { list: [{ id: "octogee-tester20-coach" }] },
    };

    applyPreBootPatches(config, {
      GATEWAY_CLASS: "isolated",
      OPENAI_EMBEDDINGS_ENABLED: "true",
      PLATFORM_OPENAI_BASE_URL: "https://llm-broker.internal.example/v1/",
      OPENAI_EMBEDDINGS_MODEL: "custom-embed-v1",
    });

    expect(config.agents.list[0].memory.search.remote.baseUrl).toBe(
      "https://llm-broker.internal.example/v1",
    );
    expect(config.agents.list[0].memory.search.model).toBe("custom-embed-v1");
  });
});

describe("applyMattermostPreBootPatches — non-object preservation", () => {
  it("does not replace existing non-object account or commands values", () => {
    const config: any = {
      messages: { ackReactionScope: "all", queue: { byChannel: { mattermost: "steer" } } },
      channels: {
        mattermost: {
          replyToMode: "all",
          replyToModeByChatType: { direct: "all" },
          streaming: { mode: "progress", preview: { toolProgress: true }, progress: { toolProgress: true } },
          actions: { reactions: true, messages: true, messageWrites: true, fileDownloads: true, pins: true, search: true, memberInfo: true },
          reactionNotifications: "own",
          joinIntro: true,
          commands: "legacy-commands",
          threadSessionScope: "channel",
          accounts: {
            default: "legacy-default",
            coach: { commands: "legacy-account-commands", threadSessionScope: "channel" },
          },
        },
      },
    };

    const changed = applyMattermostPreBootPatches(config, {
      MM_URL: "https://mm.example",
    }, () => {});

    expect(changed).toBe(false);
    expect(config.channels.mattermost.commands).toBe("legacy-commands");
    expect(config.channels.mattermost.accounts.default).toBe("legacy-default");
    expect(config.channels.mattermost.accounts.coach.commands).toBe("legacy-account-commands");
  });
});

describe("shouldMaterializeAnthropicBrokerProfiles", () => {
  it.each(["shared", "isolated"])(
    "materializes per-agent broker-token profiles for %s gateways",
    (gatewayClass) => {
      expect(shouldMaterializeAnthropicBrokerProfiles({ GATEWAY_CLASS: gatewayClass })).toBe(true);
    },
  );

  it("rejects the retired operator class and profile", () => {
    expect(shouldMaterializeAnthropicBrokerProfiles({ GATEWAY_CLASS: "operator" })).toBe(false);
    expect(shouldMaterializeAnthropicBrokerProfiles({ GATEWAY_PROFILE: "operator" })).toBe(false);
  });

  it("skips unknown classes", () => {
    expect(shouldMaterializeAnthropicBrokerProfiles({ GATEWAY_CLASS: "preview" })).toBe(false);
  });
});

describe("materializeBrokerProfilesBeforeBoot", () => {
  const config = { agents: { list: [{ id: "octogee-alice-coach" }, { id: "octogee-alice-proj-orbit-coach" }] } };
  const sweepResult = { materialized: 2, deferred: [] };

  it("applies broker profiles for every configured agent before a Shared gateway boots", async () => {
    const sweep = vi.fn(async () => sweepResult);

    await materializeBrokerProfilesBeforeBoot(config, { GATEWAY_CLASS: "shared" }, sweep, vi.fn());

    expect(sweep).toHaveBeenCalledExactlyOnceWith(["octogee-alice-coach", "octogee-alice-proj-orbit-coach"]);
  });

  it("leaves an isolated gateway's broker profiles to the post-boot sweep", async () => {
    const sweep = vi.fn(async () => sweepResult);
    const log = vi.fn();

    await materializeBrokerProfilesBeforeBoot(config, { GATEWAY_CLASS: "isolated" }, sweep, log);

    expect(sweep).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("post-boot sweep"));
  });

  it("skips gateways that hold no broker profiles", async () => {
    const sweep = vi.fn(async () => sweepResult);

    await materializeBrokerProfilesBeforeBoot(config, { GATEWAY_CLASS: "preview" }, sweep, vi.fn());

    expect(sweep).not.toHaveBeenCalled();
  });
});

describe("applyPreBootPatches — plugin config", () => {
  it("does not mutate plugin allowlists through retired router env switches", () => {
    const config: any = {
      plugins: {
        allow: ["codex", "other-plugin"],
        entries: { codex: { enabled: false }, "other-plugin": {} },
      },
    };
    applyPreBootPatches(config, { OCTOGEE_UNKNOWN_PLUGIN_FLAG: "false" });
    expect(config.plugins.allow).toEqual(["codex", "other-plugin"]);
    expect(config.plugins.entries.codex).toEqual({ enabled: false });
    expect(config.plugins.entries["other-plugin"]).toBeDefined();
  });

  it("is a no-op when there are no plugin entries", () => {
    const config: any = { plugins: { entries: {} } };
    applyPreBootPatches(config, {});
    expect(config.plugins.entries).toEqual({});
  });
});

describe("applyPreBootPatches — no-change reporting", () => {
  it("returns false when nothing in the config needs touching", () => {
    const config: any = {
      messages: { ackReactionScope: "all", queue: { byChannel: { mattermost: "steer" } } },
      agents: {
        defaults: {
          models: Object.fromEntries(modelCatalogForProvider("anthropic").map(({ id }) => [id, {}])),
          verboseDefault: "off",
          typingMode: "instant",
          toolProgressDetail: "raw",
          skipOptionalBootstrapFiles: ["IDENTITY.md"],
        },
      },
      tools: { profile: "coding" },
      channels: {
        mattermost: {
          chatmode: "onmessage",
          threadSessionScope: "channel",
          requireMention: false,
          replyToMode: "all",
          replyToModeByChatType: { direct: "all" },
          actions: { reactions: true, messages: true, messageWrites: true, fileDownloads: true, pins: true, search: true, memberInfo: true },
          reactionNotifications: "own",
          joinIntro: true,
          streaming: {
            mode: "progress",
            chunkMode: "newline",
            block: { enabled: true },
            preview: {
              toolProgress: true,
              commandText: "raw",
            },
            progress: { toolProgress: true },
          },
          commands: { native: false },
          accounts: {
            "ceckert-coach": {
              threadSessionScope: "channel",
              botToken: { source: "file", provider: "octogee-mattermost", id: "/ceckert-coach" },
              commands: { native: false },
            },
          },
        },
      },
      plugins: { entries: {} },
      approvals: { plugin: { enabled: true, mode: "session" } },
    };
    applyAgentStoreDatabasePatch(config, { GATEWAY_CLASS: "isolated" });
    const changed = applyPreBootPatches(config, {
      GATEWAY_CLASS: "isolated",
      MM_URL: "https://mm.example",
    });
    expect(changed).toBe(false);
  });
});

describe("slugFromManagedAgentId", () => {
  it("extracts the workspace slug from a canonical agent id", () => {
    expect(slugFromManagedAgentId("octogee-ceckert-coach")).toBe("ceckert");
  });

  it("returns null for non-default agent ids (ops/tools/etc.)", () => {
    expect(slugFromManagedAgentId("octogee-ops-something")).toBeNull();
    expect(slugFromManagedAgentId("random")).toBeNull();
    expect(slugFromManagedAgentId("")).toBeNull();
  });

  it("preserves kebab-case slugs (the hyphen is part of the slug, not a delimiter)", () => {
    expect(slugFromManagedAgentId("octogee-my-builder-coach")).toBe("my-builder");
  });
});

describe("pickSoleTenantSlug", () => {
  it("returns the unique slug when one agent is present", () => {
    expect(pickSoleTenantSlug(["octogee-ceckert-coach"])).toBe("ceckert");
  });

  it("returns null when multiple distinct tenants are mounted (multi-tenant cattle)", () => {
    expect(pickSoleTenantSlug(["octogee-ceckert-coach", "octogee-walter-coach"]))
      .toBeNull();
  });

  it("returns null when no agents are present (fresh gateway, ops-only)", () => {
    expect(pickSoleTenantSlug([])).toBeNull();
    expect(pickSoleTenantSlug(["octogee-ops-tools"])).toBeNull();
  });

  it("treats duplicate ids for the same tenant as a single tenant", () => {
    expect(pickSoleTenantSlug(["octogee-ceckert-coach", "octogee-ceckert-coach"]))
      .toBe("ceckert");
  });
});

describe("buildGitconfigContent — first-boot seed shape", () => {
  it("emits [user] section with the given name and email", () => {
    const out = buildGitconfigContent({ name: "Ada Lovelace", email: "c@example.test" });
    expect(out).toContain("[user]");
    expect(out).toMatch(/name = Ada Lovelace/);
    expect(out).toMatch(/email = c@example\.test/);
  });

  it("emits [push] autoSetupRemote = true (the manual `git config` line we want to delete from the operator runbook)", () => {
    const out = buildGitconfigContent({ name: "X", email: "y@example.test" });
    expect(out).toMatch(/\[push\]\s*\n\s*autoSetupRemote = true/);
  });

  it("emits [init] defaultBranch = main", () => {
    const out = buildGitconfigContent({ name: "X", email: "y@example.test" });
    expect(out).toMatch(/\[init\]\s*\n\s*defaultBranch = main/);
  });

  it("includes a first-boot comment header so operators know editing it is safe", () => {
    const out = buildGitconfigContent({ name: "X", email: "Y" });
    expect(out).toMatch(/^#.*first-boot/im);
  });
});

describe("hydrateGitIdentity — always produces a working gitconfig, never blocks boot", () => {
  const baseDeps = (overrides: Record<string, unknown> = {}) => ({
    gitconfigPath: "/home/node/.gitconfig",
    agentIds: [] as readonly string[],
    fileExists: () => false,
    writeFile: vi.fn(),
    logFn: vi.fn(),
    ...overrides,
  });

  it("writes the slug-derived identity for a single-tenant gateway", () => {
    const writeFile = vi.fn();
    const changed = hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      writeFile,
    }));
    expect(changed).toBe(true);
    expect(writeFile).toHaveBeenCalledOnce();
    const [p, content] = writeFile.mock.calls[0];
    expect(p).toBe("/home/node/.gitconfig");
    expect(content).toMatch(/name = ceckert/);
    expect(content).toMatch(/email = ceckert@users\.noreply\.octogee\.com/);
  });

  it("writes generic identity for multi-tenant cattle (git still works; per-agent isolation is Phase 2)", () => {
    const writeFile = vi.fn();
    const changed = hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach", "octogee-walter-coach"],
      writeFile,
    }));
    expect(changed).toBe(true);
    const content = writeFile.mock.calls[0][1];
    expect(content).toMatch(/name = Octogee Builder/);
    expect(content).toMatch(/email = .*@users\.noreply\.octogee\.com/);
  });

  it("writes generic identity for fresh gateway with no agents mounted yet", () => {
    const writeFile = vi.fn();
    const changed = hydrateGitIdentity(baseDeps({
      agentIds: [],
      writeFile,
    }));
    expect(changed).toBe(true);
    expect(writeFile.mock.calls[0][1]).toMatch(/Octogee Builder/);
  });

  it("idempotent: existing ~/.gitconfig is preserved (operator customizations win)", () => {
    const writeFile = vi.fn();
    const changed = hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      fileExists: () => true,
      writeFile,
    }));
    expect(changed).toBe(false);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("never throws even when writeFile itself fails (disk full / readonly fs)", () => {
    const writeFile = vi.fn(() => { throw new Error("ENOSPC: disk full"); });
    const logFn = vi.fn();
    const changed = hydrateGitIdentity(baseDeps({
      agentIds: [],
      writeFile,
      logFn,
    }));
    expect(changed).toBe(false);
    expect(logFn.mock.calls.flat().join(" ")).toMatch(/disk full/i);
  });

  it("never throws when fileExists itself throws (treats failure as absent + proceeds)", () => {
    const writeFile = vi.fn();
    const logFn = vi.fn();
    const changed = hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ceckert-coach"],
      fileExists: () => { throw new Error("EACCES: permission denied"); },
      writeFile,
      logFn,
    }));
    expect(changed).toBe(true);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(logFn.mock.calls.flat().join(" ")).toMatch(/fileExists.*threw/i);
  });

  it("strips control characters from the slug-derived identity", () => {
    const writeFile = vi.fn();
    hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-ce\tck\u0000ert-coach"],
      writeFile,
    }));
    const content = writeFile.mock.calls[0][1] as string;
    expect(content).toContain("\tname = ceckert\n");
    expect(content).toContain("\temail = ceckert@users.noreply.octogee.com\n");
  });

  it("writes generic identity when cleaning empties the slug", () => {
    const writeFile = vi.fn();
    hydrateGitIdentity(baseDeps({
      agentIds: ["octogee-\t \u0000-coach"],
      writeFile,
    }));
    const content = writeFile.mock.calls[0][1] as string;
    expect(content).toMatch(/name = Octogee Builder/);
    expect(content).toMatch(/email = builder@users\.noreply\.octogee\.com/);
  });
});

describe("applyTypingModeDefault — typing starts when the message arrives", () => {
  it("sets agents.defaults.typingMode to instant on a config that never chose one", () => {
    const config: any = { agents: { defaults: { verboseDefault: "on" } } };
    const log = vi.fn();
    expect(applyTypingModeDefault(config, log)).toBe(true);
    expect(config.agents.defaults.typingMode).toBe("instant");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("agents.defaults.typingMode"));
    expect(applyTypingModeDefault(config, vi.fn())).toBe(false);
  });

  it("creates agents.defaults when the config has none", () => {
    const config: any = {};
    expect(applyTypingModeDefault(config, vi.fn())).toBe(true);
    expect(config.agents.defaults.typingMode).toBe("instant");
  });

  it("keeps a typing mode the config already chose", () => {
    const config: any = { agents: { defaults: { typingMode: "never" } } };
    expect(applyTypingModeDefault(config, vi.fn())).toBe(false);
    expect(config.agents.defaults.typingMode).toBe("never");
  });

  it("runs as part of the pre-boot patch set on every gateway class", () => {
    for (const env of [{}, { GATEWAY_CLASS: "isolated" }]) {
      const config: any = { agents: { defaults: {} } };
      expect(applyPreBootPatches(config, env)).toBe(true);
      expect(config.agents.defaults.typingMode).toBe("instant");
    }
  });
});

describe("applyVerboseDefault — native tool summaries stay out of chat", () => {
  it("converges agents.defaults.verboseDefault to off from a durable config that still says on", () => {
    const config: any = { agents: { defaults: { verboseDefault: "on" } } };
    const log = vi.fn();
    expect(applyVerboseDefault(config, log)).toBe(true);
    expect(config.agents.defaults.verboseDefault).toBe("off");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("agents.defaults.verboseDefault"));
    expect(applyVerboseDefault(config, vi.fn())).toBe(false);
  });

  it("creates agents.defaults when the config has none", () => {
    const config: any = {};
    expect(applyVerboseDefault(config, vi.fn())).toBe(true);
    expect(config.agents.defaults.verboseDefault).toBe("off");
  });

  it("runs as part of the pre-boot patch set on every gateway class", () => {
    for (const env of [{}, { GATEWAY_CLASS: "shared" }, { GATEWAY_CLASS: "isolated" }]) {
      const config: any = { agents: { defaults: { verboseDefault: "full" } } };
      expect(applyPreBootPatches(config, env)).toBe(true);
      expect(config.agents.defaults.verboseDefault).toBe("off");
    }
  });
});

const AGENT_STORE_POSTGRES = { schemaPrefix: "octogee", connection: { source: "env", provider: "default", id: "OPENCLAW_AGENT_STORE_DSN" } };

it.each([
  { GATEWAY_CLASS: "shared" },
  { GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "cluster" },
  { GATEWAY_CLASS: "isolated", GATEWAY_RUNTIME_KIND: "gce-vm" },
])("selects PostgreSQL for every supported family on %o", env => {
  const config: any = { database: { engine: "postgres", families: Object.fromEntries(
    ["state", "agent", "workboard", "logbook", "team-reports"].map(family => [family, { engine: "postgres" }]),
  ) } };
  expect(applyAgentStoreDatabasePatch(config, env, "absent")).toBe(true);
  expect(config.database).toEqual({ engine: "postgres", postgres: AGENT_STORE_POSTGRES });
  expect(applyAgentStoreDatabasePatch(config, env, "anchor")).toBe(false);
});

it.each(["shared", "isolated"])("refuses retained %s SQLite before changing engine selectors", gatewayClass => {
  const config: any = { database: { engine: "sqlite", families: { agent: { engine: "postgres" } } } };
  const original = structuredClone(config);
  expect(() => applyAgentStoreDatabasePatch(config, { GATEWAY_CLASS: gatewayClass }, "sqlite"))
    .toThrow("openclaw database port --family state --to postgres");
  expect(config).toEqual(original);
});

it("passes the observed local state through the pre-boot patch set", () => {
  const config: any = {};
  expect(() => applyPreBootPatches(config, { GATEWAY_CLASS: "isolated" }, () => {}, { stateStore: "sqlite" }))
    .toThrow("Keep the Gateway stopped");
  expect(config).toEqual({});
});

it("does not flip an existing PostgreSQL host's remaining SQLite families", () => {
  const config: any = { database: { engine: "postgres", families: { workboard: { engine: "sqlite" } }, postgres: AGENT_STORE_POSTGRES } };
  const original = structuredClone(config);
  expect(() => applyAgentStoreDatabasePatch(config, { GATEWAY_CLASS: "isolated" }, "anchor"))
    .toThrow("database port --family workboard --to postgres");
  expect(config).toEqual(original);
});

it.each(["state", "agent", "workboard", "logbook", "team-reports"])("refuses configured SQLite %s even when GLOBAL is absent", family => {
  const config: any = { database: { engine: "postgres", families: { [family]: { engine: "sqlite" } } } };
  const original = structuredClone(config);
  expect(() => applyAgentStoreDatabasePatch(config, { GATEWAY_CLASS: "shared" }, "absent"))
    .toThrow(`database port --family ${family} --to postgres`);
  expect(config).toEqual(original);
});

it.each(["shared", "isolated"])("defaults a fresh %s config to PostgreSQL", gatewayClass => {
  const config: any = {};
  expect(applyAgentStoreDatabasePatch(config, { GATEWAY_CLASS: gatewayClass }, "absent")).toBe(true);
  expect(config.database).toEqual({ engine: "postgres", postgres: AGENT_STORE_POSTGRES });
});
