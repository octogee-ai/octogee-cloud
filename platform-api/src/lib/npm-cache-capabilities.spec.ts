import { describe, expect, it } from "vitest";

import {
  InMemoryNpmCacheCapabilityStore,
  NPM_CACHE_CAPABILITY_AUDIENCE,
  NPM_CACHE_CAPABILITY_ISSUE_INTERVAL_MS,
  NPM_CACHE_CAPABILITY_MAX_REQUESTS,
  NPM_CACHE_CAPABILITY_TTL_MS,
  NpmCacheCapabilityIssueError,
  npmCacheCapabilityDigest,
  npmCacheProxyRegistryUrl,
} from "./npm-cache-capabilities.js";

const NOW = Date.parse("2026-08-30T12:00:00.000Z");
const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);
const subject = {
  gatewayId: "builder-alice",
  uid: "uid-alice",
  slug: "alice",
  podUid: "pod-uid-alice",
};

describe("npm cache capabilities", () => {
  it("issues an audience-bound ten-minute capability and stores it by digest", () => {
    const store = new InMemoryNpmCacheCapabilityStore(() => TOKEN_A);
    const credentials = store.issue({
      subject,
      registryUrl: npmCacheProxyRegistryUrl("octogee-test"),
      nowMs: NOW,
    });

    expect(credentials).toEqual({
      registryUrl: "http://octogee-npm-cache-proxy.octogee-test.svc.cluster.local:3005/",
      token: TOKEN_A,
      expiresAt: new Date(NOW + NPM_CACHE_CAPABILITY_TTL_MS).toISOString(),
    });
    expect(npmCacheCapabilityDigest(TOKEN_A)).toMatch(/^[a-f0-9]{64}$/u);
    expect(store.authorize({ token: TOKEN_A, nowMs: NOW })).toEqual({
      ...subject,
      audience: NPM_CACHE_CAPABILITY_AUDIENCE,
      expiresAt: credentials.expiresAt,
      maxRequests: NPM_CACHE_CAPABILITY_MAX_REQUESTS,
    });
    expect(store.authorize({ token: "z".repeat(43), nowMs: NOW })).toBeNull();
  });

  it("expires capabilities exactly at their boundary", () => {
    const store = new InMemoryNpmCacheCapabilityStore(() => TOKEN_A);
    store.issue({ subject, registryUrl: npmCacheProxyRegistryUrl(), nowMs: NOW });

    expect(store.authorize({ token: TOKEN_A, nowMs: NOW + NPM_CACHE_CAPABILITY_TTL_MS - 1 }))
      .not.toBeNull();
    expect(store.authorize({ token: TOKEN_A, nowMs: NOW + NPM_CACHE_CAPABILITY_TTL_MS }))
      .toBeNull();
  });

  it("rate-limits issuance and invalidates the prior subject capability on rotation", () => {
    const tokens = [TOKEN_A, TOKEN_B];
    const store = new InMemoryNpmCacheCapabilityStore(() => tokens.shift()!);
    store.issue({ subject, registryUrl: npmCacheProxyRegistryUrl(), nowMs: NOW });

    expect(() => store.issue({
      subject,
      registryUrl: npmCacheProxyRegistryUrl(),
      nowMs: NOW + NPM_CACHE_CAPABILITY_ISSUE_INTERVAL_MS - 1,
    })).toThrowError(NpmCacheCapabilityIssueError);

    const replacement = store.issue({
      subject,
      registryUrl: npmCacheProxyRegistryUrl(),
      nowMs: NOW + NPM_CACHE_CAPABILITY_ISSUE_INTERVAL_MS,
    });
    expect(replacement.token).toBe(TOKEN_B);
    expect(store.authorize({ token: TOKEN_A, nowMs: NOW + NPM_CACHE_CAPABILITY_ISSUE_INTERVAL_MS }))
      .toBeNull();
    expect(store.authorize({ token: TOKEN_B, nowMs: NOW + NPM_CACHE_CAPABILITY_ISSUE_INTERVAL_MS }))
      .not.toBeNull();
  });

  it("bounds live capabilities and reclaims expired entries", () => {
    const tokens = [TOKEN_A, TOKEN_B];
    const store = new InMemoryNpmCacheCapabilityStore(() => tokens.shift()!, 1);
    const first = store.issue({
      subject,
      registryUrl: npmCacheProxyRegistryUrl(),
      nowMs: NOW,
    });
    const bob = { ...subject, uid: "uid-bob", slug: "bob", podUid: "pod-bob" };

    expect(() => store.issue({
      subject: bob,
      registryUrl: npmCacheProxyRegistryUrl(),
      nowMs: NOW + NPM_CACHE_CAPABILITY_ISSUE_INTERVAL_MS,
    })).toThrowError(expect.objectContaining({ reasonCode: "capacity-exhausted" }));

    const second = store.issue({
      subject: bob,
      registryUrl: npmCacheProxyRegistryUrl(),
      nowMs: NOW + NPM_CACHE_CAPABILITY_TTL_MS,
    });
    expect(second.token).toBe(TOKEN_B);
    expect(store.authorize({ token: first.token, nowMs: NOW + NPM_CACHE_CAPABILITY_TTL_MS }))
      .toBeNull();
  });
});
