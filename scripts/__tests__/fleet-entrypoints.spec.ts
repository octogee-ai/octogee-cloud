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
import { withUserClaim } from "./helpers/user-claim.js";

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
      gatewayClass: "builder",
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
      gatewayClass: "builder",
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
      gatewayId: "builder-alice", gatewayClass: "builder", builderSlug: "alice", isolated: true,
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
      gatewayId: "builder-alice", gatewayClass: "builder", builderSlug, isolated: true,
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
      gatewayClass: "builder",
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
