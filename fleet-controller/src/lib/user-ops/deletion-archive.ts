import {
  anonymousOperationalEnvironment,
  anonymousOperationalGatewayClass,
  isAnonymousOperationalModelDimension,
} from "@octogee/shared/types/account-lifecycle";

interface DeletionArchiveInput {
  archivedAt: number;
  createdAt: number | null;
  deletionRequestedAt: number;
  environment: string;
  productFields: Record<string, unknown>;
  gatewayClass: string | null;
  rollup: Record<string, unknown>;
}

interface AnonymousModelAggregate {
  provider: string;
  model: string;
  costUsd: number;
  totalTokens: number;
  requestCount: number;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function month(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return new Date(value).toISOString().slice(0, 7);
}

function canonicalAnthropicModel(raw: string): string {
  if (raw.includes("fable")) return "fable";
  if (raw.includes("mythos")) return "mythos";
  if (raw.includes("sonnet")) return "sonnet";
  if (raw.includes("haiku-3-5") || raw.includes("haiku-3.5")) return "haiku-3.5";
  if (raw.includes("haiku")) return "haiku-4.5";
  if (raw.includes("opus-4-1") || raw.includes("opus-4-0")) return "opus-legacy";
  if (raw.includes("opus")) return "opus-latest";
  return "unknown-fable-fallback";
}

function canonicalProviderModel(provider: string, raw: string): string {
  if (provider === "anthropic") return canonicalAnthropicModel(raw);
  if (provider === "openrouter") {
    const known = raw === "z-ai/glm-5.2" ||
      raw === "deepseek/deepseek-v4-pro" ||
      raw === "openai/gpt-5.6-luna";
    return known ? `openrouter:${raw}` : "openrouter:unknown-fallback";
  }
  if (provider === "openai") {
    const known = ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-5.4-mini"]
      .find((id) => raw === id || raw.startsWith(`${id}-`));
    return known ? `openai:${known}` : "openai:unknown-fallback";
  }
  if (provider === "brave") return raw === "brave/web-search" ? raw : "brave/unknown";
  if (provider === "tavily") {
    const known = [
      "tavily/search-basic",
      "tavily/search-advanced",
      "tavily/extract-basic",
      "tavily/extract-advanced",
    ].includes(raw);
    return known ? raw : "tavily/unknown";
  }
  return "unknown";
}

function canonicalModelDimension(
  providerValue: unknown,
  modelValue: unknown,
  billingModelValue: unknown,
): { provider: string; model: string } {
  const provider = typeof providerValue === "string" ? providerValue : "unknown";
  if (isAnonymousOperationalModelDimension(provider, billingModelValue)) {
    return { provider, model: billingModelValue as string };
  }
  const raw = typeof modelValue === "string" ? modelValue.toLowerCase() : "";
  const model = canonicalProviderModel(provider, raw);
  return isAnonymousOperationalModelDimension(provider, model)
    ? { provider, model }
    : { provider: "unknown", model: "unknown" };
}

function modelAggregates(rollup: Record<string, unknown>): AnonymousModelAggregate[] {
  const source = rollup.models;
  if (!source || typeof source !== "object" || Array.isArray(source)) return [];
  const aggregates = new Map<string, AnonymousModelAggregate>();
  for (const raw of Object.values(source as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const data = raw as Record<string, unknown>;
    const dimension = canonicalModelDimension(
      data.provider ?? rollup.provider,
      data.model,
      data.billingModel,
    );
    const key = `${dimension.provider}:${dimension.model}`;
    const current = aggregates.get(key) ?? {
      ...dimension,
      costUsd: 0,
      totalTokens: 0,
      requestCount: 0,
    };
    current.costUsd += nonNegative(data.costUsd);
    current.totalTokens += nonNegative(data.totalTokens);
    current.requestCount += nonNegative(data.requestCount);
    aggregates.set(key, current);
  }
  return Array.from(aggregates.values()).sort((a, b) =>
    `${a.provider}:${a.model}`.localeCompare(`${b.provider}:${b.model}`));
}

export function buildAnonymousOperationalArchive(input: DeletionArchiveInput) {
  return {
    ...input.productFields,
    schemaVersion: 1,
    archivedAt: input.archivedAt,
    accountCreatedMonth: month(input.createdAt),
    deletionRequestedMonth: month(input.deletionRequestedAt),
    environment: anonymousOperationalEnvironment(input.environment),
    gatewayClass: anonymousOperationalGatewayClass(input.gatewayClass),
    totals: {
      costUsd: nonNegative(input.rollup.costUsd),
      totalTokens: nonNegative(input.rollup.totalTokens),
      requestCount: nonNegative(input.rollup.requestCount),
    },
    models: modelAggregates(input.rollup),
  };
}
