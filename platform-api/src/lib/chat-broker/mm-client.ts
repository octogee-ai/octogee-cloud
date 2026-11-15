/**
 * Tiny HTTP wrapper around the Mattermost API, scoped to one PAT per call.
 *
 * Why not @mattermost/client? It pulls in a large surface for things we
 * don't use (websocket, file uploads, etc.). Here we want two GETs and a
 * POST, with predictable error handling. Keeping the surface small also
 * makes upstreaming cleaner — the generic plugin shouldn't depend on a
 * heavy MM client lib.
 */

export class MmFetchError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "MmFetchError";
  }
}

export interface MmClient {
  get: (path: string, pat: string) => Promise<unknown>;
  post: (path: string, pat: string, body: unknown) => Promise<unknown>;
}

export type MmJsonObject = Record<string, unknown>;

export function asMmJsonObject(value: unknown): MmJsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MmJsonObject)
    : null;
}

/**
 * Build a client bound to a base URL. Caller supplies the PAT per call so we
 * never cache a token across requests in client state.
 *
 * Timeout default 10s — MM /search can take ~2s on a 10k-post workspace
 * (spec §11 acceptance: p95 < 1.5s). 10s leaves headroom for cold-cache
 * runs without paging upstream.
 */
export function createMmClient(baseUrl: string, opts: { timeoutMs?: number } = {}): MmClient {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  // Strip ONE trailing slash if present. baseUrl is operator-controlled config,
  // not user input — pathological inputs like "//" aren't a realistic concern.
  // Avoid `/\/+$/` here (eslint's sonarjs/slow-regex flags it as
  // backtracking-prone even though the anchor makes it linear).
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  async function call(
    method: "GET" | "POST",
    path: string,
    pat: string,
    body?: unknown,
  ): Promise<unknown> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${trimmed}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${pat}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const bodySuffix = text ? `: ${text.slice(0, 200)}` : "";
        throw new MmFetchError(
          res.status,
          path,
          `${method} ${path} → ${res.status} ${res.statusText}${bodySuffix}`,
        );
      }
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new MmFetchError(res.status, path, `${path} returned non-JSON body`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get: (path, pat) => call("GET", path, pat),
    post: (path, pat, body) => call("POST", path, pat, body),
  };
}
