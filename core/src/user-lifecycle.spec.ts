import { describe, it, expect, beforeEach, vi } from "vitest";
import { provisionDefaultAgentAutomation } from "./gateway-rpc.js";
import {
  addUserToGateway,
  cloneMissingProjects,
  cloneProjectsFromSnapshot,
  ConcurrentMountError,
  _resetInFlightUidsForTests,
  _inFlightUidsHasForTests,
  pubKeysMatch,
  removeUserFromGateway,
  restoreUserRuntimeFromSnapshot,
  type UserLifecycleAdapter,
  type ProjectCloneOptions,
  type ProjectCloneTarget,
  type UserContext,
  type UserSnapshot,
  type MmUpdate,
  type ServiceProvisioningAdapter,
  type ServiceProvisioningAnswer,
} from "./user-lifecycle.js";

interface DiskState {
  customerDir: boolean;
  agentRuntime?: boolean;
  workspaceGitDir: boolean;
  gitRemote: boolean;
  sshKey: boolean;
  templatesWritten: boolean;

repoHasCommits: boolean;
}

interface MockState {
  user: UserSnapshot | null;
  disk: DiskState;
  
  calls: string[];
  
  writes: Array<{ field: string; value: unknown }>;
  cloneShouldFail: boolean;

cloneSimulatesEmptyRepo: boolean;
  initShouldFail: boolean;
  giteaRegisterShouldFail: boolean;

giteaRegisteredPubKey: string | null;

giteaRegisteredPubKeys?: string[];

giteaReadShouldThrow: boolean;

giteaReleaseShouldFail?: boolean;

  blobSyncShouldFail: boolean;
  reassertByotShouldFail?: boolean;
  reassertByotUserData?: Record<string, unknown>;
  templateContext?: UserContext;
  reassertContextFilesShouldFail?: boolean;
  reassertContextFilesUserData?: Record<string, unknown>;
  provisionedReports: Array<{ uid: string; slug: string; first: boolean }>;
  reportFailure: Error | null;
  errorLogs: string[];
  byosub?: { restored: boolean; present: boolean };
  lastConfigPatchByosActive?: boolean;
  lastConfigPatchOpts?: Parameters<UserLifecycleAdapter["applyAddUserConfigPatch"]>[2];
  configPatchWithoutProjectIds: Array<readonly string[]>;
  configPatchFingerprint?: string;
  healthy: boolean;
  pendingProjects: ProjectCloneTarget[];
  cloneProjectCalls: Array<{
    projectSlug: string;
    giteaRepoName: string | null;
    opts: ProjectCloneOptions | undefined;
  }>;
  logs: string[];
  cloneProjectThrows?: boolean;
  cloneProjectLands?: boolean;

}

function deferredFlag(): { value: boolean } {
  return { value: false };
}

function makeAdapter(state: MockState): UserLifecycleAdapter {
  const record = (name: string): void => {
    state.calls.push(name);
  };
  const write = (field: string, value: unknown) => {
    record(`write:${field}`);
    state.writes.push({ field, value });
  };
  return {
    log: (msg, fields) => {
      state.logs.push(msg);
      if (fields?.status === "failed") state.errorLogs.push(msg);
    },

    isConfiguredUser: () => true,
    configuredUserOverlayPresent: () => true,

    loadUserSnapshot: async () => state.user,

    setProvisioningStatus: async (_uid, status) => write("provisioning.openclaw.status", status),
    provisionDefaultAgentAutomation: async () => record("provisionDefaultAgentAutomation"),
    setRepoUrl: async (_uid, repoUrl) => write("provisioning.git.repoUrl", repoUrl),
    setMattermostFields: async (_uid, fields) => write("mattermost.*", fields),
    ensureAgentIds: async (_uid, agentIds) =>
      write("provisioning.openclaw.agentIds", agentIds),

    hasUserDir: () => state.disk.customerDir,
    hasUserAgentRuntime: () => state.disk.agentRuntime ?? state.disk.customerDir,
    hasWorkspaceGitDir: () => state.disk.workspaceGitDir,
    hasGitRemote: () => state.disk.gitRemote,
    ensureUserDirectories: () => {
      record("ensureUserDirectories");
      state.disk.customerDir = true;
    },
    writeUserTemplateFiles: async (ctx) => {
      record("writeUserTemplateFiles");
      state.templateContext = ctx;
      state.disk.templatesWritten = true;
    },
    removePartialWorkspace: async () => {
      record("removePartialWorkspace");
      state.disk.customerDir = false;
      state.disk.workspaceGitDir = false;
      state.disk.gitRemote = false;
    },
    deleteDepartedUserState: async () => {
      record("deleteDepartedUserState");
      state.disk.customerDir = false;
      state.disk.workspaceGitDir = false;
      state.disk.gitRemote = false;
    },

    cloneWorkspaceRepo: async (_slug, _url) => {
      record("cloneWorkspaceRepo");
      if (state.cloneShouldFail) return false;

      if (state.disk.customerDir && !state.disk.workspaceGitDir) return false;
      state.disk.customerDir = true;
      state.disk.workspaceGitDir = true;
      state.disk.gitRemote = true;

if (!state.cloneSimulatesEmptyRepo) {
        state.disk.repoHasCommits = true;
      }
      return true;
    },
    initWorkspaceRepoFromExistingDir: async () => {
      record("initWorkspaceRepoFromExistingDir");
      if (state.initShouldFail) return null;
      state.disk.workspaceGitDir = true;
      state.disk.gitRemote = true;
      return "http://gitea/octogee/test-workspace";
    },

    hasUserSshKey: () => state.disk.sshKey,
    generateUserSshKey: () => {
      record("generateUserSshKey");
      state.disk.sshKey = true;

return "ssh-pubkey";
    },
    gitHost: {
      registerKey: async (_slug, pubKey) => {
        record("registerKey");
        if (state.giteaRegisterShouldFail) {
          throw new Error("gitea register failed");
        }

        if (state.giteaRegisteredPubKeys) {
          if (!state.giteaRegisteredPubKeys.includes(pubKey)) {
            state.giteaRegisteredPubKeys.push(pubKey);
          }
        } else {
          state.giteaRegisteredPubKey = pubKey;
        }
      },
      ensureOwner: async () => {
        record("ensureOwner");
      },
      ensureRepo: async (_slug, role) => {
        record(`ensureRepo:${role.kind}`);
      },
      listKeys: async () => {
        if (state.giteaReadShouldThrow) {
          throw new Error("Gitea key read failed (test transient)");
        }
        return state.giteaRegisteredPubKeys ??
          (state.giteaRegisteredPubKey === null ? [] : [state.giteaRegisteredPubKey]);
      },
    },
    readLocalUserPubKey: () => (state.disk.sshKey ? "ssh-pubkey" : null),
    giveUpUserGitKey: async () => {
      if (!state.disk.sshKey) return "absent";
      record("giveUpUserGitKey");
      if (state.giteaReleaseShouldFail) throw new Error("git key release failed");
      state.disk.sshKey = false;
      return "released";
    },

    blobSyncForSlug: async () => {
      record("blobSyncForSlug");
      if (state.blobSyncShouldFail) throw new Error("blob sync failed");
    },
    restoreByosubForAgent: async () => {
      record("restoreByosubForAgent");
      return state.byosub ?? { restored: false, present: false };
    },
    reassertByotForUser: async (userData) => {
      record("reassertByotForUser");
      state.reassertByotUserData = { ...userData };
      if (state.reassertByotShouldFail) throw new Error("byot reassert failed");
    },
    reassertConvergedContextFilesForUser: async (userData) => {
      record("reassertConvergedContextFilesForUser");
      state.reassertContextFilesUserData = { ...userData };
      if (state.reassertContextFilesShouldFail) throw new Error("context-file reassert failed");
    },

    listProjectsNeedingClone: async () => {
      record("listProjectsNeedingClone");
      return [...state.pendingProjects];
    },
    cloneProjectRepo: async (_slug, projectSlug, giteaRepoName, opts) => {
      record("cloneProjectRepo");
      state.cloneProjectCalls.push({ projectSlug, giteaRepoName, opts });
      if (state.cloneProjectThrows) throw new Error("gitea unreachable");
      if (state.cloneProjectLands === false) return false;
      // A landed clone leaves a .git behind, so the project no longer needs cloning —
      // listProjectsNeedingClone is an on-disk probe, not a static list.
      state.pendingProjects = state.pendingProjects.filter((p) => p.projectSlug !== projectSlug);
      return true;
    },

    provisionMattermostUser: async () => {
      record("provisionMattermostUser");
      const update: MmUpdate = {
        "mattermost.userId": "mm-user-123",
        "mattermost.channelId": "c".repeat(26),
        _coachPersonalToken: "default-agent-pat",
      };
      return update;
    },
    applyAddUserConfigPatch: async (_snap, _mm, opts) => {
      record("applyAddUserConfigPatch");
      state.lastConfigPatchOpts = opts;
      state.lastConfigPatchByosActive = opts?.byosActive ?? false;
      state.configPatchWithoutProjectIds.push([...(opts?.withoutProjectIds ?? [])]);
      return {
        elapsedMs: 42,
        ...(state.configPatchFingerprint
          ? { appliedFingerprint: state.configPatchFingerprint }
          : {}),
      };
    },
    applyRemoveUserConfigPatch: async () => {
      record("applyRemoveUserConfigPatch");
    },
    waitForAccountHealthy: async () => {
      record("waitForAccountHealthy");
      return state.healthy;
    },
    projectAgentsHealthy: async () => true,
    materializeBrokerProfiles: () => record("materializeBrokerProfiles"),

    reportProvisioned: async (ctx, report) => {
      record("reportProvisioned");
      if (state.reportFailure) throw state.reportFailure;
      state.provisionedReports.push({ uid: ctx.uid, slug: ctx.slug, first: report.first });
    },

    onMounted: () => record("onMounted"),
    onUnmounted: () => record("onUnmounted"),
    uidForSlug: async () => state.user?.uid ?? null,
    quiesceUser: async () => ({ drained: true, runningCount: 0 }),
    listExportPaths: async () => [],
    prepareImportDir: async () => "/tmp/import",
    prepareKeyImportDir: async () => "/tmp/import",
    activateImportedUser: async () => ({ appliedFingerprint: "fp-test" }),
    schedulerMigration: async () => { throw new Error("user lifecycle tests do not migrate schedules"); },
    schedulerReady: async () => { throw new Error("user lifecycle tests do not wait for the scheduler"); },
    resumeUser: async () => { throw new Error("user lifecycle tests do not resume users"); },
  };
}

function snap(overrides: Partial<UserSnapshot> = {}): UserSnapshot {
  return {
    uid: "uid-test",
    slug: "test",
    contextTemplateKey: "default",
    planInputs: {},
    gatewayId: "gw-test",
    status: "",
    agentIds: [],
    repoUrl: "",
    mattermostUserId: null,
    channels: [{ scope: "workspace", kind: "coach-dm", channelId: "c".repeat(26) }],
    ownerName: "Test User",
    persona: null,
    projectCheckoutScope: "workspace-and-projects",
    ...overrides,
  };
}

function emptyDisk(): DiskState {
  return {
    customerDir: false,
    workspaceGitDir: false,
    gitRemote: false,
    sshKey: false,
    templatesWritten: false,
    repoHasCommits: false,
  };
}

function makeState(snapshot: UserSnapshot | null, disk: DiskState): MockState {
  return {
    user: snapshot,
    disk,
    calls: [],
    writes: [],
    cloneShouldFail: false,
    cloneSimulatesEmptyRepo: false,
    initShouldFail: false,
    giteaRegisterShouldFail: false,
    giteaRegisteredPubKey: null,
    giteaReadShouldThrow: false,
    blobSyncShouldFail: false,
    healthy: true,
    pendingProjects: [],
    cloneProjectCalls: [],
    configPatchWithoutProjectIds: [],
    logs: [],
    provisionedReports: [],
    reportFailure: null,
    errorLogs: [],
  };
}

const GITHUB_REPO_SOURCE = {
  provider: "github",
  owner: "octogee-ai",
  repo: "demo",
} as const;

function mountedDisk(): DiskState {
  return {
    ...emptyDisk(),
    customerDir: true,
    workspaceGitDir: true,
    gitRemote: true,
    sshKey: true,
  };
}

function mountedSnapshot(overrides: Partial<UserSnapshot> = {}): UserSnapshot {
  return snap({
    status: "complete",
    repoUrl: "http://gitea/octogee/test-workspace",
    mattermostUserId: "mm-user",
    ...overrides,
  });
}

describe("addUserToGateway — first-time provisioning", () => {
  let state: MockState;
  beforeEach(() => {
    state = makeState(snap({ status: "" }), emptyDisk());
  });

  it("completes a new workspace after channel verification without posting a greeting", async () => {
    await addUserToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("waitForAccountHealthy");
    expect(state.writes).toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
    expect(state.writes.some((write) => write.field.includes("greeting"))).toBe(false);
  });

  it("provisions agent monitoring after readiness and before durable completion", async () => {
    await addUserToGateway(makeAdapter(state), "uid-test");
    const provisioned = state.calls.indexOf("provisionDefaultAgentAutomation");
    expect(provisioned).toBeGreaterThan(state.calls.indexOf("waitForAccountHealthy"));
    expect(provisioned).toBeLessThan(state.calls.lastIndexOf("write:provisioning.openclaw.status"));
  });

  it("uses the newly created private agent channel while the snapshot is stale", async () => {
    const adapter = makeAdapter(state);
    const channelId = "c".repeat(26);
    const cronAdd = vi.fn(async () => ({ id: "initial-monitor" }));
    adapter.provisionMattermostUser = async () => ({ "mattermost.userId": "a".repeat(26), "mattermost.channelId": channelId });
    adapter.provisionDefaultAgentAutomation = async (user) => {
      await provisionDefaultAgentAutomation({ cronAdd }, user);
    };
    await addUserToGateway(adapter, "uid-test");
    expect(cronAdd).toHaveBeenCalledWith(expect.objectContaining({
      delivery: { mode: "announce", channel: "mattermost", accountId: "test-coach", to: `channel:${channelId}` },
    }));
  });

  it("refuses a missing private agent channel before monitoring or completion", async () => {
    const adapter = makeAdapter(state);
    adapter.provisionMattermostUser = async () => ({});
    adapter.provisionDefaultAgentAutomation = vi.fn(async () => {});
    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow("has no private agent channel");
    expect(adapter.provisionDefaultAgentAutomation).not.toHaveBeenCalled();
    expect(state.writes).not.toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
  });

  it("uses only the canonical workspace agent channel on a provisioning retry", async () => {
    state.user = snap({ status: "provisioning", mattermostUserId: "a".repeat(26), channels: [
      { scope: "workspace", kind: "general", channelId: "g".repeat(26) },
      { scope: "project", projectId: "project", kind: "coach-dm", channelId: "p".repeat(26) },
      { scope: "workspace", kind: "coach-dm", channelId: "c".repeat(26) },
    ] });
    const adapter = makeAdapter(state);
    adapter.provisionDefaultAgentAutomation = vi.fn(async () => {});
    await addUserToGateway(adapter, "uid-test");
    expect(adapter.provisionDefaultAgentAutomation).toHaveBeenCalledWith({ slug: "test", coachChannelId: "c".repeat(26) });
  });

  it("refuses ambiguous private agent channel bindings before durable completion", async () => {
    state.user = snap({ status: "provisioning", mattermostUserId: "a".repeat(26), channels: [
      { scope: "workspace", kind: "coach-dm", channelId: "a".repeat(26) },
      { scope: "workspace", kind: "coach-dm", channelId: "b".repeat(26) },
    ] });
    await expect(addUserToGateway(makeAdapter(state), "uid-test")).rejects.toThrow("has no private agent channel");
    expect(state.writes).not.toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
  });

  it("keeps failed monitor provisioning pending and retries before completing", async () => {
    const adapter = makeAdapter(state);
    const provision = vi.fn().mockRejectedValueOnce(new Error("cron unavailable")).mockResolvedValue(undefined);
    adapter.provisionDefaultAgentAutomation = provision;
    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow("cron unavailable");
    expect(state.writes).not.toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
    state.user = snap({ status: "provisioning", mattermostUserId: "mm-user" });
    await addUserToGateway(adapter, "uid-test");
    expect(provision).toHaveBeenCalledTimes(2);
    expect(state.writes).toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
  });

  it("does not recreate deleted monitoring during a completed user reconcile", async () => {
    state.user = mountedSnapshot({ agentIds: ["octogee-test-coach"] });
    state.disk = mountedDisk();
    const adapter = makeAdapter(state);
    adapter.provisionDefaultAgentAutomation = vi.fn(async () => {});
    await addUserToGateway(adapter, "uid-test");
    expect(adapter.provisionDefaultAgentAutomation).not.toHaveBeenCalled();
  });

  it("runs the full first-time flow and writes Firestore in canonical order", async () => {
    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.newUser).toBe(true);

expect(result.steps).toEqual([
      "claim-slot",
      "ssh-key",
      "write-templates",
      "init-workspace-repo",
      "mattermost-provision",
      "config-patch",
      "verify-channel-ready",
      "byot-reassert",
      "context-files-reassert",
      "mark-complete",
      "blob-sync",
      "report-provisioned",
    ]);
  });

  it("verifies channel readiness right after config convergence, before the byot re-assert", async () => {
    await addUserToGateway(makeAdapter(state), "uid-test");

    const patchIndex = state.calls.indexOf("applyAddUserConfigPatch");
    const verifyIndex = state.calls.indexOf("waitForAccountHealthy");
    const reassertIndex = state.calls.indexOf("reassertByotForUser");

    expect(verifyIndex).toBeGreaterThan(patchIndex);
    expect(reassertIndex).toBeGreaterThan(verifyIndex);
  });

  it("marks the user complete before blob sync and the provisioned report", async () => {
    await addUserToGateway(makeAdapter(state), "uid-test");

    const verifyIdx = state.calls.indexOf("waitForAccountHealthy");
    const completeIdx = state.calls.indexOf("write:provisioning.openclaw.status");
    const completeAt = state.calls.lastIndexOf("write:provisioning.openclaw.status");
    expect(state.writes.filter((w) => w.field === "provisioning.openclaw.status").map((w) => w.value))
      .toEqual(["provisioning", "complete"]);
    expect(completeIdx).toBeLessThan(verifyIdx);
    expect(completeAt).toBeGreaterThan(verifyIdx);
    const blobSyncAt = state.calls.indexOf("blobSyncForSlug");
    expect(blobSyncAt).toBeGreaterThan(completeAt);
    expect(state.calls.indexOf("reportProvisioned")).toBeGreaterThan(blobSyncAt);
  });

  it("names the agent agent on the user when the slot is claimed, before broker profiles start", async () => {
    await addUserToGateway(makeAdapter(state), "uid-test");

    const agentIdsIdx = state.calls.indexOf("write:provisioning.openclaw.agentIds");
    expect(agentIdsIdx).toBeGreaterThan(state.calls.indexOf("write:provisioning.openclaw.status"));
    expect(agentIdsIdx).toBeLessThan(state.calls.indexOf("materializeBrokerProfiles"));
    expect(state.writes.find((w) => w.field === "provisioning.openclaw.agentIds")?.value).toEqual(["octogee-test-coach"]);
  });

  it("starts broker profile materialization before Gitea and settles it for the config patch", async () => {
    let settled = false;
    const adapter = {
      ...makeAdapter(state),
      materializeBrokerProfiles: async () => {
        state.calls.push("materializeBrokerProfiles");
        await new Promise((resolve) => setTimeout(resolve, 5));
        settled = true;
      },
    };
    await addUserToGateway(adapter, "uid-test");

    expect(state.calls.indexOf("materializeBrokerProfiles")).toBeLessThan(state.calls.indexOf("registerKey"));
    expect(state.lastConfigPatchOpts?.brokerProfilesReady).toBeInstanceOf(Promise);
    await state.lastConfigPatchOpts!.brokerProfilesReady;
    expect(settled).toBe(true);
  });

  it("keeps a failed early broker profile materialization non-fatal", async () => {
    let attempts = 0;
    const adapter = {
      ...makeAdapter(state),
      materializeBrokerProfiles: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("openclaw refused the secrets apply");
      },
    };
    const result = await addUserToGateway(adapter, "uid-test");

    expect(result.steps).toContain("mark-complete");
    await expect(state.lastConfigPatchOpts!.brokerProfilesReady).resolves.toBeUndefined();
    expect(state.logs.some((line) => line.includes("early broker profile materialization failed"))).toBe(true);
  });

  it("provisions the workspace repo and Mattermost concurrently", async () => {
    const adapter = {
      ...makeAdapter(state),
      initWorkspaceRepoFromExistingDir: async () => {
        const deadline = Date.now() + 500;
        while (!state.calls.includes("provisionMattermostUser")) {
          if (Date.now() > deadline) throw new Error("Mattermost provisioning waited for the Gitea repo");
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        state.calls.push("initWorkspaceRepoFromExistingDir");
        return "http://gitea.local/test/workspace";
      },
    };
    const result = await addUserToGateway(adapter, "uid-test");

    expect(result.steps.slice(0, 5)).toEqual([
      "claim-slot", "ssh-key", "write-templates", "init-workspace-repo", "mattermost-provision",
    ]);
    expect(state.calls.indexOf("applyAddUserConfigPatch"))
      .toBeGreaterThan(state.calls.indexOf("initWorkspaceRepoFromExistingDir"));
  });

  it("waits for Mattermost provisioning to finish before a Gitea failure releases the mount", async () => {
    const mattermostDone = deferredFlag();
    const adapter = {
      ...makeAdapter(state),
      initWorkspaceRepoFromExistingDir: async () => {
        throw new Error("gitea down");
      },
      provisionMattermostUser: async () => {
        state.calls.push("provisionMattermostUser");
        await new Promise((resolve) => setTimeout(resolve, 20));
        mattermostDone.value = true;
        state.calls.push("provisionMattermostUser:done");
        return { "mattermost.userId": "mm-user-123", _coachPersonalToken: "default-agent-pat" };
      },
    };

    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow("gitea down");

    expect(mattermostDone.value).toBe(true);
    expect(state.calls).toContain("provisionMattermostUser:done");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
  });

  it("retries the deferred broker profiles once the agent is verified, before marking the workspace complete", async () => {
    await addUserToGateway(makeAdapter(state), "uid-test");

    const verifyIdx = state.calls.indexOf("waitForAccountHealthy");
    const materializeIdx = state.calls.lastIndexOf("materializeBrokerProfiles");
    const completeIdx = state.calls.lastIndexOf("write:provisioning.openclaw.status");

    expect(materializeIdx).toBeGreaterThan(verifyIdx);
    expect(completeIdx).toBeGreaterThan(materializeIdx);
  });

  it("ensures the per-workspace Gitea org BEFORE the workspace repo (#963)", async () => {
    await addUserToGateway(makeAdapter(state), "uid-test");

    const orgIdx = state.calls.indexOf("ensureOwner");
    const repoIdx = state.calls.indexOf("initWorkspaceRepoFromExistingDir");

expect(orgIdx).toBeGreaterThan(-1);
    expect(repoIdx).toBeGreaterThan(orgIdx);
  });

  it("ensures the durable system_config repo for every user, not just non-shared pods (#3196)", async () => {
    await addUserToGateway(makeAdapter(state), "uid-test");

    const orgIdx = state.calls.indexOf("ensureOwner");
    const systemConfigIdx = state.calls.indexOf("ensureRepo:system-config");

    expect(systemConfigIdx).toBeGreaterThan(-1);
    expect(systemConfigIdx).toBeGreaterThan(orgIdx);
  });

  it("converges BYOS from the durable ref on mount, BEFORE the config-patch reload (no user-doc signal needed)", async () => {
    state.byosub = { restored: true, present: true }; 
    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    const restoreIdx = state.calls.indexOf("restoreByosubForAgent");
    const patchIdx = state.calls.indexOf("applyAddUserConfigPatch");

expect(restoreIdx).toBeGreaterThan(-1);
    expect(patchIdx).toBeGreaterThan(restoreIdx);
    expect(result.steps).toContain("byosub-restore");

expect(state.lastConfigPatchByosActive).toBe(true);
  });

it("re-mount over a healthy on-disk cred: byosActive stays true (no model clobber) but no byosub-restore step", async () => {
    state.byosub = { restored: false, present: true };
    const result = await addUserToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("restoreByosubForAgent");
    expect(state.lastConfigPatchByosActive).toBe(true);
    expect(result.steps).not.toContain("byosub-restore");
  });

  it("is a self-no-op for non-BYOS users (called, but no step, default model)", async () => {
    const result = await addUserToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("restoreByosubForAgent");
    expect(result.steps).not.toContain("byosub-restore");
    expect(state.lastConfigPatchByosActive).toBe(false);
  });

  it("first-time BYOT provision: forwards byot state with a COMPLETE runtime status (the agent is mounted by config-patch), so the non-anthropic key is written, not skipped/cleared", async () => {
    // status "" is the first-provision reality: loadAndPrepareForMount never advances the
    // in-memory snapshot, so forwarding snapshot.status would derive input=null and skip
    // writing this BYOK user's models.json. The reassert runs post-mount, so it must
    // tell deriveDesiredByotState the runtime is complete.
    state.user = snap({
      status: "",
      byotActive: true,
      systemConfig: { byot: { provider: "openai", model: "gpt-4o" } },
    });
    const result = await addUserToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("reassertByotForUser");
    expect(result.steps).toContain("byot-reassert");

    const ud = state.reassertByotUserData ?? {};
    expect(ud.username).toBe("test");
    expect(ud.byotActive).toBe(true);
    expect(ud.systemConfig).toEqual({ byot: { provider: "openai", model: "gpt-4o" } });
    expect(ud.provisioning).toEqual({
      openclaw: { status: "complete" },
    });
  });

  it("hands the snapshot's plan inputs to the reassert untouched so its configured plans survive the mount boundary", async () => {
    const claimedSeconds = Math.floor(Date.now() / 1000) - 2 * 86_400;
    const trialGrant = {
      schemaVersion: 3,
      offerId: "builder-signup",
      offerVersion: 1,
      personalTier: "personal",
      builderTier: "hobby",
      configHash: "config-a",
      claimedAt: { _seconds: claimedSeconds, _nanoseconds: 0 },
      endsAt: { _seconds: claimedSeconds + 7 * 86_400, _nanoseconds: 0 },
    };
    const planInputs = { tier: "personal_free", trialGrant };
    state.user = snap({
      planInputs,
      systemConfig: {
        agentModels: { "octogee-test-coach": { primary: "platform-openrouter/minimax/minimax-m3", fallbacks: [] } },
      },
    });
    await addUserToGateway(makeAdapter(state), "uid-test");

    const ud = state.reassertByotUserData ?? {};
    expect(ud.planInputs).toBe(planInputs);
  });

  it("puts no plan input at the top level of the reassert data", async () => {
    state.user = snap({
      planInputs: { tier: "personal_free", builderSubscription: { tier: "hobby", status: "active" } },
    });
    await addUserToGateway(makeAdapter(state), "uid-test");

    expect(Object.keys(state.reassertByotUserData ?? {}).sort()).toEqual([
      "builderAgentDefault",
      "byotActive",
      "freeTierModelRef",
      "planInputs",
      "provisioning",
      "systemConfig",
      "timeZone",
      "username",
    ]);
  });

  it("a byot re-assert failure is non-fatal — the mount still completes", async () => {
    state.reassertByotShouldFail = true;
    const result = await addUserToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("reassertByotForUser");
    expect(result.steps).not.toContain("byot-reassert");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("hands the same plan inputs to the context-file reassert as the byot reassert", async () => {
    const planInputs = { tier: "personal_free", builderSubscription: { tier: "hobby", status: "active" } };
    state.user = snap({ planInputs });
    await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).toContain("reassertConvergedContextFilesForUser");
    const ud = state.reassertContextFilesUserData ?? {};
    expect(ud.username).toBe("test");
    expect(ud.planInputs).toBe(planInputs);
    expect(state.reassertByotUserData?.planInputs).toBe(planInputs);
  });

  it("a context-file re-assert failure is non-fatal — the mount still completes", async () => {
    state.reassertContextFilesShouldFail = true;
    const result = await addUserToGateway(makeAdapter(state), "uid-test");
    expect(state.calls).toContain("reassertConvergedContextFilesForUser");
    expect(result.steps).not.toContain("context-files-reassert");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("a byot re-assert failure does not skip the context-file reassert (independent failure domains)", async () => {
    state.reassertByotShouldFail = true;
    const result = await addUserToGateway(makeAdapter(state), "uid-test");
    expect(result.steps).not.toContain("byot-reassert");
    expect(result.steps).toContain("context-files-reassert");
  });

  it("a context-file re-assert failure does not skip the byot reassert (independent failure domains)", async () => {
    state.reassertContextFilesShouldFail = true;
    const result = await addUserToGateway(makeAdapter(state), "uid-test");
    expect(result.steps).toContain("byot-reassert");
    expect(result.steps).not.toContain("context-files-reassert");
  });

  it("reports a first provisioning to the API once, as first", async () => {
    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.provisionedReports).toEqual([{ uid: "uid-test", slug: "test", first: true }]);
    expect(result.steps).toContain("report-provisioned");
  });

  it("logs a failed first report at error with its route, status and cause, and still completes the mount", async () => {
    state.reportFailure = new Error("fleet-broker /internal/fleet/provisioned → 404: not found");

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).not.toContain("report-provisioned");
    expect(result.steps).toContain("mark-complete");
    expect(state.errorLogs).toEqual([
      expect.stringMatching(/provisioned report failed for a first provisioning.*\/internal\/fleet\/provisioned → 404: not found/u),
    ]);
  });

  it("does not send a first report again after it failed: the next mount reports a re-mount", async () => {
    const adapter = makeAdapter(state);
    state.reportFailure = new Error("fleet-broker /internal/fleet/provisioned → 404: not found");
    await addUserToGateway(adapter, "uid-test");

    state.reportFailure = null;
    state.user = mountedSnapshot();
    state.disk = mountedDisk();
    await addUserToGateway(adapter, "uid-test");

    expect(state.provisionedReports).toEqual([{ uid: "uid-test", slug: "test", first: false }]);
  });

  it("sends no report when the mount stops before the report step", async () => {
    const adapter = makeAdapter(state);
    const stop = new AbortController();
    adapter.blobSyncForSlug = async () => {
      stop.abort(new Error("gateway is shutting down"));
    };

    await expect(addUserToGateway(adapter, "uid-test", { signal: stop.signal })).rejects.toThrow("gateway is shutting down");

    expect(state.calls).not.toContain("reportProvisioned");
  });

  it("writes provisioning.git.repoUrl IMMEDIATELY after the repo init succeeds", async () => {
    await addUserToGateway(makeAdapter(state), "uid-test");

    const initIdx = state.calls.indexOf("initWorkspaceRepoFromExistingDir");
    const writeIdx = state.calls.indexOf("write:provisioning.git.repoUrl");
    expect(initIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(initIdx);
    const between = state.calls.slice(initIdx + 1, writeIdx);
    expect(between).toEqual([]);
  });

  it("aborts loudly if the initial workspace repo creation fails", async () => {
    state.initShouldFail = true;
    await expect(addUserToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /initial workspace repo creation failed/,
    );
    expect(state.writes.find((w) => w.field === "provisioning.git.repoUrl")).toBeUndefined();
  });

  it("aborts loudly if the channel never reaches running+connected (no half-mounts)", async () => {
    state.healthy = false;
    await expect(addUserToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /didn't reach running\+connected/,
    );
    expect(state.calls).toContain("waitForAccountHealthy");
    
    expect(state.writes.find((w) => w.field === "provisioning.openclaw.status" && w.value === "complete")).toBeUndefined();
  });

});

describe("addUserToGateway — restore from Gitea (post pod loss)", () => {
  let state: MockState;
  beforeEach(() => {
    
    state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      emptyDisk(),
    );
  });

  it("clones the workspace from Gitea instead of reinitializing", async () => {
    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.newUser).toBe(false);
    expect(result.steps).toContain("clone-workspace-repo");
    expect(result.steps).not.toContain("init-workspace-repo");
  });

  it("ensures user workspace templates after the clone", async () => {
    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toContain("write-templates");
    expect(state.calls).toContain("writeUserTemplateFiles");
  });

  it("seeds workspace templates from the snapshot's context template key and names no plan in the template variables", async () => {
    state.user = snap({ ...state.user, contextTemplateKey: "seed-key-from-the-api" });

    await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.templateContext?.contextTemplateKey).toBe("seed-key-from-the-api");
    expect(Object.keys(state.templateContext?.templateVars ?? {}).sort()).toEqual([
      "createdAt",
      "ownerName",
      "slug",
      "timeZone",
      "uid",
      "username",
    ]);
  });

  it("does NOT re-provision Mattermost", async () => {
    await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).not.toContain("provisionMattermostUser");
  });

  it("reports the re-mount of a provisioned user as not first", async () => {
    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.provisionedReports).toEqual([{ uid: "uid-test", slug: "test", first: false }]);
    expect(result.steps).toContain("report-provisioned");
  });

  it("passes the snapshot's persona strings to the seed templates and no other persona value", async () => {
    state.user = snap({ ...state.user, persona: { style: "garage", zone: "Europe/Paris", weight: 3, nested: { a: "b" }, empty: null } });

    await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.templateContext?.templateVars).toMatchObject({ "persona.style": "garage", "persona.zone": "Europe/Paris" });
    expect(Object.keys(state.templateContext?.templateVars ?? {}).filter((key) => key.startsWith("persona.")).sort())
      .toEqual(["persona.style", "persona.zone"]);
  });

  it("aborts loudly on a clone failure (workspace data is at risk)", async () => {
    state.cloneShouldFail = true;
    await expect(addUserToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /workspace clone from .* failed/,
    );
  });

  it("removes a partial non-git user dir before cloning from Gitea", async () => {
    state.disk.customerDir = true;
    state.disk.workspaceGitDir = false;
    state.disk.gitRemote = false;

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toContain("clone-workspace-repo");
    expect(state.calls).toContain("removePartialWorkspace");
    expect(state.calls).not.toContain("deleteDepartedUserState");
    expect(state.calls.indexOf("removePartialWorkspace")).toBeLessThan(
      state.calls.indexOf("cloneWorkspaceRepo"),
    );
  });

  it("does NOT pre-create the user dir before the clone (would break git clone)", async () => {

await addUserToGateway(makeAdapter(state), "uid-test");

    const ensureIdx = state.calls.indexOf("ensureUserDirectories");
    const cloneIdx = state.calls.indexOf("cloneWorkspaceRepo");
    expect(cloneIdx).toBeGreaterThan(-1);

if (ensureIdx !== -1) {
      expect(ensureIdx).toBeGreaterThan(cloneIdx);
    }
  });

  it("still applies the config patch and verifies (the whole point of the restore)", async () => {
    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).toContain("applyAddUserConfigPatch");
    expect(state.calls).toContain("waitForAccountHealthy");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("returns the exact snapshot fingerprint applied by the successful config patch", async () => {
    state.configPatchFingerprint = "post-mattermost-fingerprint";

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.appliedFingerprint).toBe("post-mattermost-fingerprint");
  });

  it("passes publication custody and pending checkouts to the guarded adapter", async () => {
    const adapter = makeAdapter(state);
    const runtimePublication = { settled: Promise.resolve(), invalidateFingerprint: vi.fn() };
    const patch = adapter.applyAddUserConfigPatch;
    adapter.applyAddUserConfigPatch = async (...args) => {
      expect(args[2]?.runtimePublication).toBe(runtimePublication);
      const result = await patch(...args);
      return result;
    };

    await addUserToGateway(adapter, "uid-test", { runtimePublication });

    expect(state.lastConfigPatchOpts?.withoutProjectIds).toEqual([]);
  });

  it("refreshes the user snapshot before reasserting cohort model state", async () => {
    const adapter = makeAdapter(state);
    const applyAddUserConfigPatch = adapter.applyAddUserConfigPatch;
    adapter.applyAddUserConfigPatch = async (...args) => {
      const result = await applyAddUserConfigPatch(...args);
      state.user = snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      });
      return result;
    };

    await addUserToGateway(adapter, "uid-test");

    expect(state.reassertByotUserData?.provisioning).toEqual({
      openclaw: { status: "complete" },
    });
  });
});

describe("addUserToGateway — recovery from orphan dir (the bug class)", () => {
  it("creates the Gitea repo AND writes Firestore in the same step", async () => {

const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "",
        mattermostUserId: "mm-user-existing",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: false },
    );

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toContain("init-workspace-repo");
    const initIdx = state.calls.indexOf("initWorkspaceRepoFromExistingDir");
    const writeIdx = state.calls.indexOf("write:provisioning.git.repoUrl");
    expect(initIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(initIdx);
    expect(state.calls.slice(initIdx + 1, writeIdx)).toEqual([]);
  });

  it("aborts loudly if the recovery init fails (no silent Firestore drift)", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "",
        mattermostUserId: "mm-user-existing",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: false },
    );
    state.initShouldFail = true;

    await expect(addUserToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /recovery workspace repo creation failed/,
    );
    expect(state.writes.find((w) => w.field === "provisioning.git.repoUrl")).toBeUndefined();
  });
});

describe("addUserToGateway — empty-Gitea restore (mid-bootstrap pod loss)", () => {
  it("re-writes templates when the cloned repo has no working tree", async () => {

const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      emptyDisk(),
    );
    state.cloneSimulatesEmptyRepo = true;

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toContain("clone-workspace-repo");
    expect(result.steps).toContain("write-templates");

const cloneIdx = state.calls.indexOf("cloneWorkspaceRepo");
    const writeIdx = state.calls.indexOf("writeUserTemplateFiles");
    expect(writeIdx).toBeGreaterThan(cloneIdx);
  });

});

describe("addUserToGateway — configured user overlay", () => {
  function configuredProjectState(): MockState {
    const state = makeState(snap({
      status: "complete",
      agentIds: ["octogee-test-coach"],
      repoUrl: "http://gitea/octogee/test-workspace",
      mattermostUserId: "mm-user-existing",
      projectAgents: [{ projectId: "launchroom", enabled: true, mmUserId: "project-bot", token: "project-pat" }],
    }), {
      customerDir: true,
      workspaceGitDir: true,
      gitRemote: true,
      sshKey: true,
      templatesWritten: true,
      repoHasCommits: true,
    });
    state.giteaRegisteredPubKey = "ssh-pubkey";
    state.pendingProjects = [{ projectSlug: "launchroom", giteaRepoName: "launchroom" }];
    return state;
  }

  it.each([true, false])("reconciles configured project agents after checkout convergence (checkout lands: %s)", async (checkoutLands) => {
    const state = configuredProjectState();
    state.cloneProjectLands = checkoutLands;
    const adapter = makeAdapter(state);
    const runtimePublication = { settled: Promise.resolve(), invalidateFingerprint: vi.fn() };
    adapter.isIsolatedGateway = () => true;
    adapter.reconcileConfiguredUserProjectAgents = async (snapshot, opts) => {
      expect(snapshot).toBe(state.user);
      expect(state.calls).toContain("cloneProjectRepo");
      expect(opts?.withoutProjectIds).toEqual(checkoutLands ? [] : ["launchroom"]);
      expect(opts?.runtimePublication).toBe(runtimePublication);
      state.calls.push("reconcileConfiguredUserProjectAgents");
      return { elapsedMs: 10, appliedFingerprint: "project-activation" };
    };

    const result = await addUserToGateway(adapter, "uid-test", { convergeContent: true, runtimePublication });

    expect(state.calls).toContain("reconcileConfiguredUserProjectAgents");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
    expect(state.calls).not.toContain("writeUserTemplates");
    expect(state.provisionedReports).toEqual([]);
    expect(result.appliedFingerprint).toBe("project-activation");
    expect(result.steps).toContain("config-patch");
  });

  it("finishes a default-agent-wired user overlay attach while its Mattermost agent is still dormant", async () => {
    const state = configuredProjectState();
    state.healthy = false;
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true;
    adapter.reconcileConfiguredUserProjectAgents = async () => {
      state.calls.push("reconcileConfiguredUserProjectAgents");
      return { elapsedMs: 0, appliedFingerprint: "project-activation" };
    };
    adapter.materializeBrokerProfiles = async () => {
      throw new Error("Agent model profiles are not ready: octogee-test-coach");
    };

    const result = await addUserToGateway(adapter, "uid-test", { convergeContent: true });

    expect(state.calls).not.toContain("waitForAccountHealthy");
    expect(state.calls).toContain("onMounted");
    expect(result.steps).not.toContain("verify-channel-ready");
    expect(result.appliedFingerprint).toBe("project-activation");
  });

  it("does not mark a configured user mounted when project activation fails", async () => {
    const state = configuredProjectState();
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.reconcileConfiguredUserProjectAgents = async () => {
      throw new Error("project routing activation failed");
    };

    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow("project routing activation failed");
    expect(state.calls).not.toContain("onMounted");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
  });

  it.each([true, false])("defers project runtime reconciliation until OpenClaw starts (hook available: %s)", async (hasHook) => {
    const state = configuredProjectState();
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true;
    if (hasHook) {
      adapter.reconcileConfiguredUserProjectAgents = async () => {
        state.calls.push("reconcileConfiguredUserProjectAgents");
        return { elapsedMs: 0, appliedFingerprint: "must-not-be-applied-before-startup" };
      };
    }

    const result = await addUserToGateway(adapter, "uid-test", {
      convergeContent: true,
      deferRuntimeVerification: true,
    });

    expect(state.calls).toContain("cloneProjectRepo");
    expect(state.calls).not.toContain("reconcileConfiguredUserProjectAgents");
    expect(state.calls).not.toContain("waitForAccountHealthy");
    expect(result.appliedFingerprint).toBeUndefined();
    expect(result.steps).not.toContain("config-patch");
    expect(state.logs.some((line) => line.includes("project runtime reconciliation deferred until OpenClaw starts"))).toBe(true);
  });

  it("rejects a configured project snapshot when the adapter cannot reconcile its agents", async () => {
    const state = configuredProjectState();
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;

    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow("configured user project reconciliation is unavailable");
    expect(state.calls).not.toContain("onMounted");
  });

  it("converges project checkouts without replacing a mounted user overlay when its snapshot changed", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    state.pendingProjects = [
      { projectSlug: "launchroom", giteaRepoName: "launchroom" },
    ];
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true;
    adapter.userMountMarked = () => true;

    const result = await addUserToGateway(adapter, "uid-test", {
      convergeContent: true,
    });

    expect(result.steps).toContain("project-clone");
    expect(result.pendingProjectClones).toEqual([]);
    expect(state.calls).toContain("cloneProjectRepo");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
  });

  it("verifies the SSH key but skips unrelated convergence when the durable workspace is ready", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );

    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true; // openclaw.json has the agent
    state.giteaRegisteredPubKey = "ssh-pubkey";

    const result = await addUserToGateway(adapter, "uid-test");

    expect(result.newUser).toBe(false);
    expect(result.steps).toEqual([]);
    expect(state.calls).not.toContain("ensureOwner");
    expect(state.calls).not.toContain("registerKey");
    expect(state.calls).not.toContain("blobSyncForSlug");
    expect(state.calls).toContain("restoreByosubForAgent");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
    expect(state.calls).not.toContain("waitForAccountHealthy");
    // Fleet heartbeat MUST register this user as mounted, even on the
    // short-circuit path — Copilot review on PR #1182 caught a regression
    // here. Without it, fleet/heartbeat reports no mounted users.
    expect(state.calls).toContain("onMounted");
  });

  it("defers only runtime verification for a configured user overlay", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true;

    const result = await addUserToGateway(adapter, "uid-test", {
      deferRuntimeVerification: true,
    });

    expect(result.steps).not.toContain("verify-channel-ready");
    expect(state.calls).not.toContain("waitForAccountHealthy");
    expect(state.calls).toContain("onMounted");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
  });

  it("restores the subscription store for a configured user overlay before OpenClaw starts", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    state.byosub = { restored: true, present: true };
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true;

    const result = await addUserToGateway(adapter, "uid-test", {
      deferRuntimeVerification: true,
    });

    expect(state.calls).toContain("restoreByosubForAgent");
    expect(state.calls.indexOf("restoreByosubForAgent")).toBeLessThan(state.calls.indexOf("onMounted"));
    expect(result.steps).toContain("byosub-restore");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
  });

  it("recovers an unmarked configured user overlay without replacing its config during content convergence", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        agentRuntime: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true;
    adapter.userMountMarked = () => false;

    const result = await addUserToGateway(adapter, "uid-test", {
      convergeContent: true,
    });

    expect(result.steps).toEqual([]);
    expect(state.calls).toContain("onMounted");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
    expect(state.calls).not.toContain("removePartialWorkspace");
    expect(state.calls).not.toContain("cloneWorkspaceRepo");
  });

  it("keeps a marked user content converge overlay-safe", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        agentRuntime: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true;
    adapter.userMountMarked = () => true;
    state.pendingProjects = [{ projectSlug: "launchroom", giteaRepoName: "launchroom" }];
    state.cloneProjectLands = false;

    const result = await addUserToGateway(adapter, "uid-test", { convergeContent: true });

    expect(result.pendingProjectClones).toEqual(["launchroom"]);
    expect(state.calls).toContain("cloneProjectRepo");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
  });

  it("resyncs a drifted Gitea SSH key before the complete/wired fast path returns", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-stale-from-old-pod";
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true;

    const result = await addUserToGateway(adapter, "uid-test");

    expect(result.steps).toEqual(["ssh-key-resync"]);
    expect(state.giteaRegisteredPubKey).toBe("ssh-pubkey");
    expect(state.calls).toContain("registerKey");
    expect(state.calls).not.toContain("ensureOwner");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
  });

  it("does not short-circuit for a brand-new user (status='')", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;

    const result = await addUserToGateway(adapter, "uid-test");
    expect(result.newUser).toBe(true);
    expect(result.steps).toContain("ssh-key");
    expect(result.steps).toContain("mattermost-provision");
    expect(result.steps).toContain("config-patch");
  });

  it("rehydrates a missing workspace below a configured user overlay without rewriting that overlay", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      emptyDisk(),
    );
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true;

    const result = await addUserToGateway(adapter, "uid-test");

    expect(result.steps).toContain("ssh-key");
    expect(result.steps).toContain("clone-workspace-repo");
    expect(state.calls).toContain("cloneWorkspaceRepo");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
  });

  it("attaches a Discord-only user overlay without a canonical Mattermost agent", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      emptyDisk(), // fresh PVC — no SSH key, no workspace, nothing
    );
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => false;

    const result = await addUserToGateway(adapter, "uid-test");

    expect(state.calls).toContain("generateUserSshKey");
    expect(state.calls).toContain("registerKey");
    expect(state.calls).toContain("cloneWorkspaceRepo");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
    expect(state.calls).not.toContain("waitForAccountHealthy");
    expect(state.calls).toContain("onMounted");
    expect(result.pendingProjectClones).toEqual([]);
    expect(result.steps).toContain("clone-workspace-repo");
  });

  it("fails without rewriting when a complete user overlay is unavailable", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      emptyDisk(),
    );
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.configuredUserOverlayPresent = () => false;

    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow(
      /configured user system-config overlay is unavailable/u,
    );

    expect(state.calls).not.toContain("applyAddUserConfigPatch");
  });

  it("repairs the canonical Git metadata without deleting a default-agent-wired workspace", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: false,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: false,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true;

    const result = await addUserToGateway(adapter, "uid-test");

    expect(state.calls).toContain("cloneWorkspaceRepo");
    expect(state.calls).not.toContain("removePartialWorkspace");
    expect(state.calls).not.toContain("initWorkspaceRepoFromExistingDir");
    expect(state.disk.sshKey).toBe(true);
    expect(result.steps).toContain("clone-workspace-repo");
  });

  it("does not rewrite an already configured user overlay when the agent runtime dir is absent", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        agentRuntime: false,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => true;

    await addUserToGateway(adapter, "uid-test");

    expect(state.calls).not.toContain("applyAddUserConfigPatch");
    expect(state.calls).toContain("onMounted");
  });

  it("does not overwrite a complete user overlay when its platform agent wiring is absent", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;
    adapter.userDefaultAgentWiredInOpenclawConfig = () => false;
    state.giteaRegisteredPubKey = "ssh-pubkey";

    const result = await addUserToGateway(adapter, "uid-test");

    expect(state.calls).not.toContain("applyAddUserConfigPatch");
    expect(state.calls).not.toContain("waitForAccountHealthy");
    expect(result.pendingProjectClones).toEqual([]);
  });
});

describe("addUserToGateway — idempotent re-add", () => {
  it("is a near-no-op on a fully-mounted user (only patch + verify fire)", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user-existing",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.newUser).toBe(false);
    expect(result.steps).not.toContain("claim-slot");
    expect(result.steps).not.toContain("write-templates");
    expect(result.steps).not.toContain("clone-workspace-repo");
    expect(result.steps).not.toContain("init-workspace-repo");
    expect(result.steps).not.toContain("ssh-key");
    expect(result.steps).not.toContain("mattermost-provision");
    expect(state.provisionedReports).toEqual([{ uid: "uid-test", slug: "test", first: false }]);
    expect(result.steps).toContain("blob-sync");
    expect(result.steps).toContain("config-patch");
    expect(result.steps).toContain("verify-channel-ready");
  });
});

describe("addUserToGateway — partial-state scenarios", () => {
  it("FAILS LOUD when Gitea SSH key registration fails — and rolls back the local key", async () => {

const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      emptyDisk(),
    );
    state.giteaRegisterShouldFail = true;

    await expect(
      addUserToGateway(makeAdapter(state), "uid-test"),
    ).rejects.toThrow(/SSH key registration failed/);

    expect(state.calls).toContain("generateUserSshKey");
    expect(state.calls).toContain("registerKey");

expect(state.calls).toContain("giveUpUserGitKey");
    expect(state.disk.sshKey).toBe(false);
    
    expect(state.writes.find((w) => w.field === "system/config.gitea")).toBeUndefined();
  });

  it("rolls back local SSH key when Gitea registration appears to succeed but the key isn't actually persisted", async () => {

const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
      }),
      emptyDisk(),
    );

const adapter = makeAdapter(state);
    const orig = adapter.gitHost.registerKey;
    adapter.gitHost.registerKey = async (slug, pubKey) => {
      
      await orig(slug, pubKey);
      state.giteaRegisteredPubKey = null;
    };

    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow(
      /SSH key registration failed.*giteaPub=absent/,
    );
    expect(state.calls).toContain("giveUpUserGitKey");
    expect(state.disk.sshKey).toBe(false);
  });

  it("fails the mount with the registration error and says loudly that the key it could not give up stays", async () => {
    const state = makeState(snap({ status: "complete", repoUrl: "http://gitea/octogee/test-workspace", mattermostUserId: "mm-user" }), emptyDisk());
    state.giteaRegisterShouldFail = true;
    state.giteaReleaseShouldFail = true;

    await expect(addUserToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(/SSH key registration failed/);

    expect(state.disk.sshKey).toBe(true);
    expect(state.errorLogs).toContainEqual(expect.stringContaining("could not give up the key whose registration failed"));
  });

  it("self-heals stale Gitea-side key on existing-key path (the ceckert bug)", async () => {

const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    
    state.giteaRegisteredPubKey = "ssh-stale-from-old-pod";

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

expect(state.calls).toContain("registerKey");
    expect(result.steps).toContain("ssh-key-resync");
    
    expect(state.calls).not.toContain("generateUserSshKey");
    
    expect(state.giteaRegisteredPubKey).toBe("ssh-pubkey");
  });

  it("accepts the local key when an older rollout key is listed first", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKeys = ["ssh-stale-from-old-pod"];

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toContain("ssh-key-resync");
    expect(state.giteaRegisteredPubKeys).toEqual([
      "ssh-stale-from-old-pod",
      "ssh-pubkey",
    ]);
  });

  it("does not resync when the local key follows an older rollout key", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKeys = ["ssh-stale-from-old-pod", "ssh-pubkey"];

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).not.toContain("ssh-key-resync");
    expect(state.calls).not.toContain("registerKey");
  });

  it("does NOT resync when local + Gitea keys match (healthy state)", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    
    state.giteaRegisteredPubKey = "ssh-pubkey";

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.steps).not.toContain("ssh-key");
    expect(result.steps).not.toContain("ssh-key-resync");
    expect(state.calls).not.toContain("registerKey");
  });

  it("reclaims a matching existing Gitea key when a target mount requires ownership", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    const adapter = makeAdapter(state);
    adapter.isIsolatedGateway = () => true;

    const result = await addUserToGateway(adapter, "uid-test", {
      reclaimExistingSshKey: true,
    });

    expect(result.steps).toContain("ssh-key-resync");
    expect(state.calls).toContain("registerKey");
  });

  it("treats transient Gitea-read failure as ERROR, not as 'key absent' (no spurious resync)", async () => {

const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";
    state.giteaReadShouldThrow = true;

    await expect(
      addUserToGateway(makeAdapter(state), "uid-test"),
    ).rejects.toThrow(/Gitea key read failed/);
    
    expect(state.calls).not.toContain("registerKey");
  });

  it("clones project repos that have giteaRepoName but no on-disk clone", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
      },
    );
    state.pendingProjects = [
      { projectSlug: "p1", giteaRepoName: "test-p1" },
      { projectSlug: "p2", giteaRepoName: "test-p2" },
    ];

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    const cloneCalls = state.calls.filter((c) => c === "cloneProjectRepo");
    expect(cloneCalls).toHaveLength(2);
    expect(result.steps.filter((s) => s === "project-clone")).toHaveLength(2);
    expect(result.pendingProjectClones).toEqual([]);
  });

  it("clones a GitHub-backed project from its repoSource, not the Gitea mirror", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [
      { projectSlug: "gh", giteaRepoName: "test-gh", repoSource: GITHUB_REPO_SOURCE },
    ];

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls).toEqual([
      {
        projectSlug: "gh",
        giteaRepoName: "test-gh",
        opts: { repoSource: GITHUB_REPO_SOURCE },
      },
    ]);
    expect(result.steps).toContain("project-clone");
    expect(result.pendingProjectClones).toEqual([]);
  });

  it("does not pass a GitHub credential for a Gitea-only project", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];

    await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "camp", giteaRepoName: "test-camp", opts: undefined },
    ]);
  });

  it("delegates a GitHub-backed clone without exposing a credential to the lifecycle", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [
      { projectSlug: "gh", giteaRepoName: null, repoSource: GITHUB_REPO_SOURCE },
    ];

    await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "gh", giteaRepoName: null, opts: { repoSource: GITHUB_REPO_SOURCE } },
    ]);
  });

  it("clones a GitHub-backed project that never got a Gitea repo", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [
      { projectSlug: "gh", giteaRepoName: null, repoSource: GITHUB_REPO_SOURCE },
    ];

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "gh", giteaRepoName: null, opts: { repoSource: GITHUB_REPO_SOURCE } },
    ]);
    expect(result.steps).toContain("project-clone");
  });

  it("leaves a Gitea-backed project's clone free of repoSource options", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];

    await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "camp", giteaRepoName: "test-camp", opts: undefined },
    ]);
  });

  it("keeps a project with no checkout source pending and does not activate its agent", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.pendingProjects = [
      { projectSlug: "orphan", giteaRepoName: null },
      { projectSlug: "camp", giteaRepoName: "test-camp" },
    ];

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.cloneProjectCalls.map((c) => c.projectSlug)).toEqual(["camp"]);
    expect(result.pendingProjectClones).toEqual(["orphan"]);
    expect(state.configPatchWithoutProjectIds.at(-1)).toEqual(["orphan"]);
    expect(state.logs).toContainEqual(expect.stringContaining("test/orphan"));
    expect(state.logs.find((l) => l.includes("test/orphan"))).toMatch(
      /no Gitea repo and no GitHub repoSource/,
    );
  });

  it("never probes or clones project checkouts for a workspace-only mount", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
        projectCheckoutScope: "workspace-only",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).not.toContain("listProjectsNeedingClone");
    expect(state.calls).not.toContain("cloneProjectRepo");
    expect(result.pendingProjectClones).toEqual([]);
  });

  it("converges project checkouts before attaching the agent", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];

    await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.calls.indexOf("cloneProjectRepo")).toBeLessThan(
      state.calls.indexOf("applyAddUserConfigPatch"),
    );
  });

  it("includes a project agent in the single config patch after its checkout lands", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.pendingProjectClones).toEqual([]);
    expect(state.configPatchWithoutProjectIds).toEqual([[]]);
  });

  it("patches the config once when every project checkout is already on disk", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());

    await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.configPatchWithoutProjectIds).toEqual([[]]);
  });

  it("attaches the agent when an optional project checkout can never clone — a GitHub project on a shared gateway must not strand the user", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [
      { projectSlug: "octogee", giteaRepoName: null, repoSource: GITHUB_REPO_SOURCE },
    ];
    state.cloneProjectThrows = true;

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(state.calls).toContain("applyAddUserConfigPatch");
    expect(state.calls).toContain("waitForAccountHealthy");
    expect(result.pendingProjectClones).toEqual(["octogee"]);
    expect(state.configPatchWithoutProjectIds).toEqual([["octogee"]]);
  });

  it("surfaces a project whose clone did not land as pending — a swallowed failure must not read as converged", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];
    state.cloneProjectLands = false;

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.pendingProjectClones).toEqual(["camp"]);
    expect(state.configPatchWithoutProjectIds).toEqual([["camp"]]);
  });

  it("surfaces a clone that throws as pending, so the next reconcile retries instead of stranding the checkout", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true },
    );
    state.pendingProjects = [{ projectSlug: "camp", giteaRepoName: "test-camp" }];
    state.cloneProjectThrows = true;

    const result = await addUserToGateway(makeAdapter(state), "uid-test");

    expect(result.pendingProjectClones).toEqual(["camp"]);
    expect(state.configPatchWithoutProjectIds).toEqual([["camp"]]);
  });

  it("throws when verify times out — restores must NOT silently succeed on a broken mount", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        ...emptyDisk(),
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
      },
    );
    state.healthy = false;

    await expect(addUserToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /didn't reach running\+connected/,
    );

expect(state.calls).toContain("onMounted");
  });
});

describe("addUserToGateway — failure modes", () => {
  it("throws if the user doc does not exist", async () => {
    const state = makeState(null, emptyDisk());
    await expect(addUserToGateway(makeAdapter(state), "uid-missing")).rejects.toThrow(
      /user doc not found/,
    );
  });
});

describe("removeUserFromGateway", () => {
  it("removes the user from openclaw config + disk; persistent state untouched", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: true,
      },
    );

    const result = await removeUserFromGateway(makeAdapter(state), "uid-test");

    expect(result.wasMounted).toBe(true);
    expect(result.steps).toEqual(["config-patch-remove", "delete-dir", "release-gitea-key"]);
    expect(state.calls).toContain("applyRemoveUserConfigPatch");
    expect(state.calls).toContain("deleteDepartedUserState");
    expect(state.calls).not.toContain("removePartialWorkspace");
    expect(state.calls).toContain("onUnmounted");
    expect(state.writes).toEqual([]);
  });

  it("gives up this pod's git key once the user is gone", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());

    await removeUserFromGateway(makeAdapter(state), "uid-test");

    expect(state.calls.indexOf("giveUpUserGitKey")).toBeGreaterThan(state.calls.indexOf("deleteDepartedUserState"));
    expect(state.calls.filter((call) => call === "giveUpUserGitKey")).toHaveLength(1);
    expect(state.disk.sshKey).toBe(false);
  });

  it("keeps the local keypair, finishes the unmount and logs a failure when the key release fails", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    state.giteaReleaseShouldFail = true;

    const result = await removeUserFromGateway(makeAdapter(state), "uid-test");

    expect(result.steps).toEqual(["config-patch-remove", "delete-dir"]);
    expect(state.calls).toContain("onUnmounted");
    expect(state.disk.sshKey).toBe(true);
    expect(state.errorLogs).toContainEqual(expect.stringContaining("git key release failed"));
  });

  it("does not release a Gitea key when the eviction is cancelled", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    const adapter: UserLifecycleAdapter = {
      ...makeAdapter(state),
      applyRemoveUserConfigPatch: async () => {
        state.calls.push("applyRemoveUserConfigPatch");
        return ["test"];
      },
    };

    const result = await removeUserFromGateway(adapter, "uid-test", {
      evictionBatch: ["test"],
      currentEvictionBatch: async () => [],
    });

    expect(result.retained).toBe(true);
    expect(state.calls).not.toContain("giveUpUserGitKey");
    expect(state.disk.sshKey).toBe(true);
  });

  it("deletes a mounted user's departed state even when its workspace is already gone", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());

    const result = await removeUserFromGateway(makeAdapter(state), "uid-test");

    expect(result.wasMounted).toBe(true);
    expect(result.steps).toEqual(["config-patch-remove", "delete-dir"]);
    expect(state.calls).toContain("deleteDepartedUserState");
  });

  it("is a no-op when the user was never mounted", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());

    const result = await removeUserFromGateway(makeAdapter(state), "uid-test");

    expect(result.wasMounted).toBe(false);
    expect(result.steps).toEqual([]);
    expect(state.calls).not.toContain("applyRemoveUserConfigPatch");
    expect(state.calls).not.toContain("deleteDepartedUserState");
  });

  it("retains an admitted user overlay when a known user is evicted", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    const adapter: UserLifecycleAdapter = {
      ...makeAdapter(state),
      isIsolatedGateway: () => true,
      isConfiguredUser: () => true,
      configuredUserOverlayPresent: () => true,
      clearMountMarker: () => state.calls.push("clearMountMarker"),
      clearUserMigratingIn: () => state.calls.push("clearUserMigratingIn"),
    };

    const result = await removeUserFromGateway(adapter, "uid-test");

    expect(result).toEqual({ wasMounted: true, steps: [], retained: true });
    expect(state.calls).toContain("clearMountMarker");
    expect(state.calls).toContain("clearUserMigratingIn");
    expect(state.calls).toContain("onUnmounted");
    expect(state.calls).not.toContain("applyRemoveUserConfigPatch");
    expect(state.calls).not.toContain("deleteDepartedUserState");
  });

  it("fails closed for the configured user when its overlay is unavailable", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    const adapter: UserLifecycleAdapter = {
      ...makeAdapter(state),
      isIsolatedGateway: () => true,
      isConfiguredUser: () => true,
      configuredUserOverlayPresent: () => false,
      clearMountMarker: () => state.calls.push("clearMountMarker"),
      clearUserMigratingIn: () => state.calls.push("clearUserMigratingIn"),
    };

    await expect(removeUserFromGateway(adapter, "uid-test")).rejects.toThrow(
      /configured user system-config overlay is unavailable/,
    );

    expect(state.calls).not.toContain("applyRemoveUserConfigPatch");
    expect(state.calls).not.toContain("deleteDepartedUserState");
    expect(state.calls).not.toContain("clearMountMarker");
    expect(state.calls).not.toContain("clearUserMigratingIn");
    expect(state.calls).not.toContain("onUnmounted");
  });
});

describe("unmount + re-add round trip", () => {
  it("re-add after remove follows the clone branch (Firestore state preserved)", async () => {
    const state = makeState(
      snap({
        status: "complete",
        agentIds: ["octogee-test-coach"],
        repoUrl: "http://gitea/octogee/test-workspace",
        mattermostUserId: "mm-user",
      }),
      {
        customerDir: true,
        workspaceGitDir: true,
        gitRemote: true,
        sshKey: true,
        repoHasCommits: true,
        templatesWritten: true,
      },
    );
    const adapter = makeAdapter(state);

    await removeUserFromGateway(adapter, "uid-test");
    state.calls = [];
    state.writes = [];

    const reAdd = await addUserToGateway(adapter, "uid-test");

    expect(reAdd.steps).toContain("clone-workspace-repo");
    expect(reAdd.steps).not.toContain("init-workspace-repo");
    expect(reAdd.steps).not.toContain("mattermost-provision");
    expect(state.provisionedReports).toEqual([{ uid: "uid-test", slug: "test", first: false }]);
  });
});

describe("addUserToGateway — same-uid in-flight dedup", () => {
  beforeEach(() => {
    _resetInFlightUidsForTests();
  });

  it("throws ConcurrentMountError when a second mount is started for the same uid mid-flight", async () => {

const state = makeState(snap({ status: "" }), emptyDisk());
    const realAdapter = makeAdapter(state);

    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((r) => { releaseFirst = r; });

    const dedupAdapter: UserLifecycleAdapter = {
      ...realAdapter,
      loadUserSnapshot: async (uid) => {
        await firstReleased;
        return realAdapter.loadUserSnapshot(uid);
      },
    };

    const firstRun = addUserToGateway(dedupAdapter, "uid-test");

await Promise.resolve();
    await Promise.resolve();

await expect(addUserToGateway(dedupAdapter, "uid-test")).rejects.toBeInstanceOf(
      ConcurrentMountError,
    );

releaseFirst();
    const result = await firstRun;
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("clears the in-flight uid on success so a follow-up mount works", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    await addUserToGateway(makeAdapter(state), "uid-test");

    const state2 = makeState(snap({ status: "complete", agentIds: ["octogee-test-coach"], repoUrl: "http://gitea/octogee/test-workspace", mattermostUserId: "mm-x" }), { ...emptyDisk(), customerDir: true, workspaceGitDir: true, gitRemote: true, sshKey: true, repoHasCommits: true });
    const result = await addUserToGateway(makeAdapter(state2), "uid-test");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("reports a deadline-raced user workspace clone only after its post-deadline tree mutation settles", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
      }),
      emptyDisk(),
    );
    const realAdapter = makeAdapter(state);
    realAdapter.isIsolatedGateway = () => true;
    let cloneStarted!: () => void;
    const cloneStartedPromise = new Promise<void>((resolve) => {
      cloneStarted = resolve;
    });
    let releaseClone!: () => void;
    const clone = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    const hangingAdapter: UserLifecycleAdapter = {
      ...realAdapter,
      cloneWorkspaceRepo: async (slug, repoUrl) => {
        cloneStarted();
        await clone;
        return realAdapter.cloneWorkspaceRepo(slug, repoUrl);
      },
    };
    let workSettled: Promise<void> | undefined;

    const mounting = addUserToGateway(hangingAdapter, "uid-test", {
        mountDeadlineMs: 25,
        onWorkSettled: (settled) => {
          workSettled = settled;
        },
      });
    await cloneStartedPromise;

    await expect(mounting).rejects.toThrow(/mountDeadlineMs.*25ms.*exceeded/i);

    let callbackSettled = false;
    void workSettled?.then(() => {
      callbackSettled = true;
    });
    await Promise.resolve();
    expect(workSettled).toBeDefined();
    expect(callbackSettled).toBe(false);
    expect(_inFlightUidsHasForTests("uid-test")).toBe(true);

    const state2 = makeState(snap({ status: "" }), emptyDisk());
    await expect(addUserToGateway(makeAdapter(state2), "uid-test")).rejects.toBeInstanceOf(ConcurrentMountError);

    releaseClone();
    await workSettled;
    expect(callbackSettled).toBe(true);
    expect(state.calls).toContain("cloneWorkspaceRepo");
    expect(state.calls).toContain("ensureUserDirectories");
    expect(state.calls).toContain("writeUserTemplateFiles");
    expect(_inFlightUidsHasForTests("uid-test")).toBe(false);
    const retry = await addUserToGateway(makeAdapter(state2), "uid-test");
    expect(retry.steps).toContain("verify-channel-ready");
  });

  it("names the hung step in the deadline error", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    const hangingAdapter: UserLifecycleAdapter = {
      ...realAdapter,
      gitHost: { ...realAdapter.gitHost, listKeys: () => new Promise(() => {}) },
    };

    await expect(
      addUserToGateway(hangingAdapter, "uid-test", { mountDeadlineMs: 25 }),
    ).rejects.toThrow(/step "ssh-key" is hung/);
  });

  it("names load-snapshot as the hung step when the snapshot fetch never returns", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    const hangingAdapter: UserLifecycleAdapter = {
      ...realAdapter,
      loadUserSnapshot: () => new Promise(() => {}),
    };

    await expect(
      addUserToGateway(hangingAdapter, "uid-test", { mountDeadlineMs: 25 }),
    ).rejects.toThrow(/step "load-snapshot" is hung/);
  });

  it("stops the inner pipeline at the next checkpoint after mountDeadlineMs trips", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    let blobSyncCalled = false;
    const slowAdapter: UserLifecycleAdapter = {
      ...realAdapter,
      loadUserSnapshot: async (uid: string) => {
        await new Promise<void>((r) => setTimeout(r, 80));
        return realAdapter.loadUserSnapshot(uid);
      },
      blobSyncForSlug: async (slug: string) => {
        blobSyncCalled = true;
        return realAdapter.blobSyncForSlug(slug);
      },
    };

    await expect(
      addUserToGateway(slowAdapter, "uid-test", { mountDeadlineMs: 25 }),
    ).rejects.toThrow(/mountDeadlineMs.*25ms.*exceeded/i);

    await new Promise<void>((r) => setTimeout(r, 120));
    expect(blobSyncCalled).toBe(false);
  });

  it("aborts an external AbortSignal observer so callers can react to the deadline trip", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    const slowAdapter: UserLifecycleAdapter = {
      ...realAdapter,
      loadUserSnapshot: async () => new Promise(() => {}),
    };

    let externalSignalAborted = false;
    const aborter = await addUserToGateway(slowAdapter, "uid-test", {
      mountDeadlineMs: 25,
      onSignalCreated: (signal) => {
        signal.addEventListener("abort", () => {
          externalSignalAborted = true;
        });
      },
    }).catch((e) => e);
    expect(String(aborter)).toMatch(/mountDeadlineMs/);
    expect(externalSignalAborted).toBe(true);
  });

  it("clears the in-flight uid on failure so the fleet can retry", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    state.healthy = false;

    await expect(addUserToGateway(makeAdapter(state), "uid-test")).rejects.toThrow(
      /didn't reach running\+connected/,
    );

    const state2 = makeState(snap({ status: "" }), emptyDisk());
    const result = await addUserToGateway(makeAdapter(state2), "uid-test");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("isolates uids — different uids run concurrently without dedup interference", async () => {
    const stateA = makeState(snap({ uid: "uid-a", slug: "alice" }), emptyDisk());
    const stateB = makeState(snap({ uid: "uid-b", slug: "bob" }), emptyDisk());

    const [resA, resB] = await Promise.all([
      addUserToGateway(makeAdapter(stateA), "uid-a"),
      addUserToGateway(makeAdapter(stateB), "uid-b"),
    ]);
    expect(resA.steps).toContain("verify-channel-ready");
    expect(resB.steps).toContain("verify-channel-ready");
  });
});

describe("restoreUserRuntimeFromSnapshot — blob backfill stays out of the migration-critical path", () => {
  beforeEach(() => {
    _resetInFlightUidsForTests();
  });

  it("keeps the restored gateway's SSH key registered after the previous owner unmounts", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    state.disk.sshKey = true;
    state.giteaRegisteredPubKey = "ssh-pubkey";
    let keyOwner = "native";
    const adapter = makeAdapter(state);
    adapter.gitHost.registerKey = async () => { keyOwner = "shared"; };

    await restoreUserRuntimeFromSnapshot(adapter, state.user!);
    if (keyOwner === "native") state.giteaRegisteredPubKey = null;

    expect(keyOwner).toBe("shared");
    expect(await adapter.gitHost.listKeys("test")).toEqual(["ssh-pubkey"]);
  });

  it("shares one preparation deadline and request signal across snapshot project refreshes", async () => {
    const state = makeState(snap({ status: "complete", projects: [
      { projectSlug: "first", giteaRepoName: "first" },
      { projectSlug: "second", giteaRepoName: "second" },
    ] }), emptyDisk());
    const adapter = makeAdapter(state);
    const controller = new AbortController();
    await cloneProjectsFromSnapshot(adapter, state.user!, { signal: controller.signal });
    const [first, second] = state.cloneProjectCalls;
    expect(first.opts?.refreshLeaseDeadlineMs).toEqual(expect.any(Number));
    expect(second.opts?.refreshLeaseDeadlineMs).toBe(first.opts?.refreshLeaseDeadlineMs);
    expect(first.opts?.signal).toBe(controller.signal);
    expect(second.opts?.signal).toBe(controller.signal);
  });

  it("does not start the next snapshot project after its owning request aborts", async () => {
    const state = makeState(snap({ status: "complete", projects: [
      { projectSlug: "first", giteaRepoName: "first" },
      { projectSlug: "second", giteaRepoName: "second" },
    ] }), emptyDisk());
    const adapter = makeAdapter(state);
    const controller = new AbortController();
    const clone = vi.fn(async () => {
      controller.abort(new Error("finish import cancelled"));
      return false;
    });
    adapter.cloneProjectRepo = clone;
    await expect(cloneProjectsFromSnapshot(adapter, state.user!, { signal: controller.signal }))
      .rejects.toThrow("finish import cancelled");
    expect(clone).toHaveBeenCalledOnce();
  });

  it("requires Gitea project checkouts to refresh during runtime restoration", async () => {
    const state = makeState(snap({
      status: "complete",
      projects: [{ projectSlug: "proofproj", giteaRepoName: "proofproj" }],
    }), emptyDisk());
    const adapter = makeAdapter(state);
    const clone = vi.fn(adapter.cloneProjectRepo);
    adapter.cloneProjectRepo = clone;

    await restoreUserRuntimeFromSnapshot(adapter, state.user!);

    expect(clone).toHaveBeenCalledWith(state.user!.slug, "proofproj", "proofproj", expect.objectContaining({ refreshRemote: true }));
  });

  it("does not publish a restored mount when an active project runtime is missing", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    const adapter = makeAdapter(state);
    adapter.projectAgentsHealthy = async () => false;
    adapter.writeMountMarker = () => { throw new Error("must not mark an incomplete restore"); };
    await expect(restoreUserRuntimeFromSnapshot(adapter, state.user!)).rejects.toThrow("project agents are not connected");
  });

  it("verifies only project agents admitted after checkout restoration", async () => {
    const state = makeState(snap({
      status: "complete",
      projects: [{ projectSlug: "pending", giteaRepoName: "test-pending" }],
      projectAgents: [
        { projectId: "pending", enabled: true, mmUserId: "pending-bot", token: "pending-pat", status: "ready" },
        { projectId: "ready", enabled: true, mmUserId: "ready-bot", token: "ready-pat", status: "ready" },
      ],
    }), emptyDisk());
    state.cloneProjectLands = false;
    const adapter = makeAdapter(state);
    const verified: UserSnapshot[] = [];
    adapter.projectAgentsHealthy = async (snapshot) => {
      verified.push(snapshot);
      return !snapshot.projectAgents?.some((agent) => agent.projectId === "pending");
    };
    const result = await restoreUserRuntimeFromSnapshot(adapter, state.user!);
    expect(result.restored).toBe(true);
    expect(state.configPatchWithoutProjectIds).toEqual([["pending"]]);
    expect(verified[0].projectAgents?.map((agent) => agent.projectId)).toEqual(["ready"]);
  });

  it("does not publish a restored mount after cancellation during project verification", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    const adapter = makeAdapter(state);
    const controller = new AbortController();
    adapter.projectAgentsHealthy = async () => {
      controller.abort(new Error("restore cancelled"));
      return true;
    };
    let marked = false;
    adapter.writeMountMarker = () => { marked = true; };
    await expect(restoreUserRuntimeFromSnapshot(adapter, state.user!, { signal: controller.signal })).rejects.toThrow("restore cancelled");
    expect(marked).toBe(false);
  });

  it("returns the applied fingerprint and pending checkouts so the caller can record convergence", async () => {
    const state = makeState(snap({
      status: "complete",
      projects: [{ projectSlug: "pending", giteaRepoName: "test-pending" }],
      projectAgents: [
        { projectId: "pending", enabled: true, mmUserId: "pending-bot", token: "pending-pat", status: "ready" },
      ],
    }), emptyDisk());
    state.configPatchFingerprint = "restored-fingerprint";
    state.cloneProjectLands = false;
    const adapter = makeAdapter(state);
    adapter.projectAgentsHealthy = async (snapshot) =>
      !snapshot.projectAgents?.some((agent) => agent.projectId === "pending");

    const result = await restoreUserRuntimeFromSnapshot(adapter, state.user!);

    expect(result.appliedFingerprint).toBe("restored-fingerprint");
    expect(result.pendingProjectClones).toEqual(["pending"]);
  });

  it("reports converged state only when every re-assert completed", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    state.configPatchFingerprint = "restored-fingerprint";

    const converged = await restoreUserRuntimeFromSnapshot(makeAdapter(state), state.user!);
    expect(converged.convergedState).toBe(true);

    _resetInFlightUidsForTests();
    state.reassertByotShouldFail = true;
    const incomplete = await restoreUserRuntimeFromSnapshot(makeAdapter(state), state.user!);
    expect(incomplete.restored).toBe(true);
    expect(incomplete.convergedState).toBe(false);
  });

  it("stamps the mount marker once the restored runtime is verified", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    const marked: string[] = [];
    const adapter = makeAdapter(state);
    adapter.writeMountMarker = (slug) => { marked.push(slug); };

    const result = await restoreUserRuntimeFromSnapshot(adapter, state.user!);

    expect(result.restored).toBe(true);
    expect(marked).toEqual(["test"]);
  });

  it("does not call blobSyncForSlug during restore — the source rsync + the post-online loop own blob backfill", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());

    const result = await restoreUserRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.calls).not.toContain("blobSyncForSlug");
    expect(result.steps).not.toContain("blob-sync");
    expect(result.steps).toContain("verify-channel-ready");
  });

  it("restores only the workspace when the target checkout scope is workspace-only", async () => {
    const state = makeState(
      snap({
        status: "complete",
        projectCheckoutScope: undefined,
        projects: [
          { projectSlug: "camp", giteaRepoName: "test-camp", provisioningState: "active" },
        ],
      }),
      emptyDisk(),
    );
    const adapter = makeAdapter(state);
    adapter.projectCheckoutScope = () => "workspace-only";

    await restoreUserRuntimeFromSnapshot(adapter, state.user!);

    expect(state.calls).not.toContain("cloneProjectRepo");
  });

  it("restores isolated project checkouts before establishing the agent", async () => {
    const state = makeState(
      snap({
        status: "complete",
        projects: [
          { projectSlug: "camp", giteaRepoName: "test-camp", provisioningState: "active" },
        ],
      }),
      emptyDisk(),
    );

    await restoreUserRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.calls.indexOf("cloneProjectRepo")).toBeLessThan(
      state.calls.indexOf("applyAddUserConfigPatch"),
    );
  });

  it("restores a GitHub-backed project from its repoSource even with no Gitea repo", async () => {
    const state = makeState(
      snap({
        status: "complete",
        projects: [
          {
            projectSlug: "gh",
            giteaRepoName: null,
            repoSource: GITHUB_REPO_SOURCE,
            provisioningState: "active",
          },
          { projectSlug: "camp", giteaRepoName: "test-camp", provisioningState: "active" },
        ],
      }),
      emptyDisk(),
    );

    const result = await restoreUserRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "gh", giteaRepoName: null, opts: { repoSource: GITHUB_REPO_SOURCE } },
      { projectSlug: "camp", giteaRepoName: "test-camp", opts: expect.objectContaining({ refreshRemote: true }) },
    ]);
    expect(result.steps.filter((s) => s === "project-clone")).toHaveLength(2);
  });

  it("skips a restored project whose owner turned the checkout off, and clones the rest", async () => {
    const state = makeState(
      snap({
        status: "complete",
        projects: [
          {
            projectSlug: "gh",
            giteaRepoName: null,
            repoSource: GITHUB_REPO_SOURCE,
            provisioningState: "active",
            checkoutEnabled: false,
          },
          { projectSlug: "camp", giteaRepoName: "test-camp", provisioningState: "active" },
        ],
      }),
      emptyDisk(),
    );

    await restoreUserRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.cloneProjectCalls).toEqual([
      { projectSlug: "camp", giteaRepoName: "test-camp", opts: expect.objectContaining({ refreshRemote: true }) },
    ]);
    expect(state.logs.find((l) => l.includes("test/gh"))).toMatch(/turned off by its owner/);
  });

  it("skips a restored project with neither checkout source, and says so", async () => {
    const state = makeState(
      snap({
        status: "complete",
        projects: [{ projectSlug: "orphan", giteaRepoName: null, provisioningState: "active" }],
      }),
      emptyDisk(),
    );

    await restoreUserRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.cloneProjectCalls).toEqual([]);
    expect(state.logs.find((l) => l.includes("test/orphan"))).toMatch(
      /no Gitea repo and no GitHub repoSource/,
    );
  });

  it("repairs imported Git metadata without deleting the imported workspace", async () => {
    const state = makeState(
      snap({
        status: "complete",
        repoUrl: "http://gitea/octogee/test-workspace",
      }),
      {
        customerDir: true,
        agentRuntime: true,
        workspaceGitDir: true,
        gitRemote: false,
        sshKey: true,
        templatesWritten: true,
        repoHasCommits: false,
      },
    );
    state.giteaRegisteredPubKey = "ssh-pubkey";

    const result = await restoreUserRuntimeFromSnapshot(
      makeAdapter(state),
      state.user!,
    );

    expect(state.calls).toContain("cloneWorkspaceRepo");
    expect(state.calls).not.toContain("removePartialWorkspace");
    expect(result.steps).toContain("clone-workspace-repo");
  });

  it("reports a restored user as provisioned and not first, after the runtime is verified", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());

    const result = await restoreUserRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(state.provisionedReports).toEqual([{ uid: state.user!.uid, slug: state.user!.slug, first: false }]);
    expect(result.steps).toContain("report-provisioned");
    expect(state.calls.indexOf("reportProvisioned")).toBeGreaterThan(state.calls.indexOf("waitForAccountHealthy"));
  });

  it("logs a failed restore report at error with its cause and still completes the restore", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    state.reportFailure = new Error("fleet-broker /internal/fleet/provisioned → 404");

    const result = await restoreUserRuntimeFromSnapshot(makeAdapter(state), state.user!);

    expect(result.restored).toBe(true);
    expect(result.steps).not.toContain("report-provisioned");
    expect(state.errorLogs).toEqual([expect.stringMatching(/provisioned report failed for a re-mount.*→ 404/u)]);
  });

  it("does not report a restore whose runtime never became ready", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    state.healthy = false;

    await expect(restoreUserRuntimeFromSnapshot(makeAdapter(state), state.user!)).rejects.toThrow(/running\+connected/);

    expect(state.provisionedReports).toEqual([]);
  });
});

describe("restoreUserRuntimeFromSnapshot — same-uid in-flight dedup", () => {
  beforeEach(() => {
    _resetInFlightUidsForTests();
  });

  it("retains restore exclusivity against both restore and reconcile until late work settles", async () => {
    const state = makeState(snap({ status: "complete" }), emptyDisk());
    const realAdapter = makeAdapter(state);
    let releaseRead!: () => void;
    const read = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const hangingAdapter: UserLifecycleAdapter = {
      ...realAdapter,
      hasUserSshKey: () => true,
      readLocalUserPubKey: () => "ssh-pubkey",
      gitHost: {
        ...realAdapter.gitHost,
        listKeys: async () => {
          await read;
          return ["ssh-pubkey"];
        },
      },
    };
    let workSettled: Promise<void> | undefined;

    await expect(
      restoreUserRuntimeFromSnapshot(hangingAdapter, state.user!, {
        mountDeadlineMs: 25,
        onWorkSettled: (settled) => {
          workSettled = settled;
        },
      }),
    ).rejects.toThrow(/mountDeadlineMs.*25ms.*exceeded/i);

    expect(_inFlightUidsHasForTests("uid-test")).toBe(true);
    const state2 = makeState(snap({ status: "complete" }), emptyDisk());
    await expect(addUserToGateway(makeAdapter(state2), "uid-test")).rejects.toBeInstanceOf(ConcurrentMountError);
    await expect(restoreUserRuntimeFromSnapshot(makeAdapter(state2), state2.user!)).rejects.toBeInstanceOf(ConcurrentMountError);
    releaseRead();
    await workSettled;
    expect(_inFlightUidsHasForTests("uid-test")).toBe(false);

    const retry = await restoreUserRuntimeFromSnapshot(makeAdapter(state2), state2.user!);
    expect(retry.steps).toContain("verify-channel-ready");
  });
});

describe("pubKeysMatch", () => {

it("matches identical keys", () => {
    const k = "ssh-ed25519 AAAAC3Nz...etc octogee-chris@gateway";
    expect(pubKeysMatch(k, k)).toBe(true);
  });

  it("matches same type + key bytes with different comments", () => {
    const a = "ssh-ed25519 AAAAC3Nz...etc octogee-chris@gateway";
    const b = "ssh-ed25519 AAAAC3Nz...etc anything-else";
    expect(pubKeysMatch(a, b)).toBe(true);
  });

  it("matches when one side has trailing whitespace", () => {
    const a = "ssh-ed25519 AAAAC3Nz...etc octogee-chris@gateway\n";
    const b = "ssh-ed25519 AAAAC3Nz...etc octogee-chris@gateway";
    expect(pubKeysMatch(a, b)).toBe(true);
  });

  it("rejects different key bytes (the drift case)", () => {
    const a = "ssh-ed25519 AAAAC3Nz...stale octogee-chris@gateway";
    const b = "ssh-ed25519 AAAAC3Nz...fresh octogee-chris@gateway";
    expect(pubKeysMatch(a, b)).toBe(false);
  });

  it("rejects different key types", () => {
    const a = "ssh-ed25519 AAAAC3Nz...";
    const b = "ssh-rsa     AAAAB3Nz...";
    expect(pubKeysMatch(a, b)).toBe(false);
  });
});

describe("addUserToGateway — org-ensure precedes EVERY repo-touching path (the #963 incomplete-rollout class)", () => {

const ADAPTER_REPO_TOUCHING: Record<keyof UserLifecycleAdapter, boolean> = {
    cloneWorkspaceRepo: true,
    initWorkspaceRepoFromExistingDir: true,
    cloneProjectRepo: true,
    log: false,
    provisioningService: false,
    loadUserSnapshot: false,
    setProvisioningStatus: false,
    provisionDefaultAgentAutomation: false,
    setRepoUrl: false,
    setMattermostFields: false,
    ensureAgentIds: false,
    hasUserDir: false,
    hasWorkspaceGitDir: false,
    hasGitRemote: false,
    ensureUserDirectories: false,
    writeUserTemplateFiles: false,
    removePartialWorkspace: false,
    deleteDepartedUserState: false,
    hasUserSshKey: false,
    generateUserSshKey: false,
    gitHost: false,
    readLocalUserPubKey: false,
    giveUpUserGitKey: false,
    blobSyncForSlug: false,
    restoreByosubForAgent: false,
    listProjectsNeedingClone: false,
    provisionMattermostUser: false,
    applyAddUserConfigPatch: false,
    applyRemoveUserConfigPatch: false,
    waitForAccountHealthy: false,
    projectAgentsHealthy: false,
    reportProvisioned: false,
    onMounted: false,
    onUnmounted: false,
    uidForSlug: false,
    quiesceUser: false,
    listExportPaths: false,
    prepareImportDir: false,
    prepareKeyImportDir: false,
    activateImportedUser: false,
    recordAppliedFingerprint: false,
    isIsolatedGateway: false,
    isConfiguredUser: false,
    configuredUserOverlayPresent: false,
    materializeBrokerProfiles: false,
    userDefaultAgentWiredInOpenclawConfig: false,
    hasUserAgentRuntime: false,
    projectCheckoutScope: false,
    listLocalUserSlugs: false,
    listLocalUserDirs: false,
    userMountMarked: false,
    writeMountMarker: false,
    userMigratingIn: false,
    markUserMigratingIn: false,
    clearUserMigratingIn: false,
    listMigratingInSlugs: false,
    seedUserSnapshotForMigration: false,
    reassertByotForUser: false,
    reassertConvergedContextFilesForUser: false,
    seedDeferredProjectWorkspace: false,
    reconcileConfiguredUserProjectAgents: false,
    cancelPendingEviction: false,
    clearMountMarker: false,
    userContextRestoreHeld: false,
    schedulerMigration: false,
    schedulerReady: false,
    resumeUser: false,
    sourceMigrationIdentityCustody: false,
    sourceMigrationAgentAnchors: false,
    targetMigrationIdentityCustody: false,
    exportOpenClawActivationManifest: false,
    removeImportedUserBySlug: false,
    releaseAgent: false,
  };

  const REPO_TOUCHING = (
    Object.keys(ADAPTER_REPO_TOUCHING) as Array<keyof UserLifecycleAdapter>
  ).filter((k) => ADAPTER_REPO_TOUCHING[k]);

  it("classifies exactly the clone/init workspace+project methods as repo-touching", () => {
    expect([...REPO_TOUCHING].sort()).toEqual(
      [
        "cloneProjectRepo",
        "cloneWorkspaceRepo",
        "initWorkspaceRepoFromExistingDir",
      ].sort(),
    );
  });

  const mounted = (over: Partial<UserSnapshot> = {}) =>
    snap({
      status: "complete",
      agentIds: ["octogee-test-coach"],
      repoUrl: "http://gitea/octogee/test-workspace",
      mattermostUserId: "mm-user",
      ...over,
    });

  const scenarios: Array<{
    name: string;
    state: () => MockState;
    expectRepoTouch: boolean;
  }> = [
    {
      name: "first-time provision (init-workspace)",
      state: () => makeState(snap({ status: "" }), emptyDisk()),
      expectRepoTouch: true,
    },
    {
      name: "restore from Gitea (clone-workspace)",
      state: () => makeState(mounted(), emptyDisk()),
      expectRepoTouch: true,
    },
    {
      name: "empty-Gitea restore (clone then template re-apply)",
      state: () => {
        const s = makeState(mounted(), emptyDisk());
        s.cloneSimulatesEmptyRepo = true;
        return s;
      },
      expectRepoTouch: true,
    },
    {
      name: "recovery from orphan dir (recovery init-workspace)",
      state: () =>
        makeState(mounted({ repoUrl: "" }), {
          ...emptyDisk(),
          customerDir: true,
          workspaceGitDir: true,
          gitRemote: false,
        }),
      expectRepoTouch: true,
    },
    {
      name: "pending project clone (workspace already healthy)",
      state: () => {
        const s = makeState(mounted(), {
          ...emptyDisk(),
          customerDir: true,
          workspaceGitDir: true,
          gitRemote: true,
          sshKey: true,
          repoHasCommits: true,
        });
        s.giteaRegisteredPubKey = "ssh-pubkey";
        s.pendingProjects = [{ projectSlug: "p1", giteaRepoName: "test-p1" }];
        return s;
      },
      expectRepoTouch: true,
    },
    {
      name: "idempotent re-add (no repo touch — org still ensured)",
      state: () =>
        makeState(mounted(), {
          customerDir: true,
          workspaceGitDir: true,
          gitRemote: true,
          sshKey: true,
          templatesWritten: true,
          repoHasCommits: true,
        }),
      expectRepoTouch: false,
    },
  ];

  it.each(scenarios)("$name", async ({ state, expectRepoTouch }) => {
    const st = state();

    if (st.giteaRegisteredPubKey === null) st.giteaRegisteredPubKey = "ssh-pubkey";
    await addUserToGateway(makeAdapter(st), "uid-test");

    const orgIdx = st.calls.indexOf("ensureOwner");

expect(orgIdx).toBeGreaterThan(-1);

    const repoTouchIdxs = REPO_TOUCHING.map((m) => st.calls.indexOf(m)).filter(
      (i) => i !== -1,
    );
    if (expectRepoTouch) {
      expect(repoTouchIdxs.length).toBeGreaterThan(0);
      expect(Math.min(...repoTouchIdxs)).toBeGreaterThan(orgIdx);
    } else {
      expect(repoTouchIdxs).toEqual([]);
    }
  });
});

describe("cloneMissingProjects — GitHub checkouts hydrate only on the owner's isolated runtime", () => {
  const targets: ProjectCloneTarget[] = [
    { projectSlug: "hedgeherd", giteaRepoName: "chris-hedgeherd" },
    { projectSlug: "octogee", giteaRepoName: null, repoSource: { provider: "github", owner: "octogee-ai", repo: "octogee" } },
  ];

  function adapterFor(ownerRuntime: boolean, cloned: Set<string>) {
    const cloneProjectRepo = vi.fn(async (_slug: string, projectSlug: string) => {
      cloned.add(projectSlug);
      return true;
    });
    const seedDeferredProjectWorkspace = vi.fn(async () => undefined);
    const adapter = {
      log: vi.fn(),
      isIsolatedGateway: () => ownerRuntime,
      isConfiguredUser: () => ownerRuntime,
      listProjectsNeedingClone: vi.fn(async () => targets.filter((t) => !cloned.has(t.projectSlug))),
      cloneProjectRepo,
      seedDeferredProjectWorkspace,
    } as unknown as UserLifecycleAdapter;
    return { adapter, cloneProjectRepo, seedDeferredProjectWorkspace };
  }

  it("defers the GitHub project on a shared gateway and still clones the Gitea one", async () => {
    const { adapter, cloneProjectRepo } = adapterFor(false, new Set());

    const result = await cloneMissingProjects(adapter, "chris");

    expect(cloneProjectRepo).toHaveBeenCalledTimes(1);
    expect(cloneProjectRepo.mock.calls[0][1]).toBe("hedgeherd");
    expect(result).toEqual({ steps: ["project-clone"], pending: [], deferred: ["octogee"] });
  });

  it("leaves a deferred project a workspace OpenClaw will not call vanished", async () => {
    const { adapter, seedDeferredProjectWorkspace } = adapterFor(false, new Set());

    await cloneMissingProjects(adapter, "chris");

    expect(seedDeferredProjectWorkspace).toHaveBeenCalledWith("chris", "octogee");
    expect(seedDeferredProjectWorkspace).toHaveBeenCalledTimes(1);
  });

  it("defers the GitHub project even on the owner's runtime when a migration import asks it to", async () => {
    const { adapter, cloneProjectRepo } = adapterFor(true, new Set());

    const result = await cloneMissingProjects(adapter, "chris", { githubCheckouts: "defer" });

    expect(cloneProjectRepo).toHaveBeenCalledTimes(1);
    expect(cloneProjectRepo.mock.calls[0][1]).toBe("hedgeherd");
    expect(result).toEqual({ steps: ["project-clone"], pending: [], deferred: ["octogee"] });
  });

  it("attempts the GitHub project on the owner's isolated runtime and reports it pending when it fails", async () => {
    const { adapter, cloneProjectRepo } = adapterFor(true, new Set());
    cloneProjectRepo.mockImplementation(async (_slug: string, projectSlug: string) => projectSlug === "hedgeherd");
    (adapter.listProjectsNeedingClone as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      cloneProjectRepo.mock.calls.length === 0 ? targets : targets.filter((t) => t.projectSlug === "octogee"));

    const result = await cloneMissingProjects(adapter, "chris");

    expect(cloneProjectRepo).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ steps: ["project-clone"], pending: ["octogee"], deferred: [] });
  });

  it("does not probe checkouts for an already cancelled owner", async () => {
    const { adapter, cloneProjectRepo } = adapterFor(true, new Set());
    const controller = new AbortController();
    controller.abort(new Error("finish import cancelled"));

    await expect(cloneMissingProjects(adapter, "chris", { signal: controller.signal }))
      .rejects.toThrow("finish import cancelled");

    expect(adapter.listProjectsNeedingClone).not.toHaveBeenCalled();
    expect(cloneProjectRepo).not.toHaveBeenCalled();
  });

  it("does not clone after its initial checkout probe is cancelled", async () => {
    const { adapter, cloneProjectRepo } = adapterFor(true, new Set());
    const controller = new AbortController();
    adapter.listProjectsNeedingClone = vi.fn(async () => {
      controller.abort(new Error("finish import cancelled"));
      return targets;
    });

    await expect(cloneMissingProjects(adapter, "chris", { signal: controller.signal }))
      .rejects.toThrow("finish import cancelled");

    expect(cloneProjectRepo).not.toHaveBeenCalled();
  });

  it.each(["gitea", "github"] as const)("propagates cancellation from a %s clone instead of starting another project", async provider => {
    const { adapter } = adapterFor(true, new Set());
    const ordered = provider === "gitea" ? targets : [...targets].reverse();
    adapter.listProjectsNeedingClone = vi.fn(async () => ordered);
    const controller = new AbortController();
    const clone = vi.fn(async () => {
      controller.abort(new Error("finish import cancelled"));
      throw new Error("clone interrupted");
    });
    adapter.cloneProjectRepo = clone;

    await expect(cloneMissingProjects(adapter, "chris", { signal: controller.signal }))
      .rejects.toThrow("finish import cancelled");

    expect(clone).toHaveBeenCalledExactlyOnceWith("chris", ordered[0].projectSlug, ordered[0].giteaRepoName,
      expect.objectContaining({ signal: controller.signal }));
    expect(adapter.listProjectsNeedingClone).toHaveBeenCalledOnce();
  });

  it("does not report hydration complete after its final checkout probe is cancelled", async () => {
    const { adapter } = adapterFor(true, new Set());
    const controller = new AbortController();
    adapter.listProjectsNeedingClone = vi.fn()
      .mockResolvedValueOnce([targets[0]])
      .mockImplementationOnce(async () => {
        controller.abort(new Error("finish import cancelled"));
        return [];
      });

    await expect(cloneMissingProjects(adapter, "chris", { signal: controller.signal }))
      .rejects.toThrow("finish import cancelled");
  });
});

describe("lifecycle log identity", () => {
  it("binds each concurrent removal's canonical user slug and clears it afterwards", async () => {
    const { createServiceLogger } = await import("@octogee/shared/server/service-logger");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation(line => { lines.push(String(line)); });
    try {
      const logger = createServiceLogger("provisioner");
      await Promise.all(["alice", "bob"].map(async slug => {
        const adapter = makeAdapter(makeState(snap({ uid: slug, slug }), emptyDisk()));
        adapter.log = message => logger.info(message);
        await removeUserFromGateway(adapter, slug);
      }));
      expect(lines.map(line => JSON.parse(line).builderSlug).sort()).toEqual(["alice", "bob"]);
      logger.info("Shared work");
      expect(JSON.parse(lines.at(-1)!).builderSlug).toBeUndefined();
    } finally { spy.mockRestore(); }
  });
});

const HOLDER = "gw-test/octogee-gateway-gw-test-5bc59-p946t";

describe("addUserToGateway — through the provisioning service", () => {
  const READY: ServiceProvisioningAnswer = { ready: true };
  const pending = (reason: string, retryAfterMs = 5_000): ServiceProvisioningAnswer => ({ ready: false, reason, retryAfterMs });

  function withService(
    state: MockState,
    options: {
      readiness?: () => ServiceProvisioningAnswer;
      registerGitKey?: () => ServiceProvisioningAnswer;
    } = {},
  ) {
    let clock = 0;
    const sleeps: number[] = [];
    const service: ServiceProvisioningAdapter = {
      readiness: vi.fn(async () => {
        state.calls.push("service:readiness");
        return options.readiness?.() ?? READY;
      }),
      serviceGitKey: vi.fn(() => {
        state.calls.push("service:gitKey");
        state.disk.sshKey = true;
        return { publicKey: "ssh-service-pubkey", registered: () => state.calls.push("service:keyRegistered") };
      }),
      registerGitKey: vi.fn(async () => {
        state.calls.push("service:registerGitKey");
        return options.registerGitKey?.() ?? READY;
      }),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      now: () => clock,
    };
    const adapter = makeAdapter(state);
    adapter.provisioningService = service;
    const loads: Array<{ refresh?: boolean } | undefined> = [];
    adapter.loadUserSnapshot = async (_uid, options) => {
      loads.push(options);
      return state.user;
    };
    const initPaths: Array<string | undefined> = [];
    const init = adapter.initWorkspaceRepoFromExistingDir;
    adapter.initWorkspaceRepoFromExistingDir = async (ctx, path) => {
      initPaths.push(path);
      return init(ctx, path);
    };
    return { adapter, service, sleeps, loads, initPaths };
  }

  const LEGACY_REMOTE_CALLS = [
    "registerKey",
    "ensureOwner",
    "ensureRepo:system-config",
    "ensureRepo:workspace",
    "provisionMattermostUser",
    "write:mattermost.*",
    "generateUserSshKey",
  ];

  beforeEach(() => {
    _resetInFlightUidsForTests();
  });

  it("waits for chat and git, registers its own key through the service and performs no chat or git side effect", async () => {
    const state = makeState(snap({ provisionedBy: "service", gitKeyHolder: HOLDER, mattermostUserId: "mm-user" }), emptyDisk());
    const { adapter, initPaths, loads } = withService(state);

    const result = await addUserToGateway(adapter, "uid-test");

    for (const call of LEGACY_REMOTE_CALLS) expect(state.calls).not.toContain(call);
    expect(state.calls.indexOf("service:readiness")).toBeLessThan(state.calls.indexOf("service:registerGitKey"));
    expect(state.calls.indexOf("service:registerGitKey")).toBeLessThan(state.calls.indexOf("initWorkspaceRepoFromExistingDir"));
    expect(initPaths).toEqual(["service"]);
    expect(adapter.provisioningService?.serviceGitKey).toHaveBeenCalledWith("test", HOLDER);
    expect(state.calls.indexOf("service:registerGitKey")).toBeLessThan(state.calls.indexOf("service:keyRegistered"));
    expect(loads).toContainEqual({ refresh: true });
    expect(state.calls).toContain("applyAddUserConfigPatch");
    expect(state.calls).toContain("provisionDefaultAgentAutomation");
    expect(state.writes).toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
    expect(result.steps).toEqual(expect.arrayContaining(["ssh-key", "init-workspace-repo", "config-patch", "mark-complete"]));
    expect(result.steps).not.toContain("mattermost-provision");
  });

  it("re-mounts a user with a workspace already on disk without asking for any repository", async () => {
    const state = makeState(mountedSnapshot({ provisionedBy: "service", gitKeyHolder: HOLDER }), mountedDisk());
    const { adapter, service } = withService(state);

    await addUserToGateway(adapter, "uid-test");

    for (const call of LEGACY_REMOTE_CALLS) expect(state.calls).not.toContain(call);
    expect(state.calls).not.toContain("initWorkspaceRepoFromExistingDir");
    expect(service.registerGitKey).toHaveBeenCalledWith("uid-test", "ssh-service-pubkey");
  });

  it("logs each reason it waits for, backs off, and continues once the service is ready", async () => {
    const state = makeState(snap({ provisionedBy: "service", gitKeyHolder: HOLDER, mattermostUserId: "mm-user" }), emptyDisk());
    const answers = [pending("ChatTeamFailed", 0), pending("GitRepositoryFailed", 7_000), READY];
    const { adapter, sleeps } = withService(state, { readiness: () => answers.shift()! });

    await addUserToGateway(adapter, "uid-test");

    expect(sleeps).toEqual([1_000, 7_000]);
    expect(state.logs).toContainEqual(expect.stringContaining("waiting for the provisioning service to report chat and git ready (reason ChatTeamFailed"));
    expect(state.logs).toContainEqual(expect.stringContaining("(reason GitRepositoryFailed, next check in 7000ms"));
    expect(state.logs).toContainEqual(expect.stringContaining("chat and git ready: ready after 8000ms"));
  });

  it("caps a long Retry-After so a recovered service is noticed", async () => {
    const state = makeState(snap({ provisionedBy: "service", gitKeyHolder: HOLDER, mattermostUserId: "mm-user" }), emptyDisk());
    const answers = [pending("ProvisioningServiceUnavailable", 300_000), READY];
    const { adapter, sleeps } = withService(state, { readiness: () => answers.shift()! });

    await addUserToGateway(adapter, "uid-test");

    expect(sleeps).toEqual([15_000]);
  });

  it("fails the mount with the last reason once the wait exceeds its bound, before any key, checkout or config patch", async () => {
    const state = makeState(snap({ provisionedBy: "service", gitKeyHolder: HOLDER }), emptyDisk());
    const { adapter, sleeps } = withService(state, { readiness: () => pending("GitOwnerFailed") });

    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow(
      /gave up waiting for the provisioning service to report chat and git ready after \d+ms \(bound 90000ms, last reason GitOwnerFailed\); failing the mount/,
    );

    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(90_000);
    expect(state.errorLogs).toContainEqual(expect.stringContaining("gave up waiting for the provisioning service to report chat and git ready"));
    expect(state.calls).not.toContain("service:registerGitKey");
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
    expect(state.writes).not.toContainEqual({ field: "provisioning.openclaw.status", value: "complete" });
  });

  it("fails the mount when the service does not register the key within its bound", async () => {
    const state = makeState(snap({ provisionedBy: "service", gitKeyHolder: HOLDER, mattermostUserId: "mm-user" }), emptyDisk());
    const { adapter, service } = withService(state, { registerGitKey: () => pending("GitKeyFailed") });

    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow(
      /gave up waiting for the provisioning service to register this pod's git key .*last reason GitKeyFailed/,
    );

    expect(vi.mocked(service.registerGitKey).mock.calls.length).toBeGreaterThan(1);
    expect(state.calls).not.toContain("applyAddUserConfigPatch");
  });

  it("fails the mount at once and logs an error when the platform refuses the user", async () => {
    const state = makeState(snap({ provisionedBy: "service", gitKeyHolder: HOLDER }), emptyDisk());
    const { adapter, service, sleeps } = withService(state, {
      readiness: () => ({ ready: false, refused: true, reason: "UserBeingErased" }),
    });

    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow(
      /the platform refused the mount while waiting for the provisioning service to report chat and git ready \(reason UserBeingErased\); no retry can finish this mount/,
    );

    expect(service.readiness).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([]);
    expect(state.errorLogs).toContainEqual(expect.stringContaining("reason UserBeingErased"));
    expect(state.calls).not.toContain("service:registerGitKey");
  });

  it("records no holder for a key the service did not register within its bound", async () => {
    const state = makeState(snap({ provisionedBy: "service", gitKeyHolder: HOLDER, mattermostUserId: "mm-user" }), emptyDisk());
    const { adapter } = withService(state, { registerGitKey: () => pending("GitKeyHeldElsewhere", 120_000) });

    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow(/GitKeyHeldElsewhere/);

    expect(state.calls).not.toContain("service:keyRegistered");
  });

  it("fails the mount before any key when the snapshot names no holder for this pod", async () => {
    const state = makeState(snap({ provisionedBy: "service", mattermostUserId: "mm-user" }), emptyDisk());
    const { adapter, service } = withService(state);

    await expect(addUserToGateway(adapter, "uid-test")).rejects.toThrow("names no git key holder");

    expect(service.serviceGitKey).not.toHaveBeenCalled();
    expect(service.registerGitKey).not.toHaveBeenCalled();
  });

  it("stops waiting when the mount is aborted", async () => {
    const state = makeState(snap({ provisionedBy: "service", gitKeyHolder: HOLDER }), emptyDisk());
    const { adapter, service } = withService(state, { readiness: () => pending("ChatUserFailed") });
    delete service.sleep;
    delete service.now;
    const controller = new AbortController();
    const mounted = addUserToGateway(adapter, "uid-test", { signal: controller.signal });
    controller.abort(new Error("caller gave up"));

    await expect(mounted).rejects.toThrow("caller gave up");
  });

  it("keeps today's path when the platform does not provision through the service", async () => {
    const state = makeState(snap({ status: "" }), emptyDisk());
    const { adapter, service } = withService(state);

    await addUserToGateway(adapter, "uid-test");

    expect(service.readiness).not.toHaveBeenCalled();
    expect(service.registerGitKey).not.toHaveBeenCalled();
    expect(state.calls).toEqual(expect.arrayContaining(["generateUserSshKey", "registerKey", "ensureOwner", "provisionMattermostUser"]));
  });

  it("refuses a service-provisioned user on a gateway without a provisioning service adapter", async () => {
    const state = makeState(snap({ provisionedBy: "service", gitKeyHolder: HOLDER }), emptyDisk());

    await expect(addUserToGateway(makeAdapter(state), "uid-test")).rejects.toThrow("has no provisioning service adapter");
    for (const call of LEGACY_REMOTE_CALLS) expect(state.calls).not.toContain(call);
  });
});

describe("removeUserFromGateway — whatever path registered the key", () => {
  it.each([
    ["the snapshot says service and names this pod's holder", { provisionedBy: "service", gitKeyHolder: HOLDER }],
    ["the snapshot names a holder but no longer says service", { gitKeyHolder: HOLDER }],
    ["the snapshot says nothing about the service", {}],
  ] as Array<[string, Partial<UserSnapshot>]>)("gives up the key through the one release when %s", async (_name, snapshot) => {
    const state = makeState(mountedSnapshot(snapshot), mountedDisk());

    const result = await removeUserFromGateway(makeAdapter(state), "uid-test");

    expect(state.calls.filter((call) => call === "giveUpUserGitKey")).toHaveLength(1);
    expect(state.disk.sshKey).toBe(false);
    expect(result.steps).toContain("release-gitea-key");
  });

  it("records no release step for a key that could not be released", async () => {
    const state = makeState(mountedSnapshot(), mountedDisk());
    const adapter = makeAdapter(state);
    adapter.giveUpUserGitKey = async () => "unreleasable";

    const result = await removeUserFromGateway(adapter, "uid-test");

    expect(result.steps).toEqual(["config-patch-remove", "delete-dir"]);
  });
});
