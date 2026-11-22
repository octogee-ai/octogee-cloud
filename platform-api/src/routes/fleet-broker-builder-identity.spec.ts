import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import type { BoundTenant } from "../lib/sa-to-tenant.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const vmCaller: BoundTenant = {
  kind: "gateway",
  gatewayId: "b-x",
  ownerUid: "uid-bob",
  saName: "octogee-computer-test",
  podName: "octogee-gateway-b-x-vm-4242",
  podUid: "4242",
};

const podCaller: BoundTenant = {
  kind: "gateway",
  gatewayId: "b-x",
  ownerUid: "uid-bob",
  saName: "octogee-gw-b-x",
  podName: "octogee-gateway-b-x-5bc5949d46-p946t",
  podUid: "0f6b7c1e-3d2a-4b8e-9c51-6a7d8e9f0a1b",
};

function isolatedRoot(): Record<string, unknown> {
  return {
    gatewayId: "b-x",
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
    sizingTier: "s",
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: "uid-bob",
    builderSlug: "bob",
    modelBrokerLimits: null,
    preemption: null,
    allocation: { kind: "disposable-builder", schemaVersion: 1, leaseId: "operator-bob-1", generation: 1, claimedByUid: "uid-bob" },
  };
}

const vmRuntime = { docKind: "runtime", gatewayId: "b-x", release: 1, lifecycle: "running", runtime: "gce-vm", vm: { instanceId: "4242", instanceName: "octogee-computer-b-x" } };
const podRuntime = { docKind: "runtime", gatewayId: "b-x", release: 1, lifecycle: "running", runtime: "cluster" };

const NOW = 1_800_000_000_000;
type BrokerOptions = Partial<Pick<Parameters<typeof createFleetBrokerRoutes>[0], "assignedPodInitialBoot">> & {
  firstAssignedOwner?: boolean;
  root?: Record<string, unknown>;
  mirrorGatewayId?: string;
};
function broker(caller: BoundTenant, runtime: Record<string, unknown>, options: BrokerOptions = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.boundTenant = caller;
    next();
  });
  app.use("/internal/fleet", createFleetBrokerRoutes({
    now: () => NOW,
    assignedPodInitialBoot: options.assignedPodInitialBoot,
    store: createDocumentFixtureStore({
      "gateways/b-x": { ...isolatedRoot(), ...(options.firstAssignedOwner && { allocation: null, liveRelease: null }), ...options.root },
      "glmGateways/b-x": runtime,
      "gateways/shared-1": { gatewayId: "shared-1", gatewayClass: "shared", desiredStatus: "running", desiredRelease: 1, latestRelease: 1 },
      "gateways/shared-1/assignments/uid-bob": { uid: "uid-bob", slug: "bob", gatewayId: "shared-1", source: "onboarding", state: "serving", epoch: 1 },
      ...(options.firstAssignedOwner && {
        "gateways/b-x/assignments/uid-bob": { uid: "uid-bob", slug: "bob", gatewayId: "b-x", source: "onboarding", state: "serving", epoch: 0 },
      }),
      "users/uid-bob": {
        username: "bob", provisioning: { openclaw: { gatewayId: options.mirrorGatewayId ?? (options.firstAssignedOwner ? "b-x" : "shared-1"), slug: "bob" } },
      },
    }),
  }));
  return (body: Record<string, unknown>) => request(app).post("/internal/fleet/builder-identity").send({ gatewayId: "b-x", ...body });
}

const prelaunchIdentity = {
  gatewayId: "b-x",
  state: "claimed",
  ownerUid: "uid-bob",
  builderSlug: "bob",
  leaseId: "operator-bob-1",
  generation: 1,
  bootMode: "prelaunch",
};

describe("POST /internal/fleet/builder-identity", () => {
  it("tells an isolated gateway's computer to prelaunch while its user is still served on a shared gateway", async () => {
    const response = await broker(vmCaller, vmRuntime)({ nativeBoot: true }).expect(200);

    expect(response.body).toEqual({ identity: prelaunchIdentity });
  });

  it("tells a pod-hosted isolated gateway's pod to prelaunch the same way", async () => {
    const response = await broker(podCaller, podRuntime)({ nativeBoot: true }).expect(200);

    expect(response.body).toEqual({ identity: prelaunchIdentity });
  });

  it("refuses the boot mode to a Kubernetes pod of an isolated gateway that runs on a computer", async () => {
    const response = await broker(podCaller, vmRuntime)({ nativeBoot: true });

    expect(response.status).toBe(403);
  });

  it("refuses the boot mode to a pod the cluster did not name", async () => {
    const { podUid: _podUid, ...unnamed } = podCaller as Extract<BoundTenant, { kind: "gateway" }>;

    const response = await broker(unnamed, podRuntime)({ nativeBoot: true });

    expect(response.status).toBe(403);
  });

  it("answers a pod's plain identity read without a boot mode", async () => {
    const response = await broker(podCaller, podRuntime)({}).expect(200);

    const { bootMode: _bootMode, ...plain } = prelaunchIdentity;
    expect(response.body).toEqual({ identity: plain });
  });
});


describe("initial Native boot of a previously prepared assigned Pod", () => {
  const pod = podCaller as Extract<BoundTenant, { kind: "gateway" }>;
  const observed = {
    ...podRuntime,
    lifecycle: "provisioning",
    kubernetes: { status: "not-ready", observedAt: NOW - 500, totalPods: 1, readyPods: 0, pods: [{ name: pod.podName, uid: pod.podUid }] },
  };

  it.each([1, 2])("allows the exact prepared owner and retained release %s to take the held prelaunch path", async release => {
    const authority = vi.fn(async () => true);
    const root = { latestRelease: release, desiredRelease: release };
    const response = await broker(pod, { ...observed, release }, {
      firstAssignedOwner: true, root, assignedPodInitialBoot: authority,
    })({ nativeBoot: true }).expect(200);
    expect(response.body.identity).toMatchObject({ ownerUid: "uid-bob", bootMode: "prelaunch", leaseId: null, generation: null });
    expect(authority).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      gatewayId: "b-x", podName: pod.podName, podUid: pod.podUid, slug: "bob", uid: "uid-bob", ownerAssignmentEpoch: 0, release,
    }, NOW);
  });

  it("keeps generic assigned or rejected Pods held without a positive preparation proof", async () => {
    for (const authority of [undefined, vi.fn(async () => false)]) {
      const response = await broker(pod, observed, { firstAssignedOwner: true, assignedPodInitialBoot: authority })({ nativeBoot: true }).expect(200);
      expect(response.body.identity.bootMode).toBe("normal");
    }
  });

  it.each([
    ["another authenticated Pod", { ...pod, podUid: "33d68b3c-38a8-41bc-a19e-b8a149bd4026" }, observed, {}],
    ["a stale observation", pod, { ...observed, kubernetes: { ...observed.kubernetes, observedAt: 1 } }, {}],
    ["another owner's gateway mirror", pod, observed, { mirrorGatewayId: "shared-1" }],
    ["a live release", pod, observed, { root: { liveRelease: 1 } }],
    ["a retired root", pod, observed, { root: { desiredStatus: "retired" } }],
  ] as const)("does not ask for preparation authority for %s", async (_scenario, caller, runtime, options) => {
    const authority = vi.fn(async () => true);
    const response = await broker(caller, runtime, { firstAssignedOwner: true, ...options, assignedPodInitialBoot: authority })({ nativeBoot: true }).expect(200);
    expect(response.body.identity.bootMode).not.toBe("prelaunch");
    expect(authority).not.toHaveBeenCalled();
  });
});
