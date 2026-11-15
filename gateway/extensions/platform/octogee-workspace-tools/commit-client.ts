import { createHmac } from "node:crypto";
import { WorkspaceToolError } from "./errors.js";

export const DEFAULT_CONTROL_URL = "http://127.0.0.1:3001";
export const COMMIT_PATH = "/internal/workspace/commit";
export const DEFAULT_COMMIT_TIMEOUT_MS = 20_000;

export interface CommitResult {
  committed: boolean;
  pushed: boolean;
  nothingToCommit: boolean;
  divertedBlobs: number;
}

/** Minimal structural shape of fetch — keeps the client testable without a real Response. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text?: () => Promise<string>;
}>;

export interface CommitClientOptions {
  controlUrl?: string;
  fetchImpl?: FetchLike;
  agentProofSecretProvider?: (agentId: string) => Promise<string | null>;
  now?: () => number;
  timeoutMs?: number;
}

export interface CommitClient {
  commit(agentId: string, slug: string, message?: string, project?: string): Promise<CommitResult>;
}

const CONTROL_ERROR = "control-error" as const;

export function createWorkspaceCommitProofSignature(
  secret: string,
  timestamp: string,
  path: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`octogee-workspace-commit-v1\n${timestamp}\n${path}\n${body}`)
    .digest("hex");
}

async function agentProofHeaders(
  agentId: string,
  body: string,
  opts: CommitClientOptions,
): Promise<Record<string, string>> {
  let secret: string | null;
  try {
    secret = await opts.agentProofSecretProvider?.(agentId) ?? null;
  } catch (error) {
    throw new WorkspaceToolError(
      CONTROL_ERROR,
      `could not read agent identity proof: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!secret) throw new WorkspaceToolError(CONTROL_ERROR, "agent identity proof is unavailable");
  const timestamp = Math.trunc((opts.now ?? Date.now)()).toString();
  return {
    "x-octogee-agent-proof-timestamp": timestamp,
    "x-octogee-agent-proof-signature": createWorkspaceCommitProofSignature(
      secret,
      timestamp,
      COMMIT_PATH,
      body,
    ),
  };
}

export function createCommitClient(opts: CommitClientOptions = {}): CommitClient {
  const base = (opts.controlUrl ?? DEFAULT_CONTROL_URL).replace(/\/$/, "");
  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  async function commit(agentId: string, slug: string, message?: string, project?: string): Promise<CommitResult> {
    const body: Record<string, unknown> = { agentId, slug };
    if (message && message.trim()) body.message = message.trim();
    if (project) body.project = project;
    const serializedBody = JSON.stringify(body);
    const proofHeaders = await agentProofHeaders(agentId, serializedBody, opts);

    let resp: Awaited<ReturnType<FetchLike>>;
    try {
      resp = await doFetch(`${base}${COMMIT_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...proofHeaders,
        },
        body: serializedBody,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new WorkspaceToolError(
        CONTROL_ERROR,
        `gateway-edge unreachable at ${base}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = await resp.json().catch(() => undefined);
    if (!resp.ok) {
      throw new WorkspaceToolError(
        CONTROL_ERROR,
        strField(parsed, "error") ?? `workspace commit failed (${resp.status})`,
        strField(parsed, "code"),
        stringArrayField(parsed, "paths"),
      );
    }

    const committed = boolField(parsed, "committed");
    const pushed = boolField(parsed, "pushed");
    const nothingToCommit = boolField(parsed, "nothingToCommit");
    const divertedBlobs = nonNegativeIntegerField(parsed, "divertedBlobs");
    if (committed === undefined || pushed === undefined || nothingToCommit === undefined || divertedBlobs === undefined) {
      throw new WorkspaceToolError("bad-response", "commit endpoint returned an incomplete response");
    }
    if (!pushed) {
      throw new WorkspaceToolError(CONTROL_ERROR, "commit did not reach the remote repository");
    }
    return {
      committed,
      pushed,
      nothingToCommit,
      divertedBlobs,
    };
  }

  return { commit };
}

function strField(source: unknown, key: string): string | undefined {
  const value = (source as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

function boolField(source: unknown, key: string): boolean | undefined {
  const value = (source as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function nonNegativeIntegerField(source: unknown, key: string): number | undefined {
  const value = (source as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function stringArrayField(source: unknown, key: string): string[] | undefined {
  const value = (source as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}
