import { describe, expect, it, vi } from "vitest";
import { encodeWav } from "./audio-format.js";
import { createVoiceCatalog, discoveryUrl, previewText } from "./catalog.js";
import type { VoiceRelayConfig } from "./config.js";

const config: VoiceRelayConfig = {
  stt: { provider: "mistral-realtime", url: "wss://api.mistral.ai/v1/audio/transcriptions/realtime", model: "voxtral-mini-transcribe-realtime-2602", apiKey: "k", streamingDelayMs: 480 },
  tts: {
    url: "https://api.mistral.ai/v1/audio/speech",
    model: "voxtral-mini-tts-2603",
    apiKey: "tts-key",
    voice: "en_paul_neutral",
    voiceParam: "voice_id",
    speedParam: null,
    format: "wav",
    pcmSampleRate: 24_000,
    pcmEncoding: "s16le",
    extraBody: { stream: true },
    voices: [],
  },
};

/** The shape Mistral's `GET /v1/audio/voices?type=preset` returns (observed 2026-08-16). */
const mistralVoices = {
  items: [
    { name: "Paul - Neutral", slug: "en_paul_neutral", languages: ["en_us"], gender: "male", age: 30, tags: ["relaxed", "balanced", "neutral"], id: "c69964a6-ab8b-4f8a-9465-ec0925096ec8" },
    { name: "Jane - Confident", slug: "gb_jane_confident", languages: ["en_gb"], gender: "female", age: 30, tags: ["assured", "poised", "confident"], id: "0d3f0f2e-1111-4a2b-9c3d-abcdefabcdef" },
    { name: "weird", slug: "bad id\n", languages: [], id: "x" },
  ],
  page: 1,
  page_size: 10,
  total: 3,
  total_pages: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("discoveryUrl", () => {
  it("swaps the speech path for the voices listing and leaves other endpoints alone", () => {
    expect(discoveryUrl("https://api.mistral.ai/v1/audio/speech")).toBe("https://api.mistral.ai/v1/audio/voices?type=preset&limit=100");
    expect(discoveryUrl("https://openrouter.ai/api/v1/audio/speech")).toBe("https://openrouter.ai/api/v1/audio/voices?type=preset&limit=100");
    expect(discoveryUrl("https://tts.example/synthesize")).toBeNull();
  });
});

describe("createVoiceCatalog", () => {
  it("reports unconfigured without touching the network", async () => {
    const fetchImpl = vi.fn();
    expect(await createVoiceCatalog(null, { fetchImpl }).list()).toEqual({ configured: false, default: null, voices: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(createVoiceCatalog(null, { fetchImpl }).preview({ voice: "" })).rejects.toMatchObject({ status: 503 });
  });

  it("discovers Mistral preset voices with the TTS key, keys them by slug, resolves the default, and caches within the TTL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(mistralVoices));
    let clock = 1_000;
    const catalog = createVoiceCatalog(config, { fetchImpl, now: () => clock, ttlMs: 60_000 });
    const first = await catalog.list();
    expect(first).toEqual({
      configured: true,
      default: { id: "en_paul_neutral", name: "Paul - Neutral", language: "en_us", gender: "male", tags: ["relaxed", "balanced", "neutral"] },
      voices: [
        { id: "en_paul_neutral", name: "Paul - Neutral", language: "en_us", gender: "male", tags: ["relaxed", "balanced", "neutral"] },
        { id: "gb_jane_confident", name: "Jane - Confident", language: "en_gb", gender: "female", tags: ["assured", "poised", "confident"] },
      ],
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/audio/voices?type=preset&limit=100");
    expect(init.headers).toMatchObject({ authorization: "Bearer tts-key" });

    clock += 30_000;
    await catalog.list();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    clock += 31_000;
    await catalog.list();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("names an unknown default and degrades to an empty list (logged) when discovery is refused, malformed, or has no listing endpoint", async () => {
    const log = vi.fn();
    const refused = createVoiceCatalog({ ...config, tts: { ...config.tts, voice: "custom-123" } }, { fetchImpl: vi.fn(async () => jsonResponse({ detail: "no" }, 404)), log });
    expect(await refused.list()).toEqual({ configured: true, default: { id: "custom-123", name: "custom-123" }, voices: [] });
    expect(log).toHaveBeenCalledWith("voice catalog discovery refused", expect.objectContaining({ status: 404 }));

    const malformed = createVoiceCatalog(config, { fetchImpl: vi.fn(async () => jsonResponse({ hello: "world" })), log });
    expect((await malformed.list()).voices).toEqual([]);

    const noListing = createVoiceCatalog({ ...config, tts: { ...config.tts, url: "https://tts.example/synthesize" } }, { fetchImpl: vi.fn(), log });
    expect((await noListing.list()).voices).toEqual([]);
  });

  it("an operator-declared catalog wins over discovery", async () => {
    const fetchImpl = vi.fn();
    const declared = createVoiceCatalog(
      { ...config, tts: { ...config.tts, voice: "af_heart", voices: [{ id: "af_heart", name: "Heart", language: "en_us" }, { id: "am_adam", name: "Adam" }] } },
      { fetchImpl },
    );
    expect(await declared.list()).toEqual({
      configured: true,
      default: { id: "af_heart", name: "Heart", language: "en_us" },
      voices: [{ id: "af_heart", name: "Heart", language: "en_us" }, { id: "am_adam", name: "Adam" }],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preview speaks a short greeting in the chosen voice and returns a 24 kHz WAV", async () => {
    const samples = Int16Array.from({ length: 2400 }, (_, i) => i % 300);
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(encodeWav(samples, 24_000)), { status: 200, headers: { "content-type": "audio/wav" } }));
    const catalog = createVoiceCatalog(config, { fetchImpl });
    const wav = await catalog.preview({ voice: "gb_jane_confident", name: "Octo <b>!" });
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.length).toBe(44 + samples.length * 2);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toMatchObject({ voice_id: "gb_jane_confident", input: "Hi, I'm Octo b. This is how I sound. Shall we get started?" });

    await catalog.preview({ voice: "" });
    expect(JSON.parse(String((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toMatchObject({ voice_id: "en_paul_neutral", input: "Hi! This is how I sound. Shall we get started?" });
    await expect(catalog.preview({ voice: "<script>" })).rejects.toMatchObject({ status: 400 });
  });
});

describe("previewText", () => {
  it("keeps the greeting short and strips markup from the agent name", () => {
    expect(previewText(undefined)).toBe("Hi! This is how I sound. Shall we get started?");
    expect(previewText("O'Malley-Bot 2")).toBe("Hi, I'm O'Malley-Bot 2. This is how I sound. Shall we get started?");
    expect(previewText("x".repeat(200)).length).toBeLessThanOrEqual(160);
  });
});
