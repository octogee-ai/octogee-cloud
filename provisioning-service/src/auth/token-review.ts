import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export type ReviewResult =
  | { authenticated: false }
  | { authenticated: true; namespace: string; serviceAccount: string };

export type Reviewer = (token: string) => Promise<ReviewResult>;

export interface TokenReviewerOptions {
  url: string;
  audience: string;
  reviewerToken: () => Promise<string>;
  ca?: string;
  now?: () => number;
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
}

interface CachedReview {
  result: Extract<ReviewResult, { authenticated: true }>;
  at: number;
}

function post(url: URL, bearer: string, body: string, ca: string | undefined): Promise<{ status: number; text: string }> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(url, {
      method: "POST",
      ...(ca ? { ca } : {}),
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body).toString(),
      },
      timeout: 10_000,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("TokenReview timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

export function parseTokenReview(body: unknown, audience: string): ReviewResult {
  const status = (body as { status?: { authenticated?: unknown; audiences?: unknown; user?: { username?: unknown } } } | null)?.status;
  if (status?.authenticated !== true) return { authenticated: false };
  const audiences = Array.isArray(status.audiences) ? status.audiences : [];
  if (!audiences.includes(audience)) return { authenticated: false };
  const username = status.user?.username;
  if (typeof username !== "string") return { authenticated: false };
  const parts = username.split(":");
  if (parts.length !== 4 || parts[0] !== "system" || parts[1] !== "serviceaccount" || !parts[2] || !parts[3]) {
    return { authenticated: false };
  }
  return { authenticated: true, namespace: parts[2], serviceAccount: parts[3] };
}

export function createTokenReviewer(options: TokenReviewerOptions): Reviewer {
  const now = options.now ?? Date.now;
  const ttl = options.cacheTtlMs ?? 30_000;
  const maxEntries = options.cacheMaxEntries ?? 1_000;
  const cache = new Map<string, CachedReview>();
  const url = new URL(options.url);

  return async (token) => {
    const key = createHash("sha256").update(token).digest("hex");
    const cached = cache.get(key);
    if (cached && now() - cached.at < ttl) return cached.result;
    cache.delete(key);
    const body = JSON.stringify({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      spec: { token, audiences: [options.audience] },
    });
    const response = await post(url, await options.reviewerToken(), body, options.ca);
    if (response.status < 200 || response.status >= 300) throw new Error(`TokenReview answered HTTP ${response.status}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      throw new Error("TokenReview answered a body that is not JSON");
    }
    const result = parseTokenReview(parsed, options.audience);
    if (result.authenticated) {
      if (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { result, at: now() });
    }
    return result;
  };
}
