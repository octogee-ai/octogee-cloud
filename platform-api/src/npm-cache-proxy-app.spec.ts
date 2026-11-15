import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { NpmCacheCapabilityAuthorization } from "./lib/npm-cache-capabilities.js";
import {
  createNpmCacheProxyApp,
  safeRegistryTarget,
  type NpmCacheProxyEvent,
} from "./npm-cache-proxy-app.js";

const CAPABILITY = "c".repeat(43);
const GOOGLE_TOKEN = "google-access-token-secret";
const NOW = Date.parse("2026-08-30T12:00:00.000Z");

function authorization(overrides: Partial<NpmCacheCapabilityAuthorization> = {}) {
  return {
    gatewayId: "builder-alice",
    uid: "uid-alice",
    slug: "alice",
    podUid: "pod-alice",
    audience: "octogee-npm-cache-proxy" as const,
    expiresAt: "2026-08-30T12:10:00.000Z",
    maxRequests: 4_096,
    ...overrides,
  };
}

function proxy(overrides: {
  authorizeCapability?: (token: string) => Promise<NpmCacheCapabilityAuthorization | null>;
  artifactRegistryAccessToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  reportEvent?: (event: NpmCacheProxyEvent) => void;
  now?: () => number;
  upstreamRegistryUrl?: string;
} = {}) {
  return createNpmCacheProxyApp({
    authorizeCapability: overrides.authorizeCapability ?? vi.fn(async () => authorization()),
    artifactRegistryAccessToken: overrides.artifactRegistryAccessToken ??
      vi.fn(async () => GOOGLE_TOKEN),
    upstreamRegistryUrl: overrides.upstreamRegistryUrl ??
      "https://us-central1-npm.pkg.dev/example-project/npm-cache/",
    fetchImpl: overrides.fetchImpl ?? vi.fn(async () => new Response("ok", {
      headers: { "content-type": "text/plain", etag: "cache-hit" },
    })),
    reportEvent: overrides.reportEvent,
    now: overrides.now ?? (() => NOW),
  });
}

describe("npm cache proxy", () => {
  it("serves health without accepting a registry request", async () => {
    const response = await request(proxy()).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects missing capabilities and non-read registry methods", async () => {
    await request(proxy()).get("/@scope%2fpkg").expect(403);
    await request(proxy()).post("/@scope%2fpkg").set("authorization", `Bearer ${CAPABILITY}`).expect(405);
  });

  it("replaces the opaque user capability with the proxy Google token", async () => {
    const authorizeCapability = vi.fn(async () => authorization());
    const fetchImpl = vi.fn<typeof fetch>(async (_input, _init) =>
      new Response(JSON.stringify({ name: "@scope/pkg" }), {
        headers: { "content-type": "application/json", etag: "remote-cache" },
      }));
    const response = await request(proxy({ authorizeCapability, fetchImpl }))
      .get("/@scope%2fpkg?write=false")
      .set("authorization", `Bearer ${CAPABILITY}`)
      .set("if-none-match", "remote-cache");

    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe("remote-cache");
    expect(authorizeCapability).toHaveBeenCalledWith(CAPABILITY);
    const [target, init] = fetchImpl.mock.calls[0]!;
    expect(String(target)).toBe(
      "https://us-central1-npm.pkg.dev/example-project/npm-cache/@scope%2fpkg?write=false",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${GOOGLE_TOKEN}`);
    expect(new Headers(init?.headers).get("if-none-match")).toBe("remote-cache");
    expect(JSON.stringify(init)).not.toContain(CAPABILITY);
  });

  it("deduplicates authorization and enforces the broker request scope", async () => {
    const authorizeCapability = vi.fn(async () => authorization({ maxRequests: 2 }));
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const reportEvent = vi.fn();
    const app = proxy({ authorizeCapability, fetchImpl, reportEvent });

    await request(app).get("/a").set("authorization", `Bearer ${CAPABILITY}`).expect(200);
    await request(app).get("/b").set("authorization", `Bearer ${CAPABILITY}`).expect(200);
    await request(app).get("/c").set("authorization", `Bearer ${CAPABILITY}`).expect(429);

    expect(authorizeCapability).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reportEvent.mock.calls.slice(0, 2).map(([event]) => event.authorizationCache))
      .toEqual(["cold", "warm"]);
  });

  it("rejects an expired or wrong-audience authorization", async () => {
    const expired = await request(proxy({
      authorizeCapability: vi.fn(async () => authorization({ expiresAt: new Date(NOW).toISOString() })),
    })).get("/pkg").set("authorization", `Bearer ${CAPABILITY}`);

    const wrongAudience = await request(proxy({
      authorizeCapability: vi.fn(async () => ({
        ...authorization(),
        audience: "another-service" as never,
      })),
    })).get("/pkg").set("authorization", `Bearer ${CAPABILITY}`);

    expect([expired.status, wrongAudience.status]).toEqual([403, 403]);
  });

  it("returns a generic upstream failure without logging either credential", async () => {
    const reportEvent = vi.fn();
    const response = await request(proxy({
      fetchImpl: vi.fn(async () => {
        throw new Error(`${CAPABILITY} ${GOOGLE_TOKEN}`);
      }),
      reportEvent,
    })).get("/pkg").set("authorization", `Bearer ${CAPABILITY}`);

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "npm_cache_upstream_unavailable" });
    expect(JSON.stringify(response.body)).not.toContain(CAPABILITY);
    expect(JSON.stringify(reportEvent.mock.calls)).not.toContain(CAPABILITY);
    expect(JSON.stringify(reportEvent.mock.calls)).not.toContain(GOOGLE_TOKEN);
    expect(reportEvent).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "upstream-error",
      reason: "Error",
    }));
  });

  it("never turns an absolute or traversal target into an upstream request", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const app = proxy({ fetchImpl });

    await request(app).get("//example.com/pkg").set("authorization", `Bearer ${CAPABILITY}`).expect(404);
    expect(safeRegistryTarget(
      "/%2e%2e/secrets",
      "https://us-central1-npm.pkg.dev/example-project/npm-cache/",
    )).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses to send its Google credential to any other upstream", () => {
    expect(() => createNpmCacheProxyApp({
      authorizeCapability: vi.fn(async () => authorization()),
      artifactRegistryAccessToken: vi.fn(async () => GOOGLE_TOKEN),
      upstreamRegistryUrl: "https://attacker.example/npm/",
    })).toThrow("invalid npm cache upstream registry");
  });

  it("forwards to any Artifact Registry npm repository it is configured with", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("ok"));
    await request(proxy({
      fetchImpl,
      upstreamRegistryUrl: "https://europe-west4-npm.pkg.dev/other-project-42/team-npm/",
    }))
      .get("/@scope%2fpkg")
      .set("authorization", `Bearer ${CAPABILITY}`)
      .expect(200);

    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "https://europe-west4-npm.pkg.dev/other-project-42/team-npm/@scope%2fpkg",
    );
  });

  it.each([
    "http://us-central1-npm.pkg.dev/example-project/npm-cache/",
    "https://us-central1-docker.pkg.dev/example-project/npm-cache/",
    "https://us-central1-npm.pkg.dev.attacker.example/example-project/npm-cache/",
    "https://us-central1-npm.pkg.dev/example-project/",
    "https://us-central1-npm.pkg.dev/example-project/npm-cache/nested/",
    "https://us-central1-npm.pkg.dev/example-project/npm-cache",
    "https://us-central1-npm.pkg.dev:8443/example-project/npm-cache/",
    "https://us-central1-npm.pkg.dev/example-project/npm-cache/?x=1",
  ])("refuses the non-repository upstream %s", (upstreamRegistryUrl) => {
    expect(() => proxy({ upstreamRegistryUrl })).toThrow("invalid npm cache upstream registry");
  });
});
