import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");
const workflowTools = [
  "automations",
  "message",
  "octogee_project_create",
  "octogee_project_delegate",
  "octogee_project_commit",
  "octogee_project_list",
  "octogee_project_set_recipe",
  "octogee_project_capability",
  "octogee_project_build",
  "octogee_project_test",
  "octogee_project_preview",
  "octogee_project_run_status",
  "octogee_project_publish",
  "octogee_board_list",
  "octogee_board_card_read",
  "octogee_board_card_create",
  "octogee_board_card_update",
  "octogee_board_card_move",
  "octogee_board_card_comment",
  "workspace_commit",
  "brave_search",
  "tavily_search",
  "tavily_extract",
  "octogee_chat_search",
  "octogee_chat_history",
  "octogee_chat_set_identity",
  "octogee_connection_request",
  "octogee_status",
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
];

function readTemplate() {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "gateway/openclaw.template.json"), "utf8"),
  );
}

describe("gateway/openclaw.template.json — standard gateway exec-off posture", () => {
  it("runs SecretRef resolution through a private runtime-owned executable", () => {
    const template = readTemplate();
    const provider = template.secrets.providers["gcp-secret-manager"];
    const dockerfile = readFileSync(path.join(repoRoot, "gateway/Dockerfile"), "utf8");

    expect(provider.command).toBe("/octogee/scripts/secret-resolver.mjs");
    expect(provider.args).toBeUndefined();
    expect(dockerfile).toContain(
      "COPY --chown=node:node scripts/secret-resolver.mjs /octogee/scripts/",
    );
    expect(dockerfile).toContain(
      "/octogee/scripts/node_modules/.bin/esbuild /octogee/scripts/secret-resolver.mjs",
    );
    expect(dockerfile).toContain("--bundle --platform=node --format=esm");
    expect(dockerfile).toContain("chown root:root /octogee/scripts");
    expect(dockerfile).toContain("chmod 755 /octogee/scripts");
    expect(dockerfile).toContain("chmod 500 /octogee/scripts/secret-resolver.mjs");
  });

  it("denies host-code surfaces for standard agents and exec/process for subagents", () => {
    const template = readTemplate();

    expect(template.tools.deny).toEqual([
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
      "computer",
    ]);
    expect(template.cron).toEqual({ triggers: { enabled: false } });
    expect(template.plugins.entries["skill-workshop"]).toEqual({
      enabled: true, config: { autonomous: { mode: "off" } },
    });
    expect(template.tools.exec).toEqual({ mode: "deny" });
    expect(template.tools.fs).toEqual({ workspaceOnly: true });
    expect(template.tools.subagents.tools.deny).toEqual(["exec", "process"]);
  });

  it("scopes session tools to the current conversation", () => {
    const template = readTemplate();

    expect(template.tools.sessions).toEqual({ visibility: "self" });
    expect(template.gateway.terminal).toEqual({ enabled: false });
  });

  it("allows Octogee workflow tools outside the core coding profile", () => {
    const template = readTemplate();

    expect(template.tools.alsoAllow).toEqual(workflowTools);
  });

  it("disables the Codex plugin and removes the gpt-5.5 Codex runtime route", () => {
    const template = readTemplate();

    expect(template.plugins.allow).not.toContain("codex");
    expect(template.plugins.entries.codex).toEqual({ enabled: false });
    expect(template.agents.defaults.models["openai/gpt-5.5"]).toBeUndefined();
    expect(template.auth.profiles["openai-codex:default"]).toBeUndefined();
  });

  it("enables bearer-blind productivity skills in the shared-safe base template", () => {
    const template = readTemplate();

    expect(template.tools.alsoAllow).toContain("octogee_google_calendar_events");
    expect(template.tools.alsoAllow).toContain("octogee_obsidian_read");
    expect(template.plugins.allow).toContain("octogee-connector-tools");
    expect(template.plugins.entries["octogee-connector-tools"]).toEqual({
      enabled: true,
      config: {
        brokerUrl: "${FLEET_BROKER_URL}",
        tokenPath: "${OCTOGEE_API_SA_TOKEN_PATH}",
      },
    });
    expect(template.plugins.entries["octogee-connector-tools"].config)
      .not.toHaveProperty("requireWriteApproval");
  });
});
