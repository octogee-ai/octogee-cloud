import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachUpstreamRpcClient,
  type UpstreamRpcClient,
} from "./bridge-upstream-rpc.js";

class FakeWs extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  simulateMessage(data: unknown) {
    this.emit("message", JSON.stringify(data));
  }
}

describe("attachUpstreamRpcClient", () => {
  let ws: FakeWs;
  let client: UpstreamRpcClient;

  beforeEach(() => {
    ws = new FakeWs();
    client = attachUpstreamRpcClient(ws as unknown as import("ws").WebSocket);
  });

  afterEach(() => {
    client.dispose();
  });

  it("sends a canonical req envelope when call() is invoked", async () => {
    const promise = client.call("exec.approval.resolve", {
      approvalId: "appr-1",
      decision: "approved",
      resolvedBy: "@bob",
    });
    expect(ws.sent.length).toBe(1);
    const sent = JSON.parse(ws.sent[0]);
    expect(sent).toMatchObject({
      type: "req",
      method: "exec.approval.resolve",
      params: { approvalId: "appr-1" },
    });
    expect(typeof sent.id).toBe("string");

    ws.simulateMessage({ type: "res", id: sent.id, ok: true, payload: { ok: true } });
    const result = await promise;
    expect(result).toEqual({ ok: true, result: { ok: true } });
  });

  it("rejects via the returned ok:false shape on response.ok === false", async () => {
    const promise = client.call("plugin.approval.resolve", { approvalId: "appr-2", decision: "denied" });
    const sentId = JSON.parse(ws.sent[0]).id;
    ws.simulateMessage({ type: "res", id: sentId, ok: false, error: { code: "NOT_FOUND", message: "no such approval" } });
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("no such approval"), error: { code: "NOT_FOUND", message: "no such approval" } });
  });

  it("retains native revision-conflict details for scoped mutation clients", async () => {
    const promise = client.call("cron.update", { id: "job", expectedConfigRevision: "old", patch: { enabled: false } });
    const id = JSON.parse(ws.sent[0]).id;
    const error = { code: "INVALID_REQUEST", message: "Job changed", details: { code: "CRON_JOB_CHANGED", expectedConfigRevision: "old", actualConfigRevision: "new" } };
    ws.simulateMessage({ type: "res", id, ok: false, error });
    await expect(promise).resolves.toEqual({ ok: false, reason: "Job changed", error });
  });

  it("times out after the configured window if no response arrives", async () => {
    const fastClient = attachUpstreamRpcClient(ws as unknown as import("ws").WebSocket, {
      timeoutMs: 30,
    });
    const result = await fastClient.call("exec.approval.resolve", { approvalId: "appr-3" });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("timeout") });
    fastClient.dispose();
  });

  it("ignores response envelopes whose id doesn't match any in-flight call (no crash)", async () => {
    const promise = client.call("exec.approval.resolve", { approvalId: "appr-4" });
    ws.simulateMessage({ type: "res", id: "unrelated-id", ok: true, payload: {} });
    const sentId = JSON.parse(ws.sent[0]).id;
    ws.simulateMessage({ type: "res", id: sentId, ok: true, payload: {} });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("ignores non-response frames (e.g. agent events bound for another consumer)", async () => {
    ws.simulateMessage({ type: "event", event: "agent", payload: { runId: "r" } });
    ws.simulateMessage("not-json");
    expect(true).toBe(true);
  });

  it("dispose() clears in-flight calls (returns timeout-shape rejection)", async () => {
    const promise = client.call("exec.approval.resolve", { approvalId: "appr-5" });
    client.dispose();
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("dispose") });
  });

  it("close event on the WS rejects all in-flight calls", async () => {
    const a = client.call("exec.approval.resolve", { approvalId: "a" });
    const b = client.call("plugin.approval.resolve", { approvalId: "b" });
    ws.emit("close");
    await expect(a).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("closed") });
    await expect(b).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("closed") });
  });
});
