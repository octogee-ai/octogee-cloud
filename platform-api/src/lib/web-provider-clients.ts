export type WebProviderErrorCode =
  | "provider_rate_limited"
  | "provider_error"
  | "provider_response_too_large";

export class WebProviderError extends Error {
  constructor(
    public readonly code: WebProviderErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WebProviderError";
  }
}

type FetchLike = typeof fetch;

export interface BraveSearchInput {
  query: string;
  count?: number;
  country?: string;
  searchLang?: string;
  uiLang?: string;
  freshness?: "day" | "week" | "month" | "year";
}

export interface NormalizedSearchResult {
  title: string;
  url: string;
  snippet: string;
  age?: string;
  source?: string;
}

export interface BraveSearchOutput {
  provider: "brave";
  requestId: string | null;
  results: NormalizedSearchResult[];
}

export interface TavilySearchInput {
  query: string;
  searchDepth?: "basic" | "advanced";
  topic?: "general" | "news" | "finance";
  maxResults?: number;
  timeRange?: "day" | "week" | "month" | "year";
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface TavilyExtractInput {
  urls: string[];
  query?: string;
  extractDepth?: "basic" | "advanced";
}

export interface TavilySearchOutput {
  provider: "tavily";
  requestId: string | null;
  credits: number;
  results: NormalizedSearchResult[];
}

export interface TavilyExtractOutput {
  provider: "tavily";
  requestId: string | null;
  credits: number;
  successfulUrlCount: number;
  results: Array<{ url: string; content: string }>;
  failures: Array<{ url: string; error: string }>;
}

interface ClientOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const TAVILY_EXTRACT_ENDPOINT = "https://api.tavily.com/extract";
const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max = 100_000): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

async function providerJson(
  provider: "Brave search" | "Tavily",
  response: Response,
  maxResponseBytes: number,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    if (response.status === 429) {
      throw new WebProviderError("provider_rate_limited", 429, `${provider} rate limited`);
    }
    throw new WebProviderError("provider_error", 502, `${provider} request failed`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    await response.body?.cancel();
    throw new WebProviderError(
      "provider_response_too_large",
      502,
      `${provider} response exceeded the size limit`,
    );
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxResponseBytes) {
        await reader.cancel();
        throw new WebProviderError(
          "provider_response_too_large",
          502,
          `${provider} response exceeded the size limit`,
        );
      }
      chunks.push(next.value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = record(JSON.parse(new TextDecoder().decode(bytes)));
    if (!parsed) throw new Error("not an object");
    return parsed;
  } catch {
    throw new WebProviderError("provider_error", 502, `${provider} returned invalid JSON`);
  }
}

function requestSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function normalizeSearchResults(value: unknown): NormalizedSearchResult[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 20).flatMap((entry) => {
    const item = record(entry);
    const title = text(item?.title, 1_000);
    const rawUrl = text(item?.url, 4_096);
    let url = "";
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") url = parsed.toString();
    } catch {
      url = "";
    }
    if (!item || !title || !url) return [];
    const profile = record(item.profile);
    return [{
      title,
      url,
      snippet: text(item.description ?? item.content, 8_000),
      ...(text(item.age, 200) ? { age: text(item.age, 200) } : {}),
      ...(text(profile?.long_name, 500) ? { source: text(profile?.long_name, 500) } : {}),
    }];
  });
}

export function createBraveSearchClient(options: ClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  return {
    async search(input: BraveSearchInput): Promise<BraveSearchOutput> {
      const url = new URL(BRAVE_ENDPOINT);
      url.searchParams.set("q", input.query);
      if (input.count !== undefined) url.searchParams.set("count", String(input.count));
      if (input.country) url.searchParams.set("country", input.country);
      if (input.searchLang) url.searchParams.set("search_lang", input.searchLang);
      if (input.uiLang) url.searchParams.set("ui_lang", input.uiLang);
      if (input.freshness) url.searchParams.set("freshness", FRESHNESS[input.freshness]);
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": options.apiKey,
        },
        signal: requestSignal(timeoutMs),
      });
      const data = await providerJson("Brave search", response, maxResponseBytes);
      const results = normalizeSearchResults(record(data.web)?.results);
      if (!results) {
        throw new WebProviderError("provider_error", 502, "Brave search returned an invalid response");
      }
      return {
        provider: "brave",
        requestId: response.headers.get("x-request-id"),
        results,
      };
    },
  };
}

async function tavilyPost(
  options: Required<Pick<ClientOptions, "apiKey" | "timeoutMs" | "maxResponseBytes">> & {
    fetchImpl: FetchLike;
  },
  endpoint: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await options.fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify({ ...body, include_usage: true }),
    signal: requestSignal(options.timeoutMs),
  });
  return providerJson("Tavily", response, options.maxResponseBytes);
}

export function createTavilyClient(options: ClientOptions) {
  const resolved = {
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };
  return {
    async search(input: TavilySearchInput): Promise<TavilySearchOutput> {
      const data = await tavilyPost(resolved, TAVILY_SEARCH_ENDPOINT, {
        query: input.query,
        search_depth: input.searchDepth ?? "basic",
        ...(input.topic ? { topic: input.topic } : {}),
        ...(input.maxResults !== undefined ? { max_results: input.maxResults } : {}),
        ...(input.timeRange ? { time_range: input.timeRange } : {}),
        ...(input.includeDomains ? { include_domains: input.includeDomains } : {}),
        ...(input.excludeDomains ? { exclude_domains: input.excludeDomains } : {}),
        include_answer: false,
      });
      const results = normalizeSearchResults(data.results);
      if (!results) {
        throw new WebProviderError("provider_error", 502, "Tavily returned an invalid search response");
      }
      return {
        provider: "tavily",
        requestId: text(data.request_id, 500) || null,
        credits: positiveNumber(record(data.usage)?.credits),
        results,
      };
    },
    async extract(input: TavilyExtractInput): Promise<TavilyExtractOutput> {
      const data = await tavilyPost(resolved, TAVILY_EXTRACT_ENDPOINT, {
        urls: input.urls,
        extract_depth: input.extractDepth ?? "basic",
        ...(input.query ? { query: input.query } : {}),
      });
      if (!Array.isArray(data.results) || (data.failed_results !== undefined && !Array.isArray(data.failed_results))) {
        throw new WebProviderError("provider_error", 502, "Tavily returned an invalid extract response");
      }
      const results = data.results.slice(0, 20).flatMap((entry) => {
        const item = record(entry);
        const url = text(item?.url, 4_096);
        if (!item || !url) return [];
        return [{ url, content: text(item.raw_content ?? item.content) }];
      });
      const failedResults = Array.isArray(data.failed_results) ? data.failed_results : [];
      const failures = failedResults.slice(0, 20).flatMap((entry) => {
        const item = record(entry);
        const url = text(item?.url, 4_096);
        if (!item || !url) return [];
        return [{ url, error: text(item.error, 1_000) || "extraction failed" }];
      });
      return {
        provider: "tavily",
        requestId: text(data.request_id, 500) || null,
        credits: positiveNumber(record(data.usage)?.credits),
        successfulUrlCount: results.length,
        results,
        failures,
      };
    },
  };
}
