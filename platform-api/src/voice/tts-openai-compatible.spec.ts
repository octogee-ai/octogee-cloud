import { describe, expect, it, vi } from "vitest";
import { bufferToInt16, encodeWav, int16ToBuffer } from "./audio-format.js";
import type { VoiceTtsConfig } from "./config.js";
import { TtsUpstreamError, buildTtsRequestBody, synthesizeSpeech } from "./tts-openai-compatible.js";

const config: VoiceTtsConfig = {
  url: "https://tts.example/v1/audio/speech",
  model: "voxtral-mini-tts-2603",
  apiKey: "k",
  voice: "en_paul_neutral",
  voiceParam: "voice_id",
  speedParam: "speed",
  format: "wav",
  pcmSampleRate: 24_000,
  pcmEncoding: "s16le",
  extraBody: { stream: true },
  voices: [],
};

function streamOf(chunks: Buffer[], status = 200, contentType = "audio/wav"): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new Uint8Array(c));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": contentType } });
}

/** Mistral `POST /v1/audio/speech` with `stream: true`: SSE `speech.audio.delta` events carrying base64 audio, then `speech.audio.done`. */
function mistralSseBody(audioChunks: Buffer[]): string {
  const deltas = audioChunks.map(
    (chunk) => `event: speech.audio.delta\ndata: ${JSON.stringify({ type: "speech.audio.delta", audio_data: chunk.toString("base64") })}\n\n`,
  );
  const done = `event: speech.audio.done\ndata: ${JSON.stringify({
    type: "speech.audio.done",
    usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12, prompt_audio_seconds: null },
  })}\n\n`;
  return deltas.join("") + done;
}

async function collect(gen: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of gen) parts.push(chunk);
  return Buffer.concat(parts);
}

describe("buildTtsRequestBody", () => {
  it("uses the configured voice param name, default voice, and merges extra body", () => {
    expect(buildTtsRequestBody(config, { text: "hi" })).toEqual({
      model: "voxtral-mini-tts-2603",
      input: "hi",
      voice_id: "en_paul_neutral",
      response_format: "wav",
      stream: true,
    });
    expect(buildTtsRequestBody(config, { text: "hi", voice: "en_ada", speed: 0.9 })).toMatchObject({
      voice_id: "en_ada",
      speed: 0.9,
    });
    expect(buildTtsRequestBody(config, { text: "hi", speed: 1 })).not.toHaveProperty("speed");
  });

  it("never sends a speed field to an engine without speed control (Mistral rejects extra inputs with 422)", () => {
    const mistral: VoiceTtsConfig = { ...config, speedParam: null };
    expect(buildTtsRequestBody(mistral, { text: "hi", speed: 1.1 })).not.toHaveProperty("speed");
    expect(buildTtsRequestBody({ ...config, speedParam: "rate" }, { text: "hi", speed: 0.9 })).toMatchObject({ rate: 0.9 });
  });
});

describe("synthesizeSpeech", () => {
  it("streams WAV chunks as normalized PCM16 24k as they arrive", async () => {
    const samples = Int16Array.from({ length: 2400 }, (_, i) => (i % 100) * 100 - 5000);
    const wav = encodeWav(samples, 24_000);
    const chunks = [wav.subarray(0, 30), wav.subarray(30, 1001), wav.subarray(1001)];
    const fetchImpl = vi.fn(async () => streamOf(chunks));
    const out = await collect(synthesizeSpeech(config, { text: "Hello there." }, { fetchImpl }));
    expect(bufferToInt16(out)).toEqual(samples);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).toMatchObject({ authorization: "Bearer k" });
    expect(JSON.parse(String(init.body))).toMatchObject({ input: "Hello there.", voice_id: "en_paul_neutral" });
  });

  it("unwraps Mistral's streamed SSE envelope (base64 speech.audio.delta events) as the audio arrives", async () => {
    const samples = Int16Array.from({ length: 4800 }, (_, i) => ((i * 37) % 2000) - 1000);
    const wav = encodeWav(samples, 24_000);
    const sse = Buffer.from(mistralSseBody([wav.subarray(0, 44 + 2000), wav.subarray(44 + 2000, 44 + 6000), wav.subarray(44 + 6000)]));
    const network = [sse.subarray(0, 100), sse.subarray(100, 3000), sse.subarray(3000, 3001), sse.subarray(3001)];
    const fetchImpl = vi.fn(async () => streamOf(network, 200, "text/event-stream; charset=utf-8"));
    const chunks: Buffer[] = [];
    for await (const chunk of synthesizeSpeech(config, { text: "Hello there." }, { fetchImpl })) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(1);
    expect(bufferToInt16(Buffer.concat(chunks))).toEqual(samples);
  });

  it("unwraps Mistral's non-streamed JSON envelope ({ audio_data: base64 })", async () => {
    const samples = Int16Array.from({ length: 1200 }, (_, i) => i - 600);
    const json = Buffer.from(JSON.stringify({ audio_data: encodeWav(samples, 24_000).toString("base64") }));
    const fetchImpl = vi.fn(async () => streamOf([json.subarray(0, 50), json.subarray(50)], 200, "application/json"));
    const out = await collect(synthesizeSpeech(config, { text: "Hello there." }, { fetchImpl }));
    expect(bufferToInt16(out)).toEqual(samples);
  });

  it("refuses transports it cannot decode: unexpected content types and envelopes without audio_data", async () => {
    const html = vi.fn(async () => streamOf([Buffer.from("<html>login</html>")], 200, "text/html"));
    await expect(collect(synthesizeSpeech(config, { text: "hi" }, { fetchImpl: html }))).rejects.toMatchObject({
      name: "TtsUpstreamError",
      status: 502,
      message: expect.stringContaining("text/html"),
    });
    const noAudio = vi.fn(async () => streamOf([Buffer.from(JSON.stringify({ id: "x" }))], 200, "application/json"));
    await expect(collect(synthesizeSpeech(config, { text: "hi" }, { fetchImpl: noAudio }))).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("audio_data"),
    });
    const notJson = vi.fn(async () => streamOf([Buffer.from("event: speech.audio.delta\ndata: {nope\n\n")], 200, "text/event-stream"));
    await expect(collect(synthesizeSpeech(config, { text: "hi" }, { fetchImpl: notJson }))).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("not a JSON object"),
    });
  });

  it("resamples 48k float PCM output down to 24k int16", async () => {
    const pcmConfig: VoiceTtsConfig = { ...config, format: "pcm", pcmSampleRate: 48_000, pcmEncoding: "f32le", extraBody: {} };
    const floats = Buffer.alloc(4 * 4800);
    for (let i = 0; i < 4800; i++) floats.writeFloatLE(Math.sin(i / 20) * 0.5, i * 4);
    const fetchImpl = vi.fn(async () => streamOf([floats.subarray(0, 777), floats.subarray(777)]));
    const out = await collect(synthesizeSpeech(pcmConfig, { text: "hi" }, { fetchImpl }));
    const n = out.length / 2;
    expect(n).toBeGreaterThanOrEqual(2398);
    expect(n).toBeLessThanOrEqual(2400);
    expect(Math.max(...bufferToInt16(out))).toBeLessThanOrEqual(16384);
  });

  it("surfaces upstream HTTP errors with the status and a body snippet", async () => {
    const fetchImpl = vi.fn(async () => new Response("quota exceeded", { status: 429 }));
    await expect(collect(synthesizeSpeech(config, { text: "hi" }, { fetchImpl }))).rejects.toMatchObject({
      name: "TtsUpstreamError",
      status: 429,
      message: expect.stringContaining("quota exceeded"),
    });
  });

  it("refuses over-long input before calling upstream and yields nothing for blank text", async () => {
    const fetchImpl = vi.fn();
    await expect(collect(synthesizeSpeech(config, { text: "x".repeat(2001) }, { fetchImpl }))).rejects.toBeInstanceOf(TtsUpstreamError);
    expect(await collect(synthesizeSpeech(config, { text: "   " }, { fetchImpl }))).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stops reading when the caller aborts", async () => {
    const wav = encodeWav(Int16Array.from({ length: 24_000 }, () => 1), 24_000);
    const controller = new AbortController();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulls++;
        if (pulls === 1) ctrl.enqueue(new Uint8Array(wav.subarray(0, 44 + 4800)));
        else if (pulls === 2) {
          controller.abort();
          ctrl.enqueue(new Uint8Array(wav.subarray(44 + 4800, 44 + 9600)));
        } else ctrl.close();
      },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
    const chunks: Buffer[] = [];
    for await (const chunk of synthesizeSpeech(config, { text: "long" }, { fetchImpl, signal: controller.signal })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeLessThanOrEqual(2);
    expect(Buffer.concat(chunks).length).toBeLessThan(wav.length - 44);
  });

  it("emits pcm chunk-aligned samples across odd network reads", async () => {
    const pcmConfig: VoiceTtsConfig = { ...config, format: "pcm", extraBody: {} };
    const samples = Int16Array.from([1, 2, 3, 4, 5, 6, 7]);
    const raw = int16ToBuffer(samples);
    const fetchImpl = vi.fn(async () => streamOf([raw.subarray(0, 3), raw.subarray(3, 8), raw.subarray(8)]));
    const out = await collect(synthesizeSpeech(pcmConfig, { text: "hi" }, { fetchImpl }));
    expect(bufferToInt16(out)).toEqual(samples);
  });
});
