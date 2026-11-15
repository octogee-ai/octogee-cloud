import { isTalkVoiceId, type TalkVoice, type TalkVoiceCatalog } from "@octogee/shared/types/voice";
import { bufferToInt16, encodeWav } from "./audio-format.js";
import type { VoiceRelayConfig } from "./config.js";
import { TTS_OUTPUT_SAMPLE_RATE, synthesizeSpeech } from "./tts-openai-compatible.js";

export const VOICE_CATALOG_TTL_MS = 10 * 60 * 1000;
export const VOICE_PREVIEW_NAME_MAX = 60;
export const VOICE_PREVIEW_MAX_CHARS = 160;
const DISCOVERY_TIMEOUT_MS = 8_000;
const DISCOVERY_LIMIT = 100;

export interface VoiceCatalogDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface VoiceCatalog {
  list(): Promise<TalkVoiceCatalog>;
  /** A short spoken sample in the given voice (empty = engine default), as a 24 kHz mono WAV. */
  preview(input: { voice: string; name?: string }, signal?: AbortSignal): Promise<Buffer>;
}

export class VoiceCatalogError extends Error {
  override readonly name = "VoiceCatalogError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Mistral lists voices next to speech: `…/audio/speech` → `…/audio/voices?type=preset`. */
export function discoveryUrl(ttsUrl: string): string | null {
  const url = new URL(ttsUrl);
  if (!url.pathname.endsWith("/audio/speech")) return null;
  url.pathname = url.pathname.replace(/\/audio\/speech$/, "/audio/voices");
  url.search = new URLSearchParams({ type: "preset", limit: String(DISCOVERY_LIMIT) }).toString();
  return url.toString();
}

function voiceFromProvider(item: Record<string, unknown>): TalkVoice | null {
  const id = typeof item.slug === "string" && item.slug ? item.slug : item.id;
  if (!isTalkVoiceId(id) || !id) return null;
  const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : id;
  const languages = Array.isArray(item.languages) ? item.languages.filter((l): l is string => typeof l === "string") : [];
  const tags = Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string") : [];
  return {
    id,
    name,
    ...(languages[0] ? { language: languages[0] } : {}),
    ...(typeof item.gender === "string" && item.gender ? { gender: item.gender } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

export function parseProviderVoices(body: unknown): TalkVoice[] | null {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  const items = record?.items ?? record?.data ?? record?.voices;
  if (!Array.isArray(items)) return null;
  return items
    .map((item) => (item && typeof item === "object" ? voiceFromProvider(item as Record<string, unknown>) : null))
    .filter((voice): voice is TalkVoice => voice !== null);
}

export function previewText(name: string | undefined): string {
  const clean = (name ?? "").replace(/[^\p{L}\p{N} '.-]/gu, "").trim().slice(0, VOICE_PREVIEW_NAME_MAX);
  const text = clean ? `Hi, I'm ${clean}. This is how I sound. Shall we get started?` : "Hi! This is how I sound. Shall we get started?";
  return text.slice(0, VOICE_PREVIEW_MAX_CHARS);
}

export function createVoiceCatalog(config: VoiceRelayConfig | null, deps: VoiceCatalogDeps = {}): VoiceCatalog {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? VOICE_CATALOG_TTL_MS;
  const log = deps.log ?? (() => undefined);
  let cached: { at: number; voices: TalkVoice[] } | null = null;

  const discover = async (): Promise<TalkVoice[]> => {
    if (!config) return [];
    if (config.tts.voices.length > 0) return config.tts.voices;
    if (cached && now() - cached.at < ttlMs) return cached.voices;
    const url = discoveryUrl(config.tts.url);
    if (!url) return [];
    try {
      const res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${config.tts.apiKey}` },
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (!res.ok) {
        log("voice catalog discovery refused", { url, status: res.status });
        return [];
      }
      const voices = parseProviderVoices(await res.json());
      if (!voices) {
        log("voice catalog discovery returned an unexpected shape", { url });
        return [];
      }
      cached = { at: now(), voices };
      return voices;
    } catch (err) {
      log("voice catalog discovery failed", { url, error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  };

  return {
    async list() {
      if (!config) return { configured: false, default: null, voices: [] };
      const voices = await discover();
      const configured = config.tts.voice;
      const known = voices.find((voice) => voice.id === configured);
      return { configured: true, default: known ?? { id: configured, name: configured }, voices };
    },

    async preview(input, signal) {
      if (!config) throw new VoiceCatalogError(503, "voice_not_configured");
      if (!isTalkVoiceId(input.voice)) throw new VoiceCatalogError(400, "invalid_voice");
      const parts: Buffer[] = [];
      for await (const chunk of synthesizeSpeech(
        config.tts,
        { text: previewText(input.name), ...(input.voice ? { voice: input.voice } : {}) },
        { fetchImpl, ...(signal ? { signal } : {}) },
      )) {
        parts.push(chunk);
      }
      return encodeWav(bufferToInt16(Buffer.concat(parts)), TTS_OUTPUT_SAMPLE_RATE);
    },
  };
}
