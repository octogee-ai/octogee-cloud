import { describe, expect, it, vi } from "vitest";

import { WebToolError, createWebClient } from "../web-client.js";

describe("web tools fleet-broker client", () => {
  it("sends the trusted agent and tool-call identity to the fixed search route", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ provider: "brave", results: [] }), { status: 200 }),
    );
    const client = createWebClient({
      brokerUrl: "http://broker.test:3001/",
      gatewayId: "shared-blue",
      fetchImpl,
      tokenProvider: async () => "ksa-token",
    });
    await client.search({
      agentId: "octogee-bob-coach",
      requestId: "tool-1",
      provider: "brave",
      query: "octopus",
      count: 5,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://broker.test:3001/internal/fleet/agent/web-search",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", "X-K8s-Sa-Token": "ksa-token" },
        body: JSON.stringify({
          gatewayId: "shared-blue",
          agentId: "octogee-bob-coach",
          requestId: "tool-1",
          provider: "brave",
          query: "octopus",
          count: 5,
        }),
      }),
    );
  });

  it("uses the extract route and preserves bounded server error codes", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: "allowance_exhausted", error: "Platform allowance exhausted" }),
        { status: 429 },
      ),
    );
    const client = createWebClient({
      gatewayId: "shared-blue",
      fetchImpl,
      tokenProvider: async () => "token",
    });
    await expect(
      client.extract({
        agentId: "octogee-bob-coach",
        requestId: "tool-2",
        urls: ["https://example.com"],
      }),
    ).rejects.toMatchObject({
      code: "allowance_exhausted",
      message: "Platform allowance exhausted",
    });
    expect(String(fetchImpl.mock.calls[0][0])).toContain("/internal/fleet/agent/web-extract");
  });

  it("fails before the network when agent identity or projected auth is unavailable", async () => {
    const fetchImpl = vi.fn();
    const client = createWebClient({
      gatewayId: "shared-blue",
      fetchImpl,
      tokenProvider: async () => null,
    });
    await expect(
      client.search({ agentId: undefined, requestId: "tool-1", provider: "brave", query: "x" }),
    ).rejects.toMatchObject({ code: "no-agent" });
    await expect(
      client.search({
        agentId: "octogee-bob-coach",
        requestId: "tool-1",
        provider: "brave",
        query: "x",
      }),
    ).rejects.toMatchObject({ code: "auth-unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not expose a raw non-JSON upstream body", async () => {
    const client = createWebClient({
      gatewayId: "shared-blue",
      fetchImpl: vi.fn(async () => new Response("secret upstream detail", { status: 502 })),
      tokenProvider: async () => "token",
    });
    await expect(
      client.search({
        agentId: "octogee-bob-coach",
        requestId: "tool-1",
        provider: "brave",
        query: "x",
      }),
    ).rejects.toEqual(new WebToolError("control-error", "web broker call failed (502)"));
  });

  it("uses the namespace-qualified broker fallback and requires gateway identity", async () => {
    const original = { ...process.env };
    try {
      delete process.env.FLEET_BROKER_URL;
      delete process.env.OCTOGEE_API_URL;
      delete process.env.GATEWAY_ID;
      process.env.K8S_NAMESPACE = "octogee-test";
      const fetchImpl = vi.fn();
      const client = createWebClient({ fetchImpl, tokenProvider: async () => "token" });

      await expect(
        client.search({
          agentId: "octogee-bob-coach",
          requestId: "tool-1",
          provider: "brave",
          query: "octopus",
        }),
      ).rejects.toMatchObject({ code: "auth-unavailable" });
      expect(fetchImpl).not.toHaveBeenCalled();

      process.env.GATEWAY_ID = "shared-blue";
      const configuredFetch = vi.fn(async () =>
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      const configured = createWebClient({
        fetchImpl: configuredFetch,
        tokenProvider: async () => "token",
      });
      await configured.search({
        agentId: "octogee-bob-coach",
        requestId: "tool-2",
        provider: "brave",
        query: "octopus",
      });
      expect(String(configuredFetch.mock.calls[0][0])).toBe(
        "http://octogee-api.octogee-test.svc.cluster.local:3001/internal/fleet/agent/web-search",
      );
    } finally {
      process.env = original;
    }
  });
});
