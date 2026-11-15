import * as crypto from "node:crypto";
export function hashModelBrokerToken(token) {
    return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}
function normalizeTtlSeconds(ttlSeconds) {
    if (ttlSeconds === null || ttlSeconds === undefined)
        return null;
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0)
        return null;
    return Math.floor(ttlSeconds);
}
function nonNegativeLimit(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
export function normalizeModelBrokerTokenLimits(limits) {
    return {
        spendWindowUsd: nonNegativeLimit(limits?.spendWindowUsd),
        spendWeekUsd: nonNegativeLimit(limits?.spendWeekUsd),
        requestsPerMinute: nonNegativeLimit(limits?.requestsPerMinute),
    };
}
export function normalizeModelBrokerTokenPolicy(policy) {
    return {
        freeTier: policy?.freeTier === true,
        houseFallback: policy?.houseFallback !== false,
    };
}
function traceSource(value) {
    return value === "gateway_model_key_issuer" || value === "shared_agent_model_token"
        ? value
        : null;
}
function optionalTraceString(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
}
function normalizeModelBrokerTokenTrace(trace) {
    const source = traceSource(trace?.source);
    if (!source)
        return null;
    return {
        source,
        ownerSlug: optionalTraceString(trace?.ownerSlug),
        agentId: optionalTraceString(trace?.agentId),
    };
}
function mintModelBrokerToken(input) {
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
function lookupOutcome(record, now) {
    if (record.revoked)
        return { outcome: "revoked", record };
    if (record.expiresAt !== null && record.expiresAt <= now)
        return { outcome: "expired", record };
    return { outcome: "valid", record };
}
function storedToken(record) {
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
function tokenRecord(token) {
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
export class InMemoryModelBrokerTokenStore {
    tokens = new Map();
    pointers = new Map();
    async issueToken(input) {
        const { token, record } = mintModelBrokerToken(input);
        const { tokenHash, createdAt: now } = record;
        this.tokens.set(tokenHash, record);
        if (!input.skipPointer) {
            const pointerKey = input.pointerKey ?? input.gatewayId;
            const previousHash = this.pointers.get(pointerKey);
            if (previousHash && previousHash !== tokenHash && this.tokens.has(previousHash)) {
                const previous = this.tokens.get(previousHash);
                this.tokens.set(previousHash, { ...previous, revoked: true, revokedAt: now });
            }
            this.pointers.set(pointerKey, tokenHash);
        }
        return { token, record };
    }
    async revokeGatewayToken(input) {
        const pointerKey = input.pointerKey ?? input.gatewayId;
        const tokenHash = this.pointers.get(pointerKey);
        if (!tokenHash)
            return { revoked: false };
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
    async lookupToken(token, now = Date.now()) {
        const record = this.tokens.get(hashModelBrokerToken(token));
        return record ? lookupOutcome(record, now) : { outcome: "unknown" };
    }
}
async function replaceGatewayToken(state, token, pointerKey) {
    await state.transaction({ label: "model-broker-token.issue" }, async (tx) => {
        const pointer = await tx.access.modelBrokerGatewayTokens.get(pointerKey);
        const previous = pointer === null ? null : await tx.access.modelBrokerTokens.get(pointer.tokenHash);
        await tx.access.modelBrokerTokens.create(token);
        if (previous !== null)
            await tx.access.modelBrokerTokens.revoke(previous.tokenHash, token.createdAt);
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
export function createModelBrokerTokenStore(state) {
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
