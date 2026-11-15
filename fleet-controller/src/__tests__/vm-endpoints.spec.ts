import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { describe, expect, it, vi } from "vitest";
import { dualReadIsolatedProfileImage, type ReleasePayload } from "@octogee/shared/types/gateway-releases";
import { refineGatewayConvergenceAction } from "../index.js";
import type { DurableGateway } from "../converge-gateway.js";
import {
  reconcileSurgeUserHandoff,
  type SurgeUserHandoffDeps,
  type SurgePodHealth,
  type SurgePodSnapshot,
} from "../surge-user-handoff.js";
import { createVmReadinessProbe, createSurgeEndpointLister } from "../vm-endpoints.js";

const vm = {
  instanceName: "octogee-computer-test-uida", zone: "us-west1-b", instanceId: "4242", internalIp: "172.20.0.9",
  status: "RUNNING", provisioningModel: "SPOT", stopReason: null, updatedAt: 1,
};
const podSnapshot: SurgePodSnapshot = {
  pods: [{ uid: "pod-uid", name: "octogee-gateway-b-x-abc", podIP: "10.0.0.2", ready: true, terminating: false, crashLooping: false }],
  observedPodUids: ["pod-uid"],
};

function lister(docs: Record<string, Record<string, unknown> | undefined>, ready = vi.fn(async () => true)) {
  const listPods = vi.fn(async () => podSnapshot);
  const listEndpoints = createSurgeEndpointLister({
    readRuntimeDoc: async (gatewayId) => docs[gatewayId],
    listPods,
    readVmReady: ready,
  });
  return { listEndpoints, listPods, ready };
}

describe("createSurgeEndpointLister", () => {
  it("lists Kubernetes pods for a cluster gateway and never probes a VM", async () => {
    const h = lister({ "b-x": { runtime: "cluster", vm }, "s-y": undefined });
    expect(await h.listEndpoints("b-x")).toEqual(podSnapshot);
    expect(await h.listEndpoints("s-y")).toEqual(podSnapshot);
    expect(h.listPods).toHaveBeenCalledTimes(2);
    expect(h.ready).not.toHaveBeenCalled();
  });

  it("presents a running VM as the gateway's single endpoint with the readiness the probe reports", async () => {
    const h = lister({ "b-x": { runtime: "gce-vm", vm } }, vi.fn(async () => false));
    expect(await h.listEndpoints("b-x")).toEqual({
      pods: [{ uid: "octogee-gateway-b-x-vm-4242", name: "octogee-computer-test-uida", podIP: "172.20.0.9", ready: false, terminating: false, crashLooping: false }],
      observedPodUids: ["octogee-gateway-b-x-vm-4242"],
    });
    expect(h.ready).toHaveBeenCalledWith({ uid: "octogee-gateway-b-x-vm-4242", name: "octogee-computer-test-uida", podIP: "172.20.0.9", terminating: false, crashLooping: false }, "b-x");
    expect(h.listPods).not.toHaveBeenCalled();
  });

  it("lists no endpoint for a VM that is stopped, stopping, or unrecorded, while a recorded instance stays observed", async () => {
    const h = lister({
      stopped: { runtime: "gce-vm", vm: { ...vm, status: "TERMINATED", internalIp: null } },
      stopping: { runtime: "gce-vm", vm: { ...vm, status: "STOPPING" } },
      none: { runtime: "gce-vm" },
      cleared: { runtime: "gce-vm", vm: null },
    });
    expect(await h.listEndpoints("stopped")).toEqual({ pods: [], observedPodUids: ["octogee-gateway-stopped-vm-4242"] });
    expect(await h.listEndpoints("stopping")).toEqual({ pods: [], observedPodUids: ["octogee-gateway-stopping-vm-4242"] });
    expect(await h.listEndpoints("none")).toEqual({ pods: [], observedPodUids: [] });
    expect(await h.listEndpoints("cleared")).toEqual({ pods: [], observedPodUids: [] });
    expect(h.ready).not.toHaveBeenCalled();
    expect(h.listPods).not.toHaveBeenCalled();
  });
});

describe("createVmReadinessProbe", () => {
  const endpoint = { uid: "octogee-gateway-b-x-vm-4242", name: "octogee-computer-test-uida", podIP: "172.20.0.9", terminating: false, crashLooping: false };

  it("performs the readiness probe the kubelet would against the VM's fleet port", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const log = vi.fn();
    const probe = createVmReadinessProbe({ port: "3003", timeoutMs: 5_000, fetchImpl: fetchImpl as unknown as typeof fetch, log });
    expect(await probe(endpoint, "b-x")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("http://172.20.0.9:3003/surge-ready", expect.objectContaining({ signal: expect.any(AbortSignal) }));

    fetchImpl.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    expect(await probe(endpoint, "b-x")).toBe(false);
    expect(await probe(endpoint, "b-x")).toBe(true);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "[surge-handoff] b-x: readiness probe of octogee-computer-test-uida is passing",
      "[surge-handoff] b-x: readiness probe of octogee-computer-test-uida is failing (HTTP 503)",
      "[surge-handoff] b-x: readiness probe of octogee-computer-test-uida is passing",
    ]);
  });

  it("reports an unreachable VM as not ready, once per outcome change", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error("ECONNREFUSED"); });
    const log = vi.fn();
    const probe = createVmReadinessProbe({ port: 3003, timeoutMs: 5_000, fetchImpl: fetchImpl as unknown as typeof fetch, log });
    expect(await probe(endpoint, "b-x")).toBe(false);
    expect(await probe(endpoint, "b-x")).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/b-x: readiness probe of octogee-computer-test-uida failed — ECONNREFUSED/));

    fetchImpl.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await probe(endpoint, "b-x")).toBe(true);
    expect(await probe(endpoint, "b-x")).toBe(false);
    expect(log).toHaveBeenCalledTimes(3);
  });
});

describe("first-boot VM gateway handoff", () => {
  const imageTag = "def5678-oc2026.7.1";
  const artifact: ReleasePayload = {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: "standard-tag",
    profileImages: { builder: { imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder", imageTag } },
    openclawSourceSha: "a".repeat(40),
  } as ReleasePayload;
  const gateway = {
    gatewayId: "b-x", latestRelease: 1, desiredStatus: "running", desiredRelease: 1, liveRelease: null, configSchemaVersion: 1,
    profile: "isolated", gatewayClass: "isolated", imageProfile: "isolated", sizingTier: null, gcpProject: null,
    gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: "UidA", builderSlug: "mama", modelBrokerLimits: null, preemption: null,
    allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-1", generation: 1, claimedByUid: "UidA" },
  } as unknown as DurableGateway;

  function handoffDeps(input: { ready: boolean; health: SurgePodHealth }) {
    const listPods = vi.fn(async () => { throw new Error("kubectl must not run for a VM gateway"); });
    const unused = (name: string) => vi.fn(() => { throw new Error(`the VM handoff must not call ${name}`); });
    const deps: SurgeUserHandoffDeps = {
      reportMigrationProgress: unused("reportMigrationProgress"),
      deleteCancelledTarget: unused("deleteCancelledTarget"),
      deleteCrashLoopingPod: unused("deleteCrashLoopingPod"),
      claimCrashLoopEviction: unused("claimCrashLoopEviction"),
      markSharedSurgeForwardRecovery: unused("markSharedSurgeForwardRecovery"),
      rebindSharedSurgeForwardRecovery: unused("rebindSharedSurgeForwardRecovery"),
      waitForSourceIdle: unused("waitForSourceIdle"),
      resumeSourceIngress: unused("resumeSourceIngress"),
      readSystemConfigCommit: unused("readSystemConfigCommit"),
      recheckGatewayLater: unused("recheckGatewayLater"),
      recordMigrationProgress: vi.fn(async () => undefined),
      listPods: createSurgeEndpointLister({
        readRuntimeDoc: async () => ({ runtime: "gce-vm", vm }),
        listPods,
        readVmReady: async () => input.ready,
      }),
      readPodHealth: vi.fn(async () => input.health),
      readAssignments: vi.fn(async () => []),
      markAssignment: vi.fn(async () => {}),
      quiesce: vi.fn(async () => {}),
      flush: vi.fn(async () => ({})),
      transfer: vi.fn(async () => {}),
      discardTargetUser: vi.fn(async () => {}),
      releaseTarget: vi.fn(async () => {}),
      readOwnerOperation: vi.fn(async () => null),
      log: vi.fn(),
    };
    return { deps, listPods };
  }

  it("marks the initial prelaunch live from the VM's held endpoint, exactly like a pod", async () => {
    const { deps, listPods } = handoffDeps({
      ready: false,
      health: { status: "booting", version: imageTag, fleetSignatureCapability: "gateway-scoped", handoffReleased: false, prelaunchState: "held", mountedCustomers: [] },
    });
    const reconcileSurgeHandoff = (input: Parameters<typeof reconcileSurgeUserHandoff>[1]) => reconcileSurgeUserHandoff(deps, input);

    await expect(reconcileSurgeHandoff({
      gatewayId: "b-x", desiredImageTag: imageTag, requiresUserMigration: false, isolatedGateway: true,
      ownerlessOperatorPrewarm: false,
    })).resolves.toEqual({ ready: true, prelaunchHeld: true });
    expect(deps.readPodHealth).toHaveBeenCalledWith(expect.objectContaining({ uid: "octogee-gateway-b-x-vm-4242", podIP: "172.20.0.9" }), "b-x");
    expect(listPods).not.toHaveBeenCalled();

    await expect(refineGatewayConvergenceAction({
      passDeps: {
        store: createDocumentFixtureStore({ [`gateways/${gateway.gatewayId}`]: { ...gateway } }),
        reconcileSurgeHandoff,
      },
      gateway,
      artifact,
      runtime: undefined,
      helmObserved: { imageRepository: dualReadIsolatedProfileImage(artifact.profileImages!).imageRepository, imageTag, replicas: 1 },
      action: { kind: "steady" },
    })).resolves.toEqual({ kind: "mark-live" });
  });

  it("settles a released VM whose endpoint reports ready", async () => {
    const { deps } = handoffDeps({
      ready: true,
      health: { status: "ready", version: imageTag, fleetSignatureCapability: "gateway-scoped", handoffReleased: true, prelaunchState: "serving", mountedCustomers: [] },
    });
    await expect(reconcileSurgeUserHandoff(deps, {
      gatewayId: "b-x", desiredImageTag: imageTag, requiresUserMigration: false, isolatedGateway: true,
      ownerlessOperatorPrewarm: false,
    })).resolves.toEqual({ ready: true });
  });
});
