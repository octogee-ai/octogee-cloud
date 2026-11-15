import { describe, expect, it, vi } from "vitest";

import { hydrateConfiguredUserBootstrap } from "../lib/configured-user-bootstrap.js";
import { MalformedDeskFileError } from "../lib/desk-identity.js";

describe("configured user bootstrap", () => {
  it("materializes the exact workspace and project agent credentials required at boot", async () => {
    const configuredUserBootstrap = vi.fn().mockResolvedValue({
      uid: "uid-alice",
      slug: "alice",
      agentId: "octogee-alice-coach",
      accountId: "alice-coach",
      coachToken: "coach-token",
      projectCredentials: [{
        projectId: "orbit",
        agentId: "octogee-alice-proj-orbit-coach",
        accountId: "alice-proj-orbit",
        token: "project-token",
      }],
    });
    const writeSecrets = vi.fn().mockResolvedValue(undefined);

    await hydrateConfiguredUserBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "walter",
      revisionId: "walter-r9",
      slug: "alice",
    }, {
      createClient: () => ({ configuredUserBootstrap }),
      writeSecrets,
    });

    expect(configuredUserBootstrap).toHaveBeenCalledWith("alice");
    expect(writeSecrets).toHaveBeenCalledWith("/tmp/openclaw", {
      removePrefixes: ["alice-proj-"],
      set: {
        "alice-coach": "coach-token",
        "alice-proj-orbit": "project-token",
      },
    });
  });

  it("writes the Desk identity into the desktop home when the boot names one, and refuses a bootstrap without a valid desk", async () => {
    const desk = { builderName: "Alice", agentName: "Scout", look: { style: "kit", color: "#0ea5e9" }, timeZone: "America/Chicago" };
    const bootstrap = {
      uid: "uid-alice",
      slug: "alice",
      agentId: "octogee-alice-coach",
      accountId: "alice-coach",
      coachToken: "coach-token",
      projectCredentials: [],
    };
    const writeSecrets = vi.fn().mockResolvedValue(undefined);
    const writeDesk = vi.fn().mockResolvedValue({ written: true });
    await hydrateConfiguredUserBootstrap({ openclawDir: "/tmp/openclaw", gatewayId: "walter", slug: "alice", desktopHome: "/home/octo" }, {
      createClient: () => ({ configuredUserBootstrap: vi.fn().mockResolvedValue({ ...bootstrap, desk }) }),
      writeSecrets,
      writeDesk,
    });
    expect(writeDesk).toHaveBeenCalledWith("/home/octo", desk);

    writeDesk.mockClear();
    writeSecrets.mockClear();
    await expect(hydrateConfiguredUserBootstrap({ openclawDir: "/tmp/openclaw", gatewayId: "walter", slug: "alice", desktopHome: "/home/octo" }, {
      createClient: () => ({ configuredUserBootstrap: vi.fn().mockResolvedValue({ ...bootstrap, desk: { builderName: "Alice" } }) }),
      writeSecrets,
      writeDesk,
    })).rejects.toThrow("no valid desk identity");
    expect(writeSecrets).not.toHaveBeenCalled();
    expect(writeDesk).not.toHaveBeenCalled();

    await hydrateConfiguredUserBootstrap({ openclawDir: "/tmp/openclaw", gatewayId: "walter", slug: "alice" }, {
      createClient: () => ({ configuredUserBootstrap: vi.fn().mockResolvedValue(bootstrap) }),
      writeSecrets,
      writeDesk,
    });
    expect(writeDesk).not.toHaveBeenCalled();

    const log = vi.fn();
    const quarantining = vi.fn()
      .mockRejectedValueOnce(new MalformedDeskFileError("/home/octo/.config/octogee/desk.json", "/home/octo/.config/octogee/desk.json.malformed-1"))
      .mockResolvedValueOnce({ written: true });
    await hydrateConfiguredUserBootstrap({ openclawDir: "/tmp/openclaw", gatewayId: "walter", slug: "alice", desktopHome: "/home/octo" }, {
      createClient: () => ({ configuredUserBootstrap: vi.fn().mockResolvedValue({ ...bootstrap, desk }) }),
      writeSecrets,
      writeDesk: quarantining,
      log,
    });
    expect(quarantining).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("desk.json.malformed-1"));
    const broken = vi.fn().mockRejectedValue(new Error("EACCES"));
    await expect(hydrateConfiguredUserBootstrap({ openclawDir: "/tmp/openclaw", gatewayId: "walter", slug: "alice", desktopHome: "/home/octo" }, {
      createClient: () => ({ configuredUserBootstrap: vi.fn().mockResolvedValue({ ...bootstrap, desk }) }),
      writeSecrets,
      writeDesk: broken,
      log,
    })).rejects.toThrow("EACCES");
  });

  it("rejects a project credential outside the configured user identity", async () => {
    const writeSecrets = vi.fn().mockResolvedValue(undefined);

    await expect(hydrateConfiguredUserBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "walter",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredUserBootstrap: vi.fn().mockResolvedValue({
          uid: "uid-alice",
          slug: "alice",
          agentId: "octogee-alice-coach",
          accountId: "alice-coach",
          coachToken: "coach-token",
          projectCredentials: [{
            projectId: "orbit",
            agentId: "octogee-victim-proj-orbit-coach",
            accountId: "victim-proj-orbit",
            token: "victim-token",
          }],
        }),
      }),
      writeSecrets,
    })).rejects.toThrow("configured user bootstrap identity mismatch");
    expect(writeSecrets).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing project credential list",
      bootstrap: {
        uid: "uid-alice",
        slug: "alice",
        agentId: "octogee-alice-coach",
        accountId: "alice-coach",
        coachToken: "coach-token",
      },
    },
    {
      name: "duplicate project credential",
      bootstrap: {
        uid: "uid-alice",
        slug: "alice",
        agentId: "octogee-alice-coach",
        accountId: "alice-coach",
        coachToken: "coach-token",
        projectCredentials: [
          {
            projectId: "orbit",
            agentId: "octogee-alice-proj-orbit-coach",
            accountId: "alice-proj-orbit",
            token: "project-token-a",
          },
          {
            projectId: "orbit",
            agentId: "octogee-alice-proj-orbit-coach",
            accountId: "alice-proj-orbit",
            token: "project-token-b",
          },
        ],
      },
    },
  ])("rejects a broker response with $name", async ({ bootstrap }) => {
    const writeSecrets = vi.fn().mockResolvedValue(undefined);

    await expect(hydrateConfiguredUserBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "walter",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredUserBootstrap: vi.fn().mockResolvedValue(bootstrap),
      }),
      writeSecrets,
    })).rejects.toThrow("configured user bootstrap identity mismatch");
    expect(writeSecrets).not.toHaveBeenCalled();
  });

  it("provisions the configured agent once when a freshly claimed gateway has no bootstrap yet", async () => {
    const calls: string[] = [];
    const bootstrap = {
      uid: "uid-alice",
      slug: "alice",
      agentId: "octogee-alice-coach",
      accountId: "alice-coach",
      coachToken: "coach-token",
      projectCredentials: [],
    };
    const configuredUserBootstrap = vi.fn()
      .mockRejectedValueOnce(new Error(
        'fleet-broker POST /internal/fleet/configured-builder-bootstrap → 404 {"error":"configured_builder_bootstrap_unavailable"}',
      ))
      .mockImplementationOnce(async () => {
        calls.push("retry-bootstrap");
        return bootstrap;
      });
    const client = {
      configuredUserBootstrap,
      uidForSlug: vi.fn(async () => {
        calls.push("uid");
        return "uid-alice";
      }),
      provisionMattermost: vi.fn(async () => {
        calls.push("provision-mattermost");
        return { "mattermost.teamId": "team-alice" };
      }),
      setMattermostFields: vi.fn(async () => {
        calls.push("set-mattermost");
      }),
      ensureAgentIds: vi.fn(async () => {
        calls.push("set-agents");
      }),
    };
    const writeSecrets = vi.fn().mockResolvedValue(undefined);

    await hydrateConfiguredUserBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "walter",
      slug: "alice",
    }, {
      createClient: () => client,
      writeSecrets,
    });

    expect(calls).toEqual([
      "uid",
      "provision-mattermost",
      "set-mattermost",
      "set-agents",
      "retry-bootstrap",
    ]);
    expect(client.setMattermostFields).toHaveBeenCalledWith("uid-alice", {
      "mattermost.teamId": "team-alice",
    });
    expect(client.ensureAgentIds).toHaveBeenCalledWith("uid-alice", ["octogee-alice-coach"]);
    expect(writeSecrets).toHaveBeenCalledWith("/tmp/openclaw", {
      removePrefixes: ["alice-proj-"],
      set: { "alice-coach": "coach-token" },
    });
  });

  it("fails loudly when an unavailable bootstrap has no assigned user uid", async () => {
    const provisionMattermost = vi.fn();
    await expect(hydrateConfiguredUserBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "walter",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredUserBootstrap: vi.fn().mockRejectedValue(new Error(
          'fleet-broker POST /internal/fleet/configured-builder-bootstrap → 404 {"error":"configured_builder_bootstrap_unavailable"}',
        )),
        uidForSlug: vi.fn().mockResolvedValue(null),
        provisionMattermost,
        setMattermostFields: vi.fn(),
        ensureAgentIds: vi.fn(),
      }),
    })).rejects.toThrow("configured user alice has no assigned uid");
    expect(provisionMattermost).not.toHaveBeenCalled();
  });

  it.each([
    "fleet-broker POST /internal/fleet/configured-builder-bootstrap → 403 forbidden",
    "fleet-broker POST /internal/fleet/configured-builder-bootstrap → 404 not_found",
    "connect ECONNREFUSED",
  ])("does not provision Mattermost for a non-recoverable bootstrap error: %s", async (message) => {
    const uidForSlug = vi.fn();
    await expect(hydrateConfiguredUserBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "walter",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredUserBootstrap: vi.fn().mockRejectedValue(new Error(message)),
        uidForSlug,
        provisionMattermost: vi.fn(),
        setMattermostFields: vi.fn(),
        ensureAgentIds: vi.fn(),
      }),
    })).rejects.toThrow(message);
    expect(uidForSlug).not.toHaveBeenCalled();
  });

  it("validates the configured identity returned after recovery", async () => {
    const writeSecrets = vi.fn();
    await expect(hydrateConfiguredUserBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "walter",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredUserBootstrap: vi.fn()
          .mockRejectedValueOnce(new Error(
            'fleet-broker POST /internal/fleet/configured-builder-bootstrap → 404 {"error":"configured_builder_bootstrap_unavailable"}',
          ))
          .mockResolvedValueOnce({
            uid: "uid-victim",
            slug: "victim",
            agentId: "octogee-victim-coach",
            accountId: "victim-coach",
            coachToken: "victim-token",
            projectCredentials: [],
          }),
        uidForSlug: vi.fn().mockResolvedValue("uid-alice"),
        provisionMattermost: vi.fn().mockResolvedValue({}),
        setMattermostFields: vi.fn().mockResolvedValue(undefined),
        ensureAgentIds: vi.fn().mockResolvedValue(undefined),
      }),
      writeSecrets,
    })).rejects.toThrow("configured user bootstrap identity mismatch");
    expect(writeSecrets).not.toHaveBeenCalled();
  });

  it("rejects a broker response whose account identity does not match the configured user", async () => {
    const writeSecrets = vi.fn().mockResolvedValue(undefined);
    await expect(hydrateConfiguredUserBootstrap({
      openclawDir: "/tmp/openclaw",
      gatewayId: "walter",
      revisionId: "walter-r9",
      slug: "alice",
    }, {
      createClient: () => ({
        configuredUserBootstrap: vi.fn().mockResolvedValue({
          uid: "uid-victim",
          slug: "victim",
          agentId: "octogee-victim-coach",
          accountId: "victim-coach",
          coachToken: "victim-token",
          projectCredentials: [],
        }),
      }),
      writeSecrets,
    })).rejects.toThrow("configured user bootstrap identity mismatch");
    expect(writeSecrets).not.toHaveBeenCalled();
  });
});
