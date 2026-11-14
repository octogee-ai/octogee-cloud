import { createNativeReturnTargetRetirementVerifier } from "../lib/native-return-target-retirement.js";
import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { isRetiredSharedGateway, retiredSharedGatewayRuntimeAbsent } from "../lib/user-ops/retired-shared-gateway.js";

const gatewayId = "shared-9b3b204b1371";
const operationId = `shared-pool-retire-${gatewayId}`;

function root(fields: Record<string, unknown>): Record<string, unknown> {
  return { gatewayId, latestRelease: 1, desiredRelease: 1, liveRelease: 1, ...fields };
}

function harness() {
  const records: Record<string, Record<string, any>> = {
    [`glmOperations/${operationId}`]: {
      kind: "retire-gateway", status: "succeeded", gatewayId, createdAt: 100, completedAt: 200,
      input: { gatewayId, source: "shared-pool-scaler", retirementClaimVersion: 1 },
    },
  };
  const store = createDocumentFixtureStore(records);
  const readRuntimeAbsent = vi.fn(async () => true);
  return { store, records, readRuntimeAbsent, run: () => isRetiredSharedGateway(store, gatewayId, readRuntimeAbsent) };
}

const assignment = (uid: string) => ({ uid, slug: uid, gatewayId, source: "onboarding", state: "serving", epoch: 1 });

describe("retired Shared gateway unmount proof", () => {
  it("recognizes a removed Shared gateway with its successful retirement receipt and absent runtime", async () => {
    const h = harness();
    await expect(h.run()).resolves.toBe(true);
    expect(h.readRuntimeAbsent).toHaveBeenCalledWith(gatewayId);
  });

  it("recognizes a retired Shared root that still holds the completed claim", async () => {
    const h = harness();
    h.records[`gateways/${gatewayId}`] = root({
      gatewayClass: "shared", ownerUid: null, desiredStatus: "retired", retirementVersion: 1,
      retirementClaim: { operationId, version: 1, phase: "claimed" },
    });
    await expect(h.run()).resolves.toBe(true);
  });

  it("accepts the original add receipt before retirement", async () => {
    const h = harness();
    h.records["glmOperations/original-add"] = { gatewayId, kind: "add-gateway", status: "succeeded", createdAt: 50 };
    await expect(h.run()).resolves.toBe(true);
  });

  it.each([
    ["live root", `gateways/${gatewayId}`, root({ gatewayClass: "shared", desiredStatus: "running" })],
    ["foreign owner", `gateways/${gatewayId}`, root({ gatewayClass: "isolated", ownerUid: "other", desiredStatus: "retired" })],
    ["runtime record", `glmGateways/${gatewayId}`, { docKind: "runtime", gatewayId, release: 1, lifecycle: "serving" }],
    ["assignment", `gateways/${gatewayId}/assignments/user`, assignment("user")],
    ["user reference", "users/user", { provisioning: { openclaw: { gatewayId } } }],
    ["newer incarnation", "glmOperations/new-add", { gatewayId, kind: "add-gateway", status: "succeeded", createdAt: 150 }],
    ["unfinished add", "glmOperations/pending-add", { gatewayId, kind: "add-gateway", status: "pending", createdAt: 50 }],
    ["unversioned incarnation", "glmOperations/unknown-add", { gatewayId, kind: "add-gateway" }],
    ["different claim", `gateways/${gatewayId}`, root({ gatewayClass: "shared", ownerUid: null, desiredStatus: "retired", retirementVersion: 2, retirementClaim: { operationId, version: 2, phase: "claimed" } })],
  ])("rejects a %s", async (_label, path, record) => {
    const h = harness();
    h.records[path as string] = record as Record<string, any>;
    await expect(h.run()).resolves.toBe(false);
    expect(h.readRuntimeAbsent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["failed", { status: "failed" }],
    ["pending", { status: "pending" }],
    ["wrong kind", { kind: "add-gateway" }],
    ["foreign gateway", { input: { gatewayId: "foreign", source: "shared-pool-scaler", retirementClaimVersion: 1 } }],
    ["unknown source", { input: { gatewayId, source: "unknown", retirementClaimVersion: 1 } }],
    ["no completion", { completedAt: null }],
  ])("rejects a %s retirement receipt", async (_label, change) => {
    const h = harness();
    if (!change) delete h.records[`glmOperations/${operationId}`];
    else Object.assign(h.records[`glmOperations/${operationId}`], change);
    await expect(h.run()).resolves.toBe(false);
  });

  it("does not infer Kubernetes absence from a retirement receipt", async () => {
    const h = harness();
    h.readRuntimeAbsent.mockResolvedValue(false);
    await expect(h.run()).resolves.toBe(false);
  });

  it("surfaces unknown Kubernetes state", async () => {
    const h = harness();
    h.readRuntimeAbsent.mockRejectedValue(new Error("Kubernetes unavailable"));
    await expect(h.run()).rejects.toThrow("Kubernetes unavailable");
  });

  it("revalidates tenant references after checking Kubernetes", async () => {
    const h = harness();
    h.readRuntimeAbsent.mockImplementation(async () => {
      h.records[`gateways/${gatewayId}/assignments/new-user`] = assignment("new-user");
      return true;
    });
    await expect(h.run()).resolves.toBe(false);
  });
});

describe("retired Shared Kubernetes absence", () => {
  it.each([
    { deployment: null, status: "missing", totalPods: 0, pods: [], absent: true },
    { deployment: 0, status: "missing", totalPods: 0, pods: [], absent: false },
    { deployment: 1, status: "ready", totalPods: 1, pods: [{}], absent: false },
    { deployment: null, status: "not-ready", totalPods: 1, pods: [{}], absent: false },
    { deployment: null, status: "unknown", totalPods: 0, pods: [], absent: false },
    { deployment: null, status: "missing", totalPods: 1, pods: [{}], absent: false },
  ])("requires actual Deployment and pod absence: $deployment/$status/$totalPods", async ({ deployment, status, totalPods, pods, absent }) => {
    const kubeOps = {
      readAvailableReplicas: vi.fn(async () => deployment),
      readGatewayPodDiagnostics: vi.fn(async () => ({ status, totalPods, pods })),
    };
    await expect(retiredSharedGatewayRuntimeAbsent(kubeOps as never, "octogee-test", gatewayId, `octogee-gateway-${gatewayId}`))
      .resolves.toBe(absent);
    expect(kubeOps.readAvailableReplicas).toHaveBeenCalledWith({ namespace: "octogee-test", name: `octogee-gateway-${gatewayId}` });
    if (deployment === null) expect(kubeOps.readGatewayPodDiagnostics).toHaveBeenCalledWith({ namespace: "octogee-test", gatewayId });
  });
});

it("does not accept a deployment recreated during pod absence inspection", async () => {
  const kubeOps = {
    readAvailableReplicas: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(0),
    readGatewayPodDiagnostics: vi.fn(async () => ({ status: "missing", totalPods: 0, pods: [] })),
  };
  await expect(retiredSharedGatewayRuntimeAbsent(kubeOps as never, "octogee-test", gatewayId, `octogee-gateway-${gatewayId}`))
    .resolves.toBe(false);
});


describe("retired native return target proof", () => {
  it.each(["complete", "runtime-live", "credentials-live", "root-recreated", "receipt-changed"])("revalidates physical and PostgreSQL retirement: %s", async scenario => {
    const h = harness();
    if (scenario === "runtime-live") h.readRuntimeAbsent.mockResolvedValue(false);
    const credentialsRetired = vi.fn(async () => {
      if (scenario === "root-recreated") h.records[`gateways/${gatewayId}`] = root({ gatewayClass: "shared", desiredStatus: "running" });
      if (scenario === "receipt-changed") h.records[`glmOperations/${operationId}`].status = "pending";
      return scenario !== "credentials-live";
    });
    const verify = createNativeReturnTargetRetirementVerifier({ store: h.store, runtimeAbsent: h.readRuntimeAbsent, credentialsRetired });
    expect(await verify(gatewayId, async () => {})).toBe(scenario === "complete");
    if (scenario === "runtime-live") expect(credentialsRetired).not.toHaveBeenCalled();
  });
  it("retains uncertainty if the caller loses authority during PostgreSQL proof", async () => {
    const h = harness(); let current = true;
    const verify = createNativeReturnTargetRetirementVerifier({ store: h.store, runtimeAbsent: h.readRuntimeAbsent,
      credentialsRetired: async () => { current = false; return true; } });
    await expect(verify(gatewayId, async () => { if (!current) throw new Error("source claim changed"); })).rejects.toThrow("source claim changed");
  });
});
