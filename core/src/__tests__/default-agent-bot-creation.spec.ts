import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVISION_SRC = path.resolve(__dirname, "../mattermost/provision.ts");
const CHANNEL_HOST_SRC = path.resolve(__dirname, "../channel-host/mattermost.ts");

describe("coach is a MM bot — creation contract", () => {
  it("provision.ts creates the agent as a bot, not a user", () => {
    const src = fs.readFileSync(PROVISION_SRC, "utf-8");

    const defaultAgentIdx = src.indexOf("const defaultAgentUsername = `${slug}-coach`");
    expect(defaultAgentIdx).toBeGreaterThan(-1);

    const botCreateIdx = src.indexOf("host.ensureBot(", defaultAgentIdx);
    expect(botCreateIdx).toBeGreaterThan(defaultAgentIdx);

    const userCreateAfterDefaultAgent = src.indexOf("host.ensureUser(", defaultAgentIdx);
    expect(userCreateAfterDefaultAgent).toBe(-1);
  });

  it("the Mattermost channel host creates bots via POST /bots with display_name", () => {
    const src = fs.readFileSync(CHANNEL_HOST_SRC, "utf-8");
    const ensureBotIdx = src.indexOf("async ensureBot(");
    expect(ensureBotIdx).toBeGreaterThan(-1);
    const block = src.slice(ensureBotIdx, src.indexOf("ensureChannel:", ensureBotIdx));
    expect(block).toMatch(/"POST", "\/bots"/);
    expect(block).toMatch(/display_name:\s*displayName/);
    expect(block).not.toMatch(/first_name:/);
    expect(block).not.toMatch(/nickname:/);
  });

  it("provision.ts passes display_name (not first_name/nickname) on bot create", () => {
    const src = fs.readFileSync(PROVISION_SRC, "utf-8");
    const defaultAgentIdx = src.indexOf("const defaultAgentUsername = `${slug}-coach`");
    const blockEnd = src.indexOf("if (!defaultAgentMmUser)", defaultAgentIdx);
    const block = src.slice(defaultAgentIdx, blockEnd);
    expect(block).toMatch(/displayName:\s*"Octo"/);
    expect(block).not.toMatch(/firstName:/);
    expect(block).not.toMatch(/nickname:/);
  });
});
