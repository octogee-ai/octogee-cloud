import { beforeEach, describe, expect, it, vi } from "vitest";

import { internalFetch } from "../lib/internal-fetch.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn() }));
vi.mock("@octogee/core/internal-fetch", () => ({
  gatewayCredentialHeaders: vi.fn(async () => ({
    "x-octogee-gateway-credential-token": "credential-token",
  })),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fleet broker GitHub sync token", () => {
  beforeEach(() => {
    vi.mocked(internalFetch).mockReset();
    delete process.env.FLEET_BROKER_URL;
    process.env.OCTOGEE_API_URL = "http://broker";
  });

  it("uses the gateway credential to read the owner's GitHub sync token", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(jsonResponse({ accessToken: "ghu_user" }));
    const gatewayCredentialHeaders = vi.fn(async () => ({
      "x-octogee-gateway-credential-token": "credential-token",
    }));

    await expect(
      createFleetBrokerClient("walter", "walter-r9", { gatewayCredentialHeaders })
        .githubTokenForSync("uid-alice"),
    ).resolves.toBe("ghu_user");
    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/connectors/access-token",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-octogee-gateway-credential-token": "credential-token",
        }),
        body: JSON.stringify({ gatewayId: "walter", uid: "uid-alice", connectorId: "github" }),
      }),
    );
  });

  it("does not treat a broker failure as an unconnected account", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(jsonResponse({ error: "boom" }, 500));

    await expect(
      createFleetBrokerClient("walter", "walter-r9").githubTokenForSync("uid-alice"),
    ).rejects.toThrow();
  });
});
