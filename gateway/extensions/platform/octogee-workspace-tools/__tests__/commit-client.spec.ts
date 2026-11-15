import { createHmac } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { createCommitClient, COMMIT_PATH } from "../commit-client.js";

interface FakeCall { url: string; method: string; headers: Record<string, string>; body: unknown }

function fakeFetch(res: { ok: boolean; status: number; payload: unknown } | (() => never)) {
  const calls: FakeCall[] = [];
  const impl = async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body ? JSON.parse(init.body) : undefined });
    if (typeof res === "function") res();
    return {
      ok: res.ok,
      status: res.status,
      json: async () => res.payload,
      text: async () => JSON.stringify(res.payload),
    };
  };
  return { impl, calls };
}

const CONTROL = "http://127.0.0.1:3001";
const AGENT_ID = "octogee-acme-coach";
const SECRET = "coach-mattermost-pat";

function clientOptions(fetchImpl: ReturnType<typeof fakeFetch>["impl"]) {
  return {
    controlUrl: CONTROL,
    fetchImpl,
    agentProofSecretProvider: async () => SECRET,
    now: () => 1_785_000_000_000,
  };
}

describe("commit-client.commit", () => {
  it("POSTs slug + message to the internal commit path and returns the result", async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, payload: { committed: true, pushed: true, nothingToCommit: false, divertedBlobs: 0 } });
    const client = createCommitClient(clientOptions(impl));

    const r = await client.commit(AGENT_ID, "acme", "agent: finished onboarding");

    expect(r).toEqual({ committed: true, pushed: true, nothingToCommit: false, divertedBlobs: 0 });
    expect(calls[0]).toMatchObject({
      url: `${CONTROL}${COMMIT_PATH}`,
      method: "POST",
      body: { agentId: AGENT_ID, slug: "acme", message: "agent: finished onboarding" },
    });
    const timestamp = calls[0].headers["x-octogee-agent-proof-timestamp"];
    expect(timestamp).toBe("1785000000000");
    expect(calls[0].headers["x-octogee-agent-proof-signature"]).toBe(
      createHmac("sha256", SECRET)
        .update(`octogee-workspace-commit-v1\n${timestamp}\n${COMMIT_PATH}\n${JSON.stringify(calls[0].body)}`)
        .digest("hex"),
    );
  });

  it("omits message when not provided", async () => {
    const { impl, calls } = fakeFetch({
      ok: true,
      status: 200,
      payload: { committed: true, pushed: true, nothingToCommit: false, divertedBlobs: 0 },
    });
    const client = createCommitClient(clientOptions(impl));
    await client.commit(AGENT_ID, "acme");
    expect(calls[0].body).toEqual({ agentId: AGENT_ID, slug: "acme" });
  });

  it("reports a clean no-op when there was nothing to commit", async () => {
    const { impl } = fakeFetch({ ok: true, status: 200, payload: { committed: false, pushed: true, nothingToCommit: true, divertedBlobs: 2 } });
    const client = createCommitClient(clientOptions(impl));
    expect(await client.commit(AGENT_ID, "acme")).toEqual({ committed: false, pushed: true, nothingToCommit: true, divertedBlobs: 2 });
  });

  it("rejects an incomplete success response", async () => {
    const { impl } = fakeFetch({ ok: true, status: 200, payload: { committed: true } });
    const client = createCommitClient(clientOptions(impl));
    await expect(client.commit(AGENT_ID, "acme")).rejects.toMatchObject({ code: "bad-response" });
  });

  it("rejects a success response when the checkpoint did not reach the remote", async () => {
    const { impl } = fakeFetch({ ok: true, status: 200, payload: { committed: true, pushed: false, nothingToCommit: false, divertedBlobs: 0 } });
    const client = createCommitClient(clientOptions(impl));
    await expect(client.commit(AGENT_ID, "acme")).rejects.toMatchObject({ code: "control-error" });
  });

  it("maps a non-ok response to control-error", async () => {
    const { impl } = fakeFetch({ ok: false, status: 500, payload: { error: "push failed" } });
    const client = createCommitClient(clientOptions(impl));
    await expect(client.commit(AGENT_ID, "acme")).rejects.toMatchObject({ code: "control-error" });
  });

  it("carries the gateway-edge code through so the agent can tell the failures apart", async () => {
    const { impl } = fakeFetch({
      ok: false,
      status: 503,
      payload: { error: "Agent identity verification temporarily unavailable.", code: "PROOF_UNAVAILABLE", paths: ["large.zip"] },
    });
    const client = createCommitClient(clientOptions(impl));
    await expect(client.commit(AGENT_ID, "acme")).rejects.toMatchObject({
      code: "control-error",
      edgeCode: "PROOF_UNAVAILABLE",
      paths: ["large.zip"],
    });
  });

  it("maps an unreachable endpoint to control-error", async () => {
    const fetchImpl = (() => { throw new Error("ECONNREFUSED"); }) as never;
    const client = createCommitClient(clientOptions(fetchImpl));
    await expect(client.commit(AGENT_ID, "acme")).rejects.toMatchObject({ code: "control-error" });
  });

  it("bounds a stalled gateway-edge commit request", async () => {
    const fetchImpl = vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const client = createCommitClient({
      controlUrl: CONTROL,
      fetchImpl,
      agentProofSecretProvider: async () => SECRET,
      timeoutMs: 1,
    });

    await expect(client.commit(AGENT_ID, "acme")).rejects.toMatchObject({ code: "control-error" });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("treats an incomplete success body as bad-response", async () => {
    const { impl } = fakeFetch({ ok: true, status: 200, payload: { pushed: true } });
    const client = createCommitClient(clientOptions(impl));
    await expect(client.commit(AGENT_ID, "acme")).rejects.toMatchObject({ code: "bad-response" });
  });

  it("fails closed before the request when the selected agent secret is unavailable", async () => {
    const { impl, calls } = fakeFetch({ ok: true, status: 200, payload: {} });
    const client = createCommitClient({
      controlUrl: CONTROL,
      fetchImpl: impl,
      agentProofSecretProvider: async () => null,
    });
    await expect(client.commit(AGENT_ID, "acme")).rejects.toMatchObject({ code: "control-error" });
    expect(calls).toEqual([]);
  });
});

describe("commit-client — multi-agent project lane", () => {
  it("sends the project id when given", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const client = createCommitClient({
      fetchImpl: async (url, init) => {
        calls.push({ url, body: init?.body ?? "" });
        return { ok: true, status: 200, json: async () => ({ committed: true, pushed: true, nothingToCommit: false, divertedBlobs: 0 }) };
      },
      agentProofSecretProvider: async () => SECRET,
    });

    await client.commit("octogee-alice-proj-orbit-coach", "alice", "checkpoint", "orbit");

    expect(JSON.parse(calls[0].body)).toEqual({
      agentId: "octogee-alice-proj-orbit-coach",
      slug: "alice",
      message: "checkpoint",
      project: "orbit",
    });
  });
});
