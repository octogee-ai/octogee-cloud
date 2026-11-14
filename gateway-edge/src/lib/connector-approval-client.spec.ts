import { afterEach, describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { connectorApprovalRpc, requestConnectorApproval } from "./connector-approval-client.js";

vi.mock("./byot-sync-trigger.js", () => ({ gatewayModelCredentialSyncUrl: () => "http://gateway/model-credential-sync" }));
vi.mock("./byot-sync-internal-auth.js", () => ({ createModelCredentialSyncAuthHeaders: () => ({}) }));
afterEach(() => vi.unstubAllGlobals());

function harness() {
  const docs: Record<string, unknown> = {
    "workspaces/alice": { id: "alice", ownerUid: "owner" },
    "workspaces/alice/channels/coach-dm": { mattermost: { channelId: "c".repeat(26) } },
    "users/owner": { provisioning: { openclaw: { gatewayId: "b-alice" } } },
    "gateways/b-alice": {
      gatewayId: "b-alice", createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test",
      latestRelease: 1, desiredRelease: 1, liveRelease: 1, desiredStatus: "running", configSchemaVersion: 1,
      profile: "isolated", gatewayClass: "isolated", imageProfile: "isolated", sizingTier: null, gcpProject: null,
      gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null,
      builderAccess: { controlUiEnabled: true, controlIdentity: "per-user" }, ownerUid: "owner", builderSlug: "alice",
      modelBrokerLimits: null, preemption: null,
    },
    "gateways/b-alice/assignments/owner": {
      uid: "owner", slug: "alice", gatewayId: "b-alice", source: "onboarding", state: "serving", epoch: 1, updatedAt: 1, updatedByOperationId: null,
    },
  };
  const store = createDocumentFixtureStore(docs as Record<string, Record<string, unknown>>);
  const input = { ownerUid: "owner", gatewayId: "b-alice", agentId: "octogee-alice-coach", kind: "gmail-send",
    digest: "a".repeat(64), preview: { subject: "Private preview" }, actionUrl: "https://app.octogee.com/settings?productivityApproval=action&nonce=secret" };
  const rpc = vi.fn().mockResolvedValue({ id: "plugin:native-request", expiresAtMs: 100_000 });
  return { docs, store, input, rpc };
}
describe("connector approval native creation", () => {
  it("preserves an explicit native permission denial without exposing upstream detail", async () => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "approval_forbidden" }), { status: 403 })));
    await expect(connectorApprovalRpc(h.store, {})({ operation: "get", ownerUid: "owner", gatewayId: "b-alice", agentId: h.input.agentId, nativeId: "plugin:test" }))
      .rejects.toMatchObject({ status: 403, code: "approval_forbidden" });
  });
  it.each([JSON.stringify({ error: "reviewer_mismatch" }), "intermediary refusal"])("keeps other upstream 403 responses as bridge failures: %s", async body => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 403 })));
    await expect(connectorApprovalRpc(h.store, {})({ operation: "get", ownerUid: "owner", gatewayId: "b-alice", agentId: h.input.agentId, nativeId: "plugin:test" }))
      .rejects.toThrow("HTTP 403");
  });
  it("does not turn an unknown upstream failure into a permission denial", async () => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream detail", { status: 500 })));
    await expect(connectorApprovalRpc(h.store, {})({ operation: "get", ownerUid: "owner", gatewayId: "b-alice", agentId: h.input.agentId, nativeId: "plugin:test" }))
      .rejects.toThrow("HTTP 500");
  });
  it("uses the private canonical Agent channel and preserves the exact preview link and action hash", async () => {
    const h = harness();
    await expect(requestConnectorApproval(h.store, h.rpc, h.input)).resolves.toEqual({ nativeApprovalId: "plugin:native-request", expiresAtMs: 100_000 });
    expect(h.rpc).toHaveBeenCalledWith(expect.objectContaining({ operation: "create", coachChannelId: "c".repeat(26),
      detail: expect.stringContaining(h.input.digest), actionUrl: h.input.actionUrl }));
    expect(h.rpc.mock.calls[0][0].detail).toContain("Private preview");
  });
  it.each(["missing-coach", "foreign-owner"])("does not deliver private approval details with %s", async change => {
    const h = harness();
    if (change === "missing-coach") delete h.docs["workspaces/alice/channels/coach-dm"];
    else h.docs["workspaces/alice"] = { id: "alice", ownerUid: "someone-else" };
    await expect(requestConnectorApproval(h.store, h.rpc, h.input)).rejects.toThrow("Canonical Agent DM");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it.each(["none", "default", undefined])("discloses %s reminders even when the native event preview exceeds the display limit", async reminders => {
    const h = harness();
    await requestConnectorApproval(h.store, h.rpc, { ...h.input, kind: "calendar-create",
      preview: { description: "x".repeat(13_000), ...(reminders === undefined ? {} : { reminders }) } });
    const detail = h.rpc.mock.calls[0][0].detail;
    expect(detail).toContain(reminders === "none" ? "Reminders: No reminders" : "Reminders: Calendar defaults");
    expect(detail).toContain("exceeds the native display limit");
    expect(detail).toContain(h.input.digest);
    expect(detail).toContain(h.input.actionUrl);
  });
  it("refuses an invalid Calendar reminder preview before requesting native approval", async () => {
    const h = harness();
    await expect(requestConnectorApproval(h.store, h.rpc, { ...h.input, kind: "calendar-create", preview: { reminders: "email" } }))
      .rejects.toThrow("reminder policy");
    expect(h.rpc).not.toHaveBeenCalled();
  });
  it("makes the native display limit explicit instead of silently truncating a long message", async () => {
    const h = harness(); h.input.preview.subject = "x".repeat(20_000);
    await requestConnectorApproval(h.store, h.rpc, h.input);
    const command = h.rpc.mock.calls[0][0];
    expect(command.detail).toContain("exceeds the native display limit");
    expect(command.detail).toContain(h.input.actionUrl);
    expect(command.detail.length).toBeLessThan(16_384);
  });
  it("does not follow a user's new placement to resolve an old gateway approval", async () => {
    const h = harness();
    await expect(connectorApprovalRpc(h.store, {})({ operation: "get", ownerUid: "owner", gatewayId: "old-gateway", agentId: h.input.agentId, nativeId: "plugin:old" })).rejects.toThrow("assignment changed");
  });
});
