import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { authorizeChannelAgentReadiness, CHANNEL_READINESS_AUTHORIZATION_PATH } from "./channel-agent-readiness-authorization-broker.js";

const root = mkdtempSync(join(tmpdir(), "channel-readiness-broker-"));
const tokenPath = join(root, "token");
writeFileSync(tokenPath, "projected-sa-token\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const args = { gatewayId: "gateway-alice", channelId: "a".repeat(26), authorization: "Bearer caller", baseUrl: "http://octogee-api:3001", tokenPath };
const metadata = { gatewayId: args.gatewayId, channelId: args.channelId, workspaceId: "alice", project: null,
  agentId: "octogee-alice-coach", agentMmUserId: "b".repeat(26), peerKind: "group" };
const response = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("channel readiness authorization broker client", () => {
  it("binds caller bearer, projected gateway identity and channel without forwarding caller-selected owner or agent", async () => {
    const fetchImpl = response(200, { ...metadata, token: "must-not-return" });
    await expect(authorizeChannelAgentReadiness({ ...args, fetchImpl })).resolves.toEqual({ kind: "authorized", authorization: metadata });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe(`http://octogee-api:3001${CHANNEL_READINESS_AUTHORIZATION_PATH}`);
    expect((init!.headers as Headers).get("authorization")).toBe("Bearer caller");
    expect((init!.headers as Headers).get("x-k8s-sa-token")).toBe("projected-sa-token");
    expect(init!.redirect).toBe("error");
    expect(JSON.parse(String(init!.body))).toEqual({ gatewayId: args.gatewayId, channelId: args.channelId });
  });
  it("fails locally without caller authentication or with an invalid channel", async () => {
    const fetchImpl = response(200, metadata);
    await expect(authorizeChannelAgentReadiness({ ...args, authorization: undefined, fetchImpl })).resolves.toEqual({ kind: "unauthenticated" });
    await expect(authorizeChannelAgentReadiness({ ...args, channelId: "../other", fetchImpl })).resolves.toEqual({ kind: "not_found" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])("propagates authentication or hidden membership refusal: %s", async (status) => {
    await expect(authorizeChannelAgentReadiness({ ...args, fetchImpl: response(status, {}) }))
      .resolves.toEqual({ kind: status === 401 ? "unauthenticated" : "not_found" });
  });
  it.each([
    { gatewayId: "gateway-other" }, { channelId: "c".repeat(26) }, { workspaceId: "../alice" },
    { project: 42 }, { agentMmUserId: "" }, { agentId: "" }, { peerKind: "direct" },
  ])("rejects substituted or malformed broker metadata: %j", async (changed) => {
    await expect(authorizeChannelAgentReadiness({ ...args, fetchImpl: response(200, { ...metadata, ...changed }) })).rejects.toThrow("malformed metadata");
  });
  it("does not turn broker outages into readiness false or access denial", async () => {
    await expect(authorizeChannelAgentReadiness({ ...args, fetchImpl: response(503, {}) })).rejects.toThrow("returned 503");
    await expect(authorizeChannelAgentReadiness({ ...args, fetchImpl: vi.fn(async () => { throw new Error("timeout"); }) })).rejects.toThrow("timeout");
  });
  it("requires a projected token and a trusted broker URL", async () => {
    const fetchImpl = response(200, metadata);
    await expect(authorizeChannelAgentReadiness({ ...args, tokenPath: join(root, "absent"), fetchImpl })).rejects.toThrow();
    await expect(authorizeChannelAgentReadiness({ ...args, baseUrl: "https://untrusted.example", fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
