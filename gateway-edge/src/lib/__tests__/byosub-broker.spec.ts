import { afterEach, describe, expect, it, vi } from "vitest";

const internalFetch = vi.fn();
vi.mock("@octogee/core/internal-fetch", () => ({
  internalFetch: (...args: unknown[]) => internalFetch(...args),
}));

import { readByosubFlow, resolveByosubUserGateway } from "../byosub-broker.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("byosub sidecar broker", () => {
  afterEach(() => {
    internalFetch.mockReset();
    delete process.env.FLEET_BROKER_URL;
    delete process.env.OCTOGEE_API_URL;
  });

  it("resolves only the local user's assigned gateway through the byosub broker", async () => {
    process.env.FLEET_BROKER_URL = "http://octogee-api.octogee.svc.cluster.local:3001///";
    internalFetch.mockResolvedValue(
      jsonResponse({
        user: {
          uid: "uid-tester5",
          slug: "tester5",
          gatewayId: "walter",
          refProvider: "anthropic",
        },
      }),
    );

    await expect(resolveByosubUserGateway("uid-tester5")).resolves.toEqual({
      slug: "tester5",
      gatewayId: "walter",
      refProvider: "anthropic",
    });
    expect(internalFetch).toHaveBeenCalledWith(
      "http://octogee-api.octogee.svc.cluster.local:3001/internal/byok/byosub-user",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ uid: "uid-tester5" }) }),
      {},
    );
  });

  it("reads a flow only from the KSA-authorized byosub broker", async () => {
    process.env.FLEET_BROKER_URL = "http://octogee-api.octogee.svc.cluster.local:3001";
    internalFetch.mockResolvedValue(
      jsonResponse({
        flow: {
          uid: "uid-tester5",
          gatewayId: "walter",
          agentId: "octogee-tester5-coach",
          provider: "openai",
          modelCredentialProvider: "openai-codex",
        },
      }),
    );

    await expect(readByosubFlow("flow-abc123")).resolves.toMatchObject({
      uid: "uid-tester5",
      gatewayId: "walter",
      provider: "openai",
    });
    expect(internalFetch).toHaveBeenCalledWith(
      "http://octogee-api.octogee.svc.cluster.local:3001/internal/byok/byosub-flow-read",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ flowId: "flow-abc123" }) }),
      {},
    );
  });
});
