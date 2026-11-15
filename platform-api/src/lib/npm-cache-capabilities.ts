import { createHash, randomBytes } from "node:crypto";

import type { FleetBrokerNpmRegistryCredentials } from "@octogee/shared/types/fleet-broker";

export const NPM_CACHE_CAPABILITY_AUDIENCE = "octogee-npm-cache-proxy";
export const NPM_CACHE_CAPABILITY_TTL_MS = 10 * 60_000;
export const NPM_CACHE_CAPABILITY_MAX_REQUESTS = 4_096;
export const NPM_CACHE_CAPABILITY_ISSUE_INTERVAL_MS = 5_000;
export const NPM_CACHE_CAPABILITY_MAX_STORED = 4_096;

export interface NpmCacheCapabilitySubject {
  gatewayId: string;
  uid: string;
  slug: string;
  podUid: string;
}

export interface NpmCacheCapabilityAuthorization extends NpmCacheCapabilitySubject {
  audience: typeof NPM_CACHE_CAPABILITY_AUDIENCE;
  expiresAt: string;
  maxRequests: number;
}

interface StoredCapability {
  subject: NpmCacheCapabilitySubject;
  audience: typeof NPM_CACHE_CAPABILITY_AUDIENCE;
  expiresAtMs: number;
  issuedAtMs: number;
}

export class NpmCacheCapabilityIssueError extends Error {
  readonly reasonCode: "capacity-exhausted" | "rate-limited";

  constructor(reasonCode: NpmCacheCapabilityIssueError["reasonCode"]) {
    super(`npm cache capability issue failed: ${reasonCode}`);
    this.name = "NpmCacheCapabilityIssueError";
    this.reasonCode = reasonCode;
  }
}

export function npmCacheCapabilityDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function subjectKey(subject: NpmCacheCapabilitySubject): string {
  return `${subject.gatewayId}\0${subject.uid}\0${subject.podUid}`;
}

export interface NpmCacheCapabilityStore {
  issue(input: {
    subject: NpmCacheCapabilitySubject;
    registryUrl: string;
    nowMs?: number;
  }): FleetBrokerNpmRegistryCredentials;
  authorize(input: {
    token: string;
    nowMs?: number;
  }): NpmCacheCapabilityAuthorization | null;
}

export class InMemoryNpmCacheCapabilityStore implements NpmCacheCapabilityStore {
  readonly #capabilities = new Map<string, StoredCapability>();
  readonly #activeBySubject = new Map<string, string>();
  readonly #randomToken: () => string;
  readonly #maxStored: number;

  constructor(
    randomToken: () => string = () => randomBytes(32).toString("base64url"),
    maxStored = NPM_CACHE_CAPABILITY_MAX_STORED,
  ) {
    this.#randomToken = randomToken;
    this.#maxStored = maxStored;
  }

  #delete(digest: string, stored: StoredCapability): void {
    this.#capabilities.delete(digest);
    if (this.#activeBySubject.get(subjectKey(stored.subject)) === digest) {
      this.#activeBySubject.delete(subjectKey(stored.subject));
    }
  }

  #pruneExpired(nowMs: number): void {
    for (const [digest, stored] of this.#capabilities) {
      if (stored.expiresAtMs <= nowMs) this.#delete(digest, stored);
    }
  }

  issue(input: {
    subject: NpmCacheCapabilitySubject;
    registryUrl: string;
    nowMs?: number;
  }): FleetBrokerNpmRegistryCredentials {
    const nowMs = input.nowMs ?? Date.now();
    this.#pruneExpired(nowMs);
    const key = subjectKey(input.subject);
    const previousDigest = this.#activeBySubject.get(key);
    const previous = previousDigest ? this.#capabilities.get(previousDigest) : undefined;
    if (previous && nowMs - previous.issuedAtMs < NPM_CACHE_CAPABILITY_ISSUE_INTERVAL_MS) {
      throw new NpmCacheCapabilityIssueError("rate-limited");
    }
    if (previousDigest) this.#capabilities.delete(previousDigest);
    if (this.#capabilities.size >= this.#maxStored) {
      throw new NpmCacheCapabilityIssueError("capacity-exhausted");
    }

    const token = this.#randomToken();
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(token)) {
      throw new Error("invalid npm cache capability entropy");
    }
    const digest = npmCacheCapabilityDigest(token);
    if (this.#capabilities.has(digest)) throw new Error("npm cache capability collision");
    const expiresAtMs = nowMs + NPM_CACHE_CAPABILITY_TTL_MS;
    this.#capabilities.set(digest, {
      subject: { ...input.subject },
      audience: NPM_CACHE_CAPABILITY_AUDIENCE,
      issuedAtMs: nowMs,
      expiresAtMs,
    });
    this.#activeBySubject.set(key, digest);
    return {
      registryUrl: input.registryUrl,
      token,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  authorize(input: {
    token: string;
    nowMs?: number;
  }): NpmCacheCapabilityAuthorization | null {
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(input.token)) return null;
    const digest = npmCacheCapabilityDigest(input.token);
    const stored = this.#capabilities.get(digest);
    if (!stored) return null;
    const nowMs = input.nowMs ?? Date.now();
    if (stored.expiresAtMs <= nowMs) {
      this.#delete(digest, stored);
      return null;
    }
    return {
      ...stored.subject,
      audience: stored.audience,
      expiresAt: new Date(stored.expiresAtMs).toISOString(),
      maxRequests: NPM_CACHE_CAPABILITY_MAX_REQUESTS,
    };
  }
}

export function npmCacheProxyRegistryUrl(
  namespace = process.env.K8S_NAMESPACE ?? "octogee",
): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(namespace)) {
    throw new Error("invalid Kubernetes namespace for npm cache proxy");
  }
  return `http://octogee-npm-cache-proxy.${namespace}.svc.cluster.local:3005/`;
}
