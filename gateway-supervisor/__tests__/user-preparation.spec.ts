import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Request, Response } from "express";
import { createIsolatedSurgeGateWiring, createStartupReadinessHandler, createSurgeReadinessHandler, createToolchainReadinessHandler } from "../lib/fleet-provisioner.js";
import type { UserLifecycleAdapter } from "../lib/user-lifecycle.js";
import { writeActivationManifest, type MigrationActivationManifest } from "../lib/migration-activation-manifest.js";
import { createSurgeOpenClawProcessGate, type SurgeOpenClawProcessSupervisorClient } from "../lib/surge-openclaw-process-gate.js";
import type { SurgeReadinessGate } from "../lib/surge-readiness.js";
import { hasMountedMarker, writeMigratingInPin, writeMountedMarker } from "../lib/local-default-agent-wired.js";
import { stubUserClaim } from "./helpers/user-claim.js";

const temporaryDirectories: string[] = [];
const request = { migrationId: "prepare-alice", slug: "alice", targetPodUid: "target-pod" };

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function manifest(fingerprint: string): MigrationActivationManifest {
  return {
    version: 2, slug: request.slug, appliedFingerprint: fingerprint,
    agentId: "octogee-alice-coach", accountId: "alice-coach",
    agent: { id: "octogee-alice-coach", model: "custom-model" },
    mattermostAccount: { botToken: "coach-token" },
    bindings: [{ agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach" } }],
    projectAgents: [],
  };
}

async function preparationFixture() {
  stubUserClaim(request.slug);
  vi.stubEnv("POD_UID", request.targetPodUid);
  vi.stubEnv("OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256", "");
  vi.stubEnv("OCTOGEE_BUILDER_TOOL_GROUPS_SHA256", "");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "user-preparation-"));
  temporaryDirectories.push(root);
  await writeActivationManifest(root, manifest("initial"));
  const usersDir = path.join(root, "customers");
  const project = {
    projectSlug: "new-project", giteaRepoName: null,
    repoSource: { provider: "github" as const, owner: "alice", repo: "new-project" },
  };
  const cloned = new Set<string>();
  const cloneProjectRepo = vi.fn(async (_slug: string, projectSlug: string) => { cloned.add(projectSlug); return true; });
  const loadUserSnapshot = vi.fn(async () => ({ uid: "uid-alice", slug: request.slug, projects: [project] }));
  const adapter = {
    uidForSlug: async () => "uid-alice",
    loadUserSnapshot,
    log: vi.fn(),
    isIsolatedGateway: () => true,
    isConfiguredUser: (slug: string) => slug === request.slug,
    configuredUserOverlayPresent: () => true,
    userMountMarked: () => hasMountedMarker(usersDir, request.slug),
    listLocalUserSlugs: () => hasMountedMarker(usersDir, request.slug) ? [request.slug] : [],
    hasWorkspaceGitDir: () => true,
    hasGitRemote: () => true,
    listProjectsNeedingClone: async () => (await loadUserSnapshot()).projects.filter(target => !cloned.has(target.projectSlug)),
    cloneProjectRepo,
  } as unknown as UserLifecycleAdapter;
  const attach = vi.fn(async () => { writeMountedMarker(usersDir, request.slug); return request.slug; });
  const gate = createSurgeOpenClawProcessGate(root);
  const identity = { ...request, podUid: request.targetPodUid };
  await gate.ensure({ podUid: identity.podUid, readinessReleased: false });
  await gate.hydrateTarget(identity);
  const processGate = {
    status: vi.fn(async () => (await gate.read())!),
    claimTargetCompletion: vi.fn(() => gate.claimTargetCompletion(identity)),
    permit: vi.fn(async () => {
      await gate.permitTarget(identity);
      return gate.markRunning(identity);
    }),
    releaseTarget: vi.fn(() => gate.settleTargetCompletion(identity)),
    rehold: vi.fn(() => gate.reholdTarget(identity)),
    finalizeTargetCancellation: vi.fn(() => gate.finalizeTargetCancellation(identity)),
  } as unknown as SurgeOpenClawProcessSupervisorClient;
  const ready = vi.fn(async () => undefined);
  const wiring = createIsolatedSurgeGateWiring({
    openclawDir: root, adapter, processGate,
    waitForGatewayHealthy: async () => undefined,
    surgeReadiness: {} as SurgeReadinessGate, waitForGatewayReady: ready,
    log: vi.fn(), provisioning: { beginProvisioning: vi.fn(), finishProvisioning: vi.fn() },
    attachConfiguredUserBeforeOpenClaw: attach,
  });
  return { root, usersDir, adapter, attach, ready, processGate, cloneProjectRepo, wiring, loadUserSnapshot, project };
}

describe("offline user preparation", () => {
  it("re-earns the target mount after final-import preparation clears its marker", async () => {
    const fixture = await preparationFixture();
    await fixture.wiring.prepareSurgeTarget(request);
    expect(hasMountedMarker(fixture.usersDir, request.slug)).toBe(true);

    writeMigratingInPin(fixture.usersDir, request.slug);
    expect(hasMountedMarker(fixture.usersDir, request.slug)).toBe(false);
    const permit = fixture.processGate.permit;
    fixture.processGate.permit = vi.fn(async () => {
      expect(hasMountedMarker(fixture.usersDir, request.slug)).toBe(true);
      return permit(request);
    });

    await fixture.wiring.releaseSurgeReadiness(request);
    expect(fixture.attach).toHaveBeenCalledTimes(2);
    expect(fixture.processGate.permit).toHaveBeenCalledExactlyOnceWith(request);
    expect(fixture.processGate.releaseTarget).toHaveBeenCalledExactlyOnceWith(request);
    expect(fixture.ready).toHaveBeenCalledOnce();
  });

  it("keeps OpenClaw held when final-import mount restoration fails", async () => {
    const fixture = await preparationFixture();
    await fixture.wiring.prepareSurgeTarget(request);
    writeMigratingInPin(fixture.usersDir, request.slug);
    fixture.attach.mockRejectedValueOnce(new Error("workspace Git cannot be restored"));

    await expect(fixture.wiring.releaseSurgeReadiness(request)).rejects.toThrow("workspace Git cannot be restored");
    expect(fixture.processGate.permit).not.toHaveBeenCalled();
    expect(fixture.processGate.releaseTarget).not.toHaveBeenCalled();
    expect(fixture.ready).not.toHaveBeenCalled();
    expect(fixture.processGate.rehold).toHaveBeenCalledExactlyOnceWith(request);
    await vi.waitFor(async () => expect(await fixture.processGate.status()).toEqual({
      version: 1, podUid: request.targetPodUid, role: "normal", mode: "held", phase: "held", terminalTarget: { ...request, completionStarted: true },
    }));
    await expect(fixture.wiring.releaseSurgeReadiness(request)).rejects.toThrow("not reserved by this migration");
    expect(fixture.processGate.permit).not.toHaveBeenCalled();
    expect(fixture.ready).not.toHaveBeenCalled();
  });

  it.each(["hasWorkspaceGitDir", "hasGitRemote"] as const)("rechecks prepared workspace state before startup: %s", async (probe) => {
    const fixture = await preparationFixture();
    await fixture.wiring.prepareSurgeTarget(request);
    fixture.adapter[probe] = vi.fn(() => false);
    fixture.attach.mockImplementationOnce(async () => {
      fixture.adapter[probe] = () => true;
      return request.slug;
    });
    const permit = fixture.processGate.permit;
    fixture.processGate.permit = vi.fn(async () => {
      expect(fixture.adapter[probe](request.slug)).toBe(true);
      return permit(request);
    });

    await fixture.wiring.releaseSurgeReadiness(request);
    expect(fixture.attach).toHaveBeenCalledTimes(2);
    expect(fixture.processGate.releaseTarget).toHaveBeenCalledExactlyOnceWith(request);
  });

  it.each(["same", "manifest", "projects"])("hydrates GitHub before permitting OpenClaw and reconciles changed inputs=%s", async (changed) => {
    const fixture = await preparationFixture();
    await fixture.wiring.prepareSurgeTarget(request);
    expect(fixture.cloneProjectRepo).toHaveBeenCalledWith(request.slug, "new-project", null, expect.objectContaining({ repoSource: expect.objectContaining({ provider: "github" }) }));
    expect(fixture.attach).toHaveBeenCalledOnce();
    expect(fixture.processGate.permit).not.toHaveBeenCalled();
    expect(fixture.ready).not.toHaveBeenCalled();
    if (changed === "manifest") await writeActivationManifest(fixture.root, manifest("updated-source"));
    if (changed === "projects") fixture.loadUserSnapshot.mockResolvedValue({
      uid: "uid-alice", slug: request.slug, projects: [fixture.project, {
        projectSlug: "added-project", giteaRepoName: null,
        repoSource: { provider: "github", owner: "alice", repo: "added-project" },
      }],
    });
    await fixture.wiring.releaseSurgeReadiness(request);
    expect(fixture.attach).toHaveBeenCalledTimes(changed === "same" ? 1 : 2);
    expect(fixture.processGate.permit).toHaveBeenCalledExactlyOnceWith(request);
    expect(fixture.processGate.releaseTarget).toHaveBeenCalledExactlyOnceWith(request);
    expect(fixture.ready).toHaveBeenCalledOnce();
  });

  it("fails preparation while a required repository is still absent", async () => {
    const fixture = await preparationFixture();
    fixture.cloneProjectRepo.mockImplementation(async () => false);
    await expect(fixture.wiring.prepareSurgeTarget(request)).rejects.toThrow("pending repositories: new-project");
    expect(fixture.processGate.permit).not.toHaveBeenCalled();
  });

  it("requires the exact held target reservation before attaching", async () => {
    const fixture = await preparationFixture();
    await expect(fixture.wiring.prepareSurgeTarget({ ...request, targetPodUid: "replaced-pod" })).rejects.toThrow("not reserved by this migration");
    expect(fixture.attach).not.toHaveBeenCalled();
    expect(fixture.cloneProjectRepo).not.toHaveBeenCalled();
  });
});

describe("Isolated toolchain readiness", () => {
  it.each(["held", "hydrated", "starting", "serving"] as const)("requires durable mount and prepared lifecycle state: %s", async (phase) => {
    const fixture = await preparationFixture();
    const status = vi.fn();
    const json = vi.fn();
    const res = { status: status.mockReturnValue({ json }) } as unknown as Response;
    const handler = createToolchainReadinessHandler({ adapter: fixture.adapter, prelaunchState: async () => phase, log: vi.fn() });
    await handler({} as Request, res, vi.fn());
    expect(status).toHaveBeenLastCalledWith(503);
    await fixture.wiring.prepareSurgeTarget(request);
    await handler({} as Request, res, vi.fn());
    expect(status).toHaveBeenLastCalledWith(phase === "held" ? 503 : 200);
    expect(json).toHaveBeenLastCalledWith({ ready: phase !== "held", prelaunchState: phase });
    expect(fixture.processGate.permit).not.toHaveBeenCalled();
  });
});

describe("User startup during a held handoff", () => {
  function response() {
    const json = vi.fn(), status = vi.fn();
    return { json, status, res: { status: status.mockReturnValue({ json }) } as unknown as Response };
  }
  function readiness() {
    return {
      runtime: { status: "booting" as const, activeProvisioning: 0, mountedCustomers: [],
        beginProvisioning: vi.fn(), finishProvisioning: vi.fn(), waitForProvisioningDrain: async () => {} },
      probeHealthz: vi.fn(async () => false), brokerProfilesSettled: () => false, dashboardBridgeReady: () => false,
    };
  }
  it("reports the process gate's terminal target while keeping user readiness closed", async () => {
    vi.stubEnv("POD_UID", "foreign-pod");
    const r = response(), input = readiness();
    const terminalTarget = { migrationId: "surge-isolated-target-pod", slug: "alice", targetPodUid: "target-pod" };
    await createSurgeReadinessHandler({ readiness: input, prelaunchState: async () => "held",
      processGateState: async () => ({ version: 1, podUid: "target-pod", role: "normal", mode: "held", phase: "held", terminalTarget }), surgeReadiness: { released: async () => false } as SurgeReadinessGate,
      log: vi.fn() })({} as Request, r.res, vi.fn());
    expect(r.status).toHaveBeenCalledWith(503);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ ready: false, terminalTarget: { ...terminalTarget, processHeld: false } }));
    expect(input.probeHealthz).not.toHaveBeenCalled();
  });
  it.each(["held", "stopping", "starting", "foreign-pod"] as const)("reports deletion authority only from one settled current supervisor snapshot: %s", async mode => {
    vi.stubEnv("POD_UID", "target-pod");
    const r = response(), input = readiness();
    const terminalTarget = { migrationId: "surge-isolated-target-pod", slug: "alice", targetPodUid: "target-pod" };
    const snapshot = { version: 1 as const, podUid: mode === "foreign-pod" ? "foreign" : "target-pod", role: "normal" as const,
      mode: mode === "starting" ? "permitted" as const : "held" as const,
      phase: mode === "foreign-pod" ? "held" as const : mode, terminalTarget };
    const status = vi.fn(async () => snapshot), prelaunchState = vi.fn(async state => state?.mode === "held" ? "held" as const : "starting" as const);
    await createSurgeReadinessHandler({ readiness: input, prelaunchState, processGateState: status,
      surgeReadiness: { released: async () => false } as SurgeReadinessGate, log: vi.fn() })({} as Request, r.res, vi.fn());
    expect(status).toHaveBeenCalledTimes(1);
    expect(prelaunchState).toHaveBeenCalledExactlyOnceWith(snapshot);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ terminalTarget: { ...terminalTarget, processHeld: mode === "held" } }));
  });
  it.each(["held", "hydrated"] as const)("keeps a healthy %s process gate alive while user readiness stays closed", async phase => {
    const r = response(), input = readiness();
    await createStartupReadinessHandler({ readiness: input, prelaunchState: async () => phase, log: vi.fn() })({} as Request, r.res, vi.fn());
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(expect.objectContaining({ ready: true, openclawUp: false, runtimeStatus: "booting", prelaunchState: phase }));
    expect(input.probeHealthz).not.toHaveBeenCalled();
    const user = response();
    await createSurgeReadinessHandler({ readiness: input, prelaunchState: async () => phase,
      surgeReadiness: { released: async () => false } as SurgeReadinessGate, log: vi.fn() })({} as Request, user.res, vi.fn());
    expect(user.status).toHaveBeenCalledWith(503);
    expect(user.json).toHaveBeenCalledWith(expect.objectContaining({ ready: false, handoffReleased: false }));
  });
  it.each(["starting", "serving", "none"] as const)("does not accept an unhealthy %s runtime", async phase => {
    const r = response();
    await createStartupReadinessHandler({ readiness: readiness(), prelaunchState: async () => phase, log: vi.fn() })({} as Request, r.res, vi.fn());
    expect(r.status).toHaveBeenCalledWith(503);
  });
  it("rejects an unavailable process supervisor and logs its failure", async () => {
    const r = response(), log = vi.fn();
    await createStartupReadinessHandler({ readiness: readiness(), prelaunchState: async () => { throw new Error("supervisor unavailable"); }, log })({} as Request, r.res, vi.fn());
    expect(r.status).toHaveBeenCalledWith(500);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("supervisor unavailable"));
  });
});
