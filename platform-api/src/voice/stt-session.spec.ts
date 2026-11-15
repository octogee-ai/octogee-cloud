import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import type { VoiceSttConfig } from "./config.js";
import { createSttSession, mistralRealtimeUrl } from "./stt-session.js";

const realtimeConfig: VoiceSttConfig = {
  provider: "mistral-realtime",
  url: "wss://api.mistral.ai/v1/audio/transcriptions/realtime",
  model: "voxtral-mini-transcribe-realtime-2602",
  apiKey: "mistral-key",
  streamingDelayMs: 480,
};

interface FakeMistral {
  url: string;
  received: unknown[];
  headers: Record<string, string | string[] | undefined>;
  socket: () => WebSocket;
  send: (event: unknown) => void;
  close: () => Promise<void>;
}

async function fakeMistral(onConnect?: (send: (e: unknown) => void) => void): Promise<FakeMistral> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  const address = wss.address() as { port: number };
  const state: { socket: WebSocket | null; received: unknown[]; headers: FakeMistral["headers"] } = {
    socket: null,
    received: [],
    headers: {},
  };
  wss.on("connection", (socket, req) => {
    state.socket = socket;
    state.headers = req.headers;
    socket.on("message", (data) => state.received.push(JSON.parse(data.toString())));
    const send = (e: unknown) => socket.send(JSON.stringify(e));
    if (onConnect) onConnect(send);
    else send({ type: "session.created" });
  });
  return {
    url: `ws://127.0.0.1:${address.port}/v1/audio/transcriptions/realtime`,
    received: state.received,
    get headers() {
      return state.headers;
    },
    socket: () => state.socket!,
    send: (e) => state.socket!.send(JSON.stringify(e)),
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

const servers: FakeMistral[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("mistralRealtimeUrl", () => {
  it("adds model and streaming delay as query params (the OpenClaw mistral plugin's contract)", () => {
    expect(mistralRealtimeUrl(realtimeConfig)).toBe(
      "wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=voxtral-mini-transcribe-realtime-2602&target_streaming_delay_ms=480",
    );
  });
});

describe("mistral realtime STT session", () => {
  it("configures pcm16 16k and the streaming delay in session.update (the official SDK's contract), forwards audio as base64 appends, and finalizes on done", async () => {
    const server = await fakeMistral();
    servers.push(server);
    const events = { onReady: vi.fn(), onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
    const session = createSttSession({ ...realtimeConfig, url: server.url }, events);
    session.sendAudio(Buffer.from([1, 0, 2, 0]));
    await waitFor(() => events.onReady.mock.calls.length === 1);
    await waitFor(() => server.received.length >= 2);
    expect(server.received[0]).toEqual({
      type: "session.update",
      session: { audio_format: { encoding: "pcm_s16le", sample_rate: 16000 }, target_streaming_delay_ms: 480 },
    });
    expect(server.received[1]).toEqual({ type: "input_audio.append", audio: Buffer.from([1, 0, 2, 0]).toString("base64") });
    expect(server.headers.authorization).toBe("Bearer mistral-key");

    server.send({ type: "transcription.text.delta", text: "Hello" });
    server.send({ type: "transcription.text.delta", text: " there" });
    await waitFor(() => events.onPartial.mock.calls.length === 2);
    expect(events.onPartial).toHaveBeenLastCalledWith("Hello there");

    session.end();
    await waitFor(() => server.received.length >= 4);
    expect(server.received.slice(-2)).toEqual([{ type: "input_audio.flush" }, { type: "input_audio.end" }]);
    server.send({ type: "transcription.text.delta", text: ", Mom." });
    server.send({ type: "transcription.done", text: "" });
    await waitFor(() => events.onFinal.mock.calls.length === 1);
    expect(events.onFinal).toHaveBeenCalledWith("Hello there, Mom.");
    expect(events.onError).not.toHaveBeenCalled();
  });

  it("treats finalized segments as committed text and reports the joined transcript", async () => {
    const server = await fakeMistral();
    servers.push(server);
    const events = { onPartial: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
    const session = createSttSession({ ...realtimeConfig, url: server.url }, events);
    await waitFor(() => server.received.length >= 1);
    server.send({ type: "transcription.text.delta", text: "First sen" });
    server.send({ type: "transcription.segment", text: "First sentence." });
    server.send({ type: "transcription.text.delta", text: "Second" });
    await waitFor(() => events.onPartial.mock.calls.length === 3);
    expect(events.onPartial).toHaveBeenLastCalledWith("First sentence. Second");
    session.end();
    server.send({ type: "transcription.done", text: "ignored full text" });
    await waitFor(() => events.onFinal.mock.calls.length === 1);
    expect(events.onFinal).toHaveBeenCalledWith("First sentence. Second");
  });

  it("uses the done text when no deltas or segments arrived", async () => {
    const server = await fakeMistral();
    servers.push(server);
    const events = { onFinal: vi.fn() };
    const session = createSttSession({ ...realtimeConfig, url: server.url }, events);
    await waitFor(() => server.received.length >= 1);
    session.end();
    server.send({ type: "transcription.done", text: "Complete transcript." });
    await waitFor(() => events.onFinal.mock.calls.length === 1);
    expect(events.onFinal).toHaveBeenCalledWith("Complete transcript.");
  });

  it("surfaces provider errors and an unexpected close as onError, and stays quiet after abort", async () => {
    const server = await fakeMistral();
    servers.push(server);
    const events = { onFinal: vi.fn(), onError: vi.fn() };
    createSttSession({ ...realtimeConfig, url: server.url }, events);
    await waitFor(() => server.received.length >= 1);
    server.send({ type: "error", error: { message: "invalid model" } });
    await waitFor(() => events.onError.mock.calls.length === 1);
    expect(events.onError.mock.calls[0][0].message).toBe("invalid model");

    const second = await fakeMistral();
    servers.push(second);
    const closeEvents = { onFinal: vi.fn(), onError: vi.fn() };
    createSttSession({ ...realtimeConfig, url: second.url }, closeEvents);
    await waitFor(() => second.received.length >= 1);
    second.socket().close();
    await waitFor(() => closeEvents.onError.mock.calls.length === 1);
    expect(closeEvents.onError.mock.calls[0][0].message).toMatch(/closed/);
    expect(closeEvents.onFinal).not.toHaveBeenCalled();

    const third = await fakeMistral();
    servers.push(third);
    const abortEvents = { onFinal: vi.fn(), onError: vi.fn() };
    const aborted = createSttSession({ ...realtimeConfig, url: third.url }, abortEvents);
    await waitFor(() => third.received.length >= 1);
    aborted.abort();
    await new Promise((r) => setTimeout(r, 30));
    expect(abortEvents.onError).not.toHaveBeenCalled();
    expect(abortEvents.onFinal).not.toHaveBeenCalled();
  });

  it("queues audio sent before the provider is ready and flushes it after session.created", async () => {
    let release: ((send: (e: unknown) => void) => void) | null = null;
    const server = await fakeMistral((send) => {
      release = () => send({ type: "session.created" });
    });
    servers.push(server);
    const events = { onReady: vi.fn() };
    const session = createSttSession({ ...realtimeConfig, url: server.url }, events);
    session.sendAudio(Buffer.from([9, 9]));
    session.sendAudio(Buffer.from([8, 8]));
    await waitFor(() => release !== null);
    await new Promise((r) => setTimeout(r, 20));
    expect(server.received).toHaveLength(0);
    release!(server.send);
    await waitFor(() => server.received.length >= 3);
    expect(server.received.map((m) => (m as { type: string }).type)).toEqual([
      "session.update",
      "input_audio.append",
      "input_audio.append",
    ]);
  });
});

describe("batch STT session", () => {
  const batchConfig: VoiceSttConfig = {
    provider: "openai-compatible",
    url: "https://openrouter.ai/api/v1/audio/transcriptions",
    model: "mistralai/voxtral-mini-transcribe-2602",
    apiKey: "or-key",
    streamingDelayMs: 480,
    language: "en",
  };

  it("uploads the buffered utterance as WAV multipart on end and reports the transcript", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      const file = form.get("file") as File;
      const bytes = Buffer.from(await file.arrayBuffer());
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(form.get("model")).toBe("mistralai/voxtral-mini-transcribe-2602");
      expect(form.get("language")).toBe("en");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer or-key");
      return new Response(JSON.stringify({ text: "  Call my daughter.  " }), { status: 200 });
    });
    const events = { onReady: vi.fn(), onFinal: vi.fn(), onError: vi.fn() };
    const session = createSttSession(batchConfig, events, { fetchImpl: fetchImpl as unknown as typeof fetch });
    session.sendAudio(Buffer.from([0, 1, 0, 2]));
    session.end();
    await waitFor(() => events.onFinal.mock.calls.length === 1);
    expect(events.onReady).toHaveBeenCalledTimes(1);
    expect(events.onFinal).toHaveBeenCalledWith("Call my daughter.");
  });

  it("finalizes an empty utterance without an upstream call and maps HTTP errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad key", { status: 401 }));
    const empty = { onFinal: vi.fn(), onError: vi.fn() };
    createSttSession(batchConfig, empty, { fetchImpl: fetchImpl as unknown as typeof fetch }).end();
    await waitFor(() => empty.onFinal.mock.calls.length === 1);
    expect(empty.onFinal).toHaveBeenCalledWith("");
    expect(fetchImpl).not.toHaveBeenCalled();

    const failing = { onFinal: vi.fn(), onError: vi.fn() };
    const session = createSttSession(batchConfig, failing, { fetchImpl: fetchImpl as unknown as typeof fetch });
    session.sendAudio(Buffer.from([1, 1]));
    session.end();
    await waitFor(() => failing.onError.mock.calls.length === 1);
    expect(failing.onError.mock.calls[0][0].message).toMatch(/HTTP 401.*bad key/);
  });
});
