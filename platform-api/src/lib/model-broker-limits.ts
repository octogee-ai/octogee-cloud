import type { UserAccountReader } from "@octogee/core/user-account";
import {
  readGatewayAuthorizationInStore,
  type GatewayAuthorization,
  type GatewayRootReader,
} from "@octogee/core/gateway-live-release";
import {
  normalizeModelBrokerTokenLimits,
  normalizeModelBrokerTokenPolicy,
  type ModelBrokerTokenLimits,
  type ModelBrokerTokenPolicy,
} from "./model-broker-tokens.js";
import type { FundedBudget } from "./model-broker-budget.js";
import type { ModelBrokerRailRegistry, OwnerRailProfile } from "./model-broker-rails.js";

export interface OwnerModelBrokerGrant {
  limits: ModelBrokerTokenLimits;
  policy: ModelBrokerTokenPolicy;
  rail: string;
  fundedBudget?: FundedBudget | null;
}

export interface ModelBrokerGrantReaders {
  readonly state: GatewayRootReader;
  readonly accounts: UserAccountReader;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function parseOptionalLimitNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function envDefaultModelBrokerLimits(
  env: NodeJS.ProcessEnv = process.env,
): Partial<ModelBrokerTokenLimits> {
  return {
    spendWindowUsd: parseOptionalLimitNumber(env.MODEL_BROKER_SPEND_WINDOW_USD),
    spendWeekUsd: parseOptionalLimitNumber(env.MODEL_BROKER_SPEND_WEEK_USD),
    requestsPerMinute: parseOptionalLimitNumber(env.MODEL_BROKER_REQUESTS_PER_MINUTE),
  };
}

async function readOwnerProfile(
  accounts: UserAccountReader,
  ownerUid: string | undefined,
  now: number,
  rails: ModelBrokerRailRegistry,
): Promise<OwnerRailProfile | null> {
  if (!ownerUid) return null;
  const account = await accounts.get(ownerUid);
  if (!account) return null;
  return rails.resolveOwnerProfile({ ...account.planInputs }, ownerUid, now);
}

async function readGatewayLimitOverrides(
  state: GatewayRootReader,
  gatewayId: string,
  authorization?: GatewayAuthorization,
): Promise<Partial<ModelBrokerTokenLimits>> {
  const resolved = authorization ?? await readGatewayAuthorizationInStore(state, gatewayId);
  if (!resolved) {
    throw new Error(`durable root config unavailable for gateways/${gatewayId}`);
  }
  const raw = resolved.config.modelBrokerLimits ?? {};
  const spendWindowUsd = finiteNumber(raw.spendWindowUsd);
  const spendWeekUsd = finiteNumber(raw.spendWeekUsd);
  const requestsPerMinute = finiteNumber(raw.requestsPerMinute);
  return {
    ...(spendWindowUsd === null ? {} : { spendWindowUsd }),
    ...(spendWeekUsd === null ? {} : { spendWeekUsd }),
    ...(requestsPerMinute === null ? {} : { requestsPerMinute }),
  };
}

export async function resolveOwnerModelBrokerGrant(input: ModelBrokerGrantReaders & {
  gatewayId: string;
  ownerUid?: string;
  now: number;
  defaults?: Partial<ModelBrokerTokenLimits> | null;
  gatewayAuthorization?: GatewayAuthorization;
  rails: ModelBrokerRailRegistry;
}): Promise<OwnerModelBrokerGrant> {
  const tier = await readOwnerProfile(input.accounts, input.ownerUid, input.now, input.rails);
  const overrides = await readGatewayLimitOverrides(
    input.state,
    input.gatewayId,
    input.gatewayAuthorization,
  );
  const rail = tier?.rail ?? input.rails.defaultRailId;
  const limits = normalizeModelBrokerTokenLimits({
    ...(input.defaults ?? {}),
    ...(tier === null || !tier.windowBudgets
      ? {}
      : { spendWindowUsd: tier.spendWindowUsd, spendWeekUsd: tier.spendWeekUsd }),
    ...overrides,
  });
  const policy = normalizeModelBrokerTokenPolicy({
    freeTier: tier?.freeTier === true,
    houseFallback: tier?.houseFallback !== false,
  });
  return { limits, policy, rail, fundedBudget: tier?.fundedBudget ?? null };
}

export interface LiveOwnerGrantInput {
  gatewayId: string;
  ownerUid: string | null;
  now: number;
}

export type LiveOwnerGrantResolver = (
  input: LiveOwnerGrantInput,
) => Promise<OwnerModelBrokerGrant>;

const DEFAULT_GRANT_CACHE_TTL_MS = 60_000;
const DEFAULT_GRANT_CACHE_MAX_ENTRIES = 10_000;

function cachedGrantIsFresh(
  entry: { grant: OwnerModelBrokerGrant; resolvedAt: number },
  now: number,
  ttlMs: number,
): boolean {
  if (now - entry.resolvedAt >= ttlMs) return false;
  const budget = entry.grant.fundedBudget;
  if (!budget) return true;
  if (now >= budget.expiresAtMs) return false;
  return budget.nextCapIncreaseAtMs === null || now < budget.nextCapIncreaseAtMs;
}

function mutableLimitFingerprint(authorization: GatewayAuthorization): string {
  const limits = authorization.config.modelBrokerLimits;
  return [
    authorization.gateway.updatedAt,
    authorization.config.configSchemaVersion,
    limits?.spendWindowUsd ?? null,
    limits?.spendWeekUsd ?? null,
    limits?.requestsPerMinute ?? null,
  ].join(":");
}

export function createCachedOwnerModelBrokerGrantResolver(opts: ModelBrokerGrantReaders & {
  rails: ModelBrokerRailRegistry;
  defaults?: Partial<ModelBrokerTokenLimits> | null;
  ttlMs?: number;
  maxEntries?: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}): LiveOwnerGrantResolver {
  const ttlMs = opts.ttlMs ?? DEFAULT_GRANT_CACHE_TTL_MS;
  const maxEntries = opts.maxEntries ?? DEFAULT_GRANT_CACHE_MAX_ENTRIES;
  const cache = new Map<string, { grant: OwnerModelBrokerGrant; resolvedAt: number }>();

  const sweepExpired = (now: number): void => {
    if (cache.size < maxEntries) return;
    let evicted = 0;
    for (const [key, entry] of cache) {
      if (now - entry.resolvedAt >= ttlMs) {
        cache.delete(key);
        evicted += 1;
      }
    }
    // Everything still live at the cap: drop the oldest insertions rather
    // than grow unbounded — they re-resolve on their next call.
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
      evicted += 1;
    }
    opts.log?.("llm-broker grant cache swept", { evicted, remaining: cache.size });
  };

  return async ({ gatewayId, ownerUid, now }) => {
    const authorization = await readGatewayAuthorizationInStore(opts.state, gatewayId);
    if (!authorization) {
      throw new Error(`durable root config unavailable for gateways/${gatewayId}`);
    }
    const key = `${gatewayId}:${mutableLimitFingerprint(authorization)}:${ownerUid ?? ""}`;
    const cached = cache.get(key);
    if (cached && cachedGrantIsFresh(cached, now, ttlMs)) return cached.grant;
    if (cached) cache.delete(key);
    sweepExpired(now);

    const grant = await resolveOwnerModelBrokerGrant({
      state: opts.state,
      accounts: opts.accounts,
      gatewayId,
      ownerUid: ownerUid ?? undefined,
      now,
      defaults: opts.defaults,
      gatewayAuthorization: authorization,
      rails: opts.rails,
    });
    cache.set(key, { grant, resolvedAt: now });
    opts.log?.("llm-broker grant resolved", {
      gatewayId,
      ownerUid,
      spendWindowUsd: grant.limits.spendWindowUsd,
      spendWeekUsd: grant.limits.spendWeekUsd,
      requestsPerMinute: grant.limits.requestsPerMinute,
      freeTier: grant.policy.freeTier,
      rail: grant.rail,
      ...grant.fundedBudget?.logFields,
    });
    return grant;
  };
}
