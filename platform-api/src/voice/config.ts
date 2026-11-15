import { isTalkVoiceId, type TalkVoice } from "@octogee/shared/types/voice";

export type VoiceSttProvider = "mistral-realtime" | "openai-compatible";
export type VoiceTtsFormat = "wav" | "pcm";
export type VoicePcmEncoding = "s16le" | "f32le";

export interface VoiceSttConfig {
  provider: VoiceSttProvider;
  url: string;
  model: string;
  apiKey: string;
  language?: string;
  streamingDelayMs: number;
}

export interface VoiceTtsConfig {
  url: string;
  model: string;
  apiKey: string;
  voice: string;
  voiceParam: string;
  /** Request field for playback speed; null when the engine has no speed control (Mistral). */
  speedParam: string | null;
  format: VoiceTtsFormat;
  pcmSampleRate: number;
  pcmEncoding: VoicePcmEncoding;
  extraBody: Record<string, unknown>;
  /** Operator-declared voice catalog (VOICE_TTS_VOICES); when set, no provider discovery runs. */
  voices: TalkVoice[];
}

export interface VoiceRelayConfig {
  stt: VoiceSttConfig;
  tts: VoiceTtsConfig;
}

export const VOICE_STT_DEFAULTS: Record<VoiceSttProvider, { url: string; model: string }> = {
  "mistral-realtime": {
    url: "wss://api.mistral.ai/v1/audio/transcriptions/realtime",
    model: "voxtral-mini-transcribe-realtime-2602",
  },
  "openai-compatible": {
    url: "https://openrouter.ai/api/v1/audio/transcriptions",
    model: "mistralai/voxtral-mini-transcribe-2602",
  },
};

export const VOICE_STT_DEFAULT_DELAY_MS = 480;
export const VOICE_TTS_DEFAULT_PCM_SAMPLE_RATE = 24_000;

export class VoiceConfigError extends Error {
  override readonly name = "VoiceConfigError";
}

type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function required(env: Env, key: string): string {
  const value = read(env, key);
  if (!value) throw new VoiceConfigError(`${key} is required when voice relay is enabled`);
  return value;
}

function positiveInteger(env: Env, key: string, fallback: number): number {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VoiceConfigError(`${key} must be a positive integer`);
  }
  return value;
}

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = read(env, key) ?? fallback;
  if (!allowed.includes(raw as T)) {
    throw new VoiceConfigError(`${key} must be one of ${allowed.join(", ")}`);
  }
  return raw as T;
}

function httpsUrl(value: string, key: string, protocols: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new VoiceConfigError(`${key} must be an absolute URL`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw new VoiceConfigError(`${key} must use ${protocols.join(" or ")}`);
  }
  return parsed.toString();
}

function extraBody(env: Env, key: string): Record<string, unknown> {
  const raw = read(env, key);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VoiceConfigError(`${key} must be a JSON object`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VoiceConfigError(`${key} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function voiceCatalog(env: Env, key: string): TalkVoice[] {
  const raw = read(env, key);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VoiceConfigError(`${key} must be a JSON array of { id, name, language?, gender? }`);
  }
  if (!Array.isArray(parsed)) throw new VoiceConfigError(`${key} must be a JSON array of { id, name, language?, gender? }`);
  return parsed.map((entry, index) => {
    const item = entry as { id?: unknown; name?: unknown; language?: unknown; gender?: unknown } | null;
    if (!item || typeof item !== "object" || !isTalkVoiceId(item.id) || !item.id || typeof item.name !== "string" || !item.name.trim()) {
      throw new VoiceConfigError(`${key}[${index}] needs a valid id and a name`);
    }
    return {
      id: item.id,
      name: item.name.trim(),
      ...(typeof item.language === "string" && item.language ? { language: item.language } : {}),
      ...(typeof item.gender === "string" && item.gender ? { gender: item.gender } : {}),
    };
  });
}

/**
 * Voice relay is enabled when either VOICE_STT_URL/VOICE_STT_PROVIDER or VOICE_TTS_URL is
 * set. A half-configured relay is a boot error, not a silent no-op — the Talk engine
 * needs both halves and a wrong default here would surface as a mystery mid-conversation.
 */
export function parseVoiceRelayConfig(env: Env = process.env): VoiceRelayConfig | null {
  const enabled = Boolean(
    read(env, "VOICE_STT_PROVIDER") || read(env, "VOICE_STT_URL") || read(env, "VOICE_TTS_URL"),
  );
  if (!enabled) return null;

  const provider = oneOf<VoiceSttProvider>(
    env,
    "VOICE_STT_PROVIDER",
    ["mistral-realtime", "openai-compatible"],
    "mistral-realtime",
  );
  const sttDefaults = VOICE_STT_DEFAULTS[provider];
  const stt: VoiceSttConfig = {
    provider,
    url: httpsUrl(
      read(env, "VOICE_STT_URL") ?? sttDefaults.url,
      "VOICE_STT_URL",
      provider === "mistral-realtime" ? ["wss:", "ws:"] : ["https:", "http:"],
    ),
    model: read(env, "VOICE_STT_MODEL") ?? sttDefaults.model,
    apiKey: required(env, "VOICE_STT_API_KEY"),
    streamingDelayMs: positiveInteger(env, "VOICE_STT_DELAY_MS", VOICE_STT_DEFAULT_DELAY_MS),
    ...(read(env, "VOICE_STT_LANGUAGE") ? { language: read(env, "VOICE_STT_LANGUAGE") } : {}),
  };

  const tts: VoiceTtsConfig = {
    url: httpsUrl(required(env, "VOICE_TTS_URL"), "VOICE_TTS_URL", ["https:", "http:"]),
    model: required(env, "VOICE_TTS_MODEL"),
    apiKey: required(env, "VOICE_TTS_API_KEY"),
    voice: required(env, "VOICE_TTS_VOICE"),
    voiceParam: read(env, "VOICE_TTS_VOICE_PARAM") ?? "voice",
    speedParam: speedParam(env, "VOICE_TTS_SPEED_PARAM"),
    format: oneOf<VoiceTtsFormat>(env, "VOICE_TTS_FORMAT", ["wav", "pcm"], "wav"),
    pcmSampleRate: positiveInteger(env, "VOICE_TTS_PCM_SAMPLE_RATE", VOICE_TTS_DEFAULT_PCM_SAMPLE_RATE),
    pcmEncoding: oneOf<VoicePcmEncoding>(env, "VOICE_TTS_PCM_ENCODING", ["s16le", "f32le"], "s16le"),
    extraBody: extraBody(env, "VOICE_TTS_EXTRA_BODY"),
    voices: voiceCatalog(env, "VOICE_TTS_VOICES"),
  };

  return { stt, tts };
}

function speedParam(env: Env, key: string): string | null {
  const value = read(env, key) ?? "speed";
  return value === "none" ? null : value;
}

export interface VoiceCapabilities {
  /** The engine can change speaking rate itself; otherwise the client paces playback. */
  speed: boolean;
}

export function describeVoiceCapabilities(config: VoiceRelayConfig): VoiceCapabilities {
  return { speed: config.tts.speedParam !== null };
}

export function describeVoiceEngines(config: VoiceRelayConfig): { stt: string; tts: string } {
  return {
    stt: `${config.stt.provider}:${config.stt.model}`,
    tts: `openai-compatible:${config.tts.model}`,
  };
}
