import { once } from "node:events";
import * as crypto from "node:crypto";
import express, { type Request, type Response as ExpressResponse, type NextFunction } from "express";
import { rateLimit } from "express-rate-limit";

import type {
  ModelBrokerProviderKeyResolver,
  ModelBrokerProviderKey,
  ModelBrokerProviderKeySource,
} from "./lib/model-broker-provider-keys.js";
import type {
  ModelBrokerProvider,
  ModelBrokerTokenLookup,
  ModelBrokerTokenRecord,
  ModelBrokerTokenStore,
} from "./lib/model-broker-tokens.js";
import type { FundedBudgetInterruptionHandler } from "./lib/model-broker-budget.js";
import type {
  LiveOwnerGrantResolver,
  OwnerModelBrokerGrant,
} from "./lib/model-broker-limits.js";
import {
  estimateModelBrokerCost,
  isUnknownAnthropicPricingModel,
  isUnknownOpenAiPricingModel,
  isUnknownOpenRouterPricingModel,
  mergeAnthropicUsage,
  normalizeAnthropicUsage,
  totalTokens,
  type AnthropicCacheWriteTtl,
  type AnthropicTokenUsage,
  type ModelBrokerUsageStore,
} from "./lib/model-broker-usage.js";
import type { ResolvedHouseModel } from "@octogee/shared/types/platform-config";
import {
  spendWindowGate,
  type DegradeOutcome,
  type GateDecision,
  type GateDecisionAllowed,
  type GateDecisionDenied,
  type RailGateContext,
} from "./lib/model-broker-gate.js";
import {
  CHARGE_AT_COST,
  type ModelBrokerRail,
  type ModelBrokerRailRegistry,
  type RailCharge,
  type RailMeter,
} from "./lib/model-broker-rails.js";
import type { ModelBrokerOwnerAccessResolver } from "./lib/model-broker-owner-access.js";
import { modelCatalogForProvider } from "@octogee/shared/types/model-catalog";
import {
  VertexRequestError,
  computeVertexCost,
  translateVertexMessagesRequest,
  vertexUpstreamUrl,
  type VertexModelPriceTable,
  type VertexProviderConfig,
} from "./lib/vertex-provider.js";

export interface VertexBrokerConfig extends VertexProviderConfig {
  accessToken: () => Promise<string>;
}

export interface LlmBrokerAppDeps {
  store: Pick<ModelBrokerTokenStore, "lookupToken">;
  usageStore?: ModelBrokerUsageStore;
  providerKeys: Partial<Record<ModelBrokerProvider, string | undefined>>;
  providerKeyResolver?: ModelBrokerProviderKeyResolver;
  vertex?: VertexBrokerConfig;
  upstreamBaseUrl?: string;
  providerUpstreamBaseUrls?: Partial<Record<ModelBrokerProvider, string | undefined>>;
  houseModel?: string;
  providerHouseModels?: Partial<Record<ModelBrokerProvider, string | undefined>>;
  resolveHouseModel?: () => Promise<ResolvedHouseModel | null>;
  fetchImpl?: typeof fetch;
  upstreamHeaderTimeoutMs?: number;
  now?: () => number;
  bodyLimit?: string;
  onMeteringError?: (err: unknown) => void;
  // Live per-owner grant resolution (tier limits + policy). When present it is
  // authoritative on every call — mint-time token limits stop being load-bearing,
  // so plan changes and funded budget transitions reach the gate within one cache TTL.
  resolveGrant?: LiveOwnerGrantResolver;
  resolveOwnerAccess?: ModelBrokerOwnerAccessResolver;
  // Structured gate-decision log: one line per proxied model call with the
  // owner, budget, and model routing needed to verify billing in TEST.
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  onBudgetInterruption?: FundedBudgetInterruptionHandler;
  rails: ModelBrokerRailRegistry;
}

const DEFAULT_ANTHROPIC_UPSTREAM_BASE_URL = "https://api.anthropic.com";
const DEFAULT_OPENROUTER_UPSTREAM_BASE_URL = "https://openrouter.ai/api";
const DEFAULT_OPENAI_UPSTREAM_BASE_URL = "https://api.openai.com";
const DEFAULT_HOUSE_MODEL = "claude-haiku-4-5";
const DEFAULT_OPENROUTER_HOUSE_MODEL = "z-ai/glm-5.2";
const DEFAULT_OPENAI_HOUSE_MODEL = "gpt-6-luna";
const DEFAULT_VERTEX_HOUSE_MODEL = "claude-haiku-4-5@20251001";
const PLATFORM_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_BODY_LIMIT = "32mb";
const DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS = 120_000;
const MAX_SSE_METERING_BUFFER_CHARS = 1_000_000;

class UpstreamHeaderTimeoutError extends Error {
  constructor() {
    super("llm broker upstream timed out");
    this.name = "UpstreamHeaderTimeoutError";
  }
}

const ALLOWED_ANTHROPIC_ENDPOINTS = new Set([
  "GET /v1/models",
  "POST /v1/messages",
  "POST /v1/messages/count_tokens",
]);

const ALLOWED_OPENROUTER_ENDPOINTS = new Set([
  "GET /v1/models",
  "POST /v1/chat/completions",
]);

const ALLOWED_VERTEX_ENDPOINTS = new Set(["POST /v1/messages"]);

const ALLOWED_OPENAI_MODEL_ENDPOINTS = new Set([
  "GET /v1/models",
  "POST /v1/chat/completions",
  "POST /v1/responses",
]);

const ALLOWED_OPENAI_EMBEDDING_ENDPOINTS = new Set([
  "POST /v1/embeddings",
]);

const ALLOWED_LLM_ENDPOINTS = new Set([
  ...ALLOWED_ANTHROPIC_ENDPOINTS,
  ...ALLOWED_OPENROUTER_ENDPOINTS,
  ...ALLOWED_OPENAI_MODEL_ENDPOINTS,
  ...ALLOWED_OPENAI_EMBEDDING_ENDPOINTS,
]);

const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const PASSTHROUGH_REQUEST_HEADERS = new Set([
  "accept",
  "anthropic-beta",
  "anthropic-version",
  "content-type",
  "user-agent",
]);

function trimTrailingSlash(value: string): string {
  let out = value.trim();
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function configuredString(...values: (string | undefined)[]): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function authToken(req: Request): string {
  const xApiKey = req.get("x-api-key");
  if (xApiKey?.trim()) return xApiKey.trim();
  const auth = req.get("authorization") ?? "";
  const [scheme, ...rest] = auth.split(" ");
  if (scheme?.toLowerCase() !== "bearer") return "";
  return rest.join(" ").trim();
}

function requestUrl(req: Request): URL {
  return new URL(req.originalUrl, "https://llm-broker.local");
}

function allowedEndpoint(req: Request, url: URL): boolean {
  return ALLOWED_LLM_ENDPOINTS.has(`${req.method.toUpperCase()} ${url.pathname}`);
}

const ALLOWED_ENDPOINTS_BY_PROVIDER: Record<ModelBrokerProvider, ReadonlySet<string>> = {
  anthropic: ALLOWED_ANTHROPIC_ENDPOINTS,
  vertex: ALLOWED_VERTEX_ENDPOINTS,
  openai: ALLOWED_OPENAI_MODEL_ENDPOINTS,
  meta: new Set(["POST /v1/responses"]),
  openrouter: ALLOWED_OPENROUTER_ENDPOINTS,
};

function providerAllowedEndpoint(
  record: ModelBrokerTokenRecord,
  req: Request,
  url: URL,
): boolean {
  const key = `${req.method.toUpperCase()} ${url.pathname}`;
  return record.purpose === "embeddings"
    ? record.provider === "openai" &&
        ALLOWED_OPENAI_EMBEDDING_ENDPOINTS.has(key)
    : ALLOWED_ENDPOINTS_BY_PROVIDER[record.provider].has(key);
}

function upstreamHeaders(req: Request, apiKey: string, provider: ModelBrokerProvider): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (!PASSTHROUGH_REQUEST_HEADERS.has(lower)) continue;
    if (Array.isArray(value)) {
      headers.set(name, value.join(", "));
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  if (provider === "anthropic") {
    headers.set("x-api-key", apiKey);
  } else {
    headers.set("authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

function vertexUpstreamHeaders(req: Request, accessToken: string): Headers {
  const headers = new Headers();
  const accept = req.get("accept");
  if (accept) headers.set("accept", accept);
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${accessToken}`);
  return headers;
}

function providerConfigured(deps: LlmBrokerAppDeps, provider: ModelBrokerProvider): boolean {
  return provider === "vertex" ? Boolean(deps.vertex) : Boolean(deps.providerKeys[provider]);
}

async function resolveProviderKey(input: {
  record: ModelBrokerTokenRecord;
  providerKeys: Partial<Record<ModelBrokerProvider, string | undefined>>;
  providerKeyResolver?: ModelBrokerProviderKeyResolver;
  vertex?: VertexBrokerConfig;
}): Promise<ModelBrokerProviderKey | null> {
  if (input.record.provider === "vertex") {
    if (!input.vertex) return null;
    return { apiKey: await input.vertex.accessToken(), source: "platform" };
  }
  if (input.providerKeyResolver) {
    return input.providerKeyResolver({
      provider: input.record.provider,
      record: input.record,
    });
  }
  const apiKey = input.providerKeys[input.record.provider]?.trim();
  return apiKey ? { apiKey, source: "platform" } : null;
}

type ProviderKeyResolution =
  | { key: ModelBrokerProviderKey }
  | { refusal: "no_key_configured" | "key_resolution_failed" };

async function resolveProviderKeyForRequest(input: {
  record: ModelBrokerTokenRecord;
  providerKeys: Partial<Record<ModelBrokerProvider, string | undefined>>;
  providerKeyResolver?: ModelBrokerProviderKeyResolver;
  vertex?: VertexBrokerConfig;
  onError: (err: unknown) => void;
}): Promise<ProviderKeyResolution> {
  try {
    const key = await resolveProviderKey({
      record: input.record,
      providerKeys: input.providerKeys,
      providerKeyResolver: input.providerKeyResolver,
      vertex: input.vertex,
    });
    return key ? { key } : { refusal: "no_key_configured" };
  } catch (err) {
    input.onError(err);
    return { refusal: "key_resolution_failed" };
  }
}

function isEventStream(upstream: globalThis.Response): boolean {
  return (upstream.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

function isJson(upstream: globalThis.Response): boolean {
  return (upstream.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

function shouldMeter(
  provider: ModelBrokerProvider,
  req: Request,
  url: URL,
  upstream: globalThis.Response,
): boolean {
  if (req.method.toUpperCase() !== "POST" || !upstream.ok) return false;
  return provider === "anthropic" || provider === "vertex"
    ? url.pathname === "/v1/messages"
    : url.pathname === "/v1/chat/completions" ||
        (provider === "openai" && ["/v1/embeddings", "/v1/responses"].includes(url.pathname)) ||
        (provider === "meta" && url.pathname === "/v1/responses");
}

function readRequestMetadata(body: unknown): {
  model: string | null;
  cacheWriteTtl: AnthropicCacheWriteTtl;
} {
  if (!Buffer.isBuffer(body)) return { model: null, cacheWriteTtl: "5m" };
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    const model =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>).model
        : null;
    return {
      model: typeof model === "string" && model ? model : null,
      cacheWriteTtl: containsOneHourCacheControl(parsed) ? "1h" : "5m",
    };
  } catch {
    return { model: null, cacheWriteTtl: "5m" };
  }
}

// Body rewrites preserve the rest of the request (messages, cache_control
// breakpoints, tools): degrade swaps only the top-level `model`; OpenRouter
// chat completions additionally get `usage: {include: true}` so the response
// carries the upstream's own USD accounting — the broker meters that reported
// cost instead of a static table estimate. Returns null on a non-JSON body so
// the caller forwards the original bytes unchanged.
function rewriteRequestBody(input: {
  body: unknown;
  degradeModel: string | null;
  includeOpenRouterUsage: boolean;
}): Buffer | null {
  if (!Buffer.isBuffer(input.body)) return null;
  if (!input.degradeModel && !input.includeOpenRouterUsage) return null;
  try {
    const parsed = JSON.parse(input.body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (input.degradeModel) record.model = input.degradeModel;
    if (input.includeOpenRouterUsage) record.usage = { include: true };
    return Buffer.from(JSON.stringify(record), "utf8");
  } catch {
    return null;
  }
}

function containsOneHourCacheControl(value: unknown): boolean {
  const stack = [value];
  const seen = new Set<object>();
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    const cacheControl = record.cache_control;
    if (cacheControl && typeof cacheControl === "object" && !Array.isArray(cacheControl)) {
      const ttl = (cacheControl as Record<string, unknown>).ttl;
      if (ttl === "1h") return true;
    }
    stack.push(...Object.values(record));
  }
  return false;
}

// Anthropic reports one aggregate cache-creation counter even when a request
// mixes 5m and 1h breakpoints. Pricing all cache creation at 1h when any 1h
// breakpoint appears deliberately over-counts until we have per-block usage.

function copyResponseHeaders(upstream: globalThis.Response, res: ExpressResponse): void {
  upstream.headers.forEach((value, key) => {
    if (!FORBIDDEN_RESPONSE_HEADERS.has(key.toLowerCase())) {
      res.setHeader(key, value);
    }
  });
}

async function writeChunk(res: ExpressResponse, chunk: Uint8Array): Promise<void> {
  if (!res.write(Buffer.from(chunk))) {
    await once(res, "drain");
  }
}

const ANTHROPIC_USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

function invalidAnthropicUsageFields(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const data = value as Record<string, unknown>;
  return ANTHROPIC_USAGE_FIELDS.filter((field) => {
    if (!(field in data)) return false;
    const raw = data[field];
    return typeof raw !== "number" || !Number.isFinite(raw) || raw < 0;
  });
}

interface AnthropicPayloadExtraction {
  usage: AnthropicTokenUsage | null;
  model: string | null;
  messageId: string | null;
  invalidUsageFields: string[];
  reportedCostUsd: number | null;
}

type PayloadUsageExtractor = (payload: unknown) => AnthropicPayloadExtraction;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function extractAnthropicPayloadUsage(payload: unknown): AnthropicPayloadExtraction {
  const data = objectRecord(payload);
  if (!data) {
    return { usage: null, model: null, messageId: null, invalidUsageFields: [], reportedCostUsd: null };
  }
  const message = objectRecord(data.message);
  const model = data.model ?? message?.model;
  const messageId = data.id ?? message?.id;
  const rawUsage = data.usage ?? message?.usage;
  return {
    usage: normalizeAnthropicUsage(rawUsage),
    model: nonEmptyString(model),
    messageId: nonEmptyString(messageId),
    invalidUsageFields: invalidAnthropicUsageFields(rawUsage),
    reportedCostUsd: null,
  };
}

const OPENAI_USAGE_FIELDS = [
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
] as const;

function invalidOpenAiUsageFields(value: unknown, fields: readonly string[] = OPENAI_USAGE_FIELDS): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const data = value as Record<string, unknown>;
  return fields.filter((field) => {
    if (!(field in data)) return false;
    const raw = data[field];
    return typeof raw !== "number" || !Number.isFinite(raw) || raw < 0;
  });
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

// OpenAI-format prompt_tokens INCLUDES cached tokens; split them out so cache
// reads are priced at the discounted rate instead of full input price.
function normalizeOpenAiUsage(value: unknown): AnthropicTokenUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const details = objectRecord(data.prompt_tokens_details);
  const promptTokens = numberOrZero(data.prompt_tokens);
  const cachedTokens = Math.min(promptTokens, numberOrZero(details?.cached_tokens));
  const usage = {
    inputTokens: promptTokens - cachedTokens,
    outputTokens: numberOrZero(data.completion_tokens),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cachedTokens,
  };
  return totalTokens(usage) > 0 ? usage : null;
}

function reportedUsageCostUsd(rawUsage: Record<string, unknown> | null): number | null {
  const cost = rawUsage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function extractOpenRouterPayloadUsage(payload: unknown): AnthropicPayloadExtraction {
  const data = objectRecord(payload);
  if (!data) {
    return { usage: null, model: null, messageId: null, invalidUsageFields: [], reportedCostUsd: null };
  }
  const rawUsage = data.usage;
  return {
    usage: normalizeOpenAiUsage(rawUsage),
    model: nonEmptyString(data.model),
    messageId: nonEmptyString(data.id),
    invalidUsageFields: invalidOpenAiUsageFields(rawUsage),
    reportedCostUsd: reportedUsageCostUsd(objectRecord(rawUsage)),
  };
}

function extractOpenAiResponsesUsage(payload: unknown): AnthropicPayloadExtraction {
  const data = objectRecord(payload);
  const response = objectRecord(data?.response) ?? data;
  const rawUsage = objectRecord(response?.usage);
  const details = objectRecord(rawUsage?.input_tokens_details);
  const chatUsage = rawUsage ? {
    prompt_tokens: rawUsage.input_tokens,
    completion_tokens: rawUsage.output_tokens,
    total_tokens: rawUsage.total_tokens,
    prompt_tokens_details: details,
  } : null;
  const invalidUsageFields = [
    ...invalidOpenAiUsageFields(rawUsage, ["input_tokens", "output_tokens", "total_tokens"]),
    ...invalidOpenAiUsageFields(details, ["cached_tokens"]).map((field) => `input_tokens_details.${field}`),
  ];
  return {
    usage: normalizeOpenAiUsage(chatUsage),
    model: nonEmptyString(response?.model),
    messageId: nonEmptyString(response?.id),
    invalidUsageFields,
    reportedCostUsd: null,
  };
}

function usageExtractor(provider: ModelBrokerProvider, pathname: string): PayloadUsageExtractor {
  if ((provider === "openai" || provider === "meta") && pathname === "/v1/responses") return extractOpenAiResponsesUsage;
  return provider === "anthropic" || provider === "vertex"
    ? extractAnthropicPayloadUsage
    : extractOpenRouterPayloadUsage;
}

const PROVIDER_LABELS: Record<ModelBrokerProvider, string> = {
  anthropic: "Anthropic",
  vertex: "Vertex AI",
  openai: "OpenAI",
  meta: "Meta",
  openrouter: "OpenRouter",
};

function providerLabel(provider: ModelBrokerProvider): string {
  return PROVIDER_LABELS[provider];
}

function isUnknownPricingModel(provider: ModelBrokerProvider, pricingModel: string): boolean {
  if (provider === "anthropic" || provider === "vertex") return isUnknownAnthropicPricingModel(pricingModel);
  if (provider === "openai") return isUnknownOpenAiPricingModel(pricingModel);
  if (provider === "meta") return pricingModel !== "meta:muse-ember-1.0";
  return isUnknownOpenRouterPricingModel(pricingModel);
}

class SseUsageCollector {
  private readonly decoder = new TextDecoder();
  private buffered = "";
  usage: AnthropicTokenUsage | null = null;
  model: string | null = null;
  messageId: string | null = null;
  invalidUsageFields: string[] = [];
  reportedCostUsd: number | null = null;

  constructor(private readonly extractPayloadUsage: PayloadUsageExtractor) {}

  push(chunk: Uint8Array): void {
    this.buffered += this.decoder.decode(chunk, { stream: true });
    if (this.buffered.length > MAX_SSE_METERING_BUFFER_CHARS) {
      throw new Error("LLM broker SSE metering buffer exceeded cap");
    }
    this.processCompleteEvents();
  }

  finish(): void {
    this.buffered += this.decoder.decode();
    const trailing = this.buffered.trim();
    if (trailing) this.processEvent(trailing);
    this.buffered = "";
  }

  private processCompleteEvents(): void {
    const parts = this.buffered.split(/\r?\n\r?\n/);
    this.buffered = parts.pop() ?? "";
    for (const part of parts) this.processEvent(part);
  }

  private processEvent(raw: string): void {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    try {
      const extracted = this.extractPayloadUsage(JSON.parse(data) as unknown);
      this.usage = mergeAnthropicUsage(this.usage, extracted.usage);
      if (extracted.model) this.model = extracted.model;
      if (extracted.messageId) this.messageId = extracted.messageId;
      if (extracted.reportedCostUsd !== null) this.reportedCostUsd = extracted.reportedCostUsd;
      this.invalidUsageFields.push(...extracted.invalidUsageFields);
    } catch {
      // Ignore malformed upstream event fragments; the response is still proxied verbatim.
    }
  }
}

function collectSseUsageChunk(
  collector: SseUsageCollector | null,
  chunk: Uint8Array,
  onError: (err: unknown) => void,
): SseUsageCollector | null {
  if (!collector) return null;
  try {
    collector.push(chunk);
    return collector;
  } catch (err) {
    onError(err);
    return null;
  }
}

function finishSseUsageCollection(
  collector: SseUsageCollector | null,
  onError: (err: unknown) => void,
): SseUsageCollector | null {
  if (!collector) return null;
  try {
    collector.finish();
    return collector;
  } catch (err) {
    onError(err);
    return null;
  }
}

interface MeteringContext {
  req: Request;
  url: URL;
  record: ModelBrokerTokenRecord;
  requestId: string;
  requestModel: string | null;
  cacheWriteTtl: AnthropicCacheWriteTtl;
  usageStore?: ModelBrokerUsageStore;
  providerKey: ModelBrokerProviderKey;
  degraded: boolean;
  now: () => number;
  onMeteringError: (err: unknown) => void;
  countsTowardSpendWindow: boolean;
  charge: RailCharge;
  fundedBudget?: NonNullable<OwnerModelBrokerGrant["fundedBudget"]>;
  vertexPricing?: { model: string; prices: VertexModelPriceTable };
}

// The metered outcome of one proxied call, collected identically from a
// buffered JSON body (AnthropicPayloadExtraction) or a streamed SSE tee
// (SseUsageCollector).
interface MeteredUsage {
  usage: AnthropicTokenUsage | null;
  model: string | null;
  messageId: string | null;
  reportedCostUsd: number | null;
}

function meteredModel(ctx: MeteringContext, metered: MeteredUsage): string {
  return ctx.vertexPricing?.model ?? metered.model ?? ctx.requestModel ?? "unknown";
}

function resolveReportedCost(
  ctx: MeteringContext,
  model: string,
  usage: AnthropicTokenUsage,
  upstreamReportedCostUsd: number | null,
): number | null | undefined {
  if (!ctx.vertexPricing) return upstreamReportedCostUsd;
  try {
    return computeVertexCost(ctx.vertexPricing.prices, model, usage, ctx.cacheWriteTtl).total;
  } catch (err) {
    ctx.onMeteringError(err);
    return undefined;
  }
}

async function recordUsage(
  ctx: MeteringContext,
  upstream: globalThis.Response,
  metered: MeteredUsage,
): Promise<void> {
  const { usage } = metered;
  if (!ctx.usageStore || !usage || totalTokens(usage) <= 0) return;
  const model = meteredModel(ctx, metered);
  const reportedCostUsd = resolveReportedCost(ctx, model, usage, metered.reportedCostUsd);
  if (reportedCostUsd === undefined) return;
  const cost = estimateModelBrokerCost(ctx.record.provider, model, usage, ctx.cacheWriteTtl);
  const unknownPricing = isUnknownPricingModel(ctx.record.provider, cost.pricingModel);
  // A reported upstream cost makes the table irrelevant for this call — only a
  // genuine fallback to estimates is worth an alert.
  if (unknownPricing && reportedCostUsd === null) {
    ctx.onMeteringError(
      new Error(`llm-broker used fallback pricing for unknown ${providerLabel(ctx.record.provider)} model: ${model}`),
    );
  }
  const upstreamId = metered.messageId;
  try {
    await ctx.usageStore.recordUsage({
      eventId: usageEventId(ctx.record, upstreamId, ctx.requestId),
      requestId: ctx.requestId,
      upstreamId,
      provider: ctx.record.provider,
      gatewayId: ctx.record.gatewayId,
      ownerUid: ctx.record.ownerUid,
      agentId: ctx.record.trace?.agentId ?? null,
      brokerTokenHash: ctx.record.tokenHash,
      brokerTokenSecretName: ctx.record.secretName,
      providerKeySource: ctx.providerKey.source,
      providerKeySecretName: ctx.providerKey.secretName ?? null,
      degraded: ctx.degraded,
      model,
      usage,
      cacheWriteTtl: ctx.cacheWriteTtl,
      method: ctx.req.method.toUpperCase(),
      path: ctx.url.pathname,
      upstreamStatus: upstream.status,
      now: ctx.now(),
      countsTowardSpendWindow: ctx.countsTowardSpendWindow,
      priceMultiplier: ctx.charge.priceMultiplier,
      balanceDebit: ctx.charge.balanceDebit,
      fundedBudget: ctx.fundedBudget,
      reportedCostUsd,
      usageKind:
        ctx.record.purpose === "embeddings" ? "embedding" : "model",
    });
  } catch (err) {
    ctx.onMeteringError(err);
  }
}

function usageEventId(
  record: ModelBrokerTokenRecord,
  upstreamId: string | null,
  requestId: string,
): string {
  if (!upstreamId) return requestId;
  return `${record.provider}_${record.gatewayId}_${crypto
    .createHash("sha256")
    .update(upstreamId, "utf8")
    .digest("hex")}`;
}

interface PreflightGateInput {
  req: Request;
  url: URL;
  record: ModelBrokerTokenRecord;
  grant: OwnerModelBrokerGrant;
  rail: ModelBrokerRail;
  source: ModelBrokerProviderKeySource;
  usageStore?: ModelBrokerUsageStore;
  now: () => number;
  onMeteringError: (err: unknown) => void;
}

async function rateWindowDenial(
  input: PreflightGateInput,
  requestsPerMinute: number,
): Promise<GateDecisionDenied | null> {
  if (!input.usageStore?.reserveRateWindow) {
    return { allowed: false, status: 503, error: "model broker rate gate unavailable" };
  }
  const rate = await input.usageStore.reserveRateWindow({
    gatewayId: input.record.gatewayId,
    ownerUid: input.record.ownerUid,
    ...(input.record.purpose === "embeddings"
      ? { scope: "embedding" as const }
      : {}),
    now: input.now(),
  });
  return rate.requestCount > requestsPerMinute
    ? { allowed: false, status: 429, error: "model broker rate limit exceeded", retryAfterSeconds: 60 }
    : null;
}

function gateDecisionName(gate: GateDecisionAllowed): string {
  if (gate.decision !== null) return gate.decision;
  if (!gate.degrade) return "forward";
  return `degrade_${gate.degradeReason ?? "budget"}`;
}

type GateLogger = (decision: string, extra?: Record<string, unknown>) => void;

function deniedDecisionName(gate: GateDecisionDenied): string {
  if (gate.budgetInterruption === "awaiting_increase") return "denied_waiting";
  if (gate.budgetInterruption === "exhausted") return "denied_exhausted";
  if (gate.status === 402) return "denied_no_token_path";
  if (gate.status === 429) return "rate_limited";
  return "gate_unavailable";
}

function sendGateDenied(
  res: ExpressResponse,
  gate: GateDecisionDenied,
  logGate: GateLogger,
): void {
  if (gate.retryAfterSeconds) {
    res.setHeader("retry-after", String(gate.retryAfterSeconds));
  }
  logGate(deniedDecisionName(gate), {
    status: gate.status,
    error: gate.error,
    budgetInterruption: gate.budgetInterruption,
    budgetChargeUsd: gate.budgetChargeUsd,
  });
  res.status(gate.status).json({ error: gate.error });
}

async function grantForRecord(
  deps: LlmBrokerAppDeps,
  record: ModelBrokerTokenRecord,
  nowMs: number,
): Promise<OwnerModelBrokerGrant> {
  if (record.purpose === "embeddings" || !deps.resolveGrant) {
    return {
      limits: record.limits,
      policy: record.policy,
      rail: deps.rails.defaultRailId,
      fundedBudget: null,
    };
  }
  return deps.resolveGrant({
    gatewayId: record.gatewayId,
    ownerUid: record.ownerUid,
    now: nowMs,
  });
}

const GATE_PASS: GateDecisionAllowed = {
  allowed: true,
  degrade: false,
  degradeReason: null,
  houseModelDial: false,
  decision: null,
  windowCostUsd: null,
  weekCostUsd: null,
  balanceUsd: null,
  budgetFunded: false,
  budgetChargeUsd: null,
};

function railGateContext(input: PreflightGateInput): RailGateContext {
  return {
    grant: input.grant,
    gatewayId: input.record.gatewayId,
    ownerUid: input.record.ownerUid ?? null,
    usageStore: input.usageStore,
    now: input.now,
  };
}

async function degradeStateForGrant(
  input: PreflightGateInput,
  spendWindowUsd: number | null,
  spendWeekUsd: number | null,
): Promise<DegradeOutcome> {
  const ctx = railGateContext(input);
  const railOutcome = await input.rail.gate(ctx, { spendWindowUsd, spendWeekUsd });
  if (railOutcome) return railOutcome;
  if (spendWindowUsd !== null || spendWeekUsd !== null) {
    const spend = await spendWindowGate(ctx, spendWindowUsd, spendWeekUsd);
    if ("allowed" in spend) return { kind: "denied", decision: spend };
    if (spend.degrade && input.grant.policy.houseFallback === false) {
      return input.rail.budgetExhausted(ctx);
    }
    return {
      kind: "state",
      degrade: spend.degrade,
      degradeReason: spend.degrade ? "budget" : null,
      windowCostUsd: spend.windowCostUsd,
      weekCostUsd: spend.weekCostUsd,
      balanceUsd: null,
    };
  }
  return {
    kind: "state",
    degrade: false,
    degradeReason: null,
    windowCostUsd: null,
    weekCostUsd: null,
    balanceUsd: null,
  };
}

function requiresPreflightGate(input: PreflightGateInput): boolean {
  if (input.source === "owner_model_credential") return false;
  if (input.req.method.toUpperCase() === "GET" && input.url.pathname === "/v1/models") return false;
  const { grant } = input;
  const spendWindowUsd = grant.limits.spendWindowUsd;
  const spendWeekUsd = grant.limits.spendWeekUsd;
  const requestsPerMinute = grant.limits.requestsPerMinute;
  return input.rail.requiresGate(grant, input.record.ownerUid ?? null) ||
    spendWindowUsd !== null || spendWeekUsd !== null || requestsPerMinute !== null;
}

async function preflightGate(input: PreflightGateInput): Promise<GateDecision> {
  if (!requiresPreflightGate(input)) return GATE_PASS;
  const { grant } = input;
  const spendWindowUsd = grant.limits.spendWindowUsd;
  const spendWeekUsd = grant.limits.spendWeekUsd;
  const requestsPerMinute = grant.limits.requestsPerMinute;
  try {
    const outcome = await degradeStateForGrant(input, spendWindowUsd, spendWeekUsd);
    if (outcome.kind === "denied") return outcome.decision;
    if (requestsPerMinute !== null) {
      const denial = await rateWindowDenial(input, requestsPerMinute);
      if (denial) return denial;
    }
    const { degrade, degradeReason, windowCostUsd, weekCostUsd, balanceUsd } = outcome;
    return {
      allowed: true,
      degrade,
      degradeReason,
      houseModelDial: outcome.houseModelDial === true,
      decision: outcome.decision ?? null,
      windowCostUsd,
      weekCostUsd,
      balanceUsd,
      budgetFunded: outcome.budgetFunded === true,
      budgetChargeUsd: outcome.budgetChargeUsd ?? null,
    };
  } catch (err) {
    input.onMeteringError(err);
    return { allowed: false, status: 503, error: "model broker limit check failed" };
  }
}

async function writeBufferedUpstreamResponse(
  upstream: globalThis.Response,
  res: ExpressResponse,
  metering?: MeteringContext,
): Promise<void> {
  res.status(upstream.status);
  copyResponseHeaders(upstream, res);
  const text = await upstream.text();
  res.end(text);
  if (metering && isJson(upstream)) {
    try {
      const extracted = usageExtractor(metering.record.provider, metering.url.pathname)(JSON.parse(text) as unknown);
      if (extracted.invalidUsageFields.length) {
        metering.onMeteringError(
          new Error(`${providerLabel(metering.record.provider)} usage contained invalid fields: ${extracted.invalidUsageFields.join(",")}`),
        );
      }
      await recordUsage(metering, upstream, extracted);
    } catch {
      // Non-JSON success bodies are simply not meterable.
    }
  }
}

async function writeStreamingUpstreamResponse(
  upstream: globalThis.Response,
  res: ExpressResponse,
  metering?: MeteringContext,
): Promise<void> {
  res.status(upstream.status);
  copyResponseHeaders(upstream, res);
  if (!upstream.body) {
    res.end();
    return;
  }
  let collector = metering ? new SseUsageCollector(usageExtractor(metering.record.provider, metering.url.pathname)) : null;
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        collector = collectSseUsageChunk(
          collector,
          value,
          metering?.onMeteringError ?? (() => undefined),
        );
        await writeChunk(res, value);
      }
    }
    collector = finishSseUsageCollection(
      collector,
      metering?.onMeteringError ?? (() => undefined),
    );
    res.end();
    if (metering && collector) {
      if (collector.invalidUsageFields.length) {
        metering.onMeteringError(
          new Error(`${providerLabel(metering.record.provider)} usage contained invalid fields: ${collector.invalidUsageFields.join(",")}`),
        );
      }
      await recordUsage(metering, upstream, collector);
    }
  } finally {
    reader.releaseLock();
  }
}

async function writeUpstreamResponse(
  upstream: globalThis.Response,
  res: ExpressResponse,
  metering?: MeteringContext,
): Promise<void> {
  if (isEventStream(upstream)) {
    await writeStreamingUpstreamResponse(upstream, res, metering);
  } else {
    await writeBufferedUpstreamResponse(upstream, res, metering);
  }
}

async function effectiveHouseModel(args: {
  gate: GateDecisionAllowed;
  provider: ModelBrokerProvider;
  houseModels: Record<ModelBrokerProvider, string>;
  resolveHouseModel: LlmBrokerAppDeps["resolveHouseModel"];
  onError: (err: unknown) => void;
}): Promise<string> {
  const houseModel = args.houseModels[args.provider];
  if (!args.gate.degrade || !args.gate.houseModelDial || !args.resolveHouseModel) {
    return houseModel;
  }
  try {
    const dial = await args.resolveHouseModel();
    return dial && dial.provider === args.provider ? dial.upstreamModelId : houseModel;
  } catch (err) {
    args.onError(err);
    return houseModel;
  }
}

async function logAndForwardAllowed(args: {
  req: Request;
  res: ExpressResponse;
  url: URL;
  record: ModelBrokerTokenRecord;
  providerKey: ModelBrokerProviderKey;
  gate: GateDecisionAllowed;
  fetchImpl: typeof fetch;
  upstreamBaseUrl: string;
  vertex?: VertexBrokerConfig;
  houseModels: Record<ModelBrokerProvider, string>;
  resolveHouseModel: LlmBrokerAppDeps["resolveHouseModel"];
  requestModel: string | null;
  logGate: GateLogger;
  rail: ModelBrokerRail;
  grant: OwnerModelBrokerGrant;
  fundedBudget: OwnerModelBrokerGrant["fundedBudget"];
  usageStore?: ModelBrokerUsageStore;
  upstreamHeaderTimeoutMs: number;
  now: () => number;
  onMeteringError: (err: unknown) => void;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}): Promise<void> {
  const { gate, record } = args;
  const houseModel = await effectiveHouseModel({
    gate,
    provider: record.provider,
    houseModels: args.houseModels,
    resolveHouseModel: args.resolveHouseModel,
    onError: args.onMeteringError,
  });
  if (args.req.method.toUpperCase() === "POST") {
    args.logGate(gateDecisionName(gate), {
      effectiveModel: gate.degrade ? houseModel : args.requestModel,
      windowCostUsd: gate.windowCostUsd,
      weekCostUsd: gate.weekCostUsd,
      balanceUsd: gate.balanceUsd,
      budgetChargeUsd: gate.budgetChargeUsd,
    });
  }
  await forwardAllowed({ ...args, houseModel });
}

function degradeModelForRequest(
  gate: GateDecisionAllowed,
  url: URL,
  houseModel: string,
): string | null {
  return gate.degrade && url.pathname !== "/v1/embeddings" ? houseModel : null;
}

function includeOpenRouterUsageForRequest(
  record: ModelBrokerTokenRecord,
  req: Request,
  url: URL,
): boolean {
  return (
    record.provider === "openrouter" &&
    req.method.toUpperCase() === "POST" &&
    url.pathname === "/v1/chat/completions"
  );
}

function meteringContextFor(args: {
  req: Request;
  url: URL;
  record: ModelBrokerTokenRecord;
  requestId: string;
  requestModel: string | null;
  cacheWriteTtl: AnthropicCacheWriteTtl;
  usageStore?: ModelBrokerUsageStore;
  providerKey: ModelBrokerProviderKey;
  gate: GateDecisionAllowed;
  now: () => number;
  onMeteringError: (err: unknown) => void;
  meter: RailMeter;
  budgetFunded: boolean;
  fundedBudget: OwnerModelBrokerGrant["fundedBudget"];
  vertexPricing?: MeteringContext["vertexPricing"];
}): MeteringContext {
  const { providerKey, gate, meter, budgetFunded } = args;
  const railMetered = args.record.purpose !== "embeddings" && providerKey.source !== "owner_model_credential";
  return {
    req: args.req,
    url: args.url,
    record: args.record,
    requestId: args.requestId,
    requestModel: args.requestModel,
    cacheWriteTtl: args.cacheWriteTtl,
    usageStore: args.usageStore,
    providerKey,
    degraded: gate.degrade,
    now: args.now,
    onMeteringError: args.onMeteringError,
    countsTowardSpendWindow: railMetered && !budgetFunded && meter.countsTowardSpendWindow,
    charge: railMetered ? meter.charge : CHARGE_AT_COST,
    ...(budgetFunded && args.fundedBudget
      ? { fundedBudget: args.fundedBudget }
      : {}),
    ...(args.vertexPricing ? { vertexPricing: args.vertexPricing } : {}),
  };
}

interface UpstreamCall {
  url: string;
  headers: Headers;
  body: unknown;
  requestModel: string | null;
  vertexPricing?: MeteringContext["vertexPricing"];
}

class VertexUnpricedModelError extends Error {
  constructor(model: string) {
    super(`vertex price table has no price entry for model ${model}`);
    this.name = "VertexUnpricedModelError";
  }
}

function vertexUpstreamCall(args: {
  req: Request;
  vertex: VertexBrokerConfig;
  accessToken: string;
  body: unknown;
}): UpstreamCall {
  const translated = translateVertexMessagesRequest({
    body: args.body,
    betaHeader: args.req.get("anthropic-beta"),
  });
  if (!args.vertex.prices[translated.model]) throw new VertexUnpricedModelError(translated.model);
  return {
    url: vertexUpstreamUrl(args.vertex, translated.model, translated.stream),
    headers: vertexUpstreamHeaders(args.req, args.accessToken),
    body: translated.body,
    requestModel: translated.model,
    vertexPricing: { model: translated.model, prices: args.vertex.prices },
  };
}

function metaResponsesBody(body: unknown): Buffer {
  const input = JSON.parse(String(body));
  return Buffer.from(JSON.stringify({
    ...input,
    store: false,
    reasoning: { effort: "max" },
    include: ["reasoning.encrypted_content"],
  }));
}

function upstreamCallFor(args: {
  req: Request;
  url: URL;
  record: ModelBrokerTokenRecord;
  providerKey: ModelBrokerProviderKey;
  upstreamBaseUrl: string;
  vertex?: VertexBrokerConfig;
  body: unknown;
}): UpstreamCall {
  if (args.record.provider === "vertex") {
    if (!args.vertex) throw new Error("vertex upstream is not configured");
    return vertexUpstreamCall({
      req: args.req,
      vertex: args.vertex,
      accessToken: args.providerKey.apiKey,
      body: args.body,
    });
  }
  return {
    url: `${args.upstreamBaseUrl}${args.url.pathname}${args.url.search}`,
    headers: upstreamHeaders(args.req, args.providerKey.apiKey, args.record.provider),
    body: args.record.provider === "meta" ? metaResponsesBody(args.body) : args.body,
    requestModel: readRequestMetadata(args.body).model,
  };
}

function sendVertexRequestRejection(
  res: ExpressResponse,
  err: unknown,
  onMeteringError: (err: unknown) => void,
): boolean {
  if (err instanceof VertexRequestError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof VertexUnpricedModelError) {
    onMeteringError(err);
    res.status(503).json({ error: err.message });
    return true;
  }
  return false;
}

async function forwardAllowed(args: {
  req: Request;
  res: ExpressResponse;
  url: URL;
  record: ModelBrokerTokenRecord;
  providerKey: ModelBrokerProviderKey;
  gate: GateDecisionAllowed;
  fetchImpl: typeof fetch;
  upstreamBaseUrl: string;
  vertex?: VertexBrokerConfig;
  houseModel: string;
  rail: ModelBrokerRail;
  grant: OwnerModelBrokerGrant;
  fundedBudget: OwnerModelBrokerGrant["fundedBudget"];
  usageStore?: ModelBrokerUsageStore;
  upstreamHeaderTimeoutMs: number;
  now: () => number;
  onMeteringError: (err: unknown) => void;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
}): Promise<void> {
  const { req, res, url, record, providerKey, gate } = args;
  const meter = args.rail.meter({ grant: args.grant, gate, ownerUid: record.ownerUid ?? null });
  const rewrittenBody = rewriteRequestBody({
    body: req.body,
    degradeModel: degradeModelForRequest(gate, url, args.houseModel),
    includeOpenRouterUsage: includeOpenRouterUsageForRequest(record, req, url),
  });
  const effectiveBody = rewrittenBody ?? req.body;
  let call: UpstreamCall;
  try {
    call = upstreamCallFor({
      req,
      url,
      record,
      providerKey,
      upstreamBaseUrl: args.upstreamBaseUrl,
      vertex: args.vertex,
      body: effectiveBody,
    });
  } catch (err) {
    if (sendVertexRequestRejection(res, err, args.onMeteringError)) return;
    throw err;
  }
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : (call.body as unknown as BodyInit);
  const cacheWriteTtl = readRequestMetadata(effectiveBody).cacheWriteTtl;
  const requestId = crypto.randomUUID();
  const upstream = await fetchAndLogUpstream({
    fetchImpl: args.fetchImpl,
    url: call.url,
    init: {
      method: req.method,
      headers: Object.fromEntries(call.headers.entries()),
      body,
      redirect: "manual",
    },
    timeoutMs: args.upstreamHeaderTimeoutMs,
    now: args.now,
    log: args.log,
    fields: {
      gatewayId: record.gatewayId,
      ownerUid: record.ownerUid,
      provider: record.provider,
      path: url.pathname,
      requestId,
      requestModel: call.requestModel,
    },
  });
  const metering: MeteringContext | undefined = shouldMeter(record.provider, req, url, upstream)
    ? meteringContextFor({
        req,
        url,
        record,
        requestId,
        requestModel: call.requestModel,
        cacheWriteTtl,
        usageStore: args.usageStore,
        providerKey,
        gate,
        now: args.now,
        onMeteringError: args.onMeteringError,
        meter,
        budgetFunded: gate.budgetFunded,
        fundedBudget: args.fundedBudget,
        vertexPricing: call.vertexPricing,
      })
    : undefined;
  await writeUpstreamResponse(upstream, res, metering);
}

async function fetchAndLogUpstream(args: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
  now: () => number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  fields: Record<string, unknown>;
}): Promise<globalThis.Response> {
  const startedAt = args.now();
  args.log?.("llm-broker upstream request", args.fields);
  let upstream: globalThis.Response;
  try {
    upstream = await fetchUpstreamHeaders(args);
  } catch (err) {
    args.log?.("llm-broker upstream failed", {
      ...args.fields,
      durationMs: args.now() - startedAt,
      ...thrownUpstreamFailureFields(err, args.timeoutMs),
    });
    throw err;
  }
  args.log?.(upstream.ok ? "llm-broker upstream headers" : "llm-broker upstream failed", {
    ...args.fields,
    upstreamStatus: upstream.status,
    durationMs: args.now() - startedAt,
  });
  return upstream;
}

function thrownUpstreamFailureFields(err: unknown, timeoutMs: number): Record<string, unknown> {
  if (err instanceof UpstreamHeaderTimeoutError) return { errorName: err.name, timeoutMs };
  const errorCode = stringErrorCode(err) ?? stringErrorCode(err instanceof Error ? err.cause : undefined);
  return {
    errorName: err instanceof Error ? err.name : typeof err,
    ...(errorCode ? { errorCode } : {}),
  };
}

function stringErrorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("code" in value)) return undefined;
  return typeof value.code === "string" ? value.code : undefined;
}

async function fetchUpstreamHeaders(args: {
  fetchImpl: typeof fetch;
  url: string;
  init: RequestInit;
  timeoutMs: number;
}): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timeoutError = new UpstreamHeaderTimeoutError();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, args.timeoutMs);
  });
  try {
    return await Promise.race([
      args.fetchImpl(args.url, { ...args.init, signal: controller.signal }),
      deadline,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function reportBrokerResolutionError(deps: LlmBrokerAppDeps, error: unknown): void {
  deps.onMeteringError?.(error);
}

const BROKER_TOKEN_REJECTION_BODY: Partial<Record<ModelBrokerTokenLookup["outcome"], string>> = {
  expired: "broker token expired",
  revoked: "broker token revoked",
};

function rejectBrokerToken(
  deps: LlmBrokerAppDeps,
  res: ExpressResponse,
  url: URL,
  lookup: ModelBrokerTokenLookup,
): void {
  const rejection = lookup.outcome === "valid" ? "uncapped" : lookup.outcome;
  deps.log?.(
    `broker token rejected: ${rejection}`,
    lookup.outcome === "unknown"
      ? { path: url.pathname }
      : {
          path: url.pathname,
          gatewayId: lookup.record.gatewayId,
          ownerUid: lookup.record.ownerUid,
          provider: lookup.record.provider,
          expiresAt: lookup.record.expiresAt,
        },
  );
  res.status(401).json({
    error: BROKER_TOKEN_REJECTION_BODY[lookup.outcome] ?? "invalid broker token",
  });
}

async function ownerAllowsBrokerRequest(
  deps: LlmBrokerAppDeps,
  record: ModelBrokerTokenRecord,
  res: ExpressResponse,
): Promise<boolean> {
  if (!deps.resolveOwnerAccess) return true;
  try {
    const active = await deps.resolveOwnerAccess({
      gatewayId: record.gatewayId,
      ownerUid: record.ownerUid,
    });
    if (active) return true;
    res.status(403).json({ error: "model broker owner is not active" });
    return false;
  } catch (error) {
    reportBrokerResolutionError(deps, error);
    res.status(503).json({ error: "model broker owner resolution failed" });
    return false;
  }
}

async function resolveGrantForBrokerRequest(
  deps: LlmBrokerAppDeps,
  record: ModelBrokerTokenRecord,
  now: number,
  res: ExpressResponse,
): Promise<OwnerModelBrokerGrant | null> {
  try {
    return await grantForRecord(deps, record, now);
  } catch (error) {
    reportBrokerResolutionError(deps, error);
    res.status(503).json({ error: "model broker grant resolution failed" });
    return null;
  }
}

async function providerKeyForBrokerRequest(
  deps: LlmBrokerAppDeps,
  request: { url: URL; record: ModelBrokerTokenRecord; requestModel: string | null },
  res: ExpressResponse,
): Promise<ModelBrokerProviderKey | null> {
  const { url, record, requestModel } = request;
  const resolution = await resolveProviderKeyForRequest({
    record,
    providerKeys: deps.providerKeys,
    providerKeyResolver: deps.providerKeyResolver,
    vertex: deps.vertex,
    onError: deps.onMeteringError ?? (() => undefined),
  });
  if ("key" in resolution) return resolution.key;
  deps.log?.("llm-broker provider refused", {
    gatewayId: record.gatewayId,
    ownerUid: record.ownerUid,
    provider: record.provider,
    path: url.pathname,
    requestModel,
    status: 503,
    reason: resolution.refusal,
  });
  res.status(503).json({ error: `${record.provider} upstream is not configured` });
  return null;
}

interface BrokerRequestHandlerOptions {
  deps: LlmBrokerAppDeps;
  rails: ModelBrokerRailRegistry;
  fetchImpl: typeof fetch;
  upstreamBaseUrls: Record<ModelBrokerProvider, string>;
  houseModels: Record<ModelBrokerProvider, string>;
  now: () => number;
  upstreamHeaderTimeoutMs: number;
}

interface ResolvedBrokerRequest {
  url: URL;
  record: ModelBrokerTokenRecord;
  requestModel: string | null;
  providerKey: ModelBrokerProviderKey;
  grant: OwnerModelBrokerGrant;
  rail: ModelBrokerRail;
}

async function authorizeBrokerCredential(
  deps: LlmBrokerAppDeps,
  req: Request,
  res: ExpressResponse,
  now: () => number,
): Promise<ModelBrokerTokenRecord | null> {
  const lookup = await deps.store.lookupToken(authToken(req), now());
  if (lookup.outcome !== "valid" || lookup.record.capped !== true) {
    rejectBrokerToken(deps, res, requestUrl(req), lookup);
    return null;
  }
  return await ownerAllowsBrokerRequest(deps, lookup.record, res) ? lookup.record : null;
}

function authorizeBrokerCatalog(deps: LlmBrokerAppDeps, now: () => number) {
  return async (req: Request, res: ExpressResponse, next: NextFunction): Promise<void> => {
    res.setHeader("cache-control", "no-store");
    try {
      const record = await authorizeBrokerCredential(deps, req, res, now);
      if (!record) return;
      if (record.purpose !== "model") {
        res.status(403).json({ error: "model catalog requires a model credential" });
        return;
      }
      res.locals.catalogCredential = record;
      next();
    } catch (error) {
      reportBrokerResolutionError(deps, error);
      res.status(503).json({ error: "model catalog unavailable" });
    }
  };
}

function createBrokerCatalogHandler(deps: LlmBrokerAppDeps, now: () => number) {
  return async (req: Request, res: ExpressResponse): Promise<void> => {
    const record: ModelBrokerTokenRecord = res.locals.catalogCredential;
    try {
      const configured = record.provider === "vertex"
        ? providerConfigured(deps, "vertex")
        : "key" in await resolveProviderKeyForRequest({
            record,
            providerKeys: deps.providerKeys,
            providerKeyResolver: deps.providerKeyResolver,
            onError: (error) => reportBrokerResolutionError(deps, error),
          });
      if (!await authorizeBrokerCredential(deps, req, res, now)) return;
      if (!configured) {
        res.status(503).json({ error: `${record.provider} upstream is not configured` });
        return;
      }
      res.json({
        schemaVersion: 1,
        provider: record.provider,
        purpose: record.purpose,
        agentId: record.trace?.agentId ?? null,
        providerCredentialConfigured: true,
        admission: "request-time",
        routes: Array.from(ALLOWED_ENDPOINTS_BY_PROVIDER[record.provider], (route) => {
          const [method, path] = route.split(" ");
          return { method, path };
        }),
        models: modelCatalogForProvider(record.provider),
      });
    } catch (error) {
      reportBrokerResolutionError(deps, error);
      res.status(503).json({ error: "model catalog unavailable" });
    }
  };
}

async function resolveBrokerRequest(
  options: BrokerRequestHandlerOptions,
  req: Request,
  res: ExpressResponse,
): Promise<ResolvedBrokerRequest | null> {
  const { deps, now } = options;
  const url = requestUrl(req);
  if (!allowedEndpoint(req, url)) {
    res.status(404).json({ error: "unsupported LLM broker endpoint" });
    return null;
  }
  const record = await authorizeBrokerCredential(deps, req, res, now);
  if (!record) return null;
  if (!providerAllowedEndpoint(record, req, url)) {
    res.status(404).json({ error: "unsupported LLM broker endpoint" });
    return null;
  }
  const requestModel = readRequestMetadata(req.body).model;
  if (record.provider === "meta") {
    if (requestModel !== "muse-ember-1.0") {
      res.status(400).json({ error: "unsupported Meta model" });
      return null;
    }
    const body = JSON.parse(String(req.body));
    if (body.previous_response_id != null || body.conversation != null || body.background === true) {
      res.status(400).json({ error: "Meta broker requires stateless Responses requests" });
      return null;
    }
  }
  if (record.purpose === "embeddings" && requestModel !== PLATFORM_OPENAI_EMBEDDING_MODEL) {
    res.status(400).json({ error: "unsupported embedding model" });
    return null;
  }
  const providerKey = await providerKeyForBrokerRequest(deps, { url, record, requestModel }, res);
  if (!providerKey) return null;
  const grant = await resolveGrantForBrokerRequest(deps, record, now(), res);
  if (!grant) return null;
  let rail: ModelBrokerRail;
  try {
    rail = options.rails.rail(grant.rail);
  } catch (error) {
    reportBrokerResolutionError(deps, error);
    res.status(503).json({ error: "model broker rail unavailable" });
    return null;
  }
  return { url, record, requestModel, providerKey, grant, rail };
}

function brokerGateLogger(
  deps: LlmBrokerAppDeps,
  context: ResolvedBrokerRequest,
): GateLogger {
  const { record, providerKey, grant, requestModel, url } = context;
  return (decision, extra = {}) => {
    deps.log?.("llm-broker gate", {
      decision,
      gatewayId: record.gatewayId,
      ownerUid: record.ownerUid,
      provider: record.provider,
      purpose: record.purpose,
      path: url.pathname,
      keySource: providerKey.source,
      spendWindowUsd: grant.limits.spendWindowUsd,
      spendWeekUsd: grant.limits.spendWeekUsd,
      requestsPerMinute: grant.limits.requestsPerMinute,
      rail: grant.rail,
      ...context.rail.logFields(grant),
      requestModel,
      ...extra,
    });
  };
}

async function reportBudgetGateDenial(
  deps: LlmBrokerAppDeps,
  record: ModelBrokerTokenRecord,
  gate: GateDecisionDenied,
): Promise<void> {
  if (!gate.budgetInterruption || !record.ownerUid || !deps.onBudgetInterruption) return;
  try {
    await deps.onBudgetInterruption({
      uid: record.ownerUid,
      reason: gate.budgetInterruption,
    });
  } catch (error) {
    reportBrokerResolutionError(deps, error);
  }
}

function createBrokerRequestHandler(options: BrokerRequestHandlerOptions) {
  return async (req: Request, res: ExpressResponse, next: NextFunction): Promise<void> => {
    try {
      const context = await resolveBrokerRequest(options, req, res);
      if (!context) return;
      const { deps, fetchImpl, upstreamBaseUrls, houseModels, now, upstreamHeaderTimeoutMs } = options;
      const { url, record, requestModel, providerKey, grant } = context;
      const logGate = brokerGateLogger(deps, context);
      const gate = await preflightGate({
        req,
        url,
        record,
        grant,
        rail: context.rail,
        source: providerKey.source,
        usageStore: deps.usageStore,
        now,
        onMeteringError: deps.onMeteringError ?? (() => undefined),
      });
      if (!gate.allowed) {
        await reportBudgetGateDenial(deps, record, gate);
        sendGateDenied(res, gate, logGate);
        return;
      }
      await logAndForwardAllowed({
        req,
        res,
        url,
        record,
        providerKey,
        gate,
        fetchImpl,
        upstreamBaseUrl: upstreamBaseUrls[record.provider],
        vertex: deps.vertex,
        houseModels,
        resolveHouseModel: deps.resolveHouseModel,
        requestModel,
        logGate,
        rail: context.rail,
        grant,
        fundedBudget: grant.fundedBudget,
        usageStore: deps.usageStore,
        upstreamHeaderTimeoutMs,
        now,
        onMeteringError: deps.onMeteringError ?? (() => undefined),
        log: deps.log,
      });
    } catch (err) {
      next(err);
    }
  };
}

export function createLlmBrokerApp(deps: LlmBrokerAppDeps): express.Express {
  const app = express();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const upstreamBaseUrls: Record<ModelBrokerProvider, string> = {
    anthropic: trimTrailingSlash(
      configuredString(
        deps.providerUpstreamBaseUrls?.anthropic,
        deps.upstreamBaseUrl,
        DEFAULT_ANTHROPIC_UPSTREAM_BASE_URL,
      ),
    ),
    openrouter: trimTrailingSlash(
      configuredString(
        deps.providerUpstreamBaseUrls?.openrouter,
        DEFAULT_OPENROUTER_UPSTREAM_BASE_URL,
      ),
    ),
    openai: trimTrailingSlash(
      configuredString(
        deps.providerUpstreamBaseUrls?.openai,
        DEFAULT_OPENAI_UPSTREAM_BASE_URL,
      ),
    ),
    vertex: "",
    meta: "https://api.meta.ai",
  };
  const houseModels: Record<ModelBrokerProvider, string> = {
    anthropic: configuredString(
      deps.providerHouseModels?.anthropic,
      deps.houseModel,
      DEFAULT_HOUSE_MODEL,
    ),
    openrouter: configuredString(
      deps.providerHouseModels?.openrouter,
      DEFAULT_OPENROUTER_HOUSE_MODEL,
    ),
    openai: configuredString(
      deps.providerHouseModels?.openai,
      DEFAULT_OPENAI_HOUSE_MODEL,
    ),
    vertex: configuredString(
      deps.providerHouseModels?.vertex,
      DEFAULT_VERTEX_HOUSE_MODEL,
    ),
    meta: "muse-ember-1.0",
  };
  const now = deps.now ?? Date.now;
  const upstreamHeaderTimeoutMs =
    deps.upstreamHeaderTimeoutMs ?? DEFAULT_UPSTREAM_HEADER_TIMEOUT_MS;

  app.disable("x-powered-by");

  app.get("/healthz", (_req, res) => {
    res.json({
      status: "ok",
      service: "llm-broker",
      providers: {
        anthropic: providerConfigured(deps, "anthropic"),
        openrouter: providerConfigured(deps, "openrouter"),
        openai: providerConfigured(deps, "openai"),
        vertex: providerConfigured(deps, "vertex"),
        meta: providerConfigured(deps, "meta"),
      },
    });
  });

  app.get("/v1/catalog", rateLimit({
    windowMs: 60_000, limit: 2400, standardHeaders: false, legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => Boolean(res.locals.catalogCredential),
  }), authorizeBrokerCatalog(deps, now), rateLimit({
    windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false,
    keyGenerator: (_req, res) => {
      const record: ModelBrokerTokenRecord = res.locals.catalogCredential;
      return JSON.stringify([record.gatewayId, record.ownerUid]);
    },
    message: { error: "model catalog rate limit exceeded" },
  }), createBrokerCatalogHandler(deps, now));

  app.use(
    "/v1",
    express.raw({ type: "*/*", limit: deps.bodyLimit ?? DEFAULT_BODY_LIMIT }),
    createBrokerRequestHandler({
      deps,
      rails: deps.rails,
      fetchImpl,
      upstreamBaseUrls,
      houseModels,
      now,
      upstreamHeaderTimeoutMs,
    }),
  );

  app.use((err: Error, _req: Request, res: ExpressResponse, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof UpstreamHeaderTimeoutError) {
      res.status(504).json({ error: err.message });
      return;
    }
    res.status(502).json({ error: "llm broker upstream failure", message: err.message });
  });

  return app;
}
