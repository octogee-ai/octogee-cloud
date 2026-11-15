import { describe, expect, it, vi } from "vitest";
import { vmContext } from "../vm-client.js";

const context = { gatewayId: "gateway", ownerUid: "owner", computerInstanceId: "gce-vm:123", agentAccountId: "alex-coach", ownerMattermostUserId: null };

describe("VM context broker", () => {
  it("accepts a Hobby pod identity supplied by the broker", async () => {
    const hobby = { ...context, computerInstanceId: "cluster:12345678-1234-1234-1234-123456789abc" };
    expect(await vmContext({ agentId: "agent", signal: new AbortController().signal, readTokenImpl: async () => "token", fetchImpl: async () => Response.json(hobby) })).toEqual(hobby);
  });
  it("normalizes an old API's VM identity during the compatibility window", async () => {
    const { computerInstanceId: _id, ...fields } = context;
    expect(await vmContext({ agentId: "agent", signal: new AbortController().signal, readTokenImpl: async () => "token", fetchImpl: async () => Response.json({ ...fields, vmInstanceId: "123" }) })).toEqual(context);
  });

  it("normalizes the new API's dual identity to the same VM", async () => {
    expect(await vmContext({ agentId: "agent", signal: new AbortController().signal, readTokenImpl: async () => "token", fetchImpl: async () => Response.json({ ...context, vmInstanceId: "123" }) })).toEqual(context);
  });

  it.each(["456", "bad"])("rejects conflicting or malformed legacy VM identity %s", async (vmInstanceId) => {
    await expect(vmContext({ agentId: "agent", signal: new AbortController().signal, readTokenImpl: async () => "token", fetchImpl: async () => Response.json({ ...context, vmInstanceId }) })).rejects.toThrow("Invalid VM context");
  });

  it("uses tenant credentials and sends only the host-provided agent identity", async () => {
    const fetchImpl = vi.fn(async () => Response.json(context));
    const signal = new AbortController().signal;
    expect(await vmContext({ agentId: "octogee-alex-coach", signal, brokerUrl: "http://broker/", tokenPath: "/token", readTokenImpl: async () => " token\n", fetchImpl })).toEqual(context);
    expect(fetchImpl).toHaveBeenCalledWith("http://broker/internal/computer/agent-context", expect.objectContaining({
      method: "POST", headers: { "x-k8s-sa-token": "token", "content-type": "application/json" },
      body: JSON.stringify({ agentId: "octogee-alex-coach" }), signal: expect.any(AbortSignal),
    }));
  });

  it.each([{}, { ...context, ownerUid: "" }, { ...context, computerInstanceId: "wrong" }, { ...context, ownerMattermostUserId: "owner" }])("rejects malformed authority facts", async (body) => {
    await expect(vmContext({ agentId: "agent", signal: new AbortController().signal, readTokenImpl: async () => "token", fetchImpl: async () => Response.json(body) })).rejects.toThrow("Invalid VM context");
  });

  it("identifies VM unavailability without suggesting reauthorization", async () => {
    await expect(vmContext({ agentId: "agent", signal: new AbortController().signal, readTokenImpl: async () => "token", fetchImpl: async () => Response.json({ error: "computer-unavailable", detail: "private detail" }, { status: 409 }) }))
      .rejects.toThrow("VM is unavailable (computer-unavailable): the gateway VM is not ready. Retry when the VM is running.");
  });

  it.each([401, 403, 409, 500])("does not expose a rejected broker response body for HTTP %s", async (status) => {
    await expect(vmContext({ agentId: "agent", signal: new AbortController().signal, readTokenImpl: async () => "token", fetchImpl: async () => new Response("private detail", { status }) })).rejects.toThrow(`VM context request failed (${status})`);
  });

  it("does not expose an unrecognized broker error code", async () => {
    await expect(vmContext({ agentId: "agent", signal: new AbortController().signal, readTokenImpl: async () => "token", fetchImpl: async () => Response.json({ error: "private detail" }, { status: 409 }) }))
      .rejects.toThrow("VM context request failed (409)");
  });
});
