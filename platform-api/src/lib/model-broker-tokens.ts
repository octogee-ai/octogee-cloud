import * as crypto from "node:crypto";
import type { ModelBrokerToken, PlatformStateStore } from "@octogee/core/platform-state";

export type ModelBrokerProvider = "anthropic" | "vertex" | "openrouter" | "openai" | "meta";
export type ModelBrokerTokenPurpose = "model" | "embeddings";

export interface ModelBrokerTokenLimits {
  spendWindowUsd: number | null;
  spendWeekUsd: number | null;
  requestsPerMinute: number | null;
}

// Plan/routing policy, distinct from spend limits. `freeTier` means "always serve
// the house model on the house key, never billed" — degrade unconditionally rather
// than only on window exhaustion. Paid tiers carry `freeTier: false` and degrade
// only when their `spendWindowUsd` is exhausted. `houseFallback: false` (users
// paying for infrastructure with no live token path) turns exhaustion into a hard
// deny instead of a house-model degrade — pricing v3's "paying customers pay for
// tokens" rule.
export interface ModelBrokerTokenPolicy {
  freeTier: boolean;
  houseFallback: boolean;
}

export type ModelBrokerTokenTraceSource = "gateway_model_key_issuer" | "shared_agent_model_token";

export interface ModelBrokerTokenTrace {
  source: ModelBrokerTokenTraceSource;
  ownerSlug: string | null;
  agentId: string | null;
}

export interface ModelBrokerTokenRecord {
  tokenHash: string;
  gatewayId: string;
  ownerUid: string | null;
  provider: ModelBrokerProvider;
  purpose: ModelBrokerTokenPurpose;
  capped: true;
  secretName: string;
  createdAt: number;
  expiresAt: number | null;
  limits: ModelBrokerTokenLimits;
  policy: ModelBrokerTokenPolicy;
  trace: ModelBrokerTokenTrace | null;
  revoked: boolean;
  revokedAt?: number;
}

export interface IssueModelBrokerTokenInput {
  gatewayId: string;
  ownerUid?: string;
  provider: ModelBrokerProvider;
  purpose?: ModelBrokerTokenPurpose;
  secretName: string;
  pointerKey?: string;
  // Mint a standalone token with NO pointer (no revoke-on-reissue). Per-user
  // shared tokens are re-minted whenever the secret-resolver re-resolves the keyRef,
  // so skipPointer prevents a re-mint from yanking a still-in-flight token — stale
  // tokens expire by TTL instead. Requires ttlSeconds to bound accumulation.
  skipPointer?: boolean;
  ttlSeconds?: number | null;
  limits?: Partial<ModelBrokerTokenLimits> | null;
  policy?: Partial<ModelBrokerTokenPolicy> | null;
  trace?: Partial<ModelBrokerTokenTrace> | null;
  now?: number;
  randomBytes?: (size: number) => Buffer;
}

export interface RevokeModelBrokerTokenInput {
  gatewayId: string;
  ownerUid?: string;
  provider: ModelBrokerProvider;
  secretName: string;
  pointerKey?: string;
  now?: number;
}

export type ModelBrokerTokenLookup =
  | { outcome: "valid"; record: ModelBrokerTokenRecord }
  | { outcome: "expired"; record: ModelBrokerTokenRecord }
  | { outcome: "revoked"; record: ModelBrokerTokenRecord }
  | { outcome: "unknown" };

export interface ModelBrokerTokenStore {
  issueToken(input: IssueModelBrokerTokenInput): Promise<{
    token: string;
    record: ModelBrokerTokenRecord;
  }>;
  revokeGatewayToken(input: RevokeModelBrokerTokenInput): Promise<{ revoked: boolean }>;
  lookupToken(token: string, now?: number): Promise<ModelBrokerTokenLookup>;
}

export function hashModelBrokerToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function normalizeTtlSeconds(ttlSeconds: number | null | undefined): number | null {
  if (ttlSeconds === null || ttlSeconds === undefined) return null;
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) return null;
  return Math.floor(ttlSeconds);
}

function nonNegativeLimit(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function normalizeModelBrokerTokenLimits(
  limits: Partial<ModelBrokerTokenLimits> | null | undefined,
): ModelBrokerTokenLimits {
  return {
    spendWindowUsd: nonNegativeLimit(limits?.spendWindowUsd),
    spendWeekUsd: nonNegativeLimit(limits?.spendWeekUsd),
    requestsPerMinute: nonNegativeLimit(limits?.requestsPerMinute),
  };
}

export function normalizeModelBrokerTokenPolicy(
  policy: { readonly freeTier?: unknown; readonly houseFallback?: unknown } | null | undefined,
): ModelBrokerTokenPolicy {
  return {
    freeTier: policy?.freeTier === true,
    houseFallback: policy?.houseFallback !== false,
  };
}

function traceSource(value: unknown): ModelBrokerTokenTraceSource | null {
  return value === "gateway_model_key_issuer" || value === "shared_agent_model_token"
    ? value
    : null;
}

function optionalTraceString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeModelBrokerTokenTrace(
  trace: { readonly source?: unknown; readonly ownerSlug?: unknown; readonly agentId?: unknown } | null | undefined,
): ModelBrokerTokenTrace | null {
  const source = traceSource(trace?.source);
  if (!source) return null;
  return {
    source,
    ownerSlug: optionalTraceString(trace?.ownerSlug),
    agentId: optionalTraceString(trace?.agentId),
  };
}

function mintModelBrokerToken(input: IssueModelBrokerTokenInput): {
  token: string;
  record: ModelBrokerTokenRecord;
} {
  const now = input.now ?? Date.now();
  const ttl = normalizeTtlSeconds(input.ttlSeconds);
  const randomBytes = input.randomBytes ?? crypto.randomBytes;
  const token = `ogk_${input.gatewayId}_${randomBytes(32).toString("base64url")}`;
  return {
    token,
    record: {
      tokenHash: hashModelBrokerToken(token),
      gatewayId: input.gatewayId,
      ownerUid: input.ownerUid ?? null,
      provider: input.provider,
      purpose: input.purpose ?? "model",
      capped: true,
      secretName: input.secretName,
      createdAt: now,
      expiresAt: ttl ? now + ttl * 1000 : null,
      limits: normalizeModelBrokerTokenLimits(input.limits),
      policy: normalizeModelBrokerTokenPolicy(input.policy),
      trace: normalizeModelBrokerTokenTrace(input.trace),
      revoked: false,
    },
  };
}

function lookupOutcome(record: ModelBrokerTokenRecord, now: number): ModelBrokerTokenLookup {
  if (record.revoked) return { outcome: "revoked", record };
  if (record.expiresAt !== null && record.expiresAt <= now) return { outcome: "expired", record };
  return { outcome: "valid", record };
}

function storedToken(record: ModelBrokerTokenRecord): ModelBrokerToken {
  return {
    tokenHash: record.tokenHash,
    gatewayId: record.gatewayId,
    ownerUid: record.ownerUid,
    provider: record.provider,
    purpose: record.purpose,
    secretName: record.secretName,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    limits: record.limits,
    railPolicy: { ...record.policy },
    trace: record.trace === null ? null : { ...record.trace },
    revoked: record.revoked,
    revokedAt: record.revokedAt ?? null,
  };
}

function tokenRecord(token: ModelBrokerToken): ModelBrokerTokenRecord {
  return {
    tokenHash: token.tokenHash,
    gatewayId: token.gatewayId,
    ownerUid: token.ownerUid,
    provider: token.provider,
    purpose: token.purpose,
    capped: true,
    secretName: token.secretName,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    limits: normalizeModelBrokerTokenLimits(token.limits),
    policy: normalizeModelBrokerTokenPolicy(token.railPolicy),
    trace: normalizeModelBrokerTokenTrace(token.trace),
    revoked: token.revoked,
    ...(token.revokedAt === null ? {} : { revokedAt: token.revokedAt }),
  };
}

export class InMemoryModelBrokerTokenStore implements ModelBrokerTokenStore {
  private readonly tokens = new Map<string, ModelBrokerTokenRecord>();
  private readonly pointers = new Map<string, string>();

  async issueToken(input: IssueModelBrokerTokenInput): Promise<{
    token: string;
    record: ModelBrokerTokenRecord;
  }> {
    const { token, record } = mintModelBrokerToken(input);
    const { tokenHash, createdAt: now } = record;
    this.tokens.set(tokenHash, record);
    if (!input.skipPointer) {
      const pointerKey = input.pointerKey ?? input.gatewayId;
      const previousHash = this.pointers.get(pointerKey);
      if (previousHash && previousHash !== tokenHash && this.tokens.has(previousHash)) {
        const previous = this.tokens.get(previousHash)!;
        this.tokens.set(previousHash, { ...previous, revoked: true, revokedAt: now });
      }
      this.pointers.set(pointerKey, tokenHash);
    }
    return { token, record };
  }

  async revokeGatewayToken(input: RevokeModelBrokerTokenInput): Promise<{ revoked: boolean }> {
    const pointerKey = input.pointerKey ?? input.gatewayId;
    const tokenHash = this.pointers.get(pointerKey);
    if (!tokenHash) return { revoked: false };
    const existing = this.tokens.get(tokenHash);
    this.pointers.delete(pointerKey);
    if (!existing || existing.provider !== input.provider || existing.secretName !== input.secretName) {
      return { revoked: false };
    }
    this.tokens.set(tokenHash, {
      ...existing,
      revoked: true,
      revokedAt: input.now ?? Date.now(),
    });
    return { revoked: true };
  }

  async lookupToken(token: string, now = Date.now()): Promise<ModelBrokerTokenLookup> {
    const record = this.tokens.get(hashModelBrokerToken(token));
    return record ? lookupOutcome(record, now) : { outcome: "unknown" };
  }
}

async function replaceGatewayToken(
  state: PlatformStateStore,
  token: ModelBrokerToken,
  pointerKey: string,
): Promise<void> {
  await state.transaction({ label: "model-broker-token.issue" }, async (tx) => {
    const pointer = await tx.access.modelBrokerGatewayTokens.get(pointerKey);
    const previous = pointer === null ? null : await tx.access.modelBrokerTokens.get(pointer.tokenHash);
    await tx.access.modelBrokerTokens.create(token);
    if (previous !== null) await tx.access.modelBrokerTokens.revoke(previous.tokenHash, token.createdAt);
    await tx.access.modelBrokerGatewayTokens.put({
      pointerKey,
      gatewayId: token.gatewayId,
      ownerUid: token.ownerUid,
      provider: token.provider,
      secretName: token.secretName,
      tokenHash: token.tokenHash,
      updatedAt: token.createdAt,
    });
  });
}

export function createModelBrokerTokenStore(state: PlatformStateStore): ModelBrokerTokenStore {
  return {
    async issueToken(input) {
      const issued = mintModelBrokerToken(input);
      const token = storedToken(issued.record);
      await (input.skipPointer
        ? state.access.modelBrokerTokens.create(token)
        : replaceGatewayToken(state, token, input.pointerKey ?? input.gatewayId));
      return issued;
    },

    async revokeGatewayToken(input) {
      const pointerKey = input.pointerKey ?? input.gatewayId;
      const revokedAt = input.now ?? Date.now();
      return state.transaction({ label: "model-broker-token.revoke" }, async (tx) => {
        const pointer = await tx.access.modelBrokerGatewayTokens.get(pointerKey);
        if (pointer === null || pointer.provider !== input.provider || pointer.secretName !== input.secretName) {
          return { revoked: false };
        }
        await tx.access.modelBrokerTokens.revoke(pointer.tokenHash, revokedAt);
        await tx.access.modelBrokerGatewayTokens.delete(pointerKey);
        return { revoked: true };
      });
    },

    async lookupToken(token, now = Date.now()) {
      const stored = await state.access.modelBrokerTokens.get(hashModelBrokerToken(token));
      return stored === null ? { outcome: "unknown" } : lookupOutcome(tokenRecord(stored), now);
    },
  };
}
