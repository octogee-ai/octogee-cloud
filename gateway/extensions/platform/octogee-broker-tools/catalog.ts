import type { ProviderCatalogContext, ProviderCatalogResult, UnifiedModelCatalogEntry } from "openclaw/plugin-sdk/core";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { brokerOrigin, BrokerMetadataUnavailable, readBrokerJson, record } from "./http.js";

export const BROKER_PROVIDER_ID = "octogee-broker";
const PROVIDERS = [
  { id: "platform-meta", provider: "meta", api: "openai-responses", route: "/v1/responses", env: "PLATFORM_META_BASE_URL" },
  { id: "anthropic", provider: "anthropic", api: "anthropic-messages", route: "/v1/messages", env: "ANTHROPIC_BASE_URL" },
  { id: "platform-openai", provider: "openai", api: "openai-responses", route: "/v1/responses", env: "PLATFORM_OPENAI_BASE_URL" },
  { id: "platform-openrouter", provider: "openrouter", api: "openai-completions", route: "/v1/chat/completions", env: "OPENROUTER_BASE_URL" },
  { id: "platform-vertex", provider: "vertex", api: "anthropic-messages", route: "/v1/messages", env: "PLATFORM_VERTEX_BASE_URL" },
] as const;

const BARE_ID_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "vertex"]);
function providerModelId(model: CatalogModel, provider: Provider): string {
  const prefix = `${provider.provider}/`;
  return BARE_ID_PROVIDERS.has(provider.provider) && model.id.startsWith(prefix) ? model.id.slice(prefix.length) : model.id;
}

type Provider = typeof PROVIDERS[number];
type Api = Provider["api"];
function transport(provider: Provider, api: string | undefined): { api: Api; route: string } | null {
  const selected = api ?? provider.api;
  if (provider.id === "platform-openai" && selected === "openai-completions") return { api: selected, route: "/v1/chat/completions" };
  return selected === provider.api ? { api: provider.api, route: provider.route } : null;
}
type RuntimeModel = NonNullable<Extract<NonNullable<ProviderCatalogResult>, { provider: unknown }>["provider"]>["models"][number];
interface CatalogModel {
  id: string; label: string; contextTokens?: number; maxOutputTokens?: number; reasoning?: boolean;
  input?: ("text" | "image")[];
  pricing?: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number };
}

function positiveIntegerOrAbsent(value: unknown): boolean {
  return value === undefined || Number.isSafeInteger(value) && Number(value) > 0;
}
function validModelInput(value: unknown): boolean {
  return value === undefined || Array.isArray(value) && value.every(v => v === "text" || v === "image");
}
function validatePricing(value: unknown): void {
  if (value === undefined) return;
  const price = record(value);
  if (["inputPerMTok", "outputPerMTok", "cacheReadPerMTok", "cacheWritePerMTok"].some(key => typeof price[key] !== "number" || !Number.isFinite(price[key]) || Number(price[key]) < 0)) throw new BrokerMetadataUnavailable();
}
function parseModel(value: unknown, provider: string): CatalogModel {
  const row = record(value);
  if (row.provider !== provider || typeof row.id !== "string" || !row.id || row.id.length > 256 || typeof row.label !== "string" || row.label.length > 256) throw new BrokerMetadataUnavailable();
  for (const field of ["contextTokens", "maxOutputTokens"]) {
    if (!positiveIntegerOrAbsent(row[field])) throw new BrokerMetadataUnavailable();
  }
  if (row.reasoning !== undefined && typeof row.reasoning !== "boolean") throw new BrokerMetadataUnavailable();
  if (!validModelInput(row.input)) throw new BrokerMetadataUnavailable();
  validatePricing(row.pricing);
  return row as unknown as CatalogModel;
}

function canonicalAgentId(ctx: ProviderCatalogContext): string | undefined {
  if (!ctx.agentDir) return undefined;
  const agents = listAgentIds(ctx.config).filter(id => resolveAgentDir(ctx.config, id) === ctx.agentDir);
  return agents.length === 1 ? agents[0] : undefined;
}
function configuredBroker(ctx: ProviderCatalogContext, provider: Provider) {
  const configured = ctx.config.models?.providers?.[provider.id];
  const expected = ctx.env[provider.env];
  if (!configured || !expected || brokerOrigin(configured.baseUrl).href !== brokerOrigin(expected).href) return null;
  const selected = transport(provider, configured.api);
  return selected ? { configured, expected, selected } : null;
}
function scopedCatalogModels(data: Record<string, unknown>, agentId: string, provider: Provider, path: string): CatalogModel[] {
  if (data.schemaVersion !== 1 || data.agentId !== agentId || data.provider !== provider.provider || data.purpose !== "model" || data.providerCredentialConfigured !== true || data.admission !== "request-time" ||
      !Array.isArray(data.models) || data.models.length > 5000 || !Array.isArray(data.routes) ||
      !data.routes.some(value => { const route = record(value); return route.method === "POST" && route.path === path; })) throw new BrokerMetadataUnavailable();
  return data.models.map(row => parseModel(row, provider.provider));
}

async function discover(ctx: ProviderCatalogContext, provider: Provider, fetchImpl: typeof fetch): Promise<{ models: CatalogModel[]; baseUrl: string; api: Api } | null> {
  ctx.signal?.throwIfAborted();
  const agentId = canonicalAgentId(ctx);
  if (!agentId) return null;
  const broker = configuredBroker(ctx, provider);
  if (!broker) return null;
  const { configured, expected, selected } = broker;
  const auth = await resolveApiKeyForProvider({ provider: provider.id, cfg: ctx.config, agentDir: ctx.agentDir, workspaceDir: ctx.workspaceDir, signal: ctx.signal });
  ctx.signal?.throwIfAborted();
  if (!auth?.apiKey) return null;
  const url = brokerOrigin(expected); url.pathname = "/v1/catalog";
  const data = record(await readBrokerJson(url, { headers: { authorization: `Bearer ${auth.apiKey}`, accept: "application/json" }, signal: ctx.signal }, fetchImpl));
  ctx.signal?.throwIfAborted();
  const models = scopedCatalogModels(data, agentId, provider, selected.route);
  const current = await resolveApiKeyForProvider({ provider: provider.id, cfg: ctx.config, agentDir: ctx.agentDir, workspaceDir: ctx.workspaceDir, signal: ctx.signal });
  ctx.signal?.throwIfAborted();
  if (current?.apiKey !== auth.apiKey || !listAgentIds(ctx.config).includes(agentId) || resolveAgentDir(ctx.config, agentId) !== ctx.agentDir) throw new BrokerMetadataUnavailable("unauthorized");
  return { models, baseUrl: configured.baseUrl, api: selected.api };
}

function runtimeModel(model: CatalogModel, provider: Provider, api: Api): RuntimeModel | null {
  if (!model.pricing || !model.contextTokens || !model.maxOutputTokens || !model.input || model.reasoning === undefined) return null;
  return { id: providerModelId(model, provider),
    name: model.label, api, reasoning: model.reasoning, input: model.input,
    contextWindow: model.contextTokens, maxTokens: model.maxOutputTokens,
    cost: { input: model.pricing.inputPerMTok, output: model.pricing.outputPerMTok, cacheRead: model.pricing.cacheReadPerMTok, cacheWrite: model.pricing.cacheWritePerMTok } };
}

export function createBrokerCatalog(fetchImpl: typeof fetch = fetch) {
  const eligible = (ctx: ProviderCatalogContext) => PROVIDERS.filter(provider => !ctx.providerIds || ctx.providerIds.includes(BROKER_PROVIDER_ID) || ctx.providerIds.includes(provider.id));
  return {
    async runtime(ctx: ProviderCatalogContext): Promise<ProviderCatalogResult> {
      const providers: Record<string, NonNullable<Extract<NonNullable<ProviderCatalogResult>, { provider: unknown }>["provider"]>> = {};
      for (const provider of eligible(ctx)) {
        const found = await discover(ctx, provider, fetchImpl);
        if (!found) continue;
        const models = found.models.flatMap(model => { const row = runtimeModel(model, provider, found.api); return row ? [row] : []; });
        providers[provider.id] = { ...ctx.config.models!.providers![provider.id], baseUrl: found.baseUrl, api: found.api, models };
      }
      return { providers };
    },
    async picker(ctx: ProviderCatalogContext): Promise<UnifiedModelCatalogEntry[]> {
      const rows: UnifiedModelCatalogEntry[] = [];
      for (const provider of eligible(ctx)) {
        const found = await discover(ctx, provider, fetchImpl);
        if (!found) continue;
        for (const model of found.models) rows.push({ kind: "text", provider: provider.id,
          model: providerModelId(model, provider),
          label: model.label, source: "live", configured: true,
          warnings: ["Admission is checked for each inference request", ...(!runtimeModel(model, provider, found.api) ? ["Complete runtime metadata/pricing unavailable"] : [])] });
      }
      return rows;
    },
  };
}
