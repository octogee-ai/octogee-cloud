import { beforeEach, describe, expect, it, vi } from "vitest";

const status = vi.hoisted(() => ({ fetch: vi.fn(), format: vi.fn() }));

vi.mock("openclaw/plugin-sdk/core", () => ({
  definePluginEntry: (definition: unknown) => definition,
  jsonResult: (payload: unknown) => ({ result: payload }),
}));

vi.mock("../status-client.js", async (importOriginal) => ({
  gatewayClassMismatchNote: (await importOriginal<typeof import("../status-client.js")>()).gatewayClassMismatchNote,
  StatusToolError: class StatusToolError extends Error { code = "unavailable"; },
  fetchAgentUsageStatus: status.fetch,
  formatStatusText: status.format,
}));

type ToolFactory = (context: Record<string, unknown>) => {
  execute: () => Promise<unknown>;
};

async function registeredFactory(): Promise<ToolFactory> {
  const { default: plugin } = await import("../index.js") as {
    default: { register: (api: unknown) => void };
  };
  let factory: ToolFactory | null = null;
  plugin.register({
    pluginConfig: { brokerUrl: "http://broker", tokenPath: "/token" },
    registerTool: (value: ToolFactory) => { factory = value; },
  });
  expect(factory).not.toBeNull();
  return factory!;
}

describe("octogee_status plugin contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports status for a turn with no Mattermost origin", async () => {
    const brokerStatus = { gatewayClass: "shared" };
    status.fetch.mockResolvedValue(brokerStatus);
    status.format.mockReturnValue("Shared gateway");
    const factory = await registeredFactory();

    const result = await factory({ agentId: "octogee-mira-coach" }).execute();

    expect(result).toEqual({ result: { status: brokerStatus, text: "Shared gateway" } });
    expect(status.fetch).toHaveBeenCalledWith({
      agentId: "octogee-mira-coach",
      brokerUrl: "http://broker",
      tokenPath: "/token",
    });
  });
});
