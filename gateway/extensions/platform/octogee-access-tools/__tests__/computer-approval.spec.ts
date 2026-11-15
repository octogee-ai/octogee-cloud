import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/core", () => ({
  definePluginEntry: (definition: unknown) => definition,
  jsonResult: (result: unknown) => ({ result }),
}));
const broker = vi.hoisted(() => ({ context: vi.fn() }));
vi.mock("../vm-client.js", () => ({ vmContext: broker.context }));

const facts = { gatewayId: "gateway", ownerUid: "owner", computerInstanceId: "gce-vm:123", agentAccountId: "alex-coach", ownerMattermostUserId: "o".repeat(26) };
const channelRequester = { channel: "mattermost", accountId: "alex-coach", senderId: "m".repeat(26) };

async function registeredHook() {
  const { default: plugin } = await import("../index.js");
  let hook: (event: any, context: any) => Promise<any> = async () => undefined;
  plugin.register({ registerTool() {}, on(name: string, handler: typeof hook) {
    if (name === "before_tool_call") hook = handler;
  } } as any);
  return hook;
}

function context(requester: Record<string, unknown> = channelRequester) {
  return { agentId: "octogee-alex-coach", runId: "run", toolCallId: "call", sessionKey: "session", abortSignal: new AbortController().signal, requester };
}

describe("registered computer owner approval", () => {
  beforeEach(() => { vi.clearAllMocks(); broker.context.mockResolvedValue({ ...facts }); });

  it("requires the gateway owner to approve another user's computer action", async () => {
    const result = await (await registeredHook())({ toolName: "computer", params: { ownerUid: "attacker" } }, context());
    expect(result?.requireApproval?.allowedDecisions).toEqual(["allow-once", "deny"]);
    const guard = result.requireApproval.reviewerGuard;
    expect(await guard.prepare({ decision: "allow-once", userId: "member" })).toBeNull();
    expect(await guard.prepare({ decision: "deny", userId: "member" })).toBeNull();
    const approve = await guard.prepare({ decision: "allow-once", userId: "owner", deviceId: "other-device" });
    expect(approve).toBeTypeOf("function");
    expect(() => approve()).not.toThrow();
  });

  it("lets the authenticated gateway owner use the existing computer capability", async () => {
    const hook = await registeredHook();
    expect(await hook({ toolName: "computer" }, context({ getAuthenticatedIdentity: () => ({ profileId: "profile", userId: "owner" }) }))).toBeUndefined();
    expect(await hook({ toolName: "browser" }, context({ ...channelRequester, senderId: facts.ownerMattermostUserId }))).toBeUndefined();
    expect(await hook({ toolName: "nodes", params: { action: "invoke", invokeCommand: "computer.act" } }, context({ ...channelRequester, senderId: facts.ownerMattermostUserId }))).toBeUndefined();
  });

  it("authorizes the Hobby owner and invalidates pending approval after pod replacement", async () => {
    broker.context.mockResolvedValue({ ...facts, computerInstanceId: "cluster:12345678-1234-1234-1234-123456789abc" });
    const hook = await registeredHook();
    expect(await hook({ toolName: "computer" }, context({ getAuthenticatedIdentity: () => ({ profileId: "profile", userId: "owner" }) }))).toBeUndefined();
    const result = await hook({ toolName: "browser" }, context());
    broker.context.mockResolvedValue({ ...facts, computerInstanceId: "cluster:87654321-1234-1234-1234-123456789abc" });
    await expect(result.requireApproval.reviewerGuard.prepare({ decision: "allow-once", userId: "owner" })).rejects.toThrow("instance changed");
  });

  it.each(["computer.act", "system.execApprovals.set"])("requires the same owner approval for nodes invoking %s", async (invokeCommand) => {
    const hook = await registeredHook();
    const event = { toolName: "nodes", params: { action: "invoke", invokeCommand } };
    const result = await hook(event, context());
    expect(result?.requireApproval?.allowedDecisions).toEqual(["allow-once", "deny"]);
    const guard = result.requireApproval.reviewerGuard;
    expect(await guard.prepare({ decision: "allow-once", userId: "member" })).toBeNull();
    expect(await guard.prepare({ decision: "allow-once", userId: "owner" })).toBeTypeOf("function");
    expect(await hook(event, context({}))).toMatchObject({ block: true });
  });

  it("requires exact channel account and sender identity for the owner reviewer", async () => {
    const result = await (await registeredHook())({ toolName: "browser" }, context());
    const guard = result.requireApproval.reviewerGuard;
    expect(await guard.prepare({ decision: "allow-once", channel: { channel: "mattermost", accountId: "other", senderId: facts.ownerMattermostUserId } })).toBeNull();
    expect(await guard.prepare({ decision: "allow-once", channel: { channel: "mattermost", accountId: facts.agentAccountId, senderId: facts.ownerMattermostUserId } })).toBeTypeOf("function");
    expect(await guard.prepare({ decision: "allow-once", userId: "member", channel: { channel: "mattermost", accountId: facts.agentAccountId, senderId: facts.ownerMattermostUserId } })).toBeNull();
  });

  it.each(["ownerUid", "computerInstanceId"])("rejects approval after %s changes", async (field) => {
    const result = await (await registeredHook())({ toolName: "computer" }, context());
    broker.context.mockResolvedValue({ ...facts, [field]: "replacement" });
    await expect(result.requireApproval.reviewerGuard.prepare({ decision: "allow-once", userId: "owner" })).rejects.toThrow("changed");
  });

  it("rechecks browser requester authority after awaiting owner approval", async () => {
    let connected = true;
    const result = await (await registeredHook())({ toolName: "computer" }, context({ getAuthenticatedIdentity: () => connected ? { profileId: "member-profile", userId: "member" } : undefined }));
    const approve = await result.requireApproval.reviewerGuard.prepare({ decision: "allow-once", userId: "owner" });
    connected = false;
    expect(() => approve()).toThrow("requester");
    expect(() => result.requireApproval.reviewerGuard.assertActive()).toThrow("requester");
  });

  it("cancels approval when its tool call is aborted", async () => {
    const controller = new AbortController();
    const result = await (await registeredHook())({ toolName: "computer" }, { ...context(), abortSignal: controller.signal });
    controller.abort();
    expect(() => result.requireApproval.reviewerGuard.assertActive()).toThrow();
  });

  it("blocks unverified or conflicting requesters and does not infer ownership from labels", async () => {
    const hook = await registeredHook();
    for (const requester of [{ senderId: "owner", senderIsOwner: true }, { ...channelRequester, accountId: "other" }, {}, { ...channelRequester, senderId: facts.ownerMattermostUserId, getAuthenticatedIdentity: () => undefined }]) {
      expect(await hook({ toolName: "computer" }, context(requester))).toMatchObject({ block: true });
    }
  });

  it("uses the authenticated browser requester instead of conflicting channel labels", async () => {
    const result = await (await registeredHook())({ toolName: "computer" }, context({ ...channelRequester, senderId: facts.ownerMattermostUserId, getAuthenticatedIdentity: () => ({ profileId: "member-profile", userId: "member" }) }));
    expect(result.requireApproval.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("reports broker failure and leaves unrelated tools alone", async () => {
    broker.context.mockRejectedValue(new Error("offline"));
    const hook = await registeredHook();
    expect(await hook({ toolName: "computer" }, context())).toMatchObject({ block: true, blockReason: expect.stringContaining("offline") });
    expect(await hook({ toolName: "web_search" }, context())).toBeUndefined();
  });
});
