import { describe, expect, it, vi } from "vitest";

import { probeGiteaAdminBroker } from "../entrypoints/gitea-broker-probe.js";

describe("Gitea admin broker probe", () => {
  it("uses an assigned tenant for a read-only Gitea connectivity check", async () => {
    const assignedUsers = vi.fn().mockResolvedValue([
      { slug: "alice" },
      { slug: "bob" },
    ]);
    const repoExists = vi.fn().mockResolvedValue(true);

    await expect(probeGiteaAdminBroker({
      GATEWAY_ID: "operator-alice",
      GITEA_ADMIN_BROKER_URL: "http://octogee-api:3001",
    }, {
      createClient: () => ({ assignedUsers }),
      repoExists,
    })).resolves.toEqual({ slug: "alice", workspaceRepoExists: true });

    expect(assignedUsers).toHaveBeenCalledWith();
    expect(repoExists).toHaveBeenCalledWith("alice", "workspace");
  });

  it("fails closed when the legacy Gitea admin token is present", async () => {
    const createClient = vi.fn();
    await expect(probeGiteaAdminBroker({
      GATEWAY_ID: "operator-alice",
      GITEA_ADMIN_BROKER_URL: "http://octogee-api:3001",
      GIT_API_TOKEN: "legacy-admin-token",
    }, {
      createClient,
      repoExists: vi.fn(),
    })).rejects.toThrow("legacy GIT_API_TOKEN");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("fails loudly when the gateway has no tenant-bound slug", async () => {
    await expect(probeGiteaAdminBroker({
      GATEWAY_ID: "empty-gateway",
      GITEA_ADMIN_BROKER_URL: "http://octogee-api:3001",
    }, {
      createClient: () => ({ assignedUsers: vi.fn().mockResolvedValue([]) }),
      repoExists: vi.fn(),
    })).rejects.toThrow("no assigned tenant");
  });
});
