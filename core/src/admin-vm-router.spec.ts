import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { addAdminFleetRoutes } from "./admin-fleet-router.js";
import { createJournalFixtureStore, fixtureDocumentsAt, journalRowsAtPaths } from "./testing/journal-store.js";
import { noUserAccounts } from "./user-account.js";

const GATEWAY = "b-fixture";
const OWNER = "fixture-owner";
const gateway = {
  gatewayId: GATEWAY, desiredStatus: "running",
  createdAt: 1, createdBy: "operator", updatedAt: 1, updatedBy: "operator",
  latestRelease: 1, desiredRelease: 1, liveRelease: 1,
  configSchemaVersion: 1, profile: "isolated", gatewayClass: "isolated", imageProfile: "isolated",
  sizingTier: "s", gcpProject: "octogee-test", gatewayContainerSecurityContext: null,
  serviceAccountName: null, serviceAccount: null, builderAccess: null,
  ownerUid: OWNER, builderSlug: "fixture", modelBrokerLimits: null,
};
const vm = { instanceName: "octo-fixture", zone: "us-central1-a", instanceId: "123", status: "RUNNING" };
const parked = { ...vm, gatewayId: GATEWAY, parkedAt: 100, checkpoint: { outcome: "fresh", requestedAt: 90, completedAt: 95 } };

const runtime = { docKind: "runtime", gatewayId: GATEWAY, release: 1, lifecycle: "serving", runtime: "gce-vm", vm };
const sharedRoot = { ...gateway, gatewayId: "shared-a", gatewayClass: "shared", ownerUid: null, builderSlug: null };

function harness(overrides: Record<string, Record<string, unknown> | null> = {}, role = "admin", computerReplacementEnabled: boolean | undefined = true) {
  const records = new Map<string, Record<string, unknown>>(Object.entries({
    [`gateways/${GATEWAY}`]: gateway,
    "gateways/shared-a": sharedRoot,
    [`gateways/shared-a/assignments/${OWNER}`]: { uid: OWNER, slug: "fixture", gatewayId: "shared-a", source: "repair", state: "serving", epoch: 1 },
    [`glmGateways/${GATEWAY}`]: runtime,
    [`users/${OWNER}`]: { username: "fixture", provisioning: { openclaw: { gatewayId: GATEWAY } } },
  }));
  for (const [path, value] of Object.entries(overrides)) {
    if (value === null) records.delete(path); else records.set(path, value);
  }
  const store = createJournalFixtureStore(journalRowsAtPaths(records), { documents: fixtureDocumentsAt(records), serializeTransactions: true });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { uid: role === "anonymous" ? undefined : "operator", isAdmin: role === "admin" }); next(); });
  addAdminFleetRoutes(app, { accounts: noUserAccounts, store, computerReplacementEnabled, logger: { info: vi.fn(), warn: vi.fn() }, provisionGatewayAuthSecret: vi.fn(), listGatewayBuilds: vi.fn(), suspendAuthUser: vi.fn(), revokeConnectorGrantsForUser: vi.fn() });
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
  return { app, records, operations: () => [...records.values()].filter((value) => value.kind === "gateway-vm"), audits: () => [...records.values()].filter((value) => value.recordType === "audit") };
}
const livePath = `/gateways/${GATEWAY}/vm/replace`;
const parkedPath = `/users/${OWNER}/vm/replace`;

describe("admin VM replacement", () => {
  it.each([livePath, parkedPath])("rejects unavailable replacement before admission: %s", async (path) => {
    const h = harness({}, "admin", false);
    const result = await request(h.app).post(path).send({}).expect(409);
    expect(result.body.error).toContain("unavailable in this release");
    expect(h.audits()).toHaveLength(0);
    expect(h.operations()).toHaveLength(0);
  });
  it("journals and enqueues only checkpoint-gated replacement for the currently bound VM", async () => {
    const h = harness();
    const res = await request(h.app).post(livePath).set("Idempotency-Key", "one-replacement").send({}).expect(202);
    expect(res.body.operationId).toBeTruthy();
    expect(h.operations()).toEqual([expect.objectContaining({ kind: "gateway-vm", status: "pending", createdBy: "operator", gatewayId: GATEWAY, inputUid: OWNER, input: { gatewayId: GATEWAY, uid: OWNER, action: "replace" } })]);
    expect(h.audits()).toEqual([expect.objectContaining({ actor: "operator", status: "completed", mutation: { kind: "replace-computer", gatewayId: GATEWAY } })]);
    expect(h.records.get(`glmGateways/${GATEWAY}`)?.vm).toEqual(vm);
    await request(h.app).post(livePath).set("Idempotency-Key", "one-replacement").send({}).expect(409);
    expect(h.operations()).toHaveLength(1);
  });
  it.each([["anonymous", 401], ["member", 403]])("rejects %s before journaling or reading a VM", async (role, status) => {
    const h = harness({}, role as string);
    await request(h.app).post(livePath).send({}).expect(status as number);
    expect(h.audits()).toHaveLength(0);
    expect(h.operations()).toHaveLength(0);
  });
  it.each([{ action: "delete" }, { ownerUid: "someone-else" }, { force: true }, []])("rejects caller-controlled target or destructive flags %j", async (body) => {
    const h = harness();
    await request(h.app).post(livePath).send(body).expect(400);
    expect(h.operations()).toHaveLength(0);
  });
  it.each<Record<string, Record<string, unknown> | null>>([
    { [`gateways/${GATEWAY}`]: null },
    { [`gateways/${GATEWAY}`]: { ...gateway, desiredStatus: "retired" } },
    { [`gateways/${GATEWAY}`]: { ...gateway, retirementClaim: { claimedAt: 1 } } },
    { [`users/${OWNER}`]: null },
    { [`gateways/${GATEWAY}`]: { ...gateway, gatewayClass: "shared", ownerUid: null, builderSlug: null } },
    { [`glmGateways/${GATEWAY}`]: { ...runtime, runtime: "k8s-pod" } },
    { [`glmGateways/${GATEWAY}`]: { ...runtime, vm: null } },
    { [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "b-other" } } } },
  ])("does not enqueue invalid or no-longer-owned VMs %j", async (overrides) => {
    const h = harness(overrides);
    const res = await request(h.app).post(livePath).send({});
    expect([404, 409]).toContain(res.status);
    expect(h.operations()).toHaveLength(0);
  });
  it.each(["/gateways/invalid%2Fgateway/vm/replace", "/users/invalid%2Fowner/vm/replace"])("rejects malformed document identities %s before journaling", async (path) => {
    const h = harness();
    await request(h.app).post(path).send({}).expect(400);
    expect(h.audits()).toHaveLength(0);
    expect(h.operations()).toHaveLength(0);
  });
  it("permits a paused VM whose handler will start it for the final checkpoint", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: { ...gateway, desiredStatus: "paused" } });
    await request(h.app).post(livePath).send({}).expect(202);
    expect(h.operations()).toHaveLength(1);
  });
  it("serializes concurrent replacement admission and rejects a conflicting owner operation", async () => {
    const h = harness();
    const responses = await Promise.all([request(h.app).post(livePath).send({}), request(h.app).post(livePath).send({})]);
    expect(responses.map((res) => res.status).sort()).toEqual([202, 409]);
    expect(h.operations()).toHaveLength(1);
    const busy = harness({ "glmOperations/migration": { status: "running", kind: "migrate-user", inputUid: OWNER, input: { uid: OWNER } } });
    await request(busy.app).post(livePath).send({}).expect(409);
    expect(busy.operations()).toHaveLength(0);
    expect(busy.audits()).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("VM operation already in flight") })]);
  });
  it("journals parked replacement using the owner binding and fresh park checkpoint", async () => {
    const h = harness({ [`glmGateways/${GATEWAY}`]: { ...runtime, vm: null }, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
    await request(h.app).post(parkedPath).send({}).expect(202);
    expect(h.operations()).toEqual([expect.objectContaining({ inputUid: OWNER, input: { ownerUid: OWNER, uid: OWNER, action: "replace" } })]);
  });
  it("journals explicit force recovery for an owner with a stale checkpoint", async () => {
    const stale = { ...parked, checkpoint: { ...parked.checkpoint, outcome: "stale" } };
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: { ...runtime, vm: null }, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: stale } } });
    const res = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    expect(h.operations()).toEqual([expect.objectContaining({ input: { ownerUid: OWNER, uid: OWNER, action: "replace", force: true, expectedGatewayId: GATEWAY, expectedInstanceId: "123" } })]);
    expect(h.audits()).toEqual([expect.objectContaining({ forced: true, mutation: expect.objectContaining({ kind: "replace-computer", force: true }) })]);
    expect(h.records.get(`users/${OWNER}`)).toHaveProperty("provisioning.computerRecovery.operationId", res.body.operationId);
  });
  it.each(["requested", "provisioning", "activating", "active", "returning"])("refuses force recovery while activation is %s", async status => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a", activationLease: { leaseId: "lease-1", generation: 1, status } }, computer: parked } } });
    await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(409);
    expect(h.operations()).toHaveLength(0);
  });
  it("does not fence an owner when the parked VM has no instance ID", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: { ...parked, instanceId: null } } } });
    await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(409);
    expect(h.records.get(`users/${OWNER}`)).not.toHaveProperty("provisioning.computerRecovery");
    expect(h.operations()).toHaveLength(0);
  });
  it("does not fence an owner when the old gateway is running or belongs to another tenant", async () => {
    for (const root of [gateway, { ...gateway, desiredStatus: "paused", ownerUid: "other" }]) {
      const h = harness({ [`gateways/${GATEWAY}`]: root, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
      await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(409);
      expect(h.records.get(`users/${OWNER}`)).not.toHaveProperty("provisioning.computerRecovery");
    }
  });
  it.each([["anonymous", 401], ["member", 403]])("refuses %s force recovery", async (role, status) => {
    const h = harness({}, role as string);
    await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(status as number);
    expect(h.operations()).toHaveLength(0);
  });
  it("retries the same fenced operation after failure even if the parked record was already cleared", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
    const first = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    const operation = h.records.get(`glmOperations/${first.body.operationId}`)!;
    operation.status = "failed";
    h.records.set("glmOperations/pending-migration", { status: "pending", kind: "migrate-user", inputUid: OWNER, input: { uid: OWNER } });
    const owner = h.records.get(`users/${OWNER}`)!;
    delete (owner.provisioning as Record<string, unknown>).computer;
    const retried = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    expect(retried.body.operationId).toBe(first.body.operationId);
    expect(h.records.get(`glmOperations/${first.body.operationId}`)?.status).toBe("pending");
    expect(h.operations()).toHaveLength(1);
  });
  it("does not rearm a changed operation behind a recovery fence", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
    const first = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    const operation = h.records.get(`glmOperations/${first.body.operationId}`)!;
    operation.status = "failed";
    (operation.input as Record<string, unknown>).expectedInstanceId = "other";
    await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(409);
    expect(operation.status).toBe("failed");
  });
  it("recreates an expired failed operation with the pinned identity", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
    const first = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    h.records.delete(`glmOperations/${first.body.operationId}`);
    const retry = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    expect(retry.body.operationId).toBe(first.body.operationId);
    expect(h.operations()).toEqual([expect.objectContaining({ status: "pending", input: expect.objectContaining({ ownerUid: OWNER, expectedGatewayId: GATEWAY, expectedInstanceId: "123" }) })]);
  });
  it("refreshes a failed recovery's serving Shared epoch before retry", async () => {
    const h = harness({ [`gateways/${GATEWAY}`]: null, [`glmGateways/${GATEWAY}`]: null, [`users/${OWNER}`]: { provisioning: { openclaw: { gatewayId: "shared-a" }, computer: parked } } });
    const first = await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    h.records.get(`glmOperations/${first.body.operationId}`)!.status = "failed";
    h.records.get(`gateways/shared-a/assignments/${OWNER}`)!.epoch = 2;
    await request(h.app).post(parkedPath).send({ force: true, acceptBootDataLoss: true }).expect(202);
    expect(h.records.get(`users/${OWNER}`)).toHaveProperty("provisioning.computerRecovery.assignmentEpoch", 2);
  });
  it.each([{ force: true }, { acceptBootDataLoss: true }, { force: false, acceptBootDataLoss: true }])("requires both force and explicit boot data loss acknowledgement: %j", async body => {
    const h = harness();
    await request(h.app).post(parkedPath).send(body).expect(400);
    expect(h.operations()).toHaveLength(0);
  });
  it.each([
    { provisioning: {} },
    { provisioning: { computer: { ...parked, checkpoint: { ...parked.checkpoint, outcome: "stale" } } } },
  ])("refuses parked replacement without a fresh checkpoint %j", async (user) => {
    const h = harness({ [`users/${OWNER}`]: user });
    const res = await request(h.app).post(parkedPath).send({});
    expect([404, 409]).toContain(res.status);
    expect(h.operations()).toHaveLength(0);
  });
  it("refuses the parked-owner route while that VM is still bound to a gateway", async () => {
    const h = harness({ [`users/${OWNER}`]: { provisioning: { computer: parked } } });
    await request(h.app).post(parkedPath).send({}).expect(409);
    expect(h.operations()).toHaveLength(0);
  });
});
