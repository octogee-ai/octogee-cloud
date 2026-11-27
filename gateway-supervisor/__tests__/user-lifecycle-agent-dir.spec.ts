import * as fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import type { GatewayRpcClient } from "../lib/gateway-rpc.js";
import type { UserSnapshot } from "../lib/user-lifecycle.js";
import { stubUserClaim } from "./helpers/user-claim.js";

const supervisorStatus = vi.hoisted(() => vi.fn());
vi.mock("../lib/surge-openclaw-process-gate.js", () => ({
  createSurgeOpenClawProcessSupervisorClient: () => ({ status: supervisorStatus }),
}));

vi.mock("../lib/agent-model-token-materializer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agent-model-token-materializer.js")>();
  return {
    ...actual,
    materializeBrokerProfilesForAgents: vi.fn(async (agentIds: string[]) => ({
      materialized: agentIds.length,
      deferred: [],
    })),
  };
});

vi.mock("../lib/mattermost-account-secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mattermost-account-secrets.js")>();
  return { ...actual, updateMattermostAccountSecrets: vi.fn(async () => ({ changed: true })) };
});

const defaultAgentGit = vi.hoisted(() => ({ restore: vi.fn(), ensure: vi.fn(async () => undefined) }));
vi.mock("@octogee/core/project-agent-workspaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octogee/core/project-agent-workspaces")>();
  return { ...actual, restoreProjectAgentWorkspaces: defaultAgentGit.restore };
});
vi.mock("../lib/gitea-admin-broker-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/gitea-admin-broker-client.js")>();
  return { ...actual, brokeredGitHost: { ...actual.brokeredGitHost, ensureRepo: defaultAgentGit.ensure } };
});

interface RuntimeMock {
  tempRoot: string;
  agentsDir: string;
  applyConfigPatch: ReturnType<typeof vi.fn>;
}

const ALICE_MM_USER_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE_DEFAULT_AGENT_MM_USER_ID = "cccccccccccccccccccccccccc";

const userSnapshot: UserSnapshot = {
  uid: "uid-alice",
  slug: "alice",
  contextTemplateKey: "default",
  planInputs: { tier: "standard" },
  gatewayId: "default-blue",
  status: "complete",
  agentIds: [],
  repoUrl: "",
  mattermostUserId: ALICE_MM_USER_ID,
  channels: [],
  ownerName: "Alice",
};

const brokerSnapshot: FleetBrokerUserSnapshot = {
  ...userSnapshot,
  customerMmUserId: ALICE_MM_USER_ID,
  coachToken: "pat-1",
  defaultAgentMmUserId: ALICE_DEFAULT_AGENT_MM_USER_ID,
  projects: [],
};

function mkClient(snapshot: FleetBrokerUserSnapshot): FleetBrokerClient {
  return {
    assignedUsers: vi.fn(async () => []),
    uidForSlug: vi.fn(async () => snapshot.uid),
    userSnapshot: vi.fn(async () => snapshot),
    reconcileProjectAgentMembership: vi.fn(async () => undefined),
    setProvisioningStatus: vi.fn(async () => undefined),
    setRepoUrl: vi.fn(async () => undefined),
    provisionMattermost: vi.fn(async () => ({})),
    setMattermostFields: vi.fn(async () => undefined),
    ensureAgentIds: vi.fn(async () => undefined),
    setMounted: vi.fn(async () => undefined),
    recordReconcileError: vi.fn(async () => undefined),
    clearReconcileError: vi.fn(async () => undefined),
    reportProvisioned: vi.fn(async () => undefined),
    recordUsageEvent: vi.fn(async () => undefined),
    blobDownloadUrl: vi.fn(async () => ({
      url: "https://example.com/download",
      method: "GET",
      gcsPath: "customers/alice/file",
      expiresAt: new Date(0).toISOString(),
    })),
    blobUploadUrl: vi.fn(async () => ({
      url: "https://example.com/upload",
      method: "PUT",
      gcsPath: "customers/alice/file",
      expiresAt: new Date(0).toISOString(),
    })),
  };
}

function seedLocalAgentDatabase(file: string, state: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE fixture_state(value TEXT)");
    db.prepare("INSERT INTO fixture_state VALUES (?)").run(state);
  } finally { db.close(); }
}

function readLocalAgentFixtureState(file: string): unknown {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT value FROM fixture_state").get()?.value; }
  finally { db.close(); }
}

async function procRootHolding(tempRoot: string, files: readonly string[]): Promise<string> {
  const procRoot = path.join(tempRoot, "proc");
  await fs.mkdir(path.join(procRoot, "92", "fd"), { recursive: true });
  for (const [index, file] of files.entries()) {
    await fs.symlink(file, path.join(procRoot, "92", "fd", String(40 + index)));
  }
  return procRoot;
}

async function procRootHoldingWithFlags(
  tempRoot: string,
  files: readonly { path: string; flags: string }[],
): Promise<string> {
  const procRoot = path.join(tempRoot, "proc");
  await fs.mkdir(path.join(procRoot, "93", "fd"), { recursive: true });
  await fs.mkdir(path.join(procRoot, "93", "fdinfo"), { recursive: true });
  for (const [index, file] of files.entries()) {
    const descriptor = String(40 + index);
    await fs.symlink(file.path, path.join(procRoot, "93", "fd", descriptor));
    await fs.writeFile(path.join(procRoot, "93", "fdinfo", descriptor), `pos:\t0\nflags:\t${file.flags}\nmnt_id:\t1\n`);
  }
  return procRoot;
}

async function seedDepartedUserResidue(tempRoot: string): Promise<{ departed: string[]; kept: string[] }> {
  const expiryDir = path.join(tempRoot, "secrets", "agent-model-token-expiry");
  const expiry = async (refId: string): Promise<string> => {
    const filename = path.join(expiryDir, `${Buffer.from(refId, "utf8").toString("base64url")}.json`);
    await fs.mkdir(expiryDir, { recursive: true });
    await fs.writeFile(filename, `${JSON.stringify({ refId, expiresAt: 1_900_000_000_000 })}\n`);
    return filename;
  };
  const dir = async (...segments: string[]): Promise<string> => {
    const target = path.join(tempRoot, ...segments);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "HEAD"), "ref: refs/heads/main\n");
    return target;
  };
  const departed = [
    path.dirname(await dir("git-metadata", "alice", "workspace.git")),
    await dir("git-metadata", "alice", "projects", "demo.git"),
    await dir("git-metadata-quarantine", "alice", "workspace.git-stale"),
    await dir("git-source-switch-locks", "alice", "demo.git"),
    await dir("git-worktree-quarantine", "alice", "demo-stale"),
    await dir("git-metadata-source-switch-backups", "alice", "demo-stale"),
    await expiry("agent-model-token-octogee-alice-coach"),
    await expiry("agent-model-token-openrouter-octogee-alice-coach"),
    await expiry("agent-model-token-openai-octogee-alice-proj-demo-coach"),
    await expiry("agent-embedding-token-openai-octogee-alice-coach"),
  ];
  const trustReceipt = path.join(tempRoot, "git-metadata", "alice", "workspace.git.octogee-trusted-v3");
  await fs.writeFile(trustReceipt, "octogee-customer-git-v3\n");
  departed.push(trustReceipt);
  const kept = [
    await dir("git-metadata", "alice-smith", "workspace.git"),
    await dir("git-metadata-quarantine", "alice-smith", "workspace.git-stale"),
    await expiry("agent-model-token-openrouter-octogee-alice-smith-coach"),
  ];
  return { departed, kept };
}

function removalRpc(agentsDelete: ReturnType<typeof vi.fn>): GatewayRpcClient {
  return {
    configGet: vi.fn(async () => ({
      config: { agents: { entries: { "octogee-alice-coach": { model: "house" } } } },
      hash: "cfg-hash",
    })),
    agentsDelete,
    channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
    channelsStop: vi.fn(async () => ({ ok: true as const })),
  } as unknown as GatewayRpcClient;
}

async function withRuntimeMock(fn: (runtime: RuntimeMock) => Promise<void>): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "user-agent-dir-"));
  const agentsDir = path.join(tempRoot, "agents");
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const applyConfigPatch = vi.fn(async () => {
    expect(fsSync.existsSync(path.join(agentsDir, "octogee-alice-coach", "agent"))).toBe(true);
    return { mode: "rpc" as const, attempts: 1 };
  });
  vi.resetModules();
  vi.doMock("../lib/config.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/config.js")>();
    return {
      ...actual,
      OPENCLAW_DIR: tempRoot,
      OPENCLAW_CONFIG: path.join(tempRoot, "openclaw.json"),
      readOpenClawConfig: () => JSON.parse(fsSync.readFileSync(path.join(tempRoot, "openclaw.json"), "utf8")),
      AGENTS_DIR: agentsDir,
      CUSTOMERS_DIR: path.join(tempRoot, "customers"),
      CUSTOMER_KEYS_DIR: path.join(tempRoot, "customer-keys"),
    };
  });
  vi.doMock("../lib/apply-config-patch.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../lib/apply-config-patch.js")>();
    return { ...actual, applyConfigPatch };
  });
  try {
    await fn({ tempRoot, agentsDir, applyConfigPatch });
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    vi.doUnmock("../lib/config.js");
    vi.doUnmock("../lib/apply-config-patch.js");
    vi.resetModules();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

describe("user lifecycle config patch agent directories", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("broker adapter creates the agent dir before adding the user config", async () => {
    await withRuntimeMock(async ({ agentsDir, applyConfigPatch }) => {
      const initialSnapshot = { ...brokerSnapshot, status: "provisioning" as const };
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(initialSnapshot),
        rpc: {
          channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
          channelsStop: vi.fn(async ({ channel, accountId }) => ({
            channel,
            accountId,
            stopped: true as const,
          })),
          channelsStart: vi.fn(async ({ channel, accountId }) => ({
            channel,
            accountId,
            started: true as const,
          })),
          configGet: vi.fn(async () => ({
            config: { agents: { entries: { "octogee-alice-coach": { model: "house" } } } },
            hash: "cfg-hash",
          })),
          agentsDelete: vi.fn(async ({ agentId }: { agentId: string }) => ({
            ok: true as const,
            agentId,
          })),
          agentsCreate: vi.fn(async ({ name, workspace }: { name: string; workspace: string }) => ({
            ok: true as const,
            agentId: name,
            name,
            workspace,
          })),
          secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
        } as unknown as GatewayRpcClient,
        log: vi.fn(),
      });

      await adapter.applyAddUserConfigPatch(initialSnapshot, { _coachPersonalToken: "pat-1" });

      expect(fsSync.existsSync(path.join(agentsDir, "octogee-alice-coach", "agent"))).toBe(true);
      expect(applyConfigPatch).toHaveBeenCalledTimes(1);
    });
  });

  describe("retiring a project agent", () => {
    const retiredId = "octogee-alice-proj-orbit-coach";
    const coachId = "octogee-alice-coach";
    const evictedId = "octogee-bob-coach";

    function retirementRpc(agentsDelete: ReturnType<typeof vi.fn>): GatewayRpcClient {
      return {
        channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
        channelsStop: vi.fn(async ({ channel, accountId }) => ({ channel, accountId, stopped: true as const })),
        channelsStart: vi.fn(async ({ channel, accountId }) => ({ channel, accountId, started: true as const })),
        configGet: vi.fn(async () => ({
          config: { agents: { entries: { [coachId]: { model: "house" }, [retiredId]: {}, [evictedId]: {} } } },
          hash: "cfg-hash",
        })),
        agentsDelete,
        agentsCreate: vi.fn(async ({ name, workspace }: { name: string; workspace: string }) => ({
          ok: true as const, agentId: name, name, workspace,
        })),
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
    }

    const provisioningSnapshot = { ...brokerSnapshot, status: "provisioning" as const };

    async function seedAgentStates(tempRoot: string, agentsDir: string) {
      const database = (agentId: string) => path.join(agentsDir, agentId, "agent", "openclaw-agent.sqlite");
      for (const agentId of [coachId, retiredId, evictedId]) {
        await fs.mkdir(path.dirname(database(agentId)), { recursive: true });
        seedLocalAgentDatabase(database(agentId), agentId);
      }
      const projectFile = path.join(tempRoot, "customers", "alice", "projects", "orbit", "README.md");
      await fs.mkdir(path.dirname(projectFile), { recursive: true });
      await fs.writeFile(projectFile, "# orbit");
      return { database, projectFile };
    }

    it("removes the retired agent's state folder and leaves other agents and the project files in place", async () => {
      await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
        process.env.OPENCLAW_STATE_DIR = tempRoot;
        const { database, projectFile } = await seedAgentStates(tempRoot, agentsDir);
        const agentsDelete = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId, removedBindings: 0 }));
        const { buildBrokeredLifecycleAdapter } = await import("../lib/user-lifecycle-broker-adapter.js");
        const adapter = buildBrokeredLifecycleAdapter({
          client: mkClient(provisioningSnapshot),
          rpc: retirementRpc(agentsDelete),
          log: vi.fn(),
          procRoot: await procRootHolding(tempRoot, []),
        });

        await adapter.applyAddUserConfigPatch(provisioningSnapshot, { _coachPersonalToken: "pat-1" }, { evictionBatch: ["bob"] });

        expect(agentsDelete).toHaveBeenCalledWith({ agentId: retiredId, deleteFiles: false });
        expect(agentsDelete).toHaveBeenCalledWith({ agentId: evictedId, deleteFiles: false });
        expect(fsSync.existsSync(path.join(agentsDir, retiredId))).toBe(false);
        expect(readLocalAgentFixtureState(database(coachId))).toBe(coachId);
        expect(readLocalAgentFixtureState(database(evictedId))).toBe(evictedId);
        expect(await fs.readFile(projectFile, "utf8")).toBe("# orbit");
      });
    });

    it("detaches an archived project's agent and keeps its store and state folder for its owner's next move", async () => {
      await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
        process.env.OPENCLAW_STATE_DIR = tempRoot;
        const { database } = await seedAgentStates(tempRoot, agentsDir);
        const agentsDelete = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId, removedBindings: 0 }));
        const agentsDetach = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId, removedBindings: 0 }));
        const archivedSnapshot = { ...provisioningSnapshot, archivedProjectIds: ["orbit"] };
        const { buildBrokeredLifecycleAdapter } = await import("../lib/user-lifecycle-broker-adapter.js");
        const adapter = buildBrokeredLifecycleAdapter({
          client: mkClient(archivedSnapshot),
          rpc: { ...retirementRpc(agentsDelete), agentsDetach } as unknown as GatewayRpcClient,
          log: vi.fn(),
          procRoot: await procRootHolding(tempRoot, []),
        });

        await adapter.applyAddUserConfigPatch(archivedSnapshot, { _coachPersonalToken: "pat-1" }, { evictionBatch: ["bob"] });

        expect(agentsDetach).toHaveBeenCalledWith({ agentId: retiredId });
        expect(agentsDelete).not.toHaveBeenCalledWith(expect.objectContaining({ agentId: retiredId }));
        expect(readLocalAgentFixtureState(database(retiredId))).toBe(retiredId);
        expect(agentsDelete).toHaveBeenCalledWith({ agentId: evictedId, deleteFiles: false });
      });
    });

    it("removes a retired agent's state folder when the roster no longer has the agent", async () => {
      await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
        process.env.OPENCLAW_STATE_DIR = tempRoot;
        const { database } = await seedAgentStates(tempRoot, agentsDir);
        const { OpenclawWireError } = await import("../lib/gateway-rpc.js");
        const agentsDelete = vi.fn(async ({ agentId }: { agentId: string }) => {
          if (agentId === retiredId) throw new OpenclawWireError("rpc-error", `agent "${agentId}" not found`, { serverCode: "INVALID_REQUEST" });
          return { ok: true as const, agentId, removedBindings: 0 };
        });
        const { buildBrokeredLifecycleAdapter } = await import("../lib/user-lifecycle-broker-adapter.js");
        const adapter = buildBrokeredLifecycleAdapter({
          client: mkClient(provisioningSnapshot),
          rpc: retirementRpc(agentsDelete),
          log: vi.fn(),
          procRoot: await procRootHolding(tempRoot, []),
        });

        await adapter.applyAddUserConfigPatch(provisioningSnapshot, { _coachPersonalToken: "pat-1" });

        expect(agentsDelete).toHaveBeenCalledWith({ agentId: retiredId, deleteFiles: false });
        expect(fsSync.existsSync(path.join(agentsDir, retiredId))).toBe(false);
        expect(readLocalAgentFixtureState(database(coachId))).toBe(coachId);
      });
    });

    it("keeps a retired agent's state folder a process still holds, logs it as failed, and still retires the agent", async () => {
      await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
        process.env.OPENCLAW_STATE_DIR = tempRoot;
        const { database } = await seedAgentStates(tempRoot, agentsDir);
        const agentsDelete = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId, removedBindings: 0 }));
        const log = vi.fn();
        const { buildBrokeredLifecycleAdapter } = await import("../lib/user-lifecycle-broker-adapter.js");
        const adapter = buildBrokeredLifecycleAdapter({
          client: mkClient(provisioningSnapshot),
          rpc: retirementRpc(agentsDelete),
          log,
          procRoot: await procRootHolding(tempRoot, [database(retiredId)]),
        });

        await expect(adapter.applyAddUserConfigPatch(provisioningSnapshot, { _coachPersonalToken: "pat-1" })).resolves.toBeDefined();

        expect(agentsDelete).toHaveBeenCalledWith({ agentId: retiredId, deleteFiles: false });
        expect(readLocalAgentFixtureState(database(retiredId))).toBe(retiredId);
        expect(log).toHaveBeenCalledWith(
          expect.stringMatching(new RegExp(`agentId=${retiredId}.*still held open`)),
          { status: "failed" },
        );
      });
    });
  });

  // Project checkouts clone AFTER the mount patch, so agents.create would
  // otherwise be handed a workspace path that does not exist yet.
  it.each([false, true])("broker prepares the project workspace before agents.create (GitHub=%s)", async github => {
    await withRuntimeMock(async ({ tempRoot }) => {
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const workspaces: string[] = [];
      if (github) defaultAgentGit.restore.mockImplementationOnce(async ({ customerDir }) => {
        const workspace = path.join(customerDir, ".system", "project-coaches", "orbit");
        await fs.mkdir(workspace, { recursive: true });
        await fs.writeFile(path.join(workspace, "AGENTS.md"), "saved agent instructions");
      });
      const channelsStatus = vi.fn(async () => ({ channelAccounts: { mattermost: [] } }));
      const agentsCreate = vi.fn(
        async ({ name, workspace }: { name: string; workspace: string }) => {
          expect(fsSync.existsSync(workspace)).toBe(true);
          workspaces.push(workspace);
          if (github && name.endsWith("-proj-orbit-coach")) {
            expect(await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8")).toBe("saved agent instructions");
          }
          return { ok: true as const, agentId: name, name, workspace };
        },
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient({
          ...brokerSnapshot,
          status: "provisioning",
          projects: github ? [{ projectSlug: "orbit", giteaRepoName: "orbit", checkoutEnabled: false, repoSource: { provider: "github", owner: "alice", repo: "orbit" } }] : [],
          projectAgents: [
            { projectId: "orbit", enabled: true, mmUserId: "mm-orbit", token: "pat-orbit", ...(github ? { githubBacked: true } : {}) },
          ],
        }),
        rpc: {
          channelsStatus,
          configGet: vi.fn(async () => ({ config: { agents: { entries: {} } }, hash: "cfg-hash" })),
          agentsDelete: vi.fn(async ({ agentId }: { agentId: string }) => ({
            ok: true as const,
            agentId,
          })),
          agentsCreate,
          secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
        } as unknown as GatewayRpcClient,
        log: vi.fn(),
      });

      await adapter.applyAddUserConfigPatch({ ...userSnapshot, status: "provisioning" }, { _coachPersonalToken: "pat-1" });

      expect(workspaces).toEqual([
        path.join(tempRoot, "customers", "alice"),
        path.join(tempRoot, "customers", "alice", ...(github ? [".system", "project-coaches"] : ["projects"]), "orbit"),
      ]);
      if (github) {
        expect(defaultAgentGit.ensure).toHaveBeenCalledWith("alice", { kind: "project-coaches" });
        expect(defaultAgentGit.restore.mock.invocationCallOrder.at(-1)).toBeLessThan(agentsCreate.mock.invocationCallOrder.at(-1)!);
        expect(fsSync.existsSync(path.join(tempRoot, "customers", "alice", "projects", "orbit"))).toBe(false);
      }
      expect(agentsCreate.mock.invocationCallOrder.at(-1)).toBeLessThan(
        channelsStatus.mock.invocationCallOrder[0]!,
      );
    });
  });

  it("broker import preparation keeps the agent dir present across a gateway restart", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      const userKey = path.join(tempRoot, "customer-keys", "alice", "id_ed25519");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(path.join(agentDir, "stale.json"), "stale");
      await fs.mkdir(path.dirname(userKey), { recursive: true });
      await fs.writeFile(userKey, "private-key");
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const agentsDelete = vi.fn(async ({ agentId }: { agentId: string }) => {
        expect(fsSync.existsSync(path.join(agentsDir, agentId))).toBe(true);
        return { ok: true as const, agentId, removedBindings: 0 };
      });
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: { agentsDelete } as unknown as GatewayRpcClient,
        log: vi.fn(),
        procRoot: await procRootHolding(tempRoot, []),
      });

      await adapter.prepareImportDir("alice", "pre");

      expect(agentsDelete).toHaveBeenCalledWith(expect.objectContaining({ agentId: "octogee-alice-coach" }));

      expect(fsSync.existsSync(agentDir)).toBe(true);
      expect(fsSync.existsSync(path.join(agentDir, "stale.json"))).toBe(false);
      expect(fsSync.existsSync(userKey)).toBe(true);
    });
  });

  it("broker import preparation preserves state until native deletion cleanup completes", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      const database = path.join(agentDir, "openclaw-agent.sqlite");
      const userFile = path.join(tempRoot, "customers", "alice", "notes.md");
      await fs.mkdir(agentDir, { recursive: true });
      seedLocalAgentDatabase(database, "retained state");
      await fs.mkdir(path.dirname(userFile), { recursive: true });
      await fs.writeFile(userFile, "notes");
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const agentsDelete = vi.fn()
        .mockResolvedValueOnce({ ok: true, purgeFailed: true, failed: [] })
        .mockResolvedValue({ ok: true, failed: [] });
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: { agentsDelete } as unknown as GatewayRpcClient,
        log: vi.fn(),
        procRoot: await procRootHolding(tempRoot, []),
      });

      await expect(adapter.prepareImportDir("alice", "pre")).rejects.toThrow("native cleanup incomplete");
      expect(readLocalAgentFixtureState(database)).toBe("retained state");
      expect(await fs.readFile(userFile, "utf8")).toBe("notes");

      await adapter.prepareImportDir("alice", "pre");
      expect(agentsDelete).toHaveBeenCalledTimes(2);
      expect(fsSync.existsSync(database)).toBe(false);
    });
  });

  it("does not mistake not-found after partial native deletion for closed database files", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const database = path.join(agentsDir, "octogee-alice-coach", "agent", "openclaw-agent.sqlite");
      await fs.mkdir(path.dirname(database), { recursive: true });
      seedLocalAgentDatabase(database, "retained state");
      const procRoot = await procRootHolding(tempRoot, [database]);
      const { OpenclawWireError } = await import("../lib/gateway-rpc.js");
      const agentsDelete = vi.fn()
        .mockResolvedValueOnce({ ok: true, purgeFailed: true, failed: [] })
        .mockRejectedValue(new OpenclawWireError("rpc-error", 'agent "octogee-alice-coach" not found', { serverCode: "INVALID_REQUEST" }));
      const { buildBrokeredLifecycleAdapter } = await import("../lib/user-lifecycle-broker-adapter.js");
      const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(brokerSnapshot), rpc: { agentsDelete } as unknown as GatewayRpcClient, log: vi.fn(), procRoot });
      await expect(adapter.prepareImportDir("alice", "pre")).rejects.toThrow("native cleanup incomplete");
      await expect(adapter.prepareImportDir("alice", "pre")).rejects.toThrow("agent database files are still held open");
      expect(readLocalAgentFixtureState(database)).toBe("retained state");
      expect(agentsDelete).toHaveBeenCalledTimes(2);
    });
  });

  it("broker import preparation refuses to wipe an agent dir a process still holds", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      const database = path.join(agentDir, "openclaw-agent.sqlite");
      const userFile = path.join(tempRoot, "customers", "alice", "notes.md");
      await fs.mkdir(agentDir, { recursive: true });
      seedLocalAgentDatabase(database, "live");
      await fs.mkdir(path.dirname(userFile), { recursive: true });
      await fs.writeFile(userFile, "notes");
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: {
          agentsDelete: vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId, removedBindings: 0 })),
        } as unknown as GatewayRpcClient,
        log: vi.fn(),
        procRoot: await procRootHolding(tempRoot, [`${database}-shm`]),
      });

      await expect(adapter.prepareImportDir("alice", "pre"))
        .rejects.toThrow(`agent database files are still held open: ${database}-shm`);
      expect(fsSync.existsSync(database)).toBe(true);
      expect(fsSync.existsSync(userFile)).toBe(true);
    });
  });

  it("removes a departed user's agent dirs only after OpenClaw released them", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      const customerDir = path.join(tempRoot, "customers", "alice");
      await fs.mkdir(agentDir, { recursive: true });
      seedLocalAgentDatabase(path.join(agentDir, "openclaw-agent.sqlite"), "released");
      await fs.mkdir(customerDir, { recursive: true });
      const residue = await seedDepartedUserResidue(tempRoot);
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const agentsDelete = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId, removedBindings: 0 }));
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: removalRpc(agentsDelete),
        log: vi.fn(),
        procRoot: await procRootHolding(tempRoot, []),
      });

      await expect(adapter.removeImportedUserBySlug("alice")).resolves.toMatchObject({
        wasMounted: true,
        steps: ["config-patch-remove", "delete-dir"],
      });
      expect(agentsDelete).toHaveBeenCalledWith(expect.objectContaining({ agentId: "octogee-alice-coach" }));
      expect(fsSync.existsSync(path.join(agentsDir, "octogee-alice-coach"))).toBe(false);
      expect(fsSync.existsSync(customerDir)).toBe(false);
      expect(residue.departed.filter((entry) => fsSync.existsSync(entry))).toEqual([]);
      expect(residue.kept.filter((entry) => !fsSync.existsSync(entry))).toEqual([]);
    });
  });

  async function buildAdapter() {
    return (await import("../lib/user-lifecycle-broker-adapter.js")).buildBrokeredLifecycleAdapter({
      client: mkClient(brokerSnapshot),
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });
  }

  it(
    "removes a departed user's Git state and token expiry records with its workspace",
    async () => {
      await withRuntimeMock(async ({ tempRoot }) => {
        const customerDir = path.join(tempRoot, "customers", "alice");
        await fs.mkdir(customerDir, { recursive: true });
        const residue = await seedDepartedUserResidue(tempRoot);
        const adapter = await buildAdapter();

        await adapter.deleteDepartedUserState("alice");

        expect(fsSync.existsSync(customerDir)).toBe(false);
        expect(residue.departed.filter((entry) => fsSync.existsSync(entry))).toEqual([]);
        expect(residue.kept.filter((entry) => !fsSync.existsSync(entry))).toEqual([]);
      });
    },
  );

  it(
    "keeps a user's Git state and token expiry records when only a partial workspace is removed before a clone",
    async () => {
      await withRuntimeMock(async ({ tempRoot }) => {
        const customerDir = path.join(tempRoot, "customers", "alice");
        await fs.mkdir(path.join(customerDir, "memory"), { recursive: true });
        await fs.writeFile(path.join(customerDir, "SOUL.md"), "partial");
        const residue = await seedDepartedUserResidue(tempRoot);
        const adapter = await buildAdapter();

        await adapter.removePartialWorkspace("alice");

        expect(fsSync.readdirSync(customerDir)).toEqual([]);
        expect([...residue.departed, ...residue.kept].filter((entry) => !fsSync.existsSync(entry))).toEqual([]);
      });
    },
  );

  it(
    "keeps the project storage under a partial workspace and never tries to remove it",
    async () => {
      await withRuntimeMock(async ({ tempRoot }) => {
        const customerDir = path.join(tempRoot, "customers", "alice");
        const projects = path.join(customerDir, "projects");
        const projectFile = path.join(projects, "site", "index.html");
        await fs.mkdir(path.dirname(projectFile), { recursive: true });
        await fs.writeFile(projectFile, "<h1>work</h1>");
        await fs.mkdir(path.join(customerDir, "memory"), { recursive: true });
        await fs.writeFile(path.join(customerDir, "memory", "today.md"), "partial");
        await fs.writeFile(path.join(customerDir, "SOUL.md"), "partial");
        await fs.chmod(projects, 0o500);
        const adapter = await buildAdapter();

        try {
          await adapter.removePartialWorkspace("alice");
        } finally {
          await fs.chmod(projects, 0o700);
        }

        expect(fsSync.readdirSync(customerDir)).toEqual(["projects"]);
        expect(fsSync.readFileSync(projectFile, "utf8")).toBe("<h1>work</h1>");
      });
    },
  );

  it("refuses to remove any of a departed user's state while a process still holds its agent database", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      const database = path.join(agentDir, "openclaw-agent.sqlite");
      const customerDir = path.join(tempRoot, "customers", "alice");
      await fs.mkdir(agentDir, { recursive: true });
      seedLocalAgentDatabase(database, "still open");
      await fs.mkdir(customerDir, { recursive: true });
      const residue = await seedDepartedUserResidue(tempRoot);
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: removalRpc(vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId, removedBindings: 0 }))),
        log: vi.fn(),
        procRoot: await procRootHolding(tempRoot, [`${database} (deleted)`]),
      });

      await expect(adapter.removeImportedUserBySlug("alice"))
        .rejects.toThrow(`agent database files are still held open: ${database}`);
      expect(fsSync.existsSync(database)).toBe(true);
      expect(fsSync.existsSync(customerDir)).toBe(true);
      expect(residue.departed.filter((entry) => !fsSync.existsSync(entry))).toEqual([]);
    });
  });

  it("removes a departed user's state that OpenClaw holds only through a read-only connection", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      const database = path.join(agentDir, "openclaw-agent.sqlite");
      await fs.mkdir(agentDir, { recursive: true });
      seedLocalAgentDatabase(database, "pooled reader");
      await fs.mkdir(path.join(tempRoot, "customers", "alice"), { recursive: true });
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: removalRpc(vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId, removedBindings: 0 }))),
        log: vi.fn(),
        procRoot: await procRootHoldingWithFlags(tempRoot, [
          { path: database, flags: "02500000" },
          { path: `${database}-wal`, flags: "02500002" },
          { path: `${database}-shm`, flags: "02500002" },
        ]),
      });

      await adapter.removeImportedUserBySlug("alice");

      expect(fsSync.existsSync(path.join(agentsDir, "octogee-alice-coach"))).toBe(false);
    });
  });

  it("refuses to remove a departed user's state while a process reads a non-SQLite file in it", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      const sessionsFile = path.join(agentDir, "sessions.json");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(sessionsFile, "{}");
      await fs.mkdir(path.join(tempRoot, "customers", "alice"), { recursive: true });
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: removalRpc(vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId, removedBindings: 0 }))),
        log: vi.fn(),
        procRoot: await procRootHoldingWithFlags(tempRoot, [{ path: sessionsFile, flags: "02500000" }]),
      });

      await expect(adapter.removeImportedUserBySlug("alice"))
        .rejects.toThrow(`agent database files are still held open: ${sessionsFile}`);
      expect(fsSync.existsSync(sessionsFile)).toBe(true);
    });
  });

  it("refuses to wipe an agent dir for import while OpenClaw still reads its database", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      const database = path.join(agentDir, "openclaw-agent.sqlite");
      await fs.mkdir(agentDir, { recursive: true });
      seedLocalAgentDatabase(database, "pooled reader");
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: {
          agentsDelete: vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId, removedBindings: 0 })),
        } as unknown as GatewayRpcClient,
        log: vi.fn(),
        procRoot: await procRootHoldingWithFlags(tempRoot, [
          { path: database, flags: "02500000" },
          { path: `${database}-shm`, flags: "02500002" },
        ]),
      });

      await expect(adapter.prepareImportDir("alice", "pre"))
        .rejects.toThrow(`agent database files are still held open: ${database}, ${database}-shm`);
      expect(fsSync.existsSync(database)).toBe(true);
    });
  });

  it("refuses to remove a departed user's state while a process holds its database for writing", async () => {
    await withRuntimeMock(async ({ tempRoot, agentsDir }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      const database = path.join(agentDir, "openclaw-agent.sqlite");
      await fs.mkdir(agentDir, { recursive: true });
      seedLocalAgentDatabase(database, "writer");
      await fs.mkdir(path.join(tempRoot, "customers", "alice"), { recursive: true });
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: removalRpc(vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId, removedBindings: 0 }))),
        log: vi.fn(),
        procRoot: await procRootHoldingWithFlags(tempRoot, [
          { path: database, flags: "02500000" },
          { path: database, flags: "02500002" },
          { path: `${database}-wal`, flags: "02500002" },
        ]),
      });

      await expect(adapter.removeImportedUserBySlug("alice"))
        .rejects.toThrow(`agent database files are still held open: ${database}, ${database}-wal`);
      expect(fsSync.existsSync(database)).toBe(true);
    });
  });

  it("carries the configured user agent root, workspace, and session store as one portable plan", async () => {
    await withRuntimeMock(async ({ tempRoot }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      stubUserClaim("alice");
      const customAgentDir = path.join(tempRoot, "agents", "discord-helper", "runtime");
      const workspace = path.join(tempRoot, "workspaces", "discord-helper");
      const sessions = path.join(tempRoot, "agents", "discord-helper", "sessions", "sessions.json");
      await fs.writeFile(path.join(tempRoot, "openclaw.json"), JSON.stringify({
        agents: {
          list: [{
            id: "discord-helper",
            agentDir: customAgentDir,
            workspace,
          }],
        },
        session: { store: path.join(tempRoot, "agents", "{agentId}", "sessions", "sessions.json") },
      }));
      for (const [absolutePath, contents] of [
        [path.join(customAgentDir, "auth.json"), "agent-auth"],
        [path.join(workspace, "NOTES.md"), "workspace"],
        [sessions, JSON.stringify({ sessions: [] })],
        [path.join(tempRoot, "memory", "discord-helper.sqlite"), "sqlite"],
      ]) {
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, contents);
      }
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: {} as GatewayRpcClient,
        log: vi.fn(),
      });

      await expect(adapter.listExportPaths("alice")).resolves.toEqual(expect.arrayContaining([
        { cwd: tempRoot, path: path.join("agents", "discord-helper") },
        { cwd: tempRoot, path: path.join("workspaces", "discord-helper") },
        { cwd: tempRoot, path: path.join("memory", "discord-helper.sqlite") },
      ]));

      await fs.rm(customAgentDir, { recursive: true, force: true });
      await adapter.prepareImportDir("alice", "final");
      expect(fsSync.existsSync(customAgentDir)).toBe(true);
    });
  });

  it(
    "does not export the neutral route agent state from a configured user",
    async () => {
      await withRuntimeMock(async ({ tempRoot }) => {
        process.env.OPENCLAW_STATE_DIR = tempRoot;
        stubUserClaim("alice");
        const fallbackAgentId = "octogee-unmatched-route";
        const userDefaultAgentId = "octogee-alice-coach";
        const projectAgentId = "octogee-alice-proj-orbit-coach";
        await fs.writeFile(path.join(tempRoot, "openclaw.json"), JSON.stringify({
          agents: {
            list: [
              { id: fallbackAgentId },
              {
                id: userDefaultAgentId,
                default: true,
                workspace: path.join(tempRoot, "customers", "alice"),
              },
              {
                id: projectAgentId,
                workspace: path.join(tempRoot, "customers", "alice", "projects", "orbit"),
              },
            ],
          },
        }));
        for (const [relativePath, contents] of [
          [`agents/${fallbackAgentId}/agent/state.json`, "fallback-agent"],
          [`workspace-${fallbackAgentId}/notes.md`, "fallback-workspace"],
          [`memory/${fallbackAgentId}.sqlite`, "fallback-memory"],
          [`agents/${userDefaultAgentId}/agent/state.json`, "coach-agent"],
          [`customers/alice/notes.md`, "coach-workspace"],
          [`memory/${userDefaultAgentId}.sqlite`, "coach-memory"],
          [`agents/${projectAgentId}/agent/state.json`, "project-agent"],
          [`customers/alice/projects/orbit/notes.md`, "project-workspace"],
          [`memory/${projectAgentId}.sqlite`, "project-memory"],
        ]) {
          const absolutePath = path.join(tempRoot, relativePath);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, contents);
        }

        const adapter = (await import("../lib/user-lifecycle-broker-adapter.js")).buildBrokeredLifecycleAdapter({
          client: mkClient(brokerSnapshot),
          rpc: {} as GatewayRpcClient,
          log: vi.fn(),
        });

        const paths = await adapter.listExportPaths("alice");

        expect(paths).toEqual(expect.arrayContaining([
          { cwd: tempRoot, path: `agents/${userDefaultAgentId}` },
          { cwd: tempRoot, path: `agents/${projectAgentId}` },
          { cwd: tempRoot, path: "customers/alice" },
          { cwd: tempRoot, path: `memory/${userDefaultAgentId}.sqlite` },
          { cwd: tempRoot, path: `memory/${projectAgentId}.sqlite` },
        ]));
        expect(paths).not.toEqual(expect.arrayContaining([
          { cwd: tempRoot, path: `agents/${fallbackAgentId}` },
          { cwd: tempRoot, path: `workspace-${fallbackAgentId}` },
          { cwd: tempRoot, path: `memory/${fallbackAgentId}.sqlite` },
        ]));
      });
    },
  );

  it.each([
    ["native VM return", true, ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"]],
    ["User-to-User move", false, ["main", "octogee-alice-coach", "octogee-alice-proj-orbit-coach", "octogee-unmatched-route"]],
  ] as const)(
    "broker adapter fences the scheduler agents a %s hands over",
    async (_handoff, partialHandoff, expectedAgentIds) => {
      await withRuntimeMock(async ({ tempRoot }) => {
        process.env.OPENCLAW_STATE_DIR = tempRoot;
        stubUserClaim("alice");
        const config = {
          agents: {
            list: [
              { id: "octogee-unmatched-route" },
              { id: "main", default: true },
              { id: "octogee-alice-coach", workspace: path.join(tempRoot, "customers", "alice") },
              { id: "octogee-alice-proj-orbit-coach", workspace: path.join(tempRoot, "customers", "alice", "projects", "orbit") },
            ],
          },
          channels: { mattermost: { accounts: { "alice-coach": {}, "alice-proj-orbit": {} } } },
        };
        await fs.writeFile(path.join(tempRoot, "openclaw.json"), JSON.stringify(config));
        const rpc = {
          configGet: vi.fn(async () => ({ config, hash: "cfg-hash" })),
          channelsStop: vi.fn(async () => ({ ok: true as const })),
          sessionsList: vi.fn<GatewayRpcClient["sessionsList"]>(async () => ({ sessions: [] })),
          schedulerMigration: vi.fn(async (request: { operationId: string; phase: string; agentIds?: string[] }) => ({
            operationId: request.operationId, phase: request.phase, agentIds: request.agentIds ?? [], drained: true,
          })),
        } as unknown as GatewayRpcClient;
        const adapter = (await import("../lib/user-lifecycle-broker-adapter.js")).buildBrokeredLifecycleAdapter({
          client: mkClient(brokerSnapshot),
          rpc,
          log: vi.fn(),
        });
        const retain = partialHandoff ? { retainNonportable: true } : {};

        const quiesced = await adapter.quiesceUser("alice", 0, { stopMattermost: true, schedulerMigrationId: "handoff-1", ...retain });
        await adapter.schedulerMigration("alice", { operationId: "handoff-1", phase: "hold", ...retain });

        expect(quiesced).toEqual({ drained: true, runningCount: 0 });
        expect(vi.mocked(rpc.sessionsList).mock.calls.map(([request]) => request.agentId)).toEqual(expectedAgentIds);

        const heldAgentIds = vi.mocked(rpc.schedulerMigration).mock.calls
          .filter(([request]) => request.phase === "hold")
          .map(([request]) => request.agentIds);
        expect(heldAgentIds).toEqual([expectedAgentIds, expectedAgentIds]);
      });
    },
  );

  it(
    "broker adapter quiesces a Shared user that has scheduled jobs without a scheduler handoff",
    async () => {
      await withRuntimeMock(async ({ tempRoot }) => {
        process.env.OPENCLAW_STATE_DIR = tempRoot;
        const config = { channels: { mattermost: { accounts: { "alice-coach": {} } } } };
        await fs.writeFile(path.join(tempRoot, "openclaw.json"), JSON.stringify(config));
        const rpc = {
          configGet: vi.fn(async () => ({ config, hash: "cfg-hash" })),
          channelsStop: vi.fn(async () => ({ ok: true as const })),
          sessionsList: vi.fn<GatewayRpcClient["sessionsList"]>(async () => ({ sessions: [] })),
          cronJobCount: vi.fn(async () => 3),
          schedulerMigration: vi.fn(),
        } as unknown as GatewayRpcClient;
        const adapter = (await import("../lib/user-lifecycle-broker-adapter.js")).buildBrokeredLifecycleAdapter({
          client: mkClient(brokerSnapshot),
          rpc,
          log: vi.fn(),
        });

        await expect(adapter.quiesceUser("alice", 0)).resolves.toEqual({ drained: true, runningCount: 0 });
        expect(rpc.channelsStop).toHaveBeenCalledWith({ channel: "mattermost", accountId: "alice-coach" });
        expect(rpc.schedulerMigration).not.toHaveBeenCalled();
      });
    },
  );

  it.each(["stopped", "held", "running", "stopping", "other-pod", "unknown"])("retains a configured user overlay with proven chat shutdown (%s)", async (state) => {
    await withRuntimeMock(async ({ tempRoot, agentsDir, applyConfigPatch }) => {
      process.env.OPENCLAW_STATE_DIR = tempRoot;
      stubUserClaim("alice");
      vi.stubEnv("POD_UID", "pod-current");
      supervisorStatus.mockImplementation(async () => {
        if (state === "unknown") throw new Error("supervisor unreachable");
        return { podUid: state === "other-pod" ? "other" : "pod-current",
          mode: state === "running" ? "permitted" : "held",
          phase: state === "stopping" ? "stopping" : state === "running" ? "running" : "held" };
      });
      const customerDir = path.join(tempRoot, "customers", "alice");
      const userKey = path.join(tempRoot, "customer-keys", "alice", "id_ed25519");
      const agentDir = path.join(agentsDir, "octogee-alice-coach", "agent");
      await fs.mkdir(customerDir, { recursive: true });
      await fs.mkdir(agentDir, { recursive: true });
      seedLocalAgentDatabase(path.join(agentDir, 'openclaw-agent.sqlite'), 'retained');
      await fs.mkdir(path.dirname(userKey), { recursive: true });
      await fs.mkdir(path.join(customerDir, ".system"), { recursive: true });
      await fs.writeFile(userKey, "private-key");
      await fs.writeFile(path.join(customerDir, ".system", ".mounted"), "");
      await fs.writeFile(path.join(customerDir, ".system", ".migrating-in"), "");
      await fs.writeFile(path.join(tempRoot, "openclaw.json"), JSON.stringify({
        agents: { list: [{ id: "octogee-unmatched-route" }, { id: "octogee-alice-coach" }] },
        database: { engine: "sqlite", families: { agent: { engine: "postgres" } } },
      }));
      const residue = await seedDepartedUserResidue(tempRoot);
      const { buildBrokeredLifecycleAdapter } = await import(
        "../lib/user-lifecycle-broker-adapter.js"
      );
      const agentsDelete = vi.fn(async ({ agentId }: { agentId: string }) => ({
        ok: true as const,
        agentId,
        removedBindings: 0,
      }));
      const agentsDetach = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId }));
      const channelsStop = vi.fn(async () => {
        if (state !== "stopped") throw new Error("channel stop unavailable");
        return { ok: true as const };
      });
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(brokerSnapshot),
        rpc: {
          configGet: vi.fn(async () => ({
            config: { agents: { entries: { "octogee-alice-coach": { model: "house" } } } },
            hash: "cfg-hash",
          })),
          agentsDelete,
          agentsDetach,
          channelsStatus: vi.fn(async () => ({
            channelAccounts: {
              mattermost: [{ accountId: "alice-coach", running: true }],
            },
          })),
          channelsStop,
        } as unknown as GatewayRpcClient,
        log: vi.fn(),
      });

      if (!["stopped", "held"].includes(state)) {
        await expect(adapter.removeImportedUserBySlug("alice")).rejects.toThrow("Stale Mattermost account stop failed");
        expect(fsSync.existsSync(path.join(customerDir, ".system", ".mounted"))).toBe(true);
        expect(fsSync.existsSync(path.join(customerDir, ".system", ".migrating-in"))).toBe(true);
        return;
      }
      await expect(adapter.removeImportedUserBySlug("alice")).resolves.toMatchObject({
        wasMounted: true,
        retained: true,
      });

      expect(agentsDelete).not.toHaveBeenCalled();
      expect(agentsDetach).toHaveBeenCalledExactlyOnceWith({ agentId: "octogee-alice-coach" });
      expect(channelsStop).toHaveBeenCalledWith({ channel: "mattermost", accountId: "alice-coach" });
      expect(applyConfigPatch).not.toHaveBeenCalled();
      expect(fsSync.existsSync(customerDir)).toBe(true);
      expect(fsSync.existsSync(userKey)).toBe(true);
      expect(fsSync.existsSync(agentDir)).toBe(true);
      expect(readLocalAgentFixtureState(path.join(agentDir, 'openclaw-agent.sqlite'))).toBe('retained');
      expect(residue.departed.filter((entry) => !fsSync.existsSync(entry))).toEqual([]);
      expect(fsSync.existsSync(path.join(customerDir, ".system", ".mounted"))).toBe(false);
      expect(fsSync.existsSync(path.join(customerDir, ".system", ".migrating-in"))).toBe(false);
    });
  });
});
