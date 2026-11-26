import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentEventSource, BrainEvent } from "./brain.js";

export const VOICE_EVENT_RELAY_PATH = "/internal/openclaw/voice/v1/events";
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_READY_TTL_MS = 30_000;

export interface OpenClawVoiceRelayEvent {
  schemaVersion: 1;
  agentId: string;
  event: BrainEvent;
}

export interface OpenClawVoiceRelayReady {
  schemaVersion: 1;
  agentId: string;
  kind: "ready";
  ts: number;
}

export interface OpenClawVoiceEventRelay {
  source(agentId: string): AgentEventSource;
  publish(input: OpenClawVoiceRelayEvent): void;
  readiness(agentId: string): { ready: boolean };
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value.length > 0 ? value : null;
}

function isLoopback(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const address = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  return address === "127.0.0.1" || address === "::1";
}

function authorized(value: string | undefined, expected: string): boolean {
  const token = value?.startsWith("Bearer ") ? value.slice("Bearer ".length) : "";
  const actual = Buffer.from(token);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function finiteTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseBrainEvent(value: unknown): BrainEvent | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  const ts = finiteTimestamp(value.ts);
  if (ts === null) return null;
  if (value.kind === "inbound") {
    const messageId = nonEmptyString(value.messageId);
    const sessionKey = nonEmptyString(value.sessionKey);
    return messageId && sessionKey ? { kind: "inbound", messageId, sessionKey, ts } : null;
  }
  if (value.kind !== "agent") return null;
  const runId = nonEmptyString(value.runId);
  const stream = nonEmptyString(value.stream);
  if (!runId || !stream || !isRecord(value.data)) return null;
  const sessionKey = value.sessionKey === undefined ? undefined : nonEmptyString(value.sessionKey);
  if (value.sessionKey !== undefined && !sessionKey) return null;
  return {
    kind: "agent",
    runId,
    stream,
    ts,
    ...(sessionKey ? { sessionKey } : {}),
    data: value.data,
  };
}

function parseRelayEvent(value: unknown): OpenClawVoiceRelayEvent | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  const agentId = nonEmptyString(value.agentId);
  const event = parseBrainEvent(value.event);
  return agentId && event ? { schemaVersion: 1, agentId, event } : null;
}

function parseReady(value: unknown): OpenClawVoiceRelayReady | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "ready") return null;
  const agentId = nonEmptyString(value.agentId);
  const ts = finiteTimestamp(value.ts);
  return agentId && ts !== null ? { schemaVersion: 1, agentId, kind: "ready", ts } : null;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += body.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(body);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

function writeJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createOpenClawVoiceEventRelay(params: {
  gatewayToken: string;
  readyTtlMs?: number;
  now?: () => number;
  log?: (message: string, fields: Record<string, unknown>) => void;
}): OpenClawVoiceEventRelay {
  const gatewayToken = params.gatewayToken.trim();
  if (!gatewayToken) throw new Error("voice relay gateway token is required");
  const readyTtlMs = params.readyTtlMs ?? DEFAULT_READY_TTL_MS;
  const now = params.now ?? Date.now;
  const log = params.log ?? (() => undefined);
  const listenersByAgent = new Map<string, Set<(event: BrainEvent) => void>>();
  const lastSeenByAgent = new Map<string, number>();

  const source = (agentId: string): AgentEventSource => ({
    subscribe(listener) {
      let listeners = listenersByAgent.get(agentId);
      if (!listeners) {
        listeners = new Set();
        listenersByAgent.set(agentId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners?.delete(listener);
        if (listeners?.size === 0) listenersByAgent.delete(agentId);
      };
    },
  });

  const publish = (input: OpenClawVoiceRelayEvent): void => {
    lastSeenByAgent.set(input.agentId, now());
    for (const listener of listenersByAgent.get(input.agentId) ?? []) {
      try {
        listener(input.event);
      } catch (error) {
        log("voice relay subscriber failed", {
          agentId: input.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  const readiness = (agentId: string): { ready: boolean } => {
    const lastSeen = lastSeenByAgent.get(agentId);
    return { ready: lastSeen !== undefined && now() - lastSeen <= readyTtlMs };
  };

  const refuse = (res: ServerResponse, status: number, error: string): void => {
    log("voice relay refused an event", { status, error });
    writeJson(res, status, { error });
  };

  const accept = (res: ServerResponse, body: unknown): void => {
    const input = parseRelayEvent(body);
    const ready = parseReady(body);
    const agentId = input?.agentId ?? ready?.agentId;
    if (!agentId) {
      refuse(res, 422, "invalid_event");
      return;
    }
    if (input) publish(input);
    if (ready) lastSeenByAgent.set(ready.agentId, now());
    writeJson(res, 202, { accepted: true, listening: (listenersByAgent.get(agentId)?.size ?? 0) > 0 });
  };

  return {
    source,
    publish,
    readiness,
    async handle(req, res) {
      if (req.method !== "POST") {
        req.resume();
        writeJson(res, 405, { error: "method_not_allowed" });
        return;
      }
      if (!isLoopback(req.socket.remoteAddress) || !authorized(req.headers.authorization, gatewayToken)) {
        req.resume();
        writeJson(res, 401, { error: "unauthorized" });
        return;
      }
      try {
        accept(res, await readJson(req));
      } catch (error) {
        const code = error instanceof Error ? error.message : "invalid_json";
        refuse(res, code === "body_too_large" ? 413 : 422, code);
      }
    },
  };
}
