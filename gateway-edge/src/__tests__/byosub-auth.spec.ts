import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_UID = "uid-tester5";

vi.mock("../middleware/auth.js", () => ({
  requireAuthenticatedUid: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as { uid?: string }).uid = TEST_UID;
    next();
  },
}));

const resolveByosubUserGateway = vi.fn();
const readByosubFlow = vi.fn();
vi.mock("../lib/byosub-broker.js", () => ({
  resolveByosubUserGateway: (...a: unknown[]) => resolveByosubUserGateway(...a),
  readByosubFlow: (...a: unknown[]) => readByosubFlow(...a),
}));

const firestore = vi.hoisted(() => ({
  doc: vi.fn(),
  collection: vi.fn(),
  readGatewayAuthorization: vi.fn(),
}));
vi.mock("../lib/db.js", () => ({
  db: { doc: firestore.doc, collection: firestore.collection },
}));
vi.mock("@octogee/core/gateway-live-release", () => ({
  readGatewayAuthorizationInStore: (...args: unknown[]) => firestore.readGatewayAuthorization(...args),
}));

const ssoStart = vi.fn();
const ssoStatus = vi.fn();
const ssoSubmit = vi.fn();
const deviceStart = vi.fn();
const brokerByosubFlow = vi.fn();
vi.mock("../lib/byosub.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    brokerByosubFlow: (...a: unknown[]) => brokerByosubFlow(...a),
    gatewayClaudeSsoClient: () => ({ start: ssoStart, status: ssoStatus, submit: ssoSubmit }),
    gatewayDeviceAuthClient: () => ({ start: deviceStart, status: vi.fn() }),
  };
});

import { createByosubAuthRouter } from "../routes/byosub-auth.js";
import { userDefaultAgentId } from "../lib/byosub.js";

const AGENT = userDefaultAgentId("tester5");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/byosub", createByosubAuthRouter());
  return a;
}

describe("byosub-auth sidecar router", () => {
  beforeEach(() => {
    process.env.GATEWAY_ID = "walter";
    process.env.GATEWAY_CLASS = "isolated";
    resolveByosubUserGateway.mockReset().mockResolvedValue({ slug: "tester5", gatewayId: "walter" });
    readByosubFlow.mockReset();
    firestore.doc.mockReset();
    firestore.collection.mockReset();
    firestore.readGatewayAuthorization.mockReset();
    ssoStart.mockReset();
    ssoStatus.mockReset();
    ssoSubmit.mockReset();
    deviceStart.mockReset();
    brokerByosubFlow.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    delete process.env.GATEWAY_ID;
    delete process.env.GATEWAY_CLASS;
  });

  it("connect (anthropic): starts the in-pod SSO flow locally and brokers the flow write", async () => {
    ssoStart.mockResolvedValue({ flowId: "f1", verificationUrl: "https://x", state: "pending" });
    const res = await request(app()).post("/byosub/connect").send({ provider: "anthropic" });
    expect(res.status).toBe(200);
    expect(res.body.flowId).toBe("f1");
    expect(ssoStart).toHaveBeenCalledWith({ gatewayId: "walter", agentId: AGENT });
    expect(brokerByosubFlow).toHaveBeenCalledWith({
      flowId: "f1",
      agentId: AGENT,
      provider: "anthropic",
    });
  });

  it("connect: 409 not_on_this_pod when the user's gateway is not this pod", async () => {
    resolveByosubUserGateway.mockResolvedValue({ slug: "tester5", gatewayId: "other-gw" });
    const res = await request(app()).post("/byosub/connect").send({ provider: "anthropic" });
    expect(res.status).toBe(409);
    expect(ssoStart).not.toHaveBeenCalled();
    expect(brokerByosubFlow).not.toHaveBeenCalled();
  });

  it("connect: refuses the shared gateway from the pod's own class, never reading Firestore", async () => {
    process.env.GATEWAY_CLASS = "shared";

    const res = await request(app()).post("/byosub/connect").send({ provider: "anthropic" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "subscription-runtime-required" });
    expect(ssoStart).not.toHaveBeenCalled();
    expect(brokerByosubFlow).not.toHaveBeenCalled();
    expect(firestore.readGatewayAuthorization).not.toHaveBeenCalled();
    expect(firestore.doc).not.toHaveBeenCalled();
    expect(firestore.collection).not.toHaveBeenCalled();
  });

  it("connect: refuses when the pod does not declare a isolated class", async () => {
    delete process.env.GATEWAY_CLASS;

    const res = await request(app()).post("/byosub/connect").send({ provider: "anthropic" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "subscription-runtime-required" });
    expect(ssoStart).not.toHaveBeenCalled();
  });

  it("connect: starts the user flow without touching Firestore", async () => {
    ssoStart.mockResolvedValue({ flowId: "f1", verificationUrl: "https://x", state: "pending" });

    const res = await request(app()).post("/byosub/connect").send({ provider: "anthropic" });

    expect(res.status).toBe(200);
    expect(firestore.readGatewayAuthorization).not.toHaveBeenCalled();
    expect(firestore.doc).not.toHaveBeenCalled();
    expect(firestore.collection).not.toHaveBeenCalled();
  });

  it("connect: 400 on an unsupported provider", async () => {
    const res = await request(app()).post("/byosub/connect").send({ provider: "nope" });
    expect(res.status).toBe(400);
  });

  it("connect: 400 when the user has no provisioned gateway", async () => {
    resolveByosubUserGateway.mockResolvedValue(null);
    const res = await request(app()).post("/byosub/connect").send({ provider: "anthropic" });
    expect(res.status).toBe(400);
  });

  it("connect: 503 (surfaced) when the in-pod start fails — flow is NOT brokered", async () => {
    ssoStart.mockRejectedValue(new Error("gateway 401 unauthorized"));
    const res = await request(app()).post("/byosub/connect").send({ provider: "anthropic" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/401/);
    expect(brokerByosubFlow).not.toHaveBeenCalled();
  });

  it("bounds sign-in starts without blocking status checks for an existing flow", async () => {
    ssoStart.mockResolvedValue({ flowId: "f1", verificationUrl: "https://x", state: "pending" });
    readByosubFlow.mockResolvedValue({ uid: TEST_UID, gatewayId: "walter", agentId: AGENT, provider: "anthropic" });
    ssoStatus.mockResolvedValue({ state: "pending" });
    const client = request(app());
    for (let attempt = 0; attempt < 12; attempt++) await client.post("/byosub/connect").send({ provider: "anthropic" }).expect(200);
    await client.post("/byosub/connect").send({ provider: "anthropic" }).expect(429);
    expect(ssoStart).toHaveBeenCalledTimes(12);
    await client.get("/byosub/status/f1").expect(200);
  });

  it("status: reads the brokered flow and proxies the in-pod status for the owner", async () => {
    readByosubFlow.mockResolvedValue({ uid: TEST_UID, gatewayId: "walter", agentId: AGENT, provider: "anthropic" });
    ssoStatus.mockResolvedValue({ state: "pending" });
    const res = await request(app()).get("/byosub/status/f1");
    expect(res.status).toBe(200);
    expect(ssoStatus).toHaveBeenCalledWith({ gatewayId: "walter", flowId: "f1" });
  });

  it("status: 404 when the flow belongs to a different user", async () => {
    readByosubFlow.mockResolvedValue({ uid: "someone-else", gatewayId: "walter", agentId: AGENT, provider: "anthropic" });
    const res = await request(app()).get("/byosub/status/f1");
    expect(res.status).toBe(404);
    expect(ssoStatus).not.toHaveBeenCalled();
  });

  it("status: 409 when the flow belongs to a different pod", async () => {
    readByosubFlow.mockResolvedValue({ uid: TEST_UID, gatewayId: "other-gw", agentId: AGENT, provider: "anthropic" });
    const res = await request(app()).get("/byosub/status/f1");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "not_on_this_pod" });
    expect(ssoStatus).not.toHaveBeenCalled();
  });

  it("sso/submit: proxies the in-pod submit for the owner", async () => {
    readByosubFlow.mockResolvedValue({ uid: TEST_UID, gatewayId: "walter", agentId: AGENT, provider: "anthropic" });
    ssoSubmit.mockResolvedValue({ state: "connected" });
    const res = await request(app()).post("/byosub/sso/submit").send({ flowId: "f1", code: "abc" });
    expect(res.status).toBe(200);
    expect(ssoSubmit).toHaveBeenCalledWith({ gatewayId: "walter", flowId: "f1", code: "abc" });
  });

  it.each([42, ["f1"], { id: "f1" }])("sso/submit: rejects a non-string flow id before broker lookup", async flowId => {
    await request(app()).post("/byosub/sso/submit").send({ flowId, code: "abc" }).expect(400);
    expect(readByosubFlow).not.toHaveBeenCalled();
    expect(ssoSubmit).not.toHaveBeenCalled();
  });

  it("sso/submit: rejects an identifier with a path separator before broker lookup", async () => {
    await request(app()).post("/byosub/sso/submit").send({ flowId: "flow/other", code: "abc" }).expect(400);
    expect(readByosubFlow).not.toHaveBeenCalled();
  });

  it("sso/submit: does not forward a valid submission for another owner", async () => {
    readByosubFlow.mockResolvedValue({ uid: "someone-else", gatewayId: "walter", agentId: AGENT, provider: "anthropic" });
    await request(app()).post("/byosub/sso/submit").send({ flowId: "f1", code: "abc" }).expect(404);
    expect(ssoSubmit).not.toHaveBeenCalled();
  });

  it("sso/submit: 409 when the flow belongs to a different pod", async () => {
    readByosubFlow.mockResolvedValue({ uid: TEST_UID, gatewayId: "other-gw", agentId: AGENT, provider: "anthropic" });
    const res = await request(app()).post("/byosub/sso/submit").send({ flowId: "f1", code: "abc" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "not_on_this_pod" });
    expect(ssoSubmit).not.toHaveBeenCalled();
  });
});
