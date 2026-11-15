import { GoogleAuth } from "google-auth-library";
import { modelCatalogEntryFor } from "@octogee/shared/types/model-catalog";

import type { AnthropicCacheWriteTtl, AnthropicTokenUsage } from "./model-broker-usage.js";

export const VERTEX_ENABLED_ENV = "PLATFORM_VERTEX_ENABLED";
export const VERTEX_PROJECT_ID_ENV = "PLATFORM_VERTEX_PROJECT_ID";
export const VERTEX_LOCATION_ENV = "PLATFORM_VERTEX_LOCATION";
export const VERTEX_MODEL_PRICES_ENV = "PLATFORM_VERTEX_MODEL_PRICES";
export const VERTEX_UPSTREAM_BASE_URL_ENV = "VERTEX_UPSTREAM_BASE_URL";
export const DEFAULT_VERTEX_LOCATION = "global";
export const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";
const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKENS_PER_MILLION = 1_000_000;

const RATE_FIELDS = [
  "inputPerMTok",
  "outputPerMTok",
  "cacheReadPerMTok",
  "cacheWrite5mPerMTok",
  "cacheWrite1hPerMTok",
] as const;

export interface VertexModelRates {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
}

export interface VertexModelPrice extends VertexModelRates {
  longContext?: VertexModelRates & { aboveInputTokens: number };
}

export type VertexModelPriceTable = Record<string, VertexModelPrice>;

export interface VertexProviderConfig {
  projectId: string;
  location: string;
  prices: VertexModelPriceTable;
  baseUrl?: string;
}

export interface VertexUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  pricingModel: string;
}

export class VertexRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VertexRequestError";
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireRate(model: string, record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`vertex price entry ${model} needs a non-negative ${field}`);
  }
  return value;
}

function parseRates(model: string, value: unknown): VertexModelRates {
  const record = objectRecord(value);
  if (!record) throw new Error(`vertex price entry ${model} must be an object`);
  return Object.fromEntries(
    RATE_FIELDS.map((field) => [field, requireRate(model, record, field)]),
  ) as unknown as VertexModelRates;
}

export function parseVertexModelPrices(value: unknown): VertexModelPriceTable {
  const table = objectRecord(value);
  if (!table || Object.keys(table).length === 0) {
    throw new Error("vertex price table must list at least one model");
  }
  const prices: VertexModelPriceTable = {};
  for (const [model, entry] of Object.entries(table)) {
    const rates = parseRates(model, entry);
    const longContextRaw = objectRecord(entry)?.longContext;
    if (longContextRaw === undefined) {
      prices[model] = rates;
      continue;
    }
    const longContext = parseRates(`${model}.longContext`, longContextRaw);
    const aboveInputTokens = requireRate(`${model}.longContext`, objectRecord(longContextRaw)!, "aboveInputTokens");
    prices[model] = { ...rates, longContext: { ...longContext, aboveInputTokens } };
  }
  return prices;
}

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function vertexProviderConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VertexProviderConfig | null {
  if (!enabled(env[VERTEX_ENABLED_ENV])) return null;
  const projectId = env[VERTEX_PROJECT_ID_ENV]?.trim();
  if (!projectId) {
    throw new Error(`${VERTEX_PROJECT_ID_ENV} is required when ${VERTEX_ENABLED_ENV} is set`);
  }
  const rawPrices = env[VERTEX_MODEL_PRICES_ENV]?.trim();
  if (!rawPrices) {
    throw new Error(`${VERTEX_MODEL_PRICES_ENV} is required when ${VERTEX_ENABLED_ENV} is set`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPrices);
  } catch (err) {
    throw new Error(`${VERTEX_MODEL_PRICES_ENV} is not valid JSON: ${(err as Error).message}`);
  }
  const baseUrl = env[VERTEX_UPSTREAM_BASE_URL_ENV]?.trim();
  return {
    projectId,
    location: env[VERTEX_LOCATION_ENV]?.trim() || DEFAULT_VERTEX_LOCATION,
    prices: parseVertexModelPrices(parsed),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export function resolveVertexModel(model: string): string | null {
  return modelCatalogEntryFor("vertex", model)?.upstreamId ?? null;
}

export function vertexUpstreamUrl(
  config: Pick<VertexProviderConfig, "projectId" | "location" | "baseUrl">,
  model: string,
  stream: boolean,
): string {
  const host = config.location === "global"
    ? "https://aiplatform.googleapis.com"
    : `https://${config.location}-aiplatform.googleapis.com`;
  let base = config.baseUrl ?? host;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const verb = stream ? "streamRawPredict" : "rawPredict";
  return `${base}/v1/projects/${config.projectId}/locations/${config.location}/publishers/anthropic/models/${model}:${verb}`;
}

export interface TranslatedVertexRequest {
  model: string;
  stream: boolean;
  body: Buffer;
}

export function translateVertexMessagesRequest(input: {
  body: unknown;
  betaHeader: string | undefined;
}): TranslatedVertexRequest {
  if (!Buffer.isBuffer(input.body)) throw new VertexRequestError("vertex request body must be JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body.toString("utf8"));
  } catch {
    throw new VertexRequestError("vertex request body must be JSON");
  }
  const record = objectRecord(parsed);
  if (!record) throw new VertexRequestError("vertex request body must be a JSON object");
  const requested = record.model;
  if (typeof requested !== "string" || !requested) {
    throw new VertexRequestError("vertex request needs a model");
  }
  const model = resolveVertexModel(requested);
  if (!model) throw new VertexRequestError(`vertex does not serve model ${requested}`);
  const { model: _model, ...rest } = record;
  const betas = (input.betaHeader ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const body = {
    anthropic_version: VERTEX_ANTHROPIC_VERSION,
    ...(betas.length ? { anthropic_beta: betas } : {}),
    ...rest,
  };
  return {
    model,
    stream: record.stream === true,
    body: Buffer.from(JSON.stringify(body), "utf8"),
  };
}

function usd(tokens: number, perMTok: number): number {
  return (tokens / TOKENS_PER_MILLION) * perMTok;
}

export function computeVertexCost(
  prices: VertexModelPriceTable,
  model: string,
  usage: AnthropicTokenUsage,
  cacheWriteTtl: AnthropicCacheWriteTtl,
): VertexUsageCost {
  const entry = prices[model];
  if (!entry) throw new Error(`vertex price table has no price entry for model ${model}`);
  const inputTokens = usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
  const rates: VertexModelRates =
    entry.longContext && inputTokens > entry.longContext.aboveInputTokens ? entry.longContext : entry;
  const input = usd(usage.inputTokens, rates.inputPerMTok);
  const output = usd(usage.outputTokens, rates.outputPerMTok);
  const cacheRead = usd(usage.cacheReadInputTokens, rates.cacheReadPerMTok);
  const cacheWrite = usd(
    usage.cacheCreationInputTokens,
    cacheWriteTtl === "1h" ? rates.cacheWrite1hPerMTok : rates.cacheWrite5mPerMTok,
  );
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    pricingModel: `vertex:${model}`,
  };
}

export function createVertexAccessTokenResolver(): () => Promise<string> {
  const auth = new GoogleAuth({ scopes: [VERTEX_SCOPE] });
  return async () => {
    const token = await auth.getAccessToken();
    if (!token) throw new Error("vertex access token resolution returned no token");
    return token;
  };
}
