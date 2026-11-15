import { describe, expect, it, vi } from "vitest";
import { runNativeConnectorApproval } from "./native-connector-approval.js";

const identity = { gatewayId: "alice-user", ownerUid: "alice", agentId: "octogee-alice-coach" };
const nativeId = "plugin:9a90f032-1b23-4ff7-810d-222adff271dd";
const pending = { id: nativeId, status: "pending", expiresAtMs: 12345,
  presentation: { kind: "plugin", pluginId: "octogee-connector-tools", agentId: identity.agentId } };
function harness(scopes = ["operator.approvals"]) {
  const call = vi.fn().mockResolvedValue({ ok: true, result: { approval: pending } });
  const client = { call, scopes: new Set(scopes), close: vi.fn() };
  return { client, call, openService: vi.fn().mockResolvedValue(client), openUser: vi.fn().mockResolvedValue(client) };
}

describe("native connector approval authority", () => {
  it("uses a delegated reviewer's native identity, never the service identity, for a user decision", async () => {
    const h = harness();
    await runNativeConnectorApproval({ ...identity, operation: "resolve", nativeId, reviewerUid: "delegate", decision: "deny" },
      { ...h, isolated: true });
    expect(h.openUser).toHaveBeenCalledWith("delegate", identity.gatewayId);
    expect(h.openService).not.toHaveBeenCalled();
    expect(h.call).toHaveBeenLastCalledWith("approval.resolve", { id: nativeId, kind: "plugin", decision: "deny" });
    expect(h.client.close).toHaveBeenCalled();
  });

  it("does not elevate a user member without approval scopes", async () => {
    const h = harness(["operator.read"]);
    await expect(runNativeConnectorApproval({ ...identity, operation: "get", nativeId, reviewerUid: "member" },
      { ...h, isolated: true })).rejects.toMatchObject({ status: 403, code: "approval_forbidden" });
    expect(h.call).not.toHaveBeenCalled();
    expect(h.openService).not.toHaveBeenCalled();
  });

  it("keeps Shared decisions owner-bound", async () => {
    const h = harness();
    await expect(runNativeConnectorApproval({ ...identity, operation: "resolve", nativeId, reviewerUid: "delegate", decision: "deny" },
      { ...h, isolated: false })).rejects.toThrow("Shared approval");
    expect(h.openService).not.toHaveBeenCalled();
  });

  it("honors native visibility or revoked-role refusal without falling back to the service identity", async () => {
    const h = harness();
    h.call.mockResolvedValue({ ok: false, reason: "approval not found or not authorized" });
    await expect(runNativeConnectorApproval({ ...identity, operation: "resolve", nativeId, reviewerUid: "delegate", decision: "deny" },
      { ...h, isolated: true })).rejects.toThrow("not authorized");
    expect(h.call).toHaveBeenCalledTimes(1);
    expect(h.call).toHaveBeenCalledWith("approval.get", { id: nativeId });
    expect(h.openService).not.toHaveBeenCalled();
    expect(h.client.close).toHaveBeenCalled();
  });

  it("refuses another agent's native approval even for a native administrator", async () => {
    const h = harness(["operator.admin"]);
    h.call.mockResolvedValue({ ok: true, result: { approval: { ...pending, presentation: { ...pending.presentation, agentId: "octogee-bob-coach" } } } });
    await expect(runNativeConnectorApproval({ ...identity, operation: "resolve", nativeId, reviewerUid: "alice", decision: "deny" },
      { ...h, isolated: true })).rejects.toThrow("binding");
    expect(h.call).toHaveBeenCalledTimes(1);
  });

  it("requests native delivery to the canonical Agent DM offering only Deny, with approval in Octogee", async () => {
    const h = harness();
    h.call.mockResolvedValue({ ok: true, result: { status: "accepted", id: nativeId, expiresAtMs: 12345 } });
    await runNativeConnectorApproval({ ...identity, operation: "create", title: "Send email", detail: "Exact preview", actionUrl: "https://app.octogee.com/settings?productivityApproval=test", coachChannelId: "c".repeat(26) },
      { ...h, isolated: false });
    expect(h.call).toHaveBeenCalledWith("plugin.approval.request", expect.objectContaining({
      allowedDecisions: ["deny"], twoPhase: true, timeoutMs: 600_000,
      turnSourceChannel: "mattermost", turnSourceTo: `channel:${"c".repeat(26)}`,
      turnSourceAccountId: "alice-coach", description: expect.stringContaining("https://app.octogee.com"),
    }));
  });

  it("returns the native first answer when another surface already denied", async () => {
    const h = harness();
    const denied = { ...pending, status: "denied", decision: "deny" };
    h.call.mockResolvedValueOnce({ ok: true, result: { approval: pending } })
      .mockResolvedValueOnce({ ok: true, result: { applied: false, approval: denied } });
    const result = await runNativeConnectorApproval({ ...identity, operation: "resolve", nativeId, reviewerUid: "delegate", decision: "deny" }, { ...h, isolated: true });
    expect(result).toEqual({ applied: false, approval: denied });
  });
});
