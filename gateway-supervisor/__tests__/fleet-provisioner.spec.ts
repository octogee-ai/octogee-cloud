import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLONE_RETRY_DELAYS_MS,
  buildFleetHealthResponse,
  buildFleetStateResponse,
  openclawProcessReport,
  cloneRetryDelayMs,
  cloneRetryReady,
  userEnsureRetryReady,
  consumeRecoveredUserRuntimeReset,
  dashboardBridgeReady,
  cancelRemovedEviction,
  createConfiguredUserAssignmentMatcher,
  createConfiguredUserReconcileAdmission,
  createReconcileConvergenceHooks,
  userSourceOpenClawHeld,
  createIsolatedSurgeGateWiring,
  createVerifyAttachPending,
  permanentConfigPatchRetryReady,
  createMountRefusalReader,
  ensureUserCheckoutsOnly,
  NEEDS_FULL_ATTACH_FINGERPRINT,
  evictLocalUser,
  evictLocalUserIfStillUndesired,
  finalizeConvergedMount,
  pendingCloneAppliedFingerprint,
  pendingCloneOnlyStale,
  settleConvergence,
  selectStableContentStale,
  getEvictObservedSlugs,
  getMountObservedSlugs,
  probeSurgeReadiness,
  probeOpenClawRuntimeReady,
  reconcileAddUserOptions,
  resolveFleetCapabilities,
  runProvisioningWork,
  waitForBrokerProfilesSettled,
  waitForDashboardBridgeReady,
  waitForOpenClawHealthz,
} from "../lib/fleet-provisioner.js";
import {
  addUserToGateway,
  type UserLifecycleAdapter,
} from "../lib/user-lifecycle.js";
import { createSurgeOpenClawProcessGate, createSurgeOpenClawProcessSupervisorClient } from "../lib/surge-openclaw-process-gate.js";
import type {
  SurgeOpenClawProcessGateState,
  SurgeOpenClawProcessRequest,
  SurgeOpenClawProcessSupervisorClient,
} from "../lib/surge-openclaw-process-gate.js";
import type { SurgeReadinessGate } from "../lib/surge-readiness.js";
import { openClawRuntimeUpdateGuard } from "../lib/openclaw-runtime-update-guard.js";
import { _resetReconcileInFlightForTests, startReconcileLoop } from "../lib/reconcile-loop.js";
import { startAfterSurgeReadiness } from "../lib/surge-reconcile-gate.js";
import {
  _resetMigratingInProcessPinsForTests,
  isMigratingInPinned,
  listLocalUserDirs,
  writeMigratingInPin,
} from "../lib/local-default-agent-wired.js";
import { stubUserClaim } from "./helpers/user-claim.js";
import { buildBrokeredLifecycleAdapter } from "../lib/user-lifecycle-broker-adapter.js";
import { userClaimFromIdentity, markUserClaimOverlayApplied, writeUserClaim } from "@octogee/shared/server/user-claim";

const tmpDirs: string[] = [];

afterEach(() => _resetMigratingInProcessPinsForTests());
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function recoveredSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    uid: "uid-alice",
    slug: "alice",
    gatewayId: "shared-a",
    agentIds: ["octogee-alice-coach"],
    runtimeReset: {
      status: "pending",
      uid: "uid-alice",
      slug: "alice",
      operationId: "recover-alice-7",
      sourceGatewayId: "alice-user",
      targetGatewayId: "shared-a",
      generation: 8,
      disposableLeaseId: "lease-alice",
      disposableLeaseGeneration: 2,
      requestedAt: 1_000,
    },
    ...overrides,
  } as never;
}

describe("recovered user runtime reset — mount admission", () => {
  it("resets before acknowledging the exact pending marker", async () => {
    const events: string[] = [];
    const reset = vi.fn(() => {
      events.push("reset");
      return {
        removedAgentRegistrations: ["octogee-alice-coach"],
        removedAgentStores: ["octogee-alice-coach"],
        clearedWorkspaceAttestations: [],
      };
    });
    const acknowledge = vi.fn(async () => {
      events.push("ack");
    });

    await expect(consumeRecoveredUserRuntimeReset({
      gatewayId: "shared-a",
      uid: "uid-alice",
      slug: "alice",
      openclawDir: "/tmp/openclaw-test",
      readSnapshot: async () => recoveredSnapshot(),
      acknowledge,
      reset,
    })).resolves.toMatchObject({ removedAgentStores: ["octogee-alice-coach"] });

    expect(events).toEqual(["reset", "ack"]);
    expect(acknowledge).toHaveBeenCalledWith("uid-alice", "recover-alice-7", 8);
  });

  it("does nothing on an ordinary add without a recovery marker", async () => {
    const reset = vi.fn();
    const acknowledge = vi.fn();
    await expect(consumeRecoveredUserRuntimeReset({
      gatewayId: "shared-a",
      uid: "uid-alice",
      slug: "alice",
      openclawDir: "/tmp/openclaw-test",
      readSnapshot: async () => recoveredSnapshot({ runtimeReset: undefined }),
      acknowledge,
      reset,
    })).resolves.toBeNull();
    expect(reset).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("fails closed and leaves acknowledgement pending when reset fails", async () => {
    const acknowledge = vi.fn();
    await expect(consumeRecoveredUserRuntimeReset({
      gatewayId: "shared-a",
      uid: "uid-alice",
      slug: "alice",
      openclawDir: "/tmp/openclaw-test",
      readSnapshot: async () => recoveredSnapshot(),
      acknowledge,
      reset: () => {
        throw new Error("sqlite reset failed");
      },
    })).rejects.toThrow(/sqlite reset failed/u);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("rejects a changed target identity before touching local state", async () => {
    const reset = vi.fn();
    const acknowledge = vi.fn();
    await expect(consumeRecoveredUserRuntimeReset({
      gatewayId: "shared-b",
      uid: "uid-alice",
      slug: "alice",
      openclawDir: "/tmp/openclaw-test",
      readSnapshot: async () => recoveredSnapshot(),
      acknowledge,
      reset,
    })).rejects.toThrow(/identity fence changed/u);
    expect(reset).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });
});

describe("settleConvergence — the applied-fingerprint gate", () => {
  const hooks = () => ({
    recordApplied: vi.fn(),
    rememberRetry: vi.fn(),
    forgetRetry: vi.fn(),
  });

  const pending = (slugs: string[]) => ({
    now: 1_000,
    slug: "alice",
    desiredFingerprint: "fp1",
    prior: undefined,
    result: { pendingProjectClones: slugs },
  });

  it("records the fingerprint and drops any backoff once every checkout has landed", () => {
    const h = hooks();
    settleConvergence(
      {
        now: 1_000,
        slug: "alice",
        desiredFingerprint: "fp1",
        prior: { attempts: 3, nextAt: 0, fingerprint: "fp1" },
        result: { pendingProjectClones: [] },
      },
      h,
    );
    expect(h.recordApplied).toHaveBeenCalledWith("alice", "fp1");
    expect(h.forgetRetry).toHaveBeenCalledWith("alice");
    expect(h.rememberRetry).not.toHaveBeenCalled();
  });

  it("THROWS while a checkout is absent — returning normally would fire the loop's onEnsureSuccess, which clears the very lastError an operator needs to see", () => {
    const h = hooks();
    expect(() => settleConvergence(pending(["camp"]), h)).toThrow(/camp/);
  });

  it("parks the user on the pending-clone marker and schedules a backed-off retry while a checkout is absent", () => {
    const h = hooks();
    expect(() => settleConvergence(pending(["camp"]), h)).toThrow();
    expect(h.recordApplied).toHaveBeenCalledWith(
      "alice",
      pendingCloneAppliedFingerprint("fp1"),
    );
    expect(h.rememberRetry).toHaveBeenCalledWith("alice", {
      attempts: 1,
      nextAt: 1_000 + cloneRetryDelayMs(1),
      fingerprint: "fp1",
    });
  });

  it("never records the real fingerprint while a checkout is absent — the marker stays stale against every real fingerprint", () => {
    const h = hooks();
    expect(() => settleConvergence(pending(["camp"]), h)).toThrow();
    expect(h.recordApplied).not.toHaveBeenCalledWith("alice", "fp1");
    expect(pendingCloneOnlyStale(pendingCloneAppliedFingerprint("fp1"), "fp1")).toBe(true);
    expect(pendingCloneOnlyStale(pendingCloneAppliedFingerprint("fp1"), "fp2")).toBe(false);
    expect(pendingCloneOnlyStale("fp1", "fp1")).toBe(false);
    expect(pendingCloneOnlyStale(undefined, "fp1")).toBe(false);
  });

  it("records the post-attach fingerprint instead of relaunching a newly provisioned user as stale", () => {
    const h = hooks();
    settleConvergence(
      {
        now: 1_000,
        slug: "alice",
        desiredFingerprint: "before-mattermost",
        prior: undefined,
        result: {
          pendingProjectClones: [],
          appliedFingerprint: "after-mattermost",
        },
      },
      h,
    );

    expect(h.recordApplied).toHaveBeenCalledWith("alice", "after-mattermost");
  });

  it("lengthens the backoff on repeat and caps it — never abandons, never hot-loops", () => {
    expect(cloneRetryDelayMs(1)).toBeLessThan(cloneRetryDelayMs(2));
    expect(cloneRetryDelayMs(2)).toBeLessThan(cloneRetryDelayMs(3));
    expect(cloneRetryDelayMs(99)).toBe(cloneRetryDelayMs(CLONE_RETRY_DELAYS_MS.length));
  });
});

describe("finalizeConvergedMount — the durable mount boundary", () => {
  it.each([undefined, ""])("retains prior retry state %s when fingerprint persistence fails", (previous) => {
    const appliedFp = new Map<string, string>(previous === undefined ? [] : [["alice", previous]]);
    const hooks = createReconcileConvergenceHooks({
      userSource: async () => new Map([["alice", { fingerprint: "new-fp", lane: "move" as const }]]),
      appliedFp,
      cloneRetry: new Map(),
      persistAppliedFp: () => { throw new Error("fingerprint disk unavailable"); },
    });
    expect(() => hooks.recordApplied("alice", "new-fp")).toThrow("fingerprint disk unavailable");
    expect(appliedFp.get("alice")).toBe(previous);
  });

  it("stamps and marks the completed mount even while a project checkout is pending — the retry must be checkout-only, never a full re-attach", async () => {
    const stampMounted = vi.fn(async () => undefined);
    const writeMountMarker = vi.fn();
    const hooks = {
      recordApplied: vi.fn(),
      rememberRetry: vi.fn(),
      forgetRetry: vi.fn(),
    };

    await expect(finalizeConvergedMount({
      now: 1_000,
      slug: "alice",
      uid: "uid-alice",
      desiredFingerprint: "fp1",
      prior: undefined,
      result: { pendingProjectClones: ["camp"] },
      hooks,
      stampMounted,
      writeMountMarker,
    })).rejects.toThrow(/camp/);

    expect(hooks.rememberRetry).toHaveBeenCalledOnce();
    expect(hooks.recordApplied).toHaveBeenCalledWith(
      "alice",
      pendingCloneAppliedFingerprint("fp1"),
    );
    expect(stampMounted).toHaveBeenCalledWith("uid-alice", true);
    expect(writeMountMarker).toHaveBeenCalledWith("alice");
  });

  it("stamps and marks the mount before settling so the pending-clone throw cannot leave a completed mount unmarked", async () => {
    const events: string[] = [];
    const hooks = {
      recordApplied: vi.fn(() => events.push("applied")),
      rememberRetry: vi.fn(),
      forgetRetry: vi.fn(() => events.push("retry-forgotten")),
    };

    await finalizeConvergedMount({
      now: 1_000,
      slug: "alice",
      uid: "uid-alice",
      desiredFingerprint: "fp1",
      prior: undefined,
      result: { pendingProjectClones: [] },
      hooks,
      stampMounted: vi.fn(async () => {
        events.push("mounted-stamped");
      }),
      writeMountMarker: vi.fn(() => events.push("mount-marker")),
    });

    expect(events).toEqual([
      "mounted-stamped",
      "mount-marker",
      "retry-forgotten",
      "applied",
    ]);
  });
});

describe("ensureUserCheckoutsOnly — the pending-clone retry lane", () => {
  const adapterWith = (overrides: Record<string, unknown>) => ({
    log: vi.fn(),
    listProjectsNeedingClone: vi.fn(async () => []),
    cloneProjectRepo: vi.fn(async () => true),
    ...overrides,
  }) as unknown as UserLifecycleAdapter;

  it("routes the next converge to a full attach once the checkout lands, so the held-out project agent gets wired", async () => {
    const adapter = adapterWith({
      listProjectsNeedingClone: vi.fn(async () => []),
    });
    const hooks = {
      recordApplied: vi.fn(),
      rememberRetry: vi.fn(),
      forgetRetry: vi.fn(),
    };

    const outcome = await ensureUserCheckoutsOnly(
      adapter,
      { now: 1_000, slug: "alice", desiredFingerprint: "fp1", prior: undefined },
      hooks,
    );

    expect(outcome).toBe("noop");
    expect(hooks.recordApplied).toHaveBeenCalledWith("alice", NEEDS_FULL_ATTACH_FINGERPRINT);
    expect(hooks.forgetRetry).toHaveBeenCalledWith("alice");
    expect(pendingCloneOnlyStale(NEEDS_FULL_ATTACH_FINGERPRINT, "fp1")).toBe(false);
  });

  it("re-arms the marker and the lengthened backoff while the checkout is still absent, and throws so lastError persists", async () => {
    const adapter = adapterWith({
      listProjectsNeedingClone: vi.fn(async () => [
        { projectSlug: "camp", giteaRepoName: null },
      ]),
    });
    const hooks = {
      recordApplied: vi.fn(),
      rememberRetry: vi.fn(),
      forgetRetry: vi.fn(),
    };

    await expect(ensureUserCheckoutsOnly(
      adapter,
      {
        now: 1_000,
        slug: "alice",
        desiredFingerprint: "fp1",
        prior: { attempts: 2, nextAt: 0, fingerprint: "fp1" },
      },
      hooks,
    )).rejects.toThrow(/camp/);

    expect(hooks.recordApplied).toHaveBeenCalledWith(
      "alice",
      pendingCloneAppliedFingerprint("fp1"),
    );
    expect(hooks.rememberRetry).toHaveBeenCalledWith("alice", {
      attempts: 3,
      nextAt: 1_000 + cloneRetryDelayMs(3),
      fingerprint: "fp1",
    });
  });
});

describe("selectStableContentStale", () => {
  it("re-ensures a migrated target after cutover when its fingerprint was intentionally withheld", () => {
    const pending = new Map<string, string>();
    const desired = new Map([["august", "projects-ready"]]);
    const applied = new Map<string, string>();
    expect(selectStableContentStale(
      ["august"],
      desired,
      applied,
      pending,
    )).toEqual([]);
    expect(selectStableContentStale(
      ["august"],
      desired,
      applied,
      pending,
    )).toEqual(["august"]);
  });

  it("coalesces intermediate project provisioning fingerprints into one final re-ensure", () => {
    const pending = new Map<string, string>();
    const applied = new Map([["alice", "before-project"]]);

    expect(selectStableContentStale(
      ["alice"],
      new Map([["alice", "project-provisioning"]]),
      applied,
      pending,
    )).toEqual([]);
    expect(selectStableContentStale(
      ["alice"],
      new Map([["alice", "project-active"]]),
      applied,
      pending,
    )).toEqual([]);
    expect(selectStableContentStale(
      ["alice"],
      new Map([["alice", "project-active"]]),
      applied,
      pending,
    )).toEqual(["alice"]);

    applied.set("alice", "project-active");
    expect(selectStableContentStale(
      ["alice"],
      new Map([["alice", "project-active"]]),
      applied,
      pending,
    )).toEqual([]);
    expect(pending.has("alice")).toBe(false);
  });
});

describe("reconcileAddUserOptions", () => {
  it("forces the full lifecycle path when snapshot fingerprints drive convergence", () => {
    expect(reconcileAddUserOptions(true)).toEqual({ convergeContent: true });
    expect(reconcileAddUserOptions(false)).toEqual({});
  });
});

describe("cloneRetryReady — holds a stranded slug off the hot path between attempts", () => {
  it("is ready when nothing is pending", () => {
    expect(cloneRetryReady(undefined, "fp1", 1_000)).toBe(true);
  });

  it("waits out the backoff, so a wedged checkout cannot re-ensure the user every 15s", () => {
    const prior = { attempts: 2, nextAt: 5_000, fingerprint: "fp1" };
    expect(cloneRetryReady(prior, "fp1", 4_999)).toBe(false);
    expect(cloneRetryReady(prior, "fp1", 5_000)).toBe(true);
  });

  it("converges IMMEDIATELY on genuine drift — a new project must never wait out a backoff earned by an unrelated stranded one", () => {
    const prior = { attempts: 5, nextAt: 9_000_000, fingerprint: "fp1" };
    expect(cloneRetryReady(prior, "fp2", 1_000)).toBe(true);
  });
});

describe("userEnsureRetryReady", () => {
  const pendingClone = { attempts: 1, nextAt: 5_000, fingerprint: "fp1" };

  it("does not retry a quiescing source even when a new channel changes its fingerprint", () => {
    expect(userEnsureRetryReady({
      ensureAllowed: false,
      cloneRetry: pendingClone,
      desiredFingerprint: "new-empty-channel",
      now: 1_001,
      permanentConfigPatchRetry: undefined,
    })).toBe(false);
  });

  it("holds a cold or unmounted user until its project-clone backoff expires", () => {
    expect(userEnsureRetryReady({
      ensureAllowed: true,
      cloneRetry: pendingClone,
      desiredFingerprint: "fp1",
      now: 4_999,
      permanentConfigPatchRetry: undefined,
    })).toBe(false);
  });

  it("bypasses clone backoff immediately when the desired user fingerprint changes", () => {
    expect(userEnsureRetryReady({
      ensureAllowed: true,
      cloneRetry: pendingClone,
      desiredFingerprint: "fp2",
      now: 1_001,
      permanentConfigPatchRetry: undefined,
    })).toBe(true);
  });

  it("holds the failing user until its config-patch retry is due", () => {
    expect(userEnsureRetryReady({
      ensureAllowed: true,
      cloneRetry: undefined,
      desiredFingerprint: "fp1",
      now: 5_000,
      permanentConfigPatchRetry: { fingerprint: "fp1", nextAt: 60_000, reason: "invalid patch" },
    })).toBe(false);
  });
});

describe("permanentConfigPatchRetryReady", () => {
  it("retries an unchanged failure when its bounded backoff expires", () => {
    const prior = { fingerprint: "same", nextAt: 60_000, reason: "invalid patch" };
    expect(permanentConfigPatchRetryReady(prior, "same", 59_999)).toBe(false);
    expect(permanentConfigPatchRetryReady(prior, "same", 60_000)).toBe(true);
  });

  it("holds an unchanged invalid patch and immediately re-enables it for a changed desired fingerprint", () => {
    const unchanged = "user-fp1";
    const changed = "user-fp2";
    expect(permanentConfigPatchRetryReady({ fingerprint: unchanged, nextAt: 60_000, reason: "invalid patch" }, unchanged, 0)).toBe(false);
    expect(permanentConfigPatchRetryReady({ fingerprint: unchanged, nextAt: 60_000, reason: "invalid patch" }, changed, 0)).toBe(true);
  });
});

describe("createMountRefusalReader", () => {
  const reason = "config.patch would remove entries from array path(s): agents.entries.octogee-unmatched-route.tools.deny";
  function reader(input: { refused?: boolean; desired?: string; applied?: string }) {
    const appliedFingerprints = new Map<string, string>();
    if (input.applied !== undefined) {
      createReconcileConvergenceHooks({
        userSource: async () => new Map(), appliedFp: appliedFingerprints, cloneRetry: new Map(), persistAppliedFp: () => undefined,
      }).recordApplied("alice", input.applied);
    }
    return createMountRefusalReader({
      permanentConfigPatchRetry: new Map(input.refused === false ? [] : [["alice", { fingerprint: "user-fp1", nextAt: 60_000, reason }]]),
      desiredFingerprints: new Map([["alice", input.desired ?? "user-fp1"]]),
      appliedFingerprints,
    });
  }

  it("reports nothing while no ensure has been permanently refused", () => {
    expect(reader({ refused: false })("alice")).toBeNull();
  });

  it("reports nothing once the desired fingerprint moved past the refused one", () => {
    expect(reader({ desired: "user-fp2" })("alice")).toBeNull();
  });

  it("reports an unconverged refusal when nothing was ever applied", () => {
    expect(reader({})("alice")).toEqual({ reason, converged: false });
  });

  it("reports an unconverged refusal after the add's publication invalidated the fingerprint", () => {
    expect(reader({ applied: NEEDS_FULL_ATTACH_FINGERPRINT })("alice")).toEqual({ reason, converged: false });
  });

  it("reports a converged refusal when an earlier configuration applied", () => {
    expect(reader({ applied: "user-fp0" })("alice")).toEqual({ reason, converged: true });
  });
});

function mkObservedAdapter(over: Partial<UserLifecycleAdapter>): UserLifecycleAdapter {
  return {
    hasUserAgentRuntime: () => true,
    hasWorkspaceGitDir: () => true,
    hasGitRemote: () => true,
    ...over,
  } as UserLifecycleAdapter;
}

function createProvisioningCounter(): {
  provisioning: {
    beginProvisioning: () => void;
    finishProvisioning: () => void;
  };
  active: () => number;
  waitForDrain: () => Promise<void>;
} {
  let active = 0;
  const waiters = new Set<() => void>();
  return {
    provisioning: {
      beginProvisioning: () => {
        active += 1;
      },
      finishProvisioning: () => {
        active -= 1;
        if (active !== 0) return;
        for (const resolve of waiters) resolve();
        waiters.clear();
      },
    },
    active: () => active,
    waitForDrain: () => active === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.add(resolve)),
  };
}

function configuredUserLifecycleAdapter(input: {
  cloneWorkspaceRepo?: () => Promise<boolean>;
  writeMountMarker?: () => void;
  registerKey?: () => Promise<void>;
} = {}): { adapter: UserLifecycleAdapter; calls: string[] } {
  const calls: string[] = [];
  let customerDir = false;
  let workspaceGitDir = false;
  let gitRemote = false;
  let mountMarked = false;
  const cloneWorkspaceRepo = input.cloneWorkspaceRepo ?? (async () => true);
  const adapter = {
    listProjectsNeedingClone: vi.fn(async () => []),
    log: () => undefined,
    isIsolatedGateway: () => true,
    isConfiguredUser: (slug: string) => slug === "ceckert-test",
    configuredUserOverlayPresent: () => true,
    uidForSlug: async () => "uid-user",
    loadUserSnapshot: async () => ({
      uid: "uid-user",
      slug: "ceckert-test",
      contextTemplateKey: "default",
      planInputs: { tier: "trial" },
      gatewayId: "gw-user",
      status: "complete" as const,
      agentIds: [],
      repoUrl: "http://gitea/octogee/ceckert-test-workspace",
      mattermostUserId: null,
      channels: [],
      ownerName: "User",
    }),
    hasUserSshKey: () => true,
    readLocalUserPubKey: () => "ssh-pubkey",
    restoreByosubForAgent: async () => {
      calls.push("restore-byosub");
      return { restored: false, present: false };
    },
    gitHost: {
      listKeys: async () => ["ssh-pubkey"],
      registerKey: async () => {
        calls.push("claim-gitea-key");
        await input.registerKey?.();
      },
    },
    hasUserDir: () => customerDir,
    hasWorkspaceGitDir: () => workspaceGitDir,
    hasGitRemote: () => gitRemote,
    cloneWorkspaceRepo: async () => {
      calls.push("clone-workspace");
      const cloned = await cloneWorkspaceRepo();
      if (cloned) {
        customerDir = true;
        workspaceGitDir = true;
        gitRemote = true;
      }
      return cloned;
    },
    ensureUserDirectories: () => {
      calls.push("ensure-user-directories");
      customerDir = true;
    },
    writeUserTemplateFiles: async () => {
      calls.push("write-user-template-files");
    },
    userDefaultAgentWiredInOpenclawConfig: () => false,
    writeMountMarker: () => {
      calls.push("mount-marker");
      mountMarked = true;
      input.writeMountMarker?.();
    },
    userMountMarked: () => mountMarked,
    listLocalUserSlugs: () => mountMarked ? ["ceckert-test"] : [],
  } as unknown as UserLifecycleAdapter;
  return { adapter, calls };
}

describe("configured user surge release", () => {
  it("matches configured user ownership against the authoritative desired roster", async () => {
    const readDesiredUsers = vi.fn(async () => new Map([
      ["ceckert-test", { uid: "uid-user", fingerprint: "fingerprint", lane: "move" as const, ensureAllowed: true }],
    ]));
    const matches = createConfiguredUserAssignmentMatcher({
      readDesiredUsers,
    });

    await expect(matches("ceckert-test")).resolves.toBe(true);
    await expect(matches("other-user")).resolves.toBe(false);
    expect(readDesiredUsers).toHaveBeenCalledTimes(2);
  });

  it("keeps an unassigned prelaunch empty until canonical migration reserves it", async () => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    try {
      let mounted = false;
      const events: string[] = [];
      const adapter = {
        isIsolatedGateway: () => true,
        isConfiguredUser: (slug: string) => slug === "ceckert-test",
        configuredUserOverlayPresent: () => true,
        listLocalUserSlugs: () => mounted ? ["ceckert-test"] : [],
        userMountMarked: () => mounted,
        hasWorkspaceGitDir: () => true,
        hasGitRemote: () => true,
      } as unknown as UserLifecycleAdapter;
      let gateState: SurgeOpenClawProcessGateState = {
        version: 1,
        podUid: "target-pod",
        role: "normal",
        mode: "held",
        phase: "held",
      };
      const processGate = {
        status: vi.fn(async () => gateState),
        hydrate: vi.fn(async (request: SurgeOpenClawProcessRequest) => {
          events.push("reserve");
          gateState = {
            version: 1,
            podUid: "target-pod",
            role: "target",
            mode: "held",
            phase: "held",
            ...request,
          };
          return gateState;
        }),
        claimTargetCompletion: vi.fn(async () => {
          events.push("claim");
          gateState = { ...gateState, phase: "completing" } as SurgeOpenClawProcessGateState;
          return gateState;
        }),
        permit: vi.fn(async () => {
          events.push("permit");
          gateState = {
            ...gateState,
            mode: "permitted",
            phase: "running",
          } as SurgeOpenClawProcessGateState;
          return gateState;
        }),
        releaseTarget: vi.fn(async () => {
          events.push("release-target");
          gateState = {
            version: 1 as const,
            podUid: "target-pod",
            role: "normal" as const,
            mode: "permitted" as const,
            phase: "running" as const,
          };
          return gateState;
        }),
        permitNormal: vi.fn(),
        holdNormal: vi.fn(),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const attachConfiguredUserBeforeOpenClaw = vi.fn(async () => {
        events.push("attach");
        mounted = true;
        return "ceckert-test";
      });
      const surgeReadiness = {
        release: vi.fn(async () => {
          events.push("release");
        }),
      } as unknown as SurgeReadinessGate;
      const wiring = createIsolatedSurgeGateWiring({
        adapter,
        processGate,
        surgeReadiness,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => {
          events.push("ready");
        },
        log: () => undefined,
        provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
        configuredUserAssigned: async () => false,
        attachConfiguredUserBeforeOpenClaw,
      });
      let assigned = false;
      const reconcileAdmission = createConfiguredUserReconcileAdmission({
        processGate,
        hasServingAssignment: async () => assigned,
        log: () => undefined,
      });

      await expect(reconcileAdmission()).resolves.toBe(false);
      expect(attachConfiguredUserBeforeOpenClaw).not.toHaveBeenCalled();
      expect(vi.mocked(processGate.permitNormal)).not.toHaveBeenCalled();
      expect(vi.mocked(surgeReadiness.release)).not.toHaveBeenCalled();

      await wiring.reserveSurgeTarget({
        migrationId: "mig-user",
        slug: "ceckert-test",
      });
      await wiring.releaseSurgeReadiness({
        migrationId: "mig-user",
        targetPodUid: "target-pod",
      });

      expect(events).toEqual([
        "reserve",
        "claim",
        "claim",
        "claim",
        "attach",
        "permit",
        "ready",
        "release-target",
      ]);
      expect(attachConfiguredUserBeforeOpenClaw).toHaveBeenCalledTimes(1);
      await expect(reconcileAdmission()).resolves.toBe(false);
      assigned = true;
      await expect(reconcileAdmission()).resolves.toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("mounts the held imported tree before permitting OpenClaw and releases the target without waiting on its agent", async () => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const events: string[] = [];
      let mounted = false;
      const adapter = {
        isIsolatedGateway: () => true,
        isConfiguredUser: (slug: string) => slug === "ceckert-test",
        configuredUserOverlayPresent: () => true,
        listLocalUserSlugs: () => mounted ? ["ceckert-test"] : [],
        userMountMarked: () => mounted,
        userDefaultAgentWiredInOpenclawConfig: () => true,
        waitForAccountHealthy: async () => {
          events.push("coach-health");
          return false;
        },
        hasWorkspaceGitDir: () => true,
        hasGitRemote: () => true,
      } as unknown as UserLifecycleAdapter;
      const processGate = {
        status: vi.fn(async () => {
          events.push("status");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "held" as const,
            phase: "held" as const,
            migrationId: "mig-user",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        claimTargetCompletion: vi.fn(async () => {
          events.push("claim");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "held" as const,
            phase: "completing" as const,
            migrationId: "mig-user",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        permit: vi.fn(async () => {
          events.push("permit");
          vi.setSystemTime(Date.now() + 1_000);
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "permitted" as const,
            phase: "running" as const,
            migrationId: "mig-user",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        releaseTarget: vi.fn(async () => {
          events.push("release-target");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "normal" as const,
            mode: "permitted" as const,
            phase: "running" as const,
          };
        }),
        hold: vi.fn(),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const surgeReadiness = {
        release: vi.fn(async () => {
          events.push("release");
        }),
      } as unknown as SurgeReadinessGate;
      const attachConfiguredUserBeforeOpenClaw = vi.fn(async () => {
        events.push("attach");
        vi.setSystemTime(Date.now() + 5_000);
        mounted = true;
        return "ceckert-test";
      });
      const configuredUserAssigned = vi.fn(async () => false);
      const log = vi.fn();
      const wiring = createIsolatedSurgeGateWiring({
        adapter,
        processGate,
        surgeReadiness,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => {
          events.push("ready");
          vi.setSystemTime(Date.now() + 41_000);
        },
        log,
        provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
        configuredUserAssigned,
        attachConfiguredUserBeforeOpenClaw,
      });

      await wiring.releaseSurgeReadiness({
        migrationId: "mig-user",
        targetPodUid: "target-pod",
      });

      expect(events).toEqual([
        "status",
        "claim",
        "claim",
        "claim",
        "attach",
        "permit",
        "ready",
        "release-target",
      ]);
      expect(vi.mocked(processGate.permit)).toHaveBeenCalledWith({
        migrationId: "mig-user",
        slug: "ceckert-test",
        targetPodUid: "target-pod",
      });
      expect(vi.mocked(processGate.releaseTarget)).toHaveBeenCalledWith({
        migrationId: "mig-user",
        slug: "ceckert-test",
        targetPodUid: "target-pod",
      });
      expect(configuredUserAssigned).not.toHaveBeenCalled();
      expect(vi.mocked(surgeReadiness.release)).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[surge-handoff] configured user OpenClaw ready 42000ms after permit: ceckert-test");
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("does not reconcile a released-marker target until its user process gate is permitted", async () => {
    vi.useFakeTimers();
    stubUserClaim("ceckert-test");
    try {
      let mode: "held" | "permitted" = "held";
      const logs: string[] = [];
      const processGate = {
        status: vi.fn(async () => ({
          version: 1 as const,
          podUid: "target-pod",
          role: "target" as const,
          mode,
          phase: mode === "held" ? "held" as const : "running" as const,
          migrationId: "mig-user",
          slug: "ceckert-test",
          targetPodUid: "target-pod",
        })),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const admission = createConfiguredUserReconcileAdmission({
        processGate,
        hasServingAssignment: async () => true,
        log: (message) => logs.push(message),
      });
      const getMountObserved = vi.fn(() => [] as string[]);
      const getEvictObserved = vi.fn(() => ["stale"]);
      const readDesired = vi.fn(async () => ["ceckert-test"]);
      const add = vi.fn();
      const mount = vi.fn();
      const workspace = vi.fn();
      const evict = vi.fn();
      const start = vi.fn(() => startReconcileLoop({
        gatewayId: "builder",
        intervalMs: 10,
        canReconcile: admission,
        getMountObserved,
        getEvictObserved,
        readDesired,
        ensureSlug: async () => {
          add();
          mount();
          workspace();
          return "mounted" as const;
        },
        unmountSlug: async () => {
          evict();
          return "drained" as const;
        },
        log: (message) => logs.push(message),
      }));
      const stop = startAfterSurgeReadiness({
        released: async () => true,
        start,
        log: (message) => logs.push(message),
      });

      await vi.advanceTimersByTimeAsync(10);

      expect(start).toHaveBeenCalledOnce();
      expect(getMountObserved).not.toHaveBeenCalled();
      expect(getEvictObserved).not.toHaveBeenCalled();
      expect(readDesired).not.toHaveBeenCalled();
      expect(add).not.toHaveBeenCalled();
      expect(mount).not.toHaveBeenCalled();
      expect(workspace).not.toHaveBeenCalled();
      expect(evict).not.toHaveBeenCalled();
      expect(logs).toContain(
        "[surge-handoff] reconcile paused while configured user process gate is target/held",
      );

      mode = "permitted";
      await vi.advanceTimersByTimeAsync(10);

      expect(add).toHaveBeenCalledOnce();
      expect(mount).toHaveBeenCalledOnce();
      expect(workspace).toHaveBeenCalledOnce();
      expect(evict).toHaveBeenCalledOnce();
      stop();
    } finally {
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });

  it("fails closed without repeating a user process-gate status error", async () => {
    const logs: string[] = [];
    const admission = createConfiguredUserReconcileAdmission({
      hasServingAssignment: async () => true,
      processGate: {
        status: vi.fn(async () => {
          throw new Error("supervisor unavailable");
        }),
      } as unknown as SurgeOpenClawProcessSupervisorClient,
      log: (message) => logs.push(message),
    });

    await expect(admission()).resolves.toBe(false);
    await expect(admission()).resolves.toBe(false);

    expect(logs).toEqual([
      "[surge-handoff] reconcile paused while configured user process gate has status error: supervisor unavailable",
    ]);
  });

  it("defers target release until an actual deadline-raced user clone settles", async () => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    try {
      const events: string[] = [];
      let releaseClone!: () => void;
      const clone = new Promise<void>((resolve) => {
        releaseClone = resolve;
      });
      let cloneStarted!: () => void;
      const cloneStartedPromise = new Promise<void>((resolve) => {
        cloneStarted = resolve;
      });
      const { adapter, calls } = configuredUserLifecycleAdapter({
        cloneWorkspaceRepo: async () => {
          cloneStarted();
          await clone;
          return true;
        },
      });
      const counter = createProvisioningCounter();
      const staleEnsure = runProvisioningWork({
        provisioning: counter.provisioning,
        work: (onWorkSettled) => addUserToGateway(adapter, "uid-user", {
          mountDeadlineMs: 25,
          onWorkSettled,
        }),
      });
      await cloneStartedPromise;
      await expect(staleEnsure).rejects.toThrow(/mountDeadlineMs.*25ms.*exceeded/i);
      expect(counter.active()).toBe(1);

      let releaseWaitStarted!: () => void;
      const releaseWaitStartedPromise = new Promise<void>((resolve) => {
        releaseWaitStarted = resolve;
      });
      const processGate = {
        status: vi.fn(async () => ({
          version: 1 as const,
          podUid: "target-pod",
          role: "target" as const,
          mode: "held" as const,
          phase: "held" as const,
          migrationId: "mig-user",
          slug: "ceckert-test",
          targetPodUid: "target-pod",
        })),
        claimTargetCompletion: vi.fn(async () => {
          events.push("claim");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "held" as const,
            phase: "completing" as const,
            migrationId: "mig-user",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        permit: vi.fn(async () => {
          events.push("permit");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "permitted" as const,
            phase: "running" as const,
            migrationId: "mig-user",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        hold: vi.fn(),
        rehold: vi.fn(),
        releaseTarget: vi.fn(async () => {
          events.push("release-target");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "normal" as const,
            mode: "permitted" as const,
            phase: "running" as const,
          };
        }),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const attachConfiguredUserBeforeOpenClaw = vi.fn(async (input: {
        adapter: UserLifecycleAdapter;
        onWorkSettled?: (settled: Promise<void>) => void;
      }) => {
        events.push("attach");
        await addUserToGateway(input.adapter, "uid-user", {
          onWorkSettled: input.onWorkSettled,
        });
        input.adapter.writeMountMarker?.("ceckert-test");
        return "ceckert-test";
      });
      const surgeReadiness = {
        release: vi.fn(async () => {
          events.push("release");
        }),
      } as unknown as SurgeReadinessGate;
      const wiring = createIsolatedSurgeGateWiring({
        adapter,
        processGate,
        surgeReadiness,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => undefined,
        log: () => undefined,
        provisioning: counter.provisioning,
        waitForActiveProvisioningDrain: () => {
          releaseWaitStarted();
          return counter.waitForDrain();
        },
        attachConfiguredUserBeforeOpenClaw,
      });
      const released = wiring.releaseSurgeReadiness({
        migrationId: "mig-user",
        targetPodUid: "target-pod",
      });
      await releaseWaitStartedPromise;

      expect(attachConfiguredUserBeforeOpenClaw).not.toHaveBeenCalled();
      expect(vi.mocked(processGate.permit)).not.toHaveBeenCalled();

      releaseClone();
      await released;

      expect(calls).toEqual([
        "clone-workspace",
        "ensure-user-directories",
        "write-user-template-files",
        "restore-byosub",
        "mount-marker",
      ]);
      expect(events).toEqual([
        "claim",
        "claim",
        "claim",
        "attach",
        "permit",
        "release-target",
      ]);
      expect(vi.mocked(surgeReadiness.release)).not.toHaveBeenCalled();
      expect(counter.active()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("holds reservation and release through the actual ensure stamp and marker tail", async () => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    try {
      const events: string[] = [];
      let releaseStamp!: () => void;
      const stamp = new Promise<void>((resolve) => {
        releaseStamp = resolve;
      });
      let stampStarted!: () => void;
      const stampStartedPromise = new Promise<void>((resolve) => {
        stampStarted = resolve;
      });
      const { adapter, calls } = configuredUserLifecycleAdapter({
        writeMountMarker: () => events.push("mount-marker"),
      });
      const counter = createProvisioningCounter();
      const ensuring = runProvisioningWork({
        provisioning: counter.provisioning,
        work: async (onWorkSettled) => {
          const result = await addUserToGateway(adapter, "uid-user", { onWorkSettled });
          await finalizeConvergedMount({
            now: 1_000,
            slug: "ceckert-test",
            uid: "uid-user",
            desiredFingerprint: "fp-user",
            prior: undefined,
            result,
            hooks: {
              recordApplied: vi.fn(),
              rememberRetry: vi.fn(),
              forgetRetry: vi.fn(),
            },
            stampMounted: async () => {
              stampStarted();
              await stamp;
            },
            writeMountMarker: adapter.writeMountMarker,
          });
          return result;
        },
      });
      await stampStartedPromise;

      const processGate = {
        status: vi.fn(async () => ({
          version: 1 as const,
          podUid: "target-pod",
          role: "target" as const,
          mode: "held" as const,
          phase: "held" as const,
          migrationId: "mig-user",
          slug: "ceckert-test",
          targetPodUid: "target-pod",
        })),
        hydrate: vi.fn(async () => ({
          version: 1 as const,
          podUid: "target-pod",
          role: "target" as const,
          mode: "held" as const,
          phase: "held" as const,
          migrationId: "mig-user",
          slug: "ceckert-test",
          targetPodUid: "target-pod",
        })),
        claimTargetCompletion: vi.fn(async () => {
          events.push("claim");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "held" as const,
            phase: "completing" as const,
            migrationId: "mig-user",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        permit: vi.fn(async () => {
          events.push("permit");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "permitted" as const,
            phase: "running" as const,
            migrationId: "mig-user",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        hold: vi.fn(),
        rehold: vi.fn(),
        releaseTarget: vi.fn(async () => {
          events.push("release-target");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "normal" as const,
            mode: "permitted" as const,
            phase: "running" as const,
          };
        }),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const attachConfiguredUserBeforeOpenClaw = vi.fn(async () => {
        events.push("attach");
        return "ceckert-test";
      });
      const surgeReadiness = {
        release: vi.fn(async () => {
          events.push("release");
        }),
      } as unknown as SurgeReadinessGate;
      let drainCalls = 0;
      let bothInitialDrainsStarted!: () => void;
      const bothInitialDrainsStartedPromise = new Promise<void>((resolve) => {
        bothInitialDrainsStarted = resolve;
      });
      const wiring = createIsolatedSurgeGateWiring({
        adapter,
        processGate,
        surgeReadiness,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => undefined,
        log: () => undefined,
        provisioning: counter.provisioning,
        waitForActiveProvisioningDrain: () => {
          drainCalls += 1;
          if (drainCalls === 2) bothInitialDrainsStarted();
          return counter.waitForDrain();
        },
        attachConfiguredUserBeforeOpenClaw,
      });
      let reserved = false;
      const reservation = wiring.reserveSurgeTarget({
        migrationId: "mig-user",
        slug: "ceckert-test",
      }).then(() => {
        reserved = true;
      });
      const released = wiring.releaseSurgeReadiness({
        migrationId: "mig-user",
        targetPodUid: "target-pod",
      });
      await bothInitialDrainsStartedPromise;

      expect(counter.active()).toBe(1);
      expect(calls).not.toContain("mount-marker");
      expect(attachConfiguredUserBeforeOpenClaw).not.toHaveBeenCalled();
      expect(vi.mocked(processGate.permit)).not.toHaveBeenCalled();
      expect(reserved).toBe(false);

      releaseStamp();
      await Promise.all([ensuring, reservation, released]);

      expect(calls).toContain("mount-marker");
      expect(events).toEqual([
        "mount-marker",
        "claim",
        "claim",
        "claim",
        "attach",
        "permit",
        "release-target",
      ]);
      expect(counter.active()).toBe(0);
      expect(vi.mocked(processGate.permit)).toHaveBeenCalledOnce();
      expect(vi.mocked(surgeReadiness.release)).not.toHaveBeenCalled();
      expect(reserved).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not mutate a target cancelled after its completion claim", async () => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    try {
      const counter = createProvisioningCounter();
      const request = {
        migrationId: "mig-user",
        slug: "ceckert-test",
        targetPodUid: "target-pod",
      };
      let state: Record<string, unknown> = {
        version: 1,
        podUid: "target-pod",
        role: "target",
        mode: "held",
        phase: "held",
        ...request,
      };
      let releaseFirstClaim!: () => void;
      const firstClaimBlocked = new Promise<void>((resolve) => {
        releaseFirstClaim = resolve;
      });
      let firstClaimEntered!: () => void;
      const firstClaimEnteredPromise = new Promise<void>((resolve) => {
        firstClaimEntered = resolve;
      });
      const processGate = {
        status: vi.fn(async () => state),
        claimTargetCompletion: vi.fn(async () => {
          if (state.phase === "held") {
            const claimed = { ...state, phase: "completing" };
            state = claimed;
            firstClaimEntered();
            await firstClaimBlocked;
            return claimed;
          }
          if (state.phase !== "completing") {
            throw new Error("surge OpenClaw process gate target completion is not held");
          }
          return state;
        }),
        rehold: vi.fn(async () => state),
        finalizeTargetCancellation: vi.fn(async () => {
          state = { version: 1, podUid: "target-pod", role: "normal", mode: "held", phase: "held" };
          return state;
        }),
        hydrate: vi.fn(async () => {
          state = { version: 1, podUid: "target-pod", role: "target", mode: "held", phase: "held", ...request };
          return state;
        }),
        permit: vi.fn(),
        hold: vi.fn(),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const attachConfiguredUserBeforeOpenClaw = vi.fn(async () => "ceckert-test");
      const wiring = createIsolatedSurgeGateWiring({
        adapter: {
          isIsolatedGateway: () => true,
          isConfiguredUser: (slug: string) => slug === "ceckert-test",
          configuredUserOverlayPresent: () => true,
          listLocalUserSlugs: () => [],
          userMountMarked: () => false,
          hasWorkspaceGitDir: () => true,
          hasGitRemote: () => true,
        } as unknown as UserLifecycleAdapter,
        processGate,
        surgeReadiness: { release: vi.fn(async () => undefined) } as unknown as SurgeReadinessGate,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => undefined,
        log: () => undefined,
        provisioning: counter.provisioning,
        waitForActiveProvisioningDrain: counter.waitForDrain,
        attachConfiguredUserBeforeOpenClaw,
      });

      const release = wiring.releaseSurgeReadiness({
        migrationId: request.migrationId,
        targetPodUid: request.targetPodUid,
      });
      await firstClaimEnteredPromise;
      expect(counter.active()).toBe(1);
      state = { ...state, phase: "cancelling" };
      releaseFirstClaim();

      await expect(release).rejects.toThrow("target completion is not held");
      await vi.waitFor(() => expect(state).toMatchObject({ role: "normal", mode: "held", phase: "held" }));

      expect(vi.mocked(processGate.claimTargetCompletion)).toHaveBeenCalledTimes(2);
      expect(attachConfiguredUserBeforeOpenClaw).not.toHaveBeenCalled();
      expect(vi.mocked(processGate.permit)).not.toHaveBeenCalled();

      await expect(wiring.reserveSurgeTarget({ migrationId: "mig-next", slug: request.slug })).resolves.toBeUndefined();
      expect(vi.mocked(processGate.hydrate)).toHaveBeenCalledWith({
        migrationId: "mig-next",
        slug: request.slug,
        targetPodUid: "target-pod",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not publish readiness when a matching hold finishes during post-permit verification", async () => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    try {
      const counter = createProvisioningCounter();
      const request = {
        migrationId: "mig-user",
        slug: "ceckert-test",
        targetPodUid: "target-pod",
      };
      let state: Record<string, unknown> = {
        version: 1,
        podUid: "target-pod",
        role: "target",
        mode: "held",
        phase: "held",
        ...request,
      };
      let mounted = false;
      let releaseVerification!: () => void;
      const verificationBlocked = new Promise<void>((resolve) => {
        releaseVerification = resolve;
      });
      let verificationStarted!: () => void;
      const verificationStartedPromise = new Promise<void>((resolve) => {
        verificationStarted = resolve;
      });
      const surgeReadiness = {
        release: vi.fn(async () => undefined),
      } as unknown as SurgeReadinessGate;
      const processGate = {
        status: vi.fn(async () => state),
        claimTargetCompletion: vi.fn(async () => {
          if (state.phase !== "held" && state.phase !== "completing") {
            throw new Error("surge OpenClaw process gate target completion is not held");
          }
          state = { ...state, phase: "completing" };
          return state;
        }),
        permit: vi.fn(async () => {
          state = { ...state, mode: "permitted", phase: "running" };
          return state;
        }),
        releaseTarget: vi.fn(async () => {
          if (state.role !== "target" || state.mode !== "permitted") {
            throw new Error("surge OpenClaw process gate does not permit this target migration");
          }
          await surgeReadiness.release({ targetPodUid: request.targetPodUid });
          state = { version: 1, podUid: "target-pod", role: "normal", mode: "permitted", phase: "running" };
          return state;
        }),
        rehold: vi.fn(async () => state),
        hold: vi.fn(),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const wiring = createIsolatedSurgeGateWiring({
        adapter: {
          isIsolatedGateway: () => true,
          isConfiguredUser: (slug: string) => slug === request.slug,
          configuredUserOverlayPresent: () => true,
          listLocalUserSlugs: () => mounted ? [request.slug] : [],
          userMountMarked: () => mounted,
          hasWorkspaceGitDir: () => true,
          hasGitRemote: () => true,
        } as unknown as UserLifecycleAdapter,
        processGate,
        surgeReadiness,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => {
          verificationStarted();
          await verificationBlocked;
        },
        log: () => undefined,
        provisioning: counter.provisioning,
        waitForActiveProvisioningDrain: counter.waitForDrain,
        attachConfiguredUserBeforeOpenClaw: async () => {
          mounted = true;
          return request.slug;
        },
      });

      const release = wiring.releaseSurgeReadiness({
        migrationId: request.migrationId,
        targetPodUid: request.targetPodUid,
      });
      await verificationStartedPromise;
      expect(counter.active()).toBe(0);

      state = { ...state, mode: "held", phase: "cancelling" };
      let holdFinished = false;
      await counter.waitForDrain().then(() => {
        state = { version: 1, podUid: "target-pod", role: "normal", mode: "held", phase: "held" };
        holdFinished = true;
      });
      expect(holdFinished).toBe(true);
      expect(vi.mocked(surgeReadiness.release)).not.toHaveBeenCalled();

      releaseVerification();
      await expect(release).rejects.toThrow("does not permit this target migration");

      expect(vi.mocked(processGate.releaseTarget)).toHaveBeenCalledOnce();
      expect(vi.mocked(surgeReadiness.release)).not.toHaveBeenCalled();
      expect(state).toEqual({
        version: 1,
        podUid: "target-pod",
        role: "normal",
        mode: "held",
        phase: "held",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["podUid", "targetPodUid", "migrationId", "slug"] as const)("does not preserve a failed target with mismatched %s", async field => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    const request = { migrationId: "mig-user", slug: "ceckert-test", targetPodUid: "target-pod" };
    const initial: SurgeOpenClawProcessGateState = { version: 1, podUid: "target-pod", role: "target", mode: "held", phase: "held", ...request };
    let state = initial;
    const processGate = {
      status: async () => state,
      claimTargetCompletion: async () => state,
      rehold: vi.fn(async () => { throw new Error("reservation identity changed"); }),
    } as unknown as SurgeOpenClawProcessSupervisorClient;
    const { adapter } = configuredUserLifecycleAdapter();
    const wiring = createIsolatedSurgeGateWiring({
      adapter, processGate, surgeReadiness: {} as SurgeReadinessGate,
      waitForGatewayHealthy: async () => undefined, waitForGatewayReady: async () => undefined,
      log: () => undefined, provisioning: createProvisioningCounter().provisioning,
      attachConfiguredUserBeforeOpenClaw: async () => {
        state = { ...initial, [field]: "different" };
        throw new Error("attach failed");
      },
    });
    try {
      await expect(wiring.releaseSurgeReadiness(request)).rejects.toThrow("could not be returned to hold");
      expect(processGate.rehold).toHaveBeenCalledExactlyOnceWith(request);
    } finally { vi.unstubAllEnvs(); }
  });

  it("finishes explicit cancellation while failure cleanup is already finalizing", async () => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-cancel-"));
    tmpDirs.push(dir);
    const gate = createSurgeOpenClawProcessGate(dir);
    const request = { migrationId: "mig-user", slug: "ceckert-test", targetPodUid: "target-pod" };
    const identity = { ...request, podUid: request.targetPodUid };
    const finish = Promise.withResolvers<void>();
    let finalization: Promise<SurgeOpenClawProcessGateState> | undefined;
    try {
      await gate.ensure({ podUid: identity.podUid, readinessReleased: false });
      await gate.hydrateTarget(identity);
      const processGate = {
        status: async () => {
          const snapshot = (await gate.read())!;
          if (snapshot.phase === "cancelling") await finalization;
          return snapshot;
        },
        claimTargetCompletion: () => gate.claimTargetCompletion(identity),
        rehold: () => gate.reholdTarget(identity),
        finalizeTargetCancellation: () => {
          finalization = finish.promise.then(() => gate.finalizeTargetCancellation(identity));
          return finalization;
        },
        unreserve: () => gate.unreserveTarget(identity),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const { adapter } = configuredUserLifecycleAdapter();
      const wiring = createIsolatedSurgeGateWiring({
        adapter, processGate,
        surgeReadiness: {} as SurgeReadinessGate,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => undefined,
        log: () => undefined,
        provisioning: createProvisioningCounter().provisioning,
        attachConfiguredUserBeforeOpenClaw: async () => { throw new Error("write EPIPE"); },
      });

      await expect(wiring.releaseSurgeReadiness(request)).rejects.toThrow("write EPIPE");
      const cancelled = wiring.unreserveSurgeTarget(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      finish.resolve();

      await expect(cancelled).resolves.toMatchObject({ role: "normal", mode: "held", phase: "held" });
      await expect(gate.read()).resolves.toMatchObject({ role: "normal", mode: "held", phase: "held" });
    } finally {
      finish.resolve();
      await finalization;
      vi.unstubAllEnvs();
    }
  });

  it.each(["success", "retry", "cleanup-failed", "hold-lost", "assigned", "assigned-after-drain", "residue", "warm", "warm-replay", "released", "prelaunch-failed"] as const)("keeps exact cancellation custody through imported cleanup: %s", async scenario => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    const request = { migrationId: "cleanup-op", slug: "ceckert-test", targetPodUid: "target-pod" };
    let state: SurgeOpenClawProcessGateState = { version: 1, podUid: "target-pod", role: "target", mode: "permitted", phase: "running", ...request };
    const warm = scenario === "warm" || scenario === "warm-replay" || scenario === "prelaunch-failed";
    if (scenario === "residue" || warm) state = { version: 1, podUid: "target-pod", role: "normal", mode: warm ? "permitted" : "held", phase: warm ? "running" : "held" };
    if (scenario === "released") state = { version: 1, podUid: "target-pod", role: "normal", mode: "permitted", phase: "running", terminalTarget: { ...request, completionStarted: true } };
    const carried = (completionStarted: boolean | undefined) => completionStarted === undefined ? {} : { completionStarted };
    const events: string[] = [];
    const processGate = {
      status: async () => state,
      holdNormal: vi.fn(async () => { events.push("stop-normal"); state = { ...state, mode: "held", phase: "held" }; return state; }),
      hydrate: vi.fn(async () => { events.push("reserve"); state = { version: 1, podUid: "target-pod", role: "target", mode: "held", phase: "held", ...request, completionStarted: false }; return state; }),
      rehold: vi.fn(async () => { events.push("stop"); state = { ...state, mode: "held", phase: "cancelling" }; return state; }),
      reholdReleasedTarget: vi.fn(async () => { events.push("restop"); state = { version: 1, podUid: "target-pod", role: "target", mode: "held", phase: "cancelling", ...request, ...carried(state.terminalTarget?.completionStarted) }; return state; }),
      finalizeTargetCancellation: vi.fn(async () => { events.push("finalize"); state = { version: 1, podUid: "target-pod", role: "normal", mode: "held", phase: "held", terminalTarget: { ...request, ...carried(state.completionStarted) } }; return state; }),
      unreserve: vi.fn(async () => { state = { version: 1, podUid: "target-pod", role: "normal", mode: "held", phase: "held", terminalTarget: { ...request, ...carried(state.completionStarted) } }; return state; }),
      permitNormal: vi.fn(async () => { events.push("permit-normal"); state = { ...state, mode: "permitted", phase: "starting" }; return state; }),
    } as unknown as SurgeOpenClawProcessSupervisorClient;
    const cleanup = vi.fn(async (assertCurrent: () => Promise<void>) => {
      events.push("cleanup");
      await assertCurrent();
      if (scenario === "cleanup-failed") throw new Error("Native journal unavailable");
      if (scenario === "hold-lost") state = { ...state, mode: "permitted", phase: "running" };
    });
    try {
      const wiring = createIsolatedSurgeGateWiring({ adapter: {} as UserLifecycleAdapter, processGate,
        surgeReadiness: { release: vi.fn(async () => undefined) } as unknown as SurgeReadinessGate,
        waitForGatewayHealthy: async () => undefined, waitForGatewayReady: async () => undefined,
        log: () => undefined, provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
        waitForActiveProvisioningDrain: async () => { events.push("drain"); },
        configuredUserAssigned: async () => scenario === "assigned" || (scenario === "assigned-after-drain" && events.includes("drain")),
        prepareIsolatedPrelaunch: async (slug) => {
          if (openClawRuntimeUpdateGuard.tryRun(async () => undefined) !== undefined) throw new Error("prelaunch config written outside the runtime update guard");
          if (scenario === "prelaunch-failed") throw new Error("Isolated prelaunch requires its accepted system config");
          events.push(`prelaunch:${slug}`);
        },
      });
      const cancel = wiring.unreserveSurgeTarget(request, cleanup);
      if (scenario === "success" || scenario === "retry") {
        await expect(cancel).resolves.toMatchObject({ role: "normal", terminalTarget: request });
        expect(events).toEqual(["stop", "drain", "cleanup", "finalize"]);
        if (scenario === "retry") {
          await expect(wiring.unreserveSurgeTarget(request, cleanup)).resolves.toMatchObject({ role: "normal", terminalTarget: request });
          expect(events).toEqual(["stop", "drain", "cleanup", "finalize", "restop", "drain", "cleanup", "finalize"]);
        }
      } else if (scenario === "prelaunch-failed") {
        await expect(cancel).rejects.toThrow("Isolated prelaunch requires its accepted system config");
        expect(state).toMatchObject({ role: "normal", mode: "held", terminalTarget: request });
        expect(processGate.permitNormal).not.toHaveBeenCalled();
      } else if (warm) {
        await expect(cancel).resolves.toMatchObject({ role: "normal", mode: "permitted", terminalTarget: request });
        expect(events).toEqual(["stop-normal", "reserve", "drain", "cleanup", "prelaunch:ceckert-test", "permit-normal"]);
        if (scenario === "warm-replay") {
          await expect(wiring.unreserveSurgeTarget(request, cleanup)).resolves.toMatchObject({ role: "normal", mode: "permitted", terminalTarget: request });
          expect(events.slice(6)).toEqual(["restop", "drain", "cleanup", "finalize", "prelaunch:ceckert-test", "permit-normal"]);
        }
      } else if (scenario === "released") {
        await expect(cancel).resolves.toMatchObject({ role: "normal", mode: "held", terminalTarget: request });
        expect(events).toEqual(["restop", "drain", "cleanup", "finalize"]);
        expect(processGate.permitNormal).not.toHaveBeenCalled();
      } else if (scenario === "residue") {
        await expect(cancel).resolves.toMatchObject({ role: "normal", mode: "held" });
        expect(events).toEqual(["stop-normal", "reserve", "drain", "cleanup"]);
        expect(processGate.permitNormal).not.toHaveBeenCalled();
      } else {
        await expect(cancel).rejects.toThrow();
        expect(processGate.finalizeTargetCancellation).not.toHaveBeenCalled();
        if (scenario === "assigned" || scenario === "residue") {
          expect(cleanup).not.toHaveBeenCalled();
          expect(processGate.rehold).not.toHaveBeenCalled();
          expect(events).toEqual([]);
        }
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("reholds, drains, and finalizes a permitted target unreserve without raw fallback", async () => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    try {
      const counter = createProvisioningCounter();
      const request = {
        migrationId: "mig-user",
        slug: "ceckert-test",
        targetPodUid: "target-pod",
      };
      const permitted = {
        version: 1 as const,
        podUid: "target-pod",
        role: "target" as const,
        mode: "permitted" as const,
        phase: "running" as const,
        ...request,
      };
      const cancelling = {
        ...permitted,
        mode: "held" as const,
        phase: "cancelling" as const,
      };
      const finalized = {
        version: 1 as const,
        podUid: "target-pod",
        role: "normal" as const,
        mode: "held" as const,
        phase: "held" as const,
      };
      const processGate = {
        status: vi.fn(async () => permitted),
        rehold: vi.fn(async () => cancelling),
        finalizeTargetCancellation: vi.fn(async () => finalized),
        unreserve: vi.fn(async () => {
          throw new Error("raw unreserve must not handle a matching permitted target");
        }),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const wiring = createIsolatedSurgeGateWiring({
        adapter: {} as UserLifecycleAdapter,
        processGate,
        surgeReadiness: { release: vi.fn(async () => undefined) } as unknown as SurgeReadinessGate,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => undefined,
        log: () => undefined,
        provisioning: counter.provisioning,
        waitForActiveProvisioningDrain: counter.waitForDrain,
      });

      counter.provisioning.beginProvisioning();
      let settled = false;
      const unreserve = wiring.unreserveSurgeTarget(request).then((state) => {
        settled = true;
        return state;
      });
      await vi.waitFor(() => expect(vi.mocked(processGate.rehold)).toHaveBeenCalledWith(request));

      expect(counter.active()).toBe(1);
      expect(settled).toBe(false);
      expect(vi.mocked(processGate.finalizeTargetCancellation)).not.toHaveBeenCalled();
      expect(vi.mocked(processGate.unreserve)).not.toHaveBeenCalled();

      counter.provisioning.finishProvisioning();
      await expect(unreserve).resolves.toEqual(finalized);

      expect(vi.mocked(processGate.finalizeTargetCancellation)).toHaveBeenCalledWith(request);
      expect(vi.mocked(processGate.unreserve)).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["held and stopped", { mode: "held", phase: "held" }, true],
    ["held after completion began", { mode: "held", phase: "held", completionStarted: true }, "Native completion has already started"],
    ["permitted and running", { mode: "permitted", phase: "running" }, false],
    ["permitted and starting", { mode: "permitted", phase: "starting" }, false],
    ["held while still stopping", { mode: "held", phase: "stopping" }, "still stopping"],
    ["reserved by another migration", { mode: "held", phase: "held", migrationId: "activation-2" }, "not reserved by this migration"],
    ["no longer a target", { mode: "held", phase: "held", role: "normal" }, "not reserved by this migration"],
  ] as const)("reports whether a reserved isolated target's OpenClaw is held for this boot: %s", async (_label, gate, expected) => {
    const request = { migrationId: "activation-1", slug: "chris", targetPodUid: "target-pod" };
    const processGate = {
      status: vi.fn(async () => ({ version: 1, podUid: "target-pod", role: "target", ...request, ...gate })),
    } as unknown as SurgeOpenClawProcessSupervisorClient;
    const wiring = createIsolatedSurgeGateWiring({
      adapter: {} as UserLifecycleAdapter, processGate,
      surgeReadiness: {} as SurgeReadinessGate,
      waitForGatewayHealthy: async () => undefined,
      waitForGatewayReady: async () => undefined, log: () => undefined,
      provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
    });
    if (typeof expected === "string") {
      await expect(wiring.surgeTargetOpenClawHeld(request)).rejects.toThrow(expected);
    } else {
      await expect(wiring.surgeTargetOpenClawHeld(request)).resolves.toBe(expected);
    }
  });

  it.each([
    ["held and stopped for this migration", { role: "source", mode: "held", phase: "held" }, true],
    ["running normally", { role: "normal", mode: "permitted", phase: "running" }, false],
    ["resumed after a rollback", { role: "source", mode: "permitted", phase: "starting" }, false],
    ["held while still stopping", { role: "source", mode: "held", phase: "stopping" }, "still stopping"],
    ["held by another migration", { role: "source", mode: "held", phase: "held", migrationId: "surge-2" }, "held by another migration"],
  ] as const)("reports whether a user source's OpenClaw is held for this migration: %s", async (_label, gate, expected) => {
    const request = { migrationId: "surge-1", slug: "chris" };
    const processGate = {
      status: vi.fn(async () => ({ version: 1, podUid: "source-pod", targetPodUid: "target-pod", ...request, ...gate })),
    } as unknown as SurgeOpenClawProcessSupervisorClient;
    if (typeof expected === "string") {
      await expect(userSourceOpenClawHeld(processGate, request)).rejects.toThrow(expected);
    } else {
      await expect(userSourceOpenClawHeld(processGate, request)).resolves.toBe(expected);
    }
  });

  it("reports a gateway without a process gate as never holding a source", async () => {
    await expect(userSourceOpenClawHeld(null, { migrationId: "shared-move", slug: "chris" })).resolves.toBe(false);
  });

  it.each([
    ["running after a return", { role: "normal", mode: "permitted", phase: "running" }, true],
    ["released by an earlier activation", { role: "normal", mode: "permitted", phase: "running", terminalTarget: { migrationId: "activation-0", slug: "chris", targetPodUid: "target-pod" } }, true],
    ["released by this activation", { role: "normal", mode: "permitted", phase: "running", terminalTarget: { migrationId: "activation-1", slug: "chris", targetPodUid: "target-pod" } }, false],
    ["held fresh boot", { role: "normal", mode: "held", phase: "held" }, false],
    ["reserved held target", { role: "target", mode: "held", phase: "held", migrationId: "activation-1", slug: "chris", targetPodUid: "target-pod" }, false],
    ["permitted held-path target", { role: "target", mode: "permitted", phase: "running", migrationId: "activation-1", slug: "chris", targetPodUid: "target-pod" }, false],
  ] as const)("classifies a isolated target as live only when its OpenClaw already runs outside this migration: %s", async (_label, gate, expected) => {
    const request = { migrationId: "activation-1", slug: "chris", targetPodUid: "target-pod" };
    const processGate = {
      status: vi.fn(async () => ({ version: 1, podUid: "target-pod", ...gate })),
    } as unknown as SurgeOpenClawProcessSupervisorClient;
    const wiring = createIsolatedSurgeGateWiring({
      adapter: {} as UserLifecycleAdapter, processGate,
      surgeReadiness: {} as SurgeReadinessGate,
      waitForGatewayHealthy: async () => undefined,
      waitForGatewayReady: async () => undefined, log: () => undefined,
      provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
    });
    await expect(wiring.surgeTargetLive(request)).resolves.toBe(expected);
  });

  it.each([
    ["admitted", {}, null],
    ["still starting", { phase: "starting" }, "not running for a live import (phase starting)"],
    ["another pod", { podUid: "other-pod" }, "not a live permitted OpenClaw on this pod"],
    ["held", { mode: "held", phase: "held" }, "not a live permitted OpenClaw on this pod"],
    ["readiness held", { readinessReleased: false }, "requires released readiness"],
    ["overlay missing", { overlayPresent: false }, "requires its retained overlay"],
    ["user mounted", { mounted: true }, "already mounts its user"],
  ] as const)("admits a live user import only for a running, Ready, unmounted retained overlay: %s", async (_label, variant, expected) => {
    stubUserClaim("chris");
    try {
      const { readinessReleased = true, overlayPresent = true, mounted = false, ...gate } = variant as Record<string, unknown>;
      const request = { migrationId: "activation-1", slug: "chris", targetPodUid: "target-pod" };
      const processGate = {
        status: vi.fn(async () => ({ version: 1, podUid: "target-pod", role: "normal", mode: "permitted", phase: "running", ...gate })),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const adapter = {
        isIsolatedGateway: () => true,
        isConfiguredUser: (slug: string) => slug === "chris",
        configuredUserOverlayPresent: () => overlayPresent,
        listLocalUserSlugs: () => ["chris"],
        hasUserAgentRuntime: () => true,
        hasUserDir: () => true,
        hasWorkspaceGitDir: () => true,
        hasGitRemote: () => true,
        userMountMarked: () => mounted,
      } as unknown as UserLifecycleAdapter;
      const wiring = createIsolatedSurgeGateWiring({
        adapter, processGate,
        surgeReadiness: { released: vi.fn(async () => readinessReleased) } as unknown as SurgeReadinessGate,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => undefined, log: () => undefined,
        provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
      });
      if (expected === null) {
        await expect(wiring.admitLiveSurgeTarget(request)).resolves.toBeUndefined();
      } else {
        await expect(wiring.admitLiveSurgeTarget(request)).rejects.toThrow(expected);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("admits a claimed user live only once its claim overlay is stamped", async () => {
    const openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-claimed-user-"));
    tmpDirs.push(openclawDir);
    vi.stubEnv("OPENCLAW_DIR", openclawDir);
    vi.stubEnv("GATEWAY_ID", "b-chris");
    vi.stubEnv("GATEWAY_CLASS", "isolated");
    try {
      writeUserClaim(openclawDir, userClaimFromIdentity({
        gatewayId: "b-chris", state: "claimed", ownerUid: "uid-chris", builderSlug: "chris",
        leaseId: "lease-1", generation: 2,
      }, 1));
      const brokered = buildBrokeredLifecycleAdapter({
        client: {} as never, rpc: {} as never, log: () => undefined, isIsolatedGateway: () => true,
      });
      const adapter = {
        ...brokered,
        listLocalUserSlugs: () => [],
        userMountMarked: () => false,
      } as UserLifecycleAdapter;
      const request = { migrationId: "activation-1", slug: "chris", targetPodUid: "builder-pod" };
      const wiring = createIsolatedSurgeGateWiring({
        adapter,
        processGate: {
          status: vi.fn(async () => ({ version: 1, podUid: "builder-pod", role: "normal", mode: "permitted", phase: "running" })),
        } as unknown as SurgeOpenClawProcessSupervisorClient,
        surgeReadiness: { released: vi.fn(async () => true) } as unknown as SurgeReadinessGate,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => undefined, log: () => undefined,
        provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
      });

      expect(brokered.isConfiguredUser?.("chris")).toBe(true);
      await expect(wiring.surgeTargetLive(request)).resolves.toBe(true);
      await expect(wiring.admitLiveSurgeTarget(request)).rejects.toThrow("requires its retained overlay");

      markUserClaimOverlayApplied(openclawDir, "b-chris", 2);
      await expect(wiring.admitLiveSurgeTarget(request)).resolves.toBeUndefined();
      expect(brokered.configuredUserOverlayPresent?.("bob")).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["unassigned", "assigned", "assignment-read-failed"])(
    "rolls back a released user only before canonical assignment: %s",
    async (assignment) => {
      const request = { migrationId: "activation-1", slug: "chris", targetPodUid: "target-pod" };
      const events: string[] = [];
      const state: SurgeOpenClawProcessGateState = {
        version: 1, podUid: "target-pod", role: "normal", mode: "permitted", phase: "running",
        terminalTarget: request,
      };
      const held: SurgeOpenClawProcessGateState = { ...state, mode: "held", phase: "held" };
      const processGate = {
        status: async () => state,
        reholdReleasedTarget: vi.fn(async () => {
          events.push("rehold");
          return { ...held, role: "target", phase: "cancelling", ...request };
        }),
        finalizeTargetCancellation: vi.fn(async () => { events.push("finalize"); return held; }),
        unreserve: vi.fn(async () => state),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const wiring = createIsolatedSurgeGateWiring({
        adapter: {} as UserLifecycleAdapter, processGate,
        surgeReadiness: {} as SurgeReadinessGate,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => undefined, log: () => undefined,
        provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
        waitForActiveProvisioningDrain: async () => { events.push("drain"); },
        configuredUserAssigned: async () => {
          if (assignment === "assignment-read-failed") throw new Error("assignment unavailable");
          return assignment === "assigned";
        },
      });
      if (assignment === "unassigned") {
        await expect(wiring.unreserveSurgeTarget(request)).resolves.toMatchObject({ mode: "held" });
        expect(events).toEqual(["rehold", "drain", "finalize"]);
        expect(processGate.reholdReleasedTarget).toHaveBeenCalledExactlyOnceWith(request);
      } else {
        await expect(wiring.unreserveSurgeTarget(request)).rejects.toThrow(
          assignment === "assigned" ? "serving assignment" : "assignment unavailable",
        );
        expect(events).toEqual([]);
      }
      expect(processGate.unreserve).not.toHaveBeenCalled();
    },
  );

  it("shares an in-progress target release only with the same migration and target", async () => {
    stubUserClaim("ceckert-test");
    vi.stubEnv("POD_UID", "target-pod");
    try {
      const events: string[] = [];
      let releaseAttach!: () => void;
      const attach = new Promise<void>((resolve) => {
        releaseAttach = resolve;
      });
      let mounted = false;
      const adapter = {
        isIsolatedGateway: () => true,
        isConfiguredUser: (slug: string) => slug === "ceckert-test",
        configuredUserOverlayPresent: () => true,
        listLocalUserSlugs: () => mounted ? ["ceckert-test"] : [],
        userMountMarked: () => mounted,
        hasWorkspaceGitDir: () => true,
        hasGitRemote: () => true,
      } as unknown as UserLifecycleAdapter;
      const processGate = {
        status: vi.fn(async () => {
          events.push("status");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "held" as const,
            phase: "held" as const,
            migrationId: "mig-user",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        claimTargetCompletion: vi.fn(async () => {
          events.push("claim");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "held" as const,
            phase: "completing" as const,
            migrationId: "mig-user",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        permit: vi.fn(async () => {
          events.push("permit");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "target" as const,
            mode: "permitted" as const,
            phase: "running" as const,
            migrationId: "mig-user",
            slug: "ceckert-test",
            targetPodUid: "target-pod",
          };
        }),
        hold: vi.fn(),
        releaseTarget: vi.fn(async () => {
          events.push("release-target");
          return {
            version: 1 as const,
            podUid: "target-pod",
            role: "normal" as const,
            mode: "permitted" as const,
            phase: "running" as const,
          };
        }),
      } as unknown as SurgeOpenClawProcessSupervisorClient;
      const attachConfiguredUserBeforeOpenClaw = vi.fn(async () => {
        events.push("attach");
        await attach;
        mounted = true;
        return "ceckert-test";
      });
      const surgeReadiness = {
        release: vi.fn(async () => {
          events.push("release");
        }),
      } as unknown as SurgeReadinessGate;
      const wiring = createIsolatedSurgeGateWiring({
        adapter,
        processGate,
        surgeReadiness,
        waitForGatewayHealthy: async () => undefined,
        waitForGatewayReady: async () => undefined,
        log: () => undefined,
        provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
        attachConfiguredUserBeforeOpenClaw,
      });

      const first = wiring.releaseSurgeReadiness({
        migrationId: "mig-user",
        targetPodUid: "target-pod",
      });
      await Promise.resolve();
      const duplicate = wiring.releaseSurgeReadiness({
        migrationId: "mig-user",
        targetPodUid: "target-pod",
      });

      expect(duplicate).toBe(first);
      await expect(wiring.releaseSurgeReadiness({
        migrationId: "other-migration",
        targetPodUid: "target-pod",
      })).rejects.toThrow(/release in progress/);

      releaseAttach();
      await Promise.all([first, duplicate]);

      expect(events).toEqual([
        "status",
        "claim",
        "claim",
        "claim",
        "attach",
        "permit",
        "release-target",
      ]);
      expect(vi.mocked(processGate.status)).toHaveBeenCalledOnce();
      expect(vi.mocked(processGate.claimTargetCompletion)).toHaveBeenCalledTimes(3);
      expect(attachConfiguredUserBeforeOpenClaw).toHaveBeenCalledOnce();
      expect(vi.mocked(processGate.permit)).toHaveBeenCalledOnce();
      expect(vi.mocked(processGate.releaseTarget)).toHaveBeenCalledOnce();
      expect(vi.mocked(surgeReadiness.release)).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("observed split — evict keys off raw presence, mount off completion", () => {
  it("evict-observed = RAW on-disk dirs (not default-agent-wired), so a partial/junk dir is drainable", () => {
    const a = mkObservedAdapter({
      listLocalUserDirs: () => ["alice", "bob", "partial"], // partial: dir present, no defaultAgent
      listLocalUserSlugs: () => ["alice", "bob"], // default-agent-wired subset
    });
    expect(getEvictObservedSlugs(a)).toEqual(["alice", "bob", "partial"]);
  });

  it("evict-observed skips a migrating-in slug (no draining a fresh import pre-cutover)", () => {
    const a = mkObservedAdapter({
      listLocalUserDirs: () => ["alice", "incoming"],
      userMigratingIn: (s) => s === "incoming",
    });
    expect(getEvictObservedSlugs(a)).toEqual(["alice"]); // incoming guarded from eviction
  });

  it("evict-observed keeps a restored import guarded after the user dir is replaced", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-mig-pin-"));
    tmpDirs.push(root);
    fs.mkdirSync(path.join(root, "incoming"));
    writeMigratingInPin(root, "incoming");
    fs.rmSync(path.join(root, "incoming"), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, "incoming"));
    const a = mkObservedAdapter({
      listLocalUserDirs: () => listLocalUserDirs(root),
      userMigratingIn: (s) => isMigratingInPinned(root, s, 5 * 60_000),
    });

    expect(getEvictObservedSlugs(a)).toEqual([]);
  });

  it("evict-observed retains only the admitted user overlay", () => {
    const a = mkObservedAdapter({
      isIsolatedGateway: () => true,
      isConfiguredUser: (slug) => slug === "builder",
      configuredUserOverlayPresent: () => false,
      listLocalUserDirs: () => ["builder", "foreign", "partial"],
    });

    expect(getEvictObservedSlugs(a)).toEqual(["foreign", "partial"]);
  });

  it("mount-observed excludes a coach-wired-but-unmarked slug (the post-config wedge)", () => {
    const a = mkObservedAdapter({
      listLocalUserSlugs: () => ["alice", "bob"], // both default-agent-wired
      userMountMarked: (s) => s === "alice", // only alice fully mounted
    });
    expect(getMountObservedSlugs(a)).toEqual(["alice"]); // bob still in toMount
  });

  it("mount-observed excludes marked users missing runtime or durable workspace state", () => {
    const a = mkObservedAdapter({
      listLocalUserSlugs: () => ["healthy", "no-runtime", "no-git", "no-origin"],
      userMountMarked: () => true,
      hasUserAgentRuntime: (slug) => slug !== "no-runtime",
      hasWorkspaceGitDir: (slug) => slug !== "no-git",
      hasGitRemote: (slug) => slug !== "no-origin",
    });

    expect(getMountObservedSlugs(a)).toEqual(["healthy"]);
  });

  it("mount-observed requires a readable user overlay even when runtime directories exist", () => {
    const a = mkObservedAdapter({
      isIsolatedGateway: () => true,
      isConfiguredUser: () => true,
      listLocalUserSlugs: () => ["discord-user"],
      userMountMarked: () => true,
      configuredUserOverlayPresent: () => false,
      hasUserAgentRuntime: () => true,
      hasWorkspaceGitDir: () => true,
      hasGitRemote: () => true,
    });

    expect(getMountObservedSlugs(a)).toEqual([]);
  });

  it("mount-observed counts every default-agent-wired slug when no marker probe exists", () => {
    const a = mkObservedAdapter({
      listLocalUserSlugs: () => ["alice"],
      // no userMountMarked
    });
    expect(getMountObservedSlugs(a)).toEqual(["alice"]);
  });

  it("mount-observed is PIN-BLIND: a migrated default-agent-wired+marked slug is observed despite its pin", () => {
    // Regression guard: the migrating-in pin must NOT suppress mount-observed (or the
    // post-cutover target would re-ensure every tick for the pin's TTL). The pin only
    // gates eviction.
    const a = mkObservedAdapter({
      listLocalUserSlugs: () => ["migrated"],
      userMountMarked: () => true,
      userMigratingIn: () => true,
    });
    expect(getMountObservedSlugs(a)).toEqual(["migrated"]);
  });
});

describe("evictLocalUser — complete local teardown", () => {
  function adapter(overrides: Partial<UserLifecycleAdapter>): UserLifecycleAdapter {
    return {
      log: vi.fn(),
      uidForSlug: vi.fn(async () => null),
      applyRemoveUserConfigPatch: vi.fn(async () => undefined),
      hasUserDir: vi.fn(() => true),
      removePartialWorkspace: vi.fn(async () => undefined),
      deleteDepartedUserState: vi.fn(async () => undefined),
      readLocalUserPubKey: vi.fn(() => null),
      ...overrides,
    } as UserLifecycleAdapter;
  }

  it("prefers the imported-user teardown for an unassigned slug", async () => {
    const removeImportedUserBySlug = vi.fn(async () => ({
      wasMounted: true,
      steps: ["config-patch-remove", "delete-dir"] as const,
    }));
    const onUnmounted = vi.fn();
    const stampMounted = vi.fn(async () => undefined);
    const onLocalStateRemoved = vi.fn();
    const a = adapter({ removeImportedUserBySlug, onUnmounted });

    await expect(evictLocalUser({
      adapter: a,
      slug: "departed",
      stampMounted,
      onLocalStateRemoved,
    })).resolves.toBe("deleted-user");

    expect(removeImportedUserBySlug).toHaveBeenCalledWith("departed", undefined, undefined);
    expect(a.applyRemoveUserConfigPatch).not.toHaveBeenCalled();
    expect(a.deleteDepartedUserState).not.toHaveBeenCalled();
    expect(onUnmounted).toHaveBeenCalledWith("departed");
    expect(stampMounted).not.toHaveBeenCalled();
    expect(onLocalStateRemoved).toHaveBeenCalledWith("departed");
  });

  it("preserves the manual fallback for adapters without imported-user teardown", async () => {
    const onUnmounted = vi.fn();
    const onLocalStateRemoved = vi.fn();
    const a = adapter({ onUnmounted });

    await expect(evictLocalUser({
      adapter: a,
      slug: "departed",
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved,
    })).resolves.toBe("deleted-user");

    expect(a.applyRemoveUserConfigPatch).toHaveBeenCalledWith(
      "departed",
      "octogee-departed-coach",
      undefined,
      undefined,
    );
    expect(a.deleteDepartedUserState).toHaveBeenCalledWith("departed");
    expect(a.removePartialWorkspace).not.toHaveBeenCalled();
    expect(onUnmounted).toHaveBeenCalledWith("departed");
    expect(onLocalStateRemoved).toHaveBeenCalledWith("departed");
  });

  it("deletes departed state in the manual fallback even when the workspace is already gone", async () => {
    const a = adapter({ hasUserDir: vi.fn(() => false) });

    await expect(evictLocalUser({
      adapter: a,
      slug: "departed",
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved: vi.fn(),
    })).resolves.toBe("deleted-user");

    expect(a.deleteDepartedUserState).toHaveBeenCalledWith("departed");
  });

  it("clears runtime and fingerprint bookkeeping when teardown races with another cleanup", async () => {
    const onUnmounted = vi.fn();
    const onLocalStateRemoved = vi.fn();
    const a = adapter({
      removeImportedUserBySlug: vi.fn(async () => ({ wasMounted: false, steps: [] })),
      onUnmounted,
    });

    await expect(evictLocalUser({
      adapter: a,
      slug: "departed",
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved,
    })).resolves.toBe("noop");

    expect(onUnmounted).toHaveBeenCalledWith("departed");
    expect(onLocalStateRemoved).toHaveBeenCalledWith("departed");
  });

  it("keeps assigned-user mounted state and local bookkeeping cleanup", async () => {
    const stampMounted = vi.fn(async () => undefined);
    const onLocalStateRemoved = vi.fn();
    const a = adapter({
      uidForSlug: vi.fn(async () => "uid-alice"),
      loadUserSnapshot: vi.fn(async () => ({
        uid: "uid-alice",
        slug: "alice",
        contextTemplateKey: "default",
        planInputs: { tier: "trial" },
        gatewayId: "walter",
        status: "complete",
        agentIds: ["octogee-alice-coach"],
        repoUrl: "",
        mattermostUserId: null,
        channels: [],
        ownerName: "Alice",
        projects: [],
      })),
    });

    await expect(evictLocalUser({
      adapter: a,
      slug: "alice",
      stampMounted,
      onLocalStateRemoved,
    })).resolves.toBe("drained");

    expect(stampMounted).toHaveBeenCalledWith("uid-alice", false);
    expect(onLocalStateRemoved).toHaveBeenCalledWith("alice");
  });

  it("retains local state and invalidates mount completion when re-admitted after config removal", async () => {
    const onRetainedAfterConfigRemoval = vi.fn();
    const onLocalStateRemoved = vi.fn();
    const a = adapter({
      removeImportedUserBySlug: vi.fn(async () => ({
        wasMounted: true,
        steps: ["config-patch-remove"] as const,
        retained: true,
      })),
    });

    await expect(evictLocalUser({
      adapter: a,
      slug: "alice",
      currentEvictionBatch: vi.fn(async () => []),
      onRetainedAfterConfigRemoval,
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved,
    })).resolves.toBe("noop");

    expect(onRetainedAfterConfigRemoval).toHaveBeenCalledWith("alice");
    expect(onLocalStateRemoved).not.toHaveBeenCalled();
  });

  it("retains a matching user overlay before the missing-user fallback can mutate it", async () => {
    const onRetainedAfterConfigRemoval = vi.fn();
    const onLocalStateRemoved = vi.fn();
    const onUnmounted = vi.fn();
    const clearMountMarker = vi.fn();
    const clearUserMigratingIn = vi.fn();
    const a = adapter({
      isIsolatedGateway: () => true,
      isConfiguredUser: (slug) => slug === "builder",
      configuredUserOverlayPresent: (slug) => slug === "builder",
      onUnmounted,
      clearMountMarker,
      clearUserMigratingIn,
    });

    await expect(evictLocalUser({
      adapter: a,
      slug: "builder",
      onRetainedAfterConfigRemoval,
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved,
    })).resolves.toBe("noop");

    expect(a.uidForSlug).not.toHaveBeenCalled();
    expect(a.applyRemoveUserConfigPatch).not.toHaveBeenCalled();
    expect(a.deleteDepartedUserState).not.toHaveBeenCalled();
    expect(clearMountMarker).toHaveBeenCalledWith("builder");
    expect(clearUserMigratingIn).toHaveBeenCalledWith("builder");
    expect(onUnmounted).toHaveBeenCalledWith("builder");
    expect(onRetainedAfterConfigRemoval).toHaveBeenCalledWith("builder");
    expect(onLocalStateRemoved).not.toHaveBeenCalled();
  });

  it("fails closed for a matching user owner with an unreadable overlay", async () => {
    const a = adapter({
      isIsolatedGateway: () => true,
      isConfiguredUser: () => true,
      configuredUserOverlayPresent: () => false,
    });

    await expect(evictLocalUser({
      adapter: a,
      slug: "builder",
      stampMounted: vi.fn(async () => undefined),
      onLocalStateRemoved: vi.fn(),
    })).rejects.toThrow(/configured user system-config overlay is unavailable/);

    expect(a.uidForSlug).not.toHaveBeenCalled();
    expect(a.applyRemoveUserConfigPatch).not.toHaveBeenCalled();
    expect(a.deleteDepartedUserState).not.toHaveBeenCalled();
  });
});

describe("cancelRemovedEviction", () => {
  it("invalidates a re-admitted user only when its config-removal marker existed", () => {
    const invalidate = vi.fn();
    const removed = {
      cancelPendingEviction: vi.fn(() => true),
    } as unknown as UserLifecycleAdapter;
    const untouched = {
      cancelPendingEviction: vi.fn(() => false),
    } as unknown as UserLifecycleAdapter;

    expect(cancelRemovedEviction(removed, "b", invalidate)).toBe(true);
    expect(cancelRemovedEviction(untouched, "c", invalidate)).toBe(false);
    expect(invalidate).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith("b");
  });
});

describe("evictLocalUserIfStillUndesired", () => {
  it("does not run stale cleanup after the user is re-admitted", async () => {
    const evict = vi.fn(async () => "drained" as const);

    await expect(evictLocalUserIfStillUndesired({
      slug: "alice",
      evictionBatch: ["alice"],
      readDesired: vi.fn(async () => ["alice"]),
      evict,
    })).resolves.toBe("noop");

    expect(evict).not.toHaveBeenCalled();
  });

  it("runs cleanup once when the latest desired roster still excludes the user", async () => {
    const evict = vi.fn(async () => "drained" as const);

    await expect(evictLocalUserIfStillUndesired({
      slug: "alice",
      evictionBatch: ["alice"],
      readDesired: vi.fn(async () => ["bob"]),
      evict,
    })).resolves.toBe("drained");

    expect(evict).toHaveBeenCalledWith(["alice"], expect.any(Function));
  });

  it("filters re-admitted users from the shared config-removal batch", async () => {
    const evict = vi.fn(async () => "drained" as const);

    await expect(evictLocalUserIfStillUndesired({
      slug: "alice",
      evictionBatch: ["alice", "bob"],
      readDesired: vi.fn(async () => ["bob"]),
      evict,
    })).resolves.toBe("drained");

    expect(evict).toHaveBeenCalledWith(["alice"], expect.any(Function));
  });
});

describe("in-pod gateway heartbeat", () => {
  it("keeps a healthy HTTP server unready until workspace identities are initialized", async () => {
    const identitiesReady = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const healthz = vi.fn(async () => true);
    await expect(probeOpenClawRuntimeReady(healthz, identitiesReady)).resolves.toBe(false);
    await expect(probeOpenClawRuntimeReady(healthz, identitiesReady)).resolves.toBe(true);
  });

  it("does not admit a stopped OpenClaw process with an existing identity marker", async () => {
    await expect(probeOpenClawRuntimeReady(async () => false, () => true)).resolves.toBe(false);
  });

  it("waits on the lightweight health endpoint instead of retrying authenticated RPC", async () => {
    const probeHealthz = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const sleep = vi.fn(async () => undefined);

    await expect(waitForOpenClawHealthz({ probeHealthz, sleep })).resolves.toBeUndefined();

    expect(probeHealthz).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 1_000);
  });

  it("uses lightweight local health without opening an authenticated RPC on every probe", async () => {
    const probeHealthz = vi.fn(async () => true);

    await expect(probeSurgeReadiness({
      runtimeStatus: "ready",
      handoffReleased: true,
      probeHealthz,
    })).resolves.toEqual({
      ready: true,
      openclawUp: true,
      brokerProfilesSettled: true,
      dashboardBridgeReady: true,
    });
    expect(probeHealthz).toHaveBeenCalledOnce();

    probeHealthz.mockResolvedValueOnce(false);
    await expect(probeSurgeReadiness({
      runtimeStatus: "ready",
      handoffReleased: true,
      probeHealthz,
    })).resolves.toEqual({
      ready: false,
      openclawUp: false,
      brokerProfilesSettled: true,
      dashboardBridgeReady: true,
    });

    probeHealthz.mockClear();
    await expect(probeSurgeReadiness({
      runtimeStatus: "booting",
      handoffReleased: true,
      probeHealthz,
    })).resolves.toEqual({
      ready: false,
      openclawUp: false,
      brokerProfilesSettled: true,
      dashboardBridgeReady: true,
    });
    expect(probeHealthz).not.toHaveBeenCalled();
  });

  it("keeps readiness open while a user is actively provisioning", async () => {
    const probeHealthz = vi.fn(async () => false);

    await expect(probeSurgeReadiness({
      runtimeStatus: "ready",
      handoffReleased: true,
      provisioning: true,
      probeHealthz,
    })).resolves.toEqual({
      ready: true,
      openclawUp: true,
      brokerProfilesSettled: true,
      dashboardBridgeReady: true,
    });

    expect(probeHealthz).not.toHaveBeenCalled();
  });

  it("holds readiness closed until the broker profiles and Dashboard bridge both settle", async () => {
    const probeHealthz = vi.fn(async () => true);

    await expect(probeSurgeReadiness({
      runtimeStatus: "ready",
      handoffReleased: true,
      brokerProfilesSettled: false,
      dashboardBridgeReady: true,
      probeHealthz,
    })).resolves.toMatchObject({ ready: false, openclawUp: true });

    await expect(probeSurgeReadiness({
      runtimeStatus: "ready",
      handoffReleased: true,
      brokerProfilesSettled: true,
      dashboardBridgeReady: false,
      probeHealthz,
    })).resolves.toMatchObject({ ready: false, openclawUp: true });
  });

  it("retries the initial broker-profile sweep until every profile is settled", async () => {
    const sweep = vi.fn()
      .mockResolvedValueOnce({ settled: false, deferred: ["octogee-alice-coach"] })
      .mockResolvedValueOnce({ settled: true, deferred: [] });
    const sleep = vi.fn(async () => undefined);

    await expect(waitForBrokerProfilesSettled({ sweep, sleep })).resolves.toBeUndefined();

    expect(sweep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("waits for the Dashboard bridge capability handshake with bounded state logs", async () => {
    const probe = vi.fn()
      .mockReturnValueOnce({ ready: false, state: "missing" })
      .mockReturnValueOnce({ ready: false, state: "missing" })
      .mockReturnValueOnce({ ready: false, state: "stale" })
      .mockReturnValueOnce({ ready: true, state: "ready" });
    const log = vi.fn();
    const sleep = vi.fn(async () => undefined);

    await expect(waitForDashboardBridgeReady({
      required: true,
      openclawDir: "/unused",
      gatewayId: "gw-test",
      log,
      probe,
      sleep,
    })).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(1, expect.stringContaining("state=missing"));
    expect(log).toHaveBeenNthCalledWith(2, expect.stringContaining("state=stale"));
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("treats a Dashboard bridge as ready when the isolated gateway contract is disabled", () => {
    expect(dashboardBridgeReady({
      required: false,
      openclawDir: "/does-not-exist",
      gatewayId: "gw-test",
    })).toEqual({ ready: true, state: "not-required" });
  });

  it("reports the OpenClaw runtime version through the signed fleet state endpoint", () => {
    expect(
      buildFleetStateResponse({
        status: "ready",
        gatewayId: "default",
        podUid: "pod-uid-1",
        version: "sha-1",
        openclawVersion: "2026.7.1",
        startedAt: 42,
        users: ["alice"],
        migratingIn: [],
        configuredBuilder: null,
      }),
    ).toMatchObject({ openclawVersion: "2026.7.1", podUid: "pod-uid-1", customers: ["alice"] });
  });

  it("reports the configured user through the signed fleet state, never the unauthenticated probe", () => {
    const state = buildFleetStateResponse({
      status: "ready",
      gatewayId: "b-chris",
      podUid: "pod-uid-1",
      version: "sha-1",
      openclawVersion: "2026.7.1",
      startedAt: 42,
      users: [],
      migratingIn: [],
      configuredBuilder: { state: "claimed", generation: 2 },
    });

    expect(state).toMatchObject({ status: "ready", customers: [], configuredBuilder: { state: "claimed", generation: 2 } });
    expect(buildFleetHealthResponse({ status: "ready", podUid: "pod-uid-1", startedAt: 42 }))
      .not.toHaveProperty("configuredBuilder");
  });

  it("reports why the configured user's OpenClaw is not serving through the signed fleet state", () => {
    const state = buildFleetStateResponse({
      status: "booting",
      gatewayId: "b-chris",
      podUid: "pod-uid-1",
      version: "sha-1",
      openclawVersion: "2026.7.1",
      startedAt: 42,
      users: [],
      migratingIn: [],
      configuredBuilder: { state: "claimed", generation: null },
      openclawProcess: { state: "held", migrationId: null },
    });

    expect(state.openclawProcess).toEqual({ state: "held", migrationId: null });
  });

  it("keeps the unauthenticated probe body free of tenant identity", () => {
    const probe = buildFleetHealthResponse({
      status: "ready",
      podUid: "pod-uid-1",
      startedAt: 42,
    });

    expect(probe).toEqual({ status: "ready", podUid: "pod-uid-1", startedAt: 42, rsyncAttemptFencing: true });
  });
});

describe("resolveFleetCapabilities — brokered local reconcile", () => {
  it("provisions local mounts when the local reconcile runs from a brokered roster", () => {
    expect(resolveFleetCapabilities({ localReconcile: true, hasBrokeredRoster: true })).toEqual({ provision: true });
  });

  it("does not provision without both the local reconcile and a brokered roster", () => {
    expect(resolveFleetCapabilities({ localReconcile: false, hasBrokeredRoster: true })).toEqual({ provision: false });
    expect(resolveFleetCapabilities({ hasBrokeredRoster: true })).toEqual({ provision: false });
    expect(resolveFleetCapabilities({ localReconcile: true, hasBrokeredRoster: false })).toEqual({ provision: false });
  });
});

describe("createVerifyAttachPending", () => {
  afterEach(() => _resetReconcileInFlightForTests());

  it("reports an assignment the reconcile has not picked up yet as a pending attach", async () => {
    const readDesiredSlugs = vi.fn(async () => ["alice"]);
    const pending = createVerifyAttachPending({ provision: true, opts: { gatewayId: "shared-1", readDesiredSlugs } });

    expect(await pending?.("alice")).toBe(true);
    expect(await pending?.("bob")).toBe(false);
  });

  it("reads the assignment from the content-convergence roster when one is wired", async () => {
    const pending = createVerifyAttachPending({
      provision: true,
      opts: { gatewayId: "shared-1", readDesiredUsers: async () => new Map([["alice", { uid: "uid-alice", fingerprint: "fp-1", lane: "move" as const, ensureAllowed: true }]]) },
    });

    expect(await pending?.("alice")).toBe(true);
  });

  it("offers no attach signal on a gateway that does not run the mount reconcile", () => {
    expect(createVerifyAttachPending({
      provision: false,
      opts: { gatewayId: "shared-1", readDesiredSlugs: async () => ["alice"] },
    })).toBeUndefined();
  });
});

describe("OpenClaw process report", () => {
  const configuredAdapter = {
    isIsolatedGateway: () => true,
    isConfiguredUser: (slug: string) => slug === "ceckert-test",
    configuredUserOverlayPresent: () => true,
    userMountMarked: () => false,
  } as unknown as UserLifecycleAdapter;

  function gateAt(state: Partial<SurgeOpenClawProcessGateState>): Pick<SurgeOpenClawProcessSupervisorClient, "status"> {
    return { status: async () => ({ version: 1, podUid: "pod-1", role: "normal", mode: "held", phase: "held", ...state }) };
  }

  it("says nothing for a gateway without a configured user", async () => {
    const status = vi.fn();
    await expect(openclawProcessReport({ adapter: {} as UserLifecycleAdapter, processGate: { status }, log: () => undefined }))
      .resolves.toBeNull();
    expect(status).not.toHaveBeenCalled();
  });

  it("reports a hold that no move owns", async () => {
    stubUserClaim("ceckert-test");
    await expect(openclawProcessReport({ adapter: configuredAdapter, processGate: gateAt({}), log: () => undefined }))
      .resolves.toEqual({ state: "held", migrationId: null });
  });

  it("names the move that holds it", async () => {
    stubUserClaim("ceckert-test");
    const processGate = gateAt({ role: "target", migrationId: "mig-1", slug: "ceckert-test", targetPodUid: "pod-1" });
    await expect(openclawProcessReport({ adapter: configuredAdapter, processGate, log: () => undefined }))
      .resolves.toEqual({ state: "held", migrationId: "mig-1" });
  });

  it.each([
    ["starting", "starting"],
    ["running", "serving"],
  ] as const)("reports a permitted OpenClaw in phase %s as %s", async (phase, expected) => {
    stubUserClaim("ceckert-test");
    await expect(openclawProcessReport({ adapter: configuredAdapter, processGate: gateAt({ mode: "permitted", phase }), log: () => undefined }))
      .resolves.toEqual({ state: expected, migrationId: null });
  });

  it("reports and logs a supervisor that does not answer", async () => {
    stubUserClaim("ceckert-test");
    const log = vi.fn();
    const processGate = { status: async () => { throw new Error("connect ENOENT supervisor.sock"); } };
    await expect(openclawProcessReport({ adapter: configuredAdapter, processGate, log }))
      .resolves.toEqual({ state: "unavailable", migrationId: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("connect ENOENT supervisor.sock"));
  });

  it("answers unavailable well inside the heartbeat deadline when the supervisor accepts and never answers", async () => {
    stubUserClaim("ceckert-test");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-gate-"));
    const socketPath = path.join(dir, "gate.sock");
    const accepted = new Set<net.Socket>();
    const server = net.createServer(socket => { accepted.add(socket); });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    try {
      const processGate = createSurgeOpenClawProcessSupervisorClient(dir, { socketPath });
      const started = Date.now();
      await expect(openclawProcessReport({ adapter: configuredAdapter, processGate, log: () => undefined }))
        .resolves.toEqual({ state: "unavailable", migrationId: null });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
