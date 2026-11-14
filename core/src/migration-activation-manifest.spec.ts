import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMPORT_ACTIVATION_PATCH_DEADLINE_MS } from "@octogee/shared/types/fleet-controller";
import { applyConfigPatch } from "./apply-config-patch.js";

vi.mock("./apply-config-patch", async (importActual) => {
  const actual = await importActual<typeof import("./apply-config-patch.js")>();
  return { ...actual, applyConfigPatch: vi.fn(actual.applyConfigPatch) };
});
import {
  activationManifestAgentIds,
  activationManifestTarPath,
  applyOpenClawActivationManifest,
  extractOpenClawActivationManifest,
  readActivationManifest,
  writeActivationManifest,
  captureSourceWorkspaceIdentities,
  captureTargetWorkspaceIdentities,
  privateProjectWorkspaceAgentIds,
  restoreTargetWorkspaceIdentities,
  restoreSourceWorkspaceIdentities,
  type MigrationActivationManifest,
} from "./migration-activation-manifest.js";
import { initializeRelocatedProjectAgent, projectAgentWorkspace } from "./project-agent-workspaces.js";
import { platformOpenAiEmbeddingSecretId } from "./platform-embedding-refs.js";
import {
  USER_CODE_DENIED_TOOLS,
  USER_WORKFLOW_TOOLS,
  PRODUCTIVITY_TOOL_NAMES,
  PROJECT_AGENT_ALLOWED_TOOLS,
  PROJECT_AGENT_DENIED_TOOLS,
  platformInvariantViolations,
  reconcilePlatformInvariants,
} from "./system-config-invariants.js";

const tmpDirs: string[] = [];
const APPLIED_FINGERPRINT = "fp-alice-v1";

async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "activation-manifest-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function manifest(): MigrationActivationManifest {
  return {
    version: 2,
    slug: "alice",
    appliedFingerprint: APPLIED_FINGERPRINT,
    agentId: "octogee-alice-coach",
    accountId: "alice-coach",
    agent: { id: "octogee-alice-coach", model: "custom-model" },
    mattermostAccount: { botToken: "default-agent-pat", groupAllowFrom: ["mm-user"] },
    bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
    projectAgents: [],
  };
}

function withoutTools(agents: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return agents.map(({ tools: _tools, ...agent }) => agent);
}

describe("activationManifestAgentIds", () => {
  it("lists the agent and every project agent the activation installs", () => {
    expect(
      activationManifestAgentIds({
        ...manifest(),
        projectAgents: [
          {
            agentId: "octogee-alice-proj-orbit-coach",
            accountId: "alice-proj-orbit",
            agent: { id: "octogee-alice-proj-orbit-coach" },
            mattermostAccount: {},
            bindings: [],
          },
        ],
      }),
    ).toEqual(["octogee-alice-coach", "octogee-alice-proj-orbit-coach"]);
  });
});

describe("migration activation manifest", () => {
  it("never nulls a roster entry the target still carries — removals go through agents.delete", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string, _options?: { replacePaths?: readonly string[] }) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            entries: {
              "octogee-alice-coach": { model: "house" },
              "octogee-alice-proj-residue-coach": { model: "house" },
            },
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { entries: Record<string, unknown> };
    };
    expect(Object.values(patch.agents.entries)).not.toContain(null);
    expect(patch.agents.entries).not.toHaveProperty("octogee-alice-proj-residue-coach");
  });

  it("extracts only the per-user OpenClaw fragments needed for local activation", async () => {
    const dir = await mkTmp();
    const configPath = path.join(dir, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          list: [
            { id: "octogee-bob-coach", model: "other" },
            { id: "octogee-alice-coach", model: "custom-model" },
          ],
        },
        channels: {
          mattermost: {
            accounts: {
              "alice-coach": { botToken: "default-agent-pat" },
              "bob-coach": { botToken: "other-pat" },
            },
          },
        },
        bindings: [
          { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } },
          { agentId: "octogee-bob-coach", match: { channel: "mattermost", accountId: "bob-coach" } },
        ],
      }),
    );

    await expect(extractOpenClawActivationManifest(configPath, "alice", {
      appliedFingerprint: APPLIED_FINGERPRINT,
    })).resolves.toMatchObject({
      slug: "alice",
      agent: { id: "octogee-alice-coach", model: "custom-model" },
      mattermostAccount: { botToken: "default-agent-pat" },
      bindings: [{ agentId: "octogee-alice-coach" }],
    });
  });

  it("extracts a beta keyed source entry as the id-bearing migration manifest agent", async () => {
    const dir = await mkTmp();
    const configPath = path.join(dir, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: { entries: { "octogee-alice-coach": { model: "custom-model" } } },
        channels: { mattermost: { accounts: { "alice-coach": { botToken: "default-agent-pat" } } } },
        bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
      }),
    );

    await expect(extractOpenClawActivationManifest(configPath, "alice", {
      appliedFingerprint: APPLIED_FINGERPRINT,
    })).resolves.toMatchObject({
      agent: { id: "octogee-alice-coach", model: "custom-model" },
    });
  });

  it("rejects a source agent binding that claims another user's account", async () => {
    const dir = await mkTmp();
    const configPath = path.join(dir, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({
      agents: { list: [{ id: "octogee-alice-coach", model: "custom-model" }] },
      channels: { mattermost: { accounts: { "alice-coach": { botToken: "default-agent-pat" } } } },
      bindings: [{
        agentId: "octogee-alice-coach",
        match: { channel: "mattermost", accountId: "mike-coach" },
      }],
    }));

    await expect(extractOpenClawActivationManifest(configPath, "alice", {
      appliedFingerprint: APPLIED_FINGERPRINT,
    })).rejects.toThrow("foreign binding scope");
  });

  it("adds the stable account route when reading a peer-only user manifest", async () => {
    const dir = await mkTmp();
    const peerOnly = {
      ...manifest(),
      bindings: [{
        agentId: "octogee-alice-coach",
        match: {
          channel: "mattermost",
          accountId: "alice-coach",
          peer: { kind: "group", id: "alice-general" },
        },
      }],
    };
    await writeActivationManifest(dir, peerOnly);

    await expect(readActivationManifest(dir, "alice")).resolves.toMatchObject({
      bindings: [
        {
          agentId: "octogee-alice-coach",
          match: { channel: "mattermost", accountId: "alice-coach" },
        },
        peerOnly.bindings[0],
      ],
    });
  });

  it("carries every active project agent's account and bindings without carrying another user", async () => {
    const dir = await mkTmp();
    const configPath = path.join(dir, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: {
          list: [
            { id: "octogee-alice-coach", model: "workspace" },
            { id: "octogee-alice-proj-orbit-coach", model: "orbit" },
            { id: "octogee-alice-proj-scout-coach", model: "scout" },
            { id: "octogee-bob-proj-orbit-coach", model: "foreign" },
          ],
        },
        channels: {
          mattermost: {
            accounts: {
              "alice-coach": { botToken: "workspace-pat" },
              "alice-proj-orbit": { botToken: "orbit-pat" },
              "alice-proj-scout": { botToken: "scout-pat" },
              "bob-proj-orbit": { botToken: "foreign-pat" },
            },
          },
        },
        bindings: [
          { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } },
          { agentId: "octogee-alice-proj-orbit-coach", match: { channel: "mattermost", accountId: "alice-proj-orbit" } },
          { agentId: "octogee-alice-proj-scout-coach", match: { channel: "mattermost", accountId: "alice-proj-scout" } },
          { agentId: "octogee-bob-proj-orbit-coach", match: { channel: "mattermost", accountId: "bob-proj-orbit" } },
        ],
      }),
    );

    await expect(extractOpenClawActivationManifest(configPath, "alice", {
      appliedFingerprint: APPLIED_FINGERPRINT,
    })).resolves.toMatchObject({
      projectAgents: [
        {
          agentId: "octogee-alice-proj-orbit-coach",
          accountId: "alice-proj-orbit",
          agent: { model: "orbit" },
          mattermostAccount: { botToken: "orbit-pat" },
          bindings: [{ agentId: "octogee-alice-proj-orbit-coach" }],
        },
        {
          agentId: "octogee-alice-proj-scout-coach",
          accountId: "alice-proj-scout",
          agent: { model: "scout" },
          mattermostAccount: { botToken: "scout-pat" },
          bindings: [{ agentId: "octogee-alice-proj-scout-coach" }],
        },
      ],
    });
  });

  it("round-trips through the tar-relative manifest path", async () => {
    const dir = await mkTmp();
    const source = await writeActivationManifest(dir, manifest());

    expect(source).toEqual({
      cwd: dir,
      path: activationManifestTarPath("alice"),
    });
    await expect(readActivationManifest(dir, "alice")).resolves.toMatchObject({
      slug: "alice",
      mattermostAccount: { botToken: "default-agent-pat" },
    });
  });

  it("rejects a manifest symlink even when its target contains a valid manifest", async () => {
    const dir = await mkTmp();
    const { path: relative } = await writeActivationManifest(dir, manifest());
    const filename = path.join(dir, relative);
    await fs.rename(filename, `${filename}.original`);
    await fs.symlink(`${filename}.original`, filename);

    await expect(readActivationManifest(dir, "alice")).rejects.toMatchObject({ code: "ELOOP" });
  });

  it.each([true, false])("rejects a version-one manifest with fingerprint present=%s", async (hasFingerprint) => {
    const dir = await mkTmp();
    const previous = { ...manifest(), version: 1 } as Record<string, unknown>;
    if (!hasFingerprint) delete previous.appliedFingerprint;
    const manifestPath = path.join(dir, activationManifestTarPath("alice"));
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, `${JSON.stringify(previous)}\n`, "utf-8");

    await expect(readActivationManifest(dir, "alice")).rejects.toThrow(
      "activation manifest version/slug mismatch",
    );
  });

  it.each(["isolated", "shared"] as const)("keeps %s account endpoint ownership through imported activation", async (gatewayClass) => {
    const source = manifest();
    source.mattermostAccount.baseUrl = "https://source-coach.example";
    source.projectAgents = ["orbit", "scout"].map((projectId) => ({
      agentId: `octogee-alice-proj-${projectId}-coach`, accountId: `alice-proj-${projectId}`,
      agent: { id: `octogee-alice-proj-${projectId}-coach` },
      mattermostAccount: { botToken: `${projectId}-pat`, ...(projectId === "orbit" ? { baseUrl: "${MM_URL}" } : {}) },
      bindings: [{ agentId: `octogee-alice-proj-${projectId}-coach`, match: { channel: "mattermost", accountId: `alice-proj-${projectId}` } }],
    }));
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({ hash: "h1", config: {
        agents: { entries: {} }, bindings: [],
        channels: { mattermost: { accounts: {
          default: { baseUrl: "${MM_URL}" },
          "alice-coach": { baseUrl: "https://owner-coach.example" },
          "alice-proj-orbit": { baseUrl: "https://owner-orbit.example" },
        } } },
      } })),
      configPatch,
    };

    await applyOpenClawActivationManifest(source, { rpc: rpc as never, log: vi.fn(), gatewayClass });

    const patch = configPatch.mock.calls[0]![0] as Record<string, any>;
    const accounts = patch.channels.mattermost.accounts;
    expect(accounts["alice-coach"].baseUrl).toBe(gatewayClass === "isolated" ? "https://owner-coach.example" : "${MM_URL}");
    expect(accounts["alice-proj-orbit"].baseUrl).toBe(gatewayClass === "isolated" ? "https://owner-orbit.example" : "${MM_URL}");
    expect(accounts["alice-proj-scout"].baseUrl).toBe("${MM_URL}");
  });

  it.each(["isolated", "shared"] as const)("only sets the imported agent as system agent on an isolated gateway: %s", async (gatewayClass) => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({ hash: "h1", config: {
        agents: { entries: {}, defaults: { systemAgent: { agentId: "octogee-unmatched-route" } } },
        bindings: [], channels: { mattermost: { accounts: {} } },
      } })),
      configPatch,
    };
    await applyOpenClawActivationManifest(manifest(), { rpc: rpc as never, log: vi.fn(), gatewayClass });
    const patch = configPatch.mock.calls[0]![0] as { agents: { defaults?: { systemAgent?: { agentId: string } } } };
    expect(patch.agents.defaults?.systemAgent?.agentId).toBe(gatewayClass === "isolated" ? "octogee-alice-coach" : undefined);
  });

  it("patches agent, account, and bindings without keeping stale entries for the same agent", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string, _options?: { replacePaths?: readonly string[] }) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { list: [{ id: "octogee-alice-coach", model: "old" }, { id: "octogee-bob-coach" }] },
          channels: { mattermost: { accounts: { default: { botToken: "mac" } } } },
          bindings: [
            { agentId: "octogee-alice-coach", stale: true },
            { agentId: "octogee-bob-coach", keep: true },
          ],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { list: Array<{ id: string; model?: string }> };
      channels: { mattermost: { accounts: Record<string, unknown> } };
      bindings: Array<{ agentId: string; stale?: boolean; keep?: boolean }>;
    };
    expect(withoutTools(patch.agents.list)).toEqual([
      { id: "octogee-bob-coach" },
      { id: "octogee-alice-coach", model: "old" },
    ]);
    expect(patch.channels.mattermost.accounts).not.toHaveProperty("default");
    expect(patch.channels.mattermost.accounts).toHaveProperty("alice-coach");
    expect(patch.bindings).toEqual([
      { agentId: "octogee-bob-coach", keep: true },
      { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } },
    ]);
    // Dropping stale user entries can shrink user-scoped arrays — the OC
    // destructive-array guard requires the intent confirmed via replacePaths. (No
    // alice-coach account in this base config, so the derived set is agents+bindings.)
    expect(configPatch.mock.calls[0][2]).toEqual({
      replacePaths: [
        "agents.list",
        "agents.list[].model.fallbacks",
        "agents.list[].tools.alsoAllow",
        "bindings",
      ],
    });
  });

  it("does not import a dedicated source agent's default flag into a shared roster", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            list: [
              { id: "octogee-unmatched-route", default: true },
              { id: "octogee-bob-coach" },
            ],
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest({
      ...manifest(),
      agent: { ...manifest().agent, default: true },
    }, { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: { list: Array<Record<string, unknown>> };
    };
    expect(patch.agents.list.filter((agent) => agent.default === true)).toEqual([
      { id: "octogee-unmatched-route", default: true },
    ]);
  });

  it("declares explicit roster ownership on a shared gateway activation that carries no auth anchor", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            entries: {
              "octogee-unmatched-route": { name: "Unmatched Mattermost route" },
              "octogee-bob-coach": { model: "foreign" },
            },
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), {
      rpc: rpc as never,
      log: vi.fn(),
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: { entries: Record<string, unknown>; ownership?: string; defaults?: unknown };
    };
    expect(patch.agents.ownership).toBe("explicit");
    expect(patch.agents.defaults).toBeUndefined();
    expect(patch).not.toHaveProperty("commands");
  });

  it("writes the owner commands in the same activation patch, derived from the config it patches", async () => {
    const current = {
      agents: { entries: {} },
      channels: { mattermost: { accounts: {} } },
      bindings: [],
    };
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({ hash: "h1", config: current })),
      configPatch,
      close: vi.fn(async () => undefined),
    };
    const ownerCommandsPatch = vi.fn(() => ({ ownerAllowFrom: ["mattermost:owner"] }));

    await applyOpenClawActivationManifest(manifest(), {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "isolated",
      ownerCommandsPatch,
    });

    expect(configPatch).toHaveBeenCalledTimes(1);
    expect(ownerCommandsPatch).toHaveBeenCalledWith(current);
    expect(configPatch.mock.calls[0]?.[0]).toMatchObject({
      commands: { ownerAllowFrom: ["mattermost:owner"] },
    });
  });

  it("leaves commands out of the activation patch when the owner commands are already present", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: { agents: { entries: {} }, channels: { mattermost: { accounts: {} } }, bindings: [] },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "isolated",
      ownerCommandsPatch: () => undefined,
    });

    expect(configPatch.mock.calls[0]?.[0]).not.toHaveProperty("commands");
  });

  it("anchors user auth inheritance while retaining the agent routing default", async () => {
    const anchor = {
      id: "octogee-unmatched-route",
      name: "Unmatched Mattermost route",
      heartbeat: { every: "0m" },
    };
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            entries: {
              "octogee-alice-coach": { model: "house", default: true },
              "octogee-bob-coach": { model: "foreign" },
            },
            defaults: { authInheritance: { agentId: "octogee-alice-coach" } },
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "isolated",
      authInheritanceAnchor: { agentId: anchor.id, agent: anchor },
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: {
        entries: Record<string, Record<string, unknown>>;
        ownership: string;
        defaults: { authInheritance: { agentId: string } };
      };
    };
    expect(patch.agents.ownership).toBe("explicit");
    expect(patch.agents.defaults.authInheritance).toEqual({ agentId: anchor.id });
    expect(patch.agents.entries["octogee-alice-coach"]).toMatchObject({
      model: "house",
      default: true,
    });
    expect(patch.agents.entries[anchor.id]).toEqual({
      name: anchor.name,
      heartbeat: anchor.heartbeat,
    });
    expect(Object.keys(patch.agents.entries)).toEqual(["octogee-alice-coach", anchor.id]);
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("tools");
    expect(patch.agents.entries).not.toHaveProperty("octogee-bob-coach");
  });

  it.each(["entries", "list"] as const)("confirms stale auth anchor array replacement in a %s roster", async (roster) => {
    const anchor = {
      id: "octogee-unmatched-route",
      tools: { profile: "minimal", deny: ["exec", "process"] },
    };
    const denyPath = roster === "entries"
      ? `agents.entries.${anchor.id}.tools.deny`
      : "agents.list[].tools.deny";
    const staleAnchor = { tools: { profile: "minimal", deny: ["exec", "process", "browser"] } };
    const configPatch = vi.fn(async (patch: unknown, _hash: string, options?: { replacePaths: string[] }) => {
      expect(options?.replacePaths).toContain(denyPath);
      expect(options?.replacePaths).not.toContain("agents.entries.octogee-bob-coach.tools.deny");
      return { hash: "h2", config: patch };
    });
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: roster === "entries" ? { entries: {
            [anchor.id]: staleAnchor,
            "octogee-bob-coach": { tools: { deny: ["exec"] } },
          } } : { list: [{ id: anchor.id, ...staleAnchor }] },
          bindings: [],
        },
      })),
      configPatch,
    };

    await applyOpenClawActivationManifest(manifest(), {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "isolated",
      authInheritanceAnchor: { agentId: anchor.id, agent: anchor },
    });

    expect(configPatch).toHaveBeenCalledOnce();
    expect(configPatch.mock.calls[0]?.[0]).toMatchObject({
      agents: roster === "entries"
        ? { entries: { [anchor.id]: { tools: anchor.tools } } }
        : { list: expect.arrayContaining([expect.objectContaining(anchor)]) },
    });
  });

  it("adds the user auth anchor to a default-less list roster", async () => {
    const anchor = { id: "octogee-unmatched-route", heartbeat: { every: "0m" } };
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            list: [
              { id: "octogee-bob-coach", model: "foreign" },
              { ...anchor, name: "old anchor" },
              { id: "octogee-alice-coach", model: "house" },
            ],
            defaults: { authInheritance: { agentId: "octogee-alice-coach" } },
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "isolated",
      authInheritanceAnchor: { agentId: anchor.id, agent: anchor },
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: {
        list: Array<Record<string, unknown>>;
        ownership: string;
        defaults: { authInheritance: { agentId: string } };
      };
    };
    expect(patch.agents.ownership).toBe("explicit");
    expect(patch.agents.defaults.authInheritance).toEqual({ agentId: anchor.id });
    expect(withoutTools(patch.agents.list)).toContainEqual({ id: "octogee-bob-coach", model: "foreign" });
    expect(withoutTools(patch.agents.list)).toContainEqual({
      id: "octogee-alice-coach",
      model: "house",
    });
    expect(withoutTools(patch.agents.list).filter((agent) => agent.id === anchor.id)).toEqual([anchor]);
    expect(patch.agents.list.map((agent) => agent.id)).toEqual([
      "octogee-alice-coach",
      "octogee-bob-coach",
      anchor.id,
    ]);
    expect(patch.agents.list.find((agent) => agent.id === anchor.id)).not.toHaveProperty("tools");
    expect(patch.agents.list.find((agent) => agent.id === "octogee-alice-coach"))
      .not.toHaveProperty("tools");
  });

  it("lifts the exact shared agent tool fence when activating a user", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { entries: {} },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };
    const sharedDefaultAgentTools = {
      profile: "coding",
      alsoAllow: [...USER_WORKFLOW_TOOLS],
      deny: [...USER_CODE_DENIED_TOOLS],
      fs: { workspaceOnly: true },
      toolsBySender: {},
    };

    await applyOpenClawActivationManifest({
      ...manifest(),
      agent: { ...manifest().agent, tools: sharedDefaultAgentTools },
    }, {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "isolated",
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: { entries: Record<string, Record<string, unknown>> };
    };
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("tools");
  });

  it("lifts the exact shared project-agent tool fence when activating a user", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { entries: {} },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };
    const projectAgentId = "octogee-alice-proj-orbit-coach";
    const sharedProjectTools = {
      profile: "minimal",
      alsoAllow: [...PROJECT_AGENT_ALLOWED_TOOLS],
      deny: [...PROJECT_AGENT_DENIED_TOOLS],
      exec: { mode: "deny", host: "node" },
      fs: { workspaceOnly: true },
      toolsBySender: { "*": { deny: [...PRODUCTIVITY_TOOL_NAMES] } },
    };

    await applyOpenClawActivationManifest({
      ...manifest(),
      projectAgents: [{
        agentId: projectAgentId,
        accountId: "alice-proj-orbit",
        agent: { id: projectAgentId, tools: sharedProjectTools },
        mattermostAccount: {},
        bindings: [],
      }],
    }, {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "isolated",
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: { entries: Record<string, Record<string, unknown>> };
    };
    expect(patch.agents.entries[projectAgentId]).not.toHaveProperty("tools");
  });

  it("lifts drifted shared tool fences when a user returns from the shared gateway", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { entries: {} },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };
    const projectAgentId = "octogee-alice-proj-orbit-coach";
    const driftedDefaultAgentTools = {
      profile: "full",
      alsoAllow: ["octogee_project_create", "delegated_access", "browser", "computer", "message"],
      deny: [...USER_CODE_DENIED_TOOLS, "automations"],
      toolsBySender: {},
      fs: { workspaceOnly: true },
    };
    const driftedProjectTools = {
      deny: [...PROJECT_AGENT_DENIED_TOOLS, "computer", "nodes", "file-transfer", "ollama"],
      profile: "minimal",
      alsoAllow: [...PROJECT_AGENT_ALLOWED_TOOLS],
      fs: { workspaceOnly: true },
      toolsBySender: { "*": { deny: [...PRODUCTIVITY_TOOL_NAMES] } },
      exec: { mode: "deny", host: "node" },
    };

    await applyOpenClawActivationManifest({
      ...manifest(),
      agent: { ...manifest().agent, tools: driftedDefaultAgentTools },
      projectAgents: [{
        agentId: projectAgentId,
        accountId: "alice-proj-orbit",
        agent: { id: projectAgentId, tools: driftedProjectTools },
        mattermostAccount: {},
        bindings: [],
      }],
    }, {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "isolated",
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: { entries: Record<string, Record<string, unknown>> };
    };
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("tools");
    expect(patch.agents.entries[projectAgentId]).not.toHaveProperty("tools");
  });

  it("preserves a User-owned agent tool policy during activation", async () => {
    const configPatch = vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { entries: {} },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };
    const tools = { profile: "full", deny: ["browser"] };

    await applyOpenClawActivationManifest({
      ...manifest(),
      agent: { ...manifest().agent, tools },
    }, {
      rpc: rpc as never,
      log: vi.fn(),
      gatewayClass: "isolated",
    });

    const patch = configPatch.mock.calls[0]?.[0] as {
      agents: { entries: Record<string, Record<string, unknown>> };
    };
    expect(patch.agents.entries["octogee-alice-coach"]?.tools).toEqual(tools);
  });

  it("requests routing activation before patching only when the stable account route is absent", async () => {
    const accountBinding = {
      agentId: "octogee-alice-coach",
      match: { channel: "mattermost", accountId: "alice-coach" },
    };
    const activationManifest = {
      ...manifest(),
      bindings: [accountBinding],
    };
    const applyWith = async (
      bindings: unknown[],
      accounts: Record<string, unknown> = {},
      configNoop = false,
    ) => {
      const events: string[] = [];
      const onRoutingActivationRequired = vi.fn((accountIds: readonly string[]) => {
        events.push(`activation:${accountIds.join(",")}`);
      });
      const rpc = {
        configGet: vi.fn(async () => ({
          hash: "h1",
          configRevisionHash: "r1",
          appliedConfigHash: "r1",
          config: {
            agents: { list: [{ id: "octogee-bob-coach" }] },
            channels: { mattermost: { accounts } },
            bindings,
          },
        })),
        configPatch: vi.fn(async (patch: unknown) => {
          events.push("configPatch");
          return { hash: "h2", config: patch, ...(configNoop ? { noop: true } : {}) };
        }),
        close: vi.fn(async () => undefined),
      };

      const result = await applyOpenClawActivationManifest(activationManifest, {
        rpc: rpc as never,
        log: vi.fn(),
        onRoutingActivationRequired,
      });
      return { events, onRoutingActivationRequired, result, rpc };
    };

    const missing = await applyWith([]);
    expect(missing.events).toEqual(["activation:alice-coach", "configPatch"]);
    expect(missing.result.routingActivationRequired).toBe(true);
    expect(missing.result.restartExistingAccountIds).toEqual([]);

    const existingAccount = await applyWith([], {
      "alice-coach": { botToken: "stale-secret-ref" },
    });
    expect(existingAccount.result.routingActivationRequired).toBe(true);
    expect(existingAccount.result.restartExistingAccountIds).toEqual(["alice-coach"]);

    const present = await applyWith([accountBinding]);
    expect(present.events).toEqual(["configPatch"]);
    expect(present.onRoutingActivationRequired).not.toHaveBeenCalled();
    expect(present.result.routingActivationRequired).toBe(false);
    expect(present.result.configNoop).toBe(false);

    const noop = await applyWith([accountBinding], {}, true);
    expect(noop.result.routingActivationRequired).toBe(false);
    expect(noop.result.configNoop).toBe(true);

    const foreignPeer = {
      agentId: "octogee-bob-coach",
      match: {
        channel: "mattermost",
        accountId: "alice-coach",
        peer: { kind: "group", id: "alice-general" },
      },
    };
    const conflicted = await applyWith([accountBinding, foreignPeer]);
    expect(conflicted.events).toEqual(["activation:alice-coach", "configPatch"]);
    expect(conflicted.result.routingActivationRequired).toBe(true);
    expect(conflicted.rpc.configPatch.mock.calls[0]?.[0]).toMatchObject({
      bindings: [accountBinding],
    });

    const retiredProjectOnForeignAccount = {
      agentId: "octogee-alice-proj-retired-coach",
      match: { channel: "mattermost", accountId: "mike-coach" },
    };
    const retired = await applyWith(
      [accountBinding, retiredProjectOnForeignAccount],
      { "mike-coach": { botToken: "mike-pat" } },
    );
    expect(retired.events).toEqual(["configPatch"]);
    expect(retired.result.routingActivationRequired).toBe(false);
    expect(retired.result.restartExistingAccountIds).toEqual([]);
    expect(retired.rpc.configPatch.mock.calls[0]?.[0]).toMatchObject({
      bindings: [accountBinding],
    });

    const wildcardRoute = {
      agentId: "octogee-unmatched-route",
      match: { channel: "mattermost", accountId: "*" },
    };
    const wildcard = await applyWith(
      [wildcardRoute],
      { "alice-coach": { botToken: "stale-secret-ref" } },
    );
    expect(wildcard.events).toEqual(["activation:alice-coach", "configPatch"]);
    expect(wildcard.result.routingActivationRequired).toBe(true);
    expect(wildcard.result.restartExistingAccountIds).toEqual(["alice-coach"]);
    expect(wildcard.rpc.configPatch.mock.calls[0]?.[0]).toMatchObject({
      bindings: [wildcardRoute, accountBinding],
    });
  });

  it("rebinds redacted platform embedding refs before replacing the stable agent list", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string, _options?: { replacePaths?: readonly string[] }) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            list: [{
              id: "octogee-bob-coach",
              memorySearch: {
                provider: "openai-compatible",
                remote: {
                  baseUrl: "http://llm-broker:3010/v1",
                  apiKey: {
                    source: "exec",
                    provider: "gcp-secret-manager",
                    id: "__OPENCLAW_REDACTED__",
                  },
                },
              },
            }],
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { list: Array<{ id: string; memorySearch?: { remote?: { apiKey?: { id?: string } } } }> };
    };
    expect(patch.agents.list[0]?.memorySearch?.remote?.apiKey?.id).toBe(
      platformOpenAiEmbeddingSecretId("octogee-bob-coach"),
    );
  });

  it("replays all project agents while leaving foreign accounts and bindings out of the patch", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string, _options?: { replacePaths?: readonly string[] }) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            list: [
              { id: "octogee-bob-coach", model: "foreign" },
              { id: "octogee-alice-coach", model: "workspace-target" },
              { id: "octogee-alice-proj-old-coach", model: "retired" },
              { id: "octogee-alice-proj-orbit-coach", model: "orbit-target" },
            ],
          },
          channels: {
            mattermost: {
              accounts: {
                default: { botToken: { source: "file", id: "/default" } },
                "alice-proj-old": { botToken: { source: "file", id: "/old" } },
                "alice-proj-orbit": { botToken: { source: "file", id: "/orbit" } },
                "bob-coach": { botToken: { source: "file", id: "/bob" } },
              },
            },
          },
          bindings: [
            { agentId: "octogee-bob-coach", keep: true },
            { agentId: "octogee-alice-coach", stale: true },
            { agentId: "octogee-alice-proj-old-coach", stale: true },
            { agentId: "octogee-alice-proj-orbit-coach", stale: true },
          ],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };
    const projectManifest: MigrationActivationManifest = {
      ...manifest(),
      projectAgents: [
        {
          agentId: "octogee-alice-proj-orbit-coach",
          accountId: "alice-proj-orbit",
          agent: { id: "octogee-alice-proj-orbit-coach", model: "orbit-source" },
          mattermostAccount: { botToken: "orbit-pat" },
          bindings: [{ agentId: "octogee-alice-proj-orbit-coach", match: { peer: "orbit" } }],
        },
        {
          agentId: "octogee-alice-proj-scout-coach",
          accountId: "alice-proj-scout",
          agent: { id: "octogee-alice-proj-scout-coach", model: "scout-source" },
          mattermostAccount: { botToken: "scout-pat" },
          bindings: [{ agentId: "octogee-alice-proj-scout-coach", match: { peer: "scout" } }],
        },
      ],
    };

    await applyOpenClawActivationManifest(projectManifest, { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { list: Array<{ id: string; model?: string }> };
      bindings: Array<{ agentId: string; stale?: boolean; keep?: boolean }>;
      channels: { mattermost: { accounts: Record<string, unknown> } };
    };
    expect(withoutTools(patch.agents.list)).toEqual([
      { id: "octogee-bob-coach", model: "foreign" },
      { id: "octogee-alice-coach", model: "workspace-target" },
      { id: "octogee-alice-proj-orbit-coach", model: "orbit-target" },
      { id: "octogee-alice-proj-scout-coach", model: "scout-source" },
    ]);
    expect(patch.bindings).toEqual([
      { agentId: "octogee-bob-coach", keep: true },
      ...projectManifest.bindings,
      ...projectManifest.projectAgents.flatMap((entry) => entry.bindings),
    ]);
    expect(patch.channels.mattermost.accounts).toEqual({
      "alice-proj-old": null,
      "alice-coach": { ...projectManifest.mattermostAccount, baseUrl: "${MM_URL}" },
      "alice-proj-orbit": { ...projectManifest.projectAgents[0]!.mattermostAccount, baseUrl: "${MM_URL}" },
      "alice-proj-scout": { ...projectManifest.projectAgents[1]!.mattermostAccount, baseUrl: "${MM_URL}" },
    });
  });

  it("replays the finish-rsync activation manifest into beta keyed entries without sending agents.list", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string, _options?: { replacePaths?: readonly string[] }) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            entries: {
              "octogee-alice-coach": { model: "house" },
              "octogee-bob-coach": { model: "other" },
            },
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [{ agentId: "octogee-bob-coach", keep: true }],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest({
      ...manifest(),
      agent: {
        id: "octogee-alice-coach",
        model: "custom-model",
        memorySearch: { provider: "openai-compatible" },
      },
    }, { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { entries: Record<string, Record<string, unknown>> };
      bindings: Array<{ agentId: string; keep?: boolean }>;
    };
    expect(patch.agents.entries["octogee-alice-coach"]).toMatchObject({
      model: "house",
      memory: { search: { provider: "openai-compatible" } },
    });
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("id");
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("memorySearch");
    expect(patch.agents).not.toHaveProperty("list");
    expect(patch.agents.entries).not.toHaveProperty("octogee-bob-coach");
    expect(patch.bindings).toEqual([
      { agentId: "octogee-bob-coach", keep: true },
      { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } },
    ]);
    expect(configPatch.mock.calls[0][2]).toEqual({ replacePaths: ["bindings"] });
  });

  it("downgrades a beta memory.search agent to stable memorySearch during activation", async () => {
    const sourceDir = await mkTmp();
    const sourceConfigPath = path.join(sourceDir, "openclaw.json");
    await fs.writeFile(sourceConfigPath, JSON.stringify({
      agents: {
        list: [{
          id: "octogee-alice-coach",
          model: "beta-model",
          tools: {
            profile: "coding",
            alsoAllow: USER_WORKFLOW_TOOLS,
            deny: ["preview_start", "preview_stop", "preview_list", "octogee_publish"],
            fs: { workspaceOnly: true },
            toolsBySender: {},
          },
          memory: { search: { provider: "openai-compatible", model: "text-embedding-3-small" } },
        }],
      },
      channels: { mattermost: { accounts: { "alice-coach": { botToken: "default-agent-pat" } } } },
      bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
    }));
    const configPatch = vi.fn(async (patch: unknown, _hash: string, _options?: { replacePaths?: readonly string[] }) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { list: [{ id: "octogee-alice-coach", model: "house" }] },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    const betaManifest = await extractOpenClawActivationManifest(sourceConfigPath, "alice", {
      appliedFingerprint: APPLIED_FINGERPRINT,
    });
    await applyOpenClawActivationManifest(betaManifest, { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { list: Array<Record<string, unknown>> };
    };
    expect(withoutTools(patch.agents.list)).toEqual([
      {
        id: "octogee-alice-coach",
        model: "house",
        memorySearch: { provider: "openai-compatible", model: "text-embedding-3-small" },
      },
    ]);
    expect(patch.agents.list[0]).not.toHaveProperty("memory");
    const candidate: Record<string, unknown> = {};
    reconcilePlatformInvariants(candidate, { gatewayClass: "shared" });
    candidate.agents = patch.agents;
    expect(platformInvariantViolations(candidate, { gatewayClass: "shared" })).toEqual([]);
  });

  it("refuses beta-only memory fields that stable agents cannot represent", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string, _options?: { replacePaths?: readonly string[] }) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { list: [{ id: "octogee-alice-coach", model: "house" }] },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await expect(applyOpenClawActivationManifest({
      ...manifest(),
      agent: {
        id: "octogee-alice-coach",
        memory: {
          search: { provider: "openai-compatible" },
          consolidation: { enabled: true },
        },
      },
    }, { rpc: rpc as never, log: vi.fn() })).rejects.toThrow(
      /stable target cannot represent beta agent memory fields: consolidation/,
    );
    expect(configPatch).not.toHaveBeenCalled();
  });

  it("preserves the target gateway's current agent model when activation replays stale agent metadata", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string, _options?: { replacePaths?: readonly string[] }) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: {
            list: [
              {
                id: "octogee-alice-coach",
                model: { primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] },
              },
            ],
          },
          channels: { mattermost: { accounts: {} } },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest({
      ...manifest(),
      agent: {
        id: "octogee-alice-coach",
        name: "Gene (alice)",
        model: { primary: "anthropic/claude-haiku-4-5", fallbacks: [] },
        identity: { name: "Gene", emoji: ":sparkles:" },
      },
    }, { rpc: rpc as never, log: vi.fn() });

    const patch = configPatch.mock.calls[0][0] as {
      agents: { list: Array<{ id: string; model?: unknown; name?: string }> };
    };
    expect(withoutTools(patch.agents.list)).toEqual([
      {
        id: "octogee-alice-coach",
        name: "Gene (alice)",
        model: { primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] },
        identity: { name: "Gene", emoji: ":sparkles:" },
      },
    ]);
  });

  it("confirms the residual account's arrays when importing over residue (re-import case)", async () => {
    const configPatch = vi.fn(async (patch: unknown, _hash: string, _options?: { replacePaths?: readonly string[] }) => ({
      hash: "h2",
      config: patch,
    }));
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: {
          agents: { list: [] },
          channels: {
            mattermost: {
              accounts: {
                default: { botToken: "mac" },
                // Residue from a prior mount of the same slug — its allowlist array must be
                // confirmed or the merged (possibly shrunk) account fragment trips the guard.
                "alice-coach": { botToken: "stale-pat", groupAllowFrom: ["mm-old-1", "mm-old-2"] },
              },
            },
          },
          bindings: [],
        },
      })),
      configPatch,
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), { rpc: rpc as never, log: vi.fn() });

    expect(configPatch.mock.calls[0][2]).toEqual({
      replacePaths: [
        "agents.list",
        "agents.list[].model.fallbacks",
        "agents.list[].tools.alsoAllow",
        "bindings",
        "channels.mattermost.accounts.alice-coach.groupAllowFrom",
      ],
    });
  });
});

describe("migration activation manifest — patch budget", () => {
  it("gives the activation patch the import deadline, not the ordinary config-patch one", async () => {
    vi.mocked(applyConfigPatch).mockClear();
    const rpc = {
      configGet: vi.fn(async () => ({
        hash: "h1",
        config: { agents: { entries: {} }, channels: { mattermost: { accounts: {} } }, bindings: [] },
      })),
      configPatch: vi.fn(async (patch: unknown) => ({ hash: "h2", config: patch })),
      close: vi.fn(async () => undefined),
    };

    await applyOpenClawActivationManifest(manifest(), { rpc: rpc as never, log: vi.fn() });

    expect(vi.mocked(applyConfigPatch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyConfigPatch).mock.calls[0][1]).toMatchObject({
      totalDeadlineMs: IMPORT_ACTIVATION_PATCH_DEADLINE_MS,
    });
  });
});


describe.skipIf(process.platform !== "linux")("source rollback workspace identities", () => {
  const custody = { migrationId: "mig-alice", uid: "uid-alice", gatewayId: "shared-source", podUid: "source-pod", epoch: 0 };
  async function source() {
    const root = await mkTmp();
    const workspace = path.join(root, "customers", "alice"), project = path.join(workspace, "projects", "orbit");
    await fs.mkdir(project, { recursive: true });
    const value = manifest();
    value.agent.workspace = workspace;
    const projectId = "octogee-alice-proj-orbit-coach";
    value.projectAgents = [{ agentId: projectId, accountId: "alice-proj-orbit", agent: { id: projectId, workspace: project },
      mattermostAccount: { botToken: "project-pat" }, bindings: [{ agentId: projectId, match: { channel: "mattermost", accountId: "alice-proj-orbit" } }] }];
    return { root, workspace, project, value };
  }

  it("preserves the private agent identity in a transfer without opening the checkout identity", async () => {
    const f = await source();
    const project = path.join(f.workspace, ".system", "project-coaches", "orbit");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, "IDENTITY.md"), "private persona");
    await fs.writeFile(path.join(f.project, "IDENTITY.md"), "repo persona");
    f.value.projectAgents[0].agent.workspace = project;

    const captured = await captureSourceWorkspaceIdentities(f.value, f.root, custody);
    await writeActivationManifest(f.root, captured);
    const manifest = await readActivationManifest(f.root, "alice");
    const agentIds = activationManifestAgentIds(manifest);
    const privateWorkspaces = privateProjectWorkspaceAgentIds(manifest);
    const target = { migrationId: custody.migrationId, uid: custody.uid, gatewayId: "shared-target", podUid: "target-pod" };
    const targetCapture = await captureTargetWorkspaceIdentities("alice", agentIds, f.root, target, privateWorkspaces);
    await fs.writeFile(path.join(project, "IDENTITY.md"), "transient native rewrite");
    await restoreTargetWorkspaceIdentities(targetCapture, "alice", agentIds, f.root, { custody: target, privateWorkspaces, assertCurrent: async () => undefined });
    expect(await fs.readFile(path.join(project, "IDENTITY.md"), "utf8")).toBe("private persona");
    expect(await fs.readFile(path.join(f.project, "IDENTITY.md"), "utf8")).toBe("repo persona");
  });

  it("accepts legacy project custody during rollout and seeds a separate workspace after mount", async () => {
    const f = await source();
    const oldIdentity = path.join(f.project, "IDENTITY.md");
    await fs.writeFile(oldIdentity, "legacy repo identity");
    const captured = await captureSourceWorkspaceIdentities(f.value, f.root, custody);
    await writeActivationManifest(f.root, captured);
    const incoming = await readActivationManifest(f.root, "alice");
    expect(privateProjectWorkspaceAgentIds(incoming).size).toBe(0);
    await restoreSourceWorkspaceIdentities(incoming, f.root, custody, async () => undefined);
    await initializeRelocatedProjectAgent({ customerDir: f.workspace, project: "orbit", name: "Private Persona", emoji: "🐙" });
    const privateIdentity = path.join(projectAgentWorkspace(f.workspace, "orbit"), "IDENTITY.md");
    expect(await fs.readFile(privateIdentity, "utf8")).toContain("Private Persona");
    expect(await fs.readFile(oldIdentity, "utf8")).toBe("legacy repo identity");
  });

  it("durably retains exact Unicode/CRLF bytes and intentional absence across retry without recapturing Native drift", async () => {
    const f = await source(), file = path.join(f.project, "IDENTITY.md");
    const original = Buffer.from("# Persona\r\n- **Name:** Harbor 🐙\r\n\r\nAuthored notes\r\n");
    await fs.writeFile(file, original);
    const captured = await captureSourceWorkspaceIdentities(f.value, f.root, custody);
    await writeActivationManifest(f.root, captured);
    await fs.writeFile(file, "- Name: native-machine-id\n");
    await fs.writeFile(path.join(f.workspace, "IDENTITY.md"), "Native-created file\n");
    const restored = await readActivationManifest(f.root, "alice");
    expect(await captureSourceWorkspaceIdentities(restored, f.root, custody)).toEqual(captured);
    const current = vi.fn(async () => undefined);
    await restoreSourceWorkspaceIdentities(restored, f.root, custody, current);
    expect(await fs.readFile(file)).toEqual(original);
    await expect(fs.stat(path.join(f.workspace, "IDENTITY.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await restoreSourceWorkspaceIdentities(restored, f.root, custody, current);
    expect(await fs.readFile(file)).toEqual(original);
    expect(current).toHaveBeenCalledTimes(2);
  });

  it.each(["capture", "restore"] as const)("rejects a FIFO identity without blocking %s", async mode => {
    const f = await source(), file = path.join(f.project, "IDENTITY.md");
    await fs.writeFile(file, "original persona");
    const value = mode === "restore" ? await captureSourceWorkspaceIdentities(f.value, f.root, custody) : f.value;
    await fs.unlink(file);
    execFileSync("/usr/bin/mkfifo", [file]);
    const result = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-"], { timeout: 4_000, killSignal: "SIGKILL", stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      let opening: ReturnType<typeof setTimeout> | undefined;
      child.stdout.on("data", bytes => {
        stdout += bytes;
        if (!opening && stdout.includes("Opening FIFO")) opening = setTimeout(() => { child.kill("SIGKILL"); }, 2_000);
      });
      child.stderr.on("data", bytes => { stderr += bytes; });
      child.on("error", reject);
      child.on("close", (code, signal) => { clearTimeout(opening); resolve({ code, signal, stdout, stderr }); });
      child.stdin.end(`import { captureSourceWorkspaceIdentities, restoreSourceWorkspaceIdentities } from ${JSON.stringify(new URL("../dist/migration-activation-manifest.js", import.meta.url).href)};
        try {
          const manifest = ${JSON.stringify(value)}, root = ${JSON.stringify(f.root)}, custody = ${JSON.stringify(custody)};
          process.stdout.write("Opening FIFO\\n");
          if (${JSON.stringify(mode)} === "capture") await captureSourceWorkspaceIdentities(manifest, root, custody);
          else await restoreSourceWorkspaceIdentities(manifest, root, custody, async () => {});
          process.stderr.write("FIFO was accepted"); process.exitCode = 2;
        } catch (error) {
          if (!String(error.message).includes("identity file is unsafe")) throw error;
          process.stdout.write("FIFO refused");
        }`);
    });
    expect(result, JSON.stringify(result)).toMatchObject({ code: 0, signal: null });
    expect(result.stdout).toContain("FIFO refused");
    expect((await fs.lstat(file)).isFIFO()).toBe(true);
  });

  it.each(["workspace", "file", "hardlink"])("refuses an unsafe %s without following it", async mode => {
    const f = await source(), outside = await mkTmp();
    const target = path.join(outside, "IDENTITY.md");
    await fs.writeFile(target, "foreign bytes");
    if (mode === "workspace") { await fs.rm(f.project, { recursive: true }); await fs.symlink(outside, f.project); }
    else if (mode === "file") await fs.symlink(target, path.join(f.project, "IDENTITY.md"));
    else await fs.link(target, path.join(f.project, "IDENTITY.md"));
    await expect(captureSourceWorkspaceIdentities(f.value, f.root, custody)).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("foreign bytes");
  });

  it.each(["workspace", "agent"])("refuses foreign captured %s authority", async mode => {
    const f = await source();
    if (mode === "workspace") f.value.projectAgents[0].agent.workspace = f.workspace;
    else f.value.projectAgents[0].agentId = "octogee-bob-proj-orbit-coach";
    await expect(captureSourceWorkspaceIdentities(f.value, f.root, custody)).rejects.toThrow(/foreign|canonical/);
  });

  it("refuses content corruption and files exceeding the existing Native identity limit", async () => {
    const f = await source(), file = path.join(f.project, "IDENTITY.md");
    await fs.writeFile(file, "original");
    const captured = await captureSourceWorkspaceIdentities(f.value, f.root, custody);
    captured.sourceWorkspaceIdentities!.files[1].content = Buffer.from("tampered").toString("base64");
    await writeActivationManifest(f.root, captured);
    await expect(readActivationManifest(f.root, "alice")).rejects.toThrow("capture changed");
    await fs.writeFile(file, Buffer.alloc(4 * 1024 ** 2 + 1));
    await expect(captureSourceWorkspaceIdentities(f.value, f.root, custody)).rejects.toThrow("limit");
  });

  it("retains target persona bytes and absence with distinct target custody and final no-op authorization", async () => {
    const f = await source(), ids = [f.value.agentId, f.value.projectAgents[0].agentId];
    const binding = { migrationId: "mig-target", uid: "uid-alice", gatewayId: "shared-target", podUid: "target-pod" };
    const bytes = Buffer.from("# Authored target\r\n- Name: Human 🐙\r\n");
    await fs.writeFile(path.join(f.project, "IDENTITY.md"), bytes);
    const capture = await captureTargetWorkspaceIdentities("alice", ids, f.root, binding);
    await writeActivationManifest(f.root, { ...f.value, targetWorkspaceIdentities: capture });
    await fs.writeFile(path.join(f.project, "IDENTITY.md"), "Native machine Name");
    await fs.writeFile(path.join(f.workspace, "IDENTITY.md"), "Native-created persona");
    const retained = await readActivationManifest(f.root, "alice");
    const current = vi.fn(async () => undefined);
    await restoreTargetWorkspaceIdentities(retained.targetWorkspaceIdentities!, "alice", ids, f.root, { custody: binding, assertCurrent: current });
    expect(await fs.readFile(path.join(f.project, "IDENTITY.md"))).toEqual(bytes);
    await expect(fs.stat(path.join(f.workspace, "IDENTITY.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(current).toHaveBeenCalledTimes(4);
    await expect(restoreTargetWorkspaceIdentities(capture, "alice", ids, f.root, { custody: binding, assertCurrent: async () => { throw new Error("target claim changed"); } })).rejects.toThrow("claim changed");
    expect((await readActivationManifest(f.root, "alice")).targetWorkspaceIdentities).toEqual(capture);
  });

  it.each(["pod", "agent", "hash", "symlink", "root"])("refuses unsafe target identity capture or replay: %s", async mode => {
    const f = await source(), ids = [f.value.agentId, f.value.projectAgents[0].agentId];
    const binding = { migrationId: "mig-target", uid: "uid-alice", gatewayId: "shared-target", podUid: "target-pod" };
    await fs.writeFile(path.join(f.project, "IDENTITY.md"), "original");
    const capture = await captureTargetWorkspaceIdentities("alice", ids, f.root, binding);
    if (mode === "pod") capture.podUid = "foreign-pod";
    if (mode === "agent") capture.files[1].agentId = "octogee-bob-coach";
    if (mode === "hash") capture.files[1].sha256 = "0".repeat(64);
    if (mode === "symlink") { await fs.unlink(path.join(f.project, "IDENTITY.md")); await fs.symlink(path.join(f.workspace, "IDENTITY.md"), path.join(f.project, "IDENTITY.md")); }
    const result = mode === "symlink" || mode === "root"
      ? captureTargetWorkspaceIdentities("alice", ids, mode === "root" ? path.join(f.root, "missing") : f.root, binding)
      : restoreTargetWorkspaceIdentities(capture, "alice", ids, f.root, { custody: binding, assertCurrent: async () => undefined });
    await expect(result).rejects.toThrow();
  });

  it("restores only missing-agent target captures without rewriting a live agent", async () => {
    const f = await source(), ids = [f.value.agentId, f.value.projectAgents[0].agentId];
    const binding = { assignmentEpoch: 4, uid: "uid-alice", gatewayId: "shared-target", podUid: "target-pod" };
    await fs.writeFile(path.join(f.project, "IDENTITY.md"), "authored project");
    const capture = await captureTargetWorkspaceIdentities("alice", [ids[1]], f.root, binding);
    await writeActivationManifest(f.root, { ...f.value, targetWorkspaceIdentities: capture });
    await fs.writeFile(path.join(f.project, "IDENTITY.md"), "Native Name");
    await fs.writeFile(path.join(f.workspace, "IDENTITY.md"), "live agent edit");
    const retained = await readActivationManifest(f.root, "alice");
    await restoreTargetWorkspaceIdentities(retained.targetWorkspaceIdentities!, "alice", ids, f.root, { custody: binding, assertCurrent: async () => undefined });
    expect(await fs.readFile(path.join(f.project, "IDENTITY.md"), "utf8")).toBe("authored project");
    expect(await fs.readFile(path.join(f.workspace, "IDENTITY.md"), "utf8")).toBe("live agent edit");
  });

  it("keeps source identity captures out of the Native config RPC payload", async () => {
    const f = await source();
    const original = Buffer.from("private source identity bytes that belong only in the retained manifest");
    await fs.writeFile(path.join(f.project, "IDENTITY.md"), original);
    const captured = await captureSourceWorkspaceIdentities(f.value, f.root, custody);
    captured.targetWorkspaceIdentities = await captureTargetWorkspaceIdentities("alice", [captured.agentId, ...captured.projectAgents.map(agent => agent.agentId)], f.root, { migrationId: "mig-target", uid: custody.uid, gatewayId: "shared-target", podUid: "target-pod" });
    const patches: object[] = [];
    await applyOpenClawActivationManifest(captured, {
      rpc: { configGet: async () => ({ config: {}, hash: "before" }), configPatch: async (patch: object) => { patches.push(patch); return { hash: "after" }; } } as never,
      log: vi.fn(),
    });
    expect(patches.length).toBeGreaterThan(0);
    expect(JSON.stringify(patches)).not.toContain("sourceWorkspaceIdentities");
    expect(JSON.stringify(patches)).not.toContain("targetWorkspaceIdentities");
    expect(JSON.stringify(patches)).not.toContain(original.toString("base64"));
    expect(JSON.stringify(patches)).not.toContain(custody.podUid);
  });

  it("keeps Native drift and the original durable capture when the final custody check refuses", async () => {
    const f = await source(), file = path.join(f.project, "IDENTITY.md");
    await fs.writeFile(file, "original");
    const captured = await captureSourceWorkspaceIdentities(f.value, f.root, custody);
    await writeActivationManifest(f.root, captured);
    await fs.writeFile(file, "Native drift");
    await expect(restoreSourceWorkspaceIdentities(captured, f.root, custody, async () => { throw new Error("source departed"); })).rejects.toThrow("source departed");
    expect(await fs.readFile(file, "utf8")).toBe("Native drift");
    expect((await readActivationManifest(f.root, "alice")).sourceWorkspaceIdentities).toEqual(captured.sourceWorkspaceIdentities);
  });
});
