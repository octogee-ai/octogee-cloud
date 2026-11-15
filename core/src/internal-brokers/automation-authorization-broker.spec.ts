import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizeAutomationOwner,
  automationAuthorizationBrokerBaseUrlFromEnv,
} from "./automation-authorization-broker.js";

const dirs: string[] = [];
const DEFAULT_AGENT_CHANNEL_ID = "c".repeat(26);

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function projectedTokenPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-auth-broker-"));
  dirs.push(dir);
  const tokenPath = path.join(dir, "token");
  fs.writeFileSync(tokenPath, "gateway-service-account-token\n");
  return tokenPath;
}

describe("automation authorization broker client", () => {
  it("forwards both identities only to same-namespace octogee-api and forbids redirects", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(init).toEqual(expect.objectContaining({ method: "POST", redirect: "error" }));
      return new Response(
        JSON.stringify({
          slug: "eggman",
          gatewayId: "eggman-devdays",
          coachChannelId: DEFAULT_AGENT_CHANNEL_ID,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await authorizeAutomationOwner({
      gatewayId: "eggman-devdays",
      authorization: "Bearer firebase-id-token",
      baseUrl: "http://octogee-api.octogee-test.svc.cluster.local:3001",
      env: { K8S_NAMESPACE: "octogee-test" },
      tokenPath: projectedTokenPath(),
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toEqual({
      kind: "authorized",
      slug: "eggman",
      gatewayId: "eggman-devdays",
      coachChannelId: DEFAULT_AGENT_CHANNEL_ID,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://octogee-api.octogee-test.svc.cluster.local:3001/internal/automations/authorize",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer firebase-id-token");
    expect(headers.get("x-k8s-sa-token")).toBe("gateway-service-account-token");
    expect(JSON.parse(String(init.body))).toEqual({ gatewayId: "eggman-devdays" });
  });

  it.each([
    [401, { kind: "unauthenticated" }],
    [403, { kind: "forbidden" }],
    [404, { kind: "not_found" }],
    [409, { kind: "coach_channel_not_ready" }],
  ] as const)("maps broker status %s without granting access", async (status, expected) => {
    const result = await authorizeAutomationOwner({
      gatewayId: "eggman-devdays",
      authorization: "Bearer firebase-id-token",
      baseUrl: "http://octogee-api",
      tokenPath: projectedTokenPath(),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: "denied" }), { status })) as typeof fetch,
    });

    expect(result).toEqual(expected);
  });

  it("rejects malformed success data instead of trusting a gateway or slug mismatch", async () => {
    await expect(authorizeAutomationOwner({
      gatewayId: "eggman-devdays",
      authorization: "Bearer firebase-id-token",
      baseUrl: "http://octogee-api",
      tokenPath: projectedTokenPath(),
      fetchImpl: vi.fn(async () => new Response(
        JSON.stringify({ slug: "someone-else", gatewayId: "default" }),
        { status: 200 },
      )) as typeof fetch,
    })).rejects.toThrow("malformed authorization response");
  });

  it("rejects authorization success without an authoritative agent channel", async () => {
    await expect(authorizeAutomationOwner({
      gatewayId: "eggman-devdays",
      authorization: "Bearer firebase-id-token",
      baseUrl: "http://octogee-api",
      tokenPath: projectedTokenPath(),
      fetchImpl: vi.fn(async () => new Response(
        JSON.stringify({ slug: "eggman", gatewayId: "eggman-devdays" }),
        { status: 200 },
      )) as typeof fetch,
    })).rejects.toThrow("malformed authorization response");
  });

  it("rejects a brokered agent channel outside the Mattermost ID contract", async () => {
    await expect(authorizeAutomationOwner({
      gatewayId: "eggman-devdays",
      authorization: "Bearer firebase-id-token",
      baseUrl: "http://octogee-api",
      tokenPath: projectedTokenPath(),
      fetchImpl: vi.fn(async () => new Response(
        JSON.stringify({
          slug: "eggman",
          gatewayId: "eggman-devdays",
          coachChannelId: "mm-coach-eggman",
        }),
        { status: 200 },
      )) as typeof fetch,
    })).rejects.toThrow("malformed authorization response");
  });

  it("refuses to send caller and gateway credentials to an untrusted broker host", () => {
    expect(() => automationAuthorizationBrokerBaseUrlFromEnv({
      OPENCLAW_RUNTIME_BROKER_URL: "https://attacker.example",
    })).toThrow("must target octogee-api or localhost");
  });

  it("refuses an octogee-api FQDN in any namespace except this pod's namespace", () => {
    expect(() => automationAuthorizationBrokerBaseUrlFromEnv({
      K8S_NAMESPACE: "octogee-test",
      OPENCLAW_RUNTIME_BROKER_URL: "http://octogee-api.octogee.svc.cluster.local:3001",
    })).toThrow("must target octogee-api or localhost");
  });

  it("bounds a broker fetch even when the fetch implementation ignores abort", async () => {
    vi.useFakeTimers();
    const pending = authorizeAutomationOwner({
      gatewayId: "eggman-devdays",
      authorization: "Bearer firebase-id-token",
      baseUrl: "http://octogee-api",
      tokenPath: projectedTokenPath(),
      timeoutMs: 5_000,
      fetchImpl: vi.fn(() => new Promise(() => undefined)) as typeof fetch,
    });
    const rejected = expect(pending).rejects.toThrow("timed out after 5000ms");

    await vi.advanceTimersByTimeAsync(5_000);

    await rejected;
  });
});
