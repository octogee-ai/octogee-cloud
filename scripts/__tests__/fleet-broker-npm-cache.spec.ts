import { beforeEach, describe, expect, it, vi } from "vitest";

import { GATEWAY_CREDENTIAL_TOKEN_HEADER } from "@octogee/core/internal-fetch";
import { internalFetch } from "../lib/internal-fetch.js";
import { RETIRED_VM_BINDING_DENIAL_REASON } from "@octogee/shared/types/fleet-broker";
import {
  createFleetBrokerClient,
  isRetiredVmBindingDenial,
} from "../lib/fleet-broker-client.js";

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn() }));

describe("fleet broker npm cache client", () => {
  beforeEach(() => {
    vi.mocked(internalFetch).mockReset();
    process.env.OCTOGEE_API_URL = "http://broker";
  });

  it("requests an assignment-scoped capability with the purpose KSA credential", async () => {
    const credentials = {
      registryUrl: "http://octogee-npm-cache-proxy.shared-test.svc.cluster.local:3005/",
      token: "opaque-capability",
      expiresAt: "2026-08-30T12:10:00.000Z",
    };
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(JSON.stringify(credentials), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const gatewayCredentialHeaders = vi.fn(async () => ({
      [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
    }));

    await expect(createFleetBrokerClient("builder-alice", "builder-alice", {
      gatewayCredentialHeaders,
    }).npmRegistryCredentials("alice")).resolves.toEqual(credentials);
    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/npm-registry-credentials",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
        }),
        body: JSON.stringify({ gatewayId: "builder-alice", slug: "alice" }),
      }),
    );
  });

  it("requests held project reads with the purpose credential while keeping ordinary manifest reads on the assigned route", async () => {
    vi.mocked(internalFetch).mockImplementation(async () => new Response("{}", { status: 200 }));
    const client = createFleetBrokerClient("builder-alice", "builder-alice", { gatewayCredentialHeaders: async () => ({ [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt" }) });
    await client.workspaceManifestReadUrl({ slug: "alice", projectSlug: "app" });
    await client.blobMaterializationReadUrl({ slug: "alice", path: "projects/app/a.png", size: 3 });
    await client.workspaceManifestReadUrl({ slug: "alice" });
    const calls = vi.mocked(internalFetch).mock.calls;
    expect(calls.slice(0, 2).map(([url]) => url)).toEqual(["http://broker/internal/fleet/blob/materialization/manifest/read-url", "http://broker/internal/fleet/blob/materialization/read-url"]);
    for (const [, init] of calls.slice(0, 2)) expect(init?.headers).toMatchObject({ [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt" });
    expect(calls[2][0]).toBe("http://broker/internal/fleet/blob/manifest/read-url");
    expect(calls[2][1]?.headers).not.toHaveProperty(GATEWAY_CREDENTIAL_TOKEN_HEADER);
  });

  it("does not copy a failed broker response body into an exception", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ error: "opaque-capability-secret" }),
      { status: 503 },
    ));

    await expect(createFleetBrokerClient("builder-alice", "builder-alice", {
      gatewayCredentialHeaders: async () => ({
        [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
      }),
    }).npmRegistryCredentials("alice")).rejects.toThrow(
      "fleet-broker POST /internal/fleet/npm-registry-credentials → 503",
    );
  });

  it("recognizes a retired-vm tenant denial without copying the body into the message", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(
      JSON.stringify({
        error: `forbidden: ${RETIRED_VM_BINDING_DENIAL_REASON}`,
        code: "tenant-enforcement",
      }),
      { status: 403 },
    ));

    const failure = await createFleetBrokerClient("builder-alice", "builder-alice", {
      gatewayCredentialHeaders: async () => ({
        [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
      }),
    }).npmRegistryCredentials("alice").catch((error: unknown) => error);

    expect(isRetiredVmBindingDenial(failure)).toBe(true);
    expect((failure as Error).message).toBe(
      "fleet-broker POST /internal/fleet/npm-registry-credentials → 403",
    );
  });

  it("does not mistake an unassigned-User denial for retirement", async () => {
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ error: "forbidden" }),
      { status: 403 },
    ));

    const failure = await createFleetBrokerClient("builder-alice", "builder-alice", {
      gatewayCredentialHeaders: async () => ({
        [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
      }),
    }).npmRegistryCredentials("alice").catch((error: unknown) => error);

    expect(isRetiredVmBindingDenial(failure)).toBe(false);
  });
});
