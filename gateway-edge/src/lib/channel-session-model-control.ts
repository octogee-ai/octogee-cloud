import { isValidModelRef } from "@octogee/shared/types/agent-models";
import { containsAsciiControlCharacter } from "@octogee/shared/types/text-validation";

const INTERNAL_HOST = /^mattermost\.[a-z0-9-]+\.svc\.cluster\.local$/;
const MATTERMOST_ID = /^[a-z0-9]{26}$/;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface MattermostModelPost {
  id: string;
  type: string;
  root_id: string;
  channel_id: string;
  user_id: string;
  create_at: number;
  message: string;
  update_at?: number;
  edit_at?: number;
  delete_at?: number;
  pending_post_id?: string;
  file_ids?: string[];
  props?: Record<string, unknown>;
}

export interface MattermostChannelHistoryPage {
  posts: MattermostModelPost[];
  nextBefore?: string;
  reachedEnd: boolean;
}

export interface NativeModelResult {
  outcome: "applied" | "rejected" | "unknown";
  currentModel?: string;
  providers?: string[];
  models?: string[];
}

export class ChannelSessionMattermostError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ChannelSessionMattermostError";
  }
}

export function pickCorrelatedAgentReply(
  posts: readonly MattermostModelPost[],
  expected: { rootPostId: string; channelId: string; agentUserId: string; commandCreatedAt: number },
): MattermostModelPost | null {
  return posts
    .filter((post) =>
      post.id !== expected.rootPostId &&
      post.root_id === expected.rootPostId &&
      post.channel_id === expected.channelId &&
      post.user_id === expected.agentUserId &&
      post.create_at >= expected.commandCreatedAt)
    .sort((a, b) => a.create_at - b.create_at)[0] ?? null;
}

export function parseNativeModelResult(operation: string, message: string): NativeModelResult {
  const lines = message.split("\n").map((line) => line.trim());
  const providers = lines.flatMap((line) => {
    const match = /^- ([a-z0-9][a-z0-9._-]{0,127}) \(\d+\)$/i.exec(line);
    return match && PROVIDER.test(match[1]) ? [match[1]] : [];
  });
  const models = lines.flatMap((line) => {
    const candidate = line.startsWith("- ") ? line.slice(2) : "";
    return isValidModelRef(candidate) ? [candidate] : [];
  });
  const currentMatch = /(?:^|\n)(?:🧠\s*)?Model(?::| set to)\s+([^\s·)]+)(?:\s|\)|\.|$)/i.exec(message);
  const resetMatch = /^Model reset to default \(([^)]+)\)/i.exec(message.trim());
  const currentCandidate = currentMatch?.[1] ?? resetMatch?.[1];
  const currentModel = currentCandidate && isValidModelRef(currentCandidate) ? currentCandidate : undefined;
  const rejected = /\b(?:not allowed|unknown provider|unavailable|missing auth|authentication|error)\b/i.test(message);
  const applied = operation === "setSessionModel" || operation === "resetSessionModel"
    ? /^Model (?:set to|reset to default)/i.test(message.trim())
    : false;
  let outcome: NativeModelResult["outcome"] = "unknown";
  if (rejected) outcome = "rejected";
  else if (applied) outcome = "applied";
  return {
    outcome,
    ...(currentModel ? { currentModel } : {}),
    ...(providers.length ? { providers: [...new Set(providers)] } : {}),
    ...(models.length ? { models: [...new Set(models)] } : {}),
  };
}

function validatedBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid Mattermost internal base URL"); }
  if (url.protocol !== "http:" || !INTERNAL_HOST.test(url.hostname) || url.port !== "8065" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("invalid Mattermost internal base URL");
  }
  return `${url.protocol}//${url.host}`;
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
      throw new ChannelSessionMattermostError("Mattermost response exceeded size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

interface MattermostHistoryRecord {
  order: unknown[];
  posts: Record<string, unknown>;
  prev_post_id?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidHistoryCursor(value: unknown): boolean {
  return value === undefined ||
    typeof value === "string" && (!value || MATTERMOST_ID.test(value));
}

function parseHistoryRecord(value: unknown, perPage: number): MattermostHistoryRecord | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.order) || value.order.length > perPage) return null;
  if (new Set(value.order).size !== value.order.length || !isRecord(value.posts)) return null;
  if (!isValidHistoryCursor(value.prev_post_id)) return null;
  return {
    order: value.order,
    posts: value.posts,
    ...(value.prev_post_id === undefined ? {} : { prev_post_id: value.prev_post_id }),
  };
}

function hasValidPostIdentity(
  post: Partial<MattermostModelPost>,
  postId: string,
  channelId: string,
): boolean {
  return post.id === postId &&
    post.channel_id === channelId &&
    typeof post.user_id === "string" &&
    MATTERMOST_ID.test(post.user_id);
}

function hasValidPostContent(post: Partial<MattermostModelPost>): boolean {
  return typeof post.type === "string" &&
    typeof post.root_id === "string" &&
    (!post.root_id || MATTERMOST_ID.test(post.root_id)) &&
    typeof post.message === "string";
}

function isNonnegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasValidPostTimestamps(post: Partial<MattermostModelPost>): boolean {
  return isNonnegativeSafeInteger(post.create_at) &&
    isNonnegativeSafeInteger(post.update_at) &&
    isNonnegativeSafeInteger(post.edit_at) &&
    isNonnegativeSafeInteger(post.delete_at);
}

function hasValidPostFiles(fileIds: MattermostModelPost["file_ids"]): boolean {
  return fileIds === undefined ||
    Array.isArray(fileIds) &&
      fileIds.every((id) => typeof id === "string" && MATTERMOST_ID.test(id));
}

function hasValidPostMetadata(post: Partial<MattermostModelPost>): boolean {
  return typeof post.pending_post_id === "string" &&
    hasValidPostFiles(post.file_ids) &&
    isRecord(post.props);
}

function parseHistoryPost(
  postsById: Record<string, unknown>,
  postId: unknown,
  channelId: string,
): MattermostModelPost {
  if (typeof postId !== "string" || !MATTERMOST_ID.test(postId)) {
    throw new ChannelSessionMattermostError("Mattermost channel history response was invalid");
  }
  const value = postsById[postId];
  if (!isRecord(value)) {
    throw new ChannelSessionMattermostError("Mattermost channel history response was invalid");
  }
  const post = value as Partial<MattermostModelPost>;
  if (
    !hasValidPostIdentity(post, postId, channelId) ||
    !hasValidPostContent(post) ||
    !hasValidPostTimestamps(post) ||
    !hasValidPostMetadata(post)
  ) {
    throw new ChannelSessionMattermostError("Mattermost channel history response was invalid");
  }
  return {
    ...post,
    file_ids: post.file_ids ?? [],
  } as MattermostModelPost;
}

function nextHistoryCursor(
  record: MattermostHistoryRecord,
  posts: readonly MattermostModelPost[],
  perPage: number,
): string | undefined {
  if (typeof record.prev_post_id === "string" && record.prev_post_id) {
    return record.prev_post_id;
  }
  return posts.length === perPage ? posts.at(-1)?.id : undefined;
}

export function createChannelSessionMattermostClient(input: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}) {
  const baseUrl = validatedBaseUrl(input.baseUrl);
  if (input.token.length < 16 || input.token.length > 4096 || containsAsciiControlCharacter(input.token) || input.token.includes(" ")) throw new Error("invalid Mattermost token");
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const maxResponseBytes = input.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_RESPONSE_BYTES
  ) {
    throw new Error("invalid Mattermost response size limit");
  }
  const fetchJson = async (
    url: string,
    init: RequestInit,
  ): Promise<unknown> => {
    let response: Response;
    try {
      const signal = input.signal
        ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      response = await fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Bearer ${input.token}`,
          accept: "application/json",
          ...init.headers,
        },
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason;
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw error;
      }
      throw new ChannelSessionMattermostError("Mattermost transport failed");
    }
    let text: string;
    try {
      text = await boundedText(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof ChannelSessionMattermostError) throw error;
      throw new ChannelSessionMattermostError(
        "Mattermost response was invalid",
        response.status,
      );
    }
    if (!response.ok) {
      throw new ChannelSessionMattermostError(
        `Mattermost HTTP ${response.status}`,
        response.status,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ChannelSessionMattermostError(
        "Mattermost returned malformed JSON",
        response.status,
      );
    }
  };
  const requestJson = async (method: "GET" | "POST", segments: readonly string[], body?: unknown): Promise<unknown> => {
    if (!segments.length || segments.some((segment) => !segment || segment.length > 256 || containsAsciiControlCharacter(segment))) throw new Error("invalid Mattermost path");
    const url = `${baseUrl}/api/v4/${segments.map(encodeURIComponent).join("/")}`;
    return fetchJson(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  return {
    getJson: (segments: readonly string[]) => requestJson("GET", segments),
    postJson: (segments: readonly string[], body: unknown) => requestJson("POST", segments, body),
    uploadFiles: async (channelId: string, files: readonly { fileName: string; mimeType: string; bytes: Buffer }[]) => {
      if (!MATTERMOST_ID.test(channelId) || files.length < 1 || files.length > 8) throw new Error('Invalid Mattermost upload');
      const form = new FormData();
      form.set('channel_id', channelId);
      for (const file of files) form.append('files', new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }), file.fileName);
      return fetchJson(`${baseUrl}/api/v4/files`, { method: 'POST', body: form });
    },
    async getCurrentUserId(): Promise<string> {
      const value = await requestJson("GET", ["users", "me"]);
      const id = (value as { id?: unknown } | null)?.id;
      if (typeof id !== "string") throw new ChannelSessionMattermostError("Mattermost current user response was invalid");
      return id;
    },
    async listChannelPosts(
      channelId: string,
      before?: string,
      perPage = 100,
    ): Promise<MattermostChannelHistoryPage> {
      if (!MATTERMOST_ID.test(channelId)) {
        throw new Error("invalid Mattermost channel id");
      }
      if (
        before !== undefined &&
        !MATTERMOST_ID.test(before)
      ) {
        throw new Error("invalid Mattermost history cursor");
      }
      if (!Number.isSafeInteger(perPage) || perPage < 1 || perPage > 200) {
        throw new Error("invalid Mattermost history page size");
      }
      const query = new URLSearchParams({ per_page: String(perPage) });
      if (before) query.set("before", before);
      const value = await fetchJson(
        `${baseUrl}/api/v4/channels/${encodeURIComponent(channelId)}/posts?${query.toString()}`,
        { method: "GET" },
      );
      const record = parseHistoryRecord(value, perPage);
      if (!record) {
        throw new ChannelSessionMattermostError(
          "Mattermost channel history response was invalid",
        );
      }
      const posts = record.order.map((postId) =>
        parseHistoryPost(record.posts, postId, channelId)
      );
      const nextBefore = nextHistoryCursor(record, posts, perPage);
      return {
        posts,
        ...(nextBefore ? { nextBefore } : {}),
        reachedEnd:
          posts.length < perPage ||
          (record.prev_post_id !== undefined && !record.prev_post_id),
      };
    },
  };
}
