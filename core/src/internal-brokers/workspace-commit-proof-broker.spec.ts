import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  internalFetch: vi.fn(),
  sidecarBrokerHeaders: vi.fn(),
}));

vi.mock("../internal-fetch.js", () => ({
  internalFetch: h.internalFetch,
  sidecarBrokerHeaders: h.sidecarBrokerHeaders,
}));

import {
  verifyWorkspaceCommitProofViaBroker,
} from "./workspace-commit-proof-broker.js";

const target = { agentId: "octogee-acme-coach", slug: "acme", project: null };
const body = { ...target, message: "checkpoint" };

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

beforeEach(() => {
  vi.clearAllMocks();
  h.sidecarBrokerHeaders.mockResolvedValue({
    "x-octogee-sidecar-broker-token": "sidecar-jwt",
  });
});

describe("workspace commit proof broker", () => {
  it("uses the sidecar capability and sends the signed commit body unchanged", async () => {
    h.internalFetch.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(verifyWorkspaceCommitProofViaBroker(request(), target, {
      WORKSPACE_COMMIT_PROOF_BROKER_URL: "http://octogee-api:3001/",
      GATEWAY_ID: "shared-b",
    })).resolves.toBe(true);

    expect(h.internalFetch).toHaveBeenCalledWith(
      "http://octogee-api:3001/internal/workspace-commit/verify-proof",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octogee-sidecar-broker-token": "sidecar-jwt",
        },
        body: JSON.stringify({
          gatewayId: "shared-b",
          target,
          proof: {
            timestamp: "1785000000000",
            signature: "a".repeat(64),
            body: JSON.stringify(body),
          },
        }),
      },
    );
  });

  it("treats a rejected proof as unauthorized", async () => {
    h.internalFetch.mockResolvedValue(new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
    }));

    await expect(verifyWorkspaceCommitProofViaBroker(request(), target, {
      WORKSPACE_COMMIT_PROOF_BROKER_URL: "http://octogee-api:3001",
      GATEWAY_ID: "shared-b",
    })).resolves.toBe(false);
  });

  it("fails closed when the trusted broker is unavailable", async () => {
    h.internalFetch.mockResolvedValue(new Response(JSON.stringify({ error: "proof_unavailable" }), {
      status: 503,
    }));

    await expect(verifyWorkspaceCommitProofViaBroker(request(), target, {
      WORKSPACE_COMMIT_PROOF_BROKER_URL: "http://octogee-api:3001",
      GATEWAY_ID: "shared-b",
    })).rejects.toEqual(expect.objectContaining({
      name: "WorkspaceCommitProofBrokerError",
      status: 503,
    }));
  });

  it("requires the dedicated broker URL and bound gateway identity", async () => {
    await expect(verifyWorkspaceCommitProofViaBroker(request(), target, {
      GATEWAY_ID: "shared-b",
    })).rejects.toThrow("WORKSPACE_COMMIT_PROOF_BROKER_URL is required");
    await expect(verifyWorkspaceCommitProofViaBroker(request(), target, {
      WORKSPACE_COMMIT_PROOF_BROKER_URL: "http://octogee-api:3001",
    })).rejects.toThrow("GATEWAY_ID is required");
    expect(h.internalFetch).not.toHaveBeenCalled();
  });
});
