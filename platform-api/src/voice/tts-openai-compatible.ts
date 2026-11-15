import {
  Int16Resampler,
  WavStreamParser,
  decodePcmToMonoInt16,
  int16ToBuffer,
  type PcmFormat,
} from "./audio-format.js";
import type { VoiceTtsConfig } from "./config.js";

export const TTS_OUTPUT_SAMPLE_RATE = 24_000;
export const TTS_MAX_INPUT_CHARS = 2_000;
const TTS_HEADER_TIMEOUT_MS = 15_000;
const TTS_MAX_ERROR_BODY = 400;
const TTS_MAX_ENVELOPE_BYTES = 32 * 1024 * 1024;
const SSE_AUDIO_DELTA = "speech.audio.delta";
const SSE_AUDIO_DONE = "speech.audio.done";

export interface TtsRequest {
  text: string;
  voice?: string;
  speed?: number;
}

export interface TtsDeps {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export class TtsUpstreamError extends Error {
  override readonly name = "TtsUpstreamError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function buildTtsRequestBody(config: VoiceTtsConfig, req: TtsRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    input: req.text,
    [config.voiceParam]: req.voice?.trim() || config.voice,
    response_format: config.format,
  };
  if (config.speedParam && req.speed !== undefined && req.speed !== 1) body[config.speedParam] = req.speed;
  return { ...body, ...config.extraBody };
}

/**
 * How a provider carries the audio bytes: OpenAI-style raw audio, or Mistral's
 * JSON envelope (`{ audio_data: base64 }`) / SSE stream of `speech.audio.delta`
 * events whose `audio_data` is base64 — both of which must be unwrapped before
 * the bytes mean anything as WAV or PCM.
 */
export type SpeechTransport = "audio" | "json" | "sse";

export function classifySpeechTransport(contentType: string | null): SpeechTransport | null {
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!mime || mime.startsWith("audio/") || mime === "application/octet-stream") return "audio";
  if (mime === "application/json") return "json";
  if (mime === "text/event-stream") return "sse";
  return null;
}

/**
 * Stream synthesized speech from an OpenAI-style `/audio/speech` endpoint and
 * normalize whatever the provider emits (WAV of any supported layout, or raw PCM
 * in the configured encoding/rate, delivered raw or base64-wrapped) into PCM16LE
 * mono at TTS_OUTPUT_SAMPLE_RATE. Chunks are yielded as they arrive so first
 * audio reaches the client before the provider finishes the sentence.
 */
export async function* synthesizeSpeech(
  config: VoiceTtsConfig,
  req: TtsRequest,
  deps: TtsDeps = {},
): AsyncGenerator<Buffer, void, void> {
  const text = req.text.trim();
  if (!text) return;
  if (text.length > TTS_MAX_INPUT_CHARS) {
    throw new TtsUpstreamError(413, `speech input exceeds ${TTS_MAX_INPUT_CHARS} characters`);
  }
  const res = await requestSpeech(config, req, deps);
  const contentType = res.headers.get("content-type");
  const transport = classifySpeechTransport(contentType);
  if (!transport) throw new TtsUpstreamError(502, `speech upstream returned unexpected content-type ${contentType ?? "(none)"}`);
  yield* decodeSpeechBody(res.body, createTransportUnwrapper(transport), createChunkDecoder(config), deps.signal);
}

function* normalized(audio: Buffer[], decoder: ChunkDecoder): Generator<Buffer, void, void> {
  for (const chunk of audio) {
    const out = decoder.push(chunk);
    if (out) yield out;
  }
}

async function* decodeSpeechBody(
  body: ReadableStream<Uint8Array>,
  unwrap: TransportUnwrapper,
  decoder: ChunkDecoder,
  signal: AbortSignal | undefined,
): AsyncGenerator<Buffer, void, void> {
  const reader = body.getReader();
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      yield* normalized(unwrap.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength)), decoder);
    }
    if (!signal?.aborted) yield* normalized(unwrap.finish(), decoder);
  } finally {
    reader.releaseLock();
  }
}

async function requestSpeech(
  config: VoiceTtsConfig,
  req: TtsRequest,
  deps: TtsDeps,
): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headerTimeout = AbortSignal.timeout(TTS_HEADER_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, headerTimeout]) : headerTimeout;
  const res = await fetchImpl(config.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(buildTtsRequestBody(config, req)),
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, TTS_MAX_ERROR_BODY);
    const suffix = detail ? `: ${detail}` : "";
    throw new TtsUpstreamError(res.status, `speech upstream HTTP ${res.status}${suffix}`);
  }
  if (!res.body) throw new TtsUpstreamError(502, "speech upstream returned no body");
  return res as Response & { body: ReadableStream<Uint8Array> };
}

interface TransportUnwrapper {
  /** Audio byte chunks carried by this network chunk (possibly none yet). */
  push(chunk: Buffer): Buffer[];
  /** Audio bytes still held once the response ends. */
  finish(): Buffer[];
}

function decodeAudioData(value: unknown, where: string): Buffer {
  if (typeof value !== "string" || !value) throw new TtsUpstreamError(502, `speech upstream ${where} has no audio_data`);
  return Buffer.from(value, "base64");
}

function parseEnvelope(text: string, where: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through to the typed error */
  }
  throw new TtsUpstreamError(502, `speech upstream ${where} is not a JSON object`);
}

class BoundedText {
  private readonly parts: Buffer[] = [];
  private bytes = 0;

  append(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > TTS_MAX_ENVELOPE_BYTES) throw new TtsUpstreamError(502, "speech upstream envelope exceeds 32 MiB");
    this.parts.push(chunk);
  }

  take(): string {
    const text = Buffer.concat(this.parts.splice(0)).toString("utf8");
    this.bytes = 0;
    return text;
  }
}

function jsonUnwrapper(): TransportUnwrapper {
  const body = new BoundedText();
  return {
    push(chunk) {
      body.append(chunk);
      return [];
    },
    finish() {
      return [decodeAudioData(parseEnvelope(body.take(), "JSON body").audio_data, "JSON body")];
    },
  };
}

/** Audio bytes carried by one SSE event block (`event:`/`data:` lines), or null when it carries none. */
function sseBlockAudio(block: string): Buffer | null {
  const dataLines: string[] = [];
  let eventName = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("event:")) eventName = line.slice(6).trim();
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return null;
  const envelope = parseEnvelope(data, "event");
  const type = typeof envelope.type === "string" ? envelope.type : eventName;
  if (type === SSE_AUDIO_DONE) return null;
  if (type !== SSE_AUDIO_DELTA && envelope.audio_data === undefined) return null;
  return decodeAudioData(envelope.audio_data, `${type || "event"} event`);
}

function sseUnwrapper(): TransportUnwrapper {
  const utf8 = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const drain = (final: boolean): Buffer[] => {
    const out: Buffer[] = [];
    let cursor = 0;
    while (true) {
      const end = buffer.indexOf("\n\n", cursor);
      if (end === -1) break;
      const audio = sseBlockAudio(buffer.slice(cursor, end));
      if (audio) out.push(audio);
      cursor = end + 2;
    }
    buffer = buffer.slice(cursor);
    if (final && buffer.trim()) {
      const audio = sseBlockAudio(buffer);
      if (audio) out.push(audio);
      buffer = "";
    }
    return out;
  };
  return {
    push(chunk) {
      bytes += chunk.length;
      if (bytes > TTS_MAX_ENVELOPE_BYTES) throw new TtsUpstreamError(502, "speech upstream event stream exceeds 32 MiB");
      buffer = (buffer + utf8.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
      return drain(false);
    },
    finish() {
      buffer += utf8.decode();
      return drain(true);
    },
  };
}

function createTransportUnwrapper(transport: SpeechTransport): TransportUnwrapper {
  if (transport === "json") return jsonUnwrapper();
  if (transport === "sse") return sseUnwrapper();
  return { push: (chunk) => [chunk], finish: () => [] };
}

interface ChunkDecoder {
  /** Returns normalized PCM16 24k bytes for this audio chunk, or null when nothing is ready yet. */
  push(chunk: Buffer): Buffer | null;
}

function createChunkDecoder(config: VoiceTtsConfig): ChunkDecoder {
  let resampler: Int16Resampler | null = null;
  const normalize = (sampleBytes: Buffer, format: PcmFormat): Buffer | null => {
    resampler ??= new Int16Resampler(format.sampleRate, TTS_OUTPUT_SAMPLE_RATE);
    const out = resampler.process(decodePcmToMonoInt16(sampleBytes, format));
    return out.length > 0 ? int16ToBuffer(out) : null;
  };
  if (config.format === "wav") {
    const wav = new WavStreamParser();
    return {
      push(chunk) {
        const sampleBytes = wav.feed(chunk);
        if (!wav.format || sampleBytes.length === 0) return null;
        return normalize(sampleBytes, wav.format);
      },
    };
  }
  const rawFormat: PcmFormat = { sampleRate: config.pcmSampleRate, channels: 1, encoding: config.pcmEncoding };
  const frameBytes = config.pcmEncoding === "f32le" ? 4 : 2;
  let carry: Buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = buf.length - (buf.length % frameBytes);
      carry = buf.subarray(usable);
      const sampleBytes = buf.subarray(0, usable);
      return sampleBytes.length === 0 ? null : normalize(sampleBytes, rawFormat);
    },
  };
}
