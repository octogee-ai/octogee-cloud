import { describe, expect, it, vi } from "vitest";
import { ProvisioningServiceError } from "@octogee/core/provisioning-service-client";
import { createProvisioningGitKeys, provisioningGitKeysFromEnvironment } from "./provisioning-git-keys.js";

const PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGatewayKey";

function client(respond: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: url as URL, init: init ?? {} });
    return respond(url as URL, init ?? {});
  });
  const keys = createProvisioningGitKeys({
    baseUrl: "http://provisioning.test:8080",
    tokenPath: "/var/run/token",
    fetch: fetch as unknown as typeof globalThis.fetch,
    readToken: async () => "sa-token",
  });
  return { keys, calls };
}

describe("createProvisioningGitKeys", () => {
  it("puts the key under the user and gateway with the service account token and returns the resource", async () => {
    const resource = { uid: "uid-alice", gatewayId: "shared-blue", generation: 1 };
    const { keys, calls } = client(() => new Response(JSON.stringify(resource), { status: 201 }));

    await expect(keys.put("uid-alice", "shared-blue", PUBLIC_KEY)).resolves.toEqual(resource);

    expect(calls).toHaveLength(1);
    expect(String(calls[0].url)).toBe("http://provisioning.test:8080/v1/users/uid-alice/git-keys/shared-blue");
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ spec: { publicKey: PUBLIC_KEY } });
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sa-token");
  });

  it("deletes the user's key for the gateway", async () => {
    const { keys, calls } = client(() => new Response(null, { status: 202 }));

    await keys.delete("uid-alice", "shared-blue");

    expect(calls[0].init.method).toBe("DELETE");
    expect(String(calls[0].url)).toBe("http://provisioning.test:8080/v1/users/uid-alice/git-keys/shared-blue");
  });

  it("throws the service's code, message and Retry-After without the token", async () => {
    const { keys } = client(() => new Response(JSON.stringify({ code: "unavailable", error: "draining" }), { status: 503, headers: { "retry-after": "7" } }));

    const error = await keys.put("uid-alice", "shared-blue", PUBLIC_KEY).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProvisioningServiceError);
    expect(error).toMatchObject({ status: 503, code: "unavailable", retryAfterMs: 7000, transient: true });
    expect(String((error as Error).message)).toContain("draining");
    expect(String((error as Error).message)).not.toContain("sa-token");
  });

  it("throws an unreachable error when the request fails", async () => {
    const { keys } = client(() => { throw new Error("connect ECONNREFUSED"); });

    await expect(keys.delete("uid-alice", "shared-blue")).rejects.toMatchObject({ code: "unreachable", transient: true });
  });

  it("refuses a uid it cannot address without calling the service", async () => {
    const { keys, calls } = client(() => new Response(null, { status: 202 }));

    await expect(keys.delete("..", "shared-blue")).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(0);
  });
});

describe("provisioningGitKeysFromEnvironment", () => {
  it("is off without a provisioning service URL", () => {
    expect(provisioningGitKeysFromEnvironment({})).toBeNull();
  });

  it("is on with a URL and a token path", () => {
    expect(provisioningGitKeysFromEnvironment({ PROVISIONING_SERVICE_URL: "http://p.test", PROVISIONING_SERVICE_TOKEN_PATH: "/t" })).not.toBeNull();
  });
});
