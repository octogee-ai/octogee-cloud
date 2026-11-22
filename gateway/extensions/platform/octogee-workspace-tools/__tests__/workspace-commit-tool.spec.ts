import { describe, expect, it, vi } from "vitest";

const PUSHED = "0123456789abcdef0123456789abcdef01234567";
const commit = vi.fn();

vi.mock("openclaw/plugin-sdk/core", () => ({
  definePluginEntry: (def: unknown) => def,
  jsonResult: (payload: unknown) => ({ result: payload }),
}));
vi.mock("../commit-client.js", () => ({
  DEFAULT_CONTROL_URL: "http://127.0.0.1:3001",
  createCommitClient: () => ({ commit }),
}));

describe("workspace_commit", () => {
  it("returns the pushed commit so a later tool call can name it", async () => {
    commit.mockResolvedValueOnce({ committed: true, pushed: true, nothingToCommit: false, commit: PUSHED, divertedBlobs: 0 });
    const { default: plugin } = await import("../index.js");
    const tools: Array<(ctx: unknown) => { execute(id: string, params: Record<string, unknown>): Promise<unknown> }> = [];
    plugin.register({ pluginConfig: {}, registerTool: (factory: (typeof tools)[number]) => tools.push(factory) } as never);

    const out = await tools[0]!({ agentId: "octogee-acme-coach" }).execute("call-1", {});

    expect(out).toEqual({
      result: { committed: true, pushed: true, nothing_to_commit: false, commit: PUSHED, diverted_blobs: 0 },
    });
  });
});
