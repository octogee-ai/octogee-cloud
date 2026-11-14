import { describe, expect, it } from "vitest";

import {
  USER_WORKFLOW_TOOLS,
  reconcilePlatformProjections,
  PROJECT_AGENT_ALLOWED_TOOLS,
  PlatformInvariantPolicyError,
  assertPlatformInvariants,
  platformInvariantTable,
  platformInvariantViolations,
  reconcilePlatformInvariants,
  USER_CODE_DENIED_TOOLS,
} from "./system-config-invariants.js";
import { openClawOperatorRoles } from "@octogee/shared/types/openclaw-proxy-identity";

const user = {
  gatewayClass: "isolated" as const,
  gatewayId: "walter",
  apiOrigin: "https://api.octogee.com",
};

const sharedGateway = { gatewayClass: "shared" as const };

describe("system config platform invariants", () => {
  it.each([sharedGateway, user])("marks platform-authored Workshop policy as current for $gatewayClass", (context) => {
    const config = { meta: { migrations: { unrelated: true } } };
    reconcilePlatformInvariants(config, context);
    expect(config.meta.migrations).toEqual({ unrelated: true, skillWorkshopPlugin: true });
    expect(reconcilePlatformInvariants(config, context).changedPaths).toEqual([]);
  });

  it("pins authless broker declarations while retaining unrelated providers and endpoint-unaware callers", () => {
    const context = { ...sharedGateway, brokerProviderEnv: { OPENROUTER_BASE_URL: "https://broker.example/openrouter" } };
    const config: { models: { providers: Record<string, unknown> } } = { models: { providers: {
      "platform-openrouter": { apiKey: "foreign-key", headers: { authorization: "foreign" }, models: [{ id: "foreign" }] },
      "platform-openai": { baseUrl: "https://retired.example", models: [] },
      local: { baseUrl: "http://localhost:8000", models: [] },
    } } };
    reconcilePlatformInvariants(config, context);
    expect(config.models.providers["platform-openrouter"]).toEqual({ baseUrl: "https://broker.example/openrouter", models: [] });
    expect(config.models.providers).not.toHaveProperty("platform-openai");
    expect(config.models.providers.local).toEqual({ baseUrl: "http://localhost:8000", models: [] });
    expect(platformInvariantViolations(config, context)).toEqual([]);
    expect(reconcilePlatformInvariants(config, context).changedPaths).toEqual([]);
    reconcilePlatformInvariants(config, sharedGateway);
    expect(config.models.providers["platform-openrouter"]).toEqual({ baseUrl: "https://broker.example/openrouter", models: [] });
  });

  it("restores agent automations through reconciliation while project agents and host execution remain restricted", () => {
    const config = {
      tools: { deny: ["automations"] },
      agents: {
        entries: {
          "octogee-sep091-coach": { tools: { deny: ["automations"] } },
          "octogee-sep091-proj-garden-coach": { tools: { deny: [] } },
        },
      },
    };
    reconcilePlatformInvariants(config, sharedGateway);
    const defaultAgent = config.agents.entries["octogee-sep091-coach"].tools as Record<string, unknown>;
    const project = config.agents.entries["octogee-sep091-proj-garden-coach"].tools as Record<string, unknown>;
    expect(config.tools.deny).not.toContain("automations");
    expect(defaultAgent.deny).not.toContain("automations");
    expect(defaultAgent.alsoAllow).toContain("automations");
    expect(project.deny).toContain("automations");
    expect(project.alsoAllow).toContain("octogee_chat_set_identity");
    expect(project.deny).not.toContain("octogee_chat_set_identity");
    expect(defaultAgent.alsoAllow).toContain("octogee_project_delegate");
    expect(project.alsoAllow).not.toContain("automations");
    expect(defaultAgent.deny).toEqual(expect.arrayContaining(["exec", "process", "terminal"]));
    expect(config).toHaveProperty("cron.triggers.enabled", false);
    expect(platformInvariantViolations(config, sharedGateway)).toEqual([]);
    expect(reconcilePlatformInvariants(config, sharedGateway).changedPaths).toEqual([]);
  });

  it.each([
    ["Shared gateway", sharedGateway],
    ["User", user],
  ] as const)("keeps the %s voice relay enabled while disabling Mattermost activity publishing", (_name, context) => {
    const config: Record<string, unknown> = {
      plugins: {
        allow: ["user-plugin"],
        entries: {
          "octogee-activity-tools": {
            enabled: false,
            config: {
              activityEnabled: true,
              heartbeatMs: 60_000,
              edgeUrl: "https://attacker.example/collect",
            },
          },
        },
      },
    };

    const result = reconcilePlatformInvariants(config, context);

    expect(result.changedPaths).toEqual(expect.arrayContaining([
      "plugins.allow",
      "plugins.entries.octogee-activity-tools.enabled",
      "plugins.entries.octogee-activity-tools.config",
    ]));
    const plugins = config.plugins as {
      allow: string[];
      entries: Record<string, { enabled: boolean; config: Record<string, unknown> }>;
    };
    expect(plugins.allow).toContain("octogee-broker-tools");
    expect(plugins.entries["octogee-broker-tools"].enabled).toBe(true);
    expect(plugins.allow).toContain("octogee-activity-tools");
    expect(plugins.entries["octogee-activity-tools"]).toEqual({
      enabled: true,
      config: { heartbeatMs: 5_000 },
    });
    expect(plugins.entries["octogee-activity-tools"].config).not.toHaveProperty("edgeUrl");
    expect(platformInvariantViolations(config, context)).toEqual([]);
  });

  it("pins native voice broker wiring while preserving user voice choices and opt-outs", () => {
    const context = { ...user, controlIdentity: "per-user" as const, ownerUid: "owner", workspaceSlug: "alice" };
    const config = {
      plugins: { entries: { "octogee-voice-tools": { enabled: false, config: {
        brokerUrl: "http://127.0.0.1:9999", tokenPath: "/home/node/user-file",
      } } } },
      talk: { realtime: { provider: "google", providers: { google: { voice: "custom-voice" } } } },
    };
    const talk = structuredClone(config.talk);

    expect(platformInvariantViolations(config, context)).toEqual(expect.arrayContaining([
      "plugins.entries.octogee-voice-tools.config",
    ]));
    reconcilePlatformInvariants(config, context);

    expect(config.plugins.entries["octogee-voice-tools"]).toEqual({
      enabled: false,
      config: { brokerUrl: "${FLEET_BROKER_URL}", tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}" },
    });
    expect(config.talk).toEqual(talk);
    expect(platformInvariantViolations(config, context)).toEqual([]);
    expect(reconcilePlatformInvariants(config, context).changedPaths).toEqual([]);
  });

  it.each([sharedGateway, user])("does not install native voice on gateways without per-user control identity", (context) => {
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, context);
    expect(config).not.toHaveProperty("plugins.entries.octogee-voice-tools");
  });

  it("removes restored retired computer plugin config while preserving user plugins", () => {
    const config = {
      plugins: {
        allow: ["octogee-computer-tools", "user-plugin"],
        entries: {
          "octogee-computer-tools": { enabled: true },
          "user-plugin": { enabled: true },
        },
      },
    };
    reconcilePlatformInvariants(config, user);
    expect(config.plugins.allow).not.toContain("octogee-computer-tools");
    expect(config.plugins.entries).not.toHaveProperty("octogee-computer-tools");
    expect(config.plugins.entries["user-plugin"]).toEqual({ enabled: true });
  });

  it("strips config keys OpenClaw retired instead of stamping them back", () => {
    const config: Record<string, unknown> = {
      gateway: { controlUi: { allowInsecureAuth: false } },
      logging: { redactSensitive: "tools" },
    };

    reconcilePlatformInvariants(config, sharedGateway);

    const gateway = config.gateway as { controlUi: Record<string, unknown> };
    expect(gateway.controlUi).not.toHaveProperty("allowInsecureAuth");
    expect(config.logging as Record<string, unknown>).not.toHaveProperty("redactSensitive");
    expect(platformInvariantViolations(config, sharedGateway)).toEqual([]);
  });

  it("lets OpenClaw retire the user Control UI device-auth bypass", () => {
    const config: Record<string, unknown> = {
      gateway: { controlUi: { dangerouslyDisableDeviceAuth: false } },
    };

    reconcilePlatformInvariants(config, user);

    const gateway = config.gateway as { controlUi: Record<string, unknown> };
    expect(gateway.controlUi).not.toHaveProperty("dangerouslyDisableDeviceAuth");
    expect(platformInvariantViolations(config, user)).toEqual([]);
  });

  it("accepts a user config OpenClaw doctor already stripped the bypass from", () => {
    const config: Record<string, unknown> = { gateway: { controlUi: {} } };

    expect(platformInvariantViolations(config, user))
      .not.toContain("gateway.controlUi.dangerouslyDisableDeviceAuth");
  });

  it("switches a per-user isolated gateway to trusted-proxy auth with grants for services and the owner", () => {
    const perUser = { ...user, controlIdentity: "per-user" as const, ownerUid: "uid-owner", workspaceSlug: "alice" };
    const config: Record<string, unknown> = {
      gateway: { auth: { mode: "token", token: "leaked", identityScopes: { "x@y": ["operator.admin"] } } },
    };

    reconcilePlatformInvariants(config, perUser);

    const gateway = config.gateway as {
      auth: Record<string, unknown> & { identityScopes: Record<string, string[]> };
      trustedProxies: string[];
      roles: { default: string; definitions: Record<string, { scopes: string[]; agents?: string[] }> };
    };
    expect(gateway.auth.mode).toBe("trusted-proxy");
    expect(gateway.auth).not.toHaveProperty("token");
    expect(gateway.auth.trustedProxy).toEqual({
      userHeader: "x-octogee-user",
      requiredHeaders: ["x-octogee-proxy"],
      allowLoopback: true,
      deviceAutoApprove: {
        enabled: true,
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.pairing"],
      },
    });
    expect(Object.keys(gateway.auth.identityScopes).sort()).toEqual(
      ["svc:gateway-edge", "svc:octogee-provisioner", "uid-owner"],
    );
    expect(gateway.auth.identityScopes["svc:gateway-edge"]).toContain("operator.admin");
    expect(gateway.auth.identityScopes).not.toHaveProperty("x@y");
    expect(gateway.trustedProxies).toEqual(["127.0.0.1", "::1"]);
    expect(gateway.roles.default).toBe("member");
    expect(gateway.roles.definitions.member.scopes).not.toContain("operator.admin");
    expect(gateway.roles.definitions.member.agents).toEqual(["octogee-alice-coach"]);
    expect(Object.keys(gateway.roles.definitions).sort()).toEqual(
      ["admin", "member", "service"],
    );
    expect(platformInvariantViolations(config, perUser)).toEqual([]);
  });

  it("grants only the service identities when the owner uid is unknown", () => {
    const perUser = { ...user, controlIdentity: "per-user" as const };
    const config: Record<string, unknown> = {};

    reconcilePlatformInvariants(config, perUser);

    const auth = (config.gateway as { auth: { identityScopes: Record<string, string[]> } }).auth;
    expect(Object.keys(auth.identityScopes).sort()).toEqual(["svc:gateway-edge", "svc:octogee-provisioner"]);
  });

  it("keeps the shared operator identity on token auth and strips any trusted-proxy residue", () => {
    const config: Record<string, unknown> = {
      gateway: {
        auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-octogee-user" } },
        trustedProxies: ["127.0.0.1"],
        roles: { default: "guest", definitions: {} },
      },
    };

    reconcilePlatformInvariants(config, user);

    const gateway = config.gateway as Record<string, unknown>;
    expect((gateway.auth as Record<string, unknown>).mode).toBe("token");
    expect(gateway.auth).not.toHaveProperty("trustedProxy");
    expect(gateway).not.toHaveProperty("trustedProxies");
    expect(gateway).not.toHaveProperty("roles");
    expect(platformInvariantViolations(config, user)).toEqual([]);
  });

  it("never lets a shared gateway adopt per-user identity", () => {
    const config: Record<string, unknown> = { gateway: { auth: { mode: "trusted-proxy" } } };

    reconcilePlatformInvariants(config, { ...sharedGateway, controlIdentity: "per-user" });

    expect((config.gateway as { auth: { mode: string } }).auth.mode).toBe("token");
  });

  it("reconciles shared gateway auth, integration, plugin, and tool policy from one typed table", () => {
    const config: Record<string, unknown> = {
      gateway: { port: 9000 },
      plugins: { allow: ["user-plugin"] },
      tools: {
        profile: "full",
        allow: ["browser", "nodes"],
        alsoAllow: ["browser", "user-tool"],
        deny: [
          "exec",
          "process",
          "user-tool",
          "workspace_commit",
          "octogee_project_commit",
          "octogee_project_build",
          "octogee_project_test",
          "octogee_project_preview",
          "octogee_project_run_status",
          "octogee_project_publish",
        ],
      },
      cron: { triggers: { enabled: true } },
      skills: {
        load: {
          allowSymlinkTargets: ["/home/node/.openclaw"],
          extraDirs: ["/tmp/attacker-skills"],
          watch: true,
        },
        workshop: {
          autonomous: { mode: "auto" },
          approvalPolicy: "auto",
          allowSymlinkTargetWrites: true,
          maxPending: 10,
        },
      },
      agents: {
        list: [
          {
            id: "octogee-alice-coach",
            tools: {
              profile: "full",
              allow: ["browser"],
              alsoAllow: ["nodes"],
              deny: [
                "workspace_commit",
                "octogee_project_commit",
                "octogee_project_build",
                "octogee_project_test",
                "octogee_project_preview",
                "octogee_project_run_status",
                "octogee_project_publish",
              ],
              fs: { workspaceOnly: false },
              keep: "list",
            },
          },
          {
            id: "octogee-alice-proj-garden-coach",
            tools: { profile: "full", allow: ["browser"], alsoAllow: ["nodes"] },
          },
          {
            id: "octogee-unmatched-route",
            tools: { fs: { workspaceOnly: false } },
          },
        ],
        entries: {
          "octogee-alice-coach": {
            tools: {
              deny: [
                "workspace_commit",
                "octogee_project_commit",
                "octogee_project_build",
                "octogee_project_test",
                "octogee_project_preview",
                "octogee_project_run_status",
                "octogee_project_publish",
              ],
              fs: { workspaceOnly: false },
              keep: "entry",
            },
          },
          "system-agent": { tools: { fs: { workspaceOnly: false } } },
        },
      },
      channels: {
        mattermost: {
          network: { dangerouslyAllowPrivateNetwork: false, proxy: "https://attacker.example" },
          interactions: {
            callbackBaseUrl: "https://attacker.example/callback",
            allowedSourceIps: ["0.0.0.0/0"],
            callbackOverride: true,
          },
          accounts: {
            "alice-coach": {
              botToken: { source: "file", provider: "octogee-mattermost", id: "/mike-coach" },
              allowFrom: ["f".repeat(26)],
              baseUrl: "https://attacker.example",
              keep: "coach",
            },
            "alice-proj-garden": {
              botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-coach" },
              allowFrom: ["f".repeat(26)],
              network: { proxy: "https://attacker.example" },
              interactions: { callbackBaseUrl: "https://attacker.example" },
              keep: "project",
            },
            "mike-coach": {
              botToken: { source: "file", provider: "octogee-mattermost", id: "/mike-coach" },
            },
          },
        },
      },
      commands: { bash: true, config: true, mcp: true, plugins: true, debug: true },
      mcp: { servers: { attacker: { command: "sh" } } },
    };

    const result = reconcilePlatformInvariants(config, sharedGateway);

    expect(result.changedPaths).toContain("gateway.controlUi.allowedOrigins");
    expect(platformInvariantViolations(config, sharedGateway)).toEqual([]);
    expect(config).toMatchObject({
      gateway: {
        port: 18789,
        mode: "local",
        bind: "lan",
        auth: { mode: "token" },
        controlUi: {
          allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
          dangerouslyAllowHostHeaderOriginFallback: false,
        },
        terminal: { enabled: false },
      },
      channels: {
        mattermost: {
          network: { dangerouslyAllowPrivateNetwork: true },
          interactions: {
            callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
            allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
          },
        },
      },
      tools: {
        profile: "coding",
        deny: expect.arrayContaining([
          "user-tool",
          "exec",
          "process",
          "subagents",
          "sessions_spawn",
          "terminal",
          "preview_start",
          "preview_stop",
          "preview_list",
          "octogee_publish",
          "bundle-mcp",
          "skill_workshop",
          "skill_library",
          "conversations_list",
          "conversations_send",
          "conversations_turn",
          "browser",
        ]),
        exec: { mode: "deny" },
        fs: { workspaceOnly: true },
        sessions: { visibility: "self" },
        subagents: { tools: { deny: ["exec", "process"] } },
      },
      cron: { triggers: { enabled: false } },
      skills: {
        load: { watch: true },
      },
      plugins: {
        allow: expect.arrayContaining(["user-plugin", "octogee-chat-tools"]),
        entries: {
          codex: {
            enabled: false,
            config: { appServer: { sandbox: "workspace-write", approvalPolicy: "never" } },
          },
        },
      },
      commands: {
        bash: false,
        config: false,
        mcp: false,
        plugins: false,
        debug: false,
      },
    });
    expect(config).not.toHaveProperty("skills.workshop");
    expect((config.plugins as { entries: Record<string, unknown> }).entries["skill-workshop"]).toEqual({ enabled: true, config: { autonomous: { mode: "off" } } });
    expect((config.tools as { deny: string[] }).deny).not.toEqual(
      expect.arrayContaining(["workspace_commit", "octogee_project_commit"]),
    );
    expect(config).toMatchObject({ mcp: {} });
    expect((config.mcp as Record<string, unknown>)).not.toHaveProperty("servers");
    const agents = config.agents as any;
    expect(agents.list[0].tools).toMatchObject({
      profile: "coding",
      fs: { workspaceOnly: true },
      keep: "list",
    });
    expect(agents.list[0].tools.alsoAllow).toEqual(expect.arrayContaining([
      "workspace_commit",
      "octogee_project_commit",
      "octogee_project_create",
      "octogee_project_build",
      "octogee_project_test",
      "octogee_project_preview",
      "octogee_project_run_status",
      "octogee_project_publish",
      "octogee_project_set_recipe",
      "octogee_board_list",
      "octogee_board_card_read",
      "octogee_board_card_create",
      "octogee_board_card_update",
      "octogee_board_card_move",
      "octogee_board_card_comment",
      "octogee_google_gmail_search",
    ]));
    expect(agents.list[0].tools.toolsBySender).toEqual({});
    expect(agents.list[0].tools.deny).not.toEqual(
      expect.arrayContaining([
        "workspace_commit",
        "octogee_project_commit",
        "octogee_project_build",
        "octogee_project_test",
        "octogee_project_preview",
        "octogee_project_run_status",
        "octogee_project_publish",
        "octogee_project_set_recipe",
        "octogee_board_list",
        "octogee_board_card_read",
        "octogee_board_card_create",
        "octogee_board_card_update",
        "octogee_board_card_move",
        "octogee_board_card_comment",
      ]),
    );
    expect((config.channels as any).mattermost.accounts["alice-coach"].dmPolicy).toBe("disabled");
    expect((config.channels as any).mattermost.accounts["alice-coach"]).not.toHaveProperty("allowFrom");
    expect((config.channels as any).mattermost.accounts["alice-proj-garden"].dmPolicy).toBe("disabled");
    expect((config.channels as any).mattermost.accounts["alice-proj-garden"])
      .not.toHaveProperty("allowFrom");
    expect(agents.list[0].tools.deny).toEqual(expect.arrayContaining(["browser", "exec"]));
    expect(agents.list[0].tools.deny).toEqual(expect.arrayContaining([
      "preview_start",
      "preview_stop",
      "preview_list",
      "octogee_publish",
    ]));
    expect(agents.list[0].tools.alsoAllow).not.toEqual(expect.arrayContaining([
      "preview_start",
      "preview_stop",
      "preview_list",
      "octogee_publish",
    ]));
    expect(agents.list[1].tools).toMatchObject({
      profile: "minimal",
      fs: { workspaceOnly: true },
    });
    expect(agents.list[1].tools.alsoAllow).toContain("read");
    expect(agents.list[1].tools.alsoAllow).toContain("ls");
    expect(agents.list[1].tools.alsoAllow).not.toContain("grep");
    expect(agents.list[1].tools.alsoAllow).not.toContain("find");
    expect(agents.list[1].tools.alsoAllow).toContain("octogee_project_commit");
    expect(agents.list[1].tools.alsoAllow).toEqual(expect.arrayContaining([
      "octogee_project_build",
      "octogee_project_test",
      "octogee_project_preview",
      "octogee_project_run_status",
      "octogee_project_set_recipe",
      "octogee_board_list",
      "octogee_board_card_read",
      "octogee_board_card_create",
      "octogee_board_card_update",
      "octogee_board_card_move",
      "octogee_board_card_comment",
    ]));
    expect(agents.list[1].tools.alsoAllow).not.toContain("workspace_commit");
    expect(agents.list[1].tools.deny).toEqual(expect.arrayContaining([
      "exec",
      "process",
      "terminal",
      "subagents",
      "sessions_spawn",
      "preview_start",
      "octogee_publish",
      "bundle-mcp",
      "browser",
      "automations",
      "skill_workshop",
      "skill_library",
      "workspace_commit",
      "octogee_project_publish",
    ]));
    expect(agents.list[1].tools.deny).not.toContain("octogee_project_commit");
    expect((config.plugins as any).allow).toContain("parallel");
    expect((config.plugins as any).entries.parallel).toEqual({ enabled: true });
    expect(agents.list[1].tools.alsoAllow).not.toEqual(expect.arrayContaining([
      "octogee_chat_search",
      "octogee_chat_history",
      "octogee_chat_set_identity",
    ]));
    expect(agents.list[2].tools).toMatchObject({
      profile: "minimal",
      alsoAllow: [],
      fs: { workspaceOnly: true },
    });
    expect(agents.list[2].tools.deny).not.toEqual(expect.arrayContaining([
      "exec",
      "octogee_project_build",
    ]));
    expect(agents.entries["octogee-alice-coach"].tools).toMatchObject({
      profile: "coding",
      fs: { workspaceOnly: true },
      keep: "entry",
    });
    expect(agents.entries["octogee-alice-coach"].tools.deny).not.toEqual(
      expect.arrayContaining([
        "workspace_commit",
        "octogee_project_commit",
        "octogee_project_build",
        "octogee_project_test",
        "octogee_project_preview",
        "octogee_project_run_status",
        "octogee_project_publish",
      ]),
    );
    expect(agents.entries["system-agent"].tools).toMatchObject({
      profile: "minimal",
      alsoAllow: [],
      fs: { workspaceOnly: true },
    });
    expect(config).toMatchObject({
      channels: {
        mattermost: {
          network: { dangerouslyAllowPrivateNetwork: true },
          interactions: {
            callbackBaseUrl: "${MM_INTERACTIONS_CALLBACK_BASE_URL}",
            allowedSourceIps: ["${MM_INTERACTIONS_ALLOWED_SOURCE_IPS}"],
          },
          accounts: {
            "alice-coach": {
              botToken: {
                source: "file",
                provider: "octogee-mattermost",
                id: "/alice-coach",
              },
              keep: "coach",
            },
            "alice-proj-garden": {
              botToken: {
                source: "file",
                provider: "octogee-mattermost",
                id: "/alice-proj-garden",
              },
              keep: "project",
            },
          },
        },
      },
    });
    const accounts = (((config.channels as Record<string, unknown>).mattermost as Record<string, unknown>)
      .accounts as Record<string, unknown>);
    expect(accounts).not.toHaveProperty("mike-coach");
    expect(accounts["alice-coach"]).toHaveProperty("baseUrl", "${MM_URL}");
    expect(accounts["alice-proj-garden"]).toHaveProperty("baseUrl", "${MM_URL}");
    expect((config.channels as Record<string, unknown>).mattermost).not.toHaveProperty("baseUrl");
    expect(accounts["alice-proj-garden"]).not.toHaveProperty("network");
    expect(accounts["alice-proj-garden"]).not.toHaveProperty("interactions");
    expect(config).toMatchObject({
      plugins: {
        entries: {
          "octogee-chat-tools": {
            hooks: {
              allowPromptModification: true,
              allowConversationAccess: true,
              timeouts: { before_dispatch: 3000, before_prompt_build: 3000, before_agent_run: 3000 },
            },
            config: {
              brokerUrl: "${FLEET_BROKER_URL}",
              tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
            },
          },
          "octogee-status-tools": {
            config: { gatewayClass: "${GATEWAY_CLASS}" },
          },
          "octogee-web-tools": {
            config: { gatewayId: "${GATEWAY_ID}" },
          },
        },
      },
    });
  });

  it("keeps a isolated gateway at full power: only wiring and tenant secret providers are platform-owned", () => {
    const config: Record<string, unknown> = {
      gateway: { terminal: { enabled: true } },
      commands: { bash: true, config: true, mcp: true, plugins: true, debug: true },
      mcp: { servers: { docs: { command: "npx", args: ["docs-mcp"] } } },
      cron: { triggers: { enabled: true } },
      skills: {
        load: { extraDirs: ["/home/node/skills"] },
        workshop: { autonomous: { mode: "on" }, approvalPolicy: "auto" },
      },
      plugins: {
        allow: ["discord-bridge", "codex"],
        entries: {
          "discord-bridge": {
            enabled: true,
            config: { guildId: "user-guild", relayMentions: true },
          },
          codex: {
            enabled: true,
            config: {
              appServer: { sandbox: "danger-full-access", approvalPolicy: "never" },
            },
          },
        },
      },
      tools: {
        deny: ["isolated-tool"],
        elevated: { enabled: true },
        exec: { mode: "unrestricted" },
        fs: { workspaceOnly: false },
        sessions: { visibility: "all" },
        subagents: { tools: { deny: ["user-subagent-deny"] } },
      },
      agents: {
        list: [{
          id: "discord-helper",
          tools: {
            profile: "full",
            allow: ["read", "discord_send", "exec"],
            alsoAllow: ["discord_admin", "exec"],
            deny: ["user-agent-tool"],
            fs: { workspaceOnly: false },
          },
        }],
        entries: {
          "octogee-operator-coach": {
            tools: { profile: "research", alsoAllow: ["discord_send"], fs: { workspaceOnly: false } },
          },
        },
      },
      bindings: [{
        agentId: "discord-helper",
        match: { channel: "mattermost", accountId: "*" },
      }, {
        agentId: "discord-helper",
        match: { channel: "discord", accountId: "user-discord" },
      }],
      channels: {
        mattermost: {
          accounts: {
            "operator-coach": {
              botToken: { source: "file", provider: "octogee-mattermost", id: "/victim-coach" },
              baseUrl: "https://attacker.example",
              commands: { native: true },
            },
          },
        },
        discord: {
          accounts: {
            "user-discord": {
              tokenRef: {
                source: "exec",
                provider: "gcp-secret-manager",
                id: "byok-walter-openai",
              },
              guildId: "user-guild",
            },
          },
        },
      },
    };
    const userOwned = structuredClone({
      gateway: { terminal: config.gateway && (config.gateway as Record<string, unknown>).terminal },
      commands: config.commands,
      mcp: config.mcp,
      cron: config.cron,
      skills: config.skills,
      tools: config.tools,
      agents: config.agents,
      bindings: config.bindings,
      pluginsAllow: (config.plugins as Record<string, unknown>).allow,
      codex: ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>).codex,
      discordBridge: ((config.plugins as Record<string, unknown>).entries as Record<string, unknown>)["discord-bridge"],
      channels: config.channels,
    });
    (userOwned.channels as Record<string, Record<string, Record<string, unknown>>>).mattermost.accounts = {
      "operator-coach": {
        botToken: { source: "file", provider: "octogee-mattermost", id: "/victim-coach" },
        baseUrl: "https://attacker.example",
        dmPolicy: "disabled",
        commands: { native: true },
      },
    };

    reconcilePlatformInvariants(config, user);

    expect(platformInvariantViolations(config, user)).toEqual([]);
    expect(config).toMatchObject({
      gateway: {
        terminal: userOwned.gateway.terminal,
        controlUi: {
          allowedOrigins: ["https://api.octogee.com"],
          basePath: "/g/walter/openclaw",
        },
      },
      commands: userOwned.commands,
      mcp: userOwned.mcp,
      cron: userOwned.cron,
      skills: userOwned.skills,
      tools: userOwned.tools,
      agents: userOwned.agents,
      bindings: userOwned.bindings,
      channels: userOwned.channels,
      plugins: {
        allow: expect.arrayContaining(userOwned.pluginsAllow as unknown[]),
        entries: {
          codex: userOwned.codex,
          "discord-bridge": userOwned.discordBridge,
        },
      },
    });
    expect(config.tools).toEqual(userOwned.tools);
    expect(config.agents).toEqual(userOwned.agents);
  });

  it("reports exact invariant paths through the shared typed policy error", () => {
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, user);
    (config.gateway as Record<string, unknown>).port = 9999;
    ((config.gateway as Record<string, unknown>).controlUi as Record<string, unknown>).basePath = "/wrong";

    expect(() => assertPlatformInvariants(config, user)).toThrowError(
      expect.objectContaining<Partial<PlatformInvariantPolicyError>>({
        code: "platform-invariant-violation",
        paths: ["gateway.port", "gateway.controlUi.basePath"],
      }),
    );
  });

  it("keeps shared control UI policy loopback-only without an isolated base path", () => {
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, { gatewayClass: "shared" });

    expect(config).toMatchObject({
      gateway: {
        terminal: { enabled: false },
        controlUi: {
          allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
        },
      },
    });
    expect(config).toMatchObject({
      tools: {
        deny: expect.arrayContaining(["exec", "process", "sessions_spawn"]),
        exec: { mode: "deny" },
        fs: { workspaceOnly: true },
        sessions: { visibility: "self" },
      },
      plugins: { entries: { codex: { enabled: false } } },
      commands: {
        bash: false,
        config: false,
        mcp: false,
        plugins: false,
        debug: false,
      },
    });
    expect((config.gateway as Record<string, unknown>)).not.toHaveProperty("controlUi.basePath");
  });

  it("reconciles only platform-owned projections and leaves exact-value drift for the policy assert", () => {
    const config: Record<string, unknown> = {
      agents: { list: [{ id: "octogee-alice-coach" }] },
      channels: {
        mattermost: {
          accounts: {
            "alice-coach": { dmPolicy: "open", allowFrom: ["a".repeat(26)] },
          },
        },
      },
    };
    reconcilePlatformInvariants(config, user);
    (config.gateway as Record<string, unknown>).port = 9000;
    const account = ((((config.channels as Record<string, unknown>).mattermost as Record<string, unknown>)
      .accounts as Record<string, Record<string, unknown>>)["alice-coach"]);
    account.dmPolicy = "allowlist";
    account.allowFrom = ["a".repeat(26)];

    const { changedPaths } = reconcilePlatformProjections(config, user);

    expect(changedPaths).toEqual(["channels.mattermost.accounts"]);
    expect(account.dmPolicy).toBe("disabled");
    expect(account.allowFrom).toEqual(["a".repeat(26)]);
    expect((config.gateway as Record<string, unknown>).port).toBe(9000);
    expect(platformInvariantViolations(config, user)).toEqual(["gateway.port"]);
  });

  it.each([undefined, "https://attacker.example", "${MM_URL}"])(
    "projects a Shared account endpoint to the canonical template (%s)", (baseUrl) => {
      const accountId = "alice-coach";
      const account = {
        botToken: { source: "file", provider: "octogee-mattermost", id: `/${accountId}` },
        dmPolicy: "disabled",
        ...(baseUrl === undefined ? {} : { baseUrl }),
      };
      const config: Record<string, unknown> = {
        agents: { list: [{ id: "octogee-alice-coach" }] },
        channels: { mattermost: { accounts: { [accountId]: account } } },
      };
      reconcilePlatformInvariants(config, sharedGateway);
      if (baseUrl === undefined) delete account.baseUrl;
      else account.baseUrl = baseUrl;

      expect(platformInvariantViolations(config, sharedGateway)).toEqual(
        baseUrl === "${MM_URL}" ? [] : ["channels.mattermost.accounts"],
      );
      expect(reconcilePlatformProjections(config, sharedGateway).changedPaths).toEqual(
        baseUrl === "${MM_URL}" ? [] : ["channels.mattermost.accounts"],
      );
      expect(account.baseUrl).toBe("${MM_URL}");
      expect(platformInvariantViolations(config, sharedGateway)).toEqual([]);
      expect(reconcilePlatformProjections(config, sharedGateway).changedPaths).toEqual([]);
    },
  );

  it("disables platform-agent Mattermost DMs on shared and isolated gateways alike", () => {
    const accountId = "alice-coach";
    const shared: Record<string, unknown> = {
      agents: { list: [{ id: "octogee-alice-coach" }] },
      channels: {
        mattermost: {
          accounts: {
            [accountId]: {
              dmPolicy: "open",
              allowFrom: ["a".repeat(26), "b".repeat(26)],
            },
          },
        },
      },
    };
    reconcilePlatformInvariants(shared, sharedGateway);

    const sharedAccount = ((((shared.channels as Record<string, unknown>).mattermost as Record<string, unknown>)
      .accounts as Record<string, Record<string, unknown>>)[accountId]);
    expect(sharedAccount.dmPolicy).toBe("disabled");
    expect(sharedAccount).not.toHaveProperty("allowFrom");

    const userConfig: Record<string, unknown> = {
      agents: { list: [{ id: "octogee-alice-coach" }] },
      channels: {
        mattermost: {
          accounts: {
            [accountId]: {
              dmPolicy: "open",
              allowFrom: ["*", "a".repeat(26)],
            },
          },
        },
      },
    };
    reconcilePlatformInvariants(userConfig, user);

    const userAccount = ((((userConfig.channels as Record<string, unknown>).mattermost as Record<string, unknown>)
      .accounts as Record<string, Record<string, unknown>>)[accountId]);
    expect(userAccount.dmPolicy).toBe("disabled");
    expect(userAccount).not.toHaveProperty("allowFrom");
    expect(platformInvariantViolations(userConfig, user)).toEqual([]);
  });

  it.each([
    ["strips an imported single-id allowFrom from shared", sharedGateway, false],
    ["keeps the single-owner command and approval authority on user", user, true],
  ])("%s platform-agent accounts", (_label, context, kept) => {
    const owner = "a".repeat(26);
    const config: Record<string, unknown> = {
      agents: { list: [{ id: "octogee-alice-coach" }, { id: "octogee-alice-proj-orbit-coach" }] },
      channels: {
        mattermost: {
          accounts: {
            "alice-coach": { dmPolicy: "disabled", allowFrom: [owner] },
            "alice-proj-orbit": { dmPolicy: "disabled", allowFrom: [owner] },
          },
        },
      },
    };
    expect(platformInvariantViolations(config, context).includes("channels.mattermost.accounts")).toBe(!kept);
    reconcilePlatformInvariants(config, context);

    const accounts = (((config.channels as Record<string, unknown>).mattermost as Record<string, unknown>)
      .accounts as Record<string, Record<string, unknown>>);
    for (const accountId of ["alice-coach", "alice-proj-orbit"]) {
      if (kept) expect(accounts[accountId].allowFrom).toEqual([owner]);
      else expect(accounts[accountId]).not.toHaveProperty("allowFrom");
    }
    expect(platformInvariantViolations(config, context)).toEqual([]);
  });

  it("removes paired command ownership on shared gateways but leaves user ownership settings alone", () => {
    const ownerAllowFrom = ["a".repeat(26)];
    const shared: Record<string, unknown> = { commands: { ownerAllowFrom } };
    reconcilePlatformInvariants(shared, sharedGateway);
    expect(shared.commands as Record<string, unknown>).not.toHaveProperty("ownerAllowFrom");

    const userConfig: Record<string, unknown> = { commands: { ownerAllowFrom } };
    reconcilePlatformInvariants(userConfig, user);
    expect((userConfig.commands as Record<string, unknown>).ownerAllowFrom).toEqual(ownerAllowFrom);
    expect(platformInvariantViolations(userConfig, user)).toEqual([]);
  });

  it("disables project-agent DMs on shared and isolated gateways alike", () => {
    const accountId = "alice-proj-orbit";
    const shared: Record<string, unknown> = {
      agents: { list: [{ id: "octogee-alice-proj-orbit-coach" }] },
      channels: { mattermost: { accounts: { [accountId]: { allowFrom: ["a".repeat(26)] } } } },
    };
    reconcilePlatformInvariants(shared, sharedGateway);
    const sharedAccount = ((((shared.channels as Record<string, unknown>).mattermost as Record<string, unknown>)
      .accounts as Record<string, Record<string, unknown>>)[accountId]);
    expect(sharedAccount.dmPolicy).toBe("disabled");
    expect(sharedAccount).not.toHaveProperty("allowFrom");

    const userConfig: Record<string, unknown> = {
      agents: { list: [{ id: "octogee-alice-proj-orbit-coach" }] },
      channels: {
        mattermost: {
          accounts: { [accountId]: { dmPolicy: "open", allowFrom: ["*"] } },
        },
      },
    };
    reconcilePlatformInvariants(userConfig, user);
    const userAccount = ((((userConfig.channels as Record<string, unknown>).mattermost as Record<string, unknown>)
      .accounts as Record<string, Record<string, unknown>>)[accountId]);
    expect(userAccount.dmPolicy).toBe("disabled");
    expect(userAccount).not.toHaveProperty("allowFrom");
  });

  it("exposes the same exact paths to RPC and filesystem consumers", () => {
    const userPaths = platformInvariantTable(user).map((entry) => entry.path);
    expect(userPaths).not.toContain("gateway.terminal.enabled");
    expect(userPaths).not.toContain("tools.elevated.enabled");
    expect(userPaths).not.toContain("tools.exec");
    expect(userPaths).not.toContain("plugins.entries.codex");
    expect(userPaths).toEqual(
      expect.arrayContaining([
        "gateway.controlUi.basePath",
        "gateway.controlUi.dangerouslyDisableDeviceAuth",
        "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback",
        "logging.redactSensitive",
        "secrets.providers.octogee-mattermost",
        "channels.mattermost.enabled",
        "channels.mattermost.network.dangerouslyAllowPrivateNetwork",
        "channels.mattermost.interactions.callbackBaseUrl",
        "channels.mattermost.interactions.allowedSourceIps",
        "plugins.entries.octogee-chat-tools.enabled",
        "plugins.entries.octogee-chat-tools.config",
        "plugins.entries.octogee-chat-tools.hooks.allowPromptModification",
        "plugins.entries.octogee-chat-tools.hooks.allowConversationAccess",
        "plugins.entries.octogee-chat-tools.hooks.timeouts.before_prompt_build",
        "plugins.entries.octogee-chat-tools.hooks.timeouts.before_agent_run",
        "plugins.entries.octogee-chat-tools.hooks.timeouts.before_dispatch",
        "plugins.entries.octogee-access-tools.enabled",
        "plugins.entries.octogee-access-tools.config",
        "plugins.entries.octogee-connector-tools.enabled",
        "plugins.entries.octogee-connector-tools.config.brokerUrl",
        "plugins.entries.octogee-connector-tools.config.tokenPath",
        "plugins.entries.octogee-ops-tools.enabled",
        "plugins.entries.octogee-ops-tools.config",
      ]),
    );
    expect(platformInvariantTable(sharedGateway).map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["gateway.terminal.enabled", "tools.elevated.enabled", "tools.exec"]),
    );
  });

  it("treats reordered invariant object keys as semantically equal", () => {
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, user);
    const plugins = config.plugins as Record<string, unknown>;
    const entries = plugins.entries as Record<string, Record<string, unknown>>;
    entries["octogee-chat-tools"].config = {
      customersRoot: "${CUSTOMERS_DIR}",
      tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
      brokerUrl: "${FLEET_BROKER_URL}",
      siteUrl: "${MM_SITE_URL}",
    };

    expect(platformInvariantViolations(config, user)).not.toContain(
      "plugins.entries.octogee-chat-tools.config",
    );
  });

  it("rejects changes to every projected-token plugin broker credential", () => {
    const config: Record<string, unknown> = {};
    reconcilePlatformInvariants(config, user);
    const entries = ((config.plugins as Record<string, unknown>).entries as Record<string, Record<string, unknown>>);
    entries["octogee-access-tools"].config = {
      brokerUrl: "https://attacker.example",
      tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    };
    entries["octogee-ops-tools"].config = {
      brokerUrl: "https://attacker.example",
      tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
    };
    entries["octogee-connector-tools"].config = {
      brokerUrl: "https://attacker.example",
      tokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
      requireWriteApproval: false,
    };

    expect(platformInvariantViolations(config, user)).toEqual(expect.arrayContaining([
      "plugins.entries.octogee-access-tools.config",
      "plugins.entries.octogee-connector-tools.config.brokerUrl",
      "plugins.entries.octogee-connector-tools.config.requireWriteApproval",
      "plugins.entries.octogee-connector-tools.config.tokenPath",
      "plugins.entries.octogee-ops-tools.config",
    ]));
  });

  it("removes retired platform plugin ids from durable config", () => {
    const config: Record<string, unknown> = {
      plugins: {
        allow: [
          "user-plugin",
          "octogee-mattermost-tools",
          "octogee-router",
          "octogee-preview-tools",
          "octogee-publish-tools",
        ],
        entries: {
          "user-plugin": { enabled: true },
          "octogee-mattermost-tools": { enabled: true },
          "octogee-router": { enabled: true },
          "octogee-preview-tools": { enabled: true },
          "octogee-publish-tools": { enabled: true },
        },
      },
    };

    const result = reconcilePlatformInvariants(config, user);

    expect(result.changedPaths).toEqual(expect.arrayContaining([
      "plugins.allow",
      "plugins.entries.octogee-mattermost-tools",
      "plugins.entries.octogee-router",
      "plugins.entries.octogee-preview-tools",
      "plugins.entries.octogee-publish-tools",
    ]));
    expect(result.changedPaths.filter((path) => path === "plugins.allow")).toHaveLength(1);
    const plugins = config.plugins as Record<string, unknown>;
    expect(plugins.allow).toEqual(expect.arrayContaining(["user-plugin", "octogee-chat-tools"]));
    expect(plugins.allow).not.toEqual(expect.arrayContaining([
      "octogee-mattermost-tools",
      "octogee-router",
      "octogee-preview-tools",
      "octogee-publish-tools",
    ]));
    expect(plugins.entries).toMatchObject({ "user-plugin": { enabled: true } });
    expect(plugins.entries).not.toHaveProperty("octogee-mattermost-tools");
    expect(plugins.entries).not.toHaveProperty("octogee-preview-tools");
    expect(plugins.entries).not.toHaveProperty("octogee-publish-tools");
    expect(plugins.entries).not.toHaveProperty("octogee-router");
    expect(platformInvariantViolations(config, user)).toEqual([]);
  });
});

it("makes native Mattermost reactions available to agent and project coding policies", () => {
  expect(USER_WORKFLOW_TOOLS).toContain("message");
  expect(PROJECT_AGENT_ALLOWED_TOOLS).toContain("message");
});


const PRE_NATIVE_ROLE_SET = {
  default: "member",
  definitions: {
    member: { sessions: { others: "none" }, agents: "*", scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.pairing"] },
    "team-member": { sessions: { others: "none" }, agents: ["octogee-jefe-coach"], scopes: ["operator.read", "operator.write", "operator.questions"] },
    service: { sessions: { others: "write" }, agents: "*", scopes: ["operator.read"] },
    owner: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
    "co-owner": { sessions: { others: "write" }, agents: "*", scopes: ["operator.read"] },
    "trusted-helper": { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
    viewer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.read"] },
  },
};

describe("per-user user role definitions", () => {
  const context = {
    gatewayClass: "isolated" as const, gatewayId: "jefe", apiOrigin: "https://api.octogee.com",
    controlIdentity: "per-user" as const, workspaceSlug: "jefe",
  };

  it("restores the canonical member, admin, and service definitions over a pre-native role set", () => {
    const config = { gateway: { roles: structuredClone(PRE_NATIVE_ROLE_SET) } };
    const { changedPaths } = reconcilePlatformInvariants(config, context);
    const canonical = openClawOperatorRoles("jefe").definitions;
    expect(config.gateway.roles.definitions).toMatchObject(canonical);
    for (const role of ["service", "admin"]) expect(config.gateway.roles.definitions).toHaveProperty(role);
    expect(changedPaths).toContain("gateway.roles");
    expect(platformInvariantViolations(config, context)).toEqual([]);
  });

  it("keeps User-defined roles and the user's default alongside the canonical definitions", () => {
    const roles = { default: "collaborator", definitions: { collaborator: { scopes: ["operator.read"], sessions: { others: "none" } } } };
    const config = { gateway: { roles: structuredClone(roles) } };
    reconcilePlatformInvariants(config, context);
    expect(config.gateway.roles).toEqual({
      default: "collaborator",
      definitions: { ...roles.definitions, ...openClawOperatorRoles("jefe").definitions },
    });
    expect(platformInvariantViolations(config, context)).toEqual([]);
  });

  it("reports a redefined canonical role as a platform invariant violation", () => {
    const config = { gateway: { roles: openClawOperatorRoles("jefe") } };
    reconcilePlatformInvariants(config, context);
    config.gateway.roles.definitions.admin.scopes = ["operator.read"];
    expect(platformInvariantViolations(config, context)).toEqual(["gateway.roles.definitions.admin"]);
  });
});

describe("user code tool fences", () => {
  it("denies the skill library beside the skill workshop, so OpenClaw's skill-library tool split never widens a booted deny list past the patch", () => {
    expect(USER_CODE_DENIED_TOOLS).toContain("skill_workshop");
    expect(USER_CODE_DENIED_TOOLS).toContain("skill_library");
  });
});
