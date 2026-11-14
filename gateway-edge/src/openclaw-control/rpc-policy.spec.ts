import { describe, expect, it } from "vitest";
import { reconcilePlatformInvariants } from "@octogee/core/system-config-invariants";
import { evaluateOpenClawControlRpc, openClawConfigSnapshotFromGetResponse, installedMethodsFromHello } from "./rpc-policy.js";

const invariantContext = { gatewayClass: "isolated" as const, gatewayId: "walter", apiOrigin: "https://api.octogee.com" };
function request(method: string, params: Record<string, unknown> = {}) {
  return { type: "req", id: "rpc-1", method, params };
}
function validConfig(extra: Record<string, unknown> = {}) {
  const config = structuredClone(extra);
  reconcilePlatformInvariants(config, invariantContext);
  return config;
}
function policyContext(extra: Record<string, unknown> = {}) {
  return { installedMethods: new Set<string>(), invariantContext, ...extra };
}

describe("native Dashboard permissions and managed configuration", () => {
  it("passes private inspection through Native read authorization without adding caller identity", () => {
    const frame = request("octogee.broker.inspect", { agentId: "octogee-alice-coach" });
    expect(evaluateOpenClawControlRpc(frame, policyContext(), false)).toMatchObject({ allowed: true, category: "read", outbound: frame });
  });
  it.each(["member", "admin"] as const)("lets OpenClaw authorize ordinary RPCs for %s", (role) => {
    const frame = { type: "req", id: "list", method: "future.plugin.rpc" };
    expect(evaluateOpenClawControlRpc(frame, policyContext(), role === "admin")).toMatchObject({ allowed: true, outbound: { ...frame, params: {} } });
    for (const params of [null, [], "invalid", 1, true]) {
      expect(evaluateOpenClawControlRpc({ ...frame, params }, policyContext(), role === "admin")).toMatchObject({ allowed: false, reason: "invalid-frame" });
    }
  });
  it.each(["config.patch", "config.set", "config.apply"])("never borrows service authority for a Member's %s", (method) => {
    const current = validConfig();
    expect(evaluateOpenClawControlRpc(request(method, { raw: JSON.stringify(current) }), policyContext({ currentConfig: { raw: current, hash: "h" } }), false))
      .toMatchObject({ allowed: false, category: "config_mutation" });
  });
  it("fences Admin config writes behind the configuration freeze and the platform wiring invariants only", () => {
    const current = validConfig({ agents: { defaults: { timeoutSeconds: 10 } } });
    const context = policyContext({ currentConfig: { raw: current, hash: "hash-1" } });
    const ownerEdit = request("config.patch", {
      raw: JSON.stringify({ agents: { defaults: { timeoutSeconds: 30 } } }),
      baseHash: "hash-1",
      restartDelayMs: 500,
    });
    const rewire = request("config.patch", {
      raw: JSON.stringify({ gateway: { bind: "loopback" } }),
      baseHash: "hash-1",
    });
    const staleButOwnerShaped = request("config.apply", {
      raw: JSON.stringify(current),
      baseHash: "stale",
    });

    expect(evaluateOpenClawControlRpc(ownerEdit, policyContext({ ...context, configFrozen: true }), true))
      .toMatchObject({ allowed: false, category: "config_mutation", reason: "config-frozen" });
    expect(evaluateOpenClawControlRpc(ownerEdit, context, true))
      .toMatchObject({ allowed: true, category: "config_mutation", outbound: ownerEdit });
    expect(evaluateOpenClawControlRpc(rewire, context, true))
      .toMatchObject({ allowed: false, category: "config_mutation", reason: "platform-invariant" });
    expect(evaluateOpenClawControlRpc(staleButOwnerShaped, context, true))
      .toMatchObject({ allowed: true, category: "config_mutation" });
    const fullOwnerConfig = request("config.set", {
      raw: JSON.stringify(current),
      baseHash: "hash-1",
    });
    expect(evaluateOpenClawControlRpc(fullOwnerConfig, policyContext(), true))
      .toMatchObject({ allowed: true, category: "config_mutation", outbound: fullOwnerConfig });
    expect(evaluateOpenClawControlRpc(ownerEdit, policyContext(), true))
      .toMatchObject({ allowed: false, category: "config_mutation", reason: "config-invalid" });
  });



  it.each([
    { brokerUrl: "http://127.0.0.1:9999" },
    { tokenPath: "/home/node/user-file" },
  ])("rejects Admin native voice broker rewiring through config.patch: %j", (config) => {
    const perUser = { ...invariantContext, controlIdentity: "per-user" as const, ownerUid: "owner", workspaceSlug: "alice" };
    const current = {};
    reconcilePlatformInvariants(current, perUser);
    const frame = request("config.patch", {
      baseHash: "h",
      raw: JSON.stringify({ plugins: { entries: { "octogee-voice-tools": { config } } } }),
    });
    expect(evaluateOpenClawControlRpc(frame, policyContext({
      invariantContext: perUser, currentConfig: { raw: current, hash: "h" },
    }), true)).toMatchObject({ allowed: false, category: "config_mutation", reason: "platform-invariant" });
  });

  it("lets an Admin change native voice preferences and opt out without changing broker wiring", () => {
    const perUser = { ...invariantContext, controlIdentity: "per-user" as const, ownerUid: "owner", workspaceSlug: "alice" };
    const current = {};
    reconcilePlatformInvariants(current, perUser);
    const frame = request("config.patch", {
      baseHash: "h",
      raw: JSON.stringify({
        talk: { realtime: { provider: "google", providers: { google: { voice: "custom-voice" } } } },
        plugins: { entries: { "octogee-voice-tools": { enabled: false } } },
      }),
    });
    expect(evaluateOpenClawControlRpc(frame, policyContext({
      invariantContext: perUser, currentConfig: { raw: current, hash: "h" },
    }), true)).toMatchObject({ allowed: true, category: "config_mutation", outbound: frame });
  });

  it("keeps native optimistic hashes and replacePaths intact while checking the resulting config", () => {
    const current = validConfig({ agents: { list: [{ id: "main", name: "Main" }, { id: "coach", name: "Coach" }] } });
    const frame = request("config.patch", { baseHash: "native-hash", replacePaths: ["agents.list"], raw: JSON.stringify({ agents: { list: [{ id: "main", name: "New" }] } }) });
    const result = evaluateOpenClawControlRpc(frame, policyContext({ currentConfig: { raw: current, hash: "native-hash" } }), true);
    expect(result.allowed).toBe(true);
    expect(result.outbound).toEqual(frame);
    expect(result.proposedConfig).toMatchObject({ agents: { list: [{ id: "main", name: "New" }] } });
  });
  it("captures config source and discovery only from successful matching replies", () => {
    expect(openClawConfigSnapshotFromGetResponse({ type: "res", ok: true, payload: { raw: "{}", hash: "h", resolved: { secret: "hidden" } } }, "config.get")).toEqual({ raw: {}, hash: "h" });
    expect(openClawConfigSnapshotFromGetResponse({ type: "res", ok: false, payload: { raw: "{}", hash: "h" } }, "config.get")).toBeNull();
    expect(installedMethodsFromHello({ type: "res", ok: true, payload: { type: "hello-ok", features: { methods: ["future.plugin.rpc"] } } })).toEqual(new Set(["future.plugin.rpc"]));
  });
});
