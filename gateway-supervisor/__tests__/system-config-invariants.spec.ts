import { describe, expect, it } from "vitest";

import {
  PlatformInvariantPolicyError,
  assertPlatformInvariants,
  reconcilePlatformInvariants,
  systemConfigInvariantContextFromEnv,
} from "../lib/system-config-invariants.js";
import {
  buildUserAgent,
  buildProjectAgents,
  buildSafeDefaultAgent,
} from "../lib/openclaw-config-users.js";
import { withUserClaim } from "./helpers/user-claim.js";

function config(): Record<string, unknown> {
  return {
    discovery: { mdns: { mode: "on" } },
    gateway: {
      port: 9000,
      mode: "remote",
      bind: "loopback",
      auth: { mode: "password" },
      controlUi: { allowedOrigins: ["*"] },
    },
    secrets: { providers: {} },
    channels: { mattermost: { enabled: false, commands: { native: true } } },
    plugins: { enabled: false, allow: ["user-plugin"], entries: {} },
    tools: { deny: ["exec", "user-deny"], exec: { mode: "deny" } },
    commands: { bash: true, config: true, mcp: true, plugins: true, debug: true },
    mcp: { servers: { stale: { command: "sh" } } },
  };
}

const env = {
  GATEWAY_CLASS: "shared",
  GATEWAY_ID: "walter",
  API_PUBLIC_URL: "https://api.example.test",
};

describe("system config platform invariants", () => {
  it("reconciles the typed platform paths without removing user-owned values", () => {
    const candidate = config();

    const result = reconcilePlatformInvariants(candidate, env);

    expect(result.changedPaths).toEqual(expect.arrayContaining([
      "gateway.port",
      "gateway.mode",
      "gateway.bind",
      "gateway.auth.mode",
      "gateway.controlUi.allowedOrigins",
      "secrets.providers.octogee-mattermost",
      "channels.mattermost.enabled",
      "plugins.enabled",
      "plugins.allow",
      "tools.deny",
    ]));
    expect(candidate).toMatchObject({
      gateway: {
        port: 18789,
        mode: "local",
        bind: "lan",
        auth: { mode: "token" },
        controlUi: {
          allowedOrigins: ["http://localhost:18789", "http://127.0.0.1:18789"],
          dangerouslyAllowHostHeaderOriginFallback: false,
        },
      },
      secrets: {
        providers: {
          "octogee-mattermost": {
            source: "file",
            path: "/home/node/.openclaw/secrets/mattermost-accounts.json",
            mode: "json",
          },
        },
      },
      channels: { mattermost: { enabled: true, commands: { native: false } } },
      plugins: {
        enabled: true,
        allow: expect.arrayContaining(["user-plugin", "mattermost"]),
        entries: {
          codex: { enabled: false },
          "octogee-chat-tools": {
            hooks: {
              allowPromptModification: true,
              allowConversationAccess: true,
              timeouts: { before_dispatch: 3000, before_prompt_build: 3000, before_agent_run: 3000 },
            },
          },
        },
      },
      tools: {
        deny: [
          "exec",
          "user-deny",
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
          "computer",
        ],
        exec: { mode: "deny" },
        sessions: { visibility: "self" },
      },
      commands: {
        bash: false,
        config: false,
        mcp: false,
        plugins: false,
        debug: false,
      },
    });
    expect((candidate.mcp as Record<string, unknown>)).not.toHaveProperty("servers");
  });

  it("fails a retired operator class value closed to the shared user policy", () => {
    const candidate = config();
    const retiredClassEnv = {
      ...env,
      GATEWAY_CLASS: "operator",
      API_PUBLIC_URL: "https://api.octogee.com",
    };

    expect(systemConfigInvariantContextFromEnv(retiredClassEnv).gatewayClass).toBe("shared");
    reconcilePlatformInvariants(candidate, retiredClassEnv);

    expect(candidate).toMatchObject({
      gateway: { terminal: { enabled: false } },
      plugins: {
        entries: {
          codex: { enabled: false },
        },
      },
      tools: {
        deny: expect.arrayContaining(["exec", "process", "terminal", "user-deny"]),
        exec: { mode: "deny" },
      },
    });
    expect((candidate.plugins as { allow?: string[] }).allow).not.toContain("codex");
  });

  it("reports every violated path in a typed policy error without mutating the candidate", () => {
    const candidate = config();
    const before = structuredClone(candidate);

    expect(() => assertPlatformInvariants(candidate, env)).toThrowError(
      expect.objectContaining<Partial<PlatformInvariantPolicyError>>({
        code: "platform-invariant-violation",
        paths: expect.arrayContaining(["gateway.port", "plugins.allow", "tools.deny"]),
      }),
    );
    expect(candidate).toEqual(before);
  });

  it("is idempotent and accepts the reconciled result", () => {
    const candidate = config();
    reconcilePlatformInvariants(candidate, env);

    expect(reconcilePlatformInvariants(candidate, env)).toEqual({ changedPaths: [] });
    expect(() => assertPlatformInvariants(candidate, env)).not.toThrow();
  });

  it("accepts generated user agents at a durable checkpoint", () => {
    const candidate = config();
    const userEnv = { ...env, GATEWAY_CLASS: "isolated" };
    reconcilePlatformInvariants(candidate, userEnv);
    candidate.agents = {
      list: [
        buildSafeDefaultAgent(),
        buildUserAgent({
          uid: "uid-chris",
          slug: "chris",
          customerDir: "/customers/chris",
          agentDir: "/agents/octogee-chris-coach/agent",
          defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
          default: true,
        }),
        ...buildProjectAgents({
          slug: "chris",
          customerDir: "/customers/chris",
          agentsDir: "/agents",
          defaultAgent: { name: "Coach", emoji: "🤖", model: "house" },
          projectAgents: [{
            projectId: "garden",
            enabled: true,
            mmUserId: "mm-garden",
            token: "pat",
          }],
        }),
      ],
    };

    expect(() => assertPlatformInvariants(candidate, userEnv)).not.toThrow();
  });

  it("reads the control identity from the pod environment and defaults it to the shared operator", () => {
    expect(systemConfigInvariantContextFromEnv(env).controlIdentity).toBe("shared-operator");
    expect(systemConfigInvariantContextFromEnv({
      ...env,
      GATEWAY_CLASS: "isolated",
      OPENCLAW_CONTROL_IDENTITY: "per-user",
    }).controlIdentity).toBe("per-user");

    const candidate = config();
    reconcilePlatformInvariants(candidate, withUserClaim({
      ...env,
      GATEWAY_CLASS: "isolated",
      OPENCLAW_CONTROL_IDENTITY: "per-user",
    }, "alice"));
    expect((candidate.gateway as { auth: { mode: string } }).auth.mode).toBe("trusted-proxy");
    expect(candidate.gateway).toMatchObject({ roles: { definitions: { member: { agents: ["octogee-alice-coach"] } } } });
  });
});
