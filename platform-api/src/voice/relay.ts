import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Router, type Request, type Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { describeVoiceCapabilities, describeVoiceEngines, type VoiceRelayConfig } from "./config.js";
import { createSttSession, type SttSession, type SttSessionDeps } from "./stt-session.js";
import { TTS_MAX_INPUT_CHARS, TTS_OUTPUT_SAMPLE_RATE, TtsUpstreamError, synthesizeSpeech } from "./tts-openai-compatible.js";

export const VOICE_RELAY_STT_PATH = "/internal/voice/stt";
export const VOICE_RELAY_MAX_STT_SESSIONS_PER_GATEWAY = 4;
export const VOICE_RELAY_MAX_TTS_PER_GATEWAY = 8;
const STT_MAX_FRAME_BYTES = 64 * 1024;
const STT_MAX_CONTROL_BYTES = 1024;
const RELAY_URL_BASE = "https://relay.local";

export type VoiceRelayUpgradeAuth =
  | { ok: true; gatewayId: string }
  | { ok: false; status: 401 | 403 | 503 };

export interface VoiceRelayDeps {
  config: VoiceRelayConfig | null;
  nativeOpenAi?: boolean;
  fetchImpl?: typeof fetch;
  sttDeps?: SttSessionDeps;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export type VoiceRelaySttClientMessage = { type: "end" } | { type: "abort" };
export type VoiceRelaySttServerMessage =
  | { type: "ready"; engine: string }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string };

type RelayLog = (message: string, fields?: Record<string, unknown>) => void;

class GatewayConcurrency {
  private readonly counts = new Map<string, number>();

  constructor(private readonly limit: number) {}

  acquire(gatewayId: string): (() => void) | null {
    const current = this.counts.get(gatewayId) ?? 0;
    if (current >= this.limit) return null;
    this.counts.set(gatewayId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const now = this.counts.get(gatewayId) ?? 1;
      if (now <= 1) this.counts.delete(gatewayId);
      else this.counts.set(gatewayId, now - 1);
    };
  }

  active(gatewayId: string): number {
    return this.counts.get(gatewayId) ?? 0;
  }
}

function claimedGatewayIds(req: Request): string[] {
  const fromBody = (req.body as { gatewayId?: unknown } | undefined)?.gatewayId;
  const fromQuery = req.query?.gatewayId;
  return [fromBody, fromQuery].filter((v): v is string => typeof v === "string" && v.length > 0);
}

function boundGatewayId(req: Request, res: Response): string | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  if (claimedGatewayIds(req).some((claimed) => claimed !== bound.gatewayId)) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return bound.gatewayId;
}

interface TtsBody {
  text: string;
  voice?: string;
  speed?: number;
}

function parseTtsBody(raw: unknown): { ok: true; body: TtsBody } | { ok: false; status: number; error: string } {
  const body = (raw ?? {}) as { text?: unknown; voice?: unknown; speed?: unknown };
  if (typeof body.text !== "string" || !body.text.trim()) return { ok: false, status: 400, error: "text required" };
  if (body.text.length > TTS_MAX_INPUT_CHARS) {
    return { ok: false, status: 413, error: `text exceeds ${TTS_MAX_INPUT_CHARS} characters` };
  }
  return {
    ok: true,
    body: {
      text: body.text,
      ...(typeof body.voice === "string" && body.voice.trim() ? { voice: body.voice.trim() } : {}),
      ...(typeof body.speed === "number" && Number.isFinite(body.speed) ? { speed: body.speed } : {}),
    },
  };
}

function writePcmHeaders(res: Response): void {
  res.status(200);
  res.setHeader("content-type", "audio/pcm");
  res.setHeader("x-voice-sample-rate", String(TTS_OUTPUT_SAMPLE_RATE));
  res.setHeader("x-voice-encoding", "s16le");
  res.setHeader("cache-control", "no-store");
}

/** Resolves on drain, or as soon as the client is gone — a destroyed response never drains. */
function waitForDrain(res: Response, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const settle = () => {
      res.off("drain", settle);
      res.off("close", settle);
      signal.removeEventListener("abort", settle);
      resolve();
    };
    res.once("drain", settle);
    res.once("close", settle);
    signal.addEventListener("abort", settle, { once: true });
  });
}

async function pipePcm(res: Response, stream: AsyncIterable<Buffer>, signal: AbortSignal): Promise<void> {
  let headersSent = false;
  for await (const chunk of stream) {
    if (signal.aborted) break;
    if (!headersSent) {
      headersSent = true;
      writePcmHeaders(res);
      res.flushHeaders();
    }
    if (!res.write(chunk)) await waitForDrain(res, signal);
    if (signal.aborted) break;
  }
  if (!headersSent) writePcmHeaders(res);
  res.end();
}

function respondTtsFailure(res: Response, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = err instanceof TtsUpstreamError && err.status === 413 ? 413 : 502;
  res.status(status).json({ error: err instanceof Error ? err.message : "speech synthesis failed" });
}

export function createVoiceRelayRoutes(deps: VoiceRelayDeps): Router {
  const router = Router();
  const ttsSlots = new GatewayConcurrency(VOICE_RELAY_MAX_TTS_PER_GATEWAY);
  const log: RelayLog = deps.log ?? (() => undefined);

  router.get("/status", (req, res) => {
    if (!boundGatewayId(req, res)) return;
    res.json(
      deps.config
        ? { configured: true, engines: describeVoiceEngines(deps.config), capabilities: describeVoiceCapabilities(deps.config), ...(deps.nativeOpenAi ? { nativeOpenAi: true } : {}) }
        : { configured: false, ...(deps.nativeOpenAi ? { nativeOpenAi: true } : {}) },
    );
  });

  router.post("/tts", async (req, res) => {
    const gatewayId = boundGatewayId(req, res);
    if (!gatewayId) return;
    if (!deps.config) {
      res.status(503).json({ error: "voice_not_configured" });
      return;
    }
    const parsed = parseTtsBody(req.body);
    if (!parsed.ok) {
      res.status(parsed.status).json({ error: parsed.error });
      return;
    }
    const release = ttsSlots.acquire(gatewayId);
    if (!release) {
      res.status(429).json({ error: "too_many_tts_requests" });
      return;
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      const stream = synthesizeSpeech(deps.config.tts, parsed.body, { fetchImpl: deps.fetchImpl, signal: abort.signal });
      await pipePcm(res, stream, abort.signal);
    } catch (err) {
      log("voice relay tts failed", { gatewayId, error: err instanceof Error ? err.message : String(err) });
      respondTtsFailure(res, err);
    } finally {
      release();
    }
  });

  return router;
}

export interface VoiceRelayUpgradeDeps extends VoiceRelayDeps {
  authorize: (req: IncomingMessage) => Promise<VoiceRelayUpgradeAuth>;
}

function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function rawDataToBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function parseSttControl(buf: Buffer): VoiceRelaySttClientMessage | null {
  if (buf.length > STT_MAX_CONTROL_BYTES) return null;
  try {
    const parsed = JSON.parse(buf.toString("utf8")) as { type?: unknown };
    return parsed.type === "end" || parsed.type === "abort" ? { type: parsed.type } : null;
  } catch {
    return null;
  }
}

/** Bridges one accepted relay socket to one provider STT session for one utterance. */
function attachSttBridge(input: {
  client: WebSocket;
  config: VoiceRelayConfig;
  gatewayId: string;
  release: () => void;
  sttDeps: SttSessionDeps;
  log: RelayLog;
}): void {
  const { client, config, gatewayId, release, sttDeps, log } = input;
  const send = (message: VoiceRelaySttServerMessage) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
  };
  let closed = false;
  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    release();
    try {
      client.close(code, reason);
    } catch {
      /* already closed */
    }
  };

  let session: SttSession;
  try {
    session = createSttSession(
      config.stt,
      {
        onReady: () => send({ type: "ready", engine: describeVoiceEngines(config).stt }),
        onPartial: (text) => send({ type: "partial", text }),
        onFinal: (text) => {
          send({ type: "final", text });
          finish(1000, "final");
        },
        onError: (error) => {
          log("voice relay stt failed", { gatewayId, error: error.message });
          send({ type: "error", message: error.message });
          finish(1011, "stt-error");
        },
      },
      sttDeps,
    );
  } catch (err) {
    log("voice relay stt session create failed", { gatewayId, error: err instanceof Error ? err.message : String(err) });
    send({ type: "error", message: "transcription session unavailable" });
    finish(1011, "stt-unavailable");
    return;
  }

  const onAudio = (buf: Buffer) => {
    if (buf.length > STT_MAX_FRAME_BYTES) {
      send({ type: "error", message: "audio frame too large" });
      session.abort();
      finish(1009, "frame-too-large");
      return;
    }
    session.sendAudio(buf);
  };
  const onControl = (buf: Buffer) => {
    const control = parseSttControl(buf);
    if (!control) return;
    if (control.type === "end") {
      session.end();
      return;
    }
    session.abort();
    finish(1000, "aborted");
  };

  client.on("message", (data, isBinary) => {
    if (closed) return;
    const buf = rawDataToBuffer(data);
    if (isBinary) onAudio(buf);
    else onControl(buf);
  });
  client.on("close", () => {
    if (closed) return;
    session.abort();
    closed = true;
    release();
  });
  client.on("error", () => {
    session.abort();
    finish(1011, "client-error");
  });
}

/**
 * WebSocket half of the relay: `/internal/voice/stt` bridges one utterance from a
 * gateway-edge Talk engine (binary PCM16 16 kHz frames + `{type:"end"}`) to the
 * configured streaming transcription provider and streams `partial`/`final` back.
 * Returns true when the upgrade was for this path (handled or refused).
 */
export function createVoiceRelayUpgradeHandler(deps: VoiceRelayUpgradeDeps) {
  const wss = new WebSocketServer({ noServer: true });
  const sttSlots = new GatewayConcurrency(VOICE_RELAY_MAX_STT_SESSIONS_PER_GATEWAY);
  const log: RelayLog = deps.log ?? (() => undefined);
  const sttDeps: SttSessionDeps = { fetchImpl: deps.fetchImpl, ...deps.sttDeps };

  const admit = async (req: IncomingMessage, socket: Duplex): Promise<{ gatewayId: string; release: () => void } | null> => {
    const auth = await deps.authorize(req).catch((): VoiceRelayUpgradeAuth => ({ ok: false, status: 503 }));
    if (!auth.ok) {
      refuseUpgrade(socket, auth.status, auth.status === 503 ? "Service Unavailable" : "Forbidden");
      return null;
    }
    if (!deps.config) {
      refuseUpgrade(socket, 503, "Voice Not Configured");
      return null;
    }
    const release = sttSlots.acquire(auth.gatewayId);
    if (!release) {
      refuseUpgrade(socket, 429, "Too Many Sessions");
      return null;
    }
    return { gatewayId: auth.gatewayId, release };
  };

  return (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    const pathname = new URL(req.url ?? "/", RELAY_URL_BASE).pathname;
    if (pathname !== VOICE_RELAY_STT_PATH) return false;
    void admit(req, socket).then((admitted) => {
      if (!admitted || !deps.config) return;
      const config = deps.config;
      wss.handleUpgrade(req, socket, head, (client) => {
        attachSttBridge({ client, config, gatewayId: admitted.gatewayId, release: admitted.release, sttDeps, log });
      });
    });
    return true;
  };
}
