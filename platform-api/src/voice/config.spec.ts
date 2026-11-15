import { describe, expect, it } from "vitest";
import { VoiceConfigError, describeVoiceCapabilities, describeVoiceEngines, parseVoiceRelayConfig } from "./config.js";

const full = {
  VOICE_STT_PROVIDER: "mistral-realtime",
  VOICE_STT_API_KEY: "stt",
  VOICE_TTS_URL: "https://api.mistral.ai/v1/audio/speech",
  VOICE_TTS_MODEL: "voxtral-mini-tts-2603",
  VOICE_TTS_VOICE: "en_paul_neutral",
  VOICE_TTS_VOICE_PARAM: "voice_id",
  VOICE_TTS_API_KEY: "tts",
  VOICE_TTS_EXTRA_BODY: '{"stream":true}',
};

describe("parseVoiceRelayConfig", () => {
  it("is null when nothing voice-related is set", () => {
    expect(parseVoiceRelayConfig({})).toBeNull();
    expect(parseVoiceRelayConfig({ MISTRAL_API_KEY: "x" })).toBeNull();
  });

  it("fills provider defaults and parses extras", () => {
    const cfg = parseVoiceRelayConfig(full)!;
    expect(cfg.stt).toEqual({
      provider: "mistral-realtime",
      url: "wss://api.mistral.ai/v1/audio/transcriptions/realtime",
      model: "voxtral-mini-transcribe-realtime-2602",
      apiKey: "stt",
      streamingDelayMs: 480,
    });
    expect(cfg.tts).toEqual({
      url: "https://api.mistral.ai/v1/audio/speech",
      model: "voxtral-mini-tts-2603",
      apiKey: "tts",
      voice: "en_paul_neutral",
      voiceParam: "voice_id",
      speedParam: "speed",
      format: "wav",
      pcmSampleRate: 24_000,
      pcmEncoding: "s16le",
      extraBody: { stream: true },
      voices: [],
    });
    expect(describeVoiceCapabilities(cfg)).toEqual({ speed: true });
    const mistral = parseVoiceRelayConfig({ ...full, VOICE_TTS_SPEED_PARAM: "none" })!;
    expect(mistral.tts.speedParam).toBeNull();
    expect(describeVoiceCapabilities(mistral)).toEqual({ speed: false });
    expect(describeVoiceEngines(cfg)).toEqual({
      stt: "mistral-realtime:voxtral-mini-transcribe-realtime-2602",
      tts: "openai-compatible:voxtral-mini-tts-2603",
    });
  });

  it("supports the OpenAI-compatible batch STT provider with an OpenRouter-style URL", () => {
    const cfg = parseVoiceRelayConfig({
      ...full,
      VOICE_STT_PROVIDER: "openai-compatible",
      VOICE_STT_URL: "https://openrouter.ai/api/v1/audio/transcriptions",
      VOICE_STT_MODEL: "nvidia/parakeet-tdt-0.6b-v3",
      VOICE_STT_LANGUAGE: "en",
      VOICE_TTS_FORMAT: "pcm",
      VOICE_TTS_PCM_SAMPLE_RATE: "22050",
      VOICE_TTS_PCM_ENCODING: "f32le",
    })!;
    expect(cfg.stt).toMatchObject({ provider: "openai-compatible", model: "nvidia/parakeet-tdt-0.6b-v3", language: "en" });
    expect(cfg.tts).toMatchObject({ format: "pcm", pcmSampleRate: 22050, pcmEncoding: "f32le" });
  });

  it("accepts an operator-declared voice catalog and rejects malformed entries", () => {
    const voices = JSON.stringify([
      { id: "af_heart", name: "Heart", language: "en_us", gender: "female" },
      { id: "am_adam", name: "Adam" },
    ]);
    expect(parseVoiceRelayConfig({ ...full, VOICE_TTS_VOICES: voices })!.tts.voices).toEqual([
      { id: "af_heart", name: "Heart", language: "en_us", gender: "female" },
      { id: "am_adam", name: "Adam" },
    ]);
    expect(() => parseVoiceRelayConfig({ ...full, VOICE_TTS_VOICES: "{}" })).toThrow(VoiceConfigError);
    expect(() => parseVoiceRelayConfig({ ...full, VOICE_TTS_VOICES: JSON.stringify([{ id: "bad\nid", name: "x" }]) })).toThrow(VoiceConfigError);
    expect(() => parseVoiceRelayConfig({ ...full, VOICE_TTS_VOICES: JSON.stringify([{ id: "ok" }]) })).toThrow(/needs a valid id and a name/);
  });

  it("fails loud on half-configured or malformed values", () => {
    expect(() => parseVoiceRelayConfig({ VOICE_STT_PROVIDER: "mistral-realtime" })).toThrow(VoiceConfigError);
    expect(() => parseVoiceRelayConfig({ ...full, VOICE_TTS_URL: "not a url" })).toThrow(/VOICE_TTS_URL/);
    expect(() => parseVoiceRelayConfig({ ...full, VOICE_STT_URL: "https://wrong-scheme" })).toThrow(/wss:/);
    expect(() => parseVoiceRelayConfig({ ...full, VOICE_STT_PROVIDER: "whisper-cli" })).toThrow(/VOICE_STT_PROVIDER/);
    expect(() => parseVoiceRelayConfig({ ...full, VOICE_STT_DELAY_MS: "-5" })).toThrow(/VOICE_STT_DELAY_MS/);
    expect(() => parseVoiceRelayConfig({ ...full, VOICE_TTS_EXTRA_BODY: "[1]" })).toThrow(/VOICE_TTS_EXTRA_BODY/);
    expect(() => parseVoiceRelayConfig({ ...full, VOICE_TTS_FORMAT: "mp3" })).toThrow(/VOICE_TTS_FORMAT/);
  });
});
