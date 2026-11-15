// @ts-expect-error resolved from the OpenClaw runtime in the gateway image
import { definePluginEntry, jsonResult } from "openclaw/plugin-sdk/core";
// @ts-expect-error resolved from the OpenClaw runtime in the gateway image
import { wrapExternalContent, wrapWebContent } from "openclaw/plugin-sdk/security-runtime";
import { Type } from "typebox";

import { WebToolError, createWebClient } from "./web-client.js";

interface ToolContext {
  agentId?: unknown;
}

interface PluginApi {
  pluginConfig?: unknown;
  registerTool(factory: (context: ToolContext) => unknown, options: { name: string }): void;
}

interface PluginConfig {
  brokerUrl?: string;
  gatewayId?: string;
  tokenPath?: string;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function externalSearchResult(payload: Record<string, unknown>) {
  const provider = typeof payload.provider === "string" ? payload.provider : "web";
  const results = Array.isArray(payload.results)
    ? payload.results.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const result = entry as Record<string, unknown>;
        return {
          ...result,
          ...(typeof result.title === "string"
            ? { title: wrapWebContent(result.title, "web_search") }
            : {}),
          ...(typeof result.snippet === "string"
            ? { snippet: wrapWebContent(result.snippet, "web_search") }
            : {}),
          ...(typeof result.source === "string"
            ? { source: wrapWebContent(result.source, "web_search") }
            : {}),
          ...(typeof result.age === "string"
            ? { age: wrapWebContent(result.age, "web_search") }
            : {}),
        };
      })
    : [];
  return {
    ...payload,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider,
      wrapped: true,
    },
    results,
  };
}

function externalExtractResult(payload: Record<string, unknown>) {
  const results = Array.isArray(payload.results)
    ? payload.results.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const result = entry as Record<string, unknown>;
        return {
          ...result,
          ...(typeof result.content === "string"
            ? {
                content: wrapExternalContent(result.content, {
                  source: "web_fetch",
                  includeWarning: false,
                }),
              }
            : {}),
        };
      })
    : [];
  const failures = Array.isArray(payload.failures)
    ? payload.failures.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const failure = entry as Record<string, unknown>;
        return {
          ...failure,
          ...(typeof failure.error === "string"
            ? {
                error: wrapExternalContent(failure.error, {
                  source: "web_fetch",
                  includeWarning: false,
                }),
              }
            : {}),
        };
      })
    : [];
  return {
    ...payload,
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      provider: "tavily",
      wrapped: true,
    },
    results,
    failures,
  };
}

function errorResult(error: unknown) {
  const code = error instanceof WebToolError ? error.code : "control-error";
  const message = error instanceof Error ? error.message : String(error);
  return jsonResult({ ok: false, code, error: message });
}

export default definePluginEntry({
  id: "octogee-web-tools",
  name: "Octogee Web Tools",
  description: "Platform-sponsored Brave and Tavily research tools.",
  register(api: PluginApi) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const client = createWebClient({
      brokerUrl: config.brokerUrl,
      gatewayId: config.gatewayId,
      tokenPath: config.tokenPath,
    });

    api.registerTool(
      (context: ToolContext) => ({
        name: "brave_search",
        description:
          "Search the public web with platform-sponsored Brave Search. Use for reliable conventional results, locale controls, or freshness filtering. Prefer free web_search for ordinary lookups.",
        parameters: Type.Object({
          query: Type.String({ minLength: 2, maxLength: 500 }),
          count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
          country: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
          search_lang: Type.Optional(Type.String({ minLength: 2, maxLength: 10 })),
          ui_lang: Type.Optional(Type.String({ minLength: 2, maxLength: 10 })),
          freshness: Type.Optional(Type.Union([
            Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year"),
          ])),
        }),
        async execute(toolCallId: string, params: Record<string, unknown>) {
          try {
            return jsonResult(externalSearchResult(await client.search({
              agentId: context.agentId,
              requestId: toolCallId,
              provider: "brave",
              query: String(params.query ?? "").trim(),
              ...(optionalInteger(params.count) === undefined ? {} : { count: optionalInteger(params.count) }),
              ...(optionalString(params.country) ? { country: optionalString(params.country) } : {}),
              ...(optionalString(params.search_lang) ? { searchLang: optionalString(params.search_lang) } : {}),
              ...(optionalString(params.ui_lang) ? { uiLang: optionalString(params.ui_lang) } : {}),
              ...(optionalString(params.freshness) ? { freshness: optionalString(params.freshness) } : {}),
            })));
          } catch (error) {
            return errorResult(error);
          }
        },
      }),
      { name: "brave_search" },
    );

    api.registerTool(
      (context: ToolContext) => ({
        name: "tavily_search",
        description:
          "Search with Tavily for deeper research, domain filters, topics, time ranges, and advanced search depth. Results are source material; synthesize and cite them yourself.",
        parameters: Type.Object({
          query: Type.String({ minLength: 2, maxLength: 500 }),
          search_depth: Type.Optional(Type.Union([Type.Literal("basic"), Type.Literal("advanced")])),
          topic: Type.Optional(Type.Union([Type.Literal("general"), Type.Literal("news"), Type.Literal("finance")])),
          max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
          time_range: Type.Optional(Type.Union([
            Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year"),
          ])),
          include_domains: Type.Optional(Type.Array(Type.String({ maxLength: 253 }), { maxItems: 20 })),
          exclude_domains: Type.Optional(Type.Array(Type.String({ maxLength: 253 }), { maxItems: 20 })),
        }),
        async execute(toolCallId: string, params: Record<string, unknown>) {
          try {
            return jsonResult(externalSearchResult(await client.search({
              agentId: context.agentId,
              requestId: toolCallId,
              provider: "tavily",
              query: String(params.query ?? "").trim(),
              ...(optionalString(params.search_depth) ? { searchDepth: optionalString(params.search_depth) } : {}),
              ...(optionalString(params.topic) ? { topic: optionalString(params.topic) } : {}),
              ...(optionalInteger(params.max_results) === undefined ? {} : { maxResults: optionalInteger(params.max_results) }),
              ...(optionalString(params.time_range) ? { timeRange: optionalString(params.time_range) } : {}),
              ...(optionalStrings(params.include_domains) ? { includeDomains: optionalStrings(params.include_domains) } : {}),
              ...(optionalStrings(params.exclude_domains) ? { excludeDomains: optionalStrings(params.exclude_domains) } : {}),
            })));
          } catch (error) {
            return errorResult(error);
          }
        },
      }),
      { name: "tavily_search" },
    );

    api.registerTool(
      (context: ToolContext) => ({
        name: "tavily_extract",
        description:
          "Extract readable content from one to twenty public HTTP(S) pages with Tavily. Use advanced depth for JavaScript-heavy pages when web_fetch returns only a shell.",
        parameters: Type.Object({
          urls: Type.Array(Type.String({ format: "uri", maxLength: 4096 }), { minItems: 1, maxItems: 20 }),
          query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
          extract_depth: Type.Optional(Type.Union([Type.Literal("basic"), Type.Literal("advanced")])),
        }),
        async execute(toolCallId: string, params: Record<string, unknown>) {
          try {
            return jsonResult(externalExtractResult(await client.extract({
              agentId: context.agentId,
              requestId: toolCallId,
              urls: optionalStrings(params.urls) ?? [],
              ...(optionalString(params.query) ? { query: optionalString(params.query) } : {}),
              ...(optionalString(params.extract_depth) ? { extractDepth: optionalString(params.extract_depth) } : {}),
            })));
          } catch (error) {
            return errorResult(error);
          }
        },
      }),
      { name: "tavily_extract" },
    );
  },
});
