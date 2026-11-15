import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { USER_CODE_DENIED_TOOLS } from "../../core/src/system-config-invariants";

const repoRoot = path.resolve(__dirname, "../..");

type Template = {
  gateway: { terminal?: { enabled?: boolean } } & Record<string, unknown>;
  tools: Record<string, unknown>;
  plugins: { allow: string[]; entries: Record<string, Record<string, unknown>> };
  commands: Record<string, unknown>;
  cron?: unknown;
  skills?: unknown;
} & Record<string, unknown>;

function read(name: string): Template {
  return JSON.parse(readFileSync(path.join(repoRoot, "gateway", name), "utf8")) as Template;
}

const USER_OWNED_TOP_LEVEL = new Set([
  "browser",
  "tools",
  "plugins",
  "commands",
  "cron",
  "skills",
  "gateway",
]);

describe("gateway/openclaw.isolated.template.json — the user seed boots on the slim runtime", () => {
  const shared = read("openclaw.template.json");
  const user = read("openclaw.isolated.template.json");

  it("starts typing the moment a message arrives, on both gateway classes", () => {
    for (const name of ["openclaw.template.json", "openclaw.isolated.template.json"]) {
      const template = read(name);
      expect((template.agents as { defaults?: { typingMode?: string } }).defaults?.typingMode).toBe("instant");
    }
  });

  it("seeds both Gateway classes with current migration decisions", () => {
    for (const template of [shared, user]) {
      expect(template.meta).toMatchObject({
        migrations: {
          modelPolicyAllowlist: true,
          skillLibraryToolSplit: true,
          skillWorkshopPlugin: true,
          utilityModelSeparation: true,
          webhookListeners: true,
        },
      });
    }
  });

  it("shares every platform wiring section byte-for-byte with the shared template", () => {
    for (const key of Object.keys(shared)) {
      if (USER_OWNED_TOP_LEVEL.has(key)) continue;
      expect(user[key], key).toEqual(shared[key]);
    }
    const { terminal: _sharedTerminal, ...sharedGateway } = shared.gateway;
    const { terminal: _userTerminal, ...isolatedGateway } = user.gateway;
    expect(isolatedGateway).toEqual(sharedGateway);
    expect(Object.keys(user).sort()).toEqual(
      [...Object.keys(shared).filter((key) => key !== "cron" && key !== "skills"), "browser"].sort(),
    );
  });

  it("drops host-code fences while keeping the unavailable managed browser disabled", () => {
    expect(user.tools).toEqual({
      profile: shared.tools.profile,
      alsoAllow: [...shared.tools.alsoAllow as string[], "browser"],
      web: shared.tools.web,
    });
    for (const tool of USER_CODE_DENIED_TOOLS.filter((tool) => tool !== "browser")) {
      expect(JSON.stringify(user.tools)).not.toContain(`"${tool}"`);
    }
    expect(user.browser).toEqual({
      enabled: false,
      defaultProfile: "openclaw",
      headless: true,
      noSandbox: true,
      evaluateEnabled: true,
      executablePath: "/usr/bin/chromium",
    });
    expect(user.gateway.terminal).toEqual({ enabled: true });
    for (const command of ["bash", "config", "mcp", "plugins", "debug"]) {
      expect(user.commands).not.toHaveProperty(command);
    }
    expect(user).not.toHaveProperty("cron");
    expect(user).not.toHaveProperty("skills");
  });

  it("keeps core and native Codex available while leaving the managed browser disabled", () => {
    expect(user.plugins.allow).toEqual([...shared.plugins.allow, "codex", "browser"]);
    expect(user.plugins.entries.browser).toEqual({ enabled: false });
    expect(user.plugins.entries.codex).toEqual({ enabled: true });
    expect(shared.plugins.entries["skill-workshop"]).toEqual({ enabled: true, config: { autonomous: { mode: "off" } } });
    expect(user.plugins.entries["skill-workshop"]).toEqual({ enabled: true });
    const { codex: _sharedCodex, browser: _sharedBrowser, "skill-workshop": _sharedWorkshop, ...sharedEntries } = shared.plugins.entries;
    const { codex: _isolatedCodex, browser: _isolatedBrowser, "skill-workshop": _userWorkshop, ...userEntries } = user.plugins.entries;
    expect(userEntries).toEqual(sharedEntries);
  });
});
