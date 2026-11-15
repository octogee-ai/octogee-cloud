import { beforeEach, describe, expect, it, vi } from "vitest";

import { internalFetch } from "../lib/internal-fetch.js";
import { createFleetBrokerClient } from "../lib/fleet-broker-client.js";
import { GATEWAY_CREDENTIAL_TOKEN_HEADER } from "@octogee/core/internal-fetch";

vi.mock("../lib/internal-fetch.js", () => ({ internalFetch: vi.fn() }));

describe("fleet broker system config status", () => {
  beforeEach(() => {
    vi.mocked(internalFetch).mockReset();
    vi.mocked(internalFetch).mockResolvedValue(new Response(null, { status: 204 }));
    delete process.env.FLEET_BROKER_URL;
    process.env.OCTOGEE_API_URL = "http://broker";
  });

  it("publishes the redacted status against the immutable revision", async () => {
    await createFleetBrokerClient("walter", "walter-r9").recordSystemConfigStatus({
      state: "error",
      acceptedCommit: "abc123",
      lastErrorCode: "non-fast-forward-conflict",
    });

    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/system-config-status",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          gatewayId: "walter",
          revisionId: "walter-r9",
          status: {
            state: "error",
            acceptedCommit: "abc123",
            lastErrorCode: "non-fast-forward-conflict",
          },
        }),
      }),
    );
  });

  it("publishes only the assigned isolated toolchain state", async () => {
    await createFleetBrokerClient("walter", "walter-r9")
      .setToolchainStatus("uid-alice", "verifying");

    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/set-toolchain-status",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          gatewayId: "walter",
          uid: "uid-alice",
          status: "verifying",
        }),
      }),
    );
  });

  it("reads canonical assignment admission with the current gateway credential and revision", async () => {
    const assignments = [{ uid: "uid-alice", state: "quiescing", epoch: 7 }];
    vi.mocked(internalFetch).mockResolvedValueOnce(Response.json({ assignments }));
    const client = createFleetBrokerClient("shared-1", "shared-1", {
      gatewayCredentialHeaders: async () => ({ [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt" }),
    });

    await expect(client.assignmentRoster()).resolves.toEqual(assignments);
    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/assignment-roster",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt" }),
        body: JSON.stringify({ gatewayId: "shared-1", revisionId: "shared-1" }),
      }),
    );
  });

  it.each([
    null,
    {},
    { assignments: null },
    { assignments: [{ uid: "", state: "serving", epoch: 1 }] },
    { assignments: [{ uid: "u1", state: "unknown", epoch: 1 }] },
    { assignments: [{ uid: "u1", state: "serving", epoch: -1 }] },
    { assignments: [{ uid: "u1", state: "serving", epoch: 1.5 }] },
    { assignments: [{ uid: "u1", state: "serving", epoch: 1 }, { uid: "u1", state: "quiescing", epoch: 2 }] },
  ])("rejects malformed canonical assignment admission: %j", async (body) => {
    vi.mocked(internalFetch).mockResolvedValueOnce(Response.json(body));

    await expect(createFleetBrokerClient("shared-1", "shared-1", {
      gatewayCredentialHeaders: async () => ({}),
    }).assignmentRoster())
      .rejects.toThrow("invalid assignment roster");
  });

  it("requests the narrow configured-user bootstrap against the immutable revision", async () => {
    const bootstrap = {
      uid: "uid-alice",
      slug: "alice",
      agentId: "octogee-alice-coach",
      accountId: "alice-coach",
      coachToken: "coach-token",
      projectCredentials: [],
    };
    vi.mocked(internalFetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ bootstrap }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await expect(
      createFleetBrokerClient("walter", "walter-r9", {
        gatewayCredentialHeaders: async () => ({
          [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
        }),
      }).configuredUserBootstrap("alice"),
    ).resolves.toEqual(bootstrap);
    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/configured-builder-bootstrap",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          [GATEWAY_CREDENTIAL_TOKEN_HEADER]: "credential-jwt",
        }),
        body: JSON.stringify({
          gatewayId: "walter",
          revisionId: "walter-r9",
          slug: "alice",
        }),
      }),
    );
  });

  it("requests per-user project agent membership reconciliation", async () => {
    await createFleetBrokerClient("walter", "walter-r9")
      .reconcileProjectAgentMembership("uid-alice");

    expect(internalFetch).toHaveBeenCalledWith(
      "http://broker/internal/fleet/reconcile-project-coach-membership",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ gatewayId: "walter", uid: "uid-alice" }),
      }),
    );
  });
});
