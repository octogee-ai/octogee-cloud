export type ProductivityRateTier = "read" | "write" | "prepare";

const WINDOW_MS = 15 * 60_000;

const TIER_LIMITS: Record<ProductivityRateTier, number> = {
  read: 60,
  write: 20,
  prepare: 10,
};

interface RateWindow {
  count: number;
  resetsAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export interface ProductivityRateLimiter {
  consume(gatewayId: string, agentId: string, tier: ProductivityRateTier): RateLimitResult;
}

export function createProductivityRateLimiter(opts: {
  now?: () => number;
  limits?: Partial<Record<ProductivityRateTier, number>>;
  maxWindows?: number;
} = {}): ProductivityRateLimiter {
  const now = opts.now ?? Date.now;
  const limits = { ...TIER_LIMITS, ...opts.limits };
  const maxWindows = opts.maxWindows ?? 10_000;
  const windows = new Map<string, RateWindow>();

  function makeRoom(timestamp: number): void {
    for (const [key, window] of windows) {
      if (window.resetsAt <= timestamp) {
        windows.delete(key);
      }
    }
    while (windows.size >= maxWindows) {
      let earliestKey: string | undefined;
      let earliestReset = Number.POSITIVE_INFINITY;
      for (const [key, window] of windows) {
        if (window.resetsAt < earliestReset) {
          earliestKey = key;
          earliestReset = window.resetsAt;
        }
      }
      windows.delete(earliestKey!);
    }
  }

  return {
    consume(gatewayId, agentId, tier) {
      const key = `${gatewayId}\0${agentId}\0${tier}`;
      const timestamp = now();
      let current = windows.get(key);
      if (current && current.resetsAt <= timestamp) {
        windows.delete(key);
        current = undefined;
      }
      const window = !current
        ? { count: 0, resetsAt: timestamp + WINDOW_MS }
        : current;
      if (window.count >= limits[tier]) {
        return { allowed: false, retryAfterSeconds: Math.ceil((window.resetsAt - timestamp) / 1000) };
      }
      if (!current) {
        makeRoom(timestamp);
      }
      window.count += 1;
      windows.set(key, window);
      return { allowed: true };
    },
  };
}
