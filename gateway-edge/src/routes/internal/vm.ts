import { clientRequestLimit } from "@octogee/core/http/authenticated-request-limit";
import { Router, type Response } from "express";
import { requireGatewayInternalAuth } from "../../middleware/gateway-internal-auth.js";
import { logger } from "@octogee/core/http/logging";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const STYLES = new Set(["familiar", "omarchy"]);
const ACCENT = /^#[0-9a-f]{6}$/u;
const NOTE_MAX = 500;
const CONTROL_TIMEOUT_MS = 150_000;

export function resolveVmControlUrl(env: Record<string, string | undefined>): string | null {
  const raw = env.GATEWAY_COMPUTER_CONTROL_URL?.trim();
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`GATEWAY_COMPUTER_CONTROL_URL must be a bare http:// loopback origin (got ${raw})`);
  }
  return url.origin;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function styleRequest(body: unknown): { style: string; accent?: string } | null {
  const input = record(body);
  if (!input || typeof input.style !== "string" || !STYLES.has(input.style)) return null;
  if (input.accent === undefined || input.accent === null) return { style: input.style };
  if (input.style !== "familiar" || typeof input.accent !== "string" || !ACCENT.test(input.accent)) return null;
  return { style: input.style, accent: input.accent };
}

export function noteRequest(body: unknown): { note: string } | null {
  const input = record(body);
  if (!input || typeof input.note !== "string") return null;
  const note = input.note.trim();
  return note.length > 0 && note.length <= NOTE_MAX ? { note } : null;
}

export interface InternalVmRouterDeps {
  controlUrl: string | null;
  fetchImpl?: typeof fetch;
}

export function createInternalVmRouter(deps: InternalVmRouterDeps): Router {
  const router = Router();
  const fetchImpl = deps.fetchImpl ?? fetch;
  router.use(clientRequestLimit(600, true), requireGatewayInternalAuth);

  const forward = async (res: Response, path: string, body: Record<string, unknown>): Promise<void> => {
    if (!deps.controlUrl) {
      res.status(404).json({ error: "computer_unavailable" });
      return;
    }
    let upstream: globalThis.Response;
    let text: string;
    try {
      upstream = await fetchImpl(`${deps.controlUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
      });
      text = await upstream.text();
    } catch (err) {
      logger.warn("desktop control API unreachable", { path, error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ error: "computer_unreachable" });
      return;
    }
    let answer: unknown;
    try {
      answer = JSON.parse(text);
    } catch {
      answer = { error: text.slice(0, 200) };
    }
    if (!upstream.ok) logger.warn("desktop control API refused a request", { path, status: upstream.status, answer });
    res.status(upstream.status).set("cache-control", "no-store").json(answer);
  };

  router.post("/style", async (req, res) => {
    const input = styleRequest(req.body);
    if (!input) {
      res.status(400).json({ error: "invalid_style" });
      return;
    }
    await forward(res, "/style", input);
  });

  router.post("/desk/note", async (req, res) => {
    const input = noteRequest(req.body);
    if (!input) {
      res.status(400).json({ error: "invalid_note" });
      return;
    }
    await forward(res, "/desk/note", input);
  });

  return router;
}
