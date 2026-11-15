import { containsAsciiControlCharacter } from "@octogee/shared/types/text-validation";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MATTERMOST_ID_RE = /^[a-z0-9]{26}$/;
const MATTERMOST_INTERNAL_HOST_RE = /^mattermost\.[a-z0-9-]+\.svc\.cluster\.local$/;

export class MattermostInternalHttpError extends Error {
  override readonly name = "MattermostInternalHttpError";

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function assertMattermostId(value: unknown, label: string): string {
  if (typeof value !== "string" || !MATTERMOST_ID_RE.test(value)) {
    throw new Error(`invalid Mattermost ${label}`);
  }
  return value;
}

function internalBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("invalid Mattermost internal base URL");
  }
  if (
    parsed.protocol !== "http:" ||
    !MATTERMOST_INTERNAL_HOST_RE.test(parsed.hostname) ||
    parsed.port !== "8065" ||
    parsed.pathname !== "/" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("invalid Mattermost internal base URL");
  }
  return `${parsed.protocol}//${parsed.host}`;
}

function tokenValue(value: string | undefined, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 4_096 ||
    containsAsciiControlCharacter(value) || value.includes(" ")
  ) {
    throw new Error("invalid Mattermost internal token");
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid Mattermost ${label}`);
  return value;
}

function requestUrl(
  baseUrl: string,
  segments: readonly string[],
  query?: Readonly<Record<string, string>>,
): string {
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment.length > 256 || containsAsciiControlCharacter(segment))
  ) {
    throw new Error("invalid Mattermost request path");
  }
  const url = new URL(`${baseUrl}/api/v4/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new MattermostInternalHttpError("Mattermost response exceeded size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export interface MattermostInternalHttpResponse {
  status: number;
  ok: boolean;
  bodyText: string;
}

export interface MattermostInternalHttpClient {
  request(
    method: "GET" | "DELETE",
    segments: readonly string[],
    query?: Readonly<Record<string, string>>,
  ): Promise<MattermostInternalHttpResponse>;
  requestJson(
    method: "GET",
    segments: readonly string[],
    query?: Readonly<Record<string, string>>,
  ): Promise<unknown>;
}

export function createMattermostInternalHttpClient(input: {
  baseUrl: string;
  token?: string;
  requireToken?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}): MattermostInternalHttpClient {
  const baseUrl = internalBaseUrl(input.baseUrl);
  const token = tokenValue(input.token, input.requireToken ?? input.token !== undefined);
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = positiveInteger(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeout");
  const maxResponseBytes = positiveInteger(
    input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "response size limit",
  );

  const request = async (
    method: "GET" | "DELETE",
    segments: readonly string[],
    query?: Readonly<Record<string, string>>,
  ): Promise<MattermostInternalHttpResponse> => {
    const response = await fetchImpl(requestUrl(baseUrl, segments, query), {
      method,
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return {
      status: response.status,
      ok: response.ok,
      bodyText: await boundedText(response, maxResponseBytes),
    };
  };

  return {
    request,
    async requestJson(method, segments, query) {
      const response = await request(method, segments, query);
      if (!response.ok) {
        throw new MattermostInternalHttpError(
          `Mattermost HTTP ${response.status}: ${response.bodyText.slice(0, 200)}`,
          response.status,
        );
      }
      try {
        return JSON.parse(response.bodyText) as unknown;
      } catch {
        throw new MattermostInternalHttpError("Mattermost returned malformed JSON", response.status);
      }
    },
  };
}
