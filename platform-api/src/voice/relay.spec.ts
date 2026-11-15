import { once } from "node:events";
import http from "node:http";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createTenantEnforcementMiddleware } from "../middleware/tenant-enforcement.js";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { encodeWav } from "./audio-format.js";
import type { VoiceRelayConfig } from "./config.js";
import {
  VOICE_RELAY_MAX_TTS_PER_GATEWAY,
  createVoiceRelayRoutes,
  createVoiceRelayUpgradeHandler,
  type VoiceRelayUpgradeAuth,
} from "./relay.js";

const config: VoiceRelayConfig = {
  stt: {
    provider: "mistral-realtime",
    url: "ws://127.0.0.1:1/replaced-per-test",
    model: "voxtral-mini-transcribe-realtime-2602",
    apiKey: "stt-key",
    streamingDelayMs: 480,
  },
  tts: {
    url: "https://tts.example/v1/audio/speech",
    model: "voxtral-mini-tts-2603",
    apiKey: "tts-key",
    voice: "en_paul_neutral",
    voiceParam: "voice_id",
    speedParam: "speed",
    format: "wav",
    pcmSampleRate: 24_000,
    pcmEncoding: "s16le",
    extraBody: {},
    voices: [],
  },
};

function appWith(deps: Parameters<typeof createVoiceRelayRoutes>[0], tenant: unknown = { kind: "gateway", gatewayId: "gw-mom" }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (tenant) req.boundTenant = tenant as Express.Request["boundTenant"];
    next();
  });
  app.use("/internal/voice", createVoiceRelayRoutes(deps));
  return app;
}

function wavResponse(samples: Int16Array): Response {
  const wav = encodeWav(samples, 24_000);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(wav.subarray(0, 44)));
      c.enqueue(new Uint8Array(wav.subarray(44)));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("native OpenAI availability", () => {
  it("advertises native OpenAI even when the original voice provider is absent", async () => {
    const response = await request(appWith({ config: null, nativeOpenAi: true })).get('/internal/voice/status?gatewayId=gw-mom');
    expect(response.body).toEqual({ configured: false, nativeOpenAi: true });
  });
  it("advertises platform-funded Live voice without changing the original relay configuration", async () => {
    const response = await request(appWith({ config, nativeOpenAi: true })).get("/internal/voice/status?gatewayId=gw-mom");
    expect(response.body).toMatchObject({ configured: true, nativeOpenAi: true, engines: { tts: "openai-compatible:voxtral-mini-tts-2603" } });
  });
});

describe("POST /internal/voice/tts", () => {
  it("streams normalized PCM with sample-rate headers for a bound gateway", async () => {
    const samples = Int16Array.from({ length: 480 }, (_, i) => i);
    const fetchImpl = vi.fn(async () => wavResponse(samples));
    const res = await request(appWith({ config, fetchImpl }))
      .post("/internal/voice/tts")
      .send({ gatewayId: "gw-mom", text: "Hi Mom.", speed: 0.9 })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/audio\/pcm/);
    expect(res.headers["x-voice-sample-rate"]).toBe("24000");
    expect((res.body as Buffer).length).toBe(samples.length * 2);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toMatchObject({ input: "Hi Mom.", speed: 0.9, voice_id: "en_paul_neutral" });
  });

  it("refuses unbound callers, mismatched gateway claims, and unconfigured relays", async () => {
    const fetchImpl = vi.fn();
    expect((await request(appWith({ config, fetchImpl }, null)).post("/internal/voice/tts").send({ text: "x" })).status).toBe(403);
    expect((await request(appWith({ config, fetchImpl })).post("/internal/voice/tts").send({ gatewayId: "gw-other", text: "x" })).status).toBe(403);
    expect((await request(appWith({ config: null, fetchImpl })).post("/internal/voice/tts").send({ text: "x" })).status).toBe(503);
    expect((await request(appWith({ config, fetchImpl })).post("/internal/voice/tts").send({ text: "   " })).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps upstream failures to 502 before any audio was written", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const log = vi.fn();
    const res = await request(appWith({ config, fetchImpl, log })).post("/internal/voice/tts").send({ text: "Hi" });
    expect(res.status).toBe(502);
    expect(log).toHaveBeenCalledWith("voice relay tts failed", expect.objectContaining({ gatewayId: "gw-mom" }));
  });

  it("reports configuration on /status for the bound gateway and refuses another gateway's claim in the query", async () => {
    const res = await request(appWith({ config })).get("/internal/voice/status?gatewayId=gw-mom");
    expect(res.body).toEqual({
      configured: true,
      engines: { stt: "mistral-realtime:voxtral-mini-transcribe-realtime-2602", tts: "openai-compatible:voxtral-mini-tts-2603" },
      capabilities: { speed: true },
    });
    expect((await request(appWith({ config: null })).get("/internal/voice/status?gatewayId=gw-mom")).body).toEqual({ configured: false });
    expect((await request(appWith({ config })).get("/internal/voice/status?gatewayId=gw-other")).status).toBe(403);
  });

  it("clears octogee-api tenant enforcement only when the request names its own gateway (query for GET, body for POST)", async () => {
    const enforced = express();
    enforced.use(express.json());
    enforced.use((req, _res, next) => {
      req.boundTenant = { kind: "gateway", gatewayId: "gw-mom" } as Express.Request["boundTenant"];
      next();
    });
    enforced.use(createTenantEnforcementMiddleware({
      readFlowGateway: async () => { throw new Error("no lookups expected"); },
      store: createDocumentFixtureStore({}),
    }));
    enforced.use("/internal/voice", createVoiceRelayRoutes({ config, fetchImpl: vi.fn(async () => wavResponse(new Int16Array(0))) }));

    expect((await request(enforced).get("/internal/voice/status")).status).toBe(403);
    expect((await request(enforced).get("/internal/voice/status?gatewayId=gw-mom")).body).toMatchObject({ configured: true });
    expect((await request(enforced).get("/internal/voice/status?gatewayId=gw-other")).status).toBe(403);
    expect((await request(enforced).post("/internal/voice/tts").send({ text: "x" })).status).toBe(403);
    expect((await request(enforced).post("/internal/voice/tts").send({ gatewayId: "gw-mom", text: "x" })).status).toBe(200);
  });

  it("releases the per-gateway slot when a client disconnects while the response is backpressured", async () => {
    const pcmConfig: VoiceRelayConfig = { ...config, tts: { ...config.tts, format: "pcm" } };
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1 << 20));
          },
        }),
        { status: 200, headers: { "content-type": "audio/pcm" } },
      );
    const fetchImpl = vi.fn(async () => endless());
    const server = http.createServer(appWith({ config: pcmConfig, fetchImpl }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      const stuck = await Promise.all(
        Array.from({ length: VOICE_RELAY_MAX_TTS_PER_GATEWAY }, async () => {
          const req = http.request({ host: "127.0.0.1", port, path: "/internal/voice/tts", method: "POST", headers: { "content-type": "application/json" } });
          const responded = once(req, "response");
          req.end(JSON.stringify({ text: "endless" }));
          const [res] = (await responded) as [http.IncomingMessage];
          expect(res.statusCode).toBe(200);
          res.pause();
          return { req, res };
        }),
      );
      const refused = await request(`http://127.0.0.1:${port}`).post("/internal/voice/tts").send({ text: "one too many" });
      expect(refused.status).toBe(429);

      for (const { req } of stuck) req.destroy();
      const deadline = Date.now() + 5_000;
      let status = 429;
      while (status === 429 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        const probe = http.request({ host: "127.0.0.1", port, path: "/internal/voice/tts", method: "POST", headers: { "content-type": "application/json" } });
        const responded = once(probe, "response");
        probe.end(JSON.stringify({ text: "after disconnects" }));
        const [res] = (await responded) as [http.IncomingMessage];
        status = res.statusCode ?? 0;
        probe.destroy();
      }
      expect(status).toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("/internal/voice/stt upgrade", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function fakeProvider() {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(wss, "listening");
    const received: unknown[] = [];
    let sock: WebSocket | null = null;
    wss.on("connection", (s) => {
      sock = s;
      s.on("message", (d) => received.push(JSON.parse(d.toString())));
      s.send(JSON.stringify({ type: "session.created" }));
    });
    cleanups.push(async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    });
    return {
      url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}/rt`,
      received,
      send: (e: unknown) => sock!.send(JSON.stringify(e)),
    };
  }

  async function relayServer(authorize: (req: http.IncomingMessage) => Promise<VoiceRelayUpgradeAuth>, cfg: VoiceRelayConfig | null) {
    const server = http.createServer((_req, res) => res.end("ok"));
    const handler = createVoiceRelayUpgradeHandler({ config: cfg, authorize });
    server.on("upgrade", (req, socket, head) => {
      if (!handler(req, socket, head)) {
        socket.destroy();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanups.push(async () => {
      await new Promise<void>((r) => server.close(() => r()));
    });
    return `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("bridges one utterance: audio in → provider appends; deltas out → partial/final; closes after final", async () => {
    const provider = await fakeProvider();
    const base = await relayServer(async () => ({ ok: true, gatewayId: "gw-mom" }), {
      ...config,
      stt: { ...config.stt, url: provider.url },
    });
    const client = new WebSocket(`${base}/internal/voice/stt?gatewayId=gw-mom`);
    const messages: Array<Record<string, unknown>> = [];
    client.on("message", (d) => messages.push(JSON.parse(d.toString())));
    await once(client, "open");
    await waitFor(() => messages.some((m) => m.type === "ready"));
    client.send(Buffer.from([1, 0, 2, 0]), { binary: true });
    await waitFor(() => provider.received.length >= 2);
    expect(provider.received[1]).toEqual({ type: "input_audio.append", audio: Buffer.from([1, 0, 2, 0]).toString("base64") });
    provider.send({ type: "transcription.text.delta", text: "Where is" });
    await waitFor(() => messages.some((m) => m.type === "partial"));
    expect(messages.find((m) => m.type === "partial")).toEqual({ type: "partial", text: "Where is" });
    client.send(JSON.stringify({ type: "end" }));
    await waitFor(() => provider.received.some((m) => (m as { type: string }).type === "input_audio.end"));
    provider.send({ type: "transcription.text.delta", text: " my daughter?" });
    provider.send({ type: "transcription.done" });
    const closed = once(client, "close");
    await waitFor(() => messages.some((m) => m.type === "final"));
    expect(messages.find((m) => m.type === "final")).toEqual({ type: "final", text: "Where is my daughter?" });
    const [code] = (await closed) as [number];
    expect(code).toBe(1000);
  });

  it("refuses unauthorized upgrades and unconfigured relays without touching the provider", async () => {
    const provider = await fakeProvider();
    const denied = await relayServer(async () => ({ ok: false, status: 403 }), { ...config, stt: { ...config.stt, url: provider.url } });
    const deniedClient = new WebSocket(`${denied}/internal/voice/stt`);
    const [deniedErr] = (await once(deniedClient, "error")) as [Error];
    expect(deniedErr.message).toMatch(/403/);

    const unconfigured = await relayServer(async () => ({ ok: true, gatewayId: "gw" }), null);
    const unconfiguredClient = new WebSocket(`${unconfigured}/internal/voice/stt`);
    const [unconfiguredErr] = (await once(unconfiguredClient, "error")) as [Error];
    expect(unconfiguredErr.message).toMatch(/503/);
    expect(provider.received).toHaveLength(0);
  });

  it("forwards provider errors as an error message and closes with 1011", async () => {
    const provider = await fakeProvider();
    const base = await relayServer(async () => ({ ok: true, gatewayId: "gw-mom" }), { ...config, stt: { ...config.stt, url: provider.url } });
    const client = new WebSocket(`${base}/internal/voice/stt`);
    const messages: Array<Record<string, unknown>> = [];
    client.on("message", (d) => messages.push(JSON.parse(d.toString())));
    await once(client, "open");
    await waitFor(() => provider.received.length >= 1);
    provider.send({ type: "error", error: { message: "rate limited" } });
    const [code] = (await once(client, "close")) as [number];
    expect(messages).toContainEqual({ type: "error", message: "rate limited" });
    expect(code).toBe(1011);
  });

  it("caps concurrent STT sessions per gateway", async () => {
    const provider = await fakeProvider();
    const base = await relayServer(async () => ({ ok: true, gatewayId: "gw-mom" }), { ...config, stt: { ...config.stt, url: provider.url } });
    const clients: WebSocket[] = [];
    for (let i = 0; i < 4; i++) {
      const c = new WebSocket(`${base}/internal/voice/stt`);
      clients.push(c);
      await once(c, "open");
    }
    const fifth = new WebSocket(`${base}/internal/voice/stt`);
    const [err] = (await once(fifth, "error")) as [Error];
    expect(err.message).toMatch(/429/);
    for (const c of clients) c.close();
  });
});
