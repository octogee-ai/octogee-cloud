import { WebSocket } from "ws";
import { bufferToInt16, encodeWav } from "./audio-format.js";
import type { VoiceSttConfig } from "./config.js";

export const STT_INPUT_SAMPLE_RATE = 16_000;
export const STT_MAX_UTTERANCE_BYTES = 2 * STT_INPUT_SAMPLE_RATE * 120;
const STT_CONNECT_TIMEOUT_MS = 10_000;
const STT_FINAL_TIMEOUT_MS = 6_000;
const STT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;

export interface SttSessionEvents {
  onReady?: () => void;
  /** Cumulative transcript of the utterance so far (finalized segments + live tail). */
  onPartial?: (text: string) => void;
  /** Complete transcript for the utterance; the session is finished after this. */
  onFinal?: (text: string) => void;
  onError?: (error: Error) => void;
}

export interface SttSession {
  sendAudio(pcm16le16k: Buffer): void;
  /** End of utterance: finalize and emit onFinal. */
  end(): void;
  /** Drop the utterance without a transcript. */
  abort(): void;
}

export interface SttSessionDeps {
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}

export class SttUpstreamError extends Error {
  override readonly name = "SttUpstreamError";
}

type MistralEvent = {
  type?: string;
  text?: string;
  error?: { message?: unknown; code?: number };
};

function errorDetail(event: MistralEvent): string {
  const message = event.error?.message;
  if (typeof message === "string") return message;
  if (message && typeof message === "object") return JSON.stringify(message);
  if (typeof event.error?.code === "number") return `realtime transcription error (${event.error.code})`;
  return "realtime transcription error";
}

export function mistralRealtimeUrl(config: VoiceSttConfig): string {
  const url = new URL(config.url);
  url.searchParams.set("model", config.model);
  url.searchParams.set("target_streaming_delay_ms", String(config.streamingDelayMs));
  return url.toString();
}

function joinTranscript(segments: string[], tail: string): string {
  return [...segments, tail].map((s) => s.trim()).filter(Boolean).join(" ");
}

/** Text still owed at `transcription.done`: the live tail after segments, else the done text. */
function doneRemainder(segments: string[], tail: string, doneText: string | undefined): string {
  if (segments.length) return tail;
  return doneText?.trim() ? doneText : tail;
}

function createMistralRealtimeSession(
  config: VoiceSttConfig,
  events: SttSessionEvents,
  deps: SttSessionDeps,
): SttSession {
  const WebSocketImpl = deps.WebSocketImpl ?? WebSocket;
  const setTimer = deps.setTimeoutImpl ?? setTimeout;
  const clearTimer = deps.clearTimeoutImpl ?? clearTimeout;
  const socket = new WebSocketImpl(mistralRealtimeUrl(config), {
    headers: { authorization: `Bearer ${config.apiKey}` },
  });

  const segments: string[] = [];
  let tail = "";
  let ready = false;
  let finished = false;
  let ending = false;
  let queued: Buffer[] = [];
  let queuedBytes = 0;
  let finalTimer: ReturnType<typeof setTimeout> | null = null;

  const connectTimer = setTimer(() => fail(new SttUpstreamError("realtime transcription connect timeout")), STT_CONNECT_TIMEOUT_MS);

  const finish = (text: string) => {
    if (finished) return;
    finished = true;
    clearTimer(connectTimer);
    if (finalTimer) clearTimer(finalTimer);
    events.onFinal?.(text);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };

  const fail = (error: Error) => {
    if (finished) return;
    finished = true;
    clearTimer(connectTimer);
    if (finalTimer) clearTimer(finalTimer);
    events.onError?.(error);
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };

  const sendJson = (payload: Record<string, unknown>) => {
    if (socket.readyState !== WebSocketImpl.OPEN) return;
    socket.send(JSON.stringify(payload));
  };

  const onSessionCreated = () => {
    sendJson({
      type: "session.update",
      session: {
        audio_format: { encoding: "pcm_s16le", sample_rate: STT_INPUT_SAMPLE_RATE },
        target_streaming_delay_ms: config.streamingDelayMs,
        ...(config.language ? { language: config.language } : {}),
      },
    });
    ready = true;
    clearTimer(connectTimer);
    for (const chunk of queued) sendJson({ type: "input_audio.append", audio: chunk.toString("base64") });
    queued = [];
    queuedBytes = 0;
    events.onReady?.();
    if (ending) sendEnd();
  };

  const onDelta = (text: string | undefined) => {
    if (!text) return;
    tail += text;
    events.onPartial?.(joinTranscript(segments, tail));
  };

  const onSegment = (text: string | undefined) => {
    if (!text?.trim()) return;
    segments.push(text);
    tail = "";
    events.onPartial?.(joinTranscript(segments, tail));
  };

  const onDone = (text: string | undefined) => {
    finish(joinTranscript(segments, doneRemainder(segments, tail, text)));
  };

  socket.on("message", (data) => {
    if (finished) return;
    let event: MistralEvent;
    try {
      event = JSON.parse(data.toString()) as MistralEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "session.created":
        onSessionCreated();
        return;
      case "transcription.text.delta":
        onDelta(event.text);
        return;
      case "transcription.segment":
        onSegment(event.text);
        return;
      case "transcription.done":
        onDone(event.text);
        return;
      case "error":
        fail(new SttUpstreamError(errorDetail(event)));
        return;
      default:
        return;
    }
  });

  socket.on("error", (err) => fail(err instanceof Error ? err : new SttUpstreamError(String(err))));
  socket.on("close", () => {
    if (finished) return;
    if (ending) finish(joinTranscript(segments, tail));
    else fail(new SttUpstreamError("realtime transcription socket closed"));
  });

  const sendEnd = () => {
    sendJson({ type: "input_audio.flush" });
    sendJson({ type: "input_audio.end" });
    finalTimer = setTimer(() => finish(joinTranscript(segments, tail)), STT_FINAL_TIMEOUT_MS);
  };

  return {
    sendAudio(pcm) {
      if (finished || ending) return;
      if (!ready) {
        queuedBytes += pcm.length;
        if (queuedBytes > STT_MAX_QUEUED_BYTES) {
          fail(new SttUpstreamError("realtime transcription queue overflow before ready"));
          return;
        }
        queued.push(pcm);
        return;
      }
      sendJson({ type: "input_audio.append", audio: pcm.toString("base64") });
    },
    end() {
      if (finished || ending) return;
      ending = true;
      if (ready) sendEnd();
    },
    abort() {
      if (finished) return;
      finished = true;
      clearTimer(connectTimer);
      if (finalTimer) clearTimer(finalTimer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    },
  };
}

function createBatchSession(
  config: VoiceSttConfig,
  events: SttSessionEvents,
  deps: SttSessionDeps,
): SttSession {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const chunks: Buffer[] = [];
  let bytes = 0;
  let finished = false;
  let aborted = false;
  queueMicrotask(() => {
    if (!aborted) events.onReady?.();
  });

  const transcribe = async () => {
    const samples = bufferToInt16(Buffer.concat(chunks));
    const wav = encodeWav(samples, STT_INPUT_SAMPLE_RATE);
    const form = new FormData();
    form.set("model", config.model);
    if (config.language) form.set("language", config.language);
    form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "utterance.wav");
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers: { authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(STT_CONNECT_TIMEOUT_MS + STT_FINAL_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      const suffix = detail ? `: ${detail}` : "";
      throw new SttUpstreamError(`transcription upstream HTTP ${res.status}${suffix}`);
    }
    const body = (await res.json()) as { text?: unknown };
    return typeof body.text === "string" ? body.text.trim() : "";
  };

  return {
    sendAudio(pcm) {
      if (finished) return;
      bytes += pcm.length;
      if (bytes > STT_MAX_UTTERANCE_BYTES) {
        finished = true;
        events.onError?.(new SttUpstreamError("utterance exceeds the transcription size limit"));
        return;
      }
      chunks.push(pcm);
    },
    end() {
      if (finished) return;
      finished = true;
      if (bytes === 0) {
        events.onFinal?.("");
        return;
      }
      transcribe().then(
        (text) => events.onFinal?.(text),
        (err) => events.onError?.(err instanceof Error ? err : new SttUpstreamError(String(err))),
      );
    },
    abort() {
      finished = true;
      aborted = true;
    },
  };
}

/** One session = one utterance. Audio in, `end()` to finalize, `onFinal` out. */
export function createSttSession(
  config: VoiceSttConfig,
  events: SttSessionEvents,
  deps: SttSessionDeps = {},
): SttSession {
  return config.provider === "mistral-realtime"
    ? createMistralRealtimeSession(config, events, deps)
    : createBatchSession(config, events, deps);
}
