import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTenantEnforcementMiddleware } from "../middleware/tenant-enforcement.js";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createGatewayVmContextRoutes } from "./gateway-vm-context.js";

function gatewayRoot() {
  return {
    gatewayId: "walter",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredStatus: "running",
    desiredRelease: 1,
    liveRelease: 1,
    configSchemaVersion: 1,
    profile: "isolated",
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: { controlUiEnabled: true },
    ownerUid: "owner",
    builderSlug: "alex",
    modelBrokerLimits: null,
    preemption: null,
  };
}

function runtimeRecord(fields: Record<string, unknown>) {
  return { docKind: "runtime", gatewayId: "walter", release: 1, lifecycle: "running", ...fields };
}

function fixtureDocuments() {
  const docs = new Map<string, Record<string, unknown>>([
    ["gateways/walter", gatewayRoot()],
    ["users/owner", {
      provisioning: {
        openclaw: {
          gatewayId: "walter",
          slug: "alex",
          agentIds: ["octogee-alex-coach"],
        },
      },
    }],
  ]);
  return { docs };
}

function app(
  harness: ReturnType<typeof fixtureDocuments>,
  options: {
    gatewayId?: string;
    podUid?: string;
  } = {},
) {
  const target = express();
  target.use(express.json());
  target.use((req, _res, next) => {
    req.boundTenant = {
      kind: "gateway",
      gatewayId: options.gatewayId ?? "walter",
      ownerUid: "owner",
      podUid: options.podUid,
    };
    next();
  });
  const store = createDocumentFixtureStore(harness.docs);
  target.use(createTenantEnforcementMiddleware({ readFlowGateway: async () => null, store, onDenied: async () => {} }));
  target.use("/internal/computer", createGatewayVmContextRoutes({ store }));
  return target;
}

const agentId = "octogee-alex-coach";

describe("agent VM context", () => {
  it.each(["s", "m", "l"])("preserves authenticated X11 VM authority on retained cluster runtime at tier %s", async (sizingTier) => {
    const h = fixtureDocuments();
    const podUid = "12345678-1234-1234-1234-123456789abc";
    h.docs.get("gateways/walter")!.sizingTier = sizingTier;
    h.docs.set("glmGateways/walter", runtimeRecord({ runtime: "cluster", kubernetes: { status: "ready", totalPods: 1, readyPods: 1, pods: [{ uid: podUid }] } }));
    const response = await request(app(h, { podUid })).post("/internal/computer/agent-context").send({ agentId });
    expect(response.status).toBe(200);
    expect(response.body.computerInstanceId).toBe(`cluster:${podUid}`);
    expect((await request(app(h, { podUid: "other-pod" })).post("/internal/computer/agent-context").send({ agentId })).status).toBe(409);
  });

  it.each([
    { status: "not-ready", totalPods: 1, readyPods: 0 },
    { status: "ready", totalPods: 2, readyPods: 1 },
  ])("rejects unavailable or overlapping Hobby pods", async (observation) => {
    const h = fixtureDocuments();
    const podUid = "12345678-1234-1234-1234-123456789abc";
    h.docs.get("gateways/walter")!.sizingTier = "s";
    h.docs.set("glmGateways/walter", runtimeRecord({ runtime: "cluster", kubernetes: { ...observation, pods: [{ uid: podUid }] } }));
    await request(app(h, { podUid })).post("/internal/computer/agent-context").send({ agentId }).expect(409);
  });

  it("binds VM authority to the desired gateway root and observed running VM", async () => {
    const h = fixtureDocuments();
    h.docs.set("glmGateways/walter", runtimeRecord({ runtime: "gce-vm", vm: { instanceId: "123", status: "RUNNING" } }));
    h.docs.get("users/owner")!.mattermost = { userId: "o".repeat(26) };
    const response = await request(app(h)).post("/internal/computer/agent-context")
      .send({ agentId });
    expect(response.status).toBe(200);
    expect((await request(app(h)).post("/internal/computer/agent-context")
      .send({ agentId, gatewayId: "other" })).status).toBe(403);
    expect(response.body).toEqual({ gatewayId: "walter", ownerUid: "owner", ownerMattermostUserId: "o".repeat(26), computerInstanceId: "gce-vm:123", vmInstanceId: "123", agentAccountId: "alex-coach" });
    h.docs.get("glmGateways/walter")!.vm = { instanceId: "456", status: "RUNNING" };
    expect((await request(app(h)).post("/internal/computer/agent-context").send({ agentId })).body.computerInstanceId).toBe("gce-vm:456");
    expect((await request(app(h, { gatewayId: "other" })).post("/internal/computer/agent-context").send({ agentId })).status).toBe(403);
  });

  it.each(["paused", "draining", "retired"])("rejects a %s gateway even when its VM is still running", async (desiredStatus) => {
    const h = fixtureDocuments();
    h.docs.get("gateways/walter")!.desiredStatus = desiredStatus;
    h.docs.set("glmGateways/walter", runtimeRecord({ runtime: "gce-vm", desiredStatus: "running", vm: { instanceId: "123", status: "RUNNING" } }));
    await request(app(h)).post("/internal/computer/agent-context")
      .send({ agentId }).expect(409, { error: "computer-unavailable" });
  });

  it("does not issue VM authority for a stopped VM or an unassigned agent", async () => {
    const h = fixtureDocuments();
    h.docs.set("glmGateways/walter", runtimeRecord({ runtime: "gce-vm", vm: { instanceId: "123", status: "TERMINATED" } }));
    expect((await request(app(h)).post("/internal/computer/agent-context").send({ agentId })).status).toBe(409);
    expect((await request(app(h)).post("/internal/computer/agent-context").send({ agentId: "octogee-other-coach" })).status).toBe(403);
  });

});
