import { describe, expect, it, vi } from "vitest";
import { configuredAgentIds, registerActivityPlugin } from "../plugin-runtime-native.js";
import type { SourceAgentEvent } from "../activity-types.js";

function setupRuntime(
  config: unknown = { agents: { list: [{ id: "coach-1" }] } },
  options: { registrationMode?: string } = {},
) {
  const hooks = new Map<string, (event: any, context: any) => void | Promise<void>>();
  let service: { start(): Promise<void> | void; stop?(): Promise<void> | void } | undefined;
  let listener: ((event: SourceAgentEvent) => void) | undefined;
  const relay = {
    publishVoice: vi.fn(async () => undefined),
    heartbeat: vi.fn(async (_agentId: string, _ts: number) => undefined),
    voiceAgentEvent: (event: SourceAgentEvent) => ({
      kind: "agent" as const,
      runId: event.runId,
      stream: event.stream,
      ts: event.ts ?? 0,
      ...(event.sessionKey ? { sessionKey: event.sessionKey } : {}),
      data: event.data,
    }),
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
      publishVoice: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => undefined),
      voiceAgentEvent: vi.fn(),
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
      publishVoice: vi.fn(async () => undefined),
      heartbeat: vi.fn(async () => undefined),
      voiceAgentEvent: vi.fn(),
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

  it("keeps Voice events and stops listening when the service stops", async () => {
    const runtime = setupRuntime();
    await runtime.start();
    const event = { agentId: 'coach-1', runId: 'run', seq: 1, stream: 'tool', ts: 1, sessionKey: 'agent:coach-1:main', data: { phase: 'start' } };
    runtime.emit(event);
    expect(runtime.relay.publishVoice).toHaveBeenCalledWith('coach-1', runtime.relay.voiceAgentEvent(event));
    await runtime.stop(); runtime.relay.publishVoice.mockClear(); runtime.emit(event);
    expect(runtime.relay.publishVoice).not.toHaveBeenCalled();
  });
});
