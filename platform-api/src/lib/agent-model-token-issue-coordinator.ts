import type {
  ModelBrokerProvider,
  ModelBrokerTokenPurpose,
} from "./model-broker-tokens.js";

export const AGENT_MODEL_TOKEN_ISSUE_CONCURRENCY = 6;
export const AGENT_MODEL_TOKEN_RESPONSE_CACHE_TTL_MS = 60_000;
const EXPIRY_SKEW_MS = 1_000;

export interface AgentModelTokenResponse {
  value: string;
  expiresAt: number;
  provider: ModelBrokerProvider;
  purpose: ModelBrokerTokenPurpose;
}

interface CachedIssue {
  promise: Promise<AgentModelTokenResponse>;
  cacheUntil: number | null;
}

export function agentModelTokenIssueKey(input: {
  gatewayId: string;
  podName?: string;
  agentId: string;
  provider: ModelBrokerProvider;
  purpose: ModelBrokerTokenPurpose;
}): string {
  return JSON.stringify([
    input.gatewayId,
    input.podName ?? "",
    input.agentId,
    input.provider,
    input.purpose,
  ]);
}

export function createAgentModelTokenIssueCoordinator(
  options: {
    maxConcurrent?: number;
    cacheTtlMs?: number;
    now?: () => number;
  } = {},
): {
  issue: (
    key: string,
    task: () => Promise<AgentModelTokenResponse>,
  ) => Promise<AgentModelTokenResponse>;
} {
  const maxConcurrent = options.maxConcurrent ?? AGENT_MODEL_TOKEN_ISSUE_CONCURRENCY;
  const cacheTtlMs = options.cacheTtlMs ?? AGENT_MODEL_TOKEN_RESPONSE_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("agent model token issue concurrency must be a positive integer");
  }
  if (!Number.isFinite(cacheTtlMs) || cacheTtlMs < 0) {
    throw new Error("agent model token response cache TTL must be non-negative");
  }

  const entries = new Map<string, CachedIssue>();
  const waiters: Array<() => void> = [];
  let active = 0;

  const acquire = async (): Promise<void> => {
    if (active < maxConcurrent) {
      active++;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
  };

  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      next();
      return;
    }
    active--;
  };

  const runBounded = async (
    task: () => Promise<AgentModelTokenResponse>,
  ): Promise<AgentModelTokenResponse> => {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };

  const prune = (at: number): void => {
    for (const [key, entry] of entries) {
      if (entry.cacheUntil !== null && entry.cacheUntil <= at) entries.delete(key);
    }
  };

  const issue = (
    key: string,
    task: () => Promise<AgentModelTokenResponse>,
  ): Promise<AgentModelTokenResponse> => {
    const requestedAt = now();
    prune(requestedAt);
    const existing = entries.get(key);
    if (existing && (existing.cacheUntil === null || existing.cacheUntil > requestedAt)) {
      return existing.promise;
    }

    const promise = runBounded(task)
      .then((result) => {
        const entry = entries.get(key);
        if (!entry || entry.promise !== promise) return result;
        const settledAt = now();
        entry.cacheUntil = Math.min(
          settledAt + cacheTtlMs,
          result.expiresAt - EXPIRY_SKEW_MS,
        );
        if (entry.cacheUntil <= settledAt) entries.delete(key);
        return result;
      })
      .catch((error: unknown) => {
        if (entries.get(key)?.promise === promise) entries.delete(key);
        throw error;
      });
    entries.set(key, { promise, cacheUntil: null });
    return promise;
  };

  return { issue };
}
