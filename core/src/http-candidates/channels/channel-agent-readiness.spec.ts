import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ open: vi.fn(), call: vi.fn(), close: vi.fn(), dispose: vi.fn(), attach: vi.fn() }));
vi.mock("../chat-proxy/openclaw/authenticated-upstream.js", () => ({ openAuthenticatedUpstream: native.open }));
vi.mock("../chat-proxy/openclaw/bridge-upstream-rpc.js", () => ({ attachUpstreamRpcClient: native.attach }));
import { channelAgentReady, readChannelAgentReadiness } from "./channel-agent-readiness.js";

const scope = { workspaceId: "alice", project: null, channelId: "planning", agentId: "octogee-alice-coach", peerKind: "channel" as "group" | "channel" };
function ready(project: string | null = null) {
  const agentId = project ? `octogee-alice-proj-${project}-coach` : scope.agentId;
  const accountId = project ? `alice-proj-${project}` : "alice-coach";
  return {
    config: { configRevisionHash: "next", appliedConfigHash: "next", config: {
      agents: { entries: { [agentId]: { model: "platform-openrouter/openai/test" } } },
      bindings: [{ agentId, match: { channel: "mattermost", accountId, peer: { kind: "group", id: "planning" } } }],
    } },
    models: { providers: [{ provider: "platform-openrouter", status: "static" }] },
    session: { session: null as unknown },
    channels: { channelAccounts: { mattermost: [{ accountId, running: true, connected: true }] } },
  };
}

describe("channel Agent readiness", () => {
  it("allows a healthy configured fallback before a channel has a live session", () => {
    const snapshot = ready();
    Reflect.set(snapshot.config.config.agents.entries[scope.agentId], "model", { primary: "anthropic/test", fallbacks: ["platform-openrouter/openai/test"] });
    expect(channelAgentReady(scope, snapshot)).toBe(true);
  });
  it("inherits default fallbacks unless the Agent explicitly disables them", () => {
    const snapshot = ready();
    snapshot.config.config.agents.entries[scope.agentId].model = "anthropic/test";
    Reflect.set(snapshot.config.config.agents, "defaults", { model: { primary: "anthropic/test", fallbacks: ["platform-openrouter/openai/test"] } });
    expect(channelAgentReady(scope, snapshot)).toBe(true);
    Reflect.set(snapshot.config.config.agents.entries[scope.agentId], "model", { primary: "anthropic/test", fallbacks: [] });
    expect(channelAgentReady(scope, snapshot)).toBe(false);
  });
  it("blocks a new session when both primary and fallback credentials are unavailable", () => {
    const snapshot = ready();
    Reflect.set(snapshot.config.config.agents.entries[scope.agentId], "model", { primary: "anthropic/test", fallbacks: ["platform-openrouter/openai/test"] });
    snapshot.models.providers[0].status = "expired";
    expect(channelAgentReady(scope, snapshot)).toBe(false);
  });
  it("keeps an existing session authoritative over a healthy default fallback", () => {
    const snapshot = ready();
    Reflect.set(snapshot.config.config.agents.entries[scope.agentId], "model", { primary: "anthropic/test", fallbacks: ["platform-openrouter/openai/test"] });
    snapshot.session.session = { key: `agent:${scope.agentId}:mattermost:channel:${scope.channelId}`, modelProvider: "anthropic", model: "test" };
    expect(channelAgentReady(scope, snapshot)).toBe(false);
  });
  it.each(["anthropic", "claude-cli"])("requires native credential health for %s owner models", (provider) => {
    const snapshot = ready();
    snapshot.config.config.agents.entries[scope.agentId].model = `${provider}/test`;
    for (const status of ["missing", "expired"]) {
      snapshot.models.providers = [{ provider, status }];
      expect(channelAgentReady(scope, snapshot)).toBe(false);
    }
    snapshot.models.providers = [];
    expect(channelAgentReady(scope, snapshot)).toBe(false);
    for (const status of ["static", "ok", "expiring"]) {
      snapshot.models.providers = [{ provider, status }];
      expect(channelAgentReady(scope, snapshot)).toBe(true);
    }
  });
  it.each([undefined, {}, { key: "another-channel", modelProvider: "platform-openrouter", model: "test" }, { key: `agent:${scope.agentId}:mattermost:channel:${scope.channelId}`, model: "test" }])("blocks malformed or differently scoped live session metadata (%j)", (session) => {
    const snapshot = ready();
    snapshot.session.session = session;
    expect(channelAgentReady(scope, snapshot)).toBe(false);
  });
  it("checks an active session override instead of a healthy durable default", () => {
    const snapshot = ready();
    snapshot.session.session = { key: `agent:${scope.agentId}:mattermost:channel:${scope.channelId}`, modelProvider: "platform-openai", model: "test" };
    expect(channelAgentReady(scope, snapshot)).toBe(false);
  });
  it("accepts a healthy live override when the unused durable default has no credential", () => {
    const snapshot = ready();
    snapshot.session.session = { key: `agent:${scope.agentId}:mattermost:channel:${scope.channelId}`, modelProvider: "platform-openai", model: "test" };
    snapshot.models.providers = [{ provider: "platform-openai", status: "static" }];
    expect(channelAgentReady(scope, snapshot)).toBe(true);
  });
  it.each([null, "orbit"])("requires applied connected routing for scope %s", (project) => {
    const agentId = project ? `octogee-alice-proj-${project}-coach` : scope.agentId;
    expect(channelAgentReady({ ...scope, project, agentId }, ready(project))).toBe(true);
  });
  it.each(["unapplied", "wrong-channel", "wrong-account", "wrong-agent", "missing-agent", "disconnected", "stopped", "account-fallback", "missing-credential", "expired-credential"])("does not mark a channel ready with %s", (failure) => {
    const snapshot = ready();
    const binding = snapshot.config.config.bindings[0];
    if (failure === "unapplied") snapshot.config.appliedConfigHash = "previous";
    if (failure === "wrong-channel") binding.match.peer.id = "other";
    if (failure === "wrong-account") binding.match.accountId = "bob-coach";
    if (failure === "wrong-agent") binding.agentId = "other-agent";
    if (failure === "missing-agent") snapshot.config.config.agents.entries = {};
    if (failure === "disconnected") snapshot.channels.channelAccounts.mattermost[0].connected = false;
    if (failure === "stopped") snapshot.channels.channelAccounts.mattermost[0].running = false;
    if (failure === "missing-credential") snapshot.models.providers = [];
    if (failure === "expired-credential") snapshot.models.providers[0].status = "expired";
    if (failure === "account-fallback") Reflect.deleteProperty(binding.match, "peer");
    expect(channelAgentReady(scope, snapshot)).toBe(false);
  });
  it("requires an explicit peer binding for the private Agent channel", () => {
    const snapshot = ready();
    Reflect.deleteProperty(snapshot.config.config.bindings[0].match, "peer");
    expect(channelAgentReady({ ...scope, peerKind: "group" }, snapshot)).toBe(false);
  });
});

describe("native channel readiness snapshot", () => {
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(() => {
    vi.resetAllMocks();
    native.open.mockResolvedValue({ close: native.close });
    native.attach.mockReturnValue({ call: native.call, dispose: native.dispose });
    const snapshot = ready();
    native.call.mockImplementation(async (method) => ({ ok: true, result:
      method === "config.get" ? snapshot.config : method === "channels.status" ? snapshot.channels : method === "sessions.describe" ? snapshot.session : snapshot.models,
    }));
  });
  it("reads live applied routing, connection and selected Agent credentials without refreshing them", async () => {
    expect(await readChannelAgentReadiness(scope)).toBe(true);
    expect(native.call.mock.calls).toEqual([
      ["config.get", {}], ["channels.status", {}],
      ["sessions.describe", { key: `agent:${scope.agentId}:mattermost:channel:${scope.channelId}`, agentId: scope.agentId }],
      ["models.authStatus", { agentId: scope.agentId }],
    ]);
    expect(native.dispose).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
  });
  it("accepts healthy native connection and reads beyond the old per-stage allowance", async () => {
    vi.useFakeTimers();
    native.open.mockImplementation(({ timeoutMs }) => new Promise((resolve, reject) => {
      const response = setTimeout(() => { clearTimeout(timeout); resolve({ close: native.close }); }, 5_651);
      const timeout = setTimeout(() => { clearTimeout(response); reject(new Error("connect timed out")); }, timeoutMs);
    }));
    const success = native.call.getMockImplementation()!;
    native.call.mockImplementation(async (method, params) => {
      await new Promise(resolve => setTimeout(resolve, 1_700));
      return success(method, params);
    });
    const checked = readChannelAgentReadiness(scope).then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(12_451);
    expect(await checked).toEqual({ value: true });
    expect(native.dispose).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
  });
  it("bounds the entire snapshot instead of granting each stage a separate deadline", async () => {
    vi.useFakeTimers();
    native.open.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ close: native.close }), 5_000);
    }));
    native.call.mockImplementation(() => new Promise(() => {}));
    const checked = readChannelAgentReadiness(scope).catch(error => error);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await checked).toEqual(new Error("Channel readiness timed out"));
    expect(native.call).toHaveBeenCalledOnce();
    expect(native.dispose).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("closes a connection completed after the snapshot deadline without starting reads", async () => {
    vi.useFakeTimers();
    native.open.mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ close: native.close }), 26_000);
    }));
    const checked = readChannelAgentReadiness(scope).catch(error => error);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await checked).toEqual(new Error("Channel readiness timed out"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(native.attach).not.toHaveBeenCalled();
    expect(native.call).not.toHaveBeenCalled();
    expect(native.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("checks the private channel's live group session override", async () => {
    const success = native.call.getMockImplementation()!;
    const key = `agent:${scope.agentId}:mattermost:group:${scope.channelId}`;
    native.call.mockImplementation((method, params) => method === "sessions.describe"
      ? Promise.resolve({ ok: true, result: { session: params.key === key ? { key, modelProvider: "platform-openai", model: "test" } : null } })
      : success(method, params));
    expect(await readChannelAgentReadiness({ ...scope, peerKind: "group" })).toBe(false);
    expect(native.call).toHaveBeenCalledWith("sessions.describe", { key, agentId: scope.agentId });
  });
  it.each(["config.get", "channels.status", "sessions.describe", "models.authStatus"])("closes the upstream and reports a failed %s check", async (failed) => {
    const success = native.call.getMockImplementation()!;
    native.call.mockImplementation((method, params) => method === failed
      ? Promise.resolve({ ok: false, reason: "runtime reloading" }) : success(method, params));
    await expect(readChannelAgentReadiness(scope)).rejects.toThrow("runtime reloading");
    expect(native.dispose).toHaveBeenCalledOnce();
    expect(native.close).toHaveBeenCalledOnce();
  });
});

describe("readiness failure reasons", () => {
  it("classifies a degraded agent store, a starting gateway, and everything else", async () => {
    const { readinessFailureReason } = await import("./channel-agent-readiness.js");
    expect(readinessFailureReason(new Error("prepared model runtime publication was superseded for /x"))).toBe("agent-repair-required");
    expect(readinessFailureReason(new Error("Sessions remain unavailable. Stop the Gateway, run \"openclaw doctor --fix\""))).toBe("agent-repair-required");
    expect(readinessFailureReason(new Error("connect ECONNREFUSED 127.0.0.1:18789"))).toBe("agent-starting");
    expect(readinessFailureReason(new Error("rpc timed out after 1200ms"))).toBe("agent-starting");
    expect(readinessFailureReason(new Error("Channel routing config read failed: forbidden"))).toBe("unavailable");
    expect(readinessFailureReason("boom")).toBe("unavailable");
  });
});
