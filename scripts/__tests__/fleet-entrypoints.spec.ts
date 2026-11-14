import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FleetBrokerAssignmentRosterEntry, FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";
import type { DesiredUser } from "../lib/snapshot-fingerprint.js";
import { userEnsureRetryReady } from "../lib/fleet-provisioner.js";
import { reconcileFleet, _resetReconcileInFlightForTests } from "../lib/reconcile-loop.js";
import { CONFIG_RELOAD_DEADLINE_MS } from "../../shared/types/fleet-controller.js";
import { acquireSystemConfigMutationLease } from "@octogee/core/system-config-mutation-lease";
import { createDocumentFixtureStore, createJournalFixtureStore, fixtureDocumentsAt } from "@octogee/core/testing/journal-store";
import {
  createAssignedUserReader,
  readUserEnsureAdmission,
  createFleetFlushSystemConfigSync,
  createFleetControllerRequestedFlush,
  createFleetSystemConfigVerifyFlush,
  createFleetSystemConfigFlush,
  createFleetControllerMutationGatedRpc,
  createSystemConfigMutationGatedRpc,
  resolveFleetControllerEntrypointConfig,
  FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS,
  SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS,
} from "../entrypoints/fleet-controller.js";
import {
  ASSIGN_USER_GATEWAY_USAGE,
  isBulkAssignmentCandidate,
  parseAssignUserGatewayArgs,
} from "../ops/assign-user-gateway.js";
import {
  buildFleetMigrateOperationInput,
  resolveFleetSourceTransferMode,
  executeFleetGatewayMutation,
  parseForceRestartPodList,
  parseFleetArgs,
  releaseStatusRows,
  runForcedGatewayRestart,
  fleetServiceAccountCredential,
  fleetFirebaseSignerServiceAccountId,
  resolveFleetGatewayMutation,
  resolveFleetGatewayRestart,
  resolveFleetVerb,
  resolveFleetDeploymentTarget,
  resolveExplicitFleetOperatorUid,
  resolveFleetOperatorUid,
} from "../ops/fleet.js";
import { withUserClaim } from "./helpers/user-claim.js";
import { PROD_TARGET, TEST_TARGET } from "./fixtures/deployment.js";

describe("fleet-controller entrypoint config", () => {
  it("reports the complete gateway image tag instead of its ambiguous build SHA", () => {
    expect(resolveFleetControllerEntrypointConfig({
      BUILD_SHA: "abc1234",
      GATEWAY_IMAGE_TAG: "abc1234-oc2026.7.1",
    }, { gatewayId: "gw-1" })).toMatchObject({
      version: "abc1234-oc2026.7.1",
    });
  });

  it("uses a snapshot fingerprint roster for isolated gateways so post-mount project creation reconverges", async () => {
    const snapshot = {
      uid: "u1",
      slug: "alice",
      channels: [],
      projects: [
        { projectSlug: "launchroom", giteaRepoName: "launchroom", provisioningState: "active" },
      ],
      projectAgents: [],
      coachToken: "pat",
      defaultAgentMmUserId: "coach",
      customerMmUserId: "user",
      contextTemplateKey: "default",
      planInputs: { tier: "paid" },
    } as never;
    const assignedUsers = vi.fn(async () => [snapshot]);
    const seed = vi.fn();

    const assignmentRoster = vi.fn(async () => [{ uid: "u1", state: "serving" as const, epoch: 1 }]);
    const read = createAssignedUserReader({ assignedUsers, assignmentRoster }, seed);
    const users = await read();

    expect([...users.keys()]).toEqual(["alice"]);
    expect(users.get("alice")?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(users.get("alice")?.lane).toBe("create");
    expect(users.get("alice")?.ensureAllowed).toBe(true);
    expect(seed).toHaveBeenCalledWith(snapshot);
    expect(assignedUsers).toHaveBeenCalledWith({ completeOnly: false });
  });

  it.each(["serving", "migrating", "quiescing"] as const)(
    "keeps a %s user desired and admits ensures only outside source quiescence",
    async (state) => {
      const snapshot = {
        uid: "u1", slug: "alice", contextTemplateKey: "default", planInputs: {}, status: "provisioning", channels: [],
        projectAgents: [], projects: [],
      } as never;
      const read = createAssignedUserReader({
        assignedUsers: async () => [snapshot],
        assignmentRoster: async () => [{ uid: "u1", state, epoch: 7 }],
      }, vi.fn());

      expect([...(await read())]).toEqual([["alice", expect.objectContaining({
        lane: "create", ensureAllowed: state !== "quiescing",
      })]]);
    },
  );

  it("does not admit incoming or restore-held roster entries without returned user snapshots", async () => {
    const snapshot = { uid: "u1", slug: "alice", contextTemplateKey: "default", planInputs: {}, channels: [] } as never;
    const seed = vi.fn();
    const read = createAssignedUserReader({
      assignedUsers: async () => [snapshot],
      assignmentRoster: async () => [
        { uid: "u1", state: "serving", epoch: 7 },
        { uid: "incoming", state: "migrating", epoch: 2 },
        { uid: "restore-held", state: "serving", epoch: 9 },
      ],
    }, seed);

    expect([...(await read()).keys()]).toEqual(["alice"]);
    expect(seed).toHaveBeenCalledExactlyOnceWith(snapshot);
  });

  it("rejects a straddled assignment read before seeding any returned snapshot", async () => {
    const seed = vi.fn();
    const read = createAssignedUserReader({
      assignedUsers: async () => [
        { uid: "u1", slug: "alice", contextTemplateKey: "default", planInputs: {}, channels: [] } as never,
        { uid: "u2", slug: "bob", contextTemplateKey: "default", planInputs: {}, channels: [] } as never,
      ],
      assignmentRoster: async () => [{ uid: "u1", state: "serving", epoch: 7 }],
    }, seed);

    await expect(read()).rejects.toThrow("missing canonical assignment for u2");
    expect(seed).not.toHaveBeenCalled();
  });

  it("holds changed source content while quiescing, preserves a failed read, and removes only after cutover", async () => {
    _resetReconcileInFlightForTests();
    let users = [{ uid: "u1", slug: "alice", contextTemplateKey: "default", planInputs: {}, status: "complete", channels: [] }] as unknown as FleetBrokerUserSnapshot[];
    let assignments: FleetBrokerAssignmentRosterEntry[] = [
      { uid: "u1", state: "quiescing", epoch: 7 },
      { uid: "incoming", state: "migrating", epoch: 8 },
      { uid: "restore-held", state: "serving", epoch: 3 },
    ];
    const seed = vi.fn();
    const read = createAssignedUserReader({
      assignedUsers: async () => users,
      assignmentRoster: async () => assignments,
    }, seed);
    let desired = new Map<string, DesiredUser>();
    const ensured = vi.fn(async () => "mounted" as const);
    const evicted = vi.fn(async () => "drained" as const);
    const deps = {
      gatewayId: "shared-1",
      getMountObserved: () => ["alice"],
      getEvictObserved: () => ["alice"],
      getContentStale: () => ["alice"],
      readDesired: async () => {
        desired = await read();
        return [...desired.keys()];
      },
      shouldEnsureSlug: (slug: string) => userEnsureRetryReady({
        ensureAllowed: desired.get(slug)?.ensureAllowed === true,
        cloneRetry: undefined,
        desiredFingerprint: desired.get(slug)?.fingerprint,
        now: 0,
        permanentConfigPatchRetry: undefined,
      }),
      ensureSlug: ensured,
      unmountSlug: evicted,
      log: vi.fn(),
    };
    try {
      await reconcileFleet(deps);
      const oldFingerprint = desired.get("alice")!.fingerprint;
      users = [{ ...users[0], channels: [{ scope: "project", kind: "general", channelId: "new-empty-channel", projectId: "new-task" }] }];
      await reconcileFleet(deps);
      expect(desired.get("alice")!.fingerprint).not.toBe(oldFingerprint);
      expect([...desired.keys()]).toEqual(["alice"]);
      expect(ensured).not.toHaveBeenCalled();
      expect(evicted).not.toHaveBeenCalled();

      const priorDesired = desired;
      seed.mockClear();
      assignments = assignments.filter((assignment) => assignment.uid !== "u1");
      await expect(reconcileFleet(deps)).rejects.toThrow("missing canonical assignment for u1");
      expect(desired).toBe(priorDesired);
      expect(seed).not.toHaveBeenCalled();
      expect(evicted).not.toHaveBeenCalled();

      assignments = [{ uid: "u1", state: "serving", epoch: 7 }];
      await reconcileFleet(deps);
      expect(ensured).toHaveBeenCalledOnce();
      expect(evicted).not.toHaveBeenCalled();

      users = [];
      assignments = [];
      await reconcileFleet(deps);
      expect(evicted).toHaveBeenCalledExactlyOnceWith("alice", ["alice"]);
    } finally {
      _resetReconcileInFlightForTests();
    }
  });

  it("does not rebuild full assigned-user snapshots for each selected cold mount", async () => {
    _resetReconcileInFlightForTests();
    const users = ["alice", "bob", "cara"].map((slug, index) => ({
      uid: `u${index}`, slug, contextTemplateKey: "default", planInputs: {}, status: "complete", channels: [],
    })) as unknown as FleetBrokerUserSnapshot[];
    const assignedUsers = vi.fn(async () => users);
    const assignmentRoster = vi.fn(async () => users.map(({ uid }) => ({ uid, state: "serving" as const, epoch: 1 })));
    const read = createAssignedUserReader({ assignedUsers, assignmentRoster }, vi.fn());
    let desired = new Map<string, DesiredUser>();
    const admittedUids: string[] = [];
    const canEnsureSlug = vi.fn(async (slug: string) => {
      const uid = desired.get(slug)!.uid;
      admittedUids.push(uid);
      return readUserEnsureAdmission({ assignmentRoster }, uid);
    });
    const ensured = vi.fn(async () => "mounted" as const);
    try {
      await reconcileFleet({
        gatewayId: "shared-1",
        getMountObserved: () => [],
        getEvictObserved: () => [],
        readDesired: async () => {
          desired = await read();
          return [...desired.keys()];
        },
        canEnsureSlug,
        ensureSlug: ensured,
        unmountSlug: vi.fn(async () => "noop" as const),
        log: vi.fn(),
      });
      expect(ensured.mock.calls).toHaveLength(3);
      expect(assignedUsers).toHaveBeenCalledOnce();
      expect(canEnsureSlug).toHaveBeenCalledTimes(3);
      expect(admittedUids.sort()).toEqual(["u0", "u1", "u2"]);
      expect(assignmentRoster).toHaveBeenCalledTimes(4);
    } finally {
      _resetReconcileInFlightForTests();
    }
  });

  it.each(["serving", "migrating", "quiescing"] as const)(
    "reads current %s admission by validated user UID without admitting unrelated roster rows",
    async (state) => {
      const assignmentRoster = vi.fn(async () => [
        { uid: "incoming", state: "migrating" as const, epoch: 8 },
        { uid: "owner-uid", state, epoch: 7 },
        { uid: "restore-held", state: "serving" as const, epoch: 3 },
      ]);
      await expect(readUserEnsureAdmission({ assignmentRoster }, "owner-uid"))
        .resolves.toBe(state !== "quiescing");
      expect(assignmentRoster).toHaveBeenCalledOnce();
    },
  );

  it("rejects missing queued admission without using another user's serving state", async () => {
    await expect(readUserEnsureAdmission({
      assignmentRoster: async () => [{ uid: "another-owner", state: "serving", epoch: 7 }],
    }, "owner-uid")).rejects.toThrow("missing canonical assignment for owner-uid");
  });

  it("normalizes local gateways and reads the dedicated user slug from the claim", () => {
    expect(resolveFleetControllerEntrypointConfig(withUserClaim({
      BUILD_SHA: "abc123",
      FLEET_CONTROLLER_PORT: "3999",
      FLEET_CONTROLLER_PUBLIC_KEY: "pub",
    }, "alice"), { gatewayId: "local" })).toEqual({
      gatewayId: "default",
      builderSlug: "alice",
      port: 3999,
      publicKey: "pub",
      version: "abc123",
    });
  });

  it("uses production defaults for unset optional values", () => {
    expect(resolveFleetControllerEntrypointConfig({}, { gatewayId: "gw-1" })).toEqual({
      gatewayId: "gw-1",
      builderSlug: "",
      port: 3003,
      publicKey: "",
      version: "unknown",
    });
  });

  it("fails a controller-requested flush until the durable config commit is accepted", async () => {
    const sync = vi.fn(() => ({
      committed: false,
      pushed: false,
      skipped: "sync-locked",
      pending: true,
    }));
    const flush = createFleetSystemConfigFlush("alice", () => {}, sync);

    await expect(flush?.()).rejects.toThrow("sync-locked");
    expect(sync).toHaveBeenCalledWith("alice", expect.objectContaining({
      durablePolicy: true,
      source: "auto-watch",
    }));
  });

  it("converges to the controller-pinned remote config commit inside the durable checkpoint", async () => {
    const expectedSystemConfigCommit = "a".repeat(40);
    const acceptedCommit = "b".repeat(40);
    const sync = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit,
    }));
    const flush = createFleetSystemConfigFlush(
      "alice",
      () => {},
      sync,
      expectedSystemConfigCommit,
    );

    await expect(flush?.()).resolves.toEqual({ acceptedCommit });
    expect(sync).toHaveBeenCalledWith("alice", expect.objectContaining({
      durablePolicy: true,
      expectedRemoteCommit: expectedSystemConfigCommit,
      source: "migration-checkpoint",
    }));
  });

  it("verifies the accepted remote system config commit for a dedicated isolated pod", async () => {
    const acceptedCommit = "a".repeat(40);
    const readAcceptedCommit = vi.fn(() => acceptedCommit);
    const flush = createFleetSystemConfigVerifyFlush(
      "alice",
      undefined,
      readAcceptedCommit,
    );

    await expect(flush()).resolves.toEqual({ acceptedCommit });
    expect(readAcceptedCommit).toHaveBeenCalledExactlyOnceWith("alice");
  });

  it("rejects a dedicated target whose durable system config commit drifted during migration", async () => {
    const expectedCommit = "a".repeat(40);
    const observedCommit = "b".repeat(40);
    const flush = createFleetSystemConfigVerifyFlush(
      "alice",
      expectedCommit,
      () => observedCommit,
    );

    await expect(flush()).rejects.toThrow(
      `durable system config head changed: expected ${expectedCommit}, observed ${observedCommit}`,
    );
  });

  it("skips the migration durable-config step on a shared pod, whose users have no system_config repo", () => {
    const readAcceptedCommit = vi.fn();
    const sync = createFleetFlushSystemConfigSync({
      slug: "aug04",
      builderSlug: "",
      isolated: false,
      readAcceptedCommit,
    });

    expect(sync).toBeUndefined();
    expect(readAcceptedCommit).not.toHaveBeenCalled();
  });

  it("rejects a converge fence commit sent to a pod that holds no durable config", () => {
    expect(() => createFleetFlushSystemConfigSync({
      slug: "aug04",
      builderSlug: "",
      isolated: false,
      expectedSystemConfigCommit: "a".repeat(40),
    })).toThrow("no durable system config");
  });

  it("verifies the durable head for a dedicated isolated pod flush", async () => {
    const acceptedCommit = "c".repeat(40);
    const readAcceptedCommit = vi.fn(() => acceptedCommit);
    const sync = createFleetFlushSystemConfigSync({
      slug: "alice",
      builderSlug: "alice",
      isolated: false,
      readAcceptedCommit,
    });

    await expect(sync?.()).resolves.toEqual({ acceptedCommit });
    expect(readAcceptedCommit).toHaveBeenCalledExactlyOnceWith("alice");
  });

  it("checkpoints the durable config for an operator pod flush", async () => {
    const acceptedCommit = "d".repeat(40);
    const checkpointSync = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit,
    }));
    const sync = createFleetFlushSystemConfigSync({
      slug: "walter",
      builderSlug: "walter",
      isolated: true,
      log: () => {},
      sync: checkpointSync as never,
    });

    await expect(sync?.()).resolves.toEqual({ acceptedCommit });
    expect(checkpointSync).toHaveBeenCalledWith("walter", expect.objectContaining({
      durablePolicy: true,
      source: "auto-watch",
    }));
  });

  it("uses only the expected config checkpoint for target migration convergence", async () => {
    const flushFiles = vi.fn(async () => undefined);
    const syncBlobs = vi.fn(async () => undefined);
    const expectedSystemConfigCommit = "a".repeat(40);
    const syncSystemConfig = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit: expectedSystemConfigCommit,
    }));
    const flush = createFleetControllerRequestedFlush({
      gatewayId: "builder-alice",
      gatewayClass: "isolated",
      builderSlug: "alice",
      isolated: true,
      flushFiles,
      syncBlobs,
      syncSystemConfig,
      log: () => {},
    });

    const result = await flush({
      slug: "alice",
      reason: "migration-converge",
      expectedSystemConfigCommit,
    });

    expect(result.ok).toBe(true);
    expect(result.systemConfigCommit).toBe(expectedSystemConfigCommit);
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "customer-files", status: "skipped" }),
      expect.objectContaining({ name: "blob-sync", status: "skipped" }),
      expect.objectContaining({ name: "system-config", status: "done" }),
    ]));

    expect(flushFiles).not.toHaveBeenCalled();
    expect(syncBlobs).not.toHaveBeenCalled();
    expect(syncSystemConfig).toHaveBeenCalledWith("alice", expect.objectContaining({
      expectedRemoteCommit: expectedSystemConfigCommit,
      source: "migration-checkpoint",
    }));
  });

  it("retains strict workspace durability for a final migration flush", async () => {
    const flushFiles = vi.fn(async () => { throw new Error("workspace push failed"); });
    const flush = createFleetControllerRequestedFlush({
      gatewayId: "builder-alice",
      gatewayClass: "isolated",
      builderSlug: "alice",
      isolated: true,
      flushFiles,
      syncSystemConfig: vi.fn(() => ({
        committed: true,
        pushed: true,
        acceptedCommit: "a".repeat(40),
      })),
      log: () => {},
    });

    const result = await flush({ slug: "alice", reason: "migration-final" });
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "customer-files",
        status: "failed",
        error: "workspace push failed",
      }),
    ]));
    expect(flushFiles).toHaveBeenCalledOnce();
  });

  it.each([false, true])("native return flushes files and blobs without exporting user config (file failure=%s)", async (fail) => {
    const flushFiles = vi.fn(async () => { if (fail) throw new Error("sync failed"); });
    const syncBlobs = vi.fn(async () => {});
    const syncSystemConfig = vi.fn(() => { throw new Error("platform-invariant-violation"); });
    const flush = createFleetControllerRequestedFlush({
      gatewayId: "builder-alice", gatewayClass: "isolated", builderSlug: "alice", isolated: true,
      flushFiles, syncBlobs, syncSystemConfig, log: () => {},
    });
    const result = await flush({ slug: "alice", reason: "native-return" });
    expect(result.ok).toBe(!fail);
    expect(flushFiles).toHaveBeenCalledOnce();
    expect(syncBlobs).toHaveBeenCalledOnce();
    expect(syncSystemConfig).not.toHaveBeenCalled();
    expect(result.steps).toContainEqual(expect.objectContaining({ name: "system-config", status: "skipped" }));
  });

  it.each(["bob", ""])("rejects native-return flush outside its configured user (%s)", async (builderSlug) => {
    const flushFiles = vi.fn(async () => {});
    const flush = createFleetControllerRequestedFlush({
      gatewayId: "builder-alice", gatewayClass: "isolated", builderSlug, isolated: true,
      flushFiles, log: () => {},
    });
    await expect(flush({ slug: "alice", reason: "native-return" })).rejects.toThrow(/configured user/);
    expect(flushFiles).not.toHaveBeenCalled();
  });

  it("rejects an unpinned migration convergence request before it can sync", async () => {
    const flushFiles = vi.fn(async () => undefined);
    const syncSystemConfig = vi.fn(() => ({
      committed: true,
      pushed: true,
      acceptedCommit: "a".repeat(40),
    }));
    const flush = createFleetControllerRequestedFlush({
      gatewayId: "builder-alice",
      gatewayClass: "isolated",
      builderSlug: "alice",
      isolated: true,
      flushFiles,
      syncSystemConfig,
      log: () => {},
    });

    await expect(flush({ slug: "alice", reason: "migration-converge" }))
      .rejects.toThrow("migration converge is missing expected system config commit");
    expect(flushFiles).not.toHaveBeenCalled();
    expect(syncSystemConfig).not.toHaveBeenCalled();
  });

  it("ignores a leftover roll-era freeze marker — identity-pure mutation (GATEWAY-SIMPLE-ROLL-SPEC)", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-freeze-"));
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir);
    fs.writeFileSync(path.join(openclawDir, "system_config.freeze.json"), JSON.stringify({
      migrationId: "mig-1",
      slug: "alice",
      directoryMode: 0o700,
      configMode: 0o600,
    }));

    try {
      await expect(rpc.configApply({}, "current")).resolves.toEqual({ ok: true, hash: "next" });
      expect(configApply).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("budgets its connect for a config reload while retaining the provisioning mutation gate", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-timeout-"));
    const configPatch = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const createRpc = vi.fn(() => ({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply: vi.fn(async () => ({ ok: true as const, hash: "next" })),
      configPatch,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    }));
    const rpc = createFleetControllerMutationGatedRpc(openclawDir, createRpc as never);
    try {
      expect(FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS).toBe(120_000);
      expect(createRpc).toHaveBeenCalledWith({
        allowLegacyGatewayTokenFallback: true,
        callTimeoutMs: FLEET_CONTROLLER_MUTATION_CALL_TIMEOUT_MS,
        connectTimeoutMs: CONFIG_RELOAD_DEADLINE_MS,
      });
      await expect(rpc.configPatch({ agents: {} }, "current"))
        .resolves.toEqual({ ok: true, hash: "next" });
      expect(configPatch).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("serializes ordinary runtime config.apply against the local writer lock", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-lock-"));
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir, { wait: async () => undefined });
    fs.writeFileSync(path.join(openclawDir, "system_config.sync.lock"), `${process.pid}\n`);

    try {
      await expect(rpc.configApply({}, "current")).rejects.toThrow(/writer-lock-busy/i);
      expect(configApply).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("retries a transient writer lock within a fixed acquisition budget", async () => {
    const release = vi.fn(async () => undefined);
    const acquireLease = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: "writer-lock-busy" })
      .mockResolvedValueOnce({ ok: false, code: "writer-lock-busy" })
      .mockResolvedValueOnce({ ok: true, lease: { release } });
    const wait = vi.fn(async () => undefined);
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, "/openclaw", { acquireLease: acquireLease as never, wait });

    await expect(rpc.configApply({}, "current")).resolves.toEqual({ ok: true, hash: "next" });
    expect(acquireLease).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[250], [750]]);
    expect(configApply).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("allows a five-second auto-push overlap within a finite writer-lock acquisition window", async () => {
    let elapsedMs = 0;
    const release = vi.fn(async () => undefined);
    const acquireLease = vi.fn(async () => elapsedMs >= 5_000
      ? { ok: true as const, lease: { release } }
      : { ok: false as const, code: "writer-lock-busy" as const });
    const wait = vi.fn(async (delayMs: number) => {
      elapsedMs += delayMs;
    });
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, "/openclaw", { acquireLease: acquireLease as never, wait });

    await expect(rpc.configApply({}, "current")).resolves.toEqual({ ok: true, hash: "next" });
    expect(elapsedMs).toBeGreaterThanOrEqual(5_000);
    expect(elapsedMs).toBeLessThanOrEqual(10_000);
    expect(configApply).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("stops retrying a writer lock after the bounded eight-second acquisition window", async () => {
    const acquireLease = vi.fn(async () => ({ ok: false as const, code: "writer-lock-busy" as const }));
    const wait = vi.fn(async () => undefined);
    const configApply = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, "/openclaw", { acquireLease: acquireLease as never, wait });

    await expect(rpc.configApply({}, "current")).rejects.toThrow(/writer-lock-busy/i);
    expect(acquireLease).toHaveBeenCalledTimes(
      SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS.length + 1,
    );
    expect(wait.mock.calls).toEqual(
      SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS.map((delayMs) => [delayMs]),
    );
    expect(SYSTEM_CONFIG_MUTATION_LEASE_RETRY_DELAYS_MS.reduce(
      (totalMs, delayMs) => totalMs + delayMs,
      0,
    )).toBe(8_000);
    expect(configApply).not.toHaveBeenCalled();
  });

  it("serializes ordinary runtime config.patch against the local writer lock", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-lock-"));
    const configPatch = vi.fn(async () => ({ ok: true as const, hash: "next" }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply: vi.fn(async () => ({ ok: true as const, hash: "next" })),
      configPatch,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir, { wait: async () => undefined });
    fs.writeFileSync(path.join(openclawDir, "system_config.sync.lock"), `${process.pid}\n`);

    try {
      await expect(rpc.configPatch({ agents: {} }, "current", { replacePaths: ["agents.list"] }))
        .rejects.toThrow(/writer-lock-busy/i);
      expect(configPatch).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });

  it("holds the writer lease through awaited config.patch and preserves its arguments and result", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-entrypoint-lock-"));
    let resolvePatch: ((value: { ok: true; hash: string }) => void) | undefined;
    const configPatch = vi.fn(() => new Promise<{ ok: true; hash: string }>((resolve) => {
      resolvePatch = resolve;
    }));
    const rpc = createSystemConfigMutationGatedRpc({
      configGet: vi.fn(async () => ({ config: {}, hash: "current" })),
      configApply: vi.fn(async () => ({ ok: true as const, hash: "next" })),
      configPatch,
      channelsStatus: vi.fn(async () => ({ channels: [] })),
    } as never, openclawDir);
    const patch = { agents: { list: [] } };
    const opts = { replacePaths: ["agents.list"] };

    try {
      const pending = rpc.configPatch(patch, "current", opts);
      await vi.waitFor(() => expect(configPatch).toHaveBeenCalled());
      await expect(acquireSystemConfigMutationLease({ openclawDir })).resolves.toEqual({
        ok: false,
        code: "writer-lock-busy",
      });
      resolvePatch?.({ ok: true, hash: "next" });
      await expect(pending).resolves.toEqual({ ok: true, hash: "next" });
      expect(configPatch).toHaveBeenCalledWith(patch, "current", opts);
      const after = await acquireSystemConfigMutationLease({ openclawDir });
      expect(after.ok).toBe(true);
      if (after.ok) await after.lease.release();
    } finally {
      fs.rmSync(openclawDir, { recursive: true, force: true });
    }
  });
});

describe("assign-user-gateway args", () => {
  async function bulkCandidate(data: Record<string, unknown>): Promise<boolean> {
    const store = createDocumentFixtureStore(new Map([["users/u1", data]]));
    const userRecord = await store.users.records.get("u1");
    return isBulkAssignmentCandidate(userRecord!);
  }

  it("bulk-selects only admitted users whose provisioning has started", async () => {
    await expect(bulkCandidate({
      username: "alice",
      onboardingStep: "complete",
      provisioning: { status: "in_progress", openclaw: {} },
    })).resolves.toBe(true);
    await expect(bulkCandidate({ username: "partial" })).resolves.toBe(false);
    await expect(bulkCandidate({
      username: "service",
      onboardingStep: "complete",
      provisioning: { status: "queued", openclaw: {} },
    })).resolves.toBe(false);
  });

  it("skips bulk placement for an already placed or operator-managed user", async () => {
    const complete = { username: "alice", onboardingStep: "complete" };
    await expect(bulkCandidate({ ...complete, provisioning: { status: "complete", openclaw: { gatewayId: "shared-0" } } })).resolves.toBe(false);
    await expect(bulkCandidate({ ...complete, provisioning: { status: "complete", openclaw: { managedBy: "operator" } } })).resolves.toBe(false);
  });

  it("accepts uid-targeted dry runs", () => {
    expect(parseAssignUserGatewayArgs([
      "--env=prod",
      "--uid=uid-1",
      "--to=shared-0",
      "--dry-run",
    ])).toEqual({
      kind: "ok",
      args: {
        env: "prod",
        uid: "uid-1",
        slug: "",
        all: false,
        dryRun: true,
        gatewayId: "shared-0",
      },
    });
  });

  it("refuses an assignment with no gateway named, telling the operator to name one", () => {
    for (const selector of ["--uid=uid-1", "--slug=alice", "--all"]) {
      const parsed = parseAssignUserGatewayArgs(["--env=test", selector]);
      expect(parsed).toMatchObject({ kind: "error" });
      expect(parsed.kind === "error" && parsed.message).toContain("name the gateway with --to=GATEWAY_ID");
    }
  });

  it("rejects missing selector before Firebase init", () => {
    expect(parseAssignUserGatewayArgs(["--env=test", "--to=shared-0"])).toMatchObject({ kind: "error" });
    expect(parseAssignUserGatewayArgs(["--help"])).toEqual({ kind: "help" });
    expect(ASSIGN_USER_GATEWAY_USAGE).toContain("--uid=UID");
  });

});

describe("fleet force gateway restart", () => {
  function durableGatewayRoot(gatewayId = "canary") {
    return {
      gatewayId,
      createdAt: 1,
      createdBy: "test",
      updatedAt: 1,
      updatedBy: "test",
      latestRelease: 1,
      desiredRelease: 1,
      liveRelease: 1,
      desiredStatus: "running",
      configSchemaVersion: 1,
      profile: "isolated",
      gatewayClass: "isolated",
      imageProfile: "isolated",
      sizingTier: null,
      gcpProject: null,
      gatewayContainerSecurityContext: null,
      serviceAccountName: null,
      serviceAccount: null,
      builderAccess: null,
      ownerUid: "canary-owner",
      builderSlug: "canary",
      modelBrokerLimits: null,
      preemption: null,
    };
  }

  function forceRestartHarness(overrides: {
    selector?: unknown;
    reread?: unknown;
    afterExactPodRead?: (documents: Map<string, Record<string, unknown>>) => void;
    deleteResult?: { status: number | null; stdout: string; stderr: string };
  } = {}) {
    const documents = new Map<string, Record<string, unknown>>([
      ["gateways/canary", durableGatewayRoot()],
      ["glmOperations/audit-force-restart", {
        recordType: "audit",
        schemaVersion: 1,
        status: "in-progress",
        lifecycleStage: "action-started",
        idempotencyKey: "restart-canary-force",
        mutationFingerprint: "restart-canary-force-fingerprint",
        mutation: { kind: "restart-gateway", gatewayId: "canary", mode: "force-pod-delete" },
        actor: "operator",
        forced: true,
        what: "force restart gateway pod",
        why: "operator requested break-glass pod restart",
        target: { gatewayId: "canary" },
        preActionStatus: {},
        aliasPlan: [],
        createdAt: 1000,
        actionClaimId: "claim-force-restart",
        actionStartedAt: 1100,
        actionRecoveryCount: 0,
        completedAt: null,
      }],
    ]);
    const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
    const fixture = fixtureDocumentsAt(documents);
    const store = createJournalFixtureStore(
      {
        get: (id) => documents.get(`glmOperations/${id}`),
        set: (id, data) => {
          writes.push({ path: `glmOperations/${id}`, data });
          documents.set(`glmOperations/${id}`, data);
        },
      },
      {
        documents: {
          ...fixture,
          set: (path, data) => {
            writes.push({ path, data });
            fixture.set(path, data);
          },
        },
      },
    );
    const selector = overrides.selector ?? {
      items: [{ metadata: { name: "octogee-gateway-canary-a", uid: "pod-uid-1" } }],
    };
    const reread = overrides.reread ?? {
      metadata: { name: "octogee-gateway-canary-a", uid: "pod-uid-1" },
    };
    const kubectl = vi.fn((argv: string[], input?: string) => {
      if (argv.includes("pods")) return { status: 0, stdout: JSON.stringify(selector), stderr: "" };
      if (argv.includes("get")) {
        overrides.afterExactPodRead?.(documents);
        return { status: 0, stdout: JSON.stringify(reread), stderr: "" };
      }
      if (argv.includes("delete")) {
        expect(input).toBe(JSON.stringify({
          apiVersion: "v1",
          kind: "DeleteOptions",
          preconditions: { uid: "pod-uid-1" },
        }));
        return overrides.deleteResult ??
          { status: 0, stdout: "pod deleted", stderr: "" };
      }
      throw new Error(`unexpected kubectl args: ${argv.join(" ")}`);
    });
    const runMutation = vi.fn(async <T>(input: {
      actor: string;
      forced: boolean;
      idempotencyKey?: string;
      action: (claim: { auditId: string; claimId: string }) => Promise<T>;
    }) => input.action({ auditId: "audit-force-restart", claimId: "claim-force-restart" }));
    return { store, documents, writes, kubectl, runMutation };
  }

  it("maps a normal restart to the journaled Admin API route", () => {
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "restart", "canary", "--idempotency-key=restart-canary",
    ]))).toEqual({
      method: "POST",
      path: "/api/admin/gateways/canary/restart",
      idempotencyKey: "restart-canary",
    });
  });

  it("rejects a Shared forced pod restart before audit or kubectl", async () => {
    const { store, documents, writes, kubectl, runMutation } = forceRestartHarness();
    documents.get("gateways/canary")!.gatewayClass = "shared";
    await expect(runForcedGatewayRestart({
      store,
      kubeContext: PROD_TARGET.kubeContext, namespace: TEST_TARGET.namespace,
      gatewayId: "canary", runKubectl: kubectl, runMutation,
    })).rejects.toThrow("Shared gateways cannot be force restarted");
    expect(runMutation).not.toHaveBeenCalled();
    expect(kubectl).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("accepts only the exact restart grammar", () => {
    expect(resolveFleetGatewayRestart(parseFleetArgs([
      "--env=test", "gw", "restart", "canary", "--force", "--apply",
      "--idempotency-key=restart-canary",
    ]))).toEqual({
      gatewayId: "canary",
      force: true,
      apply: true,
      idempotencyKey: "restart-canary",
    });

    for (const argv of [
      ["--env=test", "gw", "restart", "canary", "unexpected"],
      ["--env=test", "gw", "restart", "canary", "--unknown"],
      ["--env=test", "gw", "restart", "canary", "--force=true"],
      ["--env=test", "gw", "restart", "canary", "--apply=true"],
      ["--env=test", "gw", "restart", "canary", "--idempotency-key"],
      ["--env=test", "gw", "restart", "canary", "--idempotency-key="],
    ]) {
      expect(() => resolveFleetGatewayRestart(parseFleetArgs(argv))).toThrow();
    }
  });

  it("accepts an explicit forced restart resolution without dispatching another restart", () => {
    expect(resolveFleetGatewayRestart(parseFleetArgs([
      "--env=test", "gw", "restart", "canary", "--resolve-force=audit-completed-force", "--apply",
    ]))).toEqual({ gatewayId: "canary", force: false, apply: true, resolveForceAuditId: "audit-completed-force" });
    expect(() => resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "restart", "canary", "--resolve-force=audit-completed-force",
    ]))).toThrow("resolution bypasses the Admin API");
  });

  it.each([
    ["--resolve-force"], ["--resolve-force="], ["--resolve-force=../audit"],
    ["--resolve-force=audit-1", "--force"],
  ])("rejects invalid restart resolution flags %s", (...flags) => {
    expect(() => resolveFleetGatewayRestart(parseFleetArgs(["--env=test", "gw", "restart", "canary", ...flags]))).toThrow();
  });

  it("requires exactly one fresh pod with a durable UID for a forced restart", () => {
    expect(parseForceRestartPodList(JSON.stringify({
      items: [{ metadata: { name: "octogee-gateway-canary-a", uid: "pod-uid-1" } }],
    }), "canary")).toEqual({ name: "octogee-gateway-canary-a", uid: "pod-uid-1" });

    expect(() => parseForceRestartPodList(JSON.stringify({ items: [] }), "canary"))
      .toThrow("expected exactly one pod");
    expect(() => parseForceRestartPodList(JSON.stringify({
      items: [
        { metadata: { name: "octogee-gateway-canary-a", uid: "pod-uid-1" } },
        { metadata: { name: "octogee-gateway-canary-b", uid: "pod-uid-2" } },
      ],
    }), "canary")).toThrow("expected exactly one pod");
    expect(() => parseForceRestartPodList(JSON.stringify({
      items: [{ metadata: { name: "octogee-gateway-canary-a" } }],
    }), "canary")).toThrow("missing metadata.uid");
    expect(() => parseForceRestartPodList(JSON.stringify({
      items: [{
        metadata: {
          name: "octogee-gateway-canary-a",
          uid: "pod-uid-1",
          deletionTimestamp: "2026-07-28T04:00:00Z",
        },
      }],
    }), "canary")).toThrow("is already terminating");
  });

  it("journals and performs a forced restart against only the selected pod identity", async () => {
    const { store, documents, writes, kubectl, runMutation } = forceRestartHarness();

    await expect(runForcedGatewayRestart({
      store,
      kubeContext: PROD_TARGET.kubeContext,
      namespace: TEST_TARGET.namespace,
      gatewayId: "canary",
      idempotencyKey: "restart-canary-force",
      now: () => 1234,
      runKubectl: kubectl,
      runMutation,
    })).resolves.toEqual({
      auditId: "audit-force-restart",
      podName: "octogee-gateway-canary-a",
      podUid: "pod-uid-1",
    });

    expect(runMutation).toHaveBeenCalledWith(expect.objectContaining({
      actor: "operator",
      forced: true,
      idempotencyKey: "restart-canary-force",
      mutation: { kind: "restart-gateway", gatewayId: "canary", mode: "force-pod-delete" },
    }));
    expect(documents.get("gateways/canary")?.managedBy).toBeUndefined();
    expect(documents.get("glmOperations/audit-force-restart")?.target).toEqual({
      gatewayId: "canary",
      podName: "octogee-gateway-canary-a",
      podUid: "pod-uid-1",
    });
    expect(writes.map((write) => write.path)).toEqual([
      "glmOperations/audit-force-restart",
    ]);
    expect(kubectl.mock.calls.map(([argv]) => argv)).toEqual([
      [
        "--context", PROD_TARGET.kubeContext,
        "-n", TEST_TARGET.namespace,
        "get", "pods",
        "-l", "app=octogee-gateway,gateway-instance=canary",
        "-o", "json",
      ],
      [
        "--context", PROD_TARGET.kubeContext,
        "-n", TEST_TARGET.namespace,
        "get", "pod", "octogee-gateway-canary-a",
        "-o", "json",
      ],
      [
        "--context", PROD_TARGET.kubeContext,
        "-n", TEST_TARGET.namespace,
        "delete",
        `--raw=/api/v1/namespaces/${TEST_TARGET.namespace}/pods/octogee-gateway-canary-a`,
        "-f", "-",
      ],
    ]);
  });

  it("fails before delete when the exact pod name now has a different UID", async () => {
    const { store, documents, kubectl, runMutation } = forceRestartHarness({
      reread: { metadata: { name: "octogee-gateway-canary-a", uid: "pod-uid-2" } },
    });

    await expect(runForcedGatewayRestart({
      store,
      kubeContext: PROD_TARGET.kubeContext,
      namespace: TEST_TARGET.namespace,
      gatewayId: "canary",
      now: () => 1234,
      runKubectl: kubectl,
      runMutation,
    })).rejects.toThrow("pod UID changed");

    expect(kubectl).toHaveBeenCalledTimes(2);
    expect(documents.get("glmOperations/audit-force-restart")?.target).toEqual({
      gatewayId: "canary",
      podName: "octogee-gateway-canary-a",
      podUid: "pod-uid-1",
    });
  });

  it("rejects an exact pod that entered termination after selection", async () => {
    const { store, kubectl, runMutation } = forceRestartHarness({
      reread: {
        metadata: {
          name: "octogee-gateway-canary-a",
          uid: "pod-uid-1",
          deletionTimestamp: "2026-07-28T04:00:00Z",
        },
      },
    });

    await expect(runForcedGatewayRestart({
      store,
      kubeContext: PROD_TARGET.kubeContext,
      namespace: TEST_TARGET.namespace,
      gatewayId: "canary",
      now: () => 1234,
      runKubectl: kubectl,
      runMutation,
    })).rejects.toThrow("is already terminating");

    expect(kubectl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["gateway becomes Shared", (documents: Map<string, Record<string, unknown>>) => {
      documents.set("gateways/canary", { ...documents.get("gateways/canary")!, gatewayClass: "shared" });
    }, "Shared gateways cannot be force restarted"],
    ["gateway retirement", (documents: Map<string, Record<string, unknown>>) => {
      documents.set("gateways/canary", {
        ...documents.get("gateways/canary")!,
        desiredStatus: "retired",
      });
    }, "cannot force restart a retired gateway: canary"],
    ["audit target drift", (documents: Map<string, Record<string, unknown>>) => {
      documents.set("glmOperations/audit-force-restart", {
        ...documents.get("glmOperations/audit-force-restart")!,
        target: { gatewayId: "canary", podName: "octogee-gateway-canary-a", podUid: "other-uid" },
      });
    }, "force restart audit audit-force-restart is not owned by this action"],
    ["audit target expansion", (documents: Map<string, Record<string, unknown>>) => {
      documents.set("glmOperations/audit-force-restart", {
        ...documents.get("glmOperations/audit-force-restart")!,
        target: {
          gatewayId: "canary",
          podName: "octogee-gateway-canary-a",
          podUid: "pod-uid-1",
          unexpected: true,
        },
      });
    }, "force restart audit audit-force-restart is not owned by this action"],
  ])("does not delete when %s lands after the UID re-read", async (_name, afterExactPodRead, error) => {
    const { store, kubectl, runMutation } = forceRestartHarness({ afterExactPodRead });

    await expect(runForcedGatewayRestart({
      store,
      kubeContext: PROD_TARGET.kubeContext,
      namespace: TEST_TARGET.namespace,
      gatewayId: "canary",
      now: () => 1234,
      runKubectl: kubectl,
      runMutation,
    })).rejects.toThrow(error);

    expect(kubectl).toHaveBeenCalledTimes(2);
  });

  it("binds the delete to the audited UID when replacement lands after the final fence", async () => {
    const { store, kubectl, runMutation } = forceRestartHarness({
      deleteResult: {
        status: 1,
        stdout: "",
        stderr: "409 Conflict: UID precondition failed",
      },
    });

    await expect(runForcedGatewayRestart({
      store,
      kubeContext: PROD_TARGET.kubeContext,
      namespace: TEST_TARGET.namespace,
      gatewayId: "canary",
      now: () => 1234,
      runKubectl: kubectl,
      runMutation,
    })).rejects.toThrow("409 Conflict: UID precondition failed");

    expect(kubectl).toHaveBeenCalledTimes(3);
    expect(kubectl.mock.calls[2]?.[1]).toBe(JSON.stringify({
      apiVersion: "v1",
      kind: "DeleteOptions",
      preconditions: { uid: "pod-uid-1" },
    }));
  });
});

describe("fleet CLI args", () => {
  it("resolves Firestore and Kubernetes from the active deployment target", () => {
    expect(resolveFleetDeploymentTarget("test")).toEqual({
      targetId: "test-central",
      projectId: TEST_TARGET.firebaseProjectId,
      clusterProjectId: TEST_TARGET.clusterProjectId,
      namespace: TEST_TARGET.namespace,
      kubeContext: TEST_TARGET.kubeContext,
    });
    expect(resolveFleetDeploymentTarget("prod")).toEqual({
      targetId: "prod-central",
      projectId: "octogee",
      clusterProjectId: "octogee",
      namespace: "octogee",
      kubeContext: PROD_TARGET.kubeContext,
    });
  });

  it("binds migration operations to the source and target gateways before enqueue", () => {
    expect(buildFleetMigrateOperationInput("uid-alice", "walter", "operator-green")).toEqual({
      uid: "uid-alice",
      fromGatewayId: "walter",
      toGatewayId: "operator-green",
    });
  });

  it("admits retained-pod transfer only through the explicit operator flag", () => {
    const args = parseFleetArgs(["--env=test", "migrate-customer", "alice", "--to=shared-2", "--source-transfer=retained-pod"]);
    const mode = resolveFleetSourceTransferMode(args.flags["source-transfer"]);
    expect(buildFleetMigrateOperationInput("uid-alice", "shared-1", "shared-2", mode)).toEqual({
      uid: "uid-alice",
      fromGatewayId: "shared-1",
      toGatewayId: "shared-2",
      sourceTransferMode: "retained-pod",
    });
    expect(resolveFleetSourceTransferMode(undefined)).toBeUndefined();
  });

  it.each([true, false, "", "auto", "retained", " retained-pod", null])("rejects invalid source-transfer mode %j before enqueue", (mode) => {
    expect(() => resolveFleetSourceTransferMode(mode)).toThrow("--source-transfer=retained-pod");
    expect(() => buildFleetMigrateOperationInput("uid-alice", "shared-1", "shared-2", mode)).toThrow("--source-transfer=retained-pod");
  });

  it("parses value flags in both equals and split forms", () => {
    expect(parseFleetArgs([
      "--env=prod",
      "migrate-customer",
      "alice",
      "--to",
      "canary",
      "--apply",
    ])).toEqual({
      env: "prod",
      positional: ["migrate-customer", "alice"],
      flags: { to: "canary", apply: true },
    });
  });

  it("keeps read verbs positional while recording optional filters", () => {
    expect(parseFleetArgs([
      "--env",
      "test",
      "ls",
      "customers",
      "--gateway=default",
    ])).toEqual({
      env: "test",
      positional: ["ls", "customers"],
      flags: { gateway: "default" },
    });
  });

  it("accepts release status as an unforced read verb", () => {
    const statusArgs = parseFleetArgs(["--env=test", "release", "status"]);

    expect(statusArgs).toEqual({
      env: "test",
      positional: ["release", "status"],
      flags: {},
    });
    expect(resolveFleetVerb(statusArgs)).toMatchObject({
      verb: "release status",
      writes: false,
    });
  });

  it("uses a service-account credential supplied through application-default configuration as a local signer", () => {
    expect(fleetServiceAccountCredential({
      type: "service_account",
      client_email: "fleet@example.iam.gserviceaccount.com",
      private_key: "private-key",
    }, TEST_TARGET.firebaseProjectId)).toEqual({
      projectId: TEST_TARGET.firebaseProjectId,
      clientEmail: "fleet@example.iam.gserviceaccount.com",
      privateKey: "private-key",
    });
    expect(fleetServiceAccountCredential({ type: "external_account" }, TEST_TARGET.firebaseProjectId)).toBeNull();
  });

  it("uses the environment Firebase deployer as the keyless custom-token signer", () => {
    expect(fleetFirebaseSignerServiceAccountId(TEST_TARGET.firebaseProjectId)).toBe(
      `firebase-deployer@${TEST_TARGET.firebaseProjectId}.iam.gserviceaccount.com`,
    );
  });

  it("refuses to act as anyone until OPERATOR_UID or OPERATOR_EMAIL names the operator", async () => {
    const lookups = {
      getUser: async (): Promise<{ uid: string; disabled: boolean }> => {
        throw new Error("getUser must not be called without an operator");
      },
      getUserByEmail: async (): Promise<{ uid: string; disabled: boolean }> => {
        throw new Error("getUserByEmail must not be called without an operator");
      },
      readRole: async () => "admin",
    };

    await expect(resolveFleetOperatorUid({}, lookups)).rejects.toThrow(/OPERATOR_EMAIL must name/);
    await expect(resolveFleetOperatorUid({ OPERATOR_EMAIL: " " }, lookups)).rejects.toThrow(/OPERATOR_EMAIL must name/);
  });

  it("validates every operator source as an enabled admin before the token is minted", async () => {
    const users: Record<string, { uid: string; email: string; disabled: boolean; role: string }> = {
      operator: { uid: "operator", email: "operator@example.com", disabled: false, role: "admin" },
      builder: { uid: "builder", email: "builder@example.com", disabled: false, role: "builder" },
      retired: { uid: "retired", email: "retired@example.com", disabled: true, role: "admin" },
    };
    const lookups = {
      getUser: async (uid: string) => users[uid]!,
      getUserByEmail: async (email: string) => Object.values(users).find((user) => user.email === email)!,
      readRole: async (uid: string) => users[uid]!.role,
    };

    await expect(resolveFleetOperatorUid({ OPERATOR_EMAIL: "operator@example.com" }, lookups)).resolves.toBe("operator");
    await expect(resolveFleetOperatorUid({ OPERATOR_UID: "operator" }, lookups)).resolves.toBe("operator");
    await expect(resolveFleetOperatorUid({ OPERATOR_UID: "builder" }, lookups)).rejects.toThrow(/admin role/);
    await expect(resolveFleetOperatorUid({ OPERATOR_UID: "retired" }, lookups)).rejects.toThrow(/disabled/);
    await expect(resolveFleetOperatorUid({ OPERATOR_EMAIL: "builder@example.com" }, lookups))
      .rejects.toThrow(/admin role/);
  });

  it("accepts an explicit enabled admin when other active admins exist", () => {
    expect(resolveExplicitFleetOperatorUid({
      uid: "operator-selected-by-email",
      role: "admin",
      disabled: false,
    })).toBe("operator-selected-by-email");
    expect(() => resolveExplicitFleetOperatorUid({
      uid: "retired-operator",
      role: "admin",
      disabled: true,
    })).toThrow(/disabled/);
    expect(() => resolveExplicitFleetOperatorUid({
      uid: "builder",
      role: "builder",
      disabled: false,
    })).toThrow(/admin role/);
  });

  it("rejects duplicate flags", () => {
    expect(() => parseFleetArgs([
      "--env=test",
      "release",
      "cut",
      "v0.4.0",
      "--sha=" + "a".repeat(40),
      "--sha=" + "b".repeat(40),
    ])).toThrow("duplicate --sha flag");
    expect(() => parseFleetArgs([
      "--env=test",
      "--env=prod",
      "release",
      "cut",
      "v0.4.0",
    ])).toThrow("duplicate --env flag");
  });

  it("renders the raw fleet controller lifecycle alongside release and heartbeat observations", () => {
    expect(releaseStatusRows({
      defaultGatewayId: "default",
      defaultSelection: "selected",
      gateways: [{
        gatewayId: "default",
        isDefault: true,
        desiredStatus: "running",
        desiredRelease: 4,
        liveRelease: 3,
        desiredImageTag: "abc1234-oc2026.7.1",
        runtimeRelease: 3,
        runtimeLifecycle: "reconciling",
        heartbeatStatus: "ready",
        heartbeatVersion: "abc1234-oc2026.7.1",
        lastHeartbeatAt: 1_000,
        observation: "rolling",
      }],
    })).toEqual([{
      gatewayId: "default",
      default: "*",
      desired: 4,
      live: 3,
      runtime: 3,
      lifecycle: "reconciling",
      heartbeat: "ready",
      heartbeatAt: "1970-01-01T00:00:01.000Z",
      tag: "abc1234-oc2026.7.1",
      version: "abc1234-oc2026.7.1",
      status: "rolling",
    }]);
  });

  it("parses normal gateway mutations through the gw command family", () => {
    const args = parseFleetArgs([
      "--env=test",
      "gw",
      "add",
      "--gateway-id=shared-canary",
      `--sha=${"a".repeat(40)}`,
      "--gateway-class=shared",
      "--idempotency-key=add-canary",
    ]);

    expect(resolveFleetVerb(args)).toMatchObject({ verb: "gw add", writes: true });
    expect(resolveFleetGatewayMutation(args)).toEqual({
      method: "POST",
      path: "/api/admin/gateways",
      body: {
        gatewayId: "shared-canary",
        sourceSha: "a".repeat(40),
        gatewayClass: "shared",
      },
      idempotencyKey: "add-canary",
    });
  });

  it("adds a gateway on the build the platform is running when no build is named", () => {
    const args = parseFleetArgs(["--env=test", "gw", "add", "--gateway-id=shared-canary"]);

    expect(resolveFleetGatewayMutation(args)).toEqual({
      method: "POST",
      path: "/api/admin/gateways",
      body: { gatewayId: "shared-canary" },
    });
  });

  it("refuses an abbreviated build and image references on gw add", () => {
    expect(() => resolveFleetGatewayMutation(parseFleetArgs(["--env=test", "gw", "add", "--gateway-id=shared-canary", "--sha=abc1234"])))
      .toThrow("gw add takes --sha=<full-lowercase-main-sha>");
    expect(() => resolveFleetGatewayMutation(parseFleetArgs(["--env=test", "gw", "add", "--gateway-id=shared-canary", "--image-tag=abc1234"])))
      .toThrow("gw add takes a build: name it with --sha; the images come from that build's manifest");
  });

  it("treats gw list and inspect as aliases for the existing read commands", () => {
    expect(resolveFleetVerb(parseFleetArgs(["--env=test", "gw", "ls"]))).toMatchObject({
      verb: "gw ls",
      writes: false,
    });
    expect(resolveFleetVerb(parseFleetArgs([
      "--env=test", "gw", "inspect", "canary",
    ]))).toMatchObject({
      verb: "gw inspect",
      writes: false,
    });
  });

  it("requests a journaled Shared source repair for one immutable build", async () => {
    const sourceSha = "b".repeat(40);
    const args = parseFleetArgs([
      "--env=test", "gw", "recover-source", "shared-1", `--sha=${sourceSha}`,
      "--idempotency-key=source-repair-1",
    ]);

    expect(resolveFleetVerb(args)).toMatchObject({ verb: "gw recover-source", writes: true });
    expect(resolveFleetGatewayMutation(args)).toEqual({
      method: "POST",
      path: "/api/admin/gateways/shared-1/recover-source",
      body: { sourceSha },
      idempotencyKey: "source-repair-1",
    });
    const request = vi.fn();
    await executeFleetGatewayMutation({ request }, resolveFleetGatewayMutation(args), false);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([undefined, "abc1234", "B".repeat(40)])(
    "rejects a Shared source repair without a full lowercase build SHA: %s",
    (sha) => {
      expect(() => resolveFleetGatewayMutation(parseFleetArgs([
        "--env=test", "gw", "recover-source", "shared-1",
        ...(sha === undefined ? [] : [`--sha=${sha}`]),
      ]))).toThrow("gw recover-source requires --sha");
    },
  );

  it("explicitly supersedes a failed Shared source repair through the Admin API", () => {
    const sourceSha = "c".repeat(40);
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "recover-source", "shared-1", `--sha=${sourceSha}`,
      "--supersede-recovery=failed-source-repair", "--idempotency-key=source-repair-2",
    ]))).toEqual({
      method: "POST",
      path: "/api/admin/gateways/shared-1/recover-source",
      body: { sourceSha, supersedeRecoveryId: "failed-source-repair" },
      idempotencyKey: "source-repair-2",
    });
  });

  it.each(["--supersede-recovery", "--supersede-recovery=", "--supersede-recovery=foreign/path"])(
    "rejects an invalid Shared source repair predecessor: %s",
    (flag) => {
      expect(() => resolveFleetGatewayMutation(parseFleetArgs([
        "--env=test", "gw", "recover-source", "shared-1", `--sha=${"c".repeat(40)}`, flag,
      ]))).toThrow("supersede-recovery");
    },
  );

  it("maps each existing Admin gateway action to its API request", () => {
    const sourceSha = "a".repeat(40);
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      '--env=test', 'gw', 'recover-restore', 'shared-1', `--sha=${sourceSha}`, '--operation=builder-return-1', '--idempotency-key=recovery-1',
    ]))).toEqual({ method: 'POST', path: '/api/admin/gateways/shared-1/recover-restore',
      body: { sourceSha, operationId: 'builder-return-1' }, idempotencyKey: 'recovery-1' });
    expect(() => resolveFleetGatewayMutation(parseFleetArgs([
      '--env=test', 'gw', 'recover-restore', 'shared-1', `--sha=${sourceSha}`, '--operation=foreign/path',
    ]))).toThrow('invalid restore recovery');
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      '--env=test', 'gw', 'recover-restore', 'shared-1', `--sha=${sourceSha}`, '--operation=builder-return-1', '--reauthorize-attempt=retained-1',
    ]))).toMatchObject({ body: { sourceSha, operationId: 'builder-return-1', reauthorizeAttemptId: 'retained-1' } });
    expect(() => resolveFleetGatewayMutation(parseFleetArgs([
      '--env=test', 'gw', 'recover-restore', 'shared-1', `--sha=${sourceSha}`, '--operation=builder-return-1', '--reauthorize-attempt',
    ]))).toThrow('reauthorize-attempt');
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      '--env=test', 'gw', 'recover-restore', 'shared-1', `--sha=${sourceSha}`, '--operation=builder-return-1',
      '--reauthorize-attempt=retained-1', '--supersede-recovery=failed-recovery',
    ]))).toMatchObject({ body: { sourceSha, operationId: 'builder-return-1', reauthorizeAttemptId: 'retained-1', supersedeRecoveryId: 'failed-recovery' } });
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      '--env=test', 'gw', 'recover-restore', 'shared-1', `--sha=${sourceSha}`, '--operation=builder-return-1', '--supersede-recovery=pending-recovery',
    ]))).toMatchObject({ body: { sourceSha, operationId: 'builder-return-1', supersedeRecoveryId: 'pending-recovery' } });
    expect(() => resolveFleetGatewayMutation(parseFleetArgs([
      '--env=test', 'gw', 'recover-restore', 'shared-1', `--sha=${sourceSha}`, '--operation=builder-return-1', '--reauthorize-attempt=retained-1', '--supersede-recovery',
    ]))).toThrow('supersede-recovery');
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "deploy", "canary", `--sha=${sourceSha}`,
    ]))).toEqual({
      method: "POST",
      path: "/api/admin/gateways/canary/deploy",
      body: { sourceSha },
    });
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "park", "canary",
    ]))).toEqual({
      method: "PATCH",
      path: "/api/admin/gateways/canary",
      body: { desiredStatus: "paused" },
    });
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "retire", "canary",
    ]))).toEqual({
      method: "DELETE",
      path: "/api/admin/gateways/canary",
    });
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "replace-computer", "canary", "--idempotency-key=k1", "--apply",
    ]))).toEqual({
      method: "POST",
      path: "/api/admin/gateways/canary/vm/replace",
      body: {},
      idempotencyKey: "k1",
    });
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "replace-computer", "--owner-uid=owner-1", "--idempotency-key=k2", "--apply",
    ]))).toEqual({ method: "POST", path: "/api/admin/users/owner-1/vm/replace", body: {}, idempotencyKey: "k2" });
    expect(resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "replace-computer", "--owner-uid=owner-1", "--force", "--accept-boot-data-loss", "--apply",
    ]))).toEqual({ method: "POST", path: "/api/admin/users/owner-1/vm/replace", body: { force: true, acceptBootDataLoss: true } });
    for (const argv of [
      ["--env=test", "gw", "replace-computer", "canary", "false"],
      ["--env=test", "gw", "replace-computer", "canary", "--apply=true"],
      ["--env=test", "gw", "replace-computer", "canary", "--idempotency-key"],
      ["--env=test", "gw", "replace-computer", "canary", "--force"],
      ["--env=test", "gw", "replace-computer", "canary", "--owner-uid=owner-1"],
      ["--env=test", "gw", "replace-computer", "--owner-uid=bad/owner"],
      ["--env=test", "gw", "replace-computer", "--owner-uid=.."],
      ["--env=test", "gw", "replace-computer", "--owner-uid=owner-1", "--force"],
      ["--env=test", "gw", "replace-computer", "--owner-uid=owner-1", "--accept-boot-data-loss"],
      ["--env=test", "gw", "replace-computer", "--owner-uid"],
      ["--env=test", "gw", "replace-computer"],
    ]) {
      expect(() => resolveFleetGatewayMutation(parseFleetArgs(argv))).toThrow();
    }
  });

  it("rejects incomplete gateway mutation input before any request", () => {
    expect(() => resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "deploy", "canary",
    ]))).toThrow("gw deploy requires --sha=<full-main-sha>");
    expect(() => resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "deploy", "canary", "--sha=deadbeef",
    ]))).toThrow("gw deploy requires --sha=<full-lowercase-main-sha>");
  });

  it("rejects unsafe gateway paths", () => {
    expect(() => resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "park", "a/../b",
    ]))).toThrow("gw park received an invalid gateway id");
  });

  it("does not make a normal gateway mutation request without --apply", async () => {
    const request = vi.fn(async () => ({ operationId: "op-1" }));
    const mutation = resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "park", "canary",
    ]));

    await expect(executeFleetGatewayMutation({ request }, mutation, false)).resolves.toEqual({
      applied: false,
      response: null,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("executes the normal gateway mutation through the Admin API with --apply", async () => {
    const request = vi.fn(async () => ({ gatewayId: "canary", updated: ["desiredStatus"] }));
    const mutation = resolveFleetGatewayMutation(parseFleetArgs([
      "--env=test", "gw", "park", "canary", "--idempotency-key=park-canary",
    ]));

    await expect(executeFleetGatewayMutation({ request }, mutation, true)).resolves.toEqual({
      applied: true,
      response: { gatewayId: "canary", updated: ["desiredStatus"] },
    });
    expect(request).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/api/admin/gateways/canary",
      body: { desiredStatus: "paused" },
      idempotencyKey: "park-canary",
    });
  });
});
