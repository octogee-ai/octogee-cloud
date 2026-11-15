import { isValidGatewayId } from "@octogee/shared/types/glm";
import { isValidUsername } from "@octogee/shared/types/identity";
import type { AgentImportWorkspacePolicy } from "@octogee/shared/types/agent-import";

import type { AgentImportAuthorizationIntent } from "@octogee/shared/types/agent-import";
import { internalFetch } from "@octogee/core/internal-fetch";
import type { AgentImportManifestEntry } from "@octogee/core/http-candidates/agent-transfer/agent-import-git";
import type {
  AgentImportIdentity,
  AgentImportIdentitySnapshot,
  AgentImportRecord,
  StoredAgentImportPlan,
} from "@octogee/core/http-candidates/agent-transfer/agent-import-service";

const IMPORT_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const DEFAULT_TIMEOUT_MS = 120_000;

interface StoreDeps {
  baseUrl: string;
  authorization: string;
  gatewayId: string;
  tokenPath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function requireId(id: string): string {
  if (!IMPORT_ID_RE.test(id)) throw new Error("invalid agent import id");
  return id;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function trustedBaseUrl(value: string): string {
  const normalized = trimTrailingSlashes(value.trim());
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("agent import broker URL must be an absolute http(s) URL");
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error("agent import broker URL must be an absolute http(s) URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    hostname !== "octogee-api" && hostname !== "localhost" && hostname !== "127.0.0.1" &&
    !/^octogee-api\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.svc\.cluster\.local$/u.test(hostname)
  ) {
    throw new Error("agent import broker URL must target octogee-api or localhost");
  }
  return normalized;
}

function brokerBaseUrlFromEnv(env: Record<string, string | undefined> = process.env): string {
  const value = env.AGENT_IMPORT_BROKER_URL?.trim() || env.OPENCLAW_RUNTIME_BROKER_URL?.trim();
  if (!value) throw new Error("AGENT_IMPORT_BROKER_URL or OPENCLAW_RUNTIME_BROKER_URL is required");
  return trustedBaseUrl(value);
}

async function brokerError(response: Response): Promise<Error> {
  let body: JsonObject | null = null;
  try {
    body = object(await response.json());
  } catch {
    body = null;
  }
  const code = typeof body?.error === "string" ? body.error : "agent_import_broker_failed";
  const message = typeof body?.message === "string"
    ? body.message
    : `agent import broker returned ${response.status}`;
  return Object.assign(new Error(message), { code, status: response.status });
}

function validRecord(value: unknown, id: string): AgentImportRecord {
  const data = object(value);
  if (data?.kind === "authored-agent-export" || data?.id !== id || typeof data.uid !== "string" || typeof data.status !== "string") {
    throw new Error("agent import broker returned an invalid record");
  }
  return data as unknown as AgentImportRecord;
}

function validPlan(value: unknown): StoredAgentImportPlan {
  const data = object(value);
  const workspacePolicy = object(data?.workspacePolicy);
  if (
    typeof data?.uid !== "string" || typeof data.slug !== "string" ||
    typeof data.gatewayId !== "string" || typeof data.approvalHash !== "string" ||
    typeof workspacePolicy?.preserveConvergedContextFiles !== "boolean"
  ) {
    throw new Error("agent import broker returned an invalid plan");
  }
  return data as unknown as StoredAgentImportPlan;
}

function validIdentity(value: unknown): AgentImportIdentitySnapshot {
  const data = object(value);
  if (!data || Object.keys(data).some((key) => !["name", "persona", "emoji"].includes(key))) {
    throw new Error("agent import broker returned an invalid identity");
  }
  if (
    !["name", "persona", "emoji"].every((key) => Object.prototype.hasOwnProperty.call(data, key)) ||
    Object.values(data).some((entry) => entry !== null && typeof entry !== "string")
  ) {
    throw new Error("agent import broker returned an invalid identity");
  }
  return data as unknown as AgentImportIdentitySnapshot;
}

function validManifest(value: unknown): AgentImportManifestEntry {
  const data = object(value);
  if (
    data?.type !== "blob" || typeof data.gcsPath !== "string" ||
    typeof data.size !== "number" || typeof data.mimeType !== "string" ||
    typeof data.uploadedAt !== "string"
  ) {
    throw new Error("agent import broker returned an invalid blob manifest");
  }
  return data as unknown as AgentImportManifestEntry;
}

export function createAgentImportStore(deps: StoreDeps) {
  if (!deps.authorization.startsWith("Bearer ")) {
    throw new Error("Firebase authorization is required for the agent import broker");
  }
  if (!isValidGatewayId(deps.gatewayId)) throw new Error("agent import gateway id is invalid");
  const baseUrl = trustedBaseUrl(deps.baseUrl);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("agent import broker timeout is invalid");

  const request = async (pathname: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set("authorization", deps.authorization);
    const response = await internalFetch(`${baseUrl}/internal/agent-imports${pathname}`, {
      ...init,
      headers,
      redirect: "error",
      signal: deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    }, {
      tokenPath: deps.tokenPath,
      fetchImpl: deps.fetchImpl,
      requireProjectedToken: true,
    });
    return response;
  };

  const jsonRequest = async (pathname: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await request(pathname, init);
    if (!response.ok) throw await brokerError(response);
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new Error("agent import broker returned malformed JSON");
    }
  };

  const jsonBody = (value: unknown): RequestInit => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });

  return {
    async exportRequest(pathname: string, init: RequestInit = {}): Promise<unknown> {
      if (!pathname.startsWith("/exports/")) throw new Error("invalid authored export broker path");
      return jsonRequest(pathname, init);
    },
    async authorize(intent: AgentImportAuthorizationIntent): Promise<{
      slug: string;
      gatewayId: string;
      workspacePolicy: AgentImportWorkspacePolicy;
    }> {
      const value = object(await jsonRequest("/authorize", {
        method: "POST",
        ...jsonBody({ gatewayId: deps.gatewayId, intent }),
      }));
      const workspacePolicy = object(value?.workspacePolicy);
      if (
        !value || !isValidUsername(value.slug) || value.gatewayId !== deps.gatewayId ||
        typeof workspacePolicy?.preserveConvergedContextFiles !== "boolean"
      ) {
        throw new Error("agent import broker returned malformed authorization");
      }
      return {
        slug: value.slug,
        gatewayId: deps.gatewayId,
        workspacePolicy: {
          preserveConvergedContextFiles: workspacePolicy.preserveConvergedContextFiles,
        },
      };
    },

    async putRecord(record: AgentImportRecord): Promise<void> {
      await jsonRequest(`/records/${requireId(record.id)}`, { method: "PUT", ...jsonBody(record) });
    },

    async getRecord(id: string): Promise<AgentImportRecord | null> {
      const safeId = requireId(id);
      const response = await request(`/records/${safeId}`);
      if (response.status === 404) return null;
      if (!response.ok) throw await brokerError(response);
      return validRecord(await response.json(), safeId);
    },

    async getLatestRecord(): Promise<AgentImportRecord | null> {
      const response = await request("/records/latest");
      if (!response.ok) throw await brokerError(response);
      const value: unknown = await response.json();
      if (value === null) return null;
      const data = object(value);
      return validRecord(data, typeof data?.id === "string" ? data.id : "");
    },

    async putPlan(id: string, plan: StoredAgentImportPlan): Promise<void> {
      await jsonRequest(`/plans/${requireId(id)}`, { method: "PUT", ...jsonBody(plan) });
    },

    async getPlan(id: string): Promise<StoredAgentImportPlan | null> {
      const response = await request(`/plans/${requireId(id)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw await brokerError(response);
      return validPlan(await response.json());
    },

    async putArchive(id: string, archive: Buffer): Promise<void> {
      await jsonRequest(`/archives/${requireId(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/zip" },
        body: archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer,
      });
    },

    async getArchive(id: string): Promise<Buffer | null> {
      const response = await request(`/archives/${requireId(id)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw await brokerError(response);
      return Buffer.from(await response.arrayBuffer());
    },

    async deleteStaging(id: string): Promise<void> {
      await jsonRequest(`/staging/${requireId(id)}`, { method: "DELETE" });
    },

    async deleteImportBlobs(id: string): Promise<void> {
      await jsonRequest(`/blobs/${requireId(id)}`, { method: "DELETE" });
    },

    async abandonRecord(record: AgentImportRecord): Promise<void> {
      await jsonRequest(`/records/${requireId(record.id)}/abandon`, {
        method: "POST",
        ...jsonBody(record),
      });
    },

    async storeBlob(
      id: string,
      filePath: string,
      contents: Buffer,
      mimeType: string,
    ): Promise<AgentImportManifestEntry> {
      const value = await jsonRequest(`/blobs/${requireId(id)}?path=${encodeURIComponent(filePath)}`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-agent-import-mime": mimeType,
        },
        body: contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength) as ArrayBuffer,
      });
      return validManifest(value);
    },

    async readIdentity(): Promise<AgentImportIdentitySnapshot> {
      return validIdentity(await jsonRequest("/identity"));
    },

    async syncIdentity(value: AgentImportIdentity): Promise<void> {
      await jsonRequest("/identity", { method: "PATCH", ...jsonBody(value) });
    },

    async replaceIdentity(value: AgentImportIdentitySnapshot): Promise<void> {
      await jsonRequest("/identity", { method: "PUT", ...jsonBody(value) });
    },

    async listGithubSources(): Promise<unknown> {
      return jsonRequest("/github/sources");
    },

    async readGithubToken(): Promise<string | null> {
      const value = object(await jsonRequest("/github/token"));
      if (!value || typeof value.token !== "string" || !value.token) {
        throw new Error("agent import broker returned an invalid GitHub token response");
      }
      return value.token;
    },

    async readGithubRepoSize(owner: string, repo: string): Promise<number> {
      const value = object(await jsonRequest(`/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/size`));
      if (!value || typeof value.sizeKiB !== "number" || !Number.isSafeInteger(value.sizeKiB) || value.sizeKiB < 0) {
        throw new Error("agent import broker returned an invalid GitHub repository size");
      }
      return value.sizeKiB;
    },
  };
}

export function agentImportBrokerBaseUrlFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  return brokerBaseUrlFromEnv(env);
}
