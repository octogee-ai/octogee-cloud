import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _setAgentMessageTokenReviewerForTests } from "../middleware/agent-message-auth.js";
import { createInternalAgentMessageRouter } from "../routes/internal/agent-message.js";

const API_TOKEN = "projected-api-token";

function app() {
  process.env.GATEWAY_ID = "gw-old";
  process.env.GATEWAY_CLASS = "shared";
  process.env.GATEWAY_PROFILE = "standard";
  process.env.K8S_NAMESPACE = "octogee-test";
  process.env.OPENCLAW_GATEWAY_TOKEN = "local-openclaw-token";
  const instance = express();
  instance.use(express.json());
  instance.use(
    "/api/g/:gatewayId/internal/agent-message",
    createInternalAgentMessageRouter(),
  );
  return instance;
}

afterEach(() => {
  delete process.env.GATEWAY_ID;
  delete process.env.GATEWAY_CLASS;
  delete process.env.GATEWAY_PROFILE;
  delete process.env.K8S_NAMESPACE;
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  _setAgentMessageTokenReviewerForTests(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /api/g/:gatewayId/internal/agent-message", () => {
  it("authenticates the internal route and delivers through pod-local OpenClaw", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    _setAgentMessageTokenReviewerForTests(async () => ({
      authenticated: true,
      saName: "octogee-api",
      namespace: "octogee-test",
      audiences: ["octogee-api"],
    }));

    const res = await request(app())
      .post("/api/g/gw-old/internal/agent-message")
      .set("x-k8s-sa-token", API_TOKEN)
      .send({
        uid: "owner-uid",
        agentId: "octogee-old-slug-coach",
        message: "Your gateway is moving",
      });

    expect(res.status).toBe(204);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18789/api/agents/octogee-old-slug-coach/message",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer local-openclaw-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "Your gateway is moving", source: "system" }),
      }),
    );
  });

  it("delivers with the edge service identity instead of a token when the gateway trusts the proxy", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    _setAgentMessageTokenReviewerForTests(async () => ({
      authenticated: true,
      saName: "octogee-api",
      namespace: "octogee-test",
      audiences: ["octogee-api"],
    }));
    const instance = app();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    process.env.OPENCLAW_CONTROL_IDENTITY = "per-user";
    try {
      const res = await request(instance)
        .post("/api/g/gw-old/internal/agent-message")
        .set("x-k8s-sa-token", API_TOKEN)
        .send({
          uid: "owner-uid",
          agentId: "octogee-old-slug-coach",
          message: "Your gateway is moving",
        });

      expect(res.status).toBe(204);
      const [, init] = fetchMock.mock.calls[0]!;
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["x-octogee-user"]).toBe("svc:gateway-edge");
      expect(headers["x-octogee-proxy"]).toBe("1");
      expect(headers["content-type"]).toBe("application/json");
      expect(headers).not.toHaveProperty("authorization");
    } finally {
      delete process.env.OPENCLAW_CONTROL_IDENTITY;
    }
  });

  it("rejects a route for another gateway before contacting OpenClaw", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    _setAgentMessageTokenReviewerForTests(async () => ({
      authenticated: true,
      saName: "octogee-api",
      namespace: "octogee-test",
      audiences: ["octogee-api"],
    }));

    const res = await request(app())
      .post("/api/g/gw-other/internal/agent-message")
      .set("x-k8s-sa-token", API_TOKEN)
      .send({
        uid: "owner-uid",
        agentId: "octogee-old-slug-coach",
        message: "Your gateway is moving",
      });

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "another service account",
      review: {
        authenticated: true as const,
        saName: "octogee-cron",
        namespace: "octogee-test",
        audiences: ["octogee-api"],
      },
    },
    {
      name: "another namespace",
      review: {
        authenticated: true as const,
        saName: "octogee-api",
        namespace: "octogee",
        audiences: ["octogee-api"],
      },
    },
    {
      name: "another audience",
      review: {
        authenticated: true as const,
        saName: "octogee-api",
        namespace: "octogee-test",
        audiences: ["another-audience"],
      },
    },
  ])("rejects $name before contacting OpenClaw", async ({ review }) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    _setAgentMessageTokenReviewerForTests(async () => review);

    const res = await request(app())
      .post("/api/g/gw-old/internal/agent-message")
      .set("x-k8s-sa-token", API_TOKEN)
      .send({
        uid: "owner-uid",
        agentId: "octogee-old-slug-coach",
        message: "Your gateway is moving",
      });

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when service-account identity cannot be reviewed", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    _setAgentMessageTokenReviewerForTests(async () => {
      throw new Error("TokenReview unavailable");
    });

    const res = await request(app())
      .post("/api/g/gw-old/internal/agent-message")
      .set("x-k8s-sa-token", API_TOKEN)
      .send({
        uid: "owner-uid",
        agentId: "octogee-old-slug-coach",
        message: "Your gateway is moving",
      });

    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the sidecar namespace is not configured", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const instance = app();
    delete process.env.K8S_NAMESPACE;
    vi.stubGlobal("fetch", fetchMock);
    _setAgentMessageTokenReviewerForTests(async () => ({
      authenticated: true,
      saName: "octogee-api",
      namespace: "octogee",
      audiences: ["octogee-api"],
    }));

    const res = await request(instance)
      .post("/api/g/gw-old/internal/agent-message")
      .set("x-k8s-sa-token", API_TOKEN)
      .send({
        uid: "owner-uid",
        agentId: "octogee-old-slug-coach",
        message: "Your gateway is moving",
      });

    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed before contacting OpenClaw when its local credential is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    _setAgentMessageTokenReviewerForTests(async () => ({
      authenticated: true,
      saName: "octogee-api",
      namespace: "octogee-test",
      audiences: ["octogee-api"],
    }));
    const instance = app();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;

    const res = await request(instance)
      .post("/api/g/gw-old/internal/agent-message")
      .set("x-k8s-sa-token", API_TOKEN)
      .send({
        uid: "owner-uid",
        agentId: "octogee-old-slug-coach",
        message: "Your gateway is moving",
      });

    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a project agent before contacting OpenClaw", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    _setAgentMessageTokenReviewerForTests(async () => ({
      authenticated: true,
      saName: "octogee-api",
      namespace: "octogee-test",
      audiences: ["octogee-api"],
    }));

    const res = await request(app())
      .post("/api/g/gw-old/internal/agent-message")
      .set("x-k8s-sa-token", API_TOKEN)
      .send({
        uid: "owner-uid",
        agentId: "octogee-old-slug-proj-one-coach",
        message: "Your gateway is moving",
    });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
