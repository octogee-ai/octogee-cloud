import { readFile } from "node:fs/promises";

import {
  DEFAULT_TOKEN_PATH,
  defaultBrokerUrl,
  type FetchLike,
} from "./identity-client.js";

export const SESSION_CONTEXT_PATH = "/internal/openclaw/activity/session-context";
export const DISPATCH_CONTEXT_PATH = "/internal/openclaw/activity/dispatch-context";
export const DEFAULT_SESSION_CONTEXT_TIMEOUT_MS = 2_000;

type SessionContextErrorCode =
  | "unavailable"
  | "auth-unavailable"
  | "control-error"
  | "bad-response";

export class SessionContextError extends Error {
  constructor(
    public readonly code: SessionContextErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionContextError";
  }
}

export interface SessionContext {
  authorized: true;
  purpose?: string;
}

export interface SessionContextReadInput {
  agentId: string;
  accountId: string;
  channelId: string;
  senderId?: string;
  sessionKey?: string;
}

export interface SessionContextClient {
  read(input: SessionContextReadInput): Promise<SessionContext>;
  authorizeDispatch(input: {
    agentId: string;
    accountId: string;
    conversationId: string;
    senderId: string;
    sessionKey: string;
  }): Promise<{ authorized: true }>;
}

export interface SessionContextClientOptions {
  brokerUrl?: string;
  fetchImpl?: FetchLike;
  tokenPath?: string;
  tokenProvider?: () => Promise<string | null>;
  timeoutMs?: number;
}

function responseFailureCode(status: number): SessionContextErrorCode {
  return status >= 300 && status < 500 ? "control-error" : "unavailable";
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

async function readProjectedToken(tokenPath: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export function createSessionContextClient(
  opts: SessionContextClientOptions = {},
): SessionContextClient {
  const base = stripTrailingSlashes(opts.brokerUrl || defaultBrokerUrl());
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const tokenPath =
    opts.tokenPath || process.env.OCTOGEE_API_SA_TOKEN_PATH || DEFAULT_TOKEN_PATH;
  const tokenProvider = opts.tokenProvider ?? (() => readProjectedToken(tokenPath));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SESSION_CONTEXT_TIMEOUT_MS;

  async function lookup(
    path: string,
    input: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let failureCode: SessionContextErrorCode = "unavailable";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new SessionContextError(
          failureCode,
          `session context lookup timed out after ${timeoutMs}ms`,
        ));
      }, timeoutMs);
    });
    const operation = (async (): Promise<Record<string, unknown>> => {
      const token = await tokenProvider();
      if (!token) {
        throw new SessionContextError(
          "auth-unavailable",
          `projected gateway service-account token unavailable at ${tokenPath}`,
        );
      }

      try {
        const response = await fetchImpl(`${base}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-K8s-Sa-Token": token,
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        });

        failureCode = responseFailureCode(response.status);
        let body: Record<string, unknown> | null;
        try {
          body = (await response.json()) as Record<string, unknown>;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          body = null;
        }
        if (!response.ok) {
          const message =
            typeof body?.error === "string"
              ? body.error
              : `runtime context lookup failed (${response.status})`;
          throw new SessionContextError(failureCode, message);
        }
        if (body?.authorized !== true) {
          throw new SessionContextError(
            "bad-response",
            "runtime context lookup did not positively authorize the route",
          );
        }
        return body;
      } catch (error) {
        if (error instanceof SessionContextError) throw error;
        if (controller.signal.aborted) {
          throw new SessionContextError(
            failureCode,
            `session context lookup timed out after ${timeoutMs}ms`,
          );
        }
        throw new SessionContextError(
          "unavailable",
          `runtime broker unreachable at ${base}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    })();
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  return {
    async read(input) {
      const body = await lookup(SESSION_CONTEXT_PATH, input);
      const purpose = body.purpose;
      if (purpose !== undefined && (typeof purpose !== "string" || purpose.length === 0)) {
        throw new SessionContextError(
          "bad-response",
          "session context lookup returned an invalid purpose",
        );
      }
      return purpose === undefined ? { authorized: true } : { authorized: true, purpose };
    },
    async authorizeDispatch(input) {
      const body = await lookup(DISPATCH_CONTEXT_PATH, input);
      if (Object.keys(body).length !== 1) {
        throw new SessionContextError(
          "bad-response",
          "dispatch context lookup returned unexpected fields",
        );
      }
      return { authorized: true };
    },
  };
}
