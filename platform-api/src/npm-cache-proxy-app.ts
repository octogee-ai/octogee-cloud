import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import express, { type Request, type Response } from "express";

import {
  NPM_CACHE_CAPABILITY_AUDIENCE,
  type NpmCacheCapabilityAuthorization,
} from "./lib/npm-cache-capabilities.js";

const CAPABILITY_RE = /^[A-Za-z0-9_-]{43,128}$/u;
const MAX_AUTHORIZATIONS_IN_FLIGHT = 128;
const MAX_CACHED_AUTHORIZATIONS = 2_048;
const MAX_REQUESTS_PER_CAPABILITY = 4_096;
const MAX_CONCURRENT_REQUESTS_PER_CAPABILITY = 16;
const MAX_GLOBAL_UPSTREAM_REQUESTS = 128;
const MAX_REQUEST_TARGET_LENGTH = 4_096;
const CACHE_CONTROL_HEADER = "Cache-Control";
const NO_STORE = "no-store";
const REQUEST_TARGET_BASE = "https://npm-cache-proxy.invalid";
const ARTIFACT_REGISTRY_NPM_HOST = /^[a-z][a-z0-9-]*-npm\.pkg\.dev$/u;
const ARTIFACT_REGISTRY_REPOSITORY_PATH = /^\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/[a-z][a-z0-9-]{0,62}\/$/u;

interface CachedAuthorization {
  authorization: NpmCacheCapabilityAuthorization;
  expiresAtMs: number;
  remainingRequests: number;
  activeRequests: number;
  lastUsedAtMs: number;
}

type CapabilityLeaseFailure =
  | "authorization-unavailable"
  | "forbidden"
  | "request-limit"
  | "concurrency-limit";

interface CapabilityLease {
  authorizationCache: "cold" | "warm";
  release(): void;
}

function capabilityDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function bearerToken(req: Request): string | null {
  const header = req.get("authorization");
  if (!header) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/u.exec(header);
  return match?.[1] ?? null;
}

function validAuthorization(
  value: NpmCacheCapabilityAuthorization | null,
  nowMs: number,
): value is NpmCacheCapabilityAuthorization {
  if (!value || value.audience !== NPM_CACHE_CAPABILITY_AUDIENCE) return false;
  const expiresAtMs = Date.parse(value.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs &&
    Number.isInteger(value.maxRequests) && value.maxRequests > 0 &&
    value.maxRequests <= MAX_REQUESTS_PER_CAPABILITY &&
    typeof value.gatewayId === "string" && value.gatewayId.length > 0 &&
    typeof value.uid === "string" && value.uid.length > 0 &&
    typeof value.slug === "string" && value.slug.length > 0 &&
    typeof value.podUid === "string" && value.podUid.length > 0;
}

class CapabilityGate {
  readonly #authorizations = new Map<string, CachedAuthorization>();
  readonly #pending = new Map<string, Promise<NpmCacheCapabilityAuthorization | null>>();
  readonly #authorize: (token: string) => Promise<NpmCacheCapabilityAuthorization | null>;
  readonly #now: () => number;

  constructor(options: {
    authorize: (token: string) => Promise<NpmCacheCapabilityAuthorization | null>;
    now: () => number;
  }) {
    this.#authorize = options.authorize;
    this.#now = options.now;
  }

  #removeExpired(nowMs: number): void {
    for (const [digest, cached] of this.#authorizations) {
      if (cached.expiresAtMs <= nowMs && cached.activeRequests === 0) {
        this.#authorizations.delete(digest);
      }
    }
  }

  #makeRoom(nowMs: number): void {
    this.#removeExpired(nowMs);
    if (this.#authorizations.size < MAX_CACHED_AUTHORIZATIONS) return;
    let oldest: { digest: string; at: number } | null = null;
    for (const [digest, cached] of this.#authorizations) {
      if (cached.activeRequests > 0) continue;
      if (!oldest || cached.lastUsedAtMs < oldest.at) oldest = { digest, at: cached.lastUsedAtMs };
    }
    if (oldest) this.#authorizations.delete(oldest.digest);
  }

  async #resolve(
    token: string,
    digest: string,
    nowMs: number,
  ): Promise<{ record: CachedAuthorization; cache: "cold" | "warm" } | null> {
    const cached = this.#authorizations.get(digest);
    if (cached && cached.expiresAtMs > nowMs) return { record: cached, cache: "warm" };
    if (cached?.activeRequests === 0) this.#authorizations.delete(digest);

    let pending = this.#pending.get(digest);
    if (!pending) {
      if (this.#pending.size >= MAX_AUTHORIZATIONS_IN_FLIGHT) {
        throw new Error("npm cache authorization capacity exhausted");
      }
      pending = this.#authorize(token).finally(() => this.#pending.delete(digest));
      this.#pending.set(digest, pending);
    }
    const authorization = await pending;
    const resolvedAtMs = this.#now();
    if (!validAuthorization(authorization, resolvedAtMs)) return null;
    this.#makeRoom(resolvedAtMs);
    const record: CachedAuthorization = {
      authorization,
      expiresAtMs: Date.parse(authorization.expiresAt),
      remainingRequests: authorization.maxRequests,
      activeRequests: 0,
      lastUsedAtMs: resolvedAtMs,
    };
    this.#authorizations.set(digest, record);
    return { record, cache: "cold" };
  }

  async acquire(token: string): Promise<CapabilityLease | CapabilityLeaseFailure> {
    if (!CAPABILITY_RE.test(token)) return "forbidden";
    const nowMs = this.#now();
    let resolved: { record: CachedAuthorization; cache: "cold" | "warm" } | null;
    try {
      resolved = await this.#resolve(token, capabilityDigest(token), nowMs);
    } catch {
      return "authorization-unavailable";
    }
    if (!resolved) return "forbidden";
    const { record } = resolved;
    if (record.remainingRequests <= 0) return "request-limit";
    if (record.activeRequests >= MAX_CONCURRENT_REQUESTS_PER_CAPABILITY) {
      return "concurrency-limit";
    }
    record.remainingRequests -= 1;
    record.activeRequests += 1;
    record.lastUsedAtMs = this.#now();
    let released = false;
    return {
      authorizationCache: resolved.cache,
      release: () => {
        if (released) return;
        released = true;
        record.activeRequests -= 1;
      },
    };
  }
}

export function safeRegistryTarget(
  rawTarget: string | undefined,
  upstreamRegistryUrl: string,
): URL | null {
  if (!rawTarget || rawTarget.length > MAX_REQUEST_TARGET_LENGTH || rawTarget.startsWith("//")) {
    return null;
  }
  if (rawTarget.includes("\\") || /(?:^|\/)(?:\.|%2e)(?:\.|%2e)?(?:\/|\?|#|$)/iu.test(rawTarget)) {
    return null;
  }
  let requestTarget: URL;
  try {
    requestTarget = new URL(rawTarget, REQUEST_TARGET_BASE);
  } catch {
    return null;
  }
  const upstream = new URL(upstreamRegistryUrl);
  if (requestTarget.origin !== REQUEST_TARGET_BASE) return null;
  if (requestTarget.username || requestTarget.password || requestTarget.hash) return null;
  const target = new URL(upstream);
  target.pathname = `${upstream.pathname.replace(/\/$/u, "")}${requestTarget.pathname}`;
  target.search = requestTarget.search;
  return target;
}

function validatedUpstreamRegistryUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid npm cache upstream registry");
  }
  if (
    url.protocol !== "https:" ||
    !ARTIFACT_REGISTRY_NPM_HOST.test(url.hostname) ||
    !ARTIFACT_REGISTRY_REPOSITORY_PATH.test(url.pathname) ||
    url.port || url.username || url.password || url.search || url.hash
  ) {
    throw new Error("invalid npm cache upstream registry");
  }
  return url.toString();
}

const FORWARDED_RESPONSE_HEADERS = [
  "cache-control",
  "accept-ranges",
  "content-disposition",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
  "vary",
] as const;

function proxyStatusForFailure(failure: CapabilityLeaseFailure): number {
  if (failure === "forbidden") return 403;
  if (failure === "authorization-unavailable") return 503;
  return 429;
}

export interface NpmCacheProxyEvent {
  outcome: "success" | "rejected" | "upstream-error";
  status: number;
  durationMs: number;
  reason?: string;
  authorizationCache?: "cold" | "warm";
  authorizationMs?: number;
  artifactCredentialMs?: number;
  upstreamHeadersMs?: number;
  upstreamAgeSeconds?: number;
}

interface NpmCacheProxyRuntime {
  artifactRegistryAccessToken: () => Promise<string>;
  fetchImpl: typeof fetch;
  now: () => number;
  report: (event: NpmCacheProxyEvent) => void;
  upstreamRegistryUrl: string;
}

class UpstreamCapacity {
  #active = 0;

  acquire(): boolean {
    if (this.#active >= MAX_GLOBAL_UPSTREAM_REQUESTS) return false;
    this.#active += 1;
    return true;
  }

  release(): void {
    this.#active -= 1;
  }
}

function rejectRegistryRequest(
  res: Response,
  runtime: Pick<NpmCacheProxyRuntime, "now" | "report">,
  input: {
    startedAtMs: number;
    status: number;
    reason: string;
    authorizationMs?: number;
  },
): void {
  res.set(CACHE_CONTROL_HEADER, NO_STORE).status(input.status).end();
  runtime.report({
    outcome: "rejected",
    status: input.status,
    durationMs: runtime.now() - input.startedAtMs,
    reason: input.reason,
    ...(input.authorizationMs === undefined
      ? {}
      : { authorizationMs: input.authorizationMs }),
  });
}

function registryTarget(req: Request, upstreamRegistryUrl: string): {
  target: URL | null;
  invalidStatus: number;
} {
  const readMethod = req.method === "GET" || req.method === "HEAD";
  return {
    target: readMethod ? safeRegistryTarget(req.originalUrl, upstreamRegistryUrl) : null,
    invalidStatus: readMethod ? 404 : 405,
  };
}

function upstreamRequestHeaders(req: Request, accessToken: string): Headers {
  const headers = new Headers({
    authorization: `Bearer ${accessToken}`,
    accept: req.get("accept") ?? "application/json",
    "accept-encoding": "identity",
    "user-agent": "octogee-npm-cache-proxy/1",
  });
  for (const name of ["if-modified-since", "if-none-match", "range"] as const) {
    const value = req.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function upstreamAgeSeconds(response: globalThis.Response): number | undefined {
  if (!response.headers.has("age")) return undefined;
  const age = Number(response.headers.get("age"));
  return Number.isFinite(age) ? age : undefined;
}

async function forwardRegistryRequest(input: {
  req: Request;
  res: Response;
  target: URL;
  lease: CapabilityLease;
  authorizationMs: number;
  startedAtMs: number;
  capacity: UpstreamCapacity;
  runtime: NpmCacheProxyRuntime;
}): Promise<void> {
  const { req, res, lease, runtime } = input;
  try {
    const credentialStartedAtMs = runtime.now();
    const accessToken = await runtime.artifactRegistryAccessToken();
    const artifactCredentialMs = runtime.now() - credentialStartedAtMs;
    if (!accessToken) throw new Error("artifact registry access token unavailable");
    const upstreamStartedAtMs = runtime.now();
    const upstream = await runtime.fetchImpl(input.target, {
      method: req.method,
      headers: upstreamRequestHeaders(req, accessToken),
      redirect: "follow",
      signal: AbortSignal.timeout(60_000),
    });
    const upstreamHeadersMs = runtime.now() - upstreamStartedAtMs;
    res.status(upstream.status);
    for (const header of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(header);
      if (value) res.set(header, value);
    }
    if (req.method === "HEAD" || !upstream.body) {
      res.end();
    } else {
      await pipeline(
        Readable.from(upstream.body as unknown as AsyncIterable<Uint8Array>),
        res,
      );
    }
    runtime.report({
      outcome: "success",
      status: upstream.status,
      durationMs: runtime.now() - input.startedAtMs,
      authorizationCache: lease.authorizationCache,
      authorizationMs: input.authorizationMs,
      artifactCredentialMs,
      upstreamHeadersMs,
      upstreamAgeSeconds: upstreamAgeSeconds(upstream),
    });
  } catch (error) {
    if (!res.headersSent) {
      res.set(CACHE_CONTROL_HEADER, NO_STORE)
        .status(502)
        .json({ error: "npm_cache_upstream_unavailable" });
    } else {
      res.destroy();
    }
    runtime.report({
      outcome: "upstream-error",
      status: 502,
      durationMs: runtime.now() - input.startedAtMs,
      authorizationCache: lease.authorizationCache,
      authorizationMs: input.authorizationMs,
      reason: error instanceof Error ? error.name : "Error",
    });
  } finally {
    input.capacity.release();
    lease.release();
  }
}

function registryRequestHandler(input: {
  gate: CapabilityGate;
  capacity: UpstreamCapacity;
  runtime: NpmCacheProxyRuntime;
}): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    const startedAtMs = input.runtime.now();
    const { target, invalidStatus } = registryTarget(req, input.runtime.upstreamRegistryUrl);
    if (!target) {
      rejectRegistryRequest(res, input.runtime, {
        startedAtMs,
        status: invalidStatus,
        reason: "target",
      });
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      rejectRegistryRequest(res, input.runtime, { startedAtMs, status: 403, reason: "auth" });
      return;
    }
    const authorizationStartedAtMs = input.runtime.now();
    const lease = await input.gate.acquire(token);
    const authorizationMs = input.runtime.now() - authorizationStartedAtMs;
    if (typeof lease === "string") {
      rejectRegistryRequest(res, input.runtime, {
        startedAtMs,
        status: proxyStatusForFailure(lease),
        reason: lease,
        authorizationMs,
      });
      return;
    }
    if (!input.capacity.acquire()) {
      lease.release();
      rejectRegistryRequest(res, input.runtime, {
        startedAtMs,
        status: 429,
        reason: "capacity",
        authorizationMs,
      });
      return;
    }
    await forwardRegistryRequest({
      req,
      res,
      target,
      lease,
      authorizationMs,
      startedAtMs,
      capacity: input.capacity,
      runtime: input.runtime,
    });
  };
}

export function createNpmCacheProxyApp(options: {
  authorizeCapability: (token: string) => Promise<NpmCacheCapabilityAuthorization | null>;
  artifactRegistryAccessToken: () => Promise<string>;
  upstreamRegistryUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  reportEvent?: (event: NpmCacheProxyEvent) => void;
}): express.Express {
  const now = options.now ?? Date.now;
  const upstreamRegistryUrl = validatedUpstreamRegistryUrl(options.upstreamRegistryUrl);
  const gate = new CapabilityGate({ authorize: options.authorizeCapability, now });
  const runtime: NpmCacheProxyRuntime = {
    artifactRegistryAccessToken: options.artifactRegistryAccessToken,
    fetchImpl: options.fetchImpl ?? fetch,
    now,
    report: options.reportEvent ?? (() => undefined),
    upstreamRegistryUrl,
  };
  const app = express();
  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.set(CACHE_CONTROL_HEADER, NO_STORE).status(200).json({ status: "ok" });
  });
  app.use(registryRequestHandler({ gate, capacity: new UpstreamCapacity(), runtime }));

  return app;
}
