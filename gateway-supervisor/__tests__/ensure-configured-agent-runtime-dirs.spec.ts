import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  configuredSafeAgentIds,
  ensureConfiguredAgentRuntimeDirs,
} from "../entrypoints/ensure-configured-agent-runtime-dirs.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): { root: string; configPath: string; agentsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "configured-agent-runtime-"));
  dirs.push(root);
  return {
    root,
    configPath: path.join(root, "openclaw.json"),
    agentsDir: path.join(root, "agents"),
  };
}

describe("configured user agent runtime directories", () => {
  it("creates runtime directories for every safe configured agent, including custom user agents", () => {
    const { configPath, agentsDir } = fixture();
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        list: [
          { id: "octogee-ceckert-test-coach" },
          { id: "discord-helper" },
        ],
        entries: {
          "octogee-ceckert-test-coach": {},
          "discord-helper": {},
          "deploy-bot": {},
        },
      },
    }));

    expect(ensureConfiguredAgentRuntimeDirs({ configPath, agentsDir })).toEqual([
      "deploy-bot",
      "discord-helper",
      "octogee-ceckert-test-coach",
    ]);
    expect(fs.statSync(path.join(agentsDir, "deploy-bot", "agent")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(agentsDir, "discord-helper", "agent")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(agentsDir, "octogee-ceckert-test-coach", "agent")).mode & 0o777).toBe(0o700);
  });

  it("uses the current keyed roster and rejects noncanonical portable agent IDs", () => {
    const { root, configPath, agentsDir } = fixture();
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        entries: {
          "octogee-ceckert-test-coach": {},
          "../../outside": {},
          "has.dot": {},
          "_not-an-id": {},
        },
        list: [{ id: "legacy-agent" }],
      },
    }));

    expect(configuredSafeAgentIds(JSON.parse(fs.readFileSync(configPath, "utf8")))).toEqual([
      "octogee-ceckert-test-coach",
    ]);
    expect(() => ensureConfiguredAgentRuntimeDirs({ configPath, agentsDir })).toThrow(
      "portable canonical id",
    );
    expect(fs.existsSync(path.join(agentsDir, "has.dot", "agent"))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, "octogee-ceckert-test-coach", "agent"))).toBe(false);
    expect(fs.existsSync(path.join(root, "outside", "agent"))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, "_not-an-id", "agent"))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, "legacy-agent", "agent"))).toBe(false);
  });

  it("creates a configured in-root custom agentDir instead of only the default agent path", () => {
    const { root, configPath, agentsDir } = fixture();
    const customAgentDir = path.join(root, "agents", "discord-helper", "runtime");
    fs.writeFileSync(configPath, JSON.stringify({
      agents: {
        list: [{
          id: "discord-helper",
          agentDir: customAgentDir,
          workspace: path.join(root, "workspaces", "discord-helper"),
        }],
      },
      session: { store: path.join(root, "agents", "{agentId}", "sessions", "sessions.json") },
    }));

    expect(ensureConfiguredAgentRuntimeDirs({
      configPath,
      agentsDir,
      stateDir: root,
    })).toEqual(["discord-helper"]);
    expect(fs.statSync(customAgentDir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(agentsDir, "discord-helper", "agent"))).toBe(false);
  });

  it("fails loudly when the durable config is malformed", () => {
    const { configPath, agentsDir } = fixture();
    fs.writeFileSync(configPath, "{");

    expect(() => ensureConfiguredAgentRuntimeDirs({ configPath, agentsDir })).toThrow(
      /invalid JSON/,
    );
  });
});
