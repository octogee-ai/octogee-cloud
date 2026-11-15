/**
 * Contract test for the plugin entry. Locks the invariants that bit the
 * mattermost-tools plugin: execute is a 2-arg fn `(toolCallId, params)` (no ctx
 * arg — ctx is captured by the per-invocation factory), and the manifest's
 * `contracts.tools` matches the names registered at runtime. vi.mocks the SDK
 * import; otherwise runs the real compiled module.
 */

import { describe, it, expect, vi } from "vitest";
import { WorkspaceToolError } from "../errors.js";

vi.mock("openclaw/plugin-sdk/core", () => ({
  definePluginEntry: (def: any) => def,
  jsonResult: (payload: unknown) => ({ result: payload }),
}));

interface RegisteredFactory {
  name: string;
  factory: (ctx: any) => any;
}

function buildFakeApi(pluginConfig: unknown = {}): { api: any; registered: RegisteredFactory[] } {
  const registered: RegisteredFactory[] = [];
  const api = {
    pluginConfig,
    logger: { info: () => {} },
    registerTool: (factory: (ctx: any) => any, opts: { name: string }) => {
      registered.push({ name: opts.name, factory });
    },
  };
  return { api, registered };
}

describe("plugin contract", () => {
  it("registers exactly workspace_commit", async () => {
    const { default: plugin } = await import("../index.js");
    const { api, registered } = buildFakeApi();
    plugin.register(api);
    expect(registered.map((r) => r.name)).toEqual(["workspace_commit"]);
  });

  it("does NOT throw on empty config — controlUrl defaults", async () => {
    const { default: plugin } = await import("../index.js");
    const { api } = buildFakeApi({});
    expect(() => plugin.register(api)).not.toThrow();
  });

  it("execute is a 2-arg function; factory takes exactly one ctx arg", async () => {
    const { default: plugin } = await import("../index.js");
    const { api, registered } = buildFakeApi();
    plugin.register(api);
    const r = registered[0]!;
    expect(r.factory.length).toBe(1);
    expect(r.factory({ agentId: "octogee-test-coach" }).execute.length).toBe(2);
  });

  it("execute returns a caught error envelope when the agent is not a managed agent (no throw, no network)", async () => {
    const { default: plugin } = await import("../index.js");
    const { api, registered } = buildFakeApi();
    plugin.register(api);
    const tool = registered[0]!.factory({ agentId: "not-a-default-agent" });
    const out = await tool.execute("call-1", {});
    expect(out.result.code).toBe("not-coach");
    expect(out.result.committed).toBe(false);
  });

  it("preserves failed binary paths in the tool error envelope", async () => {
    const { errorResult } = await import("../index.js");
    expect(errorResult(new WorkspaceToolError("control-error", "blob diversion failed", "BLOB_DIVERSION_FAILED", ["large.zip"])))
      .toEqual({
        result: {
          error: "workspace_commit failed: blob diversion failed",
          code: "control-error",
          edge_code: "BLOB_DIVERSION_FAILED",
          paths: ["large.zip"],
          committed: false,
          pushed: false,
        },
      });
  });

  it("openclaw.plugin.json contracts.tools matches the names registered at runtime", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "openclaw.plugin.json"), "utf8"),
    ) as { contracts?: { tools?: unknown } };
    expect(Array.isArray(manifest.contracts?.tools)).toBe(true);

    const { default: plugin } = await import("../index.js");
    const { api, registered } = buildFakeApi();
    plugin.register(api);
    expect((manifest.contracts!.tools as string[]).slice().sort()).toEqual(
      registered.map((r) => r.name).sort(),
    );
  });
});
