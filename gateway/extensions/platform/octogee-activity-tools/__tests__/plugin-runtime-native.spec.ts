import { describe, expect, it, vi } from "vitest";
import { configuredAgentIds, registerActivityPlugin } from "../plugin-runtime-native.js";
import type { SourceAgentEvent } from "../activity-types.js";
import type { VoiceEvent } from "../edge-relay-client.js";

function setupRuntime(
  config: unknown = { agents: { list: [{ id: "coach-1" }] } },
  options: { registrationMode?: string } = {},
) {
  const hooks = new Map<string, (event: any, context: any) => void | Promise<void>>();
  let service: { start(): Promise<void> | void; stop?(): Promise<void> | void } | undefined;
  let listener: ((event: SourceAgentEvent) => void) | undefined;
  const relay = {
    publishVoice: vi.fn(async (_agentId: string, _event: VoiceEvent): Promise<{ listening: boolean }> => ({ listening: true })),
    heartbeat: vi.fn(async (_agentId: string, _ts: number) => undefined),
  };
  const api = {
    config,
    ...(options.registrationMode ? { registrationMode: options.registrationMode } : {}),
    pluginConfig: { heartbeatMs: 60_000 },
    logger: { error: vi.fn(), info: vi.fn() },
    runtime: {
      events: {
        onAgentEvent: vi.fn((next: (event: SourceAgentEvent) => void) => {
          listener = next;
          return () => { listener = undefined; };
        }),
      },
    },
    registerService: (next: typeof service) => { service = next; },
    on: (name: string, handler: (event: any, context: any) => void | Promise<void>) => {
      hooks.set(name, handler);
    },
  };

  let heartbeatTick: (() => void) | undefined;
  registerActivityPlugin(api as never, {
    relay: relay as never,
    setIntervalImpl: ((handler: () => void) => {
      heartbeatTick = handler;
      return { unref() {} };
    }) as unknown as typeof setInterval,
    clearIntervalImpl: (() => undefined) as unknown as typeof clearInterval,
  });

  return {
    api,
    hooks,
    relay,
    start: async () => { await service?.start(); },
    stop: async () => { await service?.stop?.(); },
    emit: (event: SourceAgentEvent) => listener?.(event),
    tickHeartbeat: () => heartbeatTick?.(),
    serviceRegistered: () => service !== undefined,
  };
}

describe("native OpenClaw Voice relay", () => {
  it("heartbeats legacy and keyed Agent configuration at service startup", async () => {
    const runtime = setupRuntime({
      agents: {
        list: [{ id: "legacy-coach" }, { id: "shared-coach" }],
        entries: {
          "keyed-coach": {},
          "shared-coach": {},
        },
      },
    });

    expect(configuredAgentIds(runtime.api.config)).toEqual([
      "legacy-coach",
      "shared-coach",
      "keyed-coach",
    ]);

    await runtime.start();

    expect(runtime.relay.heartbeat).toHaveBeenCalledTimes(3);
    expect(runtime.relay.heartbeat.mock.calls.map(([agentId]) => agentId)).toEqual([
      "legacy-coach",
      "shared-coach",
      "keyed-coach",
    ]);
    await runtime.stop();
  });

  it("tracks agents added and removed between heartbeat ticks", async () => {
    const config: { agents: { entries: Record<string, unknown> } } = {
      agents: { entries: { "coach-a": {} } },
    };
    const runtime = setupRuntime(config);

    await runtime.start();
    expect(runtime.relay.heartbeat.mock.calls.map(([agentId]) => agentId)).toEqual(["coach-a"]);

    delete config.agents.entries["coach-a"];
    config.agents.entries["coach-b"] = {};
    runtime.relay.heartbeat.mockClear();
    runtime.tickHeartbeat();

    expect(runtime.relay.heartbeat.mock.calls.map(([agentId]) => agentId)).toEqual(["coach-b"]);
    await runtime.stop();
  });

  it("reports the registration mode and the heartbeat roster it resolved", async () => {
    const runtime = setupRuntime({ agents: { entries: { "coach-a": {}, "coach-b": {} } } });

    await runtime.start();

    expect(runtime.api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("service started"),
    );
    expect(runtime.api.logger.info).toHaveBeenCalledWith(expect.stringContaining('"agents":2'));
    await runtime.stop();
  });

  it("registers no runtime services during a discovery registration pass", () => {
    const runtime = setupRuntime(
      { agents: { entries: { "coach-a": {} } } },
      { registrationMode: "discovery" },
    );

    expect(runtime.serviceRegistered()).toBe(false);
    expect(runtime.relay.heartbeat).not.toHaveBeenCalled();
  });

  it("takes the relay origin only from the platform environment", () => {
    const relay = {
      publishVoice: vi.fn(async () => ({ listening: false })),
      heartbeat: vi.fn(async () => undefined),
    };
    const createRelay = vi.fn((_params: {
      gatewayToken: string;
      env?: NodeJS.ProcessEnv;
    }) => relay);
    const env = {
      GATEWAY_EDGE_INTERNAL_URL: "http://127.0.0.1:3001",
      OPENCLAW_GATEWAY_TOKEN: "gateway-token",
    } as NodeJS.ProcessEnv;
    const api = {
      config: {},
      pluginConfig: {
        edgeUrl: "https://attacker.example/collect",
      },
      runtime: {
        events: { onAgentEvent: vi.fn(() => vi.fn()) },
      },
      registerService: vi.fn(),
      on: vi.fn(),
    };

    registerActivityPlugin(api as never, { createRelay: createRelay as never, env });

    expect(createRelay).toHaveBeenCalledWith({ gatewayToken: "gateway-token", env });
    expect(createRelay.mock.calls[0]?.[0]).not.toHaveProperty("edgeUrl");
  });

  it("relays with the pod relay credential when the OpenClaw process holds no gateway token", () => {
    const relay = {
      publishVoice: vi.fn(async () => ({ listening: false })),
      heartbeat: vi.fn(async () => undefined),
    };
    const createRelay = vi.fn((_params: {
      gatewayToken: string;
      env?: NodeJS.ProcessEnv;
    }) => relay);
    const env = {
      GATEWAY_EDGE_INTERNAL_URL: "http://127.0.0.1:3001",
      OCTOGEE_POD_RELAY_TOKEN: "relay-token",
      OPENCLAW_CONTROL_IDENTITY: "per-user",
    } as NodeJS.ProcessEnv;
    const api = {
      config: {},
      pluginConfig: {},
      runtime: {
        events: { onAgentEvent: vi.fn(() => vi.fn()) },
      },
      registerService: vi.fn(),
      on: vi.fn(),
    };

    registerActivityPlugin(api as never, { createRelay: createRelay as never, env });

    expect(createRelay).toHaveBeenCalledWith({ gatewayToken: "relay-token", env });
  });

  it("stops relaying when the service stops", async () => {
    const runtime = setupRuntime();
    await runtime.start();
    runtime.emit(lifecycle("run", "start"));
    expect(runtime.relay.publishVoice).toHaveBeenCalledTimes(1);
    await runtime.stop();
    runtime.relay.publishVoice.mockClear();
    runtime.emit(lifecycle("run-2", "start"));
    expect(runtime.relay.publishVoice).not.toHaveBeenCalled();
  });

  it("relays only the run start when no Talk session is listening", async () => {
    const runtime = setupRuntime();
    runtime.relay.publishVoice.mockResolvedValue({ listening: false });
    await runtime.start();

    runtime.emit(lifecycle("run", "start"));
    runtime.emit(assistant("run", { text: "Hello", delta: "Hello" }));
    runtime.emit(event("run", "tool", { phase: "result", name: "browser", result: "x".repeat(200_000) }));
    runtime.emit(lifecycle("run", "end"));
    await flush();

    expect(relayedEvents(runtime)).toEqual([
      { kind: "agent", runId: "run", stream: "lifecycle", ts: 1, sessionKey: SESSION, data: { phase: "start" } },
    ]);
  });

  it("relays a listened run's lifecycle and assistant text in order, never its tool results", async () => {
    const runtime = setupRuntime();
    let acknowledgeStart: ((ack: { listening: boolean }) => void) | undefined;
    runtime.relay.publishVoice.mockImplementationOnce(() => new Promise((resolve) => { acknowledgeStart = resolve; }));
    await runtime.start();

    runtime.emit(lifecycle("run", "start"));
    runtime.emit(assistant("run", { text: "Hel", delta: "Hel", itemId: "item-1" }));
    runtime.emit(event("run", "tool", { phase: "result", name: "browser", result: "x".repeat(200_000) }));
    runtime.emit(assistant("run", { text: "Hello", delta: "", replace: true }));
    runtime.emit(lifecycle("run", "end", { endedAt: 5, usage: { input: 1 } }));
    await flush();
    expect(runtime.relay.publishVoice).toHaveBeenCalledTimes(1);

    acknowledgeStart?.({ listening: true });
    await flush();

    expect(relayedEvents(runtime).map((relayed) => relayed.kind === "agent" ? [relayed.stream, relayed.data] : null)).toEqual([
      ["lifecycle", { phase: "start" }],
      ["assistant", { delta: "Hel" }],
      ["assistant", { text: "Hello" }],
      ["lifecycle", { phase: "end" }],
    ]);
  });

  it("logs a failed run-start relay and relays nothing more for that run", async () => {
    const runtime = setupRuntime();
    runtime.relay.publishVoice.mockRejectedValueOnce(new Error("voice relay returned 413"));
    await runtime.start();

    runtime.emit(lifecycle("run", "start"));
    runtime.emit(assistant("run", { delta: "Hi" }));
    await flush();

    expect(runtime.relay.publishVoice).toHaveBeenCalledTimes(1);
    expect(runtime.api.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("voice agent event relay failed"),
    );
    expect(runtime.api.logger.error).toHaveBeenCalledWith(expect.stringContaining("voice relay returned 413"));
  });

  it("relays nothing for a run whose start it never saw", async () => {
    const runtime = setupRuntime();
    await runtime.start();

    runtime.emit(assistant("run", { delta: "Hi" }));
    runtime.emit(lifecycle("run", "end"));
    await flush();

    expect(runtime.relay.publishVoice).not.toHaveBeenCalled();
  });

  it("heartbeats a newly seen agent once rather than on every event", async () => {
    const runtime = setupRuntime({ agents: { list: [] } });
    await runtime.start();

    runtime.emit(lifecycle("run", "start"));
    runtime.emit(assistant("run", { delta: "a" }));
    runtime.emit(assistant("run", { delta: "b" }));
    await flush();

    expect(runtime.relay.heartbeat.mock.calls.map(([agentId]) => agentId)).toEqual(["coach-1"]);
  });
});

const SESSION = "agent:coach-1:main";

function event(runId: string, stream: string, data: Record<string, unknown>): SourceAgentEvent {
  return { agentId: "coach-1", runId, seq: 1, stream, ts: 1, sessionKey: SESSION, data };
}

function lifecycle(runId: string, phase: string, extra: Record<string, unknown> = {}): SourceAgentEvent {
  return event(runId, "lifecycle", { phase, ...extra });
}

function assistant(runId: string, data: Record<string, unknown>): SourceAgentEvent {
  return event(runId, "assistant", data);
}

function relayedEvents(runtime: ReturnType<typeof setupRuntime>): VoiceEvent[] {
  return runtime.relay.publishVoice.mock.calls.map(([, relayed]) => relayed);
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
