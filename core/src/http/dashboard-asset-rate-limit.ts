import type { RequestHandler, Response } from "express";
import { ipKeyGenerator } from "express-rate-limit";

const BURST = 180;
const REFILL_PER_MS = 2 / 1_000;
const SWEEP_INTERVAL_MS = 30_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

function reject(res: Response, status: 429 | 503, retryAfterSeconds: number): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Retry-After", String(retryAfterSeconds));
  res.status(status).json({
    error: status === 429 ? "dashboard-assets-rate-limited" : "dashboard-asset-limiter-capacity",
    retryable: true,
    retryAfterSeconds,
  });
}

export function createDashboardAssetRateLimit({
  now = () => performance.now(),
  maxKeys = 10_000,
}: { now?: () => number; maxKeys?: number } = {}): RequestHandler {
  const buckets = new Map<string, Bucket>();
  let nextSweepAt = 0;
  return (req, res, next) => {
    if (!req.ip) {
      next(new Error("Dashboard asset rate limit requires a client IP"));
      return;
    }
    const timestamp = now();
    if (timestamp >= nextSweepAt) {
      for (const [key, bucket] of buckets) {
        if (bucket.tokens + (timestamp - bucket.updatedAt) * REFILL_PER_MS >= BURST) buckets.delete(key);
      }
      nextSweepAt = timestamp + SWEEP_INTERVAL_MS;
    }
    const key = ipKeyGenerator(req.ip);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxKeys) {
        reject(res, 503, Math.max(1, Math.ceil((nextSweepAt - timestamp) / 1_000)));
        return;
      }
      bucket = { tokens: BURST, updatedAt: timestamp };
      buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(BURST, bucket.tokens + Math.max(0, timestamp - bucket.updatedAt) * REFILL_PER_MS);
    bucket.updatedAt = timestamp;
    if (bucket.tokens < 1) {
      reject(res, 429, Math.ceil((1 - bucket.tokens) / REFILL_PER_MS / 1_000));
      return;
    }
    bucket.tokens -= 1;
    next();
  };
}
