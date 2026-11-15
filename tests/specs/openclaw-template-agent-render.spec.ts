import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");
const templateRaw = readFileSync(
  path.join(repoRoot, "gateway/openclaw.template.json"),
  "utf8",
);

describe("openclaw.template.json agent bootstrap", () => {
  it("starts without a permanent platform persona or operator-id placeholders", () => {
    const template = JSON.parse(templateRaw) as {
      agents: { entries: Record<string, unknown> };
      channels: { mattermost: { accounts: Record<string, unknown>; defaultAccount?: string } };
    };

    expect(template.agents.entries).toEqual({});
    expect(template.channels.mattermost.accounts).toEqual({});
    expect(template.channels.mattermost).not.toHaveProperty("defaultAccount");
    expect(templateRaw).not.toContain("OPERATOR_AGENT_ID");
    expect(templateRaw).not.toContain("OPERATOR_AGENT_SLUG");
    expect(templateRaw).not.toContain("Mac");
  });
});
