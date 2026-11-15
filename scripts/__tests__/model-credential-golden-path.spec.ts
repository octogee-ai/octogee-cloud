import { describe, expect, it } from "vitest";
import {
  modelCredentialEntryById,
} from "@octogee/shared/types/model-credentials";
import {
  buildModelCredentialConfigForProvider,
  buildClaudeCliAuthProfilesStore,
  buildCodexAuthProfilesStore,
  claudeCliRuntimeConfig,
  CLAUDE_CLI_DEFAULT_PROFILE_ID,
  codexRuntimeConfig,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "../lib/model-credential-materializer.js";

const NOW = 1_700_000_000_000;

function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
}

describe("model credential catalog golden paths", () => {
  it("pins the proven Codex OAuth catalog row to the current OpenClaw artifacts", () => {
    const entry = modelCredentialEntryById("openai-codex");
    expect(entry.openclaw.configProfileId).toBe("openai-codex");
    expect(entry.openclaw.storeProfileId).toBe(OPENAI_CODEX_DEFAULT_PROFILE_ID);
    expect(entry.openclaw.secretRefAllowed).toBe(false);
    expect(entry.defaults?.model).toBe(codexRuntimeConfig().model);

    expect(buildModelCredentialConfigForProvider({ slug: "tester-70", provider: "openai-codex" })).toEqual({
      authProfiles: {
        profiles: {
          "openai-codex": { type: "oauth", provider: "openai" },
        },
      },
      models: null,
      agentModelOverride: codexRuntimeConfig().model,
    });

    const access = jwt({ exp: 1_893_456_000 });
    const idToken = jwt({
      email: "builder@example.com",
      "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
    });
    const store = buildCodexAuthProfilesStore(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: access,
          refresh_token: "refresh-token",
          account_id: "account-id",
          id_token: idToken,
        },
      }),
    );

    expect(Object.keys(store.profiles)).toEqual([OPENAI_CODEX_DEFAULT_PROFILE_ID]);
    expect(store.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toEqual({
      type: "oauth",
      provider: "openai",
      access,
      refresh: "refresh-token",
      expires: 1_893_456_000_000,
      accountId: "account-id",
      idToken,
      chatgptPlanType: "plus",
      email: "builder@example.com",
      copyToAgents: true,
    });
    expect(JSON.stringify(store)).not.toMatch(/secretRef|keyRef|tokenRef/i);
  });

  it("pins the proven Claude CLI OAuth catalog row to the current OpenClaw artifacts", () => {
    const entry = modelCredentialEntryById("claude-cli");
    expect(entry.openclaw.configProfileId).toBe(CLAUDE_CLI_DEFAULT_PROFILE_ID);
    expect(entry.openclaw.storeProfileId).toBe(CLAUDE_CLI_DEFAULT_PROFILE_ID);
    expect(entry.openclaw.secretRefAllowed).toBe(false);
    expect(entry.defaults?.model).toBe(claudeCliRuntimeConfig().model);

    expect(buildModelCredentialConfigForProvider({ slug: "tester-70", provider: "claude-cli" })).toEqual({
      authProfiles: {
        profiles: {
          [CLAUDE_CLI_DEFAULT_PROFILE_ID]: { type: "oauth", provider: "anthropic" },
        },
      },
      models: null,
      agentModelOverride: claudeCliRuntimeConfig().model,
    });

    const store = buildClaudeCliAuthProfilesStore("sk-ant-oat01-current", NOW);
    expect(Object.keys(store.profiles)).toEqual([CLAUDE_CLI_DEFAULT_PROFILE_ID]);
    expect(store.profiles[CLAUDE_CLI_DEFAULT_PROFILE_ID]).toEqual({
      type: "oauth",
      provider: "anthropic",
      access: "sk-ant-oat01-current",
      expires: NOW + 365 * 24 * 60 * 60 * 1000,
      copyToAgents: true,
    });
    expect(JSON.stringify(store)).not.toMatch(/secretRef|keyRef|tokenRef/i);
  });
});
