import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  read: vi.fn(),
}));
vi.mock("../middleware/auth.js", () => { throw new Error("Gateway sidecar must not verify Firebase through Firestore"); });
vi.mock("../lib/channel-agent-readiness-authorization-broker.js", () => ({ authorizeChannelAgentReadiness: mocks.authorize }));
vi.mock("../lib/channel-agent-readiness.js", () => ({ readChannelAgentReadiness: mocks.read }));
vi.mock("../middleware/logging.js", () => ({ logger: { error: vi.fn() } }));

import { createChannelAgentReadinessRouter } from "./channel-agent-readiness.js";

const channelId = "a".repeat(26);
const scope = { workspaceId: "alice", project: null, channelId, agentId: "octogee-alice-coach", peerKind: "group" };
const authorization = { gatewayId: "gateway-alice", ...scope, agentMmUserId: "b".repeat(26) };
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe("channel readiness on a sidecar without datastore access", () => {
  it.each([false, true])("authorizes through the broker before reading native readiness=%s", async (ready) => {
    vi.stubEnv("GATEWAY_ID", "gateway-alice");
    mocks.authorize.mockResolvedValue({ kind: "authorized", authorization });
    mocks.read.mockResolvedValue(ready);
    const app = express();
    app.disable("x-powered-by");
    app.use("/api/g/:gatewayId/channel-agent-readiness", createChannelAgentReadinessRouter());

    const response = await request(app).get(`/api/g/gateway-alice/channel-agent-readiness/${channelId}`)
      .set("authorization", "Bearer firebase-caller");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ channelId, agentMmUserId: authorization.agentMmUserId, ready });
    expect(mocks.authorize).toHaveBeenCalledWith({ gatewayId: "gateway-alice", channelId, authorization: "Bearer firebase-caller" });
    expect(mocks.read).toHaveBeenCalledWith(scope);
  });
});
