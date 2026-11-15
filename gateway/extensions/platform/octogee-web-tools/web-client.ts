import { readFile } from "node:fs/promises";

export type WebToolErrorCode =
  | "no-agent"
  | "auth-unavailable"
  | "control-error"
  | string;

export class WebToolError extends Error {
  constructor(
    public readonly code: WebToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WebToolError";
  }
}

type FetchLike = typeof fetch;

interface BaseInput {
  agentId: unknown;
  requestId: string;
}

export type WebSearchInput = BaseInput & Record<string, unknown> & {
  provider: "brave" | "tavily";
  query: string;
};

export type WebExtractInput = BaseInput & Record<string, unknown> & {
  urls: string[];
};

interface WebClientOptions {
  brokerUrl?: string;
  gatewayId?: string;
  tokenPath?: string;
  fetchImpl?: FetchLike;
  tokenProvider?: () => Promise<string | null>;
}

const DEFAULT_TOKEN_PATH = "/var/run/secrets/octogee-api/token";

function brokerUrl(): string {
  if (process.env.FLEET_BROKER_URL) return process.env.FLEET_BROKER_URL;
  if (process.env.OCTOGEE_API_URL) return process.env.OCTOGEE_API_URL;
  const namespace = process.env.K8S_NAMESPACE || "octogee";
  return `http://octogee-api.${namespace}.svc.cluster.local:3001`;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

async function projectedToken(path: string): Promise<string | null> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value || null;
  } catch {
    return null;
  }
}

export function createWebClient(options: WebClientOptions = {}) {
  const base = stripTrailingSlashes(options.brokerUrl || brokerUrl());
  const gatewayId = options.gatewayId || process.env.GATEWAY_ID;
  const tokenPath =
    options.tokenPath || process.env.OCTOGEE_API_SA_TOKEN_PATH || DEFAULT_TOKEN_PATH;
  const fetchImpl = options.fetchImpl ?? fetch;
  const tokenProvider = options.tokenProvider ?? (() => projectedToken(tokenPath));

  async function post(path: string, input: BaseInput & Record<string, unknown>) {
    if (typeof input.agentId !== "string" || input.agentId.length === 0) {
      throw new WebToolError("no-agent", "no agentId in tool context");
    }
    if (!gatewayId) {
      throw new WebToolError("auth-unavailable", "gateway identity unavailable");
    }
    const token = await tokenProvider();
    if (!token) {
      throw new WebToolError(
        "auth-unavailable",
        `projected gateway service-account token unavailable at ${tokenPath}`,
      );
    }
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-K8s-Sa-Token": token },
        body: JSON.stringify({ gatewayId, ...input }),
      });
    } catch (error) {
      throw new WebToolError(
        "control-error",
        `web broker unreachable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const parsed = (await response.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    if (!response.ok) {
      throw new WebToolError(
        typeof parsed?.code === "string" ? parsed.code : "control-error",
        typeof parsed?.error === "string"
          ? parsed.error
          : `web broker call failed (${response.status})`,
      );
    }
    if (!parsed) {
      throw new WebToolError("control-error", "web broker returned a non-JSON response");
    }
    return parsed;
  }

  return {
    search(input: WebSearchInput) {
      return post("/internal/fleet/agent/web-search", input);
    },
    extract(input: WebExtractInput) {
      return post("/internal/fleet/agent/web-extract", input);
    },
  };
}
