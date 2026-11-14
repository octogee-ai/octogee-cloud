import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetBrokerClient } from "../lib/fleet-broker-client.js";
import {
  buildBrokeredLifecycleAdapter,
  projectCheckoutScopeForRuntime,
  waitForAppliedConfigRevision,
} from "../lib/user-lifecycle-broker-adapter.js";
import { landAgentAnchors, readLocalAgentAnchors } from "../lib/agent-anchor-record.js";
import { OPENCLAW_CONFIG } from "../lib/config.js";
import { OpenclawWireError, type GatewayRpcClient } from "../lib/gateway-rpc.js";
import {
  applyConfigPatch,
  userConfigFullAgentListReplacePaths,
  userConfigReplacePaths,
} from "../lib/apply-config-patch.js";
import {
  SAFE_DEFAULT_AGENT_ID,
  platformOpenAiEmbeddingMemorySearch,
  platformOpenAiEmbeddingSecretId,
} from "../lib/openclaw-config-users.js";
import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";
import { snapshotConfigFingerprint } from "../lib/snapshot-fingerprint.js";
import {
  applyConfigPatch as realApplyConfigPatch,
  mergePatchValueAlreadyApplied,
} from "@octogee/core/apply-config-patch";
import { applyAgentModelOverrides, userOauthRuntimeConfigPatch, platformModelAllowlistPatch } from "@octogee/core/byot-sync-runtime";
import { canonicalUserModelDefinition } from "../../shared/types/agent-models.js";
import { DEFAULT_USER_AGENT_MODEL_REF } from "../../shared/types/platform-config.js";
import { _resetBrokerProfileLogStateForTests, createReconcileConvergenceHooks, finalizeConvergedMount, materializeDeferredBrokerProfiles } from "../lib/fleet-provisioner.js";
import { saveAppliedFingerprints } from "../lib/applied-fingerprint-store.js";
import { openClawRuntimeUpdateGuard } from "../lib/openclaw-runtime-update-guard.js";
import { clearUserClaim, stubUserClaim, withUserClaim } from "./helpers/user-claim.js";
import { houseOnlyUserEntitlements, installUserEntitlementsForTest } from "./helpers/user-entitlements.js";
import { mattermostAccountSecretRef } from "../lib/mattermost-account-secrets.js";
import { recordIsolatedNativeInitialState } from "../lib/isolated-native-initial-state.js";
import { activationManifestTarPath, captureTargetWorkspaceIdentities, restoreTargetWorkspaceIdentities, captureSourceWorkspaceIdentities, writeActivationManifest, readActivationManifest as realReadActivationManifest } from "@octogee/core/migration-activation-manifest";
import { createRestoreHandler } from "../lib/fleet-http-migration.js";
import { gatewayScopedJobId, signFleetRequest } from "../lib/fleet-signature.js";
import { FLEET_KEY_PAIR } from "./fixtures/fleet-keys.js";
import type { Request, Response } from "express";
import { disableSystemConfigWatch, isSystemConfigWatchDisabled } from "../lib/system-config-watch-state.js";

describe("migration manifest export runtime wait", () => {
  afterEach(() => vi.useRealTimers());

  it("waits for the current source fingerprint without holding the runtime update guard", async () => {
    vi.useFakeTimers();
    const snapshot = aliceSnapshot();
    const fingerprintPath = path.join(testRuntime.dir, "applied-fingerprints.json");
    saveAppliedFingerprints(fingerprintPath, new Map([["alice", "old-config"]]));
    const manifest = { slug: "alice", appliedFingerprint: snapshotConfigFingerprint(snapshot) };
    secretMocks.exportActivationManifestWithSecret.mockClear();
    secretMocks.exportActivationManifestWithSecret.mockResolvedValueOnce(manifest);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ uidForSlug: vi.fn(async () => snapshot.uid) }), rpc: mkGatewayRpc(), log: vi.fn() });
    const controller = new AbortController();
    const exported = adapter.exportOpenClawActivationManifest!("alice", { convergeSource: true, timeoutMs: 10_000, signal: controller.signal });
    try {
      await vi.advanceTimersByTimeAsync(500);
      expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
      await expect(openClawRuntimeUpdateGuard.tryRun(async () => "available")).resolves.toBe("available");
      saveAppliedFingerprints(fingerprintPath, new Map([["alice", snapshotConfigFingerprint(snapshot)]]));
      await vi.advanceTimersByTimeAsync(500);
      await expect(exported).resolves.toEqual(manifest);
    } finally {
      controller.abort();
      await exported.catch(() => undefined);
      await fs.rm(fingerprintPath, { force: true });
    }
  });

  it.each(["deadline", "disconnect", "fenced"])("refuses unconverged source export on %s", async mode => {
    const fingerprintPath = path.join(testRuntime.dir, "applied-fingerprints.json");
    saveAppliedFingerprints(fingerprintPath, new Map());
    secretMocks.exportActivationManifestWithSecret.mockClear();
    const log = vi.fn();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({
      uidForSlug: vi.fn(async () => "uid-alice"),
      userSnapshot: vi.fn(async () => aliceSnapshot({ runtimeMutationFenced: mode === "fenced" })),
    }), rpc: mkGatewayRpc(), log });
    const controller = new AbortController();
    const exported = adapter.exportOpenClawActivationManifest!("alice", {
      convergeSource: true, timeoutMs: mode === "deadline" ? 20 : 10_000, signal: controller.signal,
    }).catch((error: unknown) => error);
    try {
      if (mode === "disconnect") {
        await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("waiting for source runtime")));
        controller.abort(new Error("export caller disconnected"));
      }
      await expect(exported).resolves.toMatchObject({ message: mode === "deadline"
        ? "Timed out waiting for source runtime configuration to converge for alice"
        : mode === "fenced" ? "Source runtime convergence requires unfenced serving custody for alice"
        : "The operation was aborted" });
      expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
      await expect(openClawRuntimeUpdateGuard.tryRun(async () => "available")).resolves.toBe("available");
    } finally {
      controller.abort();
      await exported;
      await fs.rm(fingerprintPath, { force: true });
    }
  });

  it("waits for a 115-second competing publication before exporting its manifest", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const custody = new Promise<void>((resolve) => { release = resolve; });
    const publishing = openClawRuntimeUpdateGuard.run(async () => undefined, { slug: "alice", holdUntil: custody });
    await publishing;
    const manifest = { slug: "alice", appliedFingerprint: "stable-after-publication" };
    secretMocks.exportActivationManifestWithSecret.mockClear();
    secretMocks.exportActivationManifestWithSecret.mockResolvedValueOnce(manifest);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: mkGatewayRpc(), log: vi.fn() });
    const exported = adapter.exportOpenClawActivationManifest!("alice", { timeoutMs: 330_000 }).then((value) => value, (error) => error);
    try {
      await vi.advanceTimersByTimeAsync(115_000);
      expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
    } finally { release(); }
    await expect(exported).resolves.toEqual(manifest);
    expect(secretMocks.exportActivationManifestWithSecret).toHaveBeenCalledOnce();
  });

  it.each(["deadline", "disconnect"])("cancels a queued export on %s without releasing publication custody", async (reason) => {
    vi.useFakeTimers();
    let release!: () => void;
    const custody = new Promise<void>((resolve) => { release = resolve; });
    await openClawRuntimeUpdateGuard.run(async () => undefined, { slug: "alice", holdUntil: custody });
    secretMocks.exportActivationManifestWithSecret.mockClear();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: mkGatewayRpc(), log: vi.fn() });
    const controller = new AbortController();
    const exported = adapter.exportOpenClawActivationManifest!("alice", { timeoutMs: 50, signal: controller.signal }).then((value) => value, (error) => error);
    try {
      if (reason === "disconnect") controller.abort(new Error("export caller disconnected"));
      else await vi.advanceTimersByTimeAsync(50);
      await expect(exported).resolves.toMatchObject({ message: reason === "disconnect" ? "export caller disconnected" : "Timed out waiting for an OpenClaw runtime update" });
      expect(openClawRuntimeUpdateGuard.tryRun(async () => undefined)).toBeUndefined();
      expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
    } finally { release(); }
    await Promise.resolve(); await Promise.resolve();
    expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
  });

  it("exports one user's manifest while another user's publication settles", async () => {
    let release!: () => void;
    const custody = new Promise<void>((resolve) => { release = resolve; });
    await openClawRuntimeUpdateGuard.run(async () => undefined, { slug: "bob", holdUntil: custody });
    const manifest = { slug: "alice", appliedFingerprint: "alice-stable" };
    secretMocks.exportActivationManifestWithSecret.mockClear();
    secretMocks.exportActivationManifestWithSecret.mockResolvedValueOnce(manifest);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: mkGatewayRpc(), log: vi.fn() });
    try {
      await expect(adapter.exportOpenClawActivationManifest!("alice", { timeoutMs: 1_000 })).resolves.toEqual(manifest);
    } finally { release(); }
  });

  it("turns a user's channels on without waiting for its own publication tail", async () => {
    let release!: () => void;
    const custody = new Promise<void>((resolve) => { release = resolve; });
    await openClawRuntimeUpdateGuard.run(async () => undefined, { slug: "carol", holdUntil: custody });
    mocks.readActivationManifest.mockRejectedValueOnce(Object.assign(new Error("no manifest"), { code: "ENOENT" }));
    const rpc = mkGatewayRpc();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const resumed = adapter.resumeUser("carol");
    try {
      await vi.waitFor(() => expect(rpc.configGet).toHaveBeenCalled());
      await expect(resumed).resolves.toBeUndefined();
    } finally {
      release();
      await resumed.catch(() => undefined);
    }
  });

  it.each<{ entry: string; evict: (adapter: ReturnType<typeof buildBrokeredLifecycleAdapter>) => Promise<unknown> }>([
    { entry: "add", evict: (adapter) => adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "default-agent-pat" }, {
      evictionBatch: ["bob"],
      runtimePublication: { settled: Promise.resolve(), invalidateFingerprint: () => { throw new Error("alice add admitted"); } },
    }) },
    { entry: "remove", evict: (adapter) => adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach", ["alice", "bob"]) },
    { entry: "imported removal", evict: (adapter) => adapter.removeImportedUserBySlug!("alice", ["alice", "bob"]) },
  ])("waits for an evicted user's publication before the $entry patch mutates it", async ({ evict }) => {
    let release!: () => void;
    const custody = new Promise<void>((resolve) => { release = resolve; });
    await openClawRuntimeUpdateGuard.run(async () => undefined, { slug: "bob", holdUntil: custody });
    const rpc = mkGatewayRpc({ configGet: vi.fn(async () => { throw new Error("alice removal admitted"); }) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    let settled = false;
    const evicting = evict(adapter).catch(() => undefined).finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
    } finally { release(); }
    await evicting;
  });
});

const testRuntime = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const originalDir = process.env.OPENCLAW_DIR;
  const originalAgentsDir = process.env.OPENCLAW_AGENTS_DIR;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "octogee-broker-test-")));
  process.env.OPENCLAW_DIR = dir;
  process.env.OPENCLAW_AGENTS_DIR = join(dir, "agents");
  process.env.OPENCLAW_STATE_DIR = dir;
  return { dir, originalDir, originalAgentsDir, originalStateDir };
});

afterAll(async () => {
  if (testRuntime.originalDir === undefined) delete process.env.OPENCLAW_DIR;
  else process.env.OPENCLAW_DIR = testRuntime.originalDir;
  if (testRuntime.originalAgentsDir === undefined) delete process.env.OPENCLAW_AGENTS_DIR;
  else process.env.OPENCLAW_AGENTS_DIR = testRuntime.originalAgentsDir;
  if (testRuntime.originalStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
  else process.env.OPENCLAW_STATE_DIR = testRuntime.originalStateDir;
  await fs.rm(testRuntime.dir, { recursive: true, force: true });
});

const ALICE_OWNER_MM_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const FRESH_OWNER_MM_ID = "ffffffffffffffffffffffffff";
const FIRST_OWNER_MM_ID = "iiiiiiiiiiiiiiiiiiiiiiiiii";
const TESTER_OWNER_MM_ID = "tttttttttttttttttttttttttt";

const mocks = vi.hoisted(() => ({
  readActivationManifest: vi.fn(),
  applyOpenClawActivationManifest: vi.fn(),
  removeActivationManifest: vi.fn(),
}));
const offlineDetachMocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../lib/openclaw-cli.js', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/openclaw-cli.js')>(),
  runOpenClaw: offlineDetachMocks.run,
}));
const supervisorMocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('../lib/surge-openclaw-process-gate.js', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/surge-openclaw-process-gate.js')>(),
  createSurgeOpenClawProcessSupervisorClient: () => ({ status: supervisorMocks.status }),
}));
const restoreDefaultAgentWorkspaces = vi.hoisted(() => vi.fn());
vi.mock("@octogee/core/project-agent-workspaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octogee/core/project-agent-workspaces")>();
  return { ...actual, restoreProjectAgentWorkspaces: restoreDefaultAgentWorkspaces };
});
vi.mock("../lib/gitea-admin-broker-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/gitea-admin-broker-client.js")>();
  return { ...actual, brokeredGitHost: { ...actual.brokeredGitHost, ensureRepo: vi.fn(async () => undefined) } };
});

const gitMocks = vi.hoisted(() => ({
  cloneProjectRepo: vi.fn(),
  userRepositoryHasCanonicalRemote: vi.fn(),
  projectCheckoutMatchesSource: vi.fn(),
  setRepoSshCommand: vi.fn(),
}));
const patchMocks = vi.hoisted(() => ({
  applyConfigPatch: vi.fn(async () => ({ mode: "rpc" as const, attempts: 1 })),
}));
const anchorQuery = vi.hoisted(() => vi.fn());
vi.mock("@octogee/core/agent-postgres", async (importOriginal) => ({
  ...await importOriginal<typeof import("@octogee/core/agent-postgres")>(),
  queryAgentStore: anchorQuery,
}));
const modelCredentialMocks = vi.hoisted(() => ({
  syncModelCredentialsForUser: vi.fn(async () => undefined),
  restoreModelCredentialOauthStoreForSlug: vi.fn(async () => ({ restored: true, present: true, providers: ["openai"] })),
}));
const brokerCatalogMocks = vi.hoisted(() => ({
  materializeBrokerProfilesForAgents: vi.fn(() => ({ materialized: 1, deferred: [] })),
}));
const contextFileConvergenceMocks = vi.hoisted(() => ({
  reassertConvergedContextFilesForSlug: vi.fn(() => []),
}));
const secretMocks = vi.hoisted(() => ({
  exportActivationManifestWithSecret: vi.fn(),
  updateMattermostAccountSecrets: vi.fn(async () => ({ changed: true })),
  materializeActivationManifestSecret: vi.fn(async (_dir: string, manifest: unknown) => ({
    manifest,
    secretsChanged: true,
  })),
}));
const routingActivationMocks = vi.hoisted(() => ({
  pending: false,
  capture: vi.fn(async (_rpc: unknown, accountIds: readonly string[]) =>
    Object.fromEntries(accountIds.map((accountId) => [accountId, 0]))),
  activate: vi.fn(async () => undefined),
  mark: vi.fn(() => {
    routingActivationMocks.pending = true;
    return "activation-token";
  }),
  discardForUsers: vi.fn(),
  stopStale: vi.fn(async () => undefined),
  activateAfterPatch: vi.fn(async (rpc, openclawDir, log, params) => {
    if (params.configNoop) {
      await routingActivationMocks.stopStale(rpc, {
        currentSlug: params.currentSlug,
        desiredAccountIds: params.accountIds,
        evictionSlugs: params.evictionSlugs,
      }, log);
    }
    if (params.required || routingActivationMocks.pending) {
      await routingActivationMocks.activate(rpc, openclawDir, log, {
        restartAccountIds: params.restartAccountIds ?? [],
        restartConfiguredPending: true,
      });
    }
  }),
}));

vi.mock("../lib/migration-activation-manifest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/migration-activation-manifest.js")>();
  return {
    ...actual,
    readActivationManifest: mocks.readActivationManifest,
    applyOpenClawActivationManifest: mocks.applyOpenClawActivationManifest,
    removeActivationManifest: mocks.removeActivationManifest,
  };
});
vi.mock("../lib/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/git.js")>();
  return {
    ...actual,
    cloneProjectRepo: gitMocks.cloneProjectRepo,
    userRepositoryHasCanonicalRemote: gitMocks.userRepositoryHasCanonicalRemote,
    projectCheckoutMatchesSource: gitMocks.projectCheckoutMatchesSource,
    setRepoSshCommand: gitMocks.setRepoSshCommand,
  };
});
vi.mock("../lib/apply-config-patch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/apply-config-patch.js")>();
  return {
    ...actual,
    applyConfigPatch: patchMocks.applyConfigPatch,
  };
});
vi.mock("../lib/model-credential-sync-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/model-credential-sync-runtime.js")>();
  return {
    ...actual,
    syncModelCredentialsForUser: modelCredentialMocks.syncModelCredentialsForUser,
    restoreModelCredentialOauthStoreForSlug: modelCredentialMocks.restoreModelCredentialOauthStoreForSlug,
  };
});
vi.mock("../lib/agent-model-token-materializer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/agent-model-token-materializer.js")>();
  return {
    ...actual,
    materializeBrokerProfilesForAgents: brokerCatalogMocks.materializeBrokerProfilesForAgents,
  };
});
vi.mock("../lib/context-file-convergence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/context-file-convergence.js")>();
  return {
    ...actual,
    reassertConvergedContextFilesForSlug: contextFileConvergenceMocks.reassertConvergedContextFilesForSlug,
  };
});
vi.mock("../lib/mattermost-account-secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mattermost-account-secrets.js")>();
  return { ...actual, updateMattermostAccountSecrets: secretMocks.updateMattermostAccountSecrets };
});
vi.mock("../lib/migration-activation-secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/migration-activation-secrets.js")>();
  secretMocks.exportActivationManifestWithSecret.mockImplementation(actual.exportActivationManifestWithSecret);
  return {
    ...actual,
    exportActivationManifestWithSecret: secretMocks.exportActivationManifestWithSecret,
    materializeActivationManifestSecret: secretMocks.materializeActivationManifestSecret,
  };
});
vi.mock("../lib/mattermost-routing-activation.js", () => ({
  activateMattermostRoutingAfterConfigPatch: routingActivationMocks.activateAfterPatch,
  captureMattermostRoutingActivationBaseline: routingActivationMocks.capture,
  activatePendingMattermostRouting: routingActivationMocks.activate,
  markMattermostRoutingActivationPending: routingActivationMocks.mark,
  discardMattermostRoutingActivationForUsers: routingActivationMocks.discardForUsers,
  mattermostRoutingActivationPending: () => routingActivationMocks.pending,
  stopStaleMattermostRoutingAccounts: routingActivationMocks.stopStale,
}));

function mkClient(overrides: Partial<FleetBrokerClient> = {}): FleetBrokerClient {
  return {
    assignedUsers: vi.fn(async () => []),
    assignmentRoster: vi.fn(async () => [{ uid: "uid-alice", state: "serving", epoch: 0 }]),
    uidForSlug: vi.fn(async () => "uid-tester10"),
    githubTokenForSync: vi.fn(async () => null),
    userSnapshot: vi.fn(async () => aliceSnapshot()),
    reconcileProjectAgentMembership: vi.fn(async () => undefined),
    setProvisioningStatus: vi.fn(async () => undefined),
    setRepoUrl: vi.fn(async () => undefined),
    provisionMattermost: vi.fn(async () => ({})),
    setMattermostFields: vi.fn(async () => undefined),
    ensureAgentIds: vi.fn(async () => undefined),
    setMounted: vi.fn(async () => undefined),
    reportProjectAgentReadiness: vi.fn(async () => undefined),
    recordReconcileError: vi.fn(async () => undefined),
    clearReconcileError: vi.fn(async () => undefined),
    reportProvisioned: vi.fn(async () => undefined),
    recordUsageEvent: vi.fn(async () => undefined),
    blobDownloadUrl: vi.fn(async () => ({
      url: "https://example.com/download",
      method: "GET",
      gcsPath: "customers/tester10/file",
      expiresAt: new Date(0).toISOString(),
    })),
    blobUploadUrl: vi.fn(async () => ({
      url: "https://example.com/upload",
      method: "PUT",
      gcsPath: "customers/tester10/file",
      expiresAt: new Date(0).toISOString(),
    })),
    ...overrides,
  };
}

function mkGatewayRpc(overrides: Partial<GatewayRpcClient> = {}): GatewayRpcClient {
  return {
    gatewayRestartRequest: vi.fn(async () => ({ status: "requested" })),
    isGatewayUp: vi.fn(async () => true),
    cronJobCount: vi.fn(async () => 0),
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
    sessionsList: vi.fn(async () => ({ sessions: [] })),
    sessionsAbort: vi.fn(async () => ({ ok: true as const, abortedRunId: "run-1", status: "aborted" as const })),
    schedulerMigration: vi.fn(async (request: { operationId: string; phase: string; agentIds?: string[] }) => ({
      operationId: request.operationId, phase: request.phase, agentIds: request.agentIds ?? [], drained: true,
    })),
    ...rosterRpc(),
    ...overrides,
  } as GatewayRpcClient;
}

function configSnapshot(config: unknown) {
  return {
    config,
    hash: "cfg-hash",
    configRevisionHash: "revision-hash",
    appliedConfigHash: "revision-hash",
  };
}

// The add path reads the live roster to decide which agents leave by
// `agents.delete` and which arrive by `agents.create`, so every add fixture
// needs all three calls.
function rosterRpc(config: unknown = { agents: { entries: {} } }) {
  return {
    configGet: vi.fn(async () => configSnapshot(config)),
    secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    cronJobCount: vi.fn(async () => 0),
    agentsDelete: vi.fn(async ({ agentId }: { agentId: string }) => ({
      ok: true as const,
      agentId,
      removedBindings: 0,
    })),
    agentsCreate: vi.fn(async ({ name, workspace }: { name: string; workspace: string }) => ({
      ok: true as const,
      agentId: name,
      name,
      workspace,
    })),
  };
}

// The roster is now removed one `agents.delete` at a time, so every eviction
// path reads the live roster and then calls the gateway per departing agent.
function mkRemovalRpc(
  config: unknown,
  overrides: Partial<GatewayRpcClient> = {},
): GatewayRpcClient {
  return {
    ...rosterRpc(config),
    ...overrides,
  } as unknown as GatewayRpcClient;
}

function keyedRoster(agentIds: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(agentIds.map((agentId) => [agentId, { model: "house" }]));
}

function mergePatch(base: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = {
    ...(base && typeof base === "object" && !Array.isArray(base) ? base as Record<string, unknown> : {}),
  };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

function aliceSnapshot(
  overrides: Partial<FleetBrokerUserSnapshot> = {},
): FleetBrokerUserSnapshot {
  return {
    uid: "uid-alice",
    slug: "alice",
    contextTemplateKey: "default",
    planInputs: { tier: "standard" },
    persona: null,
    gatewayId: "default",
    status: "",
    runtimeMutationFenced: false,
    agentIds: [],
    repoUrl: "",
    mattermostUserId: ALICE_OWNER_MM_ID,
    customerMmUserId: ALICE_OWNER_MM_ID,
    channels: [],
    projects: [],
    ownerName: "Alice",
    coachToken: "pat-1",
    defaultAgentMmUserId: "mm-alice-coach",
    ...overrides,
  };
}

function configuredUserClient(): FleetBrokerClient {
  return mkClient({
    userSnapshot: vi.fn(async () => aliceSnapshot({ uid: "uid-tester10", slug: "tester10" })),
  });
}

describe("Isolated target runtime enablement", () => {
  it.each([
    { assigned: true, talkAgentId: "octogee-alice-coach" },
    { assigned: true, talkAgentId: undefined },
    { assigned: false, talkAgentId: "octogee-alice-coach" },
  ])("enables the imported runtime only after its serving assignment commits (assigned=$assigned, talk=$talkAgentId)", async ({ assigned, talkAgentId }) => {
    const previousGatewayId = process.env.GATEWAY_ID;
    const previousGatewayClass = process.env.GATEWAY_CLASS;
    const previousApiOrigin = process.env.API_PUBLIC_URL;
    process.env.GATEWAY_ID = "alice-user";
    process.env.GATEWAY_CLASS = "isolated";
    process.env.API_PUBLIC_URL = "https://api.example.invalid";
    withUserClaim({ OPENCLAW_DIR: testRuntime.dir, GATEWAY_ID: "alice-user" }, "alice");
    const repo = path.join(testRuntime.dir, "system_config");
    const desired = { cron: { enabled: true, maxConcurrentRuns: 3 }, talk: { agentId: talkAgentId, realtime: { provider: "openai" } }, channels: {
      mattermost: { enabled: true, accounts: { "alice-coach": {} } },
      slack: { enabled: true, accounts: { primary: {}, paused: { enabled: false } } },
    } };
    const dormant = { agents: { entries: keyedRoster([SAFE_DEFAULT_AGENT_ID, "octogee-alice-coach"]) },
      cron: { enabled: false, maxConcurrentRuns: 7 }, talk: { agentId: SAFE_DEFAULT_AGENT_ID, voiceId: "live-voice" },
      channels: {
        mattermost: { enabled: false, accounts: { "alice-coach": { enabled: false, botToken: "live-token" } } },
        slack: { enabled: false, accounts: { primary: { enabled: false, appToken: "live-token" }, paused: { enabled: false } } },
      },
    };
    let current = structuredClone(dormant);
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, "openclaw.json"), JSON.stringify(desired));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["add", "openclaw.json"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: repo });
    await disableSystemConfigWatch(testRuntime.dir, "alice", { runtimeProjection: true });
    patchMocks.applyConfigPatch.mockClear();
    patchMocks.applyConfigPatch.mockImplementationOnce(realApplyConfigPatch);
    mocks.removeActivationManifest.mockReset().mockResolvedValue(undefined);
    const rpc = mkGatewayRpc({ configGet: vi.fn(async () => configSnapshot(current)),
      configPatch: vi.fn(async patch => { current = mergePatch(current, patch) as typeof current; return { ok: true }; }),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({
      uidForSlug: vi.fn(async () => "uid-alice"),
      userSnapshot: vi.fn(async () => aliceSnapshot({ gatewayId: assigned ? "alice-user" : "shared-blue" })),
      assignmentRoster: vi.fn(async () => assigned ? [{ uid: "uid-alice", state: "serving", epoch: 4 }] : []),
    }), rpc, log: vi.fn(), isIsolatedGateway: () => true });
    try {
      const resumed = adapter.resumeUser("alice", { migrationId: "migration", role: "target" });
      if (assigned) {
        await resumed;
        const patch = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0];
        expect(patch.buildPatch({})).toMatchObject({ cron: { enabled: true }, channels: { mattermost: { enabled: true } } });
        expect(current.agents).toEqual(dormant.agents);
        expect(current.cron).toEqual({ enabled: true, maxConcurrentRuns: 7 });
        expect(current.talk).toEqual({ ...(talkAgentId ? { agentId: talkAgentId } : {}), voiceId: "live-voice" });
        expect(current.channels).toEqual({
          mattermost: { enabled: true, accounts: { "alice-coach": { enabled: true, botToken: "live-token" } } },
          slack: { enabled: true, accounts: { primary: { enabled: true, appToken: "live-token" }, paused: { enabled: false } } },
        });
        expect(rpc.channelsStart).toHaveBeenCalledWith({ channel: "mattermost", accountId: "alice-coach" });
        expect(isSystemConfigWatchDisabled(testRuntime.dir, "alice")).toBe(false);
        expect(mocks.removeActivationManifest).toHaveBeenCalledWith(testRuntime.dir, "alice");
      } else {
        await expect(resumed).rejects.toThrow("requires its current serving assignment");
        expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
        expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
        expect(rpc.channelsStart).not.toHaveBeenCalled();
        expect(current).toEqual(dormant);
        expect(isSystemConfigWatchDisabled(testRuntime.dir, "alice")).toBe(true);
      }
    } finally {
      patchMocks.applyConfigPatch.mockReset().mockResolvedValue({ mode: "rpc", attempts: 1 });
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(path.join(testRuntime.dir, "system_config.watch.disabled"), { force: true });
      clearUserClaim();
      if (previousGatewayId === undefined) delete process.env.GATEWAY_ID;
      else process.env.GATEWAY_ID = previousGatewayId;
      if (previousGatewayClass === undefined) delete process.env.GATEWAY_CLASS;
      else process.env.GATEWAY_CLASS = previousGatewayClass;
      if (previousApiOrigin === undefined) delete process.env.API_PUBLIC_URL;
      else process.env.API_PUBLIC_URL = previousApiOrigin;
    }
  });
});

describe("buildBrokeredLifecycleAdapter migration import activation", () => {
  const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalLogLevel = process.env.LOG_LEVEL;
  let tempStateDir: string | null = null;

  beforeEach(() => {
    process.env.LOG_LEVEL = "info";
    mocks.readActivationManifest.mockReset();
    mocks.applyOpenClawActivationManifest.mockReset();
    mocks.removeActivationManifest.mockReset();
    gitMocks.cloneProjectRepo.mockReset().mockResolvedValue(true);
    gitMocks.userRepositoryHasCanonicalRemote.mockReset().mockReturnValue(true);
    gitMocks.projectCheckoutMatchesSource.mockReset().mockReturnValue(true);
    gitMocks.setRepoSshCommand.mockClear();
    patchMocks.applyConfigPatch.mockClear();
    secretMocks.updateMattermostAccountSecrets.mockClear();
    secretMocks.materializeActivationManifestSecret.mockClear();
    routingActivationMocks.pending = false;
    routingActivationMocks.capture.mockClear();
    routingActivationMocks.activate.mockReset().mockImplementation(async () => undefined);
    routingActivationMocks.mark.mockClear();
    routingActivationMocks.discardForUsers.mockClear();
    routingActivationMocks.stopStale.mockClear();
    routingActivationMocks.activateAfterPatch.mockClear();
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
    tempStateDir = null;
    mocks.readActivationManifest.mockResolvedValue({
      slug: "tester10",
      appliedFingerprint: "fp-tester10",
      agentId: "octogee-tester10-coach",
      agent: { id: "octogee-tester10-coach", workspace: path.join(testRuntime.dir, "customers/tester10") },
      projectAgents: [],
    });
    mocks.applyOpenClawActivationManifest.mockResolvedValue({
      elapsedMs: 42,
      routingActivationRequired: true,
      restartExistingAccountIds: [],
    });
    mocks.removeActivationManifest.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  });

  it.each(["activate", "resume", "quiescing-resume", "quiescing-missing", "quiescing-source-migration", "quiescing-source-migration-missing", "quiescing-source-surge", "quiescing-source-surge-missing", "pre-cutover", "pre-cutover-first", "pre-cutover-known-surge", "pre-cutover-known-surge-replacement", "pre-cutover-known-surge-missing-record", "pre-cutover-partial", "pre-cutover-missing-record", "pre-cutover-local-conflict", "pre-cutover-wrong-claim", "pre-cutover-no-claim", "pre-cutover-missing-pg", "stale-migration"])("preserves and durably reports Shared imported identities before activation (%s)", async (mode) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-anchor-import-"));
    const priorConfig = await fs.readFile(OPENCLAW_CONFIG).catch(() => undefined);
    const priorState = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = dir;
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify({ database: { engine: "postgres" } }));
    clearUserClaim();
    const anchors = [
      { agentId: "octogee-tester10-coach", storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_agent_92c817cc770f466d" },
      { agentId: "octogee-tester10-proj-orbit-coach", storeId: "3313965d-1e56-4006-9d9c-1b0289fafcfa", schema: "octogee_agent_3313965d1e564006" },
    ];
    const migrating = mode.startsWith("pre-cutover") || mode === "stale-migration";
    const knownSurge = mode.startsWith("pre-cutover-known-surge");
    if (knownSurge) { vi.stubEnv("GATEWAY_ID", "shared-target"); vi.stubEnv("POD_UID", mode === "pre-cutover-known-surge-replacement" ? "replacement-pod" : "target-pod"); }
    const sourceMigration = mode.startsWith("quiescing-source-migration");
    const sourceSurge = mode.startsWith("quiescing-source-surge");
    const migration = { migrationId: knownSurge ? "surge-shared-target-target-pod" : sourceSurge ? "surge-shared-source-foreign-pod" : "mig-move", claimStartedAt: 10, sourceGatewayId: knownSurge ? "shared-target" : "source", sourceEpoch: 0 };
    const quiescing = mode.startsWith("quiescing") || migrating;
    if (mode === "quiescing-resume" || mode === "quiescing-source-migration" || mode === "quiescing-source-surge" || mode === "pre-cutover" || mode === "stale-migration") await landAgentAnchors(dir, anchors);
    if (mode === "pre-cutover-partial" || mode === "quiescing-source-migration-missing" || mode === "quiescing-source-surge-missing") await landAgentAnchors(dir, [anchors[0]]);
    if (mode === "pre-cutover-local-conflict") await landAgentAnchors(dir, [{ ...anchors[0], storeId: "11111111-2222-4333-8444-555555555555", schema: "octogee_agent_1111111122224333" }]);
    const priorLocalDefaultAgent = await fs.readFile(path.join(dir, "agents", anchors[0].agentId, "agent", "openclaw-agent.sqlite")).catch(() => undefined);
    const priorLocalProject = await fs.readFile(path.join(dir, "agents", anchors[1].agentId, "agent", "openclaw-agent.sqlite")).catch(() => undefined);
    let firstAnchorQuery = mode === "activate";
    anchorQuery.mockImplementation(async (target, sql) => {
      if (mode === "pre-cutover-missing-pg" && target.schema === anchors[1].schema) throw Object.assign(new Error("relation missing"), { code: "42P01" });
      if (firstAnchorQuery) {
        firstAnchorQuery = false;
        await new Promise(resolve => setTimeout(resolve, 1_100));
      }
      return sql.includes("openclaw_schema_meta")
        ? [{ store_id: target.storeId }] : [{ agent_id: anchors.find((anchor) => anchor.schema === target.schema)!.agentId }];
    });
    mocks.readActivationManifest.mockResolvedValue({
      slug: "tester10", appliedFingerprint: "retained-import", agentId: anchors[0].agentId,
      agent: { id: anchors[0].agentId, workspace: path.join(testRuntime.dir, "customers/tester10") },
      accountId: "tester10-coach", mattermostAccount: { botToken: "synthetic-coach-pat" },
      projectAgents: [{ agentId: anchors[1].agentId, accountId: "tester10-proj-orbit", agent: {
        id: anchors[1].agentId, workspace: path.join(testRuntime.dir, "customers/tester10/projects/orbit"),
      } }],
    });
    const read = vi.fn(async () => {
      if (mode === "stale-migration") throw new Error("migration custody changed");
      return { ...((migrating || sourceMigration) && mode !== "pre-cutover-no-claim" ? { migration: mode === "pre-cutover-wrong-claim" ? { ...migration, migrationId: "mig-other" } : migration } : {}), anchors: mode === "pre-cutover-missing-record" || mode === "pre-cutover-known-surge-missing-record" ? anchors.slice(0, 1) : anchors, assignment: { uid: "uid-tester10", epoch: 0, state: quiescing ? "quiescing" as const : "serving" as const } }; });
    let release!: () => void;
    const recorded = new Promise<void>((resolve) => { release = resolve; });
    let reportStarted!: () => void;
    const reportEntered = new Promise<void>((resolve) => { reportStarted = resolve; });
    const report = vi.fn(async () => { reportStarted(); await recorded; });
    const resuming = !migrating && mode !== "activate";
    if (resuming) { vi.stubEnv("GATEWAY_ID", "shared-source"); vi.stubEnv("POD_UID", "source-pod"); }
    const rpc = mkGatewayRpc({ ...(resuming ? { configGet: vi.fn(async () => configSnapshot({ agents: { entries: Object.fromEntries(anchors.map(anchor => [anchor.agentId, { workspace: path.join(testRuntime.dir, "customers", "tester10", ...(anchor.agentId.includes("-proj-") ? ["projects", "orbit"] : [])) }])) } })) } : {}), agentsCreate: vi.fn(async ({ name, workspace }) => {
      expect(await readLocalAgentAnchors(dir, anchors.map((anchor) => anchor.agentId))).toEqual(anchors);
      return { ok: true as const, agentId: name, name, workspace };
    }), channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [
      { accountId: "tester10-coach", running: true, connected: true },
      { accountId: "tester10-proj-orbit", running: true, connected: true },
    ] } })) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ ...(resuming ? { userSnapshot: vi.fn(async () => ({ uid: "uid-tester10", slug: "tester10", gatewayId: "shared-source", status: "complete" }) as FleetBrokerUserSnapshot), assignmentRoster: vi.fn(async () => [{ uid: "uid-tester10", state: quiescing ? "quiescing" as const : "serving" as const, epoch: 0 }]) } : {}), ...(migrating && !knownSurge ? { uidForSlug: vi.fn(async () => null) } : {}), readAgentAnchors: read, reportAgentAnchors: report }), rpc, log: vi.fn(), isIsolatedGateway: () => false });
    const activation = migrating ? adapter.activateImportedUser("tester10", { migrationId: migration.migrationId, beforeRuntimePublish: async () => undefined }) : mode === "activate" ? adapter.activateImportedUser("tester10") : adapter.resumeUser("tester10", { migrationId: migration.migrationId });
    const observed = activation.catch((error) => error);
    try {
      const refusals: Partial<Record<string, string>> = {
        "quiescing-missing": "existing local", "quiescing-source-migration-missing": "existing local", "quiescing-source-surge-missing": "existing local", "stale-migration": "custody changed",
        "pre-cutover-missing-record": "every recorded agent identity", "pre-cutover-known-surge-missing-record": "every recorded agent identity", "pre-cutover-local-conflict": "different identity",
        "pre-cutover-wrong-claim": "migration anchor authority", "pre-cutover-no-claim": "migration anchor authority", "pre-cutover-missing-pg": "is missing",
      };
      const refusal = refusals[mode];
      if (refusal) {
        await expect(activation).rejects.toThrow(refusal);
        expect(rpc.agentsCreate).not.toHaveBeenCalled();
        expect(report).not.toHaveBeenCalled();
        if (priorLocalProject) expect(await fs.readFile(path.join(dir, "agents", anchors[1].agentId, "agent", "openclaw-agent.sqlite"))).toEqual(priorLocalProject);
        else await expect(fs.stat(path.join(dir, "agents", anchors[1].agentId, "agent", "openclaw-agent.sqlite"))).rejects.toThrow();
        if (priorLocalDefaultAgent) expect(await fs.readFile(path.join(dir, "agents", anchors[0].agentId, "agent", "openclaw-agent.sqlite"))).toEqual(priorLocalDefaultAgent);
        else await expect(fs.stat(path.join(dir, "agents", anchors[0].agentId, "agent", "openclaw-agent.sqlite"))).rejects.toThrow();
      } else {
        await Promise.race([
          reportEntered,
          activation.then(() => { throw new Error("activation completed before anchor reporting"); }),
        ]);
        expect(report).toHaveBeenCalledOnce();
        expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
        expect(rpc.channelsStart).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledWith({ ...(migrating ? { migrationId: migration.migrationId, ...(knownSurge ? { uid: "uid-tester10" } : {}) } : { uid: "uid-tester10" }), slug: "tester10" });
        expect(report).toHaveBeenCalledWith({ uid: "uid-tester10", slug: "tester10", ...(migrating || sourceMigration ? { migration } : {}), assignmentEpoch: 0, assignmentState: quiescing ? "quiescing" : "serving", anchors, configuredAgentIds: anchors.map((anchor) => anchor.agentId) });
        release();
        await activation;
        expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce();
        if (priorLocalDefaultAgent) expect(await fs.readFile(path.join(dir, "agents", anchors[0].agentId, "agent", "openclaw-agent.sqlite"))).toEqual(priorLocalDefaultAgent);
      }
    } finally {
      release(); await observed;
      if (resuming || knownSurge) vi.unstubAllEnvs();
      if (priorState === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = priorState;
      if (priorConfig) await fs.writeFile(OPENCLAW_CONFIG, priorConfig);
      else await fs.rm(OPENCLAW_CONFIG, { force: true });
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("defers credential repair until an account import finishes its configuration updates", async () => {
    _resetBrokerProfileLogStateForTests();
    let releasePatch!: () => void;
    mocks.applyOpenClawActivationManifest.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releasePatch = resolve; });
      return { elapsedMs: 42, routingActivationRequired: false, restartExistingAccountIds: [] };
    });
    const rpc = {
      ...rosterRpc(),
      channelsStatus: vi.fn(async () => ({ channelAccounts: {
        mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
      } })),
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const activation = adapter.activateImportedUser("tester10");
    try {
      await vi.waitFor(() => expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce());
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockClear();
      const result = await materializeDeferredBrokerProfiles(vi.fn(), {
        readConfig: () => ({}), secretsReload: rpc,
      });
      expect(result).toMatchObject({ settled: false, skipped: true });
      expect(brokerCatalogMocks.materializeBrokerProfilesForAgents).not.toHaveBeenCalled();
      expect(rpc.secretsReload).not.toHaveBeenCalled();
    } finally {
      releasePatch();
      await activation;
      _resetBrokerProfileLogStateForTests();
    }
    await expect(materializeDeferredBrokerProfiles(vi.fn(), {
      readConfig: () => ({}), secretsReload: rpc,
    })).resolves.toMatchObject({ settled: true });
    expect(brokerCatalogMocks.materializeBrokerProfilesForAgents).toHaveBeenCalledOnce();
  });

  it("prepares imported credentials after agent revival and before activating the manifest", async () => {
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockClear();
    const rpc = {
      ...rosterRpc(),
      channelsStatus: vi.fn(async () => ({ channelAccounts: {
        mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
      } })),
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log: vi.fn(),
    });
    await adapter.activateImportedUser("tester10");
    expect(brokerCatalogMocks.materializeBrokerProfilesForAgents).toHaveBeenCalledOnce();
    expect(brokerCatalogMocks.materializeBrokerProfilesForAgents.mock.invocationCallOrder[0])
      .toBeGreaterThan(rpc.agentsCreate.mock.invocationCallOrder.at(-1)!);
    expect(brokerCatalogMocks.materializeBrokerProfilesForAgents.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.applyOpenClawActivationManifest.mock.invocationCallOrder[0]);
  });

  it.each([false, true])("waits for the final import revision and only gates intermediate roster revisions on isolated gateways (isolated=%s)", async (isIsolatedGateway) => {
    let created = false;
    let applied = false;
    const base = rosterRpc();
    const rpc = {
      ...base,
      agentsCreate: vi.fn(async (params: { name: string; workspace: string }) => {
        const result = await base.agentsCreate(params);
        created = true;
        return result;
      }),
      configGet: vi.fn(async () => {
        const revision = mocks.applyOpenClawActivationManifest.mock.calls.length > 0
          ? "revision-import"
          : "revision-roster";
        return {
          ...configSnapshot({}),
          configRevisionHash: revision,
          appliedConfigHash: !created || applied ? revision : "revision-before",
        };
      }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: {
        mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
      } })),
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log: vi.fn(),
      isIsolatedGateway: () => isIsolatedGateway,
    });
    const activation = adapter.activateImportedUser("tester10");
    try {
      await vi.waitFor(() => expect(rpc.agentsCreate).toHaveBeenCalledOnce());
      if (isIsolatedGateway) {
        expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce());
      }
      expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
      expect(rpc.channelsStatus).not.toHaveBeenCalled();
    } finally {
      applied = true;
      await activation;
    }
    expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce();
    expect(mocks.removeActivationManifest).toHaveBeenCalledOnce();
  });

  it("keeps a shared import pending when its final revision fails to apply", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const rpc = {
      ...rosterRpc(),
      configGet: vi.fn(async () => {
        if (mocks.applyOpenClawActivationManifest.mock.calls.length === 0) return configSnapshot({});
        now += 60_001;
        return {
          ...configSnapshot({}),
          configRevisionHash: "revision-import",
          appliedConfigHash: "revision-roster",
        };
      }),
      channelsStatus: vi.fn(),
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log: vi.fn(),
      isIsolatedGateway: () => false,
    });
    try {
      await expect(adapter.activateImportedUser("tester10")).resolves.toMatchObject({
        verificationPending: expect.stringContaining("active config did not reach revision revision-import"),
      });
      expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
      expect(rpc.secretsReload).not.toHaveBeenCalled();
      expect(rpc.channelsStatus).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("deletes target roster residue the manifest does not carry before activating", async () => {
    mocks.readActivationManifest.mockResolvedValue({
      slug: "tester10",
      appliedFingerprint: "fp-tester10",
      agentId: "octogee-tester10-coach",
      agent: { id: "octogee-tester10-coach", workspace: path.join(testRuntime.dir, "customers/tester10") },
      projectAgents: [],
    });
    const client = mkClient();
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      ...rosterRpc({
        agents: {
          entries: keyedRoster([
            "octogee-tester10-coach",
            "octogee-tester10-proj-residue-coach",
            "octogee-keeper-coach",
          ]),
        },
      }),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });

    await adapter.activateImportedUser("tester10", {});

    expect(vi.mocked(rpc.agentsDelete).mock.calls.map(([params]) => params.agentId)).toEqual([
      "octogee-tester10-proj-residue-coach",
    ]);
    expect(rpc.agentsDelete.mock.invocationCallOrder[0]).toBeLessThan(
      routingActivationMocks.capture.mock.invocationCallOrder[0]!,
    );
    expect(routingActivationMocks.capture.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyOpenClawActivationManifest.mock.invocationCallOrder[0]!,
    );
  });

  it.each([false, true])("revives imported projects before applying model secrets and activation (already rostered: %s)", async (rostered) => {
    const agentId = "octogee-tester10-proj-orbit-coach";
    let deleted = true;
    mocks.readActivationManifest.mockResolvedValue({
      slug: "tester10",
      appliedFingerprint: "fp-tester10",
      agentId: "octogee-tester10-coach",
      agent: { id: "octogee-tester10-coach", workspace: path.join(testRuntime.dir, "customers/tester10") },
      projectAgents: [{
        agentId,
        agent: { id: agentId, workspace: path.join(testRuntime.dir, "customers/tester10/projects/orbit") },
      }],
    });
    const rpc = mkGatewayRpc({
      ...rosterRpc({ agents: { entries: keyedRoster(rostered ? [agentId] : []) } }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [
        { accountId: "tester10-coach", running: true, connected: true },
      ] } })),
      agentsCreate: vi.fn(async ({ name, workspace }) => {
        if (name === agentId) {
          deleted = false;
          if (rostered) throw new OpenclawWireError("rpc-error", `agent "${name}" already exists`);
        }
        return { ok: true, agentId: name, name, workspace };
      }),
    });
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockImplementationOnce(() => ({
      materialized: deleted ? 0 : 1,
      deferred: deleted ? [agentId] : [],
    }));
    mocks.applyOpenClawActivationManifest.mockImplementationOnce(async () => {
      if (deleted) throw new Error("agent database is unavailable while agent is deleted");
      return { elapsedMs: 1, routingActivationRequired: false, restartExistingAccountIds: [] };
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.activateImportedUser("tester10");

    expect(deleted).toBe(false);
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
  });

  it("restores the subscription store after the transferred state lands on a isolated gateway", async () => {
    modelCredentialMocks.restoreModelCredentialOauthStoreForSlug.mockClear();
    const rpc = {
      gatewayRestartRequest: vi.fn(async () => ({ status: "requested" })),
      isGatewayUp: vi.fn(async () => true),
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({
        agents: { list: [{ id: "octogee-tester10-coach", model: "house" }] },
      })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc,
      log: vi.fn(),
      isIsolatedGateway: () => true,
    });

    await adapter.activateImportedUser("tester10");

    expect(modelCredentialMocks.restoreModelCredentialOauthStoreForSlug).toHaveBeenCalledWith(
      "tester10",
      expect.objectContaining({ logFn: expect.any(Function) }),
    );
    expect(
      modelCredentialMocks.restoreModelCredentialOauthStoreForSlug.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.applyOpenClawActivationManifest.mock.invocationCallOrder[0]!);
  });

  it("does not restore the subscription store when importing onto a shared gateway", async () => {
    modelCredentialMocks.restoreModelCredentialOauthStoreForSlug.mockClear();
    const rpc = {
      gatewayRestartRequest: vi.fn(async () => ({ status: "requested" })),
      isGatewayUp: vi.fn(async () => true),
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({
        agents: { list: [{ id: "octogee-tester10-coach", model: "house" }] },
      })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.activateImportedUser("tester10");

    expect(modelCredentialMocks.restoreModelCredentialOauthStoreForSlug).not.toHaveBeenCalled();
  });

  async function sourcePersonaFixture(epoch = 4) {
    const workspace = path.join(testRuntime.dir, "customers", "tester10");
    const project = path.join(workspace, "projects", "persona");
    const userDefaultAgentId = "octogee-tester10-coach", projectId = "octogee-tester10-proj-persona-coach";
    const originals = new Map([
      [workspace, Buffer.from("# Agent\r\n\r\n- **Name:** Authored agent\r\nPrivate notes.\r\n")],
      [project, Buffer.from("# Identity\n\n- **Name:** Authored name\n\nPersonal notes stay byte-exact. 🐙\n")],
    ]);
    for (const [dir, bytes] of originals) { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, "IDENTITY.md"), bytes); }
    vi.stubEnv("GATEWAY_ID", "shared-source");
    vi.stubEnv("POD_UID", "source-pod");
    const binding = { migrationId: "migration-source-persona", uid: "uid-tester10", gatewayId: "shared-source", podUid: "source-pod", epoch };
    const manifest = await captureSourceWorkspaceIdentities({
      version: 2, slug: "tester10", appliedFingerprint: "source-persona", agentId: userDefaultAgentId, accountId: "tester10-coach",
      agent: { id: userDefaultAgentId, workspace, identity: { name: "Config agent differs" } },
      mattermostAccount: { botToken: "coach-token" }, bindings: [{ agentId: userDefaultAgentId, match: { channel: "mattermost", accountId: "tester10-coach" } }],
      projectAgents: [{ agentId: projectId, accountId: "tester10-proj-persona", agent: { id: projectId, workspace: project, identity: { name: "Config project differs" } }, mattermostAccount: { botToken: "project-token" }, bindings: [{ agentId: projectId, match: { channel: "mattermost", accountId: "tester10-proj-persona" } }] }],
    }, testRuntime.dir, binding);
    await writeActivationManifest(testRuntime.dir, manifest);
    mocks.readActivationManifest.mockImplementation(() => realReadActivationManifest(testRuntime.dir, "tester10"));
    const client = mkClient({
      userSnapshot: vi.fn(async () => ({ uid: binding.uid, slug: "tester10", gatewayId: binding.gatewayId, status: "complete" }) as FleetBrokerUserSnapshot),
      assignmentRoster: vi.fn(async () => [{ uid: binding.uid, state: "quiescing", epoch: binding.epoch }]),
    });
    const nativeWrite = async ({ name, workspace }: { name: string; workspace: string }) => {
      const filename = path.join(workspace, "IDENTITY.md");
      const content = await fs.readFile(filename, "utf8");
      await fs.writeFile(filename, content.replace(/^- \*?\*?Name:\*?\*?.*$/mu, `- Name: ${name}`));
      return { ok: true as const, agentId: name, name, workspace };
    };
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot({ agents: { entries: {} }, channels: { mattermost: { accounts: { "tester10-coach": {}, "tester10-proj-persona": {} } } } })), agentsCreate: vi.fn(nativeWrite),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] } })),
    });
    mocks.applyOpenClawActivationManifest.mockImplementation(async (applied) => {
      for (const [dir, bytes] of originals) expect(await fs.readFile(path.join(dir, "IDENTITY.md"))).toEqual(bytes);
      expect(applied.projectAgents[0].agent.identity.name).toBe("Config project differs");
      return { routingActivationRequired: false, elapsedMs: 0 };
    });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    return { workspace, project, projectId, userDefaultAgentId, originals, manifest, binding, client, rpc, nativeWrite, adapter };
  }

  it.skipIf(process.platform !== "linux")("preserves transferred agent and project persona before Shared target activation routing", async () => {
    try {
      const fixture = await sourcePersonaFixture();
      vi.stubEnv("GATEWAY_ID", "shared-target");
      vi.stubEnv("POD_UID", "target-pod");
      const custody = { migrationId: fixture.binding.migrationId, uid: fixture.binding.uid, gatewayId: "shared-target", podUid: "target-pod" };
      const ids = [fixture.userDefaultAgentId, fixture.projectId];
      const capture = await captureTargetWorkspaceIdentities("tester10", ids, testRuntime.dir, custody);
      await writeActivationManifest(testRuntime.dir, { ...fixture.manifest, targetWorkspaceIdentities: capture });
      await fixture.adapter.activateImportedUser("tester10", { migrationId: fixture.binding.migrationId,
        beforeRuntimePublish: async () => {
          const retained = await realReadActivationManifest(testRuntime.dir, "tester10");
          await restoreTargetWorkspaceIdentities(retained.targetWorkspaceIdentities!, "tester10", ids, testRuntime.dir, { custody, assertCurrent: async () => undefined });
        },
      });
      expect(fixture.rpc.agentsCreate).toHaveBeenCalledTimes(2);
      expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce();
      for (const [dir, bytes] of fixture.originals) expect(await fs.readFile(path.join(dir, "IDENTITY.md"))).toEqual(bytes);
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux")("does not restore target personas or publish after Native ACKs when the request aborts", async () => {
    try {
      const f = await sourcePersonaFixture(), controller = new AbortController();
      vi.mocked(f.rpc.agentsCreate).mockImplementation(async params => { const value = await f.nativeWrite(params); if (params.name === f.projectId) { controller.abort(new Error("target request cancelled")); } return value; });
      const beforeRuntimePublish = vi.fn(async () => undefined);
      await expect(f.adapter.activateImportedUser("tester10", { migrationId: f.binding.migrationId, signal: controller.signal, beforeRuntimePublish })).rejects.toThrow("target request cancelled");
      expect(beforeRuntimePublish).not.toHaveBeenCalled(); expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled(); expect(f.rpc.channelsStart).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(f.project, "IDENTITY.md"))).not.toEqual(f.originals.get(f.project));
    } finally { vi.unstubAllEnvs(); }
  });

  async function assignedPersonaFixture() {
    const f = await sourcePersonaFixture();
    await fs.unlink(path.join(testRuntime.dir, activationManifestTarPath("tester10")));
    const snapshot = aliceSnapshot({ uid: "uid-tester10", slug: "tester10", gatewayId: "shared-source", status: "complete", runtimeMutationFenced: false, customerMmUserId: TESTER_OWNER_MM_ID, mattermostUserId: TESTER_OWNER_MM_ID,
      coachIdentity: { name: "Config name differs" }, coachToken: "coach-token", projectAgents: [{ projectId: "persona", enabled: true, status: "ready", token: "project-token", mmUserId: "pppppppppppppppppppppppppp" }] });
    vi.mocked(f.client.userSnapshot).mockResolvedValue(snapshot);
    vi.mocked(f.client.assignmentRoster).mockResolvedValue([{ uid: snapshot.uid, state: "serving", epoch: 4 }]);
    mocks.removeActivationManifest.mockImplementation(async () => { await fs.rm(path.join(testRuntime.dir, activationManifestTarPath("tester10")), { force: true }); });
    return { ...f, snapshot, mount: (options = {}) => f.adapter.applyAddUserConfigPatch(snapshot as never, { _coachPersonalToken: "coach-token" }, options) };
  }

  function assignedPersonaRoster(f: Awaited<ReturnType<typeof assignedPersonaFixture>>, ids: string[]) {
    return configSnapshot({ agents: { entries: Object.fromEntries(ids.map(id => [id, {
      workspace: id === f.userDefaultAgentId ? f.workspace : f.project, agentDir: path.join(testRuntime.dir, "agents", id, "agent"),
    }])) }, channels: { mattermost: { accounts: { "tester10-coach": {}, "tester10-proj-persona": {} } } } });
  }

  function assignedRestoreAuthority() {
    return { uid: "uid-tester10", slug: "tester10", gatewayId: "shared-source", fromGatewayId: "user-source", assignmentEpoch: 4,
      operationId: "restore-operation", migrationId: "mig-restore-operation", claimStartedAt: 123, attemptId: "restore-attempt", phase: "dispatched" as const, dispatchedAt: 125, dispatchClaimStartedAt: 123 };
  }

  it.skipIf(process.platform !== "linux")("signed Shared restore captures converged Git bytes before actual Native creation", async () => {
    try {
      const f = await assignedPersonaFixture();
      const snapshot = { ...f.snapshot, repoUrl: "git@gitea:octogee/tester10-workspace.git", projectAgents: [], projects: [], restoreAuthority: assignedRestoreAuthority(), runtimeMutationFenced: true };
      vi.mocked(f.client.userSnapshot).mockResolvedValue(snapshot);
      const original = Buffer.from("# Restored from durable Git\r\n- Name: Authored restored name 🐙\r\n");
      const adapter = { ...f.adapter, hasUserSshKey: () => true, readLocalUserPubKey: () => "ssh-ed25519 TEST", gitHost: { ...f.adapter.gitHost, listKeys: async () => ["ssh-ed25519 TEST"], registerKey: async () => undefined,
        ensureOwner: async () => undefined }, hasWorkspaceGitDir: () => false, cloneWorkspaceRepo: async () => { await fs.writeFile(path.join(f.workspace, "IDENTITY.md"), original); return true; },
        removePartialWorkspace: async () => undefined,
        ensureUserDirectories: () => undefined, writeUserTemplateFiles: async () => undefined, blobSyncForSlug: async () => undefined,
        restoreByosubForAgent: async () => ({ restored: false, present: false }), isIsolatedGateway: () => false };
      const body = { migrationId: snapshot.restoreAuthority.migrationId, uid: snapshot.uid, slug: snapshot.slug, snapshot };
      const rawBody = JSON.stringify(body), signature = signFleetRequest(FLEET_KEY_PAIR.privateKey, gatewayScopedJobId(body.migrationId, "shared-source"), rawBody);
      const req = { header: () => signature, params: { gatewayId: "shared-source" }, rawBody } as unknown as Request;
      let status: number | undefined, payload: unknown;
      const res = { status(code: number) { status = code; return this; }, json(value: unknown) { payload = value; return this; } } as unknown as Response;
      await createRestoreHandler({ gatewayId: "shared-source", publicKey: FLEET_KEY_PAIR.publicKey, adapter, log: vi.fn() })(req, res, vi.fn());
      expect(status, JSON.stringify(payload)).toBe(200);
      expect(f.rpc.agentsCreate).toHaveBeenCalledOnce();
      expect(await fs.readFile(path.join(f.workspace, "IDENTITY.md"))).toEqual(original);
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux").each(["missing", "claim", "operation", "epoch"])("refuses Shared restore when current attested authority is %s", async mode => {
    try {
      const f = await assignedPersonaFixture(), restoreAuthority = assignedRestoreAuthority();
      const snapshot = { ...f.snapshot, restoreAuthority, runtimeMutationFenced: true };
      vi.mocked(f.client.userSnapshot).mockResolvedValue(mode === "missing" ? f.snapshot : snapshot);
      if (mode !== "missing") vi.mocked(f.rpc.agentsCreate).mockImplementation(async params => {
        const result = await f.nativeWrite(params);
        const next = { ...restoreAuthority, ...(mode === "claim" ? { claimStartedAt: 124 } : mode === "operation" ? { operationId: "successor" } : { assignmentEpoch: 5 }) };
        vi.mocked(f.client.userSnapshot).mockResolvedValue({ ...snapshot, restoreAuthority: next });
        return result;
      });
      await expect(f.mount({ migrationId: restoreAuthority.migrationId })).rejects.toThrow(/authority/);
      expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
      if (mode === "missing") expect(f.rpc.agentsCreate).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux")("preserves restored authored personas during ordinary complete Shared cold mount", async () => {
    try {
      const f = await assignedPersonaFixture();
      await f.mount();
      expect(f.rpc.agentsCreate).toHaveBeenCalledTimes(2);
      for (const [dir, bytes] of f.originals) expect(await fs.readFile(path.join(dir, "IDENTITY.md"))).toEqual(bytes);
      await expect(fs.access(path.join(testRuntime.dir, activationManifestTarPath("tester10")))).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux").each([true, false])("moves an existing Shared project agent in place when GitHub backing is %s", async githubBacked => {
    try {
      const f = await assignedPersonaFixture();
      f.snapshot.projectAgents![0].githubBacked = githubBacked ? true : undefined;
      const privateWorkspace = path.join(f.workspace, ".system", "project-coaches", "persona");
      const desired = githubBacked ? privateWorkspace : f.project;
      const before = githubBacked ? f.project : privateWorkspace;
      const privateIdentity = "Private project persona";
      await fs.mkdir(privateWorkspace, { recursive: true });
      await fs.writeFile(path.join(privateWorkspace, "IDENTITY.md"), privateIdentity);
      await fs.writeFile(path.join(privateWorkspace, "AGENTS.md"), "Private agent instructions");
      const config = assignedPersonaRoster(f, [f.userDefaultAgentId, f.projectId]).config;
      config.agents.entries[f.projectId].workspace = before;
      vi.mocked(f.rpc.configGet).mockResolvedValue(configSnapshot(config));
      vi.mocked(f.rpc.agentsCreate).mockImplementation(async ({ name }) => {
        throw new OpenclawWireError("rpc-error", `agent "${name}" already exists`);
      });
      patchMocks.applyConfigPatch.mockImplementationOnce(async args => {
        const patch = args.buildPatch(config) as typeof config;
        expect(patch.agents.entries[f.projectId]).toMatchObject({
          workspace: desired, agentDir: config.agents.entries[f.projectId].agentDir,
        });
        return { mode: "rpc", attempts: 1 };
      });

      await f.mount();

      expect(patchMocks.applyConfigPatch).toHaveBeenCalledOnce();
      expect(f.rpc.agentsDelete).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(f.project, "IDENTITY.md"))).toEqual(f.originals.get(f.project));
      expect(await fs.readFile(path.join(privateWorkspace, "IDENTITY.md"), "utf8")).toBe(privateIdentity);
      await expect(fs.access(path.join(testRuntime.dir, activationManifestTarPath("tester10")))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux").each(["foreign workspace", "agent directory", "duplicate", "pending manifest"])("rejects a Shared project relocation with %s", async invalid => {
    try {
      const f = await assignedPersonaFixture();
      f.snapshot.projectAgents![0].githubBacked = true;
      const keyed = assignedPersonaRoster(f, [f.userDefaultAgentId, f.projectId]).config;
      const entry = keyed.agents.entries[f.projectId];
      if (invalid === "foreign workspace") entry.workspace = path.join(testRuntime.dir, "customers/foreign/projects/persona");
      if (invalid === "agent directory") entry.agentDir = path.join(testRuntime.dir, "agents/foreign/agent");
      if (invalid === "pending manifest") await writeActivationManifest(testRuntime.dir, f.manifest);
      const list = Object.entries(keyed.agents.entries).map(([id, agent]) => ({ ...agent, id }));
      const current = invalid === "duplicate" ? { ...keyed, agents: { list: [...list, { ...entry, id: f.projectId }] } } : keyed;
      vi.mocked(f.rpc.configGet).mockResolvedValue(configSnapshot(current));

      await expect(f.mount()).rejects.toThrow("Assigned Shared Native roster identity changed");
      expect(f.rpc.agentsCreate).not.toHaveBeenCalled();
      expect(f.rpc.agentsDelete).not.toHaveBeenCalled();
      expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux")("refuses a Shared project relocation when the latest config changes its workspace", async () => {
    try {
      const f = await assignedPersonaFixture();
      f.snapshot.projectAgents![0].githubBacked = true;
      const current = assignedPersonaRoster(f, [f.userDefaultAgentId, f.projectId]);
      vi.mocked(f.rpc.configGet).mockResolvedValue(current);
      vi.mocked(f.rpc.agentsCreate).mockImplementation(async ({ name }) => {
        throw new OpenclawWireError("rpc-error", `agent "${name}" already exists`);
      });
      patchMocks.applyConfigPatch.mockImplementationOnce(async args => {
        const latest = structuredClone(current.config);
        latest.agents.entries[f.projectId].workspace = path.join(f.workspace, "arbitrary");
        args.buildPatch(latest);
        return { mode: "rpc", attempts: 1 };
      });

      await expect(f.mount()).rejects.toThrow("Assigned Shared Native roster identity changed");
      expect(f.rpc.agentsDelete).not.toHaveBeenCalled();
      expect(routingActivationMocks.activateAfterPatch).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux")("retains only missing-agent originals across a late create and duplicate mount retry", async () => {
    try {
      const f = await assignedPersonaFixture();
      const rostered = [f.userDefaultAgentId];
      vi.mocked(f.rpc.configGet).mockImplementation(async () => assignedPersonaRoster(f, rostered));
      let late!: () => Promise<void>, failed = false;
      const currentDefaultAgent = Buffer.from("# Agent edited while already live\n- Name: Live author\n");
      vi.mocked(f.rpc.agentsCreate).mockImplementation(async params => {
        if (params.name === f.userDefaultAgentId) { await fs.writeFile(path.join(f.workspace, "IDENTITY.md"), currentDefaultAgent); throw new OpenclawWireError("rpc-error", `agent "${params.name}" already exists`); }
        if (!failed) { failed = true; late = async () => { await f.nativeWrite(params); rostered.push(f.projectId); }; throw new Error("create response timed out"); }
        throw new OpenclawWireError("rpc-error", `agent "${params.name}" already exists`);
      });
      await expect(f.mount()).rejects.toThrow("create response timed out");
      expect((await realReadActivationManifest(testRuntime.dir, "tester10")).targetWorkspaceIdentities?.files.map(file => file.agentId)).toEqual([f.projectId]);
      await late();
      await f.mount();
      expect(await fs.readFile(path.join(f.project, "IDENTITY.md"))).toEqual(f.originals.get(f.project));
      expect(await fs.readFile(path.join(f.workspace, "IDENTITY.md"))).toEqual(currentDefaultAgent);
      expect(patchMocks.applyConfigPatch).toHaveBeenCalledOnce();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux").each([false, true])("ordinary reconcile preserves live edits after successful import (retained verification manifest: %s)", async retained => {
    try {
      const f = await assignedPersonaFixture();
      const capture = await captureTargetWorkspaceIdentities("tester10", [f.userDefaultAgentId, f.projectId], testRuntime.dir, { migrationId: "mig-incoming", uid: f.snapshot.uid, gatewayId: "shared-source", podUid: "source-pod" });
      const manifest = { ...f.manifest, targetWorkspaceIdentities: capture };
      await writeActivationManifest(testRuntime.dir, manifest);
      await f.adapter.activateImportedUser("tester10", { migrationId: "mig-incoming", beforeRuntimePublish: async () => {
        await restoreTargetWorkspaceIdentities(capture, "tester10", [f.userDefaultAgentId, f.projectId], testRuntime.dir, { custody: capture, assertCurrent: async () => undefined });
      } });
      await expect(fs.access(path.join(testRuntime.dir, activationManifestTarPath("tester10")))).rejects.toThrow();
      if (retained) await writeActivationManifest(testRuntime.dir, manifest);
      vi.mocked(f.rpc.configGet).mockImplementation(async () => assignedPersonaRoster(f, [f.userDefaultAgentId, f.projectId]));
      const edited = Buffer.from("# Identity\n- Name: Legitimate later author\n");
      vi.mocked(f.rpc.agentsCreate).mockImplementation(async params => { if (params.name === f.projectId) { await fs.writeFile(path.join(f.project, "IDENTITY.md"), edited); } throw new OpenclawWireError("rpc-error", `agent "${params.name}" already exists`); });
      await f.mount();
      expect(await fs.readFile(path.join(f.project, "IDENTITY.md"))).toEqual(edited);
      await expect(fs.access(path.join(testRuntime.dir, activationManifestTarPath("tester10")))).rejects.toThrow();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux").each([false, true])("source resume preserves originals retained by an interrupted ordinary Shared mount (project absent: %s)", async absent => {
    try {
      const f = await assignedPersonaFixture();
      if (absent) {
        await fs.unlink(path.join(f.project, "IDENTITY.md"));
        vi.mocked(f.rpc.agentsCreate).mockImplementation(async params => {
          if (params.name !== f.projectId) return f.nativeWrite(params);
          await fs.writeFile(path.join(f.project, "IDENTITY.md"), "- Name: Native-created project\n");
          return { ok: true, agentId: params.name, name: params.name, workspace: params.workspace };
        });
      }
      routingActivationMocks.capture.mockRejectedValueOnce(new Error("mount routing baseline interrupted"));
      await expect(f.mount()).rejects.toThrow("mount routing baseline interrupted");
      const retained = await realReadActivationManifest(testRuntime.dir, "tester10");
      expect(retained.sourceWorkspaceIdentities).toBeUndefined();
      expect(retained.targetWorkspaceIdentities).toMatchObject({ uid: f.snapshot.uid, gatewayId: "shared-source", podUid: "source-pod", assignmentEpoch: 4 });
      expect(retained.targetWorkspaceIdentities!.migrationId).toBeUndefined();
      for (const [dir, bytes] of f.originals) expect(await fs.readFile(path.join(dir, "IDENTITY.md"))).not.toEqual(bytes);
      vi.mocked(f.client.assignmentRoster).mockResolvedValue([{ uid: f.snapshot.uid, state: "quiescing", epoch: 4 }]);
      vi.mocked(f.rpc.configGet).mockImplementation(async () => assignedPersonaRoster(f, [f.userDefaultAgentId, f.projectId]));
      vi.mocked(f.rpc.agentsCreate).mockImplementation(async params => { throw new OpenclawWireError("rpc-error", `agent "${params.name}" already exists`); });
      vi.mocked(f.rpc.agentsCreate).mockClear();
      mocks.applyOpenClawActivationManifest.mockResolvedValue({ routingActivationRequired: false, elapsedMs: 0 });
      await f.adapter.resumeUser("tester10", { migrationId: "mig-after-interrupted-mount" });
      expect(f.rpc.agentsCreate).toHaveBeenCalledTimes(2);
      expect(f.rpc.channelsStart).toHaveBeenCalled();
      await expect(fs.access(path.join(testRuntime.dir, activationManifestTarPath("tester10")))).rejects.toThrow();
      for (const [dir, bytes] of f.originals) {
        if (absent && dir === f.project) await expect(fs.access(path.join(dir, "IDENTITY.md"))).rejects.toThrow();
        else expect(await fs.readFile(path.join(dir, "IDENTITY.md"))).toEqual(bytes);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux").each(["uid", "gatewayId", "podUid", "assignmentEpoch", "migrationId"] as const)("refuses a normal mount capture with foreign %s before source resume effects", async key => {
    try {
      const f = await assignedPersonaFixture();
      const capture = await captureTargetWorkspaceIdentities("tester10", [f.userDefaultAgentId, f.projectId], testRuntime.dir, { uid: f.snapshot.uid, gatewayId: "shared-source", podUid: "source-pod", assignmentEpoch: 4 });
      const retained = { ...f.manifest, targetWorkspaceIdentities: { ...capture, [key]: key === "assignmentEpoch" ? 5 : "foreign" } };
      delete retained.sourceWorkspaceIdentities;
      await writeActivationManifest(testRuntime.dir, retained);
      vi.mocked(f.rpc.configGet).mockImplementation(async () => assignedPersonaRoster(f, [f.userDefaultAgentId, f.projectId]));
      vi.mocked(f.client.assignmentRoster).mockResolvedValue([{ uid: f.snapshot.uid, state: "quiescing", epoch: 4 }]);
      await expect(f.adapter.resumeUser("tester10", { migrationId: "mig-after-interrupted-mount" })).rejects.toThrow(/custody changed|migration-bound/);
      expect(f.rpc.agentsCreate).not.toHaveBeenCalled(); expect(f.rpc.channelsStart).not.toHaveBeenCalled();
      expect(secretMocks.materializeActivationManifestSecret).not.toHaveBeenCalled();
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled(); expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
      expect((await realReadActivationManifest(testRuntime.dir, "tester10")).targetWorkspaceIdentities).toEqual(retained.targetWorkspaceIdentities);
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux").each(["absent", "fenced", "unknown", "epoch", "pod", "successor"])("refuses assigned workspace restoration before publication when authority changes: %s", async mode => {
    try {
      const f = await assignedPersonaFixture();
      if (mode === "absent") vi.mocked(f.client.assignmentRoster).mockResolvedValue([]);
      else if (mode === "fenced") vi.mocked(f.client.userSnapshot).mockResolvedValue({ ...f.snapshot, runtimeMutationFenced: true });
      else if (mode === "unknown") vi.mocked(f.client.userSnapshot).mockResolvedValue({ ...f.snapshot, runtimeMutationFenced: undefined });
      else vi.mocked(f.rpc.agentsCreate).mockImplementation(async params => {
        const result = await f.nativeWrite(params);
        if (mode === "epoch") vi.mocked(f.client.assignmentRoster).mockResolvedValue([{ uid: f.snapshot.uid, state: "serving", epoch: 5 }]);
        if (mode === "pod") vi.stubEnv("POD_UID", "successor-pod");
        if (mode === "successor") { const manifest = await realReadActivationManifest(testRuntime.dir, "tester10"); await writeActivationManifest(testRuntime.dir, { ...manifest, appliedFingerprint: "successor" }); }
        return result;
      });
      await expect(f.mount()).rejects.toThrow(/authority|capture changed|unfenced serving/);
      expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
      expect(routingActivationMocks.activateAfterPatch).not.toHaveBeenCalled();
      if (mode === "absent" || mode === "fenced" || mode === "unknown") expect(f.rpc.agentsCreate).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux").each(["uid", "gatewayId", "podUid", "assignmentEpoch"] as const)("refuses foreign retained %s before intact-roster cleanup", async key => {
    try {
      const f = await assignedPersonaFixture();
      const binding = { uid: f.snapshot.uid, gatewayId: "shared-source", podUid: "source-pod", assignmentEpoch: 4 };
      const capture = await captureTargetWorkspaceIdentities("tester10", [f.projectId], testRuntime.dir, binding);
      const changed = { ...capture, [key]: key === "assignmentEpoch" ? 5 : "foreign" };
      await writeActivationManifest(testRuntime.dir, { ...f.manifest, targetWorkspaceIdentities: changed });
      vi.mocked(f.rpc.configGet).mockImplementation(async () => assignedPersonaRoster(f, [f.userDefaultAgentId, f.projectId]));
      await expect(f.mount()).rejects.toThrow("custody changed");
      expect(f.rpc.agentsCreate).not.toHaveBeenCalled(); expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
      expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux")("refuses Shared migration activation without a target identity witness before Native effects", async () => {
    try {
      const f = await sourcePersonaFixture();
      await expect(f.adapter.activateImportedUser("tester10", { migrationId: f.binding.migrationId })).rejects.toThrow("original workspace identity witness");
      expect(f.rpc.agentsCreate).not.toHaveBeenCalled();
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
      for (const [dir, bytes] of f.originals) expect(await fs.readFile(path.join(dir, "IDENTITY.md"))).toEqual(bytes);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([false, true])("reads source anchors only while assignment custody stays current (changed=%s)", async (changed) => {
    vi.stubEnv("GATEWAY_ID", "user-source"); vi.stubEnv("POD_UID", "source-pod");
    try {
      let epoch = 4;
      const anchors = ["octogee-tester10-coach", "octogee-tester10-proj-first-coach", "octogee-tester10-proj-second-coach"].map((agentId, index) => ({ agentId, storeId: `source-store-${index}`, schema: `source_schema_${index}` }));
      const readAgentAnchors = vi.fn(async () => {
        if (changed) epoch++;
        return { anchors: [...anchors, { agentId: "octogee-unmatched-route", storeId: "service-store", schema: "service_schema" }] };
      });
      const client = mkClient({ userSnapshot: vi.fn(async () => ({ uid: "uid-tester10", slug: "tester10", gatewayId: "user-source", status: "complete" }) as FleetBrokerUserSnapshot),
        assignmentRoster: vi.fn(async () => [{ uid: "uid-tester10", state: "quiescing", epoch }]), readAgentAnchors });
      const adapter = buildBrokeredLifecycleAdapter({ client, rpc: mkGatewayRpc(), log: vi.fn() });
      const result = adapter.sourceMigrationAgentAnchors!("tester10", "migration-source");
      if (changed) await expect(result).rejects.toThrow("custody changed");
      else await expect(result).resolves.toEqual(anchors);
      expect(readAgentAnchors).toHaveBeenCalledExactlyOnceWith({ slug: "tester10", uid: "uid-tester10", migrationId: "migration-source" });
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["current", "missing-migration", "serving", "changed-epoch"].flatMap(mode => [[mode, false], [mode, true]] as const))("reads explicit target migration authority without an assigned-owner fallback: %s (user=%s)", async (mode, user) => {
    vi.stubEnv("GATEWAY_ID", "shared-target"); vi.stubEnv("POD_UID", "target-pod");
    try {
      const readAgentAnchors = vi.fn(async () => ({ anchors: [], assignment: { uid: "uid-tester10", epoch: mode === "changed-epoch" ? 5 : 4, state: mode === "serving" ? "serving" : "quiescing" },
        ...(mode === "missing-migration" ? {} : { migration: { migrationId: "mig-target", sourceGatewayId: "user-source", sourceEpoch: 4, claimStartedAt: 123 } }) }));
      const client = mkClient({ uidForSlug: vi.fn(async () => { throw new Error("must not use assigned-owner shortcut"); }), readAgentAnchors: readAgentAnchors as never });
      const adapter = buildBrokeredLifecycleAdapter({ client, rpc: mkGatewayRpc(), log: vi.fn(), isIsolatedGateway: () => user });
      const proof = adapter.targetMigrationIdentityCustody!("tester10", "mig-target");
      if (mode === "current") await expect(proof).resolves.toMatchObject({ custody: { uid: "uid-tester10", gatewayId: "shared-target", podUid: "target-pod", migrationId: "mig-target" } });
      else await expect(proof).rejects.toThrow("authority changed");
      expect(readAgentAnchors).toHaveBeenCalledExactlyOnceWith({ slug: "tester10", migrationId: "mig-target" });
      expect(client.uidForSlug).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux")("preserves exact authored agent and project persona before rollback routing resumes", async () => {
    try {
      const fixture = await sourcePersonaFixture();
      await fixture.adapter.resumeUser("tester10", { migrationId: fixture.binding.migrationId });
      expect(fixture.rpc.channelsStart).toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux")("retains the original capture across a late Native writer, duplicate retry and repeated source resume", async () => {
    try {
      const f = await sourcePersonaFixture();
      let completeLateWrite!: () => Promise<void>;
      let timedOut = false;
      const registered = new Set<string>();
      vi.mocked(f.rpc.agentsCreate).mockImplementation(async params => {
        if (registered.has(params.name)) throw new OpenclawWireError("rpc-error", `agent "${params.name}" already exists`);
        if (params.name === f.projectId && !timedOut) {
          timedOut = true;
          completeLateWrite = async () => { await f.nativeWrite(params); registered.add(params.name); };
          throw new OpenclawWireError("rpc-error", "first create client timed out; Native owns its in-flight write");
        }
        const result = await f.nativeWrite(params); registered.add(params.name); return result;
      });
      await expect(f.adapter.resumeUser("tester10", { migrationId: f.binding.migrationId })).rejects.toThrow("first create client timed out");
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
      expect(f.rpc.channelsStart).not.toHaveBeenCalled();
      expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
      expect((await realReadActivationManifest(testRuntime.dir, "tester10")).sourceWorkspaceIdentities).toEqual(f.manifest.sourceWorkspaceIdentities);
      await completeLateWrite();
      expect(await fs.readFile(path.join(f.project, "IDENTITY.md"))).not.toEqual(f.originals.get(f.project));
      await f.adapter.resumeUser("tester10", { migrationId: f.binding.migrationId });
      await f.adapter.resumeUser("tester10", { migrationId: f.binding.migrationId });
      expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledTimes(2);
      for (const [dir, bytes] of f.originals) expect(await fs.readFile(path.join(dir, "IDENTITY.md"))).toEqual(bytes);
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux").each(["migrationId", "uid", "gatewayId", "podUid", "epoch"] as const)("refuses a foreign retained source %s before Native registration", async key => {
    try {
      const f = await sourcePersonaFixture();
      const changed = { ...f.manifest, sourceWorkspaceIdentities: { ...f.manifest.sourceWorkspaceIdentities!, [key]: key === "epoch" ? 5 : "foreign" } };
      await writeActivationManifest(testRuntime.dir, changed);
      await expect(f.adapter.resumeUser("tester10", { migrationId: f.binding.migrationId })).rejects.toThrow("custody changed");
      expect(f.rpc.agentsCreate).not.toHaveBeenCalled(); expect(f.rpc.channelsStart).not.toHaveBeenCalled();
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux")("retains the capture and stays stopped when source authority changes during registration", async () => {
    try {
      const f = await sourcePersonaFixture();
      vi.mocked(f.rpc.agentsCreate).mockImplementation(async params => {
        const result = await f.nativeWrite(params);
        vi.mocked(f.client.assignmentRoster).mockResolvedValue([{ uid: f.binding.uid, state: "quiescing", epoch: 5 }]);
        return result;
      });
      await expect(f.adapter.resumeUser("tester10", { migrationId: f.binding.migrationId })).rejects.toThrow("custody changed");
      expect(f.rpc.channelsStart).not.toHaveBeenCalled(); expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
      expect((await realReadActivationManifest(testRuntime.dir, "tester10")).sourceWorkspaceIdentities).toEqual(f.manifest.sourceWorkspaceIdentities);
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux")("refuses a retained project workspace redirected to the agent before Native registration", async () => {
    try {
      const f = await sourcePersonaFixture();
      f.manifest.projectAgents[0].agent.workspace = f.workspace;
      await writeActivationManifest(testRuntime.dir, f.manifest);
      await expect(f.adapter.resumeUser("tester10", { migrationId: f.binding.migrationId })).rejects.toThrow("not canonical");
      expect(f.rpc.agentsCreate).not.toHaveBeenCalled(); expect(f.rpc.channelsStart).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux").each(["intact", "absent", "workspace", "agentDir"] as const)("requires exact no-detach source roster proof without invoking creation: %s", async mode => {
    try {
      const f = await sourcePersonaFixture();
      const noCapture = { ...f.manifest }; delete noCapture.sourceWorkspaceIdentities;
      noCapture.projectAgents[0].agent.agentDir = path.join(testRuntime.dir, "agents", f.projectId, "agent");
      await writeActivationManifest(testRuntime.dir, noCapture);
      const entries = Object.fromEntries([noCapture, ...noCapture.projectAgents].map(row => [row.agentId, { ...row.agent }]));
      if (mode === "absent") delete entries[f.projectId];
      else if (mode === "workspace") entries[f.projectId].workspace = f.workspace;
      else if (mode === "agentDir") entries[f.projectId].agentDir = "/foreign/agent";
      vi.mocked(f.rpc.configGet).mockResolvedValue(configSnapshot({ agents: { entries }, channels: { mattermost: { accounts: { "tester10-coach": {} } } } }));
      const resumed = f.adapter.resumeUser("tester10", { migrationId: f.binding.migrationId });
      if (mode === "intact") { await resumed; expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce(); expect(f.rpc.channelsStart).toHaveBeenCalled(); }
      else { await expect(resumed).rejects.toThrow("intact Native roster"); expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled(); expect(f.rpc.channelsStart).not.toHaveBeenCalled(); }
      expect(f.rpc.agentsCreate).not.toHaveBeenCalled();
      for (const [dir, bytes] of f.originals) expect(await fs.readFile(path.join(dir, "IDENTITY.md"))).toEqual(bytes);
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux")("rejects a same-epoch successor manifest published while Native registration was awaited", async () => {
    try {
      const f = await sourcePersonaFixture(0);
      const successorBytes = Buffer.from("# New g2 persona\n- Name: G2 author\n");
      const successor = structuredClone(f.manifest);
      successor.sourceWorkspaceIdentities!.migrationId = "migration-source-persona-g2";
      Object.assign(successor.sourceWorkspaceIdentities!.files.find(file => file.agentId === f.projectId)!, { content: successorBytes.toString("base64"), sha256: createHash("sha256").update(successorBytes).digest("hex") });
      vi.mocked(f.rpc.agentsCreate).mockImplementation(async params => {
        const result = await f.nativeWrite(params);
        if (params.name === f.projectId) { await fs.writeFile(path.join(f.project, "IDENTITY.md"), successorBytes); await writeActivationManifest(testRuntime.dir, successor); }
        return result;
      });
      await expect(f.adapter.resumeUser("tester10", { migrationId: f.binding.migrationId })).rejects.toThrow("manifest changed");
      expect(await fs.readFile(path.join(f.project, "IDENTITY.md"))).toEqual(successorBytes);
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled(); expect(f.rpc.channelsStart).not.toHaveBeenCalled();
      vi.mocked(f.rpc.agentsCreate).mockClear();
      await expect(f.adapter.resumeUser("tester10", { migrationId: f.binding.migrationId })).rejects.toThrow("custody changed");
      expect(f.rpc.agentsCreate).not.toHaveBeenCalled();
      expect((await realReadActivationManifest(testRuntime.dir, "tester10")).sourceWorkspaceIdentities).toEqual(successor.sourceWorkspaceIdentities);
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(process.platform !== "linux")("rechecks the manifest before activation when persona restoration is a no-op", async () => {
    try {
      const f = await sourcePersonaFixture(0);
      vi.mocked(f.rpc.agentsCreate).mockImplementation(async params => ({ ok: true, agentId: params.name, name: params.name, workspace: params.workspace }));
      routingActivationMocks.capture.mockImplementationOnce(async () => {
        const successor = structuredClone(f.manifest); successor.sourceWorkspaceIdentities!.migrationId = "migration-source-persona-g2";
        await writeActivationManifest(testRuntime.dir, successor); return {};
      });
      await expect(f.adapter.resumeUser("tester10", { migrationId: f.binding.migrationId })).rejects.toThrow("manifest changed");
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled(); expect(f.rpc.channelsStart).not.toHaveBeenCalled();
      for (const [dir, bytes] of f.originals) expect(await fs.readFile(path.join(dir, "IDENTITY.md"))).toEqual(bytes);
    } finally { vi.unstubAllEnvs(); }
  });

  it("refuses a detached source without an original identity capture before Native creation", async () => {
    vi.stubEnv("GATEWAY_ID", "shared-source"); vi.stubEnv("POD_UID", "source-pod");
    try {
      const rpc = mkGatewayRpc({ configGet: vi.fn(async () => configSnapshot({ agents: { entries: {} } })) });
      const client = mkClient({ userSnapshot: vi.fn(async () => ({ uid: "uid-tester10", slug: "tester10", gatewayId: "shared-source", status: "complete" }) as FleetBrokerUserSnapshot),
        assignmentRoster: vi.fn(async () => [{ uid: "uid-tester10", state: "quiescing", epoch: 0 }]) });
      const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
      await expect(adapter.resumeUser("tester10", { migrationId: "mig-old" })).rejects.toThrow("intact Native roster");
      expect(rpc.agentsCreate).not.toHaveBeenCalled(); expect(rpc.channelsStart).not.toHaveBeenCalled();
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled(); expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it("activates imported standard-gateway state from the transferred activation manifest", async () => {
    const client = mkClient();
    const rpc = {
      gatewayRestartRequest: vi.fn(async () => ({ status: "requested" })),
      isGatewayUp: vi.fn(async () => true),
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({
        agents: { list: [{ id: "octogee-tester10-coach", model: "house" }] },
      })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc,
      log: vi.fn(),
    });
    const signal = new AbortController().signal;

    await expect(adapter.activateImportedUser("tester10", { signal })).resolves.toEqual({
      appliedFingerprint: "fp-tester10",
    });

    expect(mocks.readActivationManifest).toHaveBeenCalledWith(
      testRuntime.dir,
      "tester10",
    );
    expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "tester10", appliedFingerprint: "fp-tester10" }),
      expect.objectContaining({ rpc, signal }),
    );
    expect(mocks.applyOpenClawActivationManifest.mock.calls[0]?.[1]).not.toHaveProperty(
      "ownerCommandsPatch",
    );
    expect(gitMocks.setRepoSshCommand).toHaveBeenCalledWith(
      expect.stringContaining("/customers/tester10"),
      "tester10",
    );
    expect(gitMocks.setRepoSshCommand.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyOpenClawActivationManifest.mock.invocationCallOrder[0]!,
    );
    expect(mocks.removeActivationManifest).toHaveBeenCalledWith(
      testRuntime.dir,
      "tester10",
    );
    expect(routingActivationMocks.activate).toHaveBeenCalledWith(
      rpc,
      testRuntime.dir,
      expect.any(Function),
      { restartAccountIds: [], restartConfiguredPending: true },
    );
    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    expect(rpc.secretsReload.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeActivationManifest.mock.invocationCallOrder[0]!,
    );
    expect(client.uidForSlug).not.toHaveBeenCalled();
  });

  it("commits activation without waiting for the agent account to connect, leaving that check to verify-target", async () => {
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: false, connected: false }] },
      })),
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.activateImportedUser("tester10")).resolves.toEqual({ appliedFingerprint: "fp-tester10" });
    expect(rpc.channelsStatus).not.toHaveBeenCalled();
  }, 5_000);

  it("refuses import publication when the target identity callback denies", async () => {
    const rpc = {
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const beforeRuntimePublish = vi.fn(async () => { throw new Error("target identity authority changed"); });

    await expect(adapter.activateImportedUser("tester10", { beforeRuntimePublish })).rejects.toThrow("target identity authority changed");
    expect(beforeRuntimePublish).toHaveBeenCalledOnce();
    expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
  });

  it.each(["current", "missing-assignment", "moved-user", "inactive-assignment", "missing-pod"])("requires the exact canonical source custody: %s", async (mode) => {
    vi.stubEnv("GATEWAY_ID", "shared-source"); vi.stubEnv("POD_UID", mode === "missing-pod" ? "" : "source-pod");
    try {
      const client = mkClient({
        uidForSlug: vi.fn(async () => "uid-alice"),
        userSnapshot: vi.fn(async () => aliceSnapshot({ status: "complete", gatewayId: mode === "moved-user" ? "shared-other" : "shared-source" })),
        assignmentRoster: vi.fn(async () => mode === "missing-assignment" ? []
          : [{ uid: "uid-alice", state: mode === "inactive-assignment" ? "migrating" : "quiescing", epoch: 0 }]),
      });
      const adapter = buildBrokeredLifecycleAdapter({ client, rpc: mkGatewayRpc(), log: vi.fn() });

      const custody = adapter.sourceMigrationIdentityCustody!("alice", "migration-alice");

      if (mode === "current") await expect(custody).resolves.toEqual({ migrationId: "migration-alice", uid: "uid-alice", gatewayId: "shared-source", podUid: "source-pod", epoch: 0 });
      else await expect(custody).rejects.toThrow(/custody|assigned user/);
    } finally { vi.unstubAllEnvs(); }
  });

  describe("import secrets.reload gate", () => {
    const importedConfig = {
      agents: { list: [{ id: "octogee-tester10-coach", model: "house" }] },
      channels: { mattermost: { accounts: {
        "tester10-coach": { botToken: { source: "file", provider: "octogee-mattermost", id: "/tester10-coach" } },
      } } },
    };

    function importRpc(config: unknown = importedConfig) {
      return {
        gatewayRestartRequest: vi.fn(async () => ({ status: "requested" })),
        isGatewayUp: vi.fn(async () => true),
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
          },
        })),
        configGet: vi.fn(async () => configSnapshot(config)),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      };
    }

    function unchangedImportInputs() {
      secretMocks.materializeActivationManifestSecret.mockImplementationOnce(
        async (_dir: string, manifest: unknown) => ({ manifest, secretsChanged: false }),
      );
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: [] });
      mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
        elapsedMs: 42,
        routingActivationRequired: false,
        restartExistingAccountIds: [],
        configNoop: true,
      });
    }

    it("skips secrets.reload when a re-import changes no secret material on a shared gateway", async () => {
      unchangedImportInputs();
      const rpc = importRpc();
      const log = vi.fn();
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log, isIsolatedGateway: () => false,
      });

      await expect(adapter.activateImportedUser("tester10")).resolves.toEqual({
        appliedFingerprint: "fp-tester10",
      });

      expect(rpc.secretsReload).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[import:tester10] secrets.reload skipped — no secret material changed");
      expect(mocks.removeActivationManifest).toHaveBeenCalledOnce();
    });

    it("reloads when the transferred Mattermost tokens landed in the secrets file", async () => {
      secretMocks.materializeActivationManifestSecret.mockImplementationOnce(
        async (_dir: string, manifest: unknown) => ({ manifest, secretsChanged: true }),
      );
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: [] });
      mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
        elapsedMs: 42, routingActivationRequired: false, restartExistingAccountIds: [], configNoop: true,
      });
      const rpc = importRpc();
      const log = vi.fn();
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log, isIsolatedGateway: () => false,
      });

      await adapter.activateImportedUser("tester10");

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("[import:tester10] secrets.reload — Mattermost account secrets file changed");
    });

    it("reloads when the activation patch committed config — it carries the imported SecretRefs", async () => {
      secretMocks.materializeActivationManifestSecret.mockImplementationOnce(
        async (_dir: string, manifest: unknown) => ({ manifest, secretsChanged: false }),
      );
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: [] });
      mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
        elapsedMs: 42, routingActivationRequired: false, restartExistingAccountIds: [], configNoop: false,
      });
      const rpc = importRpc();
      const log = vi.fn();
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log, isIsolatedGateway: () => false,
      });

      await adapter.activateImportedUser("tester10");

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        "[import:tester10] secrets.reload — activation config patch changed the config",
      );
    });

    it("reloads when a user import restored the subscription store", async () => {
      unchangedImportInputs();
      modelCredentialMocks.restoreModelCredentialOauthStoreForSlug.mockResolvedValueOnce({
        restored: true, present: true, providers: ["openai"],
      });
      const rpc = importRpc();
      const log = vi.fn();
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(), rpc: rpc as unknown as GatewayRpcClient, log, isIsolatedGateway: () => true,
      });

      await adapter.activateImportedUser("tester10");

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("[import:tester10] secrets.reload — model credential OAuth store restored");
    });
  });

  it("keeps a committed activation when the reload outlasts a post-commit step", async () => {
    const log = vi.fn();
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] },
      })),
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => {
        throw new OpenclawWireError("timeout", "connect response timed out after 30000ms");
      }),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log });

    await expect(adapter.activateImportedUser("tester10")).resolves.toMatchObject({
      appliedFingerprint: expect.any(String),
      verificationPending: expect.stringContaining("connect response timed out"),
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("activation committed; verification incomplete"),
    );
  });

  it("re-reads the applied revision and reloads once more when a newer config write supersedes secrets.reload", async () => {
    const log = vi.fn();
    const superseded = new OpenclawWireError("rpc-error", "secrets.reload failed", { serverCode: "UNAVAILABLE" });
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] },
      })),
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn()
        .mockRejectedValueOnce(superseded)
        .mockResolvedValueOnce({ ok: true, warningCount: 0 }),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log });

    const activation = await adapter.activateImportedUser("tester10");

    expect(activation.verificationPending).toBeUndefined();
    expect(rpc.secretsReload).toHaveBeenCalledTimes(2);
    const configReads = vi.mocked(rpc.configGet).mock.invocationCallOrder;
    const reloads = vi.mocked(rpc.secretsReload).mock.invocationCallOrder;
    expect(configReads.some((order) => order > reloads[0] && order < reloads[1])).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[import:tester10] secrets.reload complete"));
  });

  it("names the config write that preceded a secrets.reload superseded twice", async () => {
    const superseded = new OpenclawWireError("rpc-error", "secrets.reload failed", { serverCode: "UNAVAILABLE" });
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] },
      })),
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn().mockRejectedValue(superseded),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    const activation = await adapter.activateImportedUser("tester10");

    expect(rpc.secretsReload).toHaveBeenCalledTimes(2);
    expect(activation.verificationPending).toMatch(
      /secrets\.reload was refused twice after: .*activation config patch changed the config/,
    );
  });

  it("does not retry a secrets.reload that failed for a reason other than gateway unavailability", async () => {
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] },
      })),
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn().mockRejectedValue(
        new OpenclawWireError("rpc-error", "invalid secrets.reload params", { serverCode: "INVALID_REQUEST" }),
      ),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    const activation = await adapter.activateImportedUser("tester10");

    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    expect(activation.verificationPending).toBe("invalid secrets.reload params");
  });

  it("fails a committed activation when the migration itself was cancelled", async () => {
    const controller = new AbortController();
    const cancelled = new Error("migration cancelled");
    const rpc = {
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
      configGet: vi.fn(async () => configSnapshot({ agents: { list: [] } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => {
        controller.abort(cancelled);
        throw cancelled;
      }),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.activateImportedUser("tester10", { signal: controller.signal }),
    ).rejects.toBe(cancelled);
  });

  it("waits for the imported config to apply before reloading its secret runtime", async () => {
    const configGet = vi.fn()
      .mockResolvedValueOnce(configSnapshot({ agents: { list: [] } }))
      .mockResolvedValueOnce({
        ...configSnapshot({ agents: { list: [] } }),
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-old",
      })
      .mockResolvedValueOnce({
        ...configSnapshot({ agents: { list: [] } }),
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-new",
      })
      .mockResolvedValue(configSnapshot({ agents: { list: [] } }));
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet,
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.activateImportedUser("tester10");

    expect(configGet).toHaveBeenCalledTimes(3);
    expect(configGet.mock.invocationCallOrder[2]).toBeLessThan(
      rpc.secretsReload.mock.invocationCallOrder[0]!,
    );
    expect(rpc.secretsReload.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeActivationManifest.mock.invocationCallOrder[0]!,
    );
  });

  it("rides out a reload that refuses connections while waiting for the applied config", async () => {
    const configGet = vi.fn()
      .mockRejectedValueOnce(new OpenclawWireError("timeout", "connect response timed out after 30000ms"))
      .mockResolvedValueOnce({
        ...configSnapshot({}),
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-old",
      })
      .mockRejectedValueOnce(new OpenclawWireError("timeout", "connect response timed out after 30000ms"))
      .mockResolvedValue({
        ...configSnapshot({}),
        configRevisionHash: "revision-new",
        appliedConfigHash: "revision-new",
      });
    const rpc = { configGet } as unknown as Pick<GatewayRpcClient, "configGet">;

    await expect(
      waitForAppliedConfigRevision(rpc, "tester10", { pollIntervalMs: 0 }),
    ).resolves.toBeUndefined();
    expect(configGet).toHaveBeenCalledTimes(4);
  });

  it("fails the import wait when the runtime never applies the persisted config", async () => {
    const rpc = {
      configGet: vi.fn(async () => ({
        ...configSnapshot({}),
        configRevisionHash: "revision-new",
        appliedConfigHash: null,
      })),
    } as Pick<GatewayRpcClient, "configGet">;

    await expect(
      waitForAppliedConfigRevision(rpc, "tester10", { timeoutMs: 0 }),
    ).rejects.toThrow(
      /active config did not reach revision revision-new within 0ms \(applied=none\)/,
    );
  });

  it("stops the import wait when the migration is cancelled", async () => {
    const controller = new AbortController();
    const cancelled = new Error("migration cancelled");
    const rpc = {
      configGet: vi.fn(async () => {
        controller.abort(cancelled);
        return {
          ...configSnapshot({}),
          configRevisionHash: "revision-new",
          appliedConfigHash: "revision-old",
        };
      }),
    } as Pick<GatewayRpcClient, "configGet">;

    await expect(
      waitForAppliedConfigRevision(rpc, "tester10", { signal: controller.signal }),
    ).rejects.toBe(cancelled);
    expect(rpc.configGet).toHaveBeenCalledTimes(1);
  });

  it("settles a rostered agent's wait once the runtime applies a sibling lane's later revision", async () => {
    const rpc = {
      configGet: vi.fn()
        .mockResolvedValueOnce({
          ...configSnapshot({}), configRevisionHash: "revision-alice", appliedConfigHash: "revision-before",
        })
        .mockResolvedValueOnce({
          ...configSnapshot({}), configRevisionHash: "revision-bob", appliedConfigHash: "revision-alice",
        })
        .mockResolvedValueOnce({
          ...configSnapshot({}), configRevisionHash: "revision-bob", appliedConfigHash: "revision-bob",
        }),
    } as Pick<GatewayRpcClient, "configGet">;

    await expect(waitForAppliedConfigRevision(rpc, "alice", {
      pollIntervalMs: 0,
      acceptSupersedingRevision: true,
    })).resolves.toBeUndefined();
    expect(rpc.configGet).toHaveBeenCalledTimes(3);
  });

  it("rejects an import wait when another config revision supersedes the import", async () => {
    const rpc = {
      configGet: vi.fn()
        .mockResolvedValueOnce({
          ...configSnapshot({}),
          configRevisionHash: "revision-import",
          appliedConfigHash: "revision-before-import",
        })
        .mockResolvedValueOnce({
          ...configSnapshot({}),
          configRevisionHash: "revision-other",
          appliedConfigHash: "revision-other",
        }),
    } as Pick<GatewayRpcClient, "configGet">;

    await expect(
      waitForAppliedConfigRevision(rpc, "tester10", { pollIntervalMs: 0 }),
    ).rejects.toThrow(
      /config revision changed while waiting \(expected=revision-import, observed=revision-other\)/,
    );
  });

  it("detaches superseded PostgreSQL entries during an import without purging their stores", async () => {
    const config = { agents: { entries: keyedRoster(["octogee-tester10-coach", "octogee-tester10-proj-surplus-coach", "octogee-bob-coach"]) } };
    await withPostgresAgentConfig(config, async () => {
      const agentsDetach = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId }));
      const rpc = mkGatewayRpc({ ...rosterRpc(config), agentsDetach,
        channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: "tester10-coach", running: true, connected: true }] } })),
      });
      tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-anchor-import-detach-"));
      process.env.OPENCLAW_STATE_DIR = tempStateDir;
      const defaultAgent = { agentId: "octogee-tester10-coach", storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_agent_92c817cc770f466d" };
      anchorQuery.mockImplementation(async (_target, sql) => sql.includes("openclaw_schema_meta") ? [{ store_id: defaultAgent.storeId }] : [{ agent_id: defaultAgent.agentId }]);
      const client = mkClient({
        readAgentAnchors: vi.fn(async () => ({ anchors: [defaultAgent], assignment: { uid: "uid-tester10", epoch: 0, state: "serving" } })),
        reportAgentAnchors: vi.fn(async () => undefined),
      });
      const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
      await adapter.activateImportedUser("tester10");
      expect(agentsDetach).toHaveBeenCalledExactlyOnceWith({ agentId: "octogee-tester10-proj-surplus-coach" });
      expect(rpc.agentsDelete).not.toHaveBeenCalled();
    });
  });

  it("waits through a cold user control handshake before changing its roster", async () => {
    stubUserClaim("tester10");
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const rpc = mkGatewayRpc({
        channelsStatus: vi.fn(async () => ({ channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        } })),
        configGet: vi.fn()
        .mockImplementationOnce(async () => {
          now += 30_000;
          throw new OpenclawWireError("connect-failed", "socket closed before connect response");
        })
        .mockResolvedValue(configSnapshot({ agents: { list: [] } })) });
      const log = vi.fn();
      const adapter = buildBrokeredLifecycleAdapter({ client: configuredUserClient(), rpc, log });
      await expect(adapter.activateImportedUser("tester10")).resolves.toMatchObject({ appliedFingerprint: expect.any(String) });
      expect(vi.mocked(rpc.configGet).mock.invocationCallOrder[1]).toBeLessThan(vi.mocked(rpc.agentsCreate).mock.invocationCallOrder[0]);
      expect(log).toHaveBeenCalledWith("[import:tester10] User control runtime is ready for roster activation in 30000ms");
    } finally {
      clock.mockRestore();
      clearUserClaim();
    }
  });

  it.each([false, true])("keeps Native's imported roster while disabling the pre-cutover isolated runtime (retry=%s)", async retry => {
    stubUserClaim("tester10");
    const repo = path.join(testRuntime.dir, "system_config");
    const agentIds = ["octogee-tester10-coach", "octogee-tester10-proj-orbit-coach"];
    const accepted = { agents: { entries: keyedRoster([SAFE_DEFAULT_AGENT_ID]) } };
    let current = {
      ...accepted,
      agents: { entries: { ...keyedRoster([SAFE_DEFAULT_AGENT_ID]), ...(retry
        ? Object.fromEntries(agentIds.map(id => [id, { model: "native-model" }])) : {}) } },
      cron: { enabled: true, maxConcurrentRuns: 3 },
      channels: { mattermost: { enabled: true, baseUrl: "https://chat.example.invalid", accounts: {
        "tester10-coach": { enabled: false }, "tester10-proj-orbit": { enabled: false },
      } } },
    };
    let revision = 0;
    const persist = (next: typeof current, hash: string) => {
      expect(hash).toBe(`cfg-${revision}`);
      const dropped = Object.keys(current.agents.entries).filter(id => !(id in next.agents.entries));
      if (dropped.length) throw new Error(`Config write would drop agent roster entries without an explicit deletion: ${dropped.join(", ")}.`);
      current = structuredClone(next);
      revision++;
      return { ok: true as const };
    };
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => ({ ...configSnapshot(structuredClone(current)), hash: `cfg-${revision}` })),
      configApply: vi.fn(async (config, hash) => persist(config as typeof current, hash)),
      configPatch: vi.fn(async (patch, hash) => persist(mergePatch(current, patch) as typeof current, hash)),
      agentsCreate: vi.fn(async ({ name, workspace }) => {
        if (name in current.agents.entries) throw new OpenclawWireError("rpc-error", `agent "${name}" already exists`);
        current.agents.entries[name] = { workspace, model: "native-model" };
        revision++;
        return { ok: true as const, agentId: name, name, workspace };
      }),
    });
    mocks.readActivationManifest.mockResolvedValue({
      slug: "tester10", appliedFingerprint: "fp-tester10", agentId: agentIds[0],
      agent: { id: agentIds[0], workspace: path.join(testRuntime.dir, "customers/tester10") },
      projectAgents: [{ agentId: agentIds[1], accountId: "tester10-proj-orbit", agent: {
        id: agentIds[1], workspace: path.join(testRuntime.dir, "customers/tester10/projects/orbit"),
      } }],
    });
    patchMocks.applyConfigPatch.mockImplementationOnce(realApplyConfigPatch);
    const adapter = buildBrokeredLifecycleAdapter({ client: configuredUserClient(), rpc, log: vi.fn(), isIsolatedGateway: () => true });
    try {
      await fs.mkdir(repo, { recursive: true });
      await fs.writeFile(path.join(repo, "openclaw.json"), JSON.stringify(accepted));
      execFileSync("git", ["init", "-b", "main"], { cwd: repo });
      execFileSync("git", ["add", "openclaw.json"], { cwd: repo });
      execFileSync("git", ["-c", "user.name=Synthetic Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"], { cwd: repo });
      await expect(adapter.activateImportedUser("tester10", { deferRuntimeVerification: true })).resolves.toEqual({ appliedFingerprint: "fp-tester10" });
      expect(Object.keys(current.agents.entries)).toEqual([SAFE_DEFAULT_AGENT_ID, ...agentIds]);
      for (const id of agentIds) expect(current.agents.entries[id]).toEqual(expect.objectContaining({ model: "native-model" }));
      expect(current.cron).toEqual({ enabled: false, maxConcurrentRuns: 3 });
      expect(current.channels.mattermost).toEqual({ enabled: false, baseUrl: "https://chat.example.invalid", accounts: {
        "tester10-coach": { enabled: false }, "tester10-proj-orbit": { enabled: false },
      } });
      expect(rpc.channelsStart).not.toHaveBeenCalled();
      expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
    } finally {
      patchMocks.applyConfigPatch.mockReset().mockResolvedValue({ mode: "rpc", attempts: 1 });
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it.each(["connect-failed", "timeout"] as const)("exhausts cold user admission without roster changes for %s", async (code) => {
    stubUserClaim("tester10");
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const rpc = mkGatewayRpc({ configGet: vi.fn(async () => {
        now += 600_001;
        throw new OpenclawWireError(code, "cold control runtime unavailable");
      }) });
      const adapter = buildBrokeredLifecycleAdapter({ client: configuredUserClient(), rpc, log: vi.fn() });
      await expect(adapter.activateImportedUser("tester10")).rejects.toThrow(/config revision was unreadable for 600000ms/);
      expect(rpc.agentsCreate).not.toHaveBeenCalled();
      expect(rpc.agentsDelete).not.toHaveBeenCalled();
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
      expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      clearUserClaim();
    }
  });

  it.each(["auth-failed", "invalid-response", "rpc-error"] as const)("fails runtime admission immediately for %s", async (code) => {
    const failure = new OpenclawWireError(code, "strict runtime admission failure");
    const rpc = { configGet: vi.fn().mockRejectedValue(failure) };
    await expect(waitForAppliedConfigRevision(rpc, "tester10", { timeoutMs: 0 })).rejects.toBe(failure);
    expect(rpc.configGet).toHaveBeenCalledTimes(1);
  });

  it("does not admit a valid config response after the import is cancelled", async () => {
    const controller = new AbortController(), cancelled = new Error("migration cancelled");
    const rpc = { configGet: vi.fn(async () => { controller.abort(cancelled); return configSnapshot({}); }) };
    await expect(waitForAppliedConfigRevision(rpc, "tester10", { signal: controller.signal })).rejects.toBe(cancelled);
  });

  it("anchors inherited auth to the neutral agent for the configured user", async () => {
    stubUserClaim("tester10");
    try {
      const rpc = {
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
          },
        })),
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({ client: configuredUserClient(), rpc, log: vi.fn() });

      await adapter.activateImportedUser("tester10", {});

      expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          authInheritanceAnchor: {
            agentId: SAFE_DEFAULT_AGENT_ID,
            agent: expect.objectContaining({ id: SAFE_DEFAULT_AGENT_ID }),
          },
        }),
      );
    } finally {
      clearUserClaim();
    }
  });

  it("anchors a gateway VM's activation to the neutral agent with its desktop tools denied", async () => {
    stubUserClaim("tester10");
    vi.stubEnv("GATEWAY_CLASS", "isolated");
    vi.stubEnv("GATEWAY_RUNTIME_KIND", "gce-vm");
    try {
      const rpc = {
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
          },
        })),
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({ client: configuredUserClient(), rpc, log: vi.fn() });

      await adapter.activateImportedUser("tester10", {});

      const [, options] = mocks.applyOpenClawActivationManifest.mock.calls.at(-1)!;
      expect(options.authInheritanceAnchor.agent.tools.deny).toEqual(
        expect.arrayContaining(["browser", "computer", "nodes", "file-transfer", "ollama"]),
      );
    } finally {
      clearUserClaim();
    }
  });

  it("grants the configured user owner authority in its import activation patch", async () => {
    stubUserClaim("tester10");
    try {
      const rpc = {
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
          },
        })),
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({ client: configuredUserClient(), rpc, log: vi.fn() });

      await adapter.activateImportedUser("tester10", {});

      const ownerCommandsPatch = mocks.applyOpenClawActivationManifest.mock.calls[0]?.[1]
        ?.ownerCommandsPatch as ((current: unknown) => unknown) | undefined;
      expect(ownerCommandsPatch?.({})).toEqual({ ownerAllowFrom: [`mattermost:${ALICE_OWNER_MM_ID}`] });
      expect(ownerCommandsPatch?.({ commands: { ownerAllowFrom: ["mattermost:other"] } })).toBeUndefined();
    } finally {
      clearUserClaim();
    }
  });

  it("refuses a configured user import activation whose owner Mattermost id is unavailable", async () => {
    stubUserClaim("tester10");
    try {
      const rpc = {
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => null) }), rpc, log: vi.fn() });

      await expect(adapter.activateImportedUser("tester10", {})).rejects.toThrow(
        /owner Mattermost id is unavailable for tester10/,
      );
      expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
    } finally {
      clearUserClaim();
    }
  });

  it("does not add a user auth anchor for another user's user", async () => {
    stubUserClaim("someone-else");
    try {
      const rpc = {
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
          },
        })),
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

      await adapter.activateImportedUser("tester10", {});

      expect(mocks.applyOpenClawActivationManifest.mock.calls[0]?.[1]).not.toHaveProperty(
        "authInheritanceAnchor",
      );
      expect(mocks.applyOpenClawActivationManifest.mock.calls[0]?.[1]).not.toHaveProperty(
        "ownerCommandsPatch",
      );
    } finally {
      clearUserClaim();
    }
  });

  it.each([["info", 2], ["debug", 3]] as const)("keeps activation diagnostics at %s with %i config reads", async (level, reads) => {
    process.env.LOG_LEVEL = level;
    const client = mkClient();
    const log = vi.fn();
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({ agents: { entries: { "octogee-tester10-coach": { model: "test/model" } } } })),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc,
      log,
      projectCheckoutScope: () => "workspace-and-projects",
    });

    await expect(adapter.activateImportedUser("tester10")).resolves.toEqual({
      appliedFingerprint: "fp-tester10",
    });

    expect(rpc.configGet).toHaveBeenCalledTimes(reads);
    if (level === "debug") expect(log).toHaveBeenCalledWith(expect.stringContaining('model="test/model"'));
    expect(client.uidForSlug).not.toHaveBeenCalled();
    expect(client.userSnapshot).not.toHaveBeenCalled();
    expect(gitMocks.cloneProjectRepo).not.toHaveBeenCalled();
    expect(mocks.applyOpenClawActivationManifest).toHaveBeenCalledOnce();
  });

  it("reports pending verification and preserves the manifest when secrets.reload does not acknowledge success", async () => {
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({})),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: false, warningCount: 2 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.activateImportedUser("tester10")).resolves.toMatchObject({
      verificationPending: expect.stringMatching(/secrets\.reload did not acknowledge success/),
    });

    expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
    expect(rpc.channelsStatus).not.toHaveBeenCalled();
    expect(rpc.secretsReload).toHaveBeenCalledOnce();
  });

  it("logs global secret warnings before verifying the current imported account", async () => {
    const events: string[] = [];
    const log = vi.fn((message: string) => events.push(message));
    mocks.applyOpenClawActivationManifest
      .mockImplementationOnce(async (_manifest, options) => {
        options.onRoutingActivationRequired?.(["tester10-coach"]);
        return {
          elapsedMs: 42,
          routingActivationRequired: true,
          restartExistingAccountIds: ["tester10-coach"],
        };
      });
    routingActivationMocks.activate.mockImplementationOnce(async (_rpc, _dir, _log, options) => {
      events.push(options?.restartAccountIds?.join(",") ?? "activate");
      routingActivationMocks.pending = false;
    });
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({})),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 4 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log });

    await expect(adapter.activateImportedUser("tester10")).resolves.toEqual({
      appliedFingerprint: "fp-tester10",
    });

    expect(log).toHaveBeenCalledWith(
      "[import:tester10] secrets.reload complete with 4 warnings",
    );
    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    expect(events.indexOf("[import:tester10] secrets.reload complete with 4 warnings")).toBeLessThan(
      events.indexOf("tester10-coach"),
    );
    expect(routingActivationMocks.activate).toHaveBeenCalledWith(
      rpc,
      testRuntime.dir,
      expect.any(Function),
      { restartAccountIds: ["tester10-coach"], restartConfiguredPending: true },
    );
  });

  it("restarts every still-pending account when replay finds the config already patched", async () => {
    routingActivationMocks.pending = true;
    mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
      elapsedMs: 42,
      routingActivationRequired: false,
      restartExistingAccountIds: [],
    });
    const rpc = {
      channelsStatus: vi.fn(async () => ({
        channelAccounts: {
          mattermost: [{ accountId: "tester10-coach", running: true, connected: true }],
        },
      })),
      configGet: vi.fn(async () => configSnapshot({})),
      agentsCreate: rosterRpc().agentsCreate,
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.activateImportedUser("tester10");

    expect(routingActivationMocks.activate).toHaveBeenCalledWith(
      rpc,
      testRuntime.dir,
      expect.any(Function),
      { restartAccountIds: [], restartConfiguredPending: true },
    );
  });

  it("preserves configured user manifest accounts after a retained-overlay no-op without pending activation", async () => {
    stubUserClaim("tester10");
    try {
      const desiredAccountIds = ["tester10-coach", "tester10-proj-orbit"];
      mocks.readActivationManifest.mockResolvedValueOnce({
        slug: "tester10",
        appliedFingerprint: "fp-tester10",
        agentId: "octogee-tester10-coach",
        accountId: "tester10-coach",
        agent: { id: "octogee-tester10-coach", workspace: path.join(testRuntime.dir, "customers/tester10") },
        mattermostAccount: { botToken: "default-agent-pat" },
        bindings: [],
        projectAgents: [{
          agentId: "octogee-tester10-proj-orbit-coach",
          accountId: "tester10-proj-orbit",
          agent: { id: "octogee-tester10-proj-orbit-coach", workspace: path.join(testRuntime.dir, "customers/tester10/projects/orbit") },
          mattermostAccount: { botToken: "orbit-pat" },
          bindings: [],
        }],
      });
      mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
        elapsedMs: 42,
        routingActivationRequired: false,
        restartExistingAccountIds: [],
        configNoop: true,
      });
      let accountsRestarted = false;
      routingActivationMocks.activate.mockImplementationOnce(async () => {
        accountsRestarted = true;
      });
      const rpc = {
        channelsStatus: vi.fn(async () => ({
          channelAccounts: {
            mattermost: [
              {
                accountId: "tester10-coach",
                running: true,
                connected: true,
              },
              {
                accountId: "tester10-proj-orbit",
                running: true,
                connected: true,
              },
              {
                accountId: "unrelated-coach",
                running: true,
                connected: true,
              },
            ],
          },
        })),
        configGet: vi.fn(async () => configSnapshot({
          agents: {
            list: [
              { id: "octogee-tester10-coach", model: "house" },
              { id: "octogee-tester10-proj-orbit-coach", model: "house" },
            ],
          },
        })),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({
        client: configuredUserClient(),
        rpc,
        log: vi.fn(),
        isIsolatedGateway: () => true,
      });

      await expect(adapter.activateImportedUser("tester10")).resolves.toEqual({
        appliedFingerprint: "fp-tester10",
      });
      expect(accountsRestarted).toBe(false);
      expect(routingActivationMocks.stopStale).toHaveBeenCalledWith(
        rpc,
        {
          currentSlug: "tester10",
          desiredAccountIds,
          evictionSlugs: [],
        },
        expect.any(Function),
      );
      expect(routingActivationMocks.activateAfterPatch).toHaveBeenCalledWith(
        rpc,
        testRuntime.dir,
        expect.any(Function),
        {
          accountIds: desiredAccountIds,
          baseline: {
            "tester10-coach": 0,
            "tester10-proj-orbit": 0,
          },
          configNoop: true,
          required: false,
          reason: "[import:tester10] account-level Mattermost binding changed",
          currentSlug: "tester10",
          evictionSlugs: [],
        },
      );
      expect(routingActivationMocks.mark).not.toHaveBeenCalled();
      expect(routingActivationMocks.activate).not.toHaveBeenCalled();
      expect(rpc.secretsReload.mock.invocationCallOrder[0]).toBeLessThan(
        routingActivationMocks.activateAfterPatch.mock.invocationCallOrder[0]!,
      );
    } finally {
      clearUserClaim();
    }
  });

  it("keeps an existing configured user no-op activation pending when its account restart fails", async () => {
    stubUserClaim("tester10");
    routingActivationMocks.pending = true;
    try {
      mocks.readActivationManifest.mockResolvedValueOnce({
        slug: "tester10",
        appliedFingerprint: "fp-tester10",
        agentId: "octogee-tester10-coach",
        accountId: "tester10-coach",
        agent: { id: "octogee-tester10-coach", workspace: path.join(testRuntime.dir, "customers/tester10") },
        mattermostAccount: { botToken: "default-agent-pat" },
        bindings: [],
        projectAgents: [],
      });
      mocks.applyOpenClawActivationManifest.mockResolvedValueOnce({
        elapsedMs: 42,
        routingActivationRequired: false,
        restartExistingAccountIds: [],
        configNoop: true,
      });
      routingActivationMocks.activate.mockRejectedValueOnce(
        new Error("Mattermost account restart failed"),
      );
      const rpc = {
        channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
        configGet: vi.fn(async () => configSnapshot({})),
        agentsCreate: rosterRpc().agentsCreate,
        secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
      } as unknown as GatewayRpcClient;
      const adapter = buildBrokeredLifecycleAdapter({
        client: configuredUserClient(),
        rpc,
        log: vi.fn(),
        isIsolatedGateway: () => true,
      });

      await expect(adapter.activateImportedUser("tester10")).resolves.toEqual({
        appliedFingerprint: "fp-tester10",
        verificationPending: "Mattermost account restart failed",
      });

      expect(routingActivationMocks.mark).not.toHaveBeenCalled();
      expect(routingActivationMocks.activate).toHaveBeenCalledWith(
        rpc, testRuntime.dir, expect.any(Function),
        { restartAccountIds: [], restartConfiguredPending: true },
      );
      expect(routingActivationMocks.pending).toBe(true);
      expect(mocks.removeActivationManifest).not.toHaveBeenCalled();
      expect(rpc.channelsStatus).not.toHaveBeenCalled();
    } finally {
      clearUserClaim();
    }
  });

  it("propagates manifest import errors without synthesizing an applied fingerprint", async () => {
    const client = mkClient();
    const failure = new Error("activation manifest version/slug mismatch");
    mocks.readActivationManifest.mockRejectedValueOnce(failure);
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });

    await expect(adapter.activateImportedUser("tester10")).rejects.toBe(failure);

    expect(mocks.readActivationManifest).toHaveBeenCalledExactlyOnceWith(
      testRuntime.dir,
      "tester10",
    );
    expect(client.userSnapshot).not.toHaveBeenCalled();
    expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
  });

  it("fails before mutating config when the activation manifest is absent", async () => {
    mocks.readActivationManifest.mockRejectedValue(new Error("missing activation manifest"));
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });

    await expect(adapter.activateImportedUser("missing")).rejects.toThrow(
      /missing activation manifest/,
    );
    expect(mocks.applyOpenClawActivationManifest).not.toHaveBeenCalled();
  });

  it("moves and quiesces every project agent state path owned by the user", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-migration-project-state-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    await fs.mkdir(path.join(tempStateDir, "agents", "octogee-tester10-coach", "sessions"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tempStateDir, "agents", "octogee-tester10-proj-orbit-coach", "sessions"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tempStateDir, "agents", "octogee-other-proj-orbit-coach"), {
      recursive: true,
    });
    await fs.mkdir(path.join(tempStateDir, "memory"), { recursive: true });
    for (const agentId of ["octogee-tester10-coach", "octogee-tester10-proj-orbit-coach"]) {
      const agentDir = path.join(tempStateDir, "agents", agentId, "agent");
      await fs.mkdir(agentDir, { recursive: true });
      const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
      try {
        db.exec("CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT, status TEXT)");
        db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run(`agent:${agentId}:main`, agentId, "running");
      } finally {
        db.close();
      }
    }
    await fs.writeFile(
      path.join(tempStateDir, "memory", "octogee-tester10-proj-orbit-coach.sqlite-wal"),
      "",
    );
    await fs.writeFile(
      path.join(tempStateDir, "memory", "octogee-other-proj-orbit-coach.sqlite-wal"),
      "",
    );
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await fs.mkdir(path.join(testRuntime.dir, "git-metadata", "tester10", "projects", "orbit.git"), { recursive: true });
    const paths = await adapter.listExportPaths("tester10");

    expect(paths).toEqual(expect.arrayContaining([
      { cwd: testRuntime.dir, path: path.join("git-metadata", "tester10") },
      { cwd: tempStateDir, path: path.join("agents", "octogee-tester10-coach") },
      { cwd: tempStateDir, path: path.join("agents", "octogee-tester10-proj-orbit-coach") },
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringContaining("octogee-other-") }),
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: expect.stringMatching(/\.sqlite-(wal|shm)$/u) }),
    ]));
    await expect(adapter.quiesceUser("tester10", 0)).resolves.toEqual({
      drained: false,
      runningCount: 2,
    });
  });
});

describe("broker migration admission", () => {
  const boundedStopDirs: string[] = [];
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  afterEach(async () => {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    for (const dir of boundedStopDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });
  function seedMigrationqaSession(stateDir: string, status: string): void {
    const agentDir = path.join(stateDir, "agents", "octogee-migrationqa-coach", "agent");
    fsSync.mkdirSync(agentDir, { recursive: true });
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
    try {
      db.exec("CREATE TABLE IF NOT EXISTS session_nodes (session_key TEXT, current_session_id TEXT, status TEXT)");
      db.exec("DELETE FROM session_nodes");
      db.prepare("INSERT INTO session_nodes VALUES (?, ?, ?)").run("agent:octogee-migrationqa-coach:main", "s1", status);
    } finally {
      db.close();
    }
  }

  it("drains a user with scheduled jobs: the schedule transfer snapshot moves them, not quiesce", async () => {
    const rpc = mkGatewayRpc({ cronJobCount: vi.fn(async () => 1) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    await expect(adapter.quiesceUser("migrationqa", 0)).resolves.toMatchObject({ drained: true });
    expect(rpc.cronJobCount).not.toHaveBeenCalled();
  });
  it("returns a user whose agent keeps host-bound jobs: the hold retains them instead of refusing", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-migration-partial-hold-"));
    boundedStopDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    seedMigrationqaSession(stateDir, "done");
    const rpc = mkGatewayRpc({
      cronJobCount: vi.fn(async () => 2),
      configGet: vi.fn(async () => configSnapshot({ agents: { entries: { "octogee-migrationqa-coach": {} } } })),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.quiesceUser("migrationqa", 0, { stopMattermost: true, schedulerMigrationId: "handoff-1", retainNonportable: true }))
      .resolves.toEqual({ drained: true, runningCount: 0 });
    expect(rpc.cronJobCount).not.toHaveBeenCalled();
    expect(rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "handoff-1", phase: "hold", agentIds: ["octogee-migrationqa-coach"], retainNonportable: true });
  });
  it.each([false, true])("validates a configured user private workspace before export and scheduler hold (foreign: %s)", async (foreign) => {
    const previousConfig = await fs.readFile(OPENCLAW_CONFIG).catch(() => null);
    const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "broker-private-return-")));
    boundedStopDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    stubUserClaim("migrationqa");
    const agentId = "octogee-migrationqa-proj-site-coach";
    const relativeWorkspace = `customers/${foreign ? "other" : "migrationqa"}/.system/project-coaches/site`;
    const workspace = path.join(stateDir, relativeWorkspace);
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "IDENTITY.md"), "private agent identity");
    await fs.mkdir(path.join(stateDir, "agents", agentId, "agent"), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify({ agents: { entries: {
      [agentId]: { workspace, agentDir: path.join(stateDir, "agents", agentId, "agent") },
    } } }));
    const rpc = mkGatewayRpc();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    try {
      const hold = { operationId: "private-return", phase: "hold" as const };
      if (foreign) {
        await expect(adapter.listExportPaths("migrationqa")).rejects.toThrow(/canonical workspace root/);
        await expect(Promise.resolve().then(() => adapter.schedulerMigration!("migrationqa", hold))).rejects.toThrow(/canonical workspace root/);
        expect(rpc.schedulerMigration).not.toHaveBeenCalled();
        expect(rpc.channelsStop).not.toHaveBeenCalled();
      } else {
        expect(await adapter.listExportPaths("migrationqa")).toEqual(expect.arrayContaining([
          { cwd: stateDir, path: relativeWorkspace },
          { cwd: stateDir, path: `agents/${agentId}` },
        ]));
        await adapter.schedulerMigration!("migrationqa", hold);
        expect(rpc.schedulerMigration).toHaveBeenCalledWith({ ...hold, agentIds: [agentId] });
        await adapter.schedulerMigration!("migrationqa", { operationId: "private-return", phase: "export", resolveAgentScope: true });
        expect(rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "private-return", phase: "export", agentIds: [agentId] });
        await adapter.schedulerMigration!("migrationqa", { operationId: "private-return", phase: "abort", agentIds: [agentId] });
        expect(rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "private-return", phase: "abort", agentIds: [agentId] });
        await expect(adapter.quiesceUser("migrationqa", 0, { stopMattermost: true, schedulerMigrationId: "private-return" }))
          .resolves.toEqual({ drained: true, runningCount: 0 });
        expect(rpc.sessionsAbort).not.toHaveBeenCalled();
        expect(await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8")).toBe("private agent identity");
      }
    } finally {
      clearUserClaim();
      if (previousConfig) await fs.writeFile(OPENCLAW_CONFIG, previousConfig);
      else await fs.rm(OPENCLAW_CONFIG, { force: true });
    }
  });

  it("proves scheduler readiness with a read-only gateway RPC and surfaces why it is not ready", async () => {
    const ready = mkGatewayRpc({ configGet: vi.fn(async () => configSnapshot({})) });
    await expect(buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: ready, log: vi.fn() }).schedulerReady()).resolves.toBeUndefined();
    expect(ready.configGet).toHaveBeenCalledOnce();
    expect(ready.schedulerMigration).not.toHaveBeenCalled();

    const booting = mkGatewayRpc({ configGet: vi.fn(async () => { throw new Error("OpenClaw workspace identities are not initialized for this boot"); }) });
    await expect(buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: booting, log: vi.fn() }).schedulerReady())
      .rejects.toThrow("workspace identities are not initialized for this boot");
  });
  it("leaves ingress to the whole-process rollout owner when requested", async () => {
    const rpc = mkGatewayRpc();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    await adapter.quiesceUser("migrationqa", 100, { stopMattermost: false });
    expect(rpc.channelsStop).not.toHaveBeenCalled();
  });
  it("defers a turn that outlives the drain budget without aborting it", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-migration-bounded-stop-"));
    boundedStopDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const seed = (status: string) => seedMigrationqaSession(stateDir, status);
    seed("running");
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot({
        channels: { mattermost: { accounts: { "migrationqa-coach": {} } } },
        agents: { entries: { "octogee-migrationqa-coach": {} } },
      })),
      sessionsAbort: vi.fn(async () => {
        seed("killed");
        return { ok: true as const, abortedRunId: "run-9", status: "aborted" as const };
      }),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.quiesceUser("migrationqa", 0, { stopMattermost: true, schedulerMigrationId: "handoff-1" }))
      .resolves.toEqual({ drained: false, runningCount: 1 });
    expect(rpc.channelsStop).toHaveBeenCalledExactlyOnceWith({ channel: "mattermost", accountId: "migrationqa-coach" });
    expect(rpc.sessionsAbort).not.toHaveBeenCalled();
    expect(rpc.schedulerMigration).toHaveBeenCalledWith({ operationId: "handoff-1", phase: "hold", agentIds: ["octogee-migrationqa-coach"] });
  });

  it("defers while an active scheduled run keeps the source undrained", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-migration-cron-stop-"));
    boundedStopDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    seedMigrationqaSession(stateDir, "running");
    let cronRunning = true;
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot({ agents: { entries: { "octogee-migrationqa-coach": {} } } })),
      schedulerMigration: vi.fn(async (request: { operationId: string; phase: string; agentIds?: string[] }) => ({
        operationId: request.operationId, phase: request.phase, agentIds: request.agentIds ?? [], drained: !cronRunning,
      })),
      sessionsAbort: vi.fn(async () => {
        cronRunning = false;
        seedMigrationqaSession(stateDir, "killed");
        return { ok: true as const, abortedRunId: "cron-run", status: "aborted" as const };
      }),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.quiesceUser("migrationqa", 0, { stopMattermost: true, schedulerMigrationId: "handoff-1" }))
      .resolves.toEqual({ drained: false, runningCount: 1 });
    expect(rpc.sessionsAbort).not.toHaveBeenCalled();
    const holds = vi.mocked(rpc.schedulerMigration).mock.calls.map(([request]) => request.phase);
    expect(holds.every((phase) => phase === "hold")).toBe(true);
    expect(holds).toEqual(["hold"]);
  });

  it("never aborts turns for the whole-process handoff owner, which stops the process itself", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "broker-migration-surge-stop-"));
    boundedStopDirs.push(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    seedMigrationqaSession(stateDir, "running");
    const rpc = mkGatewayRpc();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.quiesceUser("migrationqa", 0, { stopMattermost: false }))
      .resolves.toEqual({ drained: false, runningCount: 1 });
    expect(rpc.sessionsAbort).not.toHaveBeenCalled();
    expect(rpc.channelsStop).not.toHaveBeenCalled();
  });

  it("stops incoming agent turns before reporting an idle user drained", async () => {
    mocks.readActivationManifest.mockRejectedValueOnce(Object.assign(new Error("no rollback manifest"), { code: "ENOENT" }));
    const rpc = mkGatewayRpc({ configGet: vi.fn(async () => configSnapshot({
      channels: { mattermost: { accounts: { "migrationqa-coach": {} } } },
    })) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    await expect(adapter.quiesceUser("migrationqa", 100)).resolves.toEqual({ drained: true, runningCount: 0 });
    expect(rpc.channelsStop).toHaveBeenCalledExactlyOnceWith({ channel: "mattermost", accountId: "migrationqa-coach" });
    await adapter.resumeUser("migrationqa");
    expect(rpc.channelsStart).toHaveBeenCalledExactlyOnceWith({ channel: "mattermost", accountId: "migrationqa-coach" });
  });
});

describe("broker adapter malformed agent identity quarantine", () => {
  beforeEach(() => {
    patchMocks.applyConfigPatch.mockClear();
    secretMocks.updateMattermostAccountSecrets.mockClear();
  });

  it("deletes every stale user account before reporting an empty allowlist", async () => {
    const current = {
      channels: {
        mattermost: {
          accounts: {
            "alice-coach": { groupPolicy: "open", groupAllowFrom: ["legacy-guest"] },
            "alice-proj-orbit": {
              groupPolicy: "allowlist",
              groupAllowFrom: ["mm-project-member"],
            },
            "bob-coach": { groupPolicy: "open", groupAllowFrom: ["mm-bob"] },
            "bob-proj-map": { groupPolicy: "open", groupAllowFrom: ["mm-bob"] },
          },
        },
      },
    };
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      expect(args.buildPatch(current)).toEqual({
        channels: {
          mattermost: {
            accounts: {
              "alice-coach": null,
              "alice-proj-orbit": null,
            },
          },
        },
      });
      expect(args.buildReplacePaths?.(current)).toEqual([
        "channels.mattermost.accounts.alice-coach.groupAllowFrom",
        "channels.mattermost.accounts.alice-proj-orbit.groupAllowFrom",
      ]);
      return { mode: "rpc", attempts: 1 };
    });
    const rpc = mkGatewayRpc({
      configPatchAndWaitForChange: vi.fn(async () => ({ ok: true })),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => aliceSnapshot({ mattermostUserId: null, customerMmUserId: null })) }),
      rpc,
      log: vi.fn(),
    });

    await expect(
      adapter.applyAddUserConfigPatch(
        aliceSnapshot({ mattermostUserId: null, customerMmUserId: null }),
        { _coachPersonalToken: "pat-1" },
      ),
    ).rejects.toThrow(/account fragment was empty/);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledOnce();
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      { remove: ["alice-coach"], removePrefixes: ["alice-proj-"] },
    );
  });

  it("does not reuse a stale lifecycle owner id when the broker explicitly clears it", async () => {
    const brokerSnapshot = aliceSnapshot({
      mattermostUserId: null,
      customerMmUserId: null,
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => brokerSnapshot) }),
      rpc: mkGatewayRpc({
        configPatchAndWaitForChange: vi.fn(async () => ({ ok: true })),
      }),
      log: vi.fn(),
    });

    await expect(
      adapter.applyAddUserConfigPatch(
        aliceSnapshot({ mattermostUserId: ALICE_OWNER_MM_ID }),
        { _coachPersonalToken: "pat-1" },
      ),
    ).rejects.toThrow(/account fragment was empty/);
  });
});

describe("buildBrokeredLifecycleAdapter template files", () => {
  const previousTemplatesDir = process.env.OCTOGEE_TEMPLATES_DIR;
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "broker-templates-"));
    process.env.OCTOGEE_TEMPLATES_DIR = tempRoot;
    await fs.mkdir(path.join(tempRoot, "tiers", "seeded"), { recursive: true });
    await fs.writeFile(path.join(tempRoot, "tiers", "seeded", "AGENTS.md"), "Agent {{slug}}\n");
    await fs.writeFile(path.join(tempRoot, "tiers", "seeded", "TOOLS.md"), "Tools\n");
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
    if (previousTemplatesDir === undefined) delete process.env.OCTOGEE_TEMPLATES_DIR;
    else process.env.OCTOGEE_TEMPLATES_DIR = previousTemplatesDir;
  });

  it("seeds user-owned context files and removes legacy gitignore entries", async () => {
    const customerDir = path.join(tempRoot, "customers", "alice");
    await fs.mkdir(customerDir, { recursive: true });
    await fs.writeFile(
      path.join(customerDir, ".gitignore"),
      "AGENTS.md\nTOOLS.md\n.ssh/\n",
    );
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as GatewayRpcClient,
      log: vi.fn(),
    });

    await adapter.writeUserTemplateFiles({
      uid: "uid-alice",
      slug: "alice",
      contextTemplateKey: "seeded",
      ownerName: "Alice",
      customerDir,
      today: "2026-06-25",
      username: "alice",
      templateVars: { slug: "alice" },
      userData: {},
    });

    expect(fsSync.readFileSync(path.join(customerDir, "AGENTS.md"), "utf-8")).toBe(
      "Agent alice\n",
    );
    expect(fsSync.existsSync(path.join(customerDir, "TOOLS.md"))).toBe(true);
    expect(fsSync.existsSync(path.join(customerDir, "memory"))).toBe(false);
    expect(fsSync.readFileSync(path.join(customerDir, ".gitignore"), "utf-8")).toBe(
      ".ssh/\n",
    );
  });
});

describe("buildBrokeredLifecycleAdapter remove config patch", () => {
  beforeEach(() => {
    patchMocks.applyConfigPatch.mockClear();
    secretMocks.updateMattermostAccountSecrets.mockClear();
    routingActivationMocks.stopStale.mockClear();
    routingActivationMocks.discardForUsers.mockClear();
  });

  it.each(["complete", "pending", "foreign"])("proves exact PG-only cleanup without a local workspace: %s", async mode => {
    const project = "octogee-alice-proj-pgonly-coach";
    const configBefore = await fs.readFile(OPENCLAW_CONFIG).catch(() => null);
    const procRoot = path.join(testRuntime.dir, "erasure-proc");
    await fs.mkdir(procRoot, { recursive: true });
    await fs.rm(path.join(testRuntime.dir, "customers", "alice"), { recursive: true, force: true });
    await fs.rm(path.join(testRuntime.dir, "agents", project), { recursive: true, force: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify({ database: { families: { agent: { engine: "postgres" } } } }));
    const agentsDetach = vi.fn(async ({ agentId }: { agentId: string }) => {
      if (mode === "pending" && agentId === project) throw new OpenclawWireError("rpc-error", "Native cleanup remains pending");
      return { ok: true as const, agentId, failed: [] };
    });
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster(["octogee-bob-coach"]) } }, { agentsDetach });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, procRoot, log: vi.fn() });
    try {
      const ids = ["octogee-alice-coach", mode === "foreign" ? "octogee-bob-coach" : project];
      const removing = adapter.removeImportedUserBySlug!("alice", undefined, undefined, undefined, ids);
      if (mode === "complete") await expect(removing).resolves.toMatchObject({ wasMounted: false, releasedAgentIds: ids });
      else await expect(removing).rejects.toThrow(mode === "pending" ? "Native cleanup remains pending" : "Invalid Shared user erasure");
      if (mode === "foreign") expect(agentsDetach).not.toHaveBeenCalled();
      else {
        expect(agentsDetach).toHaveBeenCalledWith({ agentId: project });
        expect(agentsDetach).not.toHaveBeenCalledWith({ agentId: "octogee-bob-coach" });
      }
    } finally {
      if (configBefore) await fs.writeFile(OPENCLAW_CONFIG, configBefore);
      else await fs.rm(OPENCLAW_CONFIG, { force: true });
    }
  });

  it.each(["ordinary", "orphaned import"])("holds export through %s removal's config and secret mutations", async (mode) => {
    await fs.mkdir(path.join(testRuntime.dir, "customers", "alice"), { recursive: true });
    const procRoot = path.join(testRuntime.dir, "removal-proc");
    await fs.mkdir(procRoot, { recursive: true });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    secretMocks.updateMattermostAccountSecrets.mockImplementationOnce(async () => {
      await pending;
      return { changed: true };
    });
    secretMocks.exportActivationManifestWithSecret.mockClear();
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster(["octogee-alice-coach"]) },
      channels: { mattermost: { accounts: { "alice-coach": {} } } }, bindings: [] });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, procRoot, log: vi.fn() });
    const removing = mode === "ordinary"
      ? adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach")
      : adapter.removeImportedUserBySlug!("alice");
    let exported: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalled());
      exported = adapter.exportOpenClawActivationManifest!("alice").catch((error) => error);
      await Promise.resolve();
      await Promise.resolve();
      expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
    } finally {
      release();
      await removing;
    }
    await exported;
    expect(secretMocks.exportActivationManifestWithSecret).toHaveBeenCalledOnce();
  });

  // 2026.7.2 refuses any config write whose canonical roster drops entries
  // unless the write carries `allowedAgentRosterRemovals`, which only openclaw's
  // own `agents.delete` supplies. A removal is therefore one RPC per departing
  // agent plus an accounts-only patch.
  it("deletes the user's rostered agents and sends a patch with no agents key", async () => {
    const current = {
      agents: {
        entries: keyedRoster([
          "octogee-ops-eggman",
          "octogee-alice-coach",
          "octogee-alice-proj-old-coach",
        ]),
      },
      bindings: [
        { agentId: "octogee-ops-eggman" },
        {
          agentId: "octogee-ops-eggman",
          match: { channel: "mattermost", accountId: "alice-coach" },
        },
        { agentId: "octogee-alice-coach" },
        { agentId: "octogee-alice-proj-old-coach" },
      ],
      channels: {
        mattermost: {
          accounts: { "alice-coach": {}, "alice-proj-old": {}, "ops-coach": {} },
        },
      },
    };
    const rpc = mkRemovalRpc(current);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach");

    expect(rpc.agentsDelete).toHaveBeenCalledTimes(2);
    expect(rpc.agentsDelete).toHaveBeenCalledWith({ agentId: "octogee-alice-coach", deleteFiles: false });
    expect(rpc.agentsDelete).toHaveBeenCalledWith({ agentId: "octogee-alice-proj-old-coach", deleteFiles: false });

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => Record<string, unknown>;
      buildReplacePaths?: (current: unknown) => string[];
    };
    const patch = args.buildPatch(current);
    expect(patch).toEqual({
      channels: {
        mattermost: { accounts: { "alice-coach": null, "alice-proj-old": null } },
      },
    });
    expect(patch).not.toHaveProperty("agents");
    expect(patch).not.toHaveProperty("bindings");
    expect(args.buildReplacePaths?.(current)).toEqual(
      userConfigReplacePaths(current, "alice"),
    );
    expect(routingActivationMocks.stopStale).toHaveBeenCalledWith(
      rpc,
      {
        currentSlug: "alice",
        desiredAccountIds: [],
        evictionSlugs: [],
      },
      expect.any(Function),
    );
    expect(routingActivationMocks.discardForUsers).toHaveBeenCalledWith(
      testRuntime.dir,
      ["alice"],
    );
    expect(routingActivationMocks.stopStale.mock.invocationCallOrder[0]).toBeLessThan(
      routingActivationMocks.discardForUsers.mock.invocationCallOrder[0]!,
    );
    expect(routingActivationMocks.discardForUsers.mock.invocationCallOrder[0]).toBeLessThan(
      secretMocks.updateMattermostAccountSecrets.mock.invocationCallOrder[0]!,
    );
  });

  it("waits for config.changed before stopping the removed account monitor", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const configPatchAndWaitForChange = vi.fn(async () => ({ hash: "h2", config: {} }));
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (_args, options) =>
      options.rpc.configPatch({}, "h1")
    );

    await adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach");

    expect(configPatchAndWaitForChange).toHaveBeenCalledWith({}, "h1", undefined);
    expect(configPatchAndWaitForChange.mock.invocationCallOrder[0]).toBeLessThan(
      routingActivationMocks.stopStale.mock.invocationCallOrder[0]!,
    );
  });

  it("deletes every departing agent in the batch with one config mutation", async () => {
    const current = {
      agents: {
        entries: keyedRoster([
          "octogee-alice-coach",
          "octogee-bob-coach",
          "octogee-bob-proj-orbit-coach",
          "octogee-carol-coach",
        ]),
      },
      bindings: [],
      channels: {
        mattermost: {
          accounts: { "alice-coach": {}, "bob-coach": {}, "bob-proj-orbit": {}, "carol-coach": {} },
        },
      },
    };
    const rpc = mkRemovalRpc(current);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const batch = ["alice", "bob"] as const;

    await adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach", batch);
    await adapter.applyRemoveUserConfigPatch("bob", "octogee-bob-coach", batch);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rpc.agentsDelete).mock.calls.map(([params]) => params.agentId)).toEqual([
      "octogee-alice-coach",
      "octogee-bob-coach",
      "octogee-bob-proj-orbit-coach",
    ]);

    const args = vi.mocked(applyConfigPatch).mock.calls[0]![0] as {
      buildPatch: (current: unknown) => {
        channels: { mattermost: { accounts: Record<string, null> } };
      };
    };
    expect(args.buildPatch(current).channels.mattermost.accounts).toEqual({
      "alice-coach": null,
      "bob-coach": null,
      "bob-proj-orbit": null,
    });
  });

  it("tolerates an agent openclaw already deleted so a retried eviction still finishes", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const rpc = mkRemovalRpc(current, {
      agentsDelete: vi.fn(async ({ agentId }: { agentId: string }) => {
        throw new OpenclawWireError("rpc-error", `agent "${agentId}" not found`);
      }),
    } as Partial<GatewayRpcClient>);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach"),
    ).resolves.toEqual(["alice"]);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledTimes(1);
  });

  it("fails the eviction before mutating config when a delete is refused", async () => {
    const current = {
      agents: { entries: keyedRoster(["octogee-alice-coach", "octogee-alice-proj-old-coach"]) },
    };
    const agentsDelete = vi.fn(async ({ agentId }: { agentId: string }) => {
      throw new OpenclawWireError("rpc-error", `agent "${agentId}" is the default`);
    });
    const rpc = mkRemovalRpc(current, { agentsDelete } as Partial<GatewayRpcClient>);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach"),
    ).rejects.toThrow(/octogee-alice-coach.*octogee-alice-proj-old-coach/s);

    expect(agentsDelete).toHaveBeenCalledTimes(2);
    expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
    expect(secretMocks.updateMattermostAccountSecrets).not.toHaveBeenCalled();
  });

  it("re-reads the roster after deleting so the accounts patch never rides a pre-delete hash", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const rpc = mkRemovalRpc(current);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach");

    const options = patchMocks.applyConfigPatch.mock.calls.at(-1)![1];
    expect(options.cache).toEqual({ current: undefined, hash: "" });
  });

  it("does not replay a completed config mutation when secret cleanup retries", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const rpc = mkRemovalRpc(current);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    secretMocks.updateMattermostAccountSecrets.mockRejectedValueOnce(
      new Error("secret file busy"),
    );

    await expect(
      adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach"),
    ).rejects.toThrow("secret file busy");
    await expect(
      adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach"),
    ).resolves.toEqual(["alice"]);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledTimes(1);
    expect(rpc.agentsDelete).toHaveBeenCalledTimes(1);
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledTimes(2);
  });

  function realPatchOnce(): void {
    patchMocks.applyConfigPatch.mockImplementationOnce(
      (...[args, options]: Parameters<typeof realApplyConfigPatch>) => realApplyConfigPatch(args, options),
    );
  }

  function casLostOnce() {
    return vi.fn()
      .mockRejectedValueOnce(new OpenclawWireError(
        "hash-mismatch",
        "config changed since last load; re-run config.get and retry",
      ))
      .mockResolvedValue({ ok: true });
  }

  it("rebuilds the removal from a fresh config.get and completes the eviction after losing the config CAS", async () => {
    const current = {
      agents: { entries: keyedRoster(["octogee-alice-coach"]) },
      channels: { mattermost: { accounts: { "alice-coach": {} } } },
    };
    const configPatchAndWaitForChange = casLostOnce();
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    realPatchOnce();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach", ["alice"], async () => ["alice"]),
    ).resolves.toEqual(["alice"]);

    expect(configPatchAndWaitForChange).toHaveBeenCalledTimes(2);
    expect(configPatchAndWaitForChange.mock.calls[1]![0]).toEqual({
      channels: { mattermost: { accounts: { "alice-coach": null } } },
    });
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      { remove: ["alice-coach"], removePrefixes: ["alice-proj-"] },
    );
  });

  it("retries a signed unmount removal from a fresh config.get after a concurrent unmount wins the config CAS", async () => {
    const current = {
      agents: { entries: keyedRoster(["octogee-alice-coach"]) },
      channels: { mattermost: { accounts: { "alice-coach": {} } } },
    };
    const configPatchAndWaitForChange = casLostOnce();
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    realPatchOnce();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach"),
    ).resolves.toEqual(["alice"]);

    expect(configPatchAndWaitForChange).toHaveBeenCalledTimes(2);
    expect(configPatchAndWaitForChange.mock.calls[1]![0]).toEqual({
      channels: { mattermost: { accounts: { "alice-coach": null } } },
    });
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      { remove: ["alice-coach"], removePrefixes: ["alice-proj-"] },
    );
  });

  it("stops retrying and keeps the user's accounts when it is desired here again after losing the CAS", async () => {
    const current = {
      agents: { entries: keyedRoster(["octogee-alice-coach"]) },
      channels: { mattermost: { accounts: { "alice-coach": {} } } },
    };
    const configPatchAndWaitForChange = casLostOnce();
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    realPatchOnce();
    const log = vi.fn();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log });

    await expect(
      adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach", ["alice"], async () => []),
    ).resolves.toEqual([]);

    expect(configPatchAndWaitForChange).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/\[remove:alice\].*alice.*desired on this gateway/));
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      { remove: [], removePrefixes: [] },
    );
  });

  it("retries only the batch slugs that are still evicted after losing the CAS", async () => {
    const current = {
      agents: { entries: keyedRoster(["octogee-alice-coach", "octogee-bob-coach"]) },
      channels: { mattermost: { accounts: { "alice-coach": {}, "bob-coach": {} } } },
    };
    const configPatchAndWaitForChange = casLostOnce();
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    realPatchOnce();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach", ["alice", "bob"], async () => ["alice"]),
    ).resolves.toEqual(["alice"]);

    expect(configPatchAndWaitForChange.mock.calls[1]![0]).toEqual({
      channels: { mattermost: { accounts: { "alice-coach": null } } },
    });
  });

  it("fails the eviction loudly without touching secrets when the removal patch is rejected", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const configPatchAndWaitForChange = vi.fn(async () => {
      throw new OpenclawWireError("invalid-patch", "channels.mattermost.accounts: bad shape");
    });
    const rpc = mkRemovalRpc(current, { configPatchAndWaitForChange } as Partial<GatewayRpcClient>);
    realPatchOnce();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach", ["alice"], async () => ["alice"]),
    ).rejects.toMatchObject({ code: "invalid-patch" });

    expect(configPatchAndWaitForChange).toHaveBeenCalledTimes(1);
    expect(secretMocks.updateMattermostAccountSecrets).not.toHaveBeenCalled();
  });

  it("preserves refreshed secrets when the user is re-admitted after config quarantine", async () => {
    const current = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkRemovalRpc(current),
      log: vi.fn(),
    });

    await expect(
      adapter.applyRemoveUserConfigPatch(
        "alice",
        "octogee-alice-coach",
        ["alice"],
        async () => [],
      ),
    ).resolves.toEqual([]);

    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      { remove: [], removePrefixes: [] },
    );
  });

  it("deletes the legacy list roster's user agents too", async () => {
    const current = {
      agents: { list: [{ id: "octogee-ops-eggman" }, { id: "octogee-alice-coach" }] },
      bindings: [],
      channels: { mattermost: { accounts: { "alice-coach": {} } } },
    };
    const rpc = mkRemovalRpc(current);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyRemoveUserConfigPatch("alice", "octogee-alice-coach");

    expect(rpc.agentsDelete).toHaveBeenCalledTimes(1);
    expect(rpc.agentsDelete).toHaveBeenCalledWith({ agentId: "octogee-alice-coach", deleteFiles: false });
  });
});

describe("buildBrokeredLifecycleAdapter add config patch", () => {
  beforeEach(() => {
    gitMocks.cloneProjectRepo.mockReset().mockResolvedValue(true);
    gitMocks.userRepositoryHasCanonicalRemote.mockReset().mockReturnValue(true);
    gitMocks.projectCheckoutMatchesSource.mockReset().mockReturnValue(true);
    vi.stubEnv("GATEWAY_ID", "default");
    vi.stubEnv("POD_UID", "mount-pod");
    mocks.readActivationManifest.mockReset().mockImplementation((dir, slug) => realReadActivationManifest(dir, slug));
    mocks.removeActivationManifest.mockReset().mockImplementation(async (dir, slug) => { await fs.rm(path.join(dir, activationManifestTarPath(slug)), { force: true }); });
    patchMocks.applyConfigPatch.mockClear();
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockClear();
    routingActivationMocks.pending = false;
    routingActivationMocks.capture.mockClear();
    routingActivationMocks.activate.mockReset().mockImplementation(async () => undefined);
    routingActivationMocks.mark.mockClear();
    vi.stubEnv("OPENAI_EMBEDDINGS_ENABLED", "true");
    vi.stubEnv("OPENAI_EMBEDDINGS_MODEL", "text-embedding-3-small");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("restores recorded Shared agent identities before agents.create and awaits their durable report before attach completes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-anchor-attach-"));
    const priorConfig = await fs.readFile(OPENCLAW_CONFIG).catch(() => undefined);
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify({ database: { engine: "postgres" } }));
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    vi.stubEnv("OPENCLAW_AGENT_STORE_DSN", "synthetic-pg-test");
    vi.stubEnv("GATEWAY_CLASS", "shared");
    const anchors = [
      { agentId: "octogee-alice-coach", storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_agent_92c817cc770f466d" },
      { agentId: "octogee-alice-proj-orbit-coach", storeId: "3313965d-1e56-4006-9d9c-1b0289fafcfa", schema: "octogee_agent_3313965d1e564006" },
    ];
    anchorQuery.mockImplementation(async (target, sql) => sql.includes("openclaw_schema_meta")
      ? [{ store_id: target.storeId }] : [{ agent_id: anchors.find((anchor) => anchor.schema === target.schema)!.agentId }]);
    const snapshot = aliceSnapshot({ projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "orbit-pat", status: "ready" }] });
    let release!: () => void;
    const reported = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.fn(async () => ({ anchors, assignment: { uid: snapshot.uid, epoch: 0, state: "serving" as const } }));
    const report = vi.fn(async () => reported);
    const rpc = mkGatewayRpc({ agentsCreate: vi.fn(async ({ name, workspace }) => {
      expect(await readLocalAgentAnchors(dir, anchors.map((anchor) => anchor.agentId))).toEqual(anchors);
      return { ok: true as const, agentId: name, name, workspace };
    }) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot), readAgentAnchors: read, reportAgentAnchors: report }), rpc, log: vi.fn(), isIsolatedGateway: () => false });
    let complete = false;
    const attaching = adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "default-agent-pat" }).finally(() => { complete = true; });
    const observed = attaching.catch((error) => error);
    try {
      await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
      expect(complete).toBe(false);
      expect(report).toHaveBeenCalledWith({ uid: snapshot.uid, slug: snapshot.slug, assignmentEpoch: 0, assignmentState: "serving", anchors, configuredAgentIds: anchors.map((anchor) => anchor.agentId) });
      release();
      await attaching;
      expect(read).toHaveBeenCalledWith({ uid: snapshot.uid, slug: snapshot.slug });
    } finally {
      release(); await observed; await fs.rm(dir, { recursive: true, force: true });
      if (priorConfig) await fs.writeFile(OPENCLAW_CONFIG, priorConfig);
      else await fs.rm(OPENCLAW_CONFIG, { force: true });
    }
  });

  it.each(["read", "verify", "report", "local-mismatch"])("refuses Shared attach on %s failure without accepting replacement identities", async (failure) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-anchor-refuse-"));
    const priorConfig = await fs.readFile(OPENCLAW_CONFIG).catch(() => undefined);
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify({ database: { engine: "postgres" } }));
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    vi.stubEnv("OPENCLAW_AGENT_STORE_DSN", "synthetic-pg-test");
    vi.stubEnv("GATEWAY_CLASS", "shared");
    const anchor = { agentId: "octogee-alice-coach", storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_agent_92c817cc770f466d" };
    const snapshot = aliceSnapshot();
    const replacement = { ...anchor, storeId: "3313965d-1e56-4006-9d9c-1b0289fafcfa" };
    if (failure === "local-mismatch") await landAgentAnchors(dir, [replacement]);
    anchorQuery.mockImplementation(async (_target, sql) => {
      if (failure === "verify") throw new Error("synthetic verify failure");
      return sql.includes("openclaw_schema_meta") ? [{ store_id: anchor.storeId }] : [{ agent_id: anchor.agentId }];
    });
    const read = vi.fn(async () => {
      if (failure === "read") throw new Error("synthetic read failure");
      return { anchors: [anchor], assignment: { uid: snapshot.uid, epoch: 0, state: "serving" as const } };
    });
    const report = vi.fn(async () => { if (failure === "report") throw new Error("synthetic report failure"); });
    const rpc = mkGatewayRpc();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot), readAgentAnchors: read, reportAgentAnchors: report }), rpc, log: vi.fn(), isIsolatedGateway: () => false });
    try {
      await expect(adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "default-agent-pat" })).rejects.toThrow(failure === "local-mismatch" ? "different" : `synthetic ${failure} failure`);
      if (failure !== "report") expect(rpc.agentsCreate).not.toHaveBeenCalled();
      expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
      if (failure === "local-mismatch") expect(await readLocalAgentAnchors(dir, [anchor.agentId])).toEqual([replacement]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      if (priorConfig) await fs.writeFile(OPENCLAW_CONFIG, priorConfig);
      else await fs.rm(OPENCLAW_CONFIG, { force: true });
    }
  });

  it.each(["new", "incomplete", "quiescing"])("requires complete verified Shared anchors after first creation (%s)", async (mode) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-anchor-new-"));
    const priorConfig = await fs.readFile(OPENCLAW_CONFIG).catch(() => undefined);
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify({ database: { families: { agent: { engine: "postgres" } } } }));
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);
    vi.stubEnv("GATEWAY_CLASS", "shared");
    const anchor = { agentId: "octogee-alice-coach", storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_agent_92c817cc770f466d" };
    const snapshot = aliceSnapshot();
    anchorQuery.mockImplementation(async (_target, sql) => sql.includes("openclaw_schema_meta") ? [{ store_id: anchor.storeId }] : [{ agent_id: anchor.agentId }]);
    const report = vi.fn(async () => undefined);
    const rpc = mkGatewayRpc({ agentsCreate: vi.fn(async ({ name, workspace }) => {
      if (mode === "new") await landAgentAnchors(dir, [anchor]);
      return { ok: true as const, agentId: name, name, workspace };
    }) });
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot), reportAgentAnchors: report,
      readAgentAnchors: vi.fn(async () => ({ anchors: [], assignment: { uid: snapshot.uid, epoch: 0, state: mode === "quiescing" ? "quiescing" as const : "serving" as const } })) });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn(), isIsolatedGateway: () => false });
    try {
      const attach = adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "default-agent-pat" });
      if (mode === "new") {
        await attach;
        expect(report).toHaveBeenCalledWith({ uid: snapshot.uid, slug: snapshot.slug, assignmentEpoch: 0, assignmentState: "serving", anchors: [anchor], configuredAgentIds: [anchor.agentId] });
        expect(anchorQuery).toHaveBeenCalledWith(anchor, "SELECT agent_id FROM $schema.schema_meta WHERE meta_key = 'primary'");
      } else {
        await expect(attach).rejects.toThrow(mode === "incomplete" ? "incomplete" : "serving assignment");
        expect(report).not.toHaveBeenCalled();
        if (mode === "quiescing") expect(rpc.agentsCreate).not.toHaveBeenCalled();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
      if (priorConfig) await fs.writeFile(OPENCLAW_CONFIG, priorConfig);
      else await fs.rm(OPENCLAW_CONFIG, { force: true });
    }
  });

  it.each(["isolated", "shared"])("keeps %s account endpoint ownership through a full remount", async (gatewayClass) => {
    vi.stubEnv("GATEWAY_CLASS", gatewayClass);
    stubUserClaim(gatewayClass === "isolated" ? "alice" : "");
    const snapshot = aliceSnapshot({ projectAgents: [
      { projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "orbit-pat", status: "ready" },
      { projectId: "scout", enabled: true, mmUserId: "bot-scout", token: "scout-pat", status: "ready" },
    ] });
    const config = {
      agents: { entries: keyedRoster(["octogee-alice-coach", "octogee-alice-proj-orbit-coach", "octogee-alice-proj-scout-coach"]) },
      channels: { mattermost: { accounts: {
        default: { baseUrl: "${MM_URL}" },
        "alice-coach": { baseUrl: "https://owner-coach.example" },
        "alice-proj-orbit": { baseUrl: "https://owner-orbit.example" },
      } } },
    };
    let patch: Record<string, any> | undefined;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch(config) as Record<string, any>;
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(rosterRpc(config)), log: vi.fn(),
      isIsolatedGateway: () => gatewayClass === "isolated",
    });

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "default-agent-pat" });

    const accounts = patch!.channels.mattermost.accounts;
    expect(accounts["alice-coach"].baseUrl).toBe(gatewayClass === "isolated" ? "https://owner-coach.example" : "${MM_URL}");
    expect(accounts["alice-proj-orbit"].baseUrl).toBe(gatewayClass === "isolated" ? "https://owner-orbit.example" : "${MM_URL}");
    expect(accounts["alice-proj-scout"].baseUrl).toBe("${MM_URL}");
  });

  it.each(["isolated", "shared"])("seeds a new %s project agent with the platform default and its fallbacks", async (gatewayClass) => {
    vi.stubEnv("GATEWAY_CLASS", gatewayClass);
    stubUserClaim(gatewayClass === "isolated" ? "alice" : "");
    const platformDefault = {
      primary: "platform-openai/gpt-6.1-terra",
      fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
    };
    const snapshot = aliceSnapshot({
      planInputs: { tier: "trial", selectedTier: "personal" },
      builderAgentDefault: platformDefault,
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "orbit-pat", status: "ready" }],
    });
    const config = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    let patch: Record<string, any> | undefined;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch(config) as Record<string, any>;
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(rosterRpc(config)), log: vi.fn(),
      isIsolatedGateway: () => gatewayClass === "isolated",
    });

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "default-agent-pat" });

    expect(patch!.agents.entries["octogee-alice-proj-orbit-coach"].model).toEqual(platformDefault);
  });

  it("seeds a new house-only project agent with the compiled agent model, never the platform default", async () => {
    installUserEntitlementsForTest(houseOnlyUserEntitlements);
    vi.stubEnv("GATEWAY_CLASS", "isolated");
    stubUserClaim("alice");
    const snapshot = aliceSnapshot({
      planInputs: { tier: "free", selectedTier: "free" },
      builderAgentDefault: {
        primary: "platform-openai/gpt-6.1-terra",
        fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
      },
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "orbit-pat", status: "ready" }],
    });
    const config = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    let patch: Record<string, any> | undefined;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch(config) as Record<string, any>;
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(rosterRpc(config)), log: vi.fn(),
      isIsolatedGateway: () => true,
    });

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "default-agent-pat" });

    expect(patch!.agents.entries["octogee-alice-proj-orbit-coach"].model).toBe(DEFAULT_USER_AGENT_MODEL_REF);
  });

  it("retains a ready project agent when restoring a seeded migration snapshot", async () => {
    const projectId = "octogee-alice-proj-orbit-coach";
    const snapshot = aliceSnapshot({
      status: "complete",
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", status: "ready" }],
    });
    const config = { agents: { entries: {
      "octogee-alice-coach": { workspace: path.join(testRuntime.dir, "customers/alice"), agentDir: path.join(testRuntime.dir, "agents/octogee-alice-coach/agent") },
      [projectId]: { workspace: path.join(testRuntime.dir, "customers/alice/projects/orbit"), agentDir: path.join(testRuntime.dir, "agents", projectId, "agent") },
    } } };
    const rpc = mkGatewayRpc(rosterRpc(config));
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    adapter.seedUserSnapshotForMigration!(snapshot);
    let patch: Record<string, any>;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch(config) as Record<string, any>;
      return { mode: "rpc", attempts: 1 };
    });

    await adapter.applyAddUserConfigPatch(snapshot, null);

    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect(patch!.agents.entries).toHaveProperty(projectId);
    expect(patch!.channels.mattermost.accounts).toHaveProperty("alice-proj-orbit");
    expect(patch!.bindings).toContainEqual({
      agentId: projectId,
      match: { channel: "mattermost", accountId: "alice-proj-orbit", peer: { kind: "group", id: "orbit-general" } },
    });
  });

  it.each([
    { mode: "mount", failPublication: false, initial: false }, { mode: "configured user", failPublication: false, initial: false },
    { mode: "mount", failPublication: true, initial: false }, { mode: "configured user", failPublication: true, initial: false },
    { mode: "mount", failPublication: false, initial: true }, { mode: "configured user", failPublication: false, initial: true },
    { mode: "mount", failPublication: false, failFinalization: true, initial: false },
    { mode: "configured user", failPublication: false, failFinalization: true, initial: false },
  ])("exports only after $mode project publication settles (failed: $failPublication, initial: $initial, finalization failed: $failFinalization)", async ({ mode, failPublication, failFinalization, initial }) => {
    const { updateMattermostAccountSecrets } = await vi.importActual<typeof import("../lib/mattermost-account-secrets.js")>("../lib/mattermost-account-secrets.js");
    const snapshot = aliceSnapshot({ status: "complete", channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }], projectAgents: [{
      projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning",
    }] });
    const userDefaultAgentId = "octogee-alice-coach";
    const projectId = "octogee-alice-proj-orbit-coach";
    let config: Record<string, any> = {
      agents: { entries: { [userDefaultAgentId]: { workspace: path.join(testRuntime.dir, "customers/alice"), agentDir: path.join(testRuntime.dir, "agents", userDefaultAgentId, "agent") } } },
      channels: { mattermost: { accounts: { "alice-coach": {
        botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-coach" }, allowFrom: [ALICE_OWNER_MM_ID],
      } } } },
      bindings: [{ agentId: userDefaultAgentId, match: { channel: "mattermost", accountId: "alice-coach" } }],
    };
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    await updateMattermostAccountSecrets(testRuntime.dir, { set: { "alice-coach": "default-agent-pat" } });
    const fingerprints = new Map(initial ? [] : [["alice", "stable-before-project"]]);
    const fingerprintPath = path.join(testRuntime.dir, "applied-fingerprints.json");
    saveAppliedFingerprints(fingerprintPath, fingerprints);
    const hooks = createReconcileConvergenceHooks({
      userSource: async () => new Map([...fingerprints].map(([slug, fingerprint]) => [slug, { fingerprint, lane: "move" as const }])),
      appliedFp: fingerprints,
      cloneRetry: new Map(),
      persistAppliedFp: () => saveAppliedFingerprints(fingerprintPath, fingerprints),
    });
    let releasePublication!: () => void;
    const runtimePublication = {
      settled: new Promise<void>((resolve) => { releasePublication = resolve; }),
      invalidateFingerprint: () => hooks.recordApplied("alice", ""),
    };
    secretMocks.updateMattermostAccountSecrets.mockImplementation(updateMattermostAccountSecrets);
    secretMocks.exportActivationManifestWithSecret.mockClear();
    let releaseProfiles!: () => void;
    const profiles = new Promise<void>((resolve) => { releaseProfiles = resolve; });
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockImplementationOnce(async () => {
      await profiles;
      return { materialized: 1, deferred: [] };
    });
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot(config)),
      agentsCreate: vi.fn(async ({ name, workspace }) => {
        if (!config.agents.entries[name]) {
          config.agents.entries[name] = { workspace, agentDir: path.join(testRuntime.dir, "agents", name, "agent") };
          await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
        }
        return { ok: true, agentId: name, name, workspace };
      }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [
        { accountId: "alice-proj-orbit", running: true, connected: true, lastStartAt: 2 },
      ] } })),
    });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      if (failPublication) throw new Error("project configuration refused");
      const patch = args.buildPatch(config) as Record<string, any>;
      config = {
        ...config,
        agents: { ...config.agents, entries: { ...config.agents.entries, ...patch.agents.entries } },
        channels: { mattermost: { accounts: { ...config.channels.mattermost.accounts, ...patch.channels.mattermost.accounts } } },
        bindings: patch.bindings,
      };
      await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });
    const publishing = mode === "mount"
      ? adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "default-agent-pat" }, { runtimePublication })
      : adapter.reconcileConfiguredUserProjectAgents!(snapshot, { runtimePublication });
    const publicationResult = publishing.then((result) => result, (error) => error);
    let exported: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(config.agents.entries[projectId]).toBeDefined());
      expect(config.channels.mattermost.accounts["alice-proj-orbit"]).toBeUndefined();
      exported = adapter.exportOpenClawActivationManifest!("alice").then((value) => value, (error) => error);
      expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
    } finally {
      releaseProfiles();
      const result = await publicationResult;
      secretMocks.updateMattermostAccountSecrets.mockReset().mockResolvedValue({ changed: true });
      try {
        expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
        if (failPublication) expect(result).toMatchObject({ message: "project configuration refused" });
        else {
          const finalizing = finalizeConvergedMount({
            now: 1_000, slug: "alice", uid: "uid-alice", prior: undefined,
            desiredFingerprint: snapshotConfigFingerprint(snapshot),
            result: { ...result, pendingProjectClones: [] }, hooks,
            stampMounted: async () => {
              expect(secretMocks.exportActivationManifestWithSecret).not.toHaveBeenCalled();
              if (failFinalization) throw new Error("mount stamp failed");
            },
            writeMountMarker: vi.fn(),
          });
          if (failFinalization) await expect(finalizing).rejects.toThrow("mount stamp failed");
          else await finalizing;
        }
      } finally {
        releasePublication();
      }
    }
    if (failPublication || failFinalization) {
      await expect(exported).resolves.toMatchObject({ message: expect.stringContaining("no applied fingerprint") });
      return;
    }
    await expect(exported).resolves.toMatchObject({
      slug: "alice", appliedFingerprint: snapshotConfigFingerprint(snapshot), mattermostAccount: { botToken: "default-agent-pat" },
      projectAgents: [{ agentId: projectId, accountId: "alice-proj-orbit", mattermostAccount: { botToken: "project-pat" } }],
    });
  });

  it.each([
    ["User", "alice", [`mattermost:${ALICE_OWNER_MM_ID}`]],
    ["shared", "", undefined],
  ] as const)("names the owner as the native OpenClaw command owner only on a %s gateway", async (_label, builderSlug, ownerAllowFrom) => {
    stubUserClaim(builderSlug);
    const snapshot = aliceSnapshot();
    let patch: { commands?: { ownerAllowFrom?: unknown } } | undefined;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch({}) as typeof patch;
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(rosterRpc({})),
      log: vi.fn(),
    });

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    expect(patch?.commands?.ownerAllowFrom).toEqual(ownerAllowFrom);
  });

  it("reports project readiness after reloading credentials and activating routing", async () => {
    const events: string[] = [];
    const snapshot = aliceSnapshot({
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
    });
    const agentId = "octogee-alice-proj-orbit-coach";
    const match = { channel: "mattermost", accountId: "alice-proj-orbit" };
    const config = {
      agents: { entries: { [agentId]: { id: agentId } } },
      channels: { mattermost: { accounts: { "alice-proj-orbit": {} } } },
      bindings: [{ agentId, match }, { agentId, match: { ...match, peer: { kind: "group", id: "orbit-general" } } }],
    };
    routingActivationMocks.activateAfterPatch.mockImplementationOnce(async () => { events.push("routing"); });
    const rpc = mkGatewayRpc({
      ...rosterRpc(config),
      secretsReload: vi.fn(async () => { events.push("secrets"); return { ok: true, warningCount: 0 }; }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: true, connected: true, lastStartAt: 2 }] } })),
    });
    const client = mkClient({
      userSnapshot: vi.fn(async () => snapshot),
      reportProjectAgentReadiness: vi.fn(async () => { events.push("report"); }),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });
    expect(events).toEqual(["secrets", "routing", "report"]);
    expect(client.reportProjectAgentReadiness).toHaveBeenCalledWith("uid-alice", [{
      projectId: "orbit", activationId: "activation-1", tokenHash: expect.any(String), channelIds: ["orbit-general"],
    }]);
  });

  it("stops the superseded secrets.reload wait and skips the second reload when the add mount is cancelled", async () => {
    const snapshot = aliceSnapshot({
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
    });
    const controller = new AbortController();
    const cancelled = new Error("mount deadline exceeded");
    const rpc = mkGatewayRpc({
      ...rosterRpc({}),
      secretsReload: vi.fn(async () => {
        controller.abort(cancelled);
        throw new OpenclawWireError("rpc-error", "secrets.reload failed", { serverCode: "UNAVAILABLE" });
      }),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn(),
    });

    await expect(adapter.applyAddUserConfigPatch(
      snapshot, { _coachPersonalToken: "pat-1" }, { signal: controller.signal },
    )).rejects.toBe(cancelled);

    expect(rpc.secretsReload).toHaveBeenCalledOnce();
  });

  it("reports a connected project even when another routing activation failed", async () => {
    const agentId = "octogee-alice-proj-orbit-coach";
    const match = { channel: "mattermost", accountId: "alice-proj-orbit" };
    const snapshot = aliceSnapshot({
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
    });
    const rpc = mkGatewayRpc({
      ...rosterRpc({ agents: { entries: { [agentId]: {} } }, channels: { mattermost: { accounts: { "alice-proj-orbit": {} } } },
        bindings: [{ agentId, match }, { agentId, match: { ...match, peer: { kind: "group", id: "orbit-general" } } }] }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: true, connected: true, lastStartAt: 2 }] } })),
    });
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    routingActivationMocks.activateAfterPatch.mockRejectedValueOnce(new Error("unrelated account could not connect"));
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await expect(adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" }))
      .rejects.toThrow("unrelated account could not connect");
    expect(client.reportProjectAgentReadiness).toHaveBeenCalledWith("uid-alice", [expect.objectContaining({ projectId: "orbit" })]);
  });

  it.each([
    { mode: "mount", source: "gitea" },
    { mode: "configured user", source: "gitea" },
    { mode: "mount", source: "deferred GitHub" },
    { mode: "configured user", source: "deferred GitHub" },
    { mode: "mount", source: "deferred GitHub", preCutover: true },
  ])("prepares a newly discovered $source checkout before Native initialization during $mode", async ({ mode, source, preCutover }) => {
    if (preCutover) stubUserClaim("alice");
    const projectId = "latecheckout";
    const agentId = `octogee-alice-proj-${projectId}-coach`;
    const github = source === "deferred GitHub";
    const customerDir = path.join(testRuntime.dir, "customers", "alice");
    const checkout = path.join(customerDir, "projects", projectId);
    const workspace = github ? path.join(customerDir, ".system", "project-coaches", projectId) : checkout;
    await fs.rm(workspace, { recursive: true, force: true });
    if (github) restoreDefaultAgentWorkspaces.mockImplementationOnce(async () => {
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(path.join(workspace, "AGENTS.md"), "Private agent instructions");
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", await fs.realpath(testRuntime.dir));
    const initial = aliceSnapshot({ status: "complete", projectAgents: undefined });
    const latest = aliceSnapshot({
      status: "complete",
      projects: [{ projectSlug: projectId, giteaRepoName: source === "gitea" ? "alice-late-checkout" : null,
        ...(source === "gitea" ? {} : { repoSource: { provider: "github" as const, owner: "qa", repo: "late-checkout" } }), provisioningState: "active" }],
      projectAgents: [{ projectId, enabled: true, mmUserId: "bot-late", token: "late-pat", activationId: "late-activation", status: "provisioning", ...(github ? { githubBacked: true } : {}) }],
      channels: [{ scope: "project", projectId, kind: "general", channelId: "late-general" }],
    });
    gitMocks.projectCheckoutMatchesSource.mockImplementation((_slug, id) => id !== projectId || fsSync.existsSync(path.join(checkout, "README.md")));
    gitMocks.userRepositoryHasCanonicalRemote.mockReturnValue(true);
    gitMocks.cloneProjectRepo.mockImplementation(async (_slug, id) => {
      expect(id).toBe(projectId);
      await fs.mkdir(checkout, { recursive: true });
      await fs.writeFile(path.join(checkout, "README.md"), "# Repository source\n");
      return true;
    });
    let config: Record<string, any> = { agents: { entries: {} }, channels: { mattermost: { accounts: {} } }, bindings: [] };
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot(config)),
      agentsCreate: vi.fn(async ({ name, workspace: nativeWorkspace }) => {
        if (name === agentId) {
          if (source === "gitea") expect(await fs.readFile(path.join(nativeWorkspace, "README.md"), "utf8")).toBe("# Repository source\n");
          else expect(await fs.readFile(path.join(nativeWorkspace, "AGENTS.md"), "utf8")).toBe("Private agent instructions");
        }
        return { ok: true as const, agentId: name, name, workspace: nativeWorkspace };
      }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: `alice-proj-${projectId}`, running: true, connected: true, lastStartAt: 2 }] } })),
    });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      const patch = args.buildPatch(config) as Record<string, any>;
      config = { ...config, ...patch, agents: { ...config.agents, ...patch.agents,
        entries: { ...config.agents.entries, ...patch.agents?.entries } },
      channels: { mattermost: { accounts: { ...config.channels.mattermost.accounts, ...patch.channels?.mattermost?.accounts } } } };
      return { mode: "rpc", attempts: 1 };
    });
    const client = mkClient({ userSnapshot: vi.fn(async () => latest) });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn(), isIsolatedGateway: () => preCutover === true, projectCheckoutScope: () => "workspace-and-projects" });
    if (mode === "mount") await adapter.applyAddUserConfigPatch(initial, { _coachPersonalToken: "pat-1" }, preCutover ? { migrationId: "pre-cutover" } : undefined);
    else await adapter.reconcileConfiguredUserProjectAgents!(initial);
    expect(rpc.agentsCreate).toHaveBeenCalledWith({ name: agentId, workspace });
    if (source === "deferred GitHub") {
      expect(gitMocks.cloneProjectRepo).not.toHaveBeenCalled();
      expect(client.githubTokenForSync).not.toHaveBeenCalled();
    }
    expect(client.reportProjectAgentReadiness).toHaveBeenCalledWith("uid-alice", [expect.objectContaining({ projectId })]);
  });

  it("refuses a missing authoritative user snapshot before Native registration", async () => {
    const client = mkClient({ userSnapshot: vi.fn(async () => null) });
    const rpc = mkGatewayRpc();
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await expect(adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" }))
      .rejects.toThrow("User snapshot unavailable for alice");
    expect(rpc.agentsCreate).not.toHaveBeenCalled();
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
  });

  it("uses an authoritative empty project roster instead of reviving stale input agents", async () => {
    const initial = aliceSnapshot({ projectAgents: [{ projectId: "retired", enabled: true, mmUserId: "bot-retired", token: "retired-pat", status: "ready" }] });
    const latest = aliceSnapshot();
    const client = mkClient({ userSnapshot: vi.fn(async () => latest) });
    const rpc = mkGatewayRpc();
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await adapter.applyAddUserConfigPatch(initial, { _coachPersonalToken: "pat-1" });
    expect(rpc.agentsCreate).toHaveBeenCalledOnce();
    expect(rpc.agentsCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "octogee-alice-coach" }));
    expect(gitMocks.cloneProjectRepo).not.toHaveBeenCalled();
    expect(client.reportProjectAgentReadiness).not.toHaveBeenCalled();
  });

  it.each(["mount", "configured user"] as const)("refuses an unprepared fresh project before changing Native runtime during %s", async (mode) => {
    const snapshot = aliceSnapshot({
      projects: [{ projectSlug: "unavailable", giteaRepoName: "alice-unavailable", provisioningState: "active" }],
      projectAgents: [{ projectId: "unavailable", enabled: true, mmUserId: "bot-unavailable", token: "project-pat", status: "provisioning" }],
    });
    const config = { agents: { entries: { "octogee-alice-coach": { workspace: "/owner/workspace", tools: { allow: ["owner-tool"] }, identity: { name: "Owner agent" } } } } };
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    gitMocks.projectCheckoutMatchesSource.mockReturnValue(false);
    gitMocks.cloneProjectRepo.mockRejectedValue(new Error("repository unavailable"));
    const rpc = mkGatewayRpc(rosterRpc(config));
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn(), projectCheckoutScope: () => "workspace-and-projects" });

    const update = mode === "mount"
      ? adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" })
      : adapter.reconcileConfiguredUserProjectAgents!(snapshot);
    await expect(update).rejects.toThrow("Project checkout is not ready for Native agent registration: unavailable");

    expect(JSON.parse(await fs.readFile(OPENCLAW_CONFIG, "utf8"))).toEqual(config);
    expect(rpc.agentsCreate).not.toHaveBeenCalled();
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(client.reportProjectAgentReadiness).not.toHaveBeenCalled();
  });

  it.each([true, false])("distinguishes pending checkout from authoritative project retirement (enabled: %s)", async (enabled) => {
    const agentId = "octogee-alice-proj-orbit-coach";
    const project = { workspace: "/owner/project", tools: { allow: ["owner-tool"] }, identity: { name: "Project owner" } };
    let config: Record<string, any> = { agents: { entries: { [agentId]: project } }, channels: { mattermost: { accounts: { "alice-proj-orbit": { botToken: "owner-token", baseUrl: "https://owner.example" } } } }, bindings: [] };
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [{ projectId: "orbit", enabled, mmUserId: "bot-orbit", token: "project-pat", status: "ready" }] });
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot(config)),
      agentsDelete: vi.fn(async ({ agentId: removed }) => {
        delete config.agents.entries[removed];
        return { ok: true as const, agentId: removed, removedBindings: 0 };
      }),
    });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      config = mergePatch(config, args.buildPatch(config));
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });

    const result = await adapter.reconcileConfiguredUserProjectAgents!(snapshot, { withoutProjectIds: ["orbit"] });

    expect(result.appliedFingerprint).toBeUndefined();
    expect(rpc.agentsCreate).not.toHaveBeenCalled();
    if (!enabled) {
      expect(rpc.agentsDelete).toHaveBeenCalledWith({ agentId, deleteFiles: false });
      expect(rpc.channelsStop).toHaveBeenCalledWith({ channel: "mattermost", accountId: "alice-proj-orbit" });
      expect(config.agents.entries).not.toHaveProperty(agentId);
      expect(config.channels.mattermost.accounts).not.toHaveProperty("alice-proj-orbit");
      return;
    }
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(config.agents.entries[agentId]).toMatchObject({ workspace: project.workspace, tools: project.tools });
    expect(config.channels.mattermost.accounts["alice-proj-orbit"]).toMatchObject({ botToken: "owner-token", baseUrl: "https://owner.example" });
  });

  it.each([false, true])("reconciles a configured user project without changing its owner (already rostered: %s)", async (rostered) => {
    const snapshot = aliceSnapshot({
      status: "complete",
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
    });
    const defaultAgent = { model: "owner-model", tools: { allow: ["owner-tool"] }, workspace: "/owner/workspace" };
    const projectAgentId = "octogee-alice-proj-orbit-coach";
    let deleted = rostered;
    let config: Record<string, any> = {
      agents: { entries: {
        "octogee-alice-coach": defaultAgent,
        ...(rostered ? { [projectAgentId]: { workspace: path.join(testRuntime.dir, "customers/alice/projects/orbit") } } : {}),
      }, defaults: { model: "owner-default" } },
      channels: { mattermost: { accounts: { "alice-coach": { botToken: "owner-coach-token" } } } },
      bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
    };
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot(config)),
      agentsCreate: vi.fn(async ({ name, workspace }) => {
        deleted = false;
        if (rostered) throw new OpenclawWireError("rpc-error", `agent "${name}" already exists`);
        return { ok: true, agentId: name, name, workspace };
      }),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId: "alice-proj-orbit", running: true, connected: true, lastStartAt: 2 }] } })),
    });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      if (deleted) throw new Error("agent database is unavailable while agent is deleted");
      const patch = args.buildPatch(config) as Record<string, any>;
      config = {
        ...config,
        agents: { ...config.agents, entries: { ...config.agents.entries, ...patch.agents.entries } },
        channels: { mattermost: { accounts: Object.fromEntries(Object.entries({ ...config.channels.mattermost.accounts, ...patch.channels.mattermost.accounts })
          .map(([accountId, account]) => [accountId, { ...config.channels.mattermost.accounts[accountId], ...(account as object) }])) } },
        bindings: patch.bindings,
      };
      return { mode: "rpc", attempts: 1 };
    });
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await adapter.reconcileConfiguredUserProjectAgents!(snapshot);
    expect(config.agents.entries["octogee-alice-coach"]).toEqual(defaultAgent);
    expect(config.agents.defaults).toEqual({ model: "owner-default" });
    expect(config.channels.mattermost.accounts["alice-coach"]).toEqual({ botToken: "owner-coach-token", allowFrom: [ALICE_OWNER_MM_ID] });
    expect(config.agents.entries["octogee-alice-proj-orbit-coach"]).toMatchObject({ workspace: expect.stringContaining("/projects/orbit") });
    expect(rpc.agentsCreate).toHaveBeenCalledExactlyOnceWith({
      name: projectAgentId, workspace: expect.stringContaining("/projects/orbit"),
    });
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect(routingActivationMocks.activate).toHaveBeenCalledWith(rpc, expect.any(String), expect.any(Function), { restartAccountIds: ["alice-proj-orbit"] });
    expect(client.reportProjectAgentReadiness).toHaveBeenCalledWith("uid-alice", [expect.objectContaining({ projectId: "orbit", activationId: "activation-1" })]);
  });

  it("withholds project readiness while model profile materialization is deferred", async () => {
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [{
      projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning",
    }] });
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: ["octogee-alice-proj-orbit-coach"] });
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    const rpc = mkGatewayRpc();
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await expect(adapter.reconcileConfiguredUserProjectAgents!(snapshot)).rejects.toThrow("Agent model profiles are not ready");
    expect(client.reportProjectAgentReadiness).not.toHaveBeenCalled();
    expect(routingActivationMocks.activate).not.toHaveBeenCalled();
    expect(rpc.secretsReload).not.toHaveBeenCalled();
  });

  it("withholds initial Project Agent activation while model profiles are deferred", async () => {
    routingActivationMocks.activateAfterPatch.mockClear();
    const snapshot = aliceSnapshot({ projectAgents: [{
      projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning",
    }] });
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: ["octogee-alice-proj-orbit-coach"] });
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    const rpc = mkGatewayRpc(rosterRpc({}));
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    await expect(adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" })).rejects.toThrow("Agent model profiles are not ready");
    expect(client.reportProjectAgentReadiness).not.toHaveBeenCalled();
    expect(routingActivationMocks.activateAfterPatch).not.toHaveBeenCalled();
  });

  it.each([
    ["configured", "config timeout"], ["configured", "secret reload failed"],
    ["initial", "config timeout"], ["initial", "secret reload failed"],
    ["configured", "partial sweep"], ["initial", "partial sweep"],
  ])("retries %s project secrets before readiness after %s", async (phase, failure) => {
    const agentId = "octogee-alice-proj-orbit-coach";
    const accountId = "alice-proj-orbit";
    const match = { channel: "mattermost", accountId };
    const snapshot = aliceSnapshot({
      status: "complete",
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "bot-orbit", token: "project-pat", activationId: "activation-1", status: "provisioning" }],
      channels: [{ scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
    });
    const config = {
      agents: { entries: { "octogee-alice-coach": { workspace: path.join(testRuntime.dir, "customers/alice"), agentDir: path.join(testRuntime.dir, "agents/octogee-alice-coach/agent") }, [agentId]: { workspace: path.join(testRuntime.dir, "customers/alice/projects/orbit"), agentDir: path.join(testRuntime.dir, "agents", agentId, "agent") } } },
      channels: { mattermost: { accounts: { "alice-coach": { allowFrom: [ALICE_OWNER_MM_ID] }, [accountId]: {} } } },
      bindings: [{ agentId, match }, { agentId, match: { ...match, peer: { kind: "group", id: "orbit-general" } } }],
    };
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 1, deferred: [] }).mockReturnValueOnce({ materialized: 0, deferred: [] }).mockReturnValueOnce({ materialized: 0, deferred: [] });
    if (failure === "partial sweep") {
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReset();
      brokerCatalogMocks.materializeBrokerProfilesForAgents
        .mockReturnValueOnce({ materialized: 1, deferred: [agentId] })
        .mockReturnValue({ materialized: 0, deferred: [] });
    }
    secretMocks.updateMattermostAccountSecrets.mockResolvedValue({ changed: false });
    patchMocks.applyConfigPatch.mockImplementation(async (args) => {
      args.buildPatch(config);
      return { mode: "rpc", attempts: 1, noop: true };
    });
    if (failure === "config timeout") patchMocks.applyConfigPatch.mockRejectedValueOnce(new Error(failure));
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot(config)),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [{ accountId, running: true, connected: true, lastStartAt: 2 }] } })),
    });
    if (failure === "secret reload failed") rpc.secretsReload = vi.fn().mockRejectedValueOnce(new Error(failure)).mockResolvedValue({ ok: true });
    const client = mkClient({ userSnapshot: vi.fn(async () => snapshot) });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
    const reconcile = () => phase === "initial"
      ? adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" })
      : adapter.reconcileConfiguredUserProjectAgents!(snapshot);

    await expect(reconcile()).rejects.toThrow(failure === "partial sweep" ? "Agent model profiles are not ready" : failure);
    expect(client.reportProjectAgentReadiness).not.toHaveBeenCalled();
    rpc.secretsReload.mockClear();
    await reconcile();

    expect(rpc.secretsReload).toHaveBeenCalledOnce();
    expect(rpc.secretsReload.mock.invocationCallOrder[0]).toBeLessThan(client.reportProjectAgentReadiness.mock.invocationCallOrder[0]);
    rpc.secretsReload.mockClear();
    await reconcile();
    expect(rpc.secretsReload).not.toHaveBeenCalled();
    secretMocks.updateMattermostAccountSecrets.mockResolvedValue({ changed: true });
    patchMocks.applyConfigPatch.mockImplementation(async () => ({ mode: "rpc", attempts: 1 }));
  });

  it("removes a retired project account from config and secrets before deleting its agent", async () => {
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [], channels: [] });
    const retiredAgentId = "octogee-alice-proj-old-coach";
    const retiredAccountId = "alice-proj-old";
    let config: Record<string, any> = {
      agents: { entries: {
        "octogee-alice-coach": { model: "owner-model" },
        [retiredAgentId]: { workspace: path.join(testRuntime.dir, "customers/alice/projects/old") },
      } },
      channels: { mattermost: { accounts: {
        "alice-coach": { botToken: "owner-coach-token", allowFrom: [ALICE_OWNER_MM_ID] },
        [retiredAccountId]: { botToken: mattermostAccountSecretRef(retiredAccountId) },
      } } },
      bindings: [
        { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } },
        { agentId: retiredAgentId, match: { channel: "mattermost", accountId: retiredAccountId } },
      ],
    };
    const rpc = mkGatewayRpc({
      configGet: vi.fn(async () => configSnapshot(config)),
      channelsStatus: vi.fn(async () => ({ channelAccounts: { mattermost: [] } })),
    });
    let patch: Record<string, any> | undefined;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch(config) as Record<string, any>;
      const accounts = { ...config.channels.mattermost.accounts, ...patch.channels.mattermost.accounts };
      for (const [accountId, account] of Object.entries(accounts)) if (account === null) delete accounts[accountId];
      config = { ...config, channels: { mattermost: { accounts } }, bindings: patch.bindings };
      return { mode: "rpc", attempts: 1 };
    });
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });

    await adapter.reconcileConfiguredUserProjectAgents!(snapshot);

    expect(patch!.channels.mattermost.accounts[retiredAccountId]).toBeNull();
    expect(config.channels.mattermost.accounts[retiredAccountId]).toBeUndefined();
    expect(rpc.agentsDelete).toHaveBeenCalledExactlyOnceWith({ agentId: retiredAgentId, deleteFiles: false });
    const deletedAt = vi.mocked(rpc.agentsDelete).mock.invocationCallOrder[0]!;
    expect(patchMocks.applyConfigPatch.mock.invocationCallOrder[0]).toBeLessThan(deletedAt);
    expect(rpc.channelsStop).toHaveBeenCalledExactlyOnceWith({ channel: "mattermost", accountId: retiredAccountId });
    expect(vi.mocked(rpc.channelsStop).mock.invocationCallOrder[0]).toBeLessThan(deletedAt);
    const removal = secretMocks.updateMattermostAccountSecrets.mock.calls.findIndex(
      ([, change]) => (change as { remove?: string[] }).remove?.includes(retiredAccountId),
    );
    expect(removal).toBeGreaterThanOrEqual(0);
    expect(secretMocks.updateMattermostAccountSecrets.mock.invocationCallOrder[removal]).toBeLessThan(deletedAt);
  });

  it("routes a new workspace session on a configured user without platform projects", async () => {
    secretMocks.updateMattermostAccountSecrets.mockClear();
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [], channels: [
      { scope: "workspace", kind: "general", channelId: "general-channel" },
      { scope: "workspace", kind: "session", channelId: "task-channel" },
      { scope: "workspace", kind: "admin", channelId: "admin-channel" },
      { scope: "project", kind: "general", projectId: "disabled", channelId: "disabled-project-channel" },
    ] });
    const defaultAgent = { model: "owner-model", tools: { allow: ["owner-tool"] } };
    const customRoute = { agentId: "owner-agent", match: { channel: "mattermost", accountId: "alice-coach", peer: { kind: "group", id: "general-channel" } } };
    const config = {
      agents: { entries: { "octogee-alice-coach": defaultAgent } },
      commands: { ownerAllowFrom: [`mattermost:${ALICE_OWNER_MM_ID}`] },
      channels: { mattermost: { accounts: { "alice-coach": { botToken: "owner-coach-token", allowFrom: [ALICE_OWNER_MM_ID] } } } },
      bindings: [customRoute],
    };
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const rpc = mkGatewayRpc(rosterRpc(config));
    let patch: unknown;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      patch = args.buildPatch(config);
      expect(args.buildReplacePaths?.(config)).toEqual(["bindings"]);
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });

    const result = await adapter.reconcileConfiguredUserProjectAgents!(snapshot);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledOnce();
    expect(patch).toEqual({ bindings: [customRoute, {
      agentId: "octogee-alice-coach",
      match: { channel: "mattermost", accountId: "alice-coach", peer: { kind: "group", id: "task-channel" } },
    }] });
    expect(result.appliedFingerprint).toBe(snapshotConfigFingerprint(snapshot));
    expect(rpc.agentsCreate).not.toHaveBeenCalled();
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect(secretMocks.updateMattermostAccountSecrets).not.toHaveBeenCalled();
  });

  it("makes the owner the native OpenClaw owner on a configured user without platform projects", async () => {
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [] });
    const defaultAgentAccount = { botToken: "owner-coach-token", dmPolicy: "disabled", groupPolicy: "open" };
    const config = {
      agents: { entries: { "octogee-alice-coach": {} } },
      channels: { mattermost: { accounts: { "alice-coach": defaultAgentAccount } } },
      bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
    };
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const rpc = mkGatewayRpc(rosterRpc(config));
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      expect(args.buildPatch(config)).toEqual({
        commands: { ownerAllowFrom: [`mattermost:${ALICE_OWNER_MM_ID}`] },
        channels: { mattermost: { accounts: { "alice-coach": { allowFrom: [ALICE_OWNER_MM_ID] } } } },
      });
      return { mode: "rpc", attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });

    await adapter.reconcileConfiguredUserProjectAgents!(snapshot);

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledOnce();
  });

  it("discovers deleted platform projects from authored config despite RPC secret redaction and retires runtime before credentials", async () => {
    const events: string[] = [];
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [] });
    const orphanId = "octogee-alice-proj-deleted-coach";
    const importedId = "octogee-alice-proj-imported-coach";
    const config = {
      agents: { entries: { [orphanId]: { id: orphanId }, [importedId]: { id: importedId } } },
      channels: { mattermost: { accounts: {
        "alice-proj-deleted": { botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-proj-deleted" } },
        "alice-proj-imported": { botToken: { source: "file", provider: "octogee-mattermost", id: "/owner-custom" } },
      } } },
      bindings: [
        { agentId: orphanId, match: { channel: "mattermost", accountId: "alice-proj-deleted" } },
        { agentId: orphanId, match: { channel: "mattermost", accountId: "alice-proj-deleted", peer: { kind: "group", id: "deleted-channel" } } },
        { agentId: importedId, match: { channel: "mattermost", accountId: "alice-proj-imported" } },
      ],
    };
    await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
    await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    const redacted = structuredClone(config);
    for (const account of Object.values(redacted.channels.mattermost.accounts)) {
      account.botToken.id = "__OPENCLAW_REDACTED__";
    }
    const rpc = mkGatewayRpc(rosterRpc(redacted));
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      const patch = args.buildPatch(config) as Record<string, any>;
      expect(patch.channels.mattermost.accounts).toEqual({ "alice-proj-deleted": null });
      expect(patch.bindings).toEqual([config.bindings[2]]);
      events.push("patch");
      return { mode: "rpc", attempts: 1 };
    });
    secretMocks.updateMattermostAccountSecrets.mockImplementationOnce(async () => ({ changed: true }))
      .mockImplementationOnce(async (_dir, change) => {
        expect(change.remove).toEqual(["alice-proj-deleted"]);
        events.push("remove-secret");
        return { changed: true };
      });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });
    await adapter.reconcileConfiguredUserProjectAgents!(snapshot);
    expect(rpc.agentsDelete).toHaveBeenCalledExactlyOnceWith({ agentId: orphanId, deleteFiles: false });
    expect(rpc.channelsStop).toHaveBeenCalledExactlyOnceWith({ channel: "mattermost", accountId: "alice-proj-deleted" });
    expect(events).toEqual(["patch", "remove-secret"]);
  });

  it("refreshes runtime credentials before activating changed routing bindings", async () => {
    const events: string[] = [];
    routingActivationMocks.activate.mockImplementationOnce(async () => {
      events.push("routing-activation");
    });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      events.push("config-patch");
      args.buildPatch({
        agents: { list: [] },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      });
      return { mode: "rpc" as const, attempts: 1 };
    });
    const rpc = {
      channelsStop: vi.fn(async () => {
        events.push("channels-stop");
        return { channel: "mattermost", accountId: "alice-coach", stopped: true };
      }),
      channelsStart: vi.fn(async () => {
        events.push("channels-start");
        return { channel: "mattermost", accountId: "alice-coach", started: true };
      }),
      gatewayRestartRequest: vi.fn(async () => {
        events.push("gateway-restart");
        return { status: "requested" };
      }),
      isGatewayUp: vi.fn(async () => true),
      ...rosterRpc(),
      secretsReload: vi.fn(async () => {
        events.push("secrets-reload");
        return { ok: true, warningCount: 0 };
      }),
    } as unknown as GatewayRpcClient;
    const client = mkClient();
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc,
      log: vi.fn(),
    });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      contextTemplateKey: "default",
      planInputs: { tier: "standard" },
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [
        { scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" },
      ],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-1",
      defaultAgentMmUserId: "mm-alice-coach",
    };

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    expect(client.reconcileProjectAgentMembership).toHaveBeenCalledWith("uid-alice");
    expect(rpc.channelsStop).not.toHaveBeenCalled();
    expect(rpc.channelsStart).not.toHaveBeenCalled();
    expect(routingActivationMocks.activate).toHaveBeenCalledOnce();
    expect(events).toEqual(["config-patch", "secrets-reload", "routing-activation"]);
  });

  describe("mount secrets.reload gate", () => {
    const aliceSnapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      contextTemplateKey: "default",
      planInputs: { tier: "standard" },
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-1",
      defaultAgentMmUserId: "mm-alice-coach",
    };
    const defaultAgentRef = { source: "file", provider: "octogee-mattermost", id: "/alice-coach" };
    const mountedConfig = {
      agents: { list: [{ id: "octogee-alice-coach" }] },
      bindings: [],
      channels: { mattermost: { accounts: { "alice-coach": { botToken: defaultAgentRef } } } },
    };

    function unchangedMountInputs() {
      secretMocks.updateMattermostAccountSecrets.mockResolvedValueOnce({ changed: false });
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: [] });
    }

    function mountAdapter(rpc: ReturnType<typeof rosterRpc>) {
      const log = vi.fn();
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(),
        rpc: { isGatewayUp: vi.fn(async () => true), ...rpc } as unknown as GatewayRpcClient,
        log,
      });
      return { adapter, log };
    }

    it("skips secrets.reload when a remount writes no secret material and patches nothing", async () => {
      unchangedMountInputs();
      patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
        args.buildPatch(mountedConfig);
        return { mode: "rpc" as const, attempts: 1, noop: true };
      });
      const rpc = rosterRpc(mountedConfig);
      const { adapter, log } = mountAdapter(rpc);

      await adapter.applyAddUserConfigPatch(aliceSnapshot, { _coachPersonalToken: "pat-1" });

      expect(rpc.secretsReload).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[add:alice] secrets.reload skipped — no secret material changed");
    });

    it("skips secrets.reload when the config patch touches no SecretRef", async () => {
      unchangedMountInputs();
      const before = { ...mountedConfig, bindings: [] };
      const after = { ...mountedConfig, bindings: [{ agentId: "octogee-alice-coach", match: {} }] };
      patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
        args.buildPatch(before);
        return { mode: "rpc" as const, attempts: 1 };
      });
      const rpc = rosterRpc(after);
      const { adapter, log } = mountAdapter(rpc);

      await adapter.applyAddUserConfigPatch(aliceSnapshot, { _coachPersonalToken: "pat-1" });

      expect(rpc.secretsReload).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[add:alice] secrets.reload skipped — no secret material changed");
    });

    it("reloads when the config patch adds a SecretRef", async () => {
      unchangedMountInputs();
      const before = { ...mountedConfig, channels: { mattermost: { accounts: {} } } };
      patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
        args.buildPatch(before);
        return { mode: "rpc" as const, attempts: 1 };
      });
      const rpc = rosterRpc(mountedConfig);
      const { adapter, log } = mountAdapter(rpc);

      await adapter.applyAddUserConfigPatch(aliceSnapshot, { _coachPersonalToken: "pat-1" });

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        "[add:alice] secrets.reload — SecretRef added at channels.mattermost.accounts.alice-coach.botToken",
      );
    });

    it("reloads when the Mattermost account secrets file changed", async () => {
      secretMocks.updateMattermostAccountSecrets.mockResolvedValueOnce({ changed: true });
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 0, deferred: [] });
      patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
        args.buildPatch(mountedConfig);
        return { mode: "rpc" as const, attempts: 1, noop: true };
      });
      const rpc = rosterRpc(mountedConfig);
      const { adapter, log } = mountAdapter(rpc);

      await adapter.applyAddUserConfigPatch(aliceSnapshot, { _coachPersonalToken: "pat-1" });

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("[add:alice] secrets.reload — Mattermost account secrets file changed");
    });

    it("reloads when broker model profiles were materialized", async () => {
      secretMocks.updateMattermostAccountSecrets.mockResolvedValueOnce({ changed: false });
      brokerCatalogMocks.materializeBrokerProfilesForAgents.mockReturnValueOnce({ materialized: 2, deferred: [] });
      patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
        args.buildPatch(mountedConfig);
        return { mode: "rpc" as const, attempts: 1, noop: true };
      });
      const rpc = rosterRpc(mountedConfig);
      const { adapter, log } = mountAdapter(rpc);

      await adapter.applyAddUserConfigPatch(aliceSnapshot, { _coachPersonalToken: "pat-1" });

      expect(rpc.secretsReload).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith("[add:alice] secrets.reload — broker model profiles materialized for 2 agent(s)");
    });
  });

  it("preserves isolated agent policy while refreshing no-op routing monitors", async () => {
    stubUserClaim("alice");
    routingActivationMocks.pending = true;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      const patch = args.buildPatch({
        agents: { list: [] },
        bindings: [],
        channels: {
          mattermost: {
            accounts: { "alice-coach": { dmPolicy: "open", allowFrom: ["*"] } },
          },
        },
      }) as {
        agents: { list: Array<{ id?: string; tools?: unknown }> };
        channels: { mattermost: { accounts: Record<string, unknown> } };
      };
      expect(
        patch.agents.list.find((agent) => agent.id === "octogee-alice-proj-orbit-coach"),
      ).not.toHaveProperty("tools");
      expect(patch.channels.mattermost.accounts["alice-coach"]).toMatchObject({
        dmPolicy: "disabled",
        allowFrom: [ALICE_OWNER_MM_ID],
        groupPolicy: "open",
        groups: null,
      });
      expect(patch.channels.mattermost.accounts["alice-proj-orbit"]).not.toBeNull();
      return { mode: "rpc", attempts: 1, noop: true };
    });
    const rpc = mkGatewayRpc();
    const client = mkClient({ userSnapshot: vi.fn(async () => aliceSnapshot({
      channels: [{ scope: "workspace", kind: "general", channelId: "workspace-general" }, { scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" }],
      projectAgents: [{ projectId: "orbit", enabled: true, mmUserId: "mm-orbit", token: "pat-orbit" }],
    })) });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc,
      log: vi.fn(),
      isIsolatedGateway: () => true,
    });

    await adapter.applyAddUserConfigPatch(
      aliceSnapshot({
        channels: [
          { scope: "workspace", kind: "general", channelId: "workspace-general" },
          { scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" },
        ],
        projectAgents: [
          { projectId: "orbit", enabled: true, mmUserId: "mm-orbit", token: "pat-orbit" },
        ],
      }),
      { _coachPersonalToken: "pat-1" },
    );

    expect(client.reconcileProjectAgentMembership).toHaveBeenCalledWith("uid-alice");
    expect(routingActivationMocks.stopStale).toHaveBeenCalledWith(
      rpc,
      {
        currentSlug: "alice",
        desiredAccountIds: ["alice-coach", "alice-proj-orbit"],
        evictionSlugs: [],
      },
      expect.any(Function),
    );
    expect(routingActivationMocks.mark).toHaveBeenCalledWith(
      expect.any(String),
      "[add:alice] account-level Mattermost binding changed",
      ["alice-coach", "alice-proj-orbit"],
      { "alice-coach": 0, "alice-proj-orbit": 0 },
    );
    expect(routingActivationMocks.activateAfterPatch).toHaveBeenCalledWith(
      rpc,
      expect.any(String),
      expect.any(Function),
      {
        accountIds: ["alice-coach", "alice-proj-orbit"],
        baseline: { "alice-coach": 0, "alice-proj-orbit": 0 },
        configNoop: true,
        required: true,
        reason: "[add:alice] account-level Mattermost binding changed",
        currentSlug: "alice",
        evictionSlugs: [],
        restartAccountIds: [],
      },
    );
  });

  it("takes shared agent approval authorization from the owner's Mattermost id", async () => {
    const userMmUserId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const brokerSnapshot = aliceSnapshot({
      mattermostUserId: userMmUserId,
      customerMmUserId: userMmUserId,
    });
    const client = mkClient({ userSnapshot: vi.fn(async () => brokerSnapshot) });
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      const patch = args.buildPatch({
        agents: { list: [] },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      }) as {
        channels: { mattermost: { accounts: Record<string, unknown> } };
      };

      expect(patch.channels.mattermost.accounts["alice-coach"]).toMatchObject({
        dmPolicy: "disabled",
        allowFrom: [userMmUserId],
        groupPolicy: "open",
      });
      return { mode: "rpc", attempts: 1, noop: true };
    });

    const adapter = buildBrokeredLifecycleAdapter({ client, rpc: mkGatewayRpc(), log: vi.fn() });

    await adapter.applyAddUserConfigPatch(
      aliceSnapshot({
        mattermostUserId: userMmUserId,
        channels: [{ scope: "workspace", kind: "general", channelId: "workspace-general" }],
      }),
      { _coachPersonalToken: "pat-1" },
    );
  });

  it("holds a project agent out of the patch while its checkout is absent — its workspace dir does not exist yet", async () => {
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args) => {
      const patch = args.buildPatch({
        agents: { list: [] },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      }) as {
        agents: { list: Array<{ id: string }> };
        channels: { mattermost: { accounts: Record<string, unknown> } };
      };
      const ids = patch.agents.list.map((a) => a.id);
      expect(ids).toContain("octogee-alice-coach");
      expect(ids).not.toContain("octogee-alice-proj-orbit");
      expect(patch.channels.mattermost.accounts["alice-proj-orbit"]).toBeUndefined();
      return { mode: "rpc", attempts: 1, noop: true };
    });
    const client = mkClient();
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await adapter.applyAddUserConfigPatch(
      aliceSnapshot({
        channels: [
          { scope: "workspace", kind: "general", channelId: "workspace-general" },
          { scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" },
        ],
        projectAgents: [
          { projectId: "orbit", enabled: true, mmUserId: "mm-orbit", token: "pat-orbit" },
        ],
      }),
      { _coachPersonalToken: "pat-1" },
      { withoutProjectIds: ["orbit"] },
    );

    expect(patchMocks.applyConfigPatch).toHaveBeenCalledOnce();
  });

  it("does not patch one user's runtime when membership isolation fails", async () => {
    const client = mkClient({
      reconcileProjectAgentMembership: vi.fn(async () => {
        throw new Error("Mattermost unavailable");
      }),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await expect(
      adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" }),
    ).rejects.toThrow("Mattermost unavailable");
    expect(patchMocks.applyConfigPatch).not.toHaveBeenCalled();
  });

  it("fails provisioning when the refreshed secret surface remains incomplete", async () => {
    const rpc = mkGatewayRpc({
      secretsReload: vi.fn(async () => ({ ok: false, warningCount: 0 })),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(
      adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" }),
    ).rejects.toThrow(/secrets\.reload did not acknowledge success/);
  });

  it("waits for config persistence before requesting routing activation", async () => {
    const events: string[] = [];
    routingActivationMocks.capture.mockImplementationOnce(async (_rpc, accountIds) => {
      events.push("routing-baseline");
      return Object.fromEntries(accountIds.map((accountId) => [accountId, 0]));
    });
    routingActivationMocks.activate.mockImplementationOnce(async () => {
      events.push("routing-activation");
    });
    let publishConfigChanged: (() => void) | undefined;
    const configChanged = new Promise<void>((resolve) => {
      publishConfigChanged = resolve;
    });
    const rpc = {
      configPatch: vi.fn(async () => {
        events.push("config-persisted");
        return { ok: true as const, hash: "persisted-hash" };
      }),
      configPatchAndWaitForChange: vi.fn(async () => {
        events.push("config-persisted");
        await configChanged;
        events.push("config-changed");
        return { ok: true as const, hash: "persisted-hash" };
      }),
      gatewayRestartRequest: vi.fn(async () => {
        events.push("gateway-restart");
        return { status: "requested" };
      }),
      isGatewayUp: vi.fn(async () => true),
      ...rosterRpc(),
    } as unknown as GatewayRpcClient;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (_args, options) => {
      _args.buildPatch({
        agents: { list: [] },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      });
      await options.rpc.configPatch({}, "base-hash");
      return { mode: "rpc" as const, attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc,
      log: vi.fn(),
    });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      contextTemplateKey: "default",
      planInputs: { tier: "standard" },
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [
        { scope: "project", projectId: "orbit", kind: "general", channelId: "orbit-general" },
      ],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-1",
      defaultAgentMmUserId: "mm-alice-coach",
    };

    const applying = adapter.applyAddUserConfigPatch(
      snapshot,
      { _coachPersonalToken: "pat-1" },
    );
    await vi.waitFor(() => expect(events).toEqual(["routing-baseline", "config-persisted"]));

    publishConfigChanged?.();
    await applying;

    expect(events).toEqual([
      "routing-baseline",
      "config-persisted",
      "config-changed",
      "routing-activation",
    ]);
    expect(rpc.configPatch).not.toHaveBeenCalled();
    expect(rpc.configPatchAndWaitForChange).toHaveBeenCalledOnce();
  });

  it("refuses add publication when the target identity callback denies", async () => {
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: mkGatewayRpc(), log: vi.fn() });
    const beforeRuntimePublish = vi.fn(async () => { throw new Error("target identity authority changed"); });

    await expect(adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" }, { beforeRuntimePublish }))
      .rejects.toThrow("target identity authority changed");
    expect(beforeRuntimePublish).toHaveBeenCalledOnce();
    expect(applyConfigPatch).not.toHaveBeenCalled();
  });

  it("preserves unrelated agents while explicitly confirming the full agent list replacement", async () => {
    installUserEntitlementsForTest(houseOnlyUserEntitlements);
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      contextTemplateKey: "default",
      planInputs: { tier: "standard" },
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-1",
      defaultAgentMmUserId: "mm-alice-coach",
    };

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const call = vi.mocked(applyConfigPatch).mock.calls.at(-1)!;
    const args = call[0] as {
      buildPatch: (current: unknown) => { agents: { list: Array<{ id?: string }> } };
      buildReplacePaths?: (current: unknown) => string[];
    };
    const current = {
      agents: {
        list: [
          { id: "octogee-mac-default" },
          { id: "octogee-alice-coach", stale: true },
          { id: "octogee-bob-coach" },
        ],
      },
      bindings: [],
      channels: {
        mattermost: { accounts: { "alice-coach": { groupAllowFrom: ["mm-1"] } } },
      },
    };

    const patch = args.buildPatch(current);
    expect(patch.agents.list.map((agent) => agent.id)).toEqual([
      "octogee-unmatched-route",
      "octogee-mac-default",
      "octogee-alice-coach",
      "octogee-bob-coach",
    ]);
    const rebuiltDefaultAgent = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach") as
      | { model?: string; memory?: { search?: unknown } }
      | undefined;
    expect(rebuiltDefaultAgent?.model).toEqual({ primary: "platform-openai/gpt-6-luna", fallbacks: [] });
    expect(rebuiltDefaultAgent?.memory?.search).toEqual({
      provider: "openai-compatible",
      remote: {
        baseUrl: "http://llm-broker:3010/v1",
        apiKey: {
          source: "exec",
          provider: "gcp-secret-manager",
          id: "agent-embedding-token-openai-octogee-alice-coach",
        },
      },
      model: "text-embedding-3-small",
    });
    expect(args.buildReplacePaths?.(current)).toEqual(expect.arrayContaining([
      ...userConfigFullAgentListReplacePaths(current, "alice"),
      "plugins.allow", "secrets.providers.gcp-secret-manager.passEnv",
      "agents.defaults.model.fallbacks",
    ]));
  });

  it("pins a subscription-only agent pick to the platform default when mounting on a shared gateway", async () => {
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      contextTemplateKey: "default",
      planInputs: { tier: "trial", selectedTier: "personal" },
      gatewayId: "shared-0",
      status: "provisioning",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      email: "alice@example.com",
      displayName: "Alice",
      lastName: "",
      photoURL: "",
      persona: null,
      coachToken: "pat-1",
      defaultAgentMmUserId: "mm-alice-coach",
      byotActive: false,
      builderAgentDefault: {
        primary: "platform-openrouter/z-ai/glm-5.2",
        fallbacks: [],
      },
      systemConfig: {
        agentModels: { "octogee-alice-coach": { primary: "openai/gpt-5.6-luna", fallbacks: [] } },
      },
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => {
        agents: { list: Array<{ id?: string; model?: unknown }> };
      };
    };
    const patch = args.buildPatch({ agents: { list: [] }, bindings: [] });
    const defaultAgent = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach");

    expect(defaultAgent?.model).toEqual({ primary: "platform-openrouter/z-ai/glm-5.2", fallbacks: [] });
  });

  it("puts a catalog user's final agent model and fallbacks in the initial mount patch", async () => {
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      contextTemplateKey: "default",
      planInputs: { tier: "trial", selectedTier: "personal" },
      gatewayId: "default",
      status: "provisioning",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      email: "alice@example.com",
      displayName: "Alice",
      lastName: "",
      photoURL: "",
      persona: null,
      coachToken: "pat-1",
      defaultAgentMmUserId: "mm-alice-coach",
      byotActive: false,
      builderAgentDefault: {
        primary: "platform-openrouter/openai/gpt-5.6-luna",
        fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
      },
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => {
        agents: {
          defaults?: { models?: Record<string, unknown>; modelPolicy?: unknown };
          list: Array<{ id?: string; model?: unknown }>;
        };
      };
    };
    const patch = args.buildPatch({ agents: { list: [] }, bindings: [] });
    const defaultAgent = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach");

    expect(defaultAgent?.model).toEqual(snapshot.builderAgentDefault);
    expect(patch.agents.defaults?.models).toMatchObject({
      "platform-openrouter/openai/gpt-5.6-luna": canonicalUserModelDefinition("platform-openrouter/openai/gpt-5.6-luna"),
      "platform-openrouter/z-ai/glm-5.2": { alias: "glm", params: { thinking: "xhigh" } },
    });
    expect(patch.agents.defaults?.modelPolicy).toEqual({
      allow: ["anthropic/*", "platform-openrouter/*", "platform-openai/*", "platform-vertex/*"],
    });
  });

  it("puts a house-only agent's final model and tools in the initial mount patch", async () => {
    installUserEntitlementsForTest(houseOnlyUserEntitlements);
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      contextTemplateKey: "free",
      planInputs: { tier: "free", selectedTier: "free" },
      gatewayId: "default",
      status: "provisioning",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      email: "alice@example.com",
      displayName: "Alice",
      lastName: "",
      photoURL: "",
      persona: null,
      coachToken: "pat-1",
      defaultAgentMmUserId: "mm-alice-coach",
      byotActive: false,
      freeTierModelRef: "platform-openrouter/openai/gpt-5.6-luna",
      builderAgentDefault: {
        primary: "platform-openrouter/openai/gpt-5.6-luna",
        fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
      },
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => {
        agents: {
          defaults?: { models?: Record<string, unknown> };
          list: Array<{ id?: string; model?: unknown; tools?: unknown }>;
        };
      };
    };
    const patch = args.buildPatch({ agents: { list: [] }, bindings: [] });
    const defaultAgent = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach");

    expect(defaultAgent?.model).toEqual({ primary: "platform-openrouter/openai/gpt-5.6-luna", fallbacks: [] });
    expect(defaultAgent?.tools).toMatchObject({ profile: "minimal" });
    expect(patch.agents.defaults?.models).toMatchObject({
      "platform-openrouter/openai/gpt-5.6-luna": canonicalUserModelDefinition("platform-openrouter/openai/gpt-5.6-luna"),
    });
  });

  it("re-attach preserves the mounted agent's byot-sync-owned model instead of re-seeding the compiled default", async () => {
    // A byosub user on a shared gateway: the attach path has no default-agent-model
    // selection (byotActive), while byot-sync owns the entry's model. Re-seeding
    // the compiled default string here reverted the sync's {primary, fallbacks}
    // pin on every re-attach — one config write + agent restart per converge,
    // flipped straight back by the sync for a second (observed live 2026-08-14).
    const snapshot = aliceSnapshot({ byotActive: true });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => {
        agents: { entries?: Record<string, { model?: unknown }> };
      };
    };
    const syncOwnedModel = {
      primary: "platform-openrouter/openai/gpt-5.6-luna",
      fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
    };
    const patch = args.buildPatch({
      agents: {
        entries: {
          "octogee-alice-coach": { model: syncOwnedModel },
        },
      },
      bindings: [],
    });

    expect(patch.agents.entries?.["octogee-alice-coach"]?.model).toEqual(syncOwnedModel);
  });

  it("deletes the still-undesired batch's agents, then adds the fresh user in one config mutation", async () => {
    const roster = {
      agents: {
        entries: keyedRoster([
          "octogee-stale-coach",
          "octogee-stale-proj-orbit-coach",
          "octogee-readmitted-coach",
          "octogee-keeper-coach",
        ]),
      },
    };
    const rpc = mkRemovalRpc(roster);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-fresh",
      slug: "fresh",
      contextTemplateKey: "default",
      planInputs: { tier: "standard" },
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: FRESH_OWNER_MM_ID,
      customerMmUserId: FRESH_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Fresh",
      coachToken: "pat-fresh",
      defaultAgentMmUserId: "mm-fresh-coach",
    };
    const currentEvictionBatch = vi.fn(async () => ["stale"]);

    await adapter.applyAddUserConfigPatch(
      snapshot,
      { _coachPersonalToken: "pat-fresh" },
      {
        evictionBatch: ["stale", "readmitted"],
        currentEvictionBatch,
      },
    );

    expect(currentEvictionBatch).toHaveBeenCalledOnce();
    // Only the still-undesired slug departs; the re-admitted one keeps its roster entry.
    expect(vi.mocked(rpc.agentsDelete).mock.calls.map(([params]) => params.agentId)).toEqual([
      "octogee-stale-coach",
      "octogee-stale-proj-orbit-coach",
    ]);
    expect(patchMocks.applyConfigPatch).toHaveBeenCalledTimes(1);
    const args = vi.mocked(applyConfigPatch).mock.calls[0]![0] as {
      buildPatch: (current: unknown) => {
        agents: { list: Array<{ id?: string }> };
        bindings: Array<{ agentId?: string }>;
        channels: { mattermost: { accounts: Record<string, unknown> } };
      };
    };
    // The patch is built against the post-delete roster the gateway now serves.
    const patch = args.buildPatch({
      agents: {
        list: [
          { id: "octogee-readmitted-coach" },
          { id: "octogee-keeper-coach" },
        ],
      },
      bindings: [
        { agentId: "octogee-readmitted-coach" },
        { agentId: "octogee-keeper-coach" },
      ],
      channels: {
        mattermost: {
          accounts: {
            "stale-coach": {},
            "readmitted-coach": {},
            "keeper-coach": {},
          },
        },
      },
    });

    expect(patch.agents.list.map((agent) => agent.id)).toEqual([
      "octogee-unmatched-route",
      "octogee-readmitted-coach",
      "octogee-keeper-coach",
      "octogee-fresh-coach",
    ]);
    expect(patch.bindings).toEqual([
      { agentId: "octogee-readmitted-coach" },
      { agentId: "octogee-keeper-coach" },
      {
        agentId: "octogee-fresh-coach",
        match: { channel: "mattermost", accountId: "fresh-coach" },
      },
    ]);
    expect(patch.channels.mattermost.accounts).toMatchObject({
      "fresh-coach": expect.any(Object),
      "stale-coach": null,
    });
    expect(patch.channels.mattermost.accounts["readmitted-coach"]).toEqual({ dmPolicy: "disabled" });
    expect(secretMocks.updateMattermostAccountSecrets).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        remove: expect.arrayContaining(["stale-coach"]),
        removePrefixes: ["stale-proj-"],
      }),
    );
  });

  it("leaves a user that became pending eviction after admission, while its publication settles, to the next eviction pass", async () => {
    let release!: () => void;
    const lateCustody = new Promise<void>((resolve) => { release = resolve; });
    await openClawRuntimeUpdateGuard.run(async () => undefined, { slug: "late", holdUntil: lateCustody });
    const roster = { agents: { entries: keyedRoster(["octogee-stale-coach", "octogee-late-coach"]) } };
    const rpc = mkRemovalRpc(roster);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-fresh", slug: "fresh", contextTemplateKey: "default", planInputs: { tier: "standard" }, gatewayId: "default", status: "", agentIds: [], repoUrl: "",
      mattermostUserId: FRESH_OWNER_MM_ID, customerMmUserId: FRESH_OWNER_MM_ID, channels: [], projects: [],
      ownerName: "Fresh", coachToken: "pat-fresh", defaultAgentMmUserId: "mm-fresh-coach",
    };
    try {
      await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-fresh" }, {
        evictionBatch: ["stale"],
        currentEvictionBatch: vi.fn(async () => ["stale", "late"]),
      });
    } finally { release(); }

    expect(vi.mocked(rpc.agentsDelete).mock.calls.map(([params]) => params.agentId)).toEqual(["octogee-stale-coach"]);
    const secretWrite = secretMocks.updateMattermostAccountSecrets.mock.calls.at(-1)![1] as { remove: string[]; removePrefixes: string[] };
    expect(secretWrite.remove).not.toContain("late-coach");
    expect(secretWrite.removePrefixes).toEqual(["stale-proj-"]);
    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => { channels: { mattermost: { accounts: Record<string, unknown> } } };
    };
    const patch = args.buildPatch({
      agents: { list: [{ id: "octogee-late-coach" }] },
      bindings: [{ agentId: "octogee-late-coach" }],
      channels: { mattermost: { accounts: { "stale-coach": {}, "late-coach": {} } } },
    });
    expect(patch.channels.mattermost.accounts["stale-coach"]).toBeNull();
    expect(patch.channels.mattermost.accounts["late-coach"]).toEqual({ dmPolicy: "disabled" });
  });

  it("never re-adds a deleted eviction agent to the roster patch", async () => {
    const roster = { agents: { entries: keyedRoster(["octogee-stale-coach"]) } };
    const rpc = mkRemovalRpc(roster);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-fresh",
      slug: "fresh",
      contextTemplateKey: "default",
      planInputs: { tier: "standard" },
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: FRESH_OWNER_MM_ID,
      customerMmUserId: FRESH_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Fresh",
      coachToken: "pat-fresh",
      defaultAgentMmUserId: "mm-fresh-coach",
    };

    await adapter.applyAddUserConfigPatch(
      snapshot,
      { _coachPersonalToken: "pat-fresh" },
      { evictionBatch: ["stale"] },
    );

    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => { agents: { entries: Record<string, unknown> } };
    };
    const patch = args.buildPatch({
      agents: { entries: keyedRoster(["octogee-keeper-coach"]) },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    });

    expect(Object.keys(patch.agents.entries)).toEqual([
      "octogee-unmatched-route",
      "octogee-fresh-coach",
    ]);
  });

  it("deletes the user's own retired project agents before patching — 2026.7.2 refuses a roster drop", async () => {
    const roster = {
      agents: {
        entries: keyedRoster([
          "octogee-alice-coach",
          "octogee-alice-proj-old-coach",
          "octogee-bob-coach",
        ]),
      },
    };
    const rpc = mkRemovalRpc(roster);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyAddUserConfigPatch(aliceSnapshot(), {
      _coachPersonalToken: "pat-1",
    });

    expect(vi.mocked(rpc.agentsDelete).mock.calls.map(([params]) => params.agentId)).toEqual([
      "octogee-alice-proj-old-coach",
    ]);
    const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
      buildPatch: (current: unknown) => { agents: { entries: Record<string, unknown> } };
    };
    const patch = args.buildPatch({
      agents: { entries: keyedRoster(["octogee-alice-coach", "octogee-bob-coach"]) },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    });

    expect(Object.values(patch.agents.entries)).not.toContain(null);
    expect(Object.keys(patch.agents.entries)).toEqual([
      "octogee-unmatched-route",
      "octogee-alice-coach",
    ]);
  });

  it("re-reads the live roster before destructive cleanup instead of trusting a stale patch cache", async () => {
    const liveRoster = { agents: { entries: keyedRoster(["octogee-alice-coach"]) } };
    const configGet = vi.fn(async () => ({ ...configSnapshot(liveRoster), hash: "live-hash" }));
    const rpc = mkRemovalRpc(liveRoster, { configGet } as Partial<GatewayRpcClient>);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    patchMocks.applyConfigPatch.mockImplementationOnce(async (_args, options) => {
      options.cache!.current = {
        agents: {
          entries: keyedRoster([
            "octogee-alice-coach",
            "octogee-alice-proj-now-owned-elsewhere-coach",
          ]),
        },
      };
      options.cache!.hash = "stale-hash";
      return { mode: "rpc" as const, attempts: 1 };
    });

    await adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" });
    await adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" });

    expect(configGet).toHaveBeenCalledTimes(6);
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
  });

  it("creates an agent the roster does not carry yet through agents.create, not the patch alone", async () => {
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster(["octogee-bob-coach"]) } });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyAddUserConfigPatch(aliceSnapshot(), {
      _coachPersonalToken: "pat-1",
    });

    expect(vi.mocked(rpc.agentsCreate).mock.calls.map(([params]) => params)).toEqual([
      { name: "octogee-alice-coach", workspace: expect.stringContaining("customers/alice") },
    ]);
  });

  it.each([false, true])("revives returning agents before applying model secrets and patching (already rostered: %s)", async (rostered) => {
    let deleted = true;
    const agentId = "octogee-alice-coach";
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster(rostered ? [agentId] : []) } }, {
      agentsCreate: vi.fn(async () => {
        deleted = false;
        if (rostered) throw new OpenclawWireError("rpc-error", `agent "${agentId}" already exists`);
        return { ok: true, agentId };
      }),
    });
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockImplementationOnce(() => ({
      materialized: deleted ? 0 : 1,
      deferred: deleted ? [agentId] : [],
    }));
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyAddUserConfigPatch(aliceSnapshot(), {
      _coachPersonalToken: "pat-1",
    });

    expect(deleted).toBe(false);
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect(patchMocks.applyConfigPatch).toHaveBeenCalled();
  });

  it("re-reads the roster after creating, because agents.create rewrites the config", async () => {
    const rpc = mkRemovalRpc({ agents: { entries: {} } });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyAddUserConfigPatch(aliceSnapshot(), {
      _coachPersonalToken: "pat-1",
    });

    const cache = vi.mocked(applyConfigPatch).mock.calls.at(-1)![1] as {
      cache?: { current: unknown; hash: string };
    };
    expect(cache.cache).toEqual({ current: undefined, hash: "" });
  });

  it("resumes an existing agent's pending deletion cleanup, then re-creates it and activates", async () => {
    const agentId = "octogee-alice-coach";
    let resumed = false;
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster([agentId]) } }, {
      agentsCreate: vi.fn(async () => {
        if (!resumed) {
          throw new OpenclawWireError("rpc-error", `agent "${agentId}" deletion cleanup is still pending`);
        }
        return { ok: true, agentId };
      }),
      agentsDelete: vi.fn(async () => {
        resumed = true;
        return { ok: true, agentId, complete: true, removed: [], failed: [] };
      }),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" });

    expect(rpc.agentsDelete).toHaveBeenCalledWith({ agentId, deleteFiles: false });
    expect(rpc.agentsCreate).toHaveBeenCalledTimes(2);
    expect(applyConfigPatch).toHaveBeenCalled();
  });

  it("blocks config activation when the resumed deletion cleanup still cannot complete", async () => {
    const agentId = "octogee-alice-coach";
    const rpc = mkRemovalRpc({ agents: { entries: keyedRoster([agentId]) } }, {
      agentsCreate: vi.fn(async () => {
        throw new OpenclawWireError("rpc-error", `agent "${agentId}" deletion cleanup is still pending`);
      }),
      agentsDelete: vi.fn(async () => ({
        ok: true, agentId, complete: false, removed: [], failed: [], purgeFailed: true,
      })),
    });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });

    await expect(adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" }))
      .rejects.toThrow("native cleanup incomplete: purgeFailed=true");

    expect(applyConfigPatch).not.toHaveBeenCalled();
    expect(rpc.agentsCreate).toHaveBeenCalledTimes(1);
  });

  it("patches beta keyed entries with id-free values and skips foreign agents", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });
    const snapshot = aliceSnapshot();

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const call = vi.mocked(applyConfigPatch).mock.calls.at(-1)!;
    const args = call[0] as {
      buildPatch: (current: unknown) => {
        agents: { entries: Record<string, Record<string, unknown> | null> };
      };
      buildReplacePaths?: (current: unknown) => string[];
    };
    const current = {
      agents: {
        entries: {
          "octogee-ops-eggman": { model: "house" },
          "octogee-alice-coach": { model: "stale" },
        },
      },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    };

    const patch = args.buildPatch(current);
    expect(patch.agents.entries["octogee-alice-coach"]).toMatchObject({
      model: { primary: "platform-openai/gpt-6-luna", fallbacks: [] },
      memory: {
        search: platformOpenAiEmbeddingMemorySearch("octogee-alice-coach"),
      },
    });
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("id");
    expect(patch.agents.entries["octogee-alice-coach"]).not.toHaveProperty("memorySearch");
    expect(patch.agents.entries).not.toHaveProperty("octogee-ops-eggman");
    expect(args.buildReplacePaths?.(current)).toEqual(expect.arrayContaining([
      ...userConfigReplacePaths(current, "alice"),
      "plugins.allow", "agents.entries.octogee-alice-coach.model.fallbacks",
    ]));
  });

  it("declares roster ownership on a shared gateway, which is multi-agent once a user lands", async () => {
    clearUserClaim();
    try {
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(),
        rpc: mkGatewayRpc(),
        log: vi.fn(),
      });

      await adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" });

      const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
        buildPatch: (current: unknown) => { agents: { ownership: string } };
      };
      const patch = args.buildPatch({
        agents: { list: [{ id: "octogee-unmatched-route" }] },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      });

      expect(patch.agents.ownership).toBe("explicit");
    } finally {
      clearUserClaim();
    }
  });

  it("leads a user roster with the configured agent and keeps the auth anchor last during list-roster reconciliation", async () => {
    stubUserClaim("alice");
    try {
      const adapter = buildBrokeredLifecycleAdapter({
        client: mkClient(),
        rpc: mkGatewayRpc(),
        log: vi.fn(),
      });

      await adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" });

      const args = vi.mocked(applyConfigPatch).mock.calls.at(-1)![0] as {
        buildPatch: (current: unknown) => {
          agents: {
            list: Array<Record<string, unknown>>;
            ownership: string;
            defaults: { authInheritance: { agentId: string } };
          };
        };
      };
      const patch = args.buildPatch({
        agents: {
          list: [
            { id: SAFE_DEFAULT_AGENT_ID, name: "old anchor" },
            { id: "octogee-alice-coach", default: true },
            { id: "octogee-bob-coach", model: "foreign" },
          ],
          defaults: { authInheritance: { agentId: "octogee-alice-coach" } },
        },
        bindings: [],
        channels: { mattermost: { accounts: {} } },
      });

      expect(patch.agents.ownership).toBe("explicit");
      expect(patch.agents.defaults.authInheritance).toEqual({ agentId: SAFE_DEFAULT_AGENT_ID });
      expect(patch.agents.list.map((agent) => agent.id)).toEqual([
        "octogee-alice-coach",
        "octogee-bob-coach",
        SAFE_DEFAULT_AGENT_ID,
      ]);
      expect(patch.agents.list.find((agent) => agent.id === "octogee-alice-coach")).not.toHaveProperty(
        "default",
      );
      expect(patch.agents.list).toContainEqual(expect.objectContaining({
        id: "octogee-bob-coach",
        model: "foreign",
      }));
    } finally {
      clearUserClaim();
    }
  });

  it("materializes admitted agents' broker catalogs before config patching, once early materialization settles", async () => {
    const events: string[] = [];
    brokerCatalogMocks.materializeBrokerProfilesForAgents.mockImplementationOnce(() => {
      events.push("materialize");
      return { materialized: 1, deferred: [] };
    });
    patchMocks.applyConfigPatch.mockImplementationOnce(async () => {
      events.push("config-patch");
      return { mode: "rpc" as const, attempts: 1 };
    });
    vi.stubEnv("OPENROUTER_BASE_URL", "http://llm-broker:3010/v1");
    vi.stubEnv("PLATFORM_OPENAI_BASE_URL", "http://llm-broker:3010/v1");
    const roster = rosterRpc();
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc({
        ...roster,
        agentsCreate: vi.fn(async (params: { name: string; workspace: string }) => {
          events.push("agents.create");
          return roster.agentsCreate(params);
        }),
        secretsReload: vi.fn(async () => { events.push("secrets"); return { ok: true, warningCount: 0 }; }),
      }),
      log: vi.fn(),
    });
    const brokerProfilesReady = new Promise<void>((resolve) => setTimeout(() => { events.push("early"); resolve(); }, 5));
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-first",
      slug: "first",
      contextTemplateKey: "default",
      planInputs: { tier: "standard" },
      gatewayId: "default",
      status: "provisioning",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: FIRST_OWNER_MM_ID,
      customerMmUserId: FIRST_OWNER_MM_ID,
      channels: [],
      projects: [],
      projectAgents: [
        { projectId: "orbit", enabled: true, mmUserId: "mm-orbit", token: "pat-orbit" },
        { projectId: "unminted", enabled: true, mmUserId: null, token: null },
        { projectId: "retired", enabled: false, mmUserId: "mm-retired", token: "pat-retired" },
      ],
      ownerName: "First",
      coachToken: "pat-first",
      defaultAgentMmUserId: "mm-first-coach",
    };

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-first" }, { brokerProfilesReady });

    expect(brokerCatalogMocks.materializeBrokerProfilesForAgents).toHaveBeenCalledWith(
      ["octogee-first-coach", "octogee-first-proj-orbit-coach"],
      expect.objectContaining({
        openRouter: expect.objectContaining({ baseUrl: "http://llm-broker:3010/v1" }),
        openAi: expect.objectContaining({ baseUrl: "http://llm-broker:3010/v1" }),
      }),
    );
    expect(events).toEqual(["early", "agents.create", "agents.create", "materialize", "config-patch", "secrets"]);
  });

  it("leaves nothing for the post-mount oauth purge or model override to patch", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://llm-broker:3010");
    const defaultAgent = "octogee-alice-coach";
    const selection = {
      primary: "platform-openrouter/openai/gpt-5.6-luna",
      fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
    };
    const current = {
      agents: {
        ownership: "explicit",
        defaults: {
          model: { primary: "platform-openrouter/deepseek/deepseek-v4-pro", fallbacks: [] },
          models: { "platform-openrouter/deepseek/deepseek-v4-pro": { alias: "deepseek" } },
        },
        entries: {},
      },
      models: { providers: { anthropic: { baseUrl: "http://llm-broker:3010" } } },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    };
    let mountPatch: unknown;
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args: { buildPatch(current: unknown): unknown }) => {
      mountPatch = args.buildPatch(current);
      return { mode: "rpc" as const, attempts: 1 };
    });
    const snapshot = aliceSnapshot({
      contextTemplateKey: "default",
      channels: [{ scope: "workspace", kind: "coach-dm", channelId: "dm-alice" }],
      builderAgentDefault: selection,
      planInputs: {
        tier: "trial",
        trialGrant: {
          schemaVersion: 3,
          offerId: "builder-signup",
          offerVersion: 1,
          personalTier: "personal",
          builderTier: "hobby",
          configHash: "0123456789abcdef",
          claimedAt: Date.now() - 60_000,
          endsAt: Date.now() + 7 * 24 * 60 * 60_000,
        },
      },
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc({ ...rosterRpc(current) }),
      log: vi.fn(),
    });
    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const applied = mergePatch(current, mountPatch) as {
      agents: { entries: Record<string, { model?: unknown }>; defaults: { models: Record<string, unknown> } };
    };
    expect(applied.agents.entries[defaultAgent]?.model).toEqual(selection);
    expect(applied.agents.defaults.models[selection.fallbacks[0]!]).toEqual(
      canonicalUserModelDefinition(selection.fallbacks[0]!),
    );
    const purge = userOauthRuntimeConfigPatch(applied, "alice", selection.primary);
    expect(mergePatchValueAlreadyApplied(applied, purge)).toBe(true);
    const overridePatches: unknown[] = [];
    await applyAgentModelOverrides("alice", { [defaultAgent]: selection }, { houseOnly: false }, {
      applyConfigPatch: (async (args: { buildPatch(current: unknown): unknown }) => {
        overridePatches.push(args.buildPatch(applied));
        return { mode: "rpc" as const, attempts: 1 };
      }) as never,
      logFn: vi.fn(),
    });
    expect(overridePatches).toHaveLength(1);
    expect(mergePatchValueAlreadyApplied(applied, overridePatches[0])).toBe(true);
  });

  it("leaves nothing for the post-mount purge, platform allowlist, or model override to patch when a shared gateway suppresses the owner's byosub", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "http://llm-broker:3010");
    vi.stubEnv("OPENROUTER_BASE_URL", "http://llm-broker:3010/v1");
    vi.stubEnv("PLATFORM_OPENAI_BASE_URL", "http://llm-broker:3010/v1");
    const defaultAgent = "octogee-alice-coach";
    const selection = {
      primary: "platform-openrouter/openai/gpt-5.6-luna",
      fallbacks: ["platform-openrouter/z-ai/glm-5.2"],
    };
    const current = {
      agents: {
        ownership: "explicit",
        defaults: {
          models: {
            "platform-openrouter/deepseek/deepseek-v4-pro": {},
            "openai/gpt-6-astra": { alias: "astra" },
          },
        },
        entries: {},
      },
      models: { providers: { anthropic: { baseUrl: "http://llm-broker:3010" } } },
      plugins: { entries: { codex: { enabled: true } } },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    };
    let mountPatch: unknown;
    let replacePaths: string[] = [];
    patchMocks.applyConfigPatch.mockImplementationOnce(async (args: {
      buildPatch(current: unknown): unknown;
      buildReplacePaths?(current: unknown): string[];
    }) => {
      mountPatch = args.buildPatch(current);
      replacePaths = args.buildReplacePaths?.(current) ?? [];
      return { mode: "rpc" as const, attempts: 1 };
    });
    const snapshot = aliceSnapshot({
      status: "complete",
      contextTemplateKey: "default",
      byotActive: true,
      systemConfig: { byot: { provider: "openai-codex" } },
      channels: [{ scope: "workspace", kind: "coach-dm", channelId: "dm-alice" }],
      builderAgentDefault: selection,
      planInputs: {
        tier: "trial",
        trialGrant: {
          schemaVersion: 3,
          offerId: "builder-signup",
          offerVersion: 1,
          personalTier: "personal",
          builderTier: "hobby",
          configHash: "0123456789abcdef",
          claimedAt: Date.now() - 60_000,
          endsAt: Date.now() + 7 * 24 * 60 * 60_000,
        },
      },
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc({ ...rosterRpc(current) }),
      log: vi.fn(),
    });
    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const applied = mergePatch(current, mountPatch) as {
      agents: { entries: Record<string, { model?: unknown }>; defaults: { models: Record<string, unknown> } };
    };
    expect(applied.agents.entries[defaultAgent]?.model).toEqual(selection);
    expect(replacePaths).toContain("agents.defaults.modelPolicy.allow");
    const purge = userOauthRuntimeConfigPatch(applied, "alice", selection.primary, {
      forceSafeAll: true,
      gatewayEnv: process.env,
    });
    expect(mergePatchValueAlreadyApplied(applied, purge)).toBe(true);
    expect(mergePatchValueAlreadyApplied(applied, platformModelAllowlistPatch(applied, false))).toBe(true);
    const overridePatches: unknown[] = [];
    await applyAgentModelOverrides("alice", { [defaultAgent]: selection }, { houseOnly: false }, {
      applyConfigPatch: (async (args: { buildPatch(current: unknown): unknown }) => {
        overridePatches.push(args.buildPatch(applied));
        return { mode: "rpc" as const, attempts: 1 };
      }) as never,
      logFn: vi.fn(),
    });
    expect(overridePatches).toHaveLength(1);
    expect(mergePatchValueAlreadyApplied(applied, overridePatches[0])).toBe(true);
  });

  it("receipts the post-provision snapshot whose Mattermost identity was applied", async () => {
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      contextTemplateKey: "default",
      gatewayId: "default",
      status: "provisioning",
      agentIds: [],
      repoUrl: "https://gitea.test/octogee/alice-workspace.git",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [{ scope: "coach", kind: "direct", channelId: "dm-alice" }],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-after-provision",
      defaultAgentMmUserId: "mm-alice-coach",
      planInputs: { tier: "pro", trialGrant: { gatewayId: "builder-alice" } },
    };
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });
    adapter.seedUserSnapshotForMigration?.(snapshot);

    const result = await adapter.applyAddUserConfigPatch(
      snapshot,
      { _coachPersonalToken: "pat-after-provision" },
    );

    expect(result.appliedFingerprint).toBe(snapshotConfigFingerprint(snapshot));
  });

  it("rebinds carried-forward agents' shifted platform embedding refs to their OWN agent ids on mount", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      contextTemplateKey: "default",
      planInputs: { tier: "standard" },
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [],
      projects: [],
      ownerName: "Alice",
      coachToken: "pat-1",
      defaultAgentMmUserId: "mm-alice-coach",
    };

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const call = vi.mocked(applyConfigPatch).mock.calls.at(-1)!;
    const args = call[0] as {
      buildPatch: (current: unknown) => {
        agents: { list: Array<{
          id?: string;
          memorySearch?: { remote?: { apiKey?: { id?: string } } };
          memory?: { search?: { remote?: { apiKey?: { id?: string } } } };
        }> };
      };
    };
    const current = {
      agents: {
        list: [
          { id: "octogee-mac-default" },
          {
            id: "octogee-bob-coach",
            memorySearch: platformOpenAiEmbeddingMemorySearch("octogee-tester5-coach"),
          },
        ],
      },
      bindings: [],
      channels: { mattermost: { accounts: {} } },
    };

    const patch = args.buildPatch(current);
    const bob = patch.agents.list.find((agent) => agent.id === "octogee-bob-coach");
    expect(bob?.memorySearch?.remote?.apiKey?.id).toBe(
      platformOpenAiEmbeddingSecretId("octogee-bob-coach"),
    );
    const alice = patch.agents.list.find((agent) => agent.id === "octogee-alice-coach");
    expect(alice?.memory?.search?.remote?.apiKey?.id).toBe(
      platformOpenAiEmbeddingSecretId("octogee-alice-coach"),
    );
  });
});

describe("buildBrokeredLifecycleAdapter byot re-assert (db-less LLM-auth self-heal)", () => {
  beforeEach(() => modelCredentialMocks.syncModelCredentialsForUser.mockClear());
  afterEach(() => vi.unstubAllEnvs());

  function fullSnapshot(overrides: Partial<FleetBrokerUserSnapshot> = {}): FleetBrokerUserSnapshot {
    return {
      uid: "uid-tester10",
      slug: "tester10",
      contextTemplateKey: "default",
      planInputs: { tier: "trial" },
      gatewayId: "default",
      status: "complete",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: null,
      customerMmUserId: null,
      channels: [],
      projects: [],
      ownerName: "Tester",
      email: "",
      displayName: "",
      lastName: "",
      photoURL: "",
      persona: null,
      coachToken: null,
      defaultAgentMmUserId: null,
      ...overrides,
    };
  }

  it("refreshes a prepared user snapshot after the source changes desired configuration", async () => {
    let ownerName = "Before";
    const client = mkClient({ userSnapshot: vi.fn(async () => fullSnapshot({ ownerName })) });
    const adapter = buildBrokeredLifecycleAdapter({ client, rpc: mkGatewayRpc(), log: vi.fn() });
    expect((await adapter.loadUserSnapshot("uid-tester10"))?.ownerName).toBe("Before");
    ownerName = "After";
    expect((await adapter.loadUserSnapshot("uid-tester10", { refresh: true }))?.ownerName).toBe("After");
    expect(client.userSnapshot).toHaveBeenCalledTimes(2);
  });

  it("loadUserSnapshot carries byotActive + systemConfig from the broker snapshot (the in-pod re-assert must see the real BYOT state)", async () => {
    const client = mkClient({
      userSnapshot: vi.fn(async () =>
        fullSnapshot({
          byotActive: true,
          systemConfig: { byot: { provider: "openai", model: "gpt-4o" } },
        }),
      ),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.byotActive).toBe(true);
    expect(snap?.systemConfig).toEqual({ byot: { provider: "openai", model: "gpt-4o" } });
  });

  it("loadUserSnapshot hands the broker snapshot's plan inputs to the lifecycle untouched", async () => {
    const planInputs = { selectedTier: "personal_free", builderSubscription: { tier: "hobby", status: "active" } };
    const client = mkClient({
      userSnapshot: vi.fn(async () => fullSnapshot({ planInputs })),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.planInputs).toBe(planInputs);
    for (const key of ["tier", "selectedTier", "subscription", "builderSubscription", "trialGrant", "signupOfferConvertedAt"]) {
      expect(key in (snap ?? {})).toBe(false);
    }
  });

  it("loadUserSnapshot carries the trial grant into the pod-side lifecycle snapshot", async () => {
    const trialGrant = {
      schemaVersion: 3,
      offerId: "builder-signup",
      offerVersion: 1,
      personalTier: "personal",
      builderTier: "hobby",
      configHash: "config-a",
      claimedAt: { _seconds: 1_783_500_000 },
      endsAt: { _seconds: 1_784_104_800 },
    };
    const client = mkClient({
      userSnapshot: vi.fn(async () => fullSnapshot({ planInputs: { trialGrant } })),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.planInputs.trialGrant).toBe(trialGrant);
  });

  it("loadUserSnapshot carries the free-tier dial ref (the house pin must follow the operator)", async () => {
    const client = mkClient({
      userSnapshot: vi.fn(async () =>
        fullSnapshot({ freeTierModelRef: "platform-openrouter/deepseek/deepseek-v4-pro" }),
      ),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.freeTierModelRef).toBe("platform-openrouter/deepseek/deepseek-v4-pro");
  });

  it("loadUserSnapshot carries projectAgents from the broker snapshot (a re-ensure must see the multi-agent toggle state)", async () => {
    const client = mkClient({
      userSnapshot: vi.fn(async () =>
        fullSnapshot({
          projectAgents: [
            { projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "proj-pat" },
          ],
        }),
      ),
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.projectAgents).toEqual([
      { projectId: "camp", enabled: true, mmUserId: "mm-proj", token: "proj-pat" },
    ]);
  });

  it("seedUserSnapshotForMigration replaces a stale cached snapshot so a re-ensure applies fresh content", async () => {
    // The reconcile's fingerprint source fetches fresh snapshots every tick and seeds
    // them here; without the seed, loadUserSnapshot would serve the boot-time cache
    // forever and a content-drift re-ensure would re-apply stale state while the
    // bookkeeping records the new fingerprint as applied.
    const userSnapshot = vi.fn(async () => fullSnapshot({ projectAgents: [] }));
    const client = mkClient({ userSnapshot });
    const adapter = buildBrokeredLifecycleAdapter({
      client,
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    await adapter.loadUserSnapshot("uid-tester10"); // populates the cache
    adapter.seedUserSnapshotForMigration?.(
      fullSnapshot({
        projectAgents: [{ projectId: "camp", enabled: true, mmUserId: "mm", token: "pat" }],
      }),
    );

    const snap = await adapter.loadUserSnapshot("uid-tester10");
    expect(snap?.projectAgents).toEqual([
      { projectId: "camp", enabled: true, mmUserId: "mm", token: "pat" },
    ]);
    expect(userSnapshot).toHaveBeenCalledTimes(1); // second read served from the seeded cache
  });

  it.each([
    { runtimeScope: "workspace-only", apiScope: "workspace-and-projects", allowed: false },
    { runtimeScope: "workspace-and-projects", apiScope: "workspace-only", allowed: false },
    { runtimeScope: "workspace-and-projects", apiScope: "workspace-and-projects", allowed: true },
  ] as const)("enforces runtime $runtimeScope and API $apiScope on first and cached reads", async ({ runtimeScope, apiScope, allowed }) => {
    const projects = [{ projectSlug: "camp", giteaRepoName: "tester10-camp", provisioningState: "active" }];
    const projectAgents = [{ projectId: "camp", enabled: true, mmUserId: "mm", token: "pat" }];
    const userSnapshot = vi.fn(async () => fullSnapshot({ projectCheckoutScope: apiScope, projects, projectAgents }));
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot }), rpc: mkGatewayRpc(), log: vi.fn(), projectCheckoutScope: () => runtimeScope });
    const first = await adapter.loadUserSnapshot("uid-tester10");
    const cached = await adapter.loadUserSnapshot("uid-tester10");
    expect(first).toEqual(cached);
    expect(first?.projects).toEqual(allowed ? projects : []);
    expect(first?.projectCheckoutScope).toBe(allowed ? "workspace-and-projects" : "workspace-only");
    expect(first?.projectAgents).toEqual(projectAgents);
    expect(userSnapshot).toHaveBeenCalledOnce();
    expect(gitMocks.cloneProjectRepo).not.toHaveBeenCalled();
  });

  it("projects migration snapshots to workspace-only before lifecycle restore and fingerprinting", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
      projectCheckoutScope: () => "workspace-only",
    });
    adapter.seedUserSnapshotForMigration?.(
      fullSnapshot({
        projectCheckoutScope: "workspace-and-projects",
        projects: [
          { projectSlug: "camp", giteaRepoName: "tester10-camp", provisioningState: "active" },
        ],
      }),
    );

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.projectCheckoutScope).toBe("workspace-only");
    expect(snap?.projects).toEqual([]);
  });

  it("defaults migration snapshot projection to workspace-only when runtime scope is absent", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });
    adapter.seedUserSnapshotForMigration?.(
      fullSnapshot({
        projectCheckoutScope: "workspace-and-projects",
        projects: [
          { projectSlug: "camp", giteaRepoName: "tester10-camp", provisioningState: "active" },
        ],
      }),
    );

    const snap = await adapter.loadUserSnapshot("uid-tester10");

    expect(snap?.projectCheckoutScope).toBe("workspace-only");
    expect(snap?.projects).toEqual([]);
  });

  it("reassertByotForUser delegates model config writes through the adapter RPC", async () => {
    const rpc = {} as unknown as GatewayRpcClient;
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc,
      log: vi.fn(),
    });
    const userData = {
      username: "tester10",
      byotActive: false,
      provisioning: { openclaw: { status: "complete" } },
    };

    await adapter.reassertByotForUser(userData);

    expect(modelCredentialMocks.syncModelCredentialsForUser).toHaveBeenCalledTimes(1);
    expect(modelCredentialMocks.syncModelCredentialsForUser).toHaveBeenCalledWith(
      userData,
      expect.objectContaining({
        applyConfigPatch: expect.any(Function),
        refreshDefaultAgentRuntimeSessions: expect.any(Function),
      }),
    );

    const deps = modelCredentialMocks.syncModelCredentialsForUser.mock.calls[0]?.[1];
    await deps.applyConfigPatch({ buildPatch: () => ({}) }, { maxRetries: 2 });

    expect(patchMocks.applyConfigPatch).toHaveBeenLastCalledWith(
      { buildPatch: expect.any(Function) },
      expect.objectContaining({
        maxRetries: 2,
        rpc,
        cache: expect.objectContaining({ current: undefined, hash: "" }),
      }),
    );
  });

  it("shares the lifecycle config cache with model convergence after the mount patch", async () => {
    vi.stubEnv("GATEWAY_ID", "default");
    vi.stubEnv("POD_UID", "cache-test-pod");
    await fs.rm(path.join(testRuntime.dir, activationManifestTarPath("tester10")), { force: true });
    const snapshot = fullSnapshot({
      runtimeMutationFenced: false,
      coachToken: "pat-tester10",
      defaultAgentMmUserId: "mm-tester10-coach",
      mattermostUserId: TESTER_OWNER_MM_ID,
      customerMmUserId: TESTER_OWNER_MM_ID,
    });
    const rpc = mkGatewayRpc();
    patchMocks.applyConfigPatch.mockImplementationOnce(async (_args, options) => {
      if (!options.cache) throw new Error("expected lifecycle config cache");
      options.cache.current = { mounted: snapshot.slug };
      options.cache.hash = "mounted-hash";
      return { mode: "rpc" as const, attempts: 1 };
    });
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({
        userSnapshot: vi.fn(async () => snapshot),
        assignmentRoster: vi.fn(async () => [{ uid: snapshot.uid, state: "serving", epoch: 0 }]),
      }),
      rpc,
      log: vi.fn(),
    });

    await adapter.applyAddUserConfigPatch(snapshot, {
      _coachPersonalToken: snapshot.coachToken,
    });
    const mountOptions = patchMocks.applyConfigPatch.mock.calls.at(-1)?.[1];

    await adapter.reassertByotForUser({
      username: snapshot.slug,
      byotActive: false,
      provisioning: { openclaw: { status: "complete" } },
    });
    const deps = modelCredentialMocks.syncModelCredentialsForUser.mock.calls.at(-1)?.[1];
    await deps.applyConfigPatch({ buildPatch: () => ({}) }, {});
    const modelOptions = patchMocks.applyConfigPatch.mock.calls.at(-1)?.[1];

    expect(mountOptions?.cache).toBeDefined();
    expect(modelOptions?.cache).toBe(mountOptions?.cache);
    expect(modelOptions?.cache).toEqual({
      current: { mounted: snapshot.slug },
      hash: "mounted-hash",
    });
  });

  it.each([true, false])("reports a provisioned user to the fleet broker by uid, first provisioning: %s", async (first) => {
    const reportProvisioned = vi.fn(async () => undefined);
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ reportProvisioned }),
      rpc: {} as unknown as GatewayRpcClient,
      log: vi.fn(),
    });

    await adapter.reportProvisioned({
      uid: "uid-tester10",
      slug: "tester10",
      contextTemplateKey: "default",
      planInputs: { tier: "trial" },
      ownerName: "Tester",
      customerDir: "/home/node/.openclaw/customers/tester10",
      today: "2026-07-24",
      username: "tester10",
      templateVars: {},
      userData: {},
    }, { first });

    expect(reportProvisioned).toHaveBeenCalledWith("uid-tester10", { first });
  });

  it("hands a failed log's status to the gateway's logger so it is written at error", () => {
    const log = vi.fn();
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: {} as unknown as GatewayRpcClient, log });

    adapter.log("provisioned report failed", { status: "failed" });

    expect(log).toHaveBeenCalledExactlyOnceWith("provisioned report failed", { status: "failed" });
  });

  it("gives the lifecycle no community or signup step of its own", () => {
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: {} as unknown as GatewayRpcClient, log: vi.fn() });

    expect(Object.keys(adapter).filter((name) => /community|signup/iu.test(name))).toEqual([]);
  });
});

describe("projectCheckoutScopeForRuntime", () => {
  it("restores project checkouts on a shared runtime", () => {
    expect(projectCheckoutScopeForRuntime("alice", { GATEWAY_CLASS: "shared" })).toBe(
      "workspace-and-projects",
    );
  });

  it("restores project checkouts for the exact configured isolated user", () => {
    expect(projectCheckoutScopeForRuntime("alice", withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "alice"))).toBe("workspace-and-projects");
  });

  it.each([
    ["a mismatched isolated user", "bob", withUserClaim({
      GATEWAY_CLASS: "isolated",
    }, "alice")],
    ["an isolated gateway with no configured slug", "alice", { GATEWAY_CLASS: "isolated" }],
    ["a runtime with no class", "alice", withUserClaim({ }, "alice")],
    ["an unknown runtime class", "alice", withUserClaim({
      GATEWAY_CLASS: "unknown",
    }, "alice")],
  ])("keeps %s workspace-only", (_label, slug, env) => {
    expect(projectCheckoutScopeForRuntime(slug, env)).toBe("workspace-only");
  });
});

describe("buildBrokeredLifecycleAdapter — multi-agent project agents", () => {
  beforeEach(() => {
    patchMocks.applyConfigPatch.mockClear();
  });

  it("partitions bindings, includes active project agents, and nulls stale project accounts", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }),
      rpc: mkGatewayRpc(),
      log: vi.fn(),
    });
    const snapshot: FleetBrokerUserSnapshot = {
      uid: "uid-alice",
      slug: "alice",
      contextTemplateKey: "default",
      planInputs: { tier: "standard" },
      gatewayId: "default",
      status: "",
      agentIds: [],
      repoUrl: "",
      mattermostUserId: ALICE_OWNER_MM_ID,
      customerMmUserId: ALICE_OWNER_MM_ID,
      channels: [
        { scope: "workspace", kind: "general", channelId: "ws-1" },
        { scope: "project", projectId: "orbit", kind: "general", channelId: "po-1" },
        { scope: "project", projectId: "nova", kind: "general", channelId: "pn-1" },
      ],
      projects: [],
      projectAgents: [
        { projectId: "orbit", enabled: true, mmUserId: "bot-1", token: "proj-pat-1" },
        { projectId: "nova", enabled: true, mmUserId: null, token: null },
      ],
      ownerName: "Alice",
      coachToken: "pat-1",
      defaultAgentMmUserId: "mm-alice-coach",
    };

    await adapter.applyAddUserConfigPatch(snapshot, { _coachPersonalToken: "pat-1" });

    const call = vi.mocked(applyConfigPatch).mock.calls.at(-1)!;
    const args = call[0] as {
      buildPatch: (current: unknown) => {
        agents: { list: Array<{ id?: string; workspace?: string; tools?: unknown }> };
        bindings: Array<{ agentId: string; match: { accountId: string; peer: { id: string } } }>;
        channels: {
          mattermost: {
            accounts: Record<string, {
              botToken?: unknown;
              groupPolicy?: string;
              groupAllowFrom?: string[];
              groups?: null;
            } | null>;
          };
        };
      };
    };
    const patch = args.buildPatch({
      agents: { list: [{ id: "octogee-alice-proj-old-coach" }, { id: "octogee-bob-coach" }] },
      bindings: [{ agentId: "octogee-alice-proj-old-coach", match: { accountId: "alice-proj-old", peer: { id: "dead-1" } } }],
      channels: { mattermost: { accounts: { "alice-proj-old": { botToken: "revoked" } } } },
    });

    expect(patch.agents.list.map((a) => a.id)).toEqual([
      "octogee-unmatched-route",
      "octogee-alice-coach",
      "octogee-alice-proj-orbit-coach",
      "octogee-bob-coach",
    ]);
    expect(
      patch.agents.list.find((agent) => agent.id === "octogee-alice-proj-orbit-coach")?.tools,
    ).toMatchObject({ profile: "minimal", exec: { mode: "deny" } });
    expect(
      Object.fromEntries(
        patch.bindings
          .filter((b) => "peer" in b.match)
          .map((b) => [b.match.peer.id, `${b.agentId}|${b.match.accountId}`]),
      ),
    ).toEqual({
      "ws-1": "octogee-alice-coach|alice-coach",
      "po-1": "octogee-alice-proj-orbit-coach|alice-proj-orbit",
    });
    expect(patch.channels.mattermost.accounts["alice-proj-orbit"]?.botToken).toEqual({
      source: "file",
      provider: "octogee-mattermost",
      id: "/alice-proj-orbit",
    });
    expect(patch.channels.mattermost.accounts["alice-proj-orbit"]).toMatchObject({
      dmPolicy: "disabled",
      allowFrom: [ALICE_OWNER_MM_ID],
    });
    expect(patch.channels.mattermost.accounts["alice-coach"]).toMatchObject({
      dmPolicy: "disabled",
      allowFrom: [ALICE_OWNER_MM_ID],
      groupPolicy: "open",
      groups: null,
    });
    expect(patch.channels.mattermost.accounts["alice-proj-old"]).toBeNull();
  });
});

describe("credential runtime reload", () => {


  it("routes the credential re-assert's secrets reload through the adapter rpc", async () => {
    const rpc = mkGatewayRpc({
      secretsReload: vi.fn(async () => ({ ok: true, warningCount: 0 })),
    } as Partial<GatewayRpcClient>);
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const captured = vi.mocked(modelCredentialMocks.syncModelCredentialsForUser);
    captured.mockClear();
    await adapter.reassertByotForUser({} as never);
    const deps = captured.mock.calls[0]![1] as { triggerSecretsReload?: () => Promise<void> };
    await deps.triggerSecretsReload!();
    expect(rpc.secretsReload).toHaveBeenCalledOnce();
  });
});

describe("restoreByosubForAgent", () => {
  beforeEach(() => modelCredentialMocks.restoreModelCredentialOauthStoreForSlug.mockClear());

  it("restores the subscription store from the broker on a isolated gateway", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: rosterRpc() as unknown as GatewayRpcClient,
      log: vi.fn(),
      isIsolatedGateway: () => true,
    });
    await expect(adapter.restoreByosubForAgent("tester10")).resolves.toMatchObject({
      restored: true,
      present: true,
    });
    expect(modelCredentialMocks.restoreModelCredentialOauthStoreForSlug).toHaveBeenCalledWith("tester10");
  });

  it("leaves the store alone on a shared gateway, where the customer sync owns the subscription", async () => {
    const adapter = buildBrokeredLifecycleAdapter({
      client: mkClient(),
      rpc: rosterRpc() as unknown as GatewayRpcClient,
      log: vi.fn(),
    });
    await expect(adapter.restoreByosubForAgent("tester10")).resolves.toEqual({
      restored: false,
      present: false,
    });
    expect(modelCredentialMocks.restoreModelCredentialOauthStoreForSlug).not.toHaveBeenCalled();
  });
});

it("waits for runtime publication before detaching a PostgreSQL roster entry", async () => {
  await withPostgresAgentConfig({}, async () => {
    let finishPublication!: () => void;
    const custody = new Promise<void>((resolve) => { finishPublication = resolve; });
    await openClawRuntimeUpdateGuard.run(async () => undefined, { slug: "alice", holdUntil: custody });
    const rpc = mkGatewayRpc({ agentsDetach: vi.fn(async ({ agentId }) => ({ ok: true, agentId })) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const detached = adapter.releaseAgent!("octogee-alice-coach");
    try {
      await Promise.resolve();
      expect(rpc.agentsDetach).not.toHaveBeenCalled();
    } finally { finishPublication(); await detached; }
    expect(rpc.agentsDetach).toHaveBeenCalledExactlyOnceWith({ agentId: "octogee-alice-coach" });
  });
});

it("defers broker-profile reloads until PostgreSQL detach settles", async () => {
  await withPostgresAgentConfig({}, async () => {
    let finishDetach!: () => void;
    const pending = new Promise<{ ok: true; agentId: string }>((resolve) => {
      finishDetach = () => resolve({ ok: true, agentId: "octogee-alice-coach" });
    });
    const rpc = mkGatewayRpc({ agentsDetach: vi.fn(() => pending) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    const detached = adapter.releaseAgent!("octogee-alice-coach");
    const readConfig = vi.fn(() => ({ agents: { entries: {} } }));
    try {
      await vi.waitFor(() => expect(rpc.agentsDetach).toHaveBeenCalledOnce());
      const sweep = await materializeDeferredBrokerProfiles(vi.fn(), { readConfig });
      expect(sweep).toMatchObject({ settled: false, skipped: true });
      expect(readConfig).not.toHaveBeenCalled();
    } finally { finishDetach(); await detached; }
  });
});

it("defers broker-profile reloads while import preparation detaches prior agents", async () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = testRuntime.dir;
  try { await withPostgresAgentConfig({}, async () => {
    const agentId = "octogee-guardprep-coach";
    const directory = path.join(testRuntime.dir, "agents", agentId, "agent");
    const procRoot = path.join(testRuntime.dir, "guardprep-proc");
    await fs.mkdir(directory, { recursive: true });
    await fs.mkdir(procRoot, { recursive: true });
    let finishDetach!: () => void;
    const pending = new Promise<{ ok: true; agentId: string }>((resolve) => {
      finishDetach = () => resolve({ ok: true, agentId });
    });
    const rpc = mkGatewayRpc({ agentsDetach: vi.fn(() => pending) });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn(), procRoot });
    const prepared = adapter.prepareImportDir("guardprep", "default");
    try {
      await vi.waitFor(() => expect(rpc.agentsDetach).toHaveBeenCalledOnce());
      const sweep = await materializeDeferredBrokerProfiles(vi.fn(), { readConfig: () => ({ agents: { entries: {} } }) });
      expect(sweep).toMatchObject({ settled: false, skipped: true });
    } finally { finishDetach(); await prepared; await fs.rm(path.dirname(directory), { recursive: true, force: true }); }
  }); } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
});

it("defers broker-profile reloads while rollback resumes a user", async () => {
  let finishRead!: () => void;
  const pending = new Promise<null>((resolve) => { finishRead = () => resolve(null); });
  mocks.readActivationManifest.mockReturnValueOnce(pending);
  const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc: mkGatewayRpc(), log: vi.fn() });
  const resumed = adapter.resumeUser("guardresume");
  try {
    await vi.waitFor(() => expect(mocks.readActivationManifest).toHaveBeenCalledWith(expect.any(String), "guardresume"));
    const sweep = await materializeDeferredBrokerProfiles(vi.fn(), { readConfig: () => ({ agents: { entries: {} } }) });
    expect(sweep).toMatchObject({ settled: false, skipped: true });
  } finally { finishRead(); await resumed; }
});

it("releases a PostgreSQL roster entry through detach while preserving its anchor", async () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = testRuntime.dir;
  const agentId = "octogee-pgfixture-coach";
  const directory = path.join(testRuntime.dir, "agents", agentId, "agent");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "openclaw-agent.sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE openclaw_engine_anchor(store_id TEXT, engine TEXT, schema TEXT)");
  db.prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)").run("1514f000-4540-4f4e-92a1-831adeac3d5b", "octogee_agent_fixture"); db.close();
  const rpc = mkGatewayRpc({ agentsDetach: vi.fn(async ({ agentId }) => ({ ok: true, agentId })) });
  try {
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
    await adapter.releaseAgent!(agentId);
    expect(rpc.agentsDetach).toHaveBeenCalledExactlyOnceWith({ agentId });
    expect(rpc.agentsDelete).not.toHaveBeenCalled();
    expect((await fs.stat(file)).size).toBeGreaterThan(0);
  } finally {
    if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = previousStateDir;
    await fs.rm(path.dirname(directory), { recursive: true, force: true });
  }
});

async function withPostgresAgentConfig(config: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const previous = await fs.readFile(OPENCLAW_CONFIG).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  await fs.mkdir(path.dirname(OPENCLAW_CONFIG), { recursive: true });
  await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify({ ...config, database: { engine: "sqlite", families: { agent: { engine: "postgres" } } } }));
  try { await run(); }
  finally {
    if (previous) await fs.writeFile(OPENCLAW_CONFIG, previous);
    else await fs.rm(OPENCLAW_CONFIG, { force: true });
  }
}

it.each(['confirmed', 'already-absent', 'missing-journal', 'invalid-json', 'missing-preserve', 'wrong-operation', 'wrong-pod', 'lost-hold', 'partial-retry', 'roster-retry'] as const)("cleans retained imported stores through Native under exact held target custody: %s", async scenario => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'broker-held-native-cleanup-'));
  const oldState = process.env.OPENCLAW_STATE_DIR;
  const oldPod = process.env.POD_UID;
  stubUserClaim('alice');
  process.env.OPENCLAW_STATE_DIR = root; process.env.POD_UID = 'pod-current';
  const failure = new Error('OpenClaw workspace identities are not initialized for this boot');
  routingActivationMocks.stopStale.mockRejectedValue(failure);
  const held = { version: 1 as const, podUid: scenario === 'wrong-pod' ? 'foreign' : 'pod-current', role: 'target' as const, mode: 'held' as const, phase: 'held' as const, migrationId: scenario === 'wrong-operation' ? 'another-op' : 'cleanup-op', slug: 'alice', targetPodUid: 'pod-current' };
  supervisorMocks.status.mockReset().mockResolvedValue(held);
  let calls = 0;
  const receipt = (agentId: string) => ({ code: 0, stdout: JSON.stringify({ ok: true, agentId, detached: true, storePreserved: true }) });
  const absent = (agentId: string) => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { type: 'cli_error', message: `agent "${agentId}" not found` } }) });
  offlineDetachMocks.run.mockReset().mockImplementation(async (args: string[]) => {
    calls++;
    if (scenario === 'lost-hold') supervisorMocks.status.mockResolvedValue({ ...held, mode: 'permitted', phase: 'running' });
    if (scenario === 'partial-retry') {
      if (calls === 2) throw new Error('second Native response lost');
      if (calls === 3) return absent(args[2]);
    }
    if (scenario === 'roster-retry') {
      if (calls === 2) throw new Error('second Native response lost');
      const config = JSON.parse(await fs.readFile(OPENCLAW_CONFIG, 'utf8'));
      delete config.agents.entries[args[2]];
      await fs.writeFile(OPENCLAW_CONFIG, JSON.stringify(config));
    }
    if (scenario === 'already-absent') return absent(args[2]);
    if (scenario === 'invalid-json') return { code: 0, stdout: 'not-json' };
    if (scenario === 'missing-preserve') return { code: 0, stdout: JSON.stringify({ ok: true, agentId: args[2], detached: true }) };
    if (scenario === 'missing-journal') return { code: 1, stdout: JSON.stringify({ ok: false, error: { type: 'cli_error', message: 'Agent deletion journal is missing' } }) };
    return receipt(args[2]);
  });
  const rpc = mkGatewayRpc({ agentsDetach: vi.fn().mockRejectedValue(failure) });
  try {
    const agentIds = ['octogee-alice-coach', ...(['partial-retry', 'roster-retry'].includes(scenario) ? ['octogee-alice-proj-orbit-coach'] : [])];
    const files = agentIds.map(id => path.join(root, 'agents', id, 'agent/openclaw-agent.sqlite'));
    for (const file of files) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'retained user anchor'); }
    await withPostgresAgentConfig({ agents: { entries: Object.fromEntries([...agentIds, ...(scenario === 'roster-retry' ? ['octogee-unmatched-route'] : [])].map(id => [id, {}])) } }, async () => {
      const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
      const remove = () => adapter.removeImportedUserBySlug!('alice', undefined, undefined, { migrationId: 'cleanup-op', targetPodUid: 'pod-current', assertCurrent: async () => {} });
      if (scenario === 'roster-retry') {
        await expect(remove()).rejects.toThrow('response lost');
        await expect(remove()).resolves.toMatchObject({ retained: true });
        await expect(remove()).resolves.toMatchObject({ retained: true });
        expect(offlineDetachMocks.run.mock.calls.map(([args]) => args[2])).toEqual([agentIds[0], agentIds[1], agentIds[1]]);
      } else if (scenario === 'partial-retry') {
        await expect(remove()).rejects.toThrow('response lost');
        await expect(remove()).resolves.toMatchObject({ retained: true });
        expect(offlineDetachMocks.run.mock.calls.map(([args]) => args[2])).toEqual([...agentIds, ...agentIds]);
      } else if (scenario === 'confirmed' || scenario === 'already-absent') {
        await expect(remove()).resolves.toMatchObject({ retained: true });
      } else if (scenario === 'missing-journal') await expect(remove()).rejects.toThrow('Agent deletion journal is missing');
      else await expect(remove()).rejects.toThrow();
    });
    if (scenario === 'wrong-operation' || scenario === 'wrong-pod') expect(offlineDetachMocks.run).not.toHaveBeenCalled();
    else expect(offlineDetachMocks.run).toHaveBeenCalledWith(['agents', 'detach', 'octogee-alice-coach', '--force', '--json'], expect.objectContaining({ env: expect.objectContaining({ OPENCLAW_STATE_DIR: root }) }));
    expect(rpc.agentsDetach).not.toHaveBeenCalled();
    for (const file of files) expect(await fs.readFile(file, 'utf8')).toBe('retained user anchor');
  } finally {
    routingActivationMocks.stopStale.mockResolvedValue(undefined);
    if (oldState === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = oldState;
    if (oldPod === undefined) delete process.env.POD_UID; else process.env.POD_UID = oldPod;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each(['empty', 'initialized-unused', 'initialized-changed', 'agent-store', 'running', 'wrong-pod', 'gate-changed'])("cleans an interrupted held isolated target only when no user Native state exists: %s", async scenario => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'broker-empty-target-'));
  const oldState = process.env.OPENCLAW_STATE_DIR;
  const oldPod = process.env.POD_UID;
  stubUserClaim('alice');
  process.env.OPENCLAW_STATE_DIR = root; process.env.POD_UID = 'pod-current';
  const failure = new Error('OpenClaw workspace identities are not initialized for this boot');
  routingActivationMocks.stopStale.mockRejectedValueOnce(failure);
  supervisorMocks.status.mockReset().mockResolvedValue({ version: 1, podUid: scenario === 'wrong-pod' ? 'old-pod' : 'pod-current', role: 'normal', mode: scenario === 'running' ? 'permitted' : 'held', phase: scenario === 'running' ? 'running' : 'held' });
  if (scenario === 'gate-changed') supervisorMocks.status.mockResolvedValueOnce({ version: 1, podUid: 'pod-current', role: 'normal', mode: 'held', phase: 'held' }).mockResolvedValue({ version: 1, podUid: 'pod-current', role: 'normal', mode: 'permitted', phase: 'starting' });
  const rpc = mkGatewayRpc({ agentsDetach: vi.fn().mockRejectedValue(failure) });
  try {
    const agent = path.join(root, 'agents/octogee-alice-coach/agent');
    await fs.mkdir(agent, { recursive: true });
    await fs.writeFile(path.join(agent, scenario === 'agent-store' ? 'openclaw-agent.sqlite' : 'models.json'), 'retained');
    if (scenario.startsWith('initialized-')) {
      await fs.mkdir(path.join(root, 'state'));
      await fs.writeFile(path.join(root, 'state/openclaw.sqlite'), 'Native initial state');
      recordIsolatedNativeInitialState(root, 'pod-current');
      if (scenario === 'initialized-changed') await fs.appendFile(path.join(root, 'state/openclaw.sqlite'), 'user data');
    }
    await withPostgresAgentConfig({ agents: { entries: { 'octogee-alice-coach': {} } } }, async () => {
      const adapter = buildBrokeredLifecycleAdapter({ client: mkClient(), rpc, log: vi.fn() });
      const removing = adapter.removeImportedUserBySlug!('alice');
      if (scenario === 'empty' || scenario === 'initialized-unused') {
        await expect(removing).resolves.toMatchObject({ retained: true });
        expect(rpc.agentsDetach).not.toHaveBeenCalled();
      } else await expect(removing).rejects.toThrow(/workspace identities/);
    });
    expect(await fs.readFile(path.join(agent, scenario === 'agent-store' ? 'openclaw-agent.sqlite' : 'models.json'), 'utf8')).toBe('retained');
  } finally {
    if (oldState === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = oldState;
    if (oldPod === undefined) delete process.env.POD_UID; else process.env.POD_UID = oldPod;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it("purges a retired PostgreSQL project while detaching evicted user stores", async () => {
  const current = { agents: { entries: keyedRoster(["octogee-alice-coach", "octogee-alice-proj-retired-coach", "octogee-stale-coach", "octogee-bob-coach"]) } };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shared-anchor-eviction-"));
  const oldStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = dir;
  const defaultAgent = { agentId: "octogee-alice-coach", storeId: "92c817cc-770f-466d-b4a6-4e9b02998363", schema: "octogee_agent_92c817cc770f466d" };
  anchorQuery.mockImplementation(async (_target, sql) => sql.includes("openclaw_schema_meta") ? [{ store_id: defaultAgent.storeId }] : [{ agent_id: defaultAgent.agentId }]);
  try {
    await withPostgresAgentConfig(current, async () => {
      const agentsDetach = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId }));
      const rpc = mkRemovalRpc(current, { agentsDetach });
      const client = mkClient({
        readAgentAnchors: vi.fn(async () => ({ anchors: [defaultAgent], assignment: { uid: "uid-alice", epoch: 0, state: "serving" } })),
        reportAgentAnchors: vi.fn(async () => undefined),
      });
      const adapter = buildBrokeredLifecycleAdapter({ client, rpc, log: vi.fn() });
      await adapter.applyAddUserConfigPatch(aliceSnapshot(), { _coachPersonalToken: "pat-1" }, { evictionBatch: ["stale"] });
      expect(agentsDetach).toHaveBeenCalledExactlyOnceWith({ agentId: "octogee-stale-coach" });
      expect(rpc.agentsDelete).toHaveBeenCalledExactlyOnceWith({ agentId: "octogee-alice-proj-retired-coach", deleteFiles: false });
    });
  } finally {
    if (oldStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = oldStateDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("purges a retired configured user PostgreSQL project without deleting imported agents", async () => {
  const retiredId = "octogee-alice-proj-retired-coach";
  const importedId = "octogee-alice-proj-imported-coach";
  const config = {
    agents: { entries: keyedRoster(["octogee-alice-coach", retiredId, importedId]) },
    channels: { mattermost: { accounts: {
      "alice-proj-retired": { botToken: { source: "file", provider: "octogee-mattermost", id: "/alice-proj-retired" } },
      "alice-proj-imported": { botToken: { source: "file", provider: "octogee-mattermost", id: "/owner-custom" } },
    } } },
    bindings: [
      { agentId: retiredId, match: { channel: "mattermost", accountId: "alice-proj-retired" } },
      { agentId: importedId, match: { channel: "mattermost", accountId: "alice-proj-imported" } },
    ],
  };
  await withPostgresAgentConfig(config, async () => {
    const snapshot = aliceSnapshot({ status: "complete", projectAgents: [] });
    const agentsDetach = vi.fn(async ({ agentId }: { agentId: string }) => ({ ok: true as const, agentId }));
    const rpc = mkGatewayRpc({ ...rosterRpc(config), agentsDetach });
    const adapter = buildBrokeredLifecycleAdapter({ client: mkClient({ userSnapshot: vi.fn(async () => snapshot) }), rpc, log: vi.fn() });
    await adapter.reconcileConfiguredUserProjectAgents!(snapshot);
    expect(rpc.agentsDelete).toHaveBeenCalledExactlyOnceWith({ agentId: retiredId, deleteFiles: false });
    expect(agentsDetach).not.toHaveBeenCalled();
  });
});
