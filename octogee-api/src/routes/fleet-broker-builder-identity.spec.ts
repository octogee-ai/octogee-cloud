import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
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
    profile: "builder",
    gatewayClass: "builder",
    imageProfile: "builder",
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

function broker(caller: BoundTenant, runtime: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.boundTenant = caller;
    next();
  });
  app.use("/internal/fleet", createFleetBrokerRoutes({
    store: createDocumentFixtureStore({
      "gateways/b-x": isolatedRoot(),
      "glmGateways/b-x": runtime,
      "gateways/shared-1": { gatewayId: "shared-1", gatewayClass: "shared", desiredStatus: "running", desiredRelease: 1, latestRelease: 1 },
      "gateways/shared-1/assignments/uid-bob": { uid: "uid-bob", slug: "bob", gatewayId: "shared-1", source: "onboarding", state: "serving", epoch: 1 },
      "users/uid-bob": { username: "bob", provisioning: { openclaw: { gatewayId: "shared-1", slug: "bob" } } },
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
