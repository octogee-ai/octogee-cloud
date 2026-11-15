import type { PlatformConfigRepository } from "@octogee/core/platform-state";
import {
  DEFAULT_HOUSE_MODEL_REF,
  userAgentModelDefaultFromDoc,
  resolveHouseModel,
  type UserAgentModelDefault,
  type ResolvedHouseModel,
} from "@octogee/shared/types/platform-config";

const DEFAULT_TTL_MS = 60_000;

export type HouseModelResolver = () => Promise<ResolvedHouseModel>;
export type UserAgentDefaultResolver = () => Promise<UserAgentModelDefault>;

function mustResolve(ref: string): ResolvedHouseModel {
  const resolved = resolveHouseModel(ref);
  if (!resolved) {
    throw new Error(`compiled default free-tier model ref is not in the catalog: ${ref}`);
  }
  return resolved;
}

// The broker resolves the house model dial live on every degraded call so an
// operator flip lands within one TTL; the cache bounds Firestore reads on the
// hot path. An unreadable or invalid doc never blocks free traffic — it
// reports and serves the last-known (else compiled) house model.
export function createCachedHouseModelResolver(opts: {
  platformConfig: Pick<PlatformConfigRepository, "get">;
  ttlMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}): HouseModelResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const fallback = mustResolve(DEFAULT_HOUSE_MODEL_REF);
  let cached: { value: ResolvedHouseModel; resolvedAt: number } | null = null;

  return async () => {
    const at = now();
    if (cached && at - cached.resolvedAt < ttlMs) return cached.value;
    try {
      const models = (await opts.platformConfig.get("models"))?.value;
      let value = fallback;
      if (models !== undefined) {
        if (resolveHouseModel(models.freeTierModelRef)) {
          value = mustResolve(models.freeTierModelRef);
        } else {
          opts.onError?.(
            new Error(
              `platformConfig/models freeTierModelRef is not a catalog ref: ${JSON.stringify(
                models.freeTierModelRef,
              )} — serving ${DEFAULT_HOUSE_MODEL_REF}`,
            ),
          );
        }
      }
      cached = { value, resolvedAt: at };
      return value;
    } catch (err) {
      opts.onError?.(err);
      return cached?.value ?? fallback;
    }
  };
}

// Same contract as the free-tier resolver: the field-tolerant doc read means
// an unreadable or invalid doc serves the last-known (else compiled) default.
export function createCachedUserAgentDefaultResolver(opts: {
  platformConfig: Pick<PlatformConfigRepository, "get">;
  ttlMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}): UserAgentDefaultResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const fallback = userAgentModelDefaultFromDoc(undefined);
  let cached: { value: UserAgentModelDefault; resolvedAt: number } | null = null;

  return async () => {
    const at = now();
    if (cached && at - cached.resolvedAt < ttlMs) return cached.value;
    try {
      const value = userAgentModelDefaultFromDoc((await opts.platformConfig.get("models"))?.value);
      cached = { value, resolvedAt: at };
      return value;
    } catch (err) {
      opts.onError?.(err);
      return cached?.value ?? fallback;
    }
  };
}
