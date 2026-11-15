import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawBootSentinelStore } from "../lib/openclaw-boot-sentinel.js";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createFleetBrokerRoutes } from "./fleet-broker.js";
const recoveryReads = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@octogee/core/shared-source-recovery", async original => ({
  ...await original<typeof import("@octogee/core/shared-source-recovery")>(), readSharedSourceRecoveryAuthority: recoveryReads.read,
}));

const gatewayId = "shared-source", podName = "octogee-gateway-shared-source-abc123-def45", podUid = "source-pod";
const requestId = "source-repair", sourceSha = "a".repeat(40), digest = "b".repeat(64);
const images = { gateway: `registry/gateway:selected@sha256:${digest}`, "gateway-edge": `registry/edge:selected@sha256:${"c".repeat(64)}` };
const agent = { uid: "uid-alice", slug: "alice", agentId: "octogee-alice-coach", assignmentEpoch: 3 };
const input = { gatewayId, podName, podUid, releaseKey: "older-baked-image-build" };
function fixture() {
  const data: Record<string, any> = {
    [`glmGateways/${gatewayId}`]: { docKind: "runtime", gatewayId, release: 3, lifecycle: "draining" },
    [`gateways/${gatewayId}`]: { gatewayId, ownerUid: null, builderSlug: null, latestRelease: 3, gatewayClass: "shared", desiredStatus: "draining", retirementClaim: null, desiredRelease: 3, liveRelease: 3,
      runtimeRestartFence: { kind: "source-recovery", attemptId: requestId, auditId: requestId, gatewayId, phase: "dispatched", startedAt: 100,
        target: { podName, podUid, sourceSha, images, agents: [agent] },
        installedImage: { podUid, gatewayImageId: `registry/gateway@sha256:${digest}`, verifiedAt: 200 },
        doctor: { requestId } } },
    [`glmOperations/${requestId}`]: { kind: "restart-gateway", status: "running", completedAt: null,
      input: { gatewayId, sourceRecovery: { root: { gatewayId, gatewayClass: "shared", ownerUid: null, builderSlug: null, desiredStatus: "draining", desiredRelease: 3, liveRelease: 3, latestRelease: 3 }, sourceSha, images, assignments: [{ ...agent, assignment: { state: "serving" } }] } } },
  };
  const recovery = data[`glmOperations/${requestId}`].input.sourceRecovery;
  const stores = [{ ...agent, storeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", schema: "owned_coach" }];
  recovery.postgresAgentStores = stores;
  recovery.schedulerStateRecovery = true;
  Object.assign(data[`gateways/${gatewayId}`].runtimeRestartFence.target, { postgresAgentStores: structuredClone(stores), schedulerStateRecovery: true });
  recoveryReads.read.mockImplementation(async () => ({ root: recovery.root, assignments: recovery.assignments, postgresAgentStores: recovery.postgresAgentStores, schedulerStateRecovery: true }));
  const stateStore = createDocumentFixtureStore(data);
  const store = createOpenClawBootSentinelStore(stateStore, () => 300);
  const fence = () => data[`gateways/${gatewayId}`].runtimeRestartFence;
  const server = express(); server.disable("x-powered-by"); server.use(express.json());
  server.use(((req, _res, next) => { req.boundTenant = { kind: "gateway", gatewayId, podName, podUid, tokenSource: "ksa" } as never; next(); }) as RequestHandler);
  server.use("/internal/fleet", createFleetBrokerRoutes({ store: stateStore, now: () => 300 }));
  return { data, store, fence, server };
}

describe("source Doctor boot authority", () => {
  function postgresFixture() {
    const f = fixture(), recovery = f.data[`glmOperations/${requestId}`].input.sourceRecovery;
    const stores = [{ ...agent, storeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", schema: "owned_coach" },
      { ...agent, agentId: "octogee-alice-proj-demo-coach", storeId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", schema: "owned_project" }];
    recovery.postgresAgentStores = stores;
    f.fence().target.postgresAgentStores = structuredClone(stores);
    const captured = { root: recovery.root, assignments: recovery.assignments, schedulerStateRecovery: true, postgresAgentStores: stores };
    recoveryReads.read.mockResolvedValue(captured);
    return { ...f, recovery, stores, captured };
  }
  it("refuses source repair without the PostgreSQL and scheduler roster", async () => {
    const f = fixture();
    for (const field of ["postgresAgentStores", "schedulerStateRecovery"]) {
      delete f.data[`glmOperations/${requestId}`].input.sourceRecovery[field];
      delete f.fence().target[field];
    }
    await expect(f.store.claim(input)).rejects.toThrow();
    expect(f.fence().doctor.startedAt).toBeUndefined();
  });
  it.each(["postgresAgentStores", "schedulerStateRecovery"])("requires %s for every stopped-source repair", async field => {
    const f = fixture();
    delete f.data[`glmOperations/${requestId}`].input.sourceRecovery[field];
    delete f.fence().target[field];
    await expect(f.store.claim(input)).rejects.toThrow();
    expect(f.fence().doctor.startedAt).toBeUndefined();
  });
  it("binds every PostgreSQL project anchor and exposes a read-only current-authority check during Doctor", async () => {
    const f = postgresFixture();
    const agentIds = f.stores.map(s => s.agentId);
    expect(await f.store.claim(input)).toEqual({ action: "doctor", sourceDoctor: { requestId, agentIds, schedulerStateRecovery: true,
      postgresAgentStores: f.stores.map(({ agentId, storeId, schema }) => ({ agentId, storeId, schema })) } });
    const before = structuredClone(f.fence());
    await request(f.server).post("/internal/fleet/openclaw-boot/doctor-current").send({ gatewayId, revisionId: gatewayId, releaseKey: input.releaseKey, requestId }).expect(204);
    expect(f.fence()).toEqual(before);
    expect(f.fence().doctor.completedAt).toBeUndefined();
    expect(await f.store.completeDoctor({ ...input, requestId, verifiedAgentIds: agentIds })).toBe(true);
  });
  it("binds scheduler state repair to the captured source authority and runtime fence", async () => {
    const f = postgresFixture();
    Object.assign(f.recovery, { schedulerStateRecovery: true });
    Object.assign(f.captured, { schedulerStateRecovery: true });
    Object.assign(f.fence().target, { schedulerStateRecovery: true });
    expect(await f.store.claim(input)).toMatchObject({ action: "doctor", sourceDoctor: { schedulerStateRecovery: true } });
  });
  it.each(["fence", "current-custody", "missing-roster"])("refuses unbound scheduler state repair with %s", async changed => {
    const f = postgresFixture();
    Object.assign(f.recovery, { schedulerStateRecovery: true });
    Object.assign(f.captured, { schedulerStateRecovery: true });
    Object.assign(f.fence().target, { schedulerStateRecovery: true });
    if (changed === "fence") delete f.fence().target.schedulerStateRecovery;
    if (changed === "current-custody") recoveryReads.read.mockResolvedValue({ ...f.captured, schedulerStateRecovery: undefined });
    if (changed === "missing-roster") { delete f.recovery.postgresAgentStores; delete f.fence().target.postgresAgentStores; }
    await expect(f.store.claim(input)).rejects.toThrow();
    expect(f.fence().doctor.startedAt).toBeUndefined();
  });
  it.each(["owner", "anchor", "roster", "current-custody"])("refuses changed PostgreSQL %s before admitting maintenance", async changed => {
    const f = postgresFixture();
    if (changed === "owner") f.stores[1]!.uid = "foreign";
    if (changed === "anchor") f.stores[1]!.storeId = f.stores[0]!.storeId;
    if (changed === "roster") f.fence().target.postgresAgentStores.pop();
    if (changed === "current-custody") recoveryReads.read.mockResolvedValue({ ...f.captured, postgresAgentStores: [] });
    await expect(f.store.claim(input)).rejects.toThrow();
    expect(f.fence().doctor.startedAt).toBeUndefined();
  });
  it("rejects source custody lost after Doctor starts without publishing success", async () => {
    const f = postgresFixture(); await f.store.claim(input);
    recoveryReads.read.mockRejectedValue(new Error("source custody changed"));
    await expect(f.store.assertDoctor({ ...input, requestId })).rejects.toThrow("source custody changed");
    expect(f.fence().doctor.completedAt).toBeUndefined();
  });
  it("repairs and acknowledges a agent on its initial epoch-zero assignment", async () => {
    const f = fixture();
    const initialAgent = { ...agent, assignmentEpoch: 0 };
    f.fence().target.agents = [initialAgent];
    f.fence().target.postgresAgentStores[0].assignmentEpoch = 0;
    f.data[`glmOperations/${requestId}`].input.sourceRecovery.postgresAgentStores[0].assignmentEpoch = 0;
    f.data[`glmOperations/${requestId}`].input.sourceRecovery.assignments = [{ ...initialAgent, assignment: { state: "serving" } }];

    expect(await f.store.claim(input)).toEqual({ action: "doctor", sourceDoctor: { requestId, agentIds: [agent.agentId], schedulerStateRecovery: true, postgresAgentStores: [{ agentId: agent.agentId, storeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", schema: "owned_coach" }] } });
    expect(await f.store.completeDoctor({ ...input, requestId, verifiedAgentIds: [agent.agentId] })).toBe(true);
    expect(await f.store.claim(input)).toEqual({ action: "start" });
  });

  it("binds actual installed image and Pod while treating a different baked build key only as correlation", async () => {
    const f = fixture();
    expect(await f.store.claim(input)).toEqual({ action: "doctor", sourceDoctor: { requestId, agentIds: [agent.agentId], schedulerStateRecovery: true, postgresAgentStores: [{ agentId: agent.agentId, storeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", schema: "owned_coach" }] } });
    expect(f.fence().doctor).toEqual({ requestId, releaseKey: input.releaseKey, startedAt: 300 });
    await expect(f.store.claim(input)).rejects.toThrow();
    expect(f.fence().doctor.completedAt).toBeUndefined();
  });
  it("leaves the request unspent until the controller verifies the installed gateway digest", async () => {
    const f = fixture(); delete f.fence().installedImage;
    expect(await f.store.claim(input)).toEqual({ action: "wait", sourceDoctor: { requestId, agentIds: [agent.agentId], schedulerStateRecovery: true, postgresAgentStores: [{ agentId: agent.agentId, storeId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", schema: "owned_coach" }] } });
    expect(f.fence().doctor).toEqual({ requestId });
  });
  it.each(["pod", "image", "operation", "cancelled"])("rejects stale or foreign %s custody without spending Doctor", async (changed) => {
    const f = fixture();
    if (changed === "pod") f.fence().target.podUid = "foreign";
    if (changed === "image") f.fence().installedImage.gatewayImageId = `registry/gateway@sha256:${"d".repeat(64)}`;
    if (changed === "operation") f.data[`glmOperations/${requestId}`].status = "succeeded";
    if (changed === "cancelled") f.data[`glmOperations/${requestId}`].cancellationRequestedAt = 250;
    await expect(f.store.claim(input)).rejects.toThrow();
    expect(f.fence().doctor.startedAt).toBeUndefined();
  });
  it("does not let health certify or clear an unacknowledged repair", async () => {
    const f = fixture(); await f.store.claim(input);
    await expect(f.store.complete(input)).rejects.toThrow();
    expect(f.fence().doctor.completedAt).toBeUndefined();
    expect(f.fence().kind).toBe("source-recovery");
  });
  it("records exact native preflight acknowledgement during an owned pending retry, then permits start and health", async () => {
    const f = fixture(); await f.store.claim(input); f.data[`glmOperations/${requestId}`].status = "pending";
    const body = { gatewayId, revisionId: gatewayId, releaseKey: input.releaseKey, requestId, verifiedAgentIds: [agent.agentId] };
    await request(f.server).post("/internal/fleet/openclaw-boot/doctor-complete").send(body).expect(204);
    expect(f.fence().doctor).toEqual({ requestId, releaseKey: input.releaseKey, startedAt: 300, completedAt: 300, verifiedAgentIds: [agent.agentId] });
    expect(await f.store.claim(input)).toEqual({ action: "start" });
    expect(await f.store.complete(input)).toBe(true);
    expect(f.fence().doctor.completedAt).toBe(300);
  });
  it.each(["request", "key", "agents", "revision"])("refuses a mismatched %s success acknowledgement", async (changed) => {
    const f = fixture(); await f.store.claim(input);
    const body = { gatewayId, revisionId: gatewayId, releaseKey: input.releaseKey, requestId, verifiedAgentIds: [agent.agentId] };
    if (changed === "request") body.requestId = "foreign";
    if (changed === "key") body.releaseKey = "wrong";
    if (changed === "agents") body.verifiedAgentIds = [];
    if (changed === "revision") body.revisionId = "foreign";
    const response = await request(f.server).post("/internal/fleet/openclaw-boot/doctor-complete").send(body);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(f.fence().doctor.completedAt).toBeUndefined();
  });
});
