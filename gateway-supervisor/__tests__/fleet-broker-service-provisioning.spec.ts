import { beforeEach, describe, expect, it, vi } from "vitest";

import { internalFetch } from "../lib/internal-fetch.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn() }));
vi.mock("@octogee/core/internal-fetch", () => ({
  gatewayCredentialHeaders: vi.fn(async () => ({})),
}));

function pending(reason: unknown, retryAfter: string | null): Response {
  return new Response(JSON.stringify({ error: "provisioning_pending", reason }), {
    status: 503,
    headers: { "Content-Type": "application/json", ...(retryAfter === null ? {} : { "Retry-After": retryAfter }) },
  });
}

describe("fleet broker provisioning service routes", () => {
  const client = () => createFleetBrokerClient("shared-blue");

  beforeEach(() => {
    vi.mocked(internalFetch).mockReset();
    delete process.env.FLEET_BROKER_URL;
    process.env.OCTOGEE_API_URL = "http://broker";
  });

  it("reads readiness as ready on 204", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(client().provisioningReadiness("uid-lin")).resolves.toEqual({ ready: true });
    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/provisioning-readiness",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ gatewayId: "shared-blue", uid: "uid-lin" }) }),
    );
  });

  it("reads a 503 as not ready with its reason and Retry-After", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(pending("GitRepositoryFailed", "12"));

    await expect(client().provisioningReadiness("uid-lin")).resolves.toEqual({ ready: false, reason: "GitRepositoryFailed", retryAfterMs: 12_000 });
  });

  it("names a 503 without a reason instead of inventing one", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response("busy", { status: 503 }));

    await expect(client().provisioningReadiness("uid-lin")).resolves.toEqual({
      ready: false,
      reason: "fleet-broker POST /internal/fleet/provisioning-readiness answered 503 without a reason",
      retryAfterMs: 5_000,
    });
  });

  it("reads a 422 provisioning_refused as a refusal no retry can finish", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: "provisioning_refused", reason: "UserBeingErased" }), { status: 422 }));

    await expect(client().provisioningReadiness("uid-lin")).resolves.toEqual({ ready: false, refused: true, reason: "UserBeingErased" });
  });

  it("throws any other refusal", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));

    await expect(client().provisioningReadiness("uid-lin")).rejects.toMatchObject({ status: 403 });
  });

  it("sends the public key to register and reads its answer", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(pending("GenerationNotObserved", "5"));

    await expect(client().registerGitKey("uid-lin", "ssh-ed25519 AAAA")).resolves.toEqual({ ready: false, reason: "GenerationNotObserved", retryAfterMs: 5_000 });
    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/git-key",
      expect.objectContaining({ body: JSON.stringify({ gatewayId: "shared-blue", uid: "uid-lin", publicKey: "ssh-ed25519 AAAA" }) }),
    );
  });

  it("releases the gateway's key naming the public key it releases, and throws when the broker refuses", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client().releaseGitKey("uid-lin", "ssh-ed25519 AAAA");
    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/git-key/release",
      expect.objectContaining({ body: JSON.stringify({ gatewayId: "shared-blue", uid: "uid-lin", publicKey: "ssh-ed25519 AAAA" }) }),
    );

    vi.mocked(internalFetch).mockResolvedValueOnce(new Response("down", { status: 502 }));
    await expect(client().releaseGitKey("uid-lin", "ssh-ed25519 AAAA")).rejects.toMatchObject({ status: 502 });
  });
});
