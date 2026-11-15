import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  internalFetch: vi.fn(),
  sidecarBrokerHeaders: vi.fn(),
}));

vi.mock("@octogee/core/internal-fetch", () => ({
  internalFetch: h.internalFetch,
  sidecarBrokerHeaders: h.sidecarBrokerHeaders,
}));

import { authorizeOwnerAutomationViaBroker } from "../lib/owner-automation-authorization-broker.js";

const AGENT = "octogee-acme-coach";
const OWNER = "o".repeat(26);
const CHANNEL = "c".repeat(26);
const ENV = { AUTOMATIONS_BROKER_URL: "http://octogee-api:3001/", GATEWAY_ID: "shared-b" };
const body = { agentId: AGENT, requestContext: { channel: "mattermost" }, action: "list", params: {} };

function request(): Request {
  return {
    body,
    get: (name: string) => {
      if (name === "x-octogee-agent-proof-timestamp") return "1785000000000";
      if (name === "x-octogee-agent-proof-signature") return "a".repeat(64);
      return undefined;
    },
  } as unknown as Request;
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const authorized = { gatewayId: "shared-b", slug: "acme", agentId: AGENT, ownerMattermostUserId: OWNER, coachChannelId: CHANNEL };

beforeEach(() => {
  vi.clearAllMocks();
  h.sidecarBrokerHeaders.mockResolvedValue({ "x-octogee-sidecar-broker-token": "sidecar-jwt" });
});

describe("owner automation authorization broker client", () => {
  it("forwards the signed request unchanged with the sidecar capability and returns the tenant", async () => {
    h.internalFetch.mockResolvedValue(json(200, authorized));

    await expect(authorizeOwnerAutomationViaBroker(request(), AGENT, ENV)).resolves.toEqual({
      kind: "authorized",
      tenant: { slug: "acme", agentId: AGENT, ownerMattermostUserId: OWNER, coachChannelId: CHANNEL },
    });
    expect(h.internalFetch).toHaveBeenCalledWith("http://octogee-api:3001/internal/owner-automations/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", "x-octogee-sidecar-broker-token": "sidecar-jwt" },
      body: JSON.stringify({
        gatewayId: "shared-b",
        proof: { timestamp: "1785000000000", signature: "a".repeat(64), body: JSON.stringify(body) },
      }),
    });
  });

  it("maps a rejection and a rate limit without a tenant", async () => {
    h.internalFetch.mockResolvedValueOnce(json(403, { error: "forbidden" }));
    await expect(authorizeOwnerAutomationViaBroker(request(), AGENT, ENV)).resolves.toEqual({ kind: "forbidden" });
    h.internalFetch.mockResolvedValueOnce(json(429, { error: "rate_limited", retryAfterSeconds: 12 }));
    await expect(authorizeOwnerAutomationViaBroker(request(), AGENT, ENV)).resolves.toEqual({ kind: "rate_limited", retryAfterSeconds: 12 });
  });

  it.each([
    ["another gateway", { ...authorized, gatewayId: "shared-victim" }],
    ["another agent", { ...authorized, agentId: "octogee-victim-coach" }],
    ["an agent that is not the slug's agent", { ...authorized, slug: "victim" }],
    ["a malformed channel", { ...authorized, coachChannelId: "general" }],
  ])("fails closed when the broker names %s", async (_label, response) => {
    h.internalFetch.mockResolvedValue(json(200, response));

    await expect(authorizeOwnerAutomationViaBroker(request(), AGENT, ENV)).rejects.toEqual(
      expect.objectContaining({ name: "OwnerAutomationBrokerError", status: 502 }),
    );
  });

  it("fails closed when the broker is unavailable or the URL is untrusted", async () => {
    h.internalFetch.mockResolvedValue(json(503, { error: "authorization_unavailable" }));
    await expect(authorizeOwnerAutomationViaBroker(request(), AGENT, ENV)).rejects.toEqual(
      expect.objectContaining({ status: 503 }),
    );
    await expect(authorizeOwnerAutomationViaBroker(request(), AGENT, { ...ENV, AUTOMATIONS_BROKER_URL: "https://evil.example" }))
      .rejects.toThrow("must target octogee-api");
  });
});
