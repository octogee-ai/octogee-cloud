import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

type Template = {
  agents: { defaults: { verboseDefault?: string } };
  channels?: { mattermost?: { replyToMode?: string; streaming?: unknown } };
};

function read(name: string): Template {
  return JSON.parse(readFileSync(path.join(repoRoot, "gateway", name), "utf8")) as Template;
}

describe("gateway templates — chat progress surface", () => {
  it.each(["openclaw.template.json", "openclaw.isolated.template.json"])(
    "%s keeps native verbose tool summaries out of chat",
    (name) => {
      expect(read(name).agents.defaults.verboseDefault).toBe("off");
    },
  );

  it.each(["openclaw.template.json", "openclaw.isolated.template.json"])(
    "%s keeps the Mattermost draft preview carrying tool progress and leaves the reply and streaming modes to the gateway values",
    (name) => {
      const mattermost = read(name).channels?.mattermost;
      expect(mattermost).not.toHaveProperty("replyToMode");
      expect(mattermost?.streaming).toEqual({
        preview: { toolProgress: true },
        progress: { toolProgress: true },
      });
    },
  );
});
