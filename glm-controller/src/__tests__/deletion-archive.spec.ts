import { describe, expect, it } from "vitest";
import { buildAnonymousOperationalArchive } from "../lib/user-ops/deletion-archive.js";

describe("buildAnonymousOperationalArchive", () => {
  it("keeps GPT-5.6 Luna as a closed OpenRouter billing dimension", () => {
    const archive = buildAnonymousOperationalArchive({
      archivedAt: Date.UTC(2026, 6, 30),
      createdAt: Date.UTC(2026, 6, 1),
      deletionRequestedAt: Date.UTC(2026, 6, 29),
      environment: "test",
      productFields: {},
      gatewayClass: "isolated",
      rollup: {
        models: {
          luna: {
            provider: "openrouter",
            model: "openai/gpt-5.6-luna",
            costUsd: 0.71,
            totalTokens: 2_000_000,
            requestCount: 4,
          },
        },
      },
    });

    expect(archive.models).toEqual([
      {
        provider: "openrouter",
        model: "openrouter:openai/gpt-5.6-luna",
        costUsd: 0.71,
        totalTokens: 2_000_000,
        requestCount: 4,
      },
    ]);
  });

  it("keeps aggregate operational costs while excluding every identifying input", () => {
    const archive = buildAnonymousOperationalArchive({
      archivedAt: Date.UTC(2026, 6, 19),
      createdAt: Date.UTC(2025, 0, 2),
      deletionRequestedAt: Date.UTC(2026, 6, 1),
      environment: "test",
      productFields: { planTier: "builder" },
      gatewayClass: "isolated",
      rollup: {
        costUsd: 12.34,
        totalTokens: 987_654,
        requestCount: 321,
        models: {
          one: { provider: "openai", model: "gpt-5.4", costUsd: 10, totalTokens: 800_000, requestCount: 300 },
          four: { provider: "openai", model: "gpt-6-luna-2026-10-01", costUsd: 0.5, totalTokens: 1_000, requestCount: 4 },
          two: { provider: "anthropic", model: "claude-sonnet-4-6", costUsd: 2.34, totalTokens: 187_654, requestCount: 21 },
          three: { provider: "alice@example.com", model: "alice@example.com", costUsd: 1, totalTokens: 10, requestCount: 1 },
        },
        ownerUid: "uid-alice",
        email: "alice@example.com",
      },
    });

    expect(archive).toEqual({
      schemaVersion: 1,
      archivedAt: Date.UTC(2026, 6, 19),
      accountCreatedMonth: "2025-01",
      deletionRequestedMonth: "2026-07",
      environment: "test",
      planTier: "builder",
      gatewayClass: "isolated",
      totals: { costUsd: 12.34, totalTokens: 987_654, requestCount: 321 },
      models: [
        { provider: "anthropic", model: "sonnet", costUsd: 2.34, totalTokens: 187_654, requestCount: 21 },
        { provider: "openai", model: "openai:gpt-6-luna", costUsd: 0.5, totalTokens: 1_000, requestCount: 4 },
        { provider: "openai", model: "openai:unknown-fallback", costUsd: 10, totalTokens: 800_000, requestCount: 300 },
        { provider: "unknown", model: "unknown", costUsd: 1, totalTokens: 10, requestCount: 1 },
      ],
    });
    const json = JSON.stringify(archive);
    expect(json).not.toContain("uid-alice");
    expect(json).not.toContain("alice@example.com");
    expect(json).not.toMatch(/uid|email|slug|displayName|stripe|mattermost|gitea|gatewayId|secretName/i);
  });

  it("normalizes malformed or negative counters to zero", () => {
    const archive = buildAnonymousOperationalArchive({
      archivedAt: 1,
      createdAt: null,
      deletionRequestedAt: 2,
      environment: "alice@example.com",
      productFields: {},
      gatewayClass: "alice@example.com",
      rollup: { costUsd: -1, totalTokens: "many", requestCount: Number.NaN },
    });
    expect(archive.totals).toEqual({ costUsd: 0, totalTokens: 0, requestCount: 0 });
    expect(archive.accountCreatedMonth).toBeNull();
    expect(archive.environment).toBe("unknown");
    expect(archive).not.toHaveProperty("planTier");
    expect(archive.gatewayClass).toBeNull();
    expect(archive.models).toEqual([]);
  });
});
