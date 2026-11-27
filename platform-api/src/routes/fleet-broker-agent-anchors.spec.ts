import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import type { PlatformStateStore } from "@octogee/core/platform-state";
import { GATEWAY_UNREACHABLE_AFTER_MS } from "@octogee/shared/types/fleet-controller";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const GATEWAY = "isolated-a";
const UID = "uid-alice";
const POD_NAME = "octogee-gateway-isolated-a-5bc59-p946t";
const POD_UID = "5c3cb6d0-ba45-4908-ac88-9136a92bedd9";
const OTHER_POD = "30c87f7c-89d8-4d56-b802-a7dbfc7c5b07";
const OPERATION = "placement-ancestor";
const MIGRATION = "mig-" + OPERATION;
const TARGET = "shared-return";
const NOW = 1_800_000_000_000;
const STORE_ID = "92c817cc-770f-466d-b4a6-4e9b02998363";
const ANCHOR = { agentId: "octogee-alice-coach", storeId: STORE_ID, schema: "octogee_agent_92c817cc770f466d" };
const SCOPE = { gatewayId: GATEWAY, revisionId: GATEWAY, slug: "alice" };
const ASSIGNMENT = {
  uid: UID, slug: "alice", gatewayId: GATEWAY, source: "onboarding", state: "serving", epoch: 0,
  createdAt: NOW - 1_000, updatedAt: NOW - 1_000, updatedByOperationId: null,
} as const;

const ROOT = {
  gatewayId: GATEWAY, createdAt: NOW - 1_000, createdBy: "signup-placement",
  updatedAt: NOW - 1_000, updatedBy: "signup-placement", latestRelease: 1, desiredRelease: 1, liveRelease: null,
  desiredStatus: "running", configSchemaVersion: 1, profile: null, gatewayClass: "isolated",
  imageProfile: "isolated", sizingTier: "s", gcpProject: null, gatewayContainerSecurityContext: null,
  serviceAccountName: `octogee-gw-${GATEWAY}`, serviceAccount: null, builderAccess: null, modelBrokerLimits: null,
  ownerUid: UID, builderSlug: "alice",
};

interface Options {
  boundUid?: string;
  observedUid?: string;
  assignedEpoch?: number;
  observedAt?: number;
  root?: Record<string, unknown>;
  mirrorGatewayId?: string;
  migrating?: boolean;
  quiesced?: boolean;
  allocated?: boolean;
}

const ALLOCATION = { kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-alice", generation: 1, claimedByUid: UID };
const ARCHIVED = { agentId: "octogee-alice-proj-shelved-coach", storeId: "1b7e0f4c-5c0d-4f43-9a55-0b8f1f6f2a10", schema: "octogee_agent_1b7e0f4c5c0d4f43" };

async function fixture(options: Options = {}) {
  const documents = new RecordingDocuments({
    [`gateways/${GATEWAY}`]: { ...ROOT, ...(options.allocated ? { allocation: ALLOCATION } : {}), ...options.root },
    [`gateways/${TARGET}`]: { ...ROOT, gatewayId: TARGET, gatewayClass: "shared", imageProfile: "shared", ownerUid: null, builderSlug: null },
    [`users/${UID}`]: { username: "alice", provisioning: { openclaw: { gatewayId: options.mirrorGatewayId ?? GATEWAY, slug: "alice" } } },
    [`glmGateways/${GATEWAY}`]: {
      docKind: "runtime", gatewayId: GATEWAY, release: 1, lifecycle: options.migrating ? "serving" : "provisioning", runtime: "cluster",
      kubernetes: { status: options.migrating ? "ready" : "not-ready", totalPods: 1, readyPods: options.migrating ? 1 : 0, observedAt: options.observedAt ?? NOW - 500,
        pods: [{ name: POD_NAME, uid: options.observedUid ?? POD_UID, nodeName: "node-a", replicaSetUid: "rs-a", instanceId: null, nodePool: null }] },
      heartbeat: { status: "unreachable", mountedCustomers: [] }, createdAt: NOW - 1000,
    },
  });
  const store = createDocumentFixtureStore(documents);
  await store.gateways.assignments.put({ ...ASSIGNMENT, epoch: options.assignedEpoch ?? ASSIGNMENT.epoch,
    ...(options.migrating && options.quiesced !== false ? { state: "quiescing", updatedByOperationId: OPERATION } : {}),
  });
  if (options.migrating) {
    await store.users.records.setFence(UID, "migration", { operationId: OPERATION, state: "moving", startedAt: NOW - 80 });
    await store.journal.operations.create({
      id: OPERATION, kind: "migrate-user", status: "running", origin: "automatic", createdBy: "glm-controller-placement-policy",
      createdAt: NOW - 100, startedAt: NOW - 40, completedAt: null, steps: [],
      input: { fromGatewayId: GATEWAY, toGatewayId: TARGET, uid: UID, userSlug: "alice", source: "continuous-placement-policy" },
    });
    for (const anchor of options.allocated ? [ANCHOR, ARCHIVED] : [ANCHOR]) {
      await store.users.agentStores.put(UID, { kind: "agent", ...anchor, gatewayId: GATEWAY, generation: options.allocated ? ALLOCATION.generation : null,
        assignmentEpoch: 0, recordedAt: NOW });
    }
  }

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.boundTenant = { kind: "gateway", gatewayId: GATEWAY, podName: POD_NAME, podUid: options.boundUid ?? POD_UID };
    next();
  });
  app.use("/internal/fleet", createFleetBrokerRoutes({ store, now: () => NOW }));
  const read = (body: Record<string, unknown> = {}) => request(app).post("/internal/fleet/agent-anchors/read").send({ ...SCOPE, ...body });
  const report = (body: Record<string, unknown> = {}) => request(app).post("/internal/fleet/agent-anchors/report")
    .send({ ...SCOPE, anchors: [ANCHOR], configuredAgentIds: [ANCHOR.agentId], ...body });
  return { app, read, report, store };
}

describe("agent anchors on an assignment-backed isolated Pod", () => {
  it("reads and writes the observed first owner Pod before gateway readiness, without an allocation", async () => {
    const { read, report, store } = await fixture();
    await read().expect(200, { anchors: [] });
    const state = { storeId: "266fe67a-db6e-4df9-8441-3dfd8a13eaef", schema: "octogee_gateway_state" };
    const auxiliary = [{ family: "workboard", storeId: "0db89cd3-f717-4782-a72f-97e1d31ba52a", schema: "octogee_workboard" }];
    await report({ state, auxiliary }).expect(204);
    await read().expect(200, { anchors: [ANCHOR], state, auxiliary });
    const records = await store.users.agentStores.list(UID);
    expect(records).toHaveLength(3);
    for (const record of records) expect(record).toMatchObject({ gatewayId: GATEWAY, generation: null, assignmentEpoch: 0 });
    await report({ anchors: [{ ...ANCHOR, schema: "octogee_agent_wrong" }] }).expect(409);
  });

  it.each([
    ["wrong authenticated Pod", { boundUid: OTHER_POD }],
    ["replaced Pod", { observedUid: OTHER_POD }],
    ["stale Kubernetes observation", { observedAt: NOW - GATEWAY_UNREACHABLE_AFTER_MS - 1 }],
    ["retired gateway", { root: { desiredStatus: "retired" } }],
    ["foreign user mirror", { mirrorGatewayId: "other-gateway" }],
  ] as const)("rejects both anchor operations for %s", async (_reason, options) => {
    const { read, report, store } = await fixture(options);
    await read().expect(403);
    await report().expect(403);
    expect(await store.users.agentStores.list(UID)).toEqual([]);
  });

  it("rejects stale explicit assignment epochs and keeps allocation-only native backups fenced", async () => {
    const { app, read, report, store } = await fixture();
    await read({ assignmentEpoch: 1 }).expect(403);
    await report({ assignmentEpoch: 1 }).expect(403);
    await read({ uid: "uid-other" }).expect(403);
    await report({ uid: "uid-other" }).expect(403);
    await request(app).post("/internal/fleet/builder-runtime-state/download-url").send(SCOPE).expect(403);
    expect(await store.users.agentStores.list(UID)).toEqual([]);
  });

  it("does not read or overwrite a same-key anchor from an older assignment epoch", async () => {
    const { read, report, store } = await fixture({ assignedEpoch: 1 });
    const stale = { kind: "agent", ...ANCHOR, gatewayId: GATEWAY, generation: null, assignmentEpoch: 0, recordedAt: NOW } as const;
    await store.users.agentStores.put(UID, stale);
    await read().expect(200, { anchors: [] });
    await report().expect(409);
    expect(await store.users.agentStores.list(UID)).toEqual([expect.objectContaining(stale)]);
  });

  it("fences anchor reads and writes after an owner assignment epoch changes", async () => {
    for (const path of ["read", "report"] as const) {
      const { read, report, store } = await fixture();
      const transact = store.transaction.bind(store);
      const label = path === "read" ? "fleet-broker.read-agent-anchors" : "fleet-broker.record-agent-anchors";
      const observe = vi.spyOn(store, "transaction").mockImplementation((async (options, work) => {
        if (options.label === label) {
          await store.gateways.assignments.put({ ...ASSIGNMENT, epoch: 1 });
        }
        return transact(options, work);
      }) as PlatformStateStore["transaction"]);
      await (path === "read" ? read() : report()).expect(403);
      expect(observe.mock.calls.some(([options]) => options.label === label)).toBe(true);
      expect(await store.users.agentStores.list(UID)).toEqual([]);
    }
  });
});

describe("allocation-free isolated outbound source anchor reads", () => {
  const outbound = { migrationId: MIGRATION, uid: UID };
  const live = { migrating: true, root: { liveRelease: 1 } };

  it("reads the current source owner's anchors during the exact move without granting a report", async () => {
    const { read, report, store } = await fixture(live);
    await read(outbound).expect(200, { anchors: [ANCHOR] });
    await report(outbound).expect(403);
    await read().expect(403);
    expect(await store.users.agentStores.list(UID)).toHaveLength(1);
  });

  it.each([
    ["a different Pod", { boundUid: OTHER_POD }],
    ["a stale Pod observation", { observedAt: NOW - GATEWAY_UNREACHABLE_AFTER_MS - 1 }],
  ] as const)("rejects %s", async (_reason, options) => {
    const { read } = await fixture({ ...live, ...options });
    expect((await read(outbound)).status).toBe(403);
  });

  it("rejects a foreign owner, epoch, operation, pending claim, and committed cutover", async () => {
    const { read, store } = await fixture(live);
    await read({ ...outbound, uid: "uid-other" }).expect(403);
    await read({ ...outbound, assignmentEpoch: 1 }).expect(403);
    await read({ ...outbound, migrationId: "mig-some-other-operation" }).expect(403);
    await store.journal.operations.patch(OPERATION, { status: "pending", startedAt: null });
    await read(outbound).expect(403);
    await store.journal.operations.patch(OPERATION, { status: "running", startedAt: NOW - 30, cutoverCommittedAt: NOW - 1 });
    expect((await read(outbound)).status).toBe(403);
  });

  it("refuses source anchor reads when a different gateway also holds an assignment", async () => {
    const { read, store } = await fixture(live);
    await store.gateways.assignments.put({ ...ASSIGNMENT, gatewayId: "shared-other" });
    expect((await read(outbound)).status).toBe(403);
  });

  it("rechecks the same active claim inside the anchor read transaction", async () => {
    const { read, store } = await fixture(live);
    const transact = store.transaction.bind(store);
    const observe = vi.spyOn(store, "transaction").mockImplementation((async (options, work) => {
      if (options.label === "fleet-broker.read-agent-anchors") {
        await store.journal.operations.patch(OPERATION, { startedAt: NOW - 20 });
      }
      return transact(options, work);
    }) as PlatformStateStore["transaction"]);
    await read(outbound).expect(403);
    expect(observe.mock.calls.some(([options]) => options.label === "fleet-broker.read-agent-anchors")).toBe(true);
  });
});

describe("an isolated source's anchor read at pre-sync, before quiesce", () => {
  const outbound = { migrationId: MIGRATION, uid: UID };
  const preSync = { migrating: true, quiesced: false, root: { liveRelease: 1 } };

  it("reads an allocation-free source owner's anchors for the running move while its assignment still serves the user, without granting a report", async () => {
    const { read, report, store } = await fixture(preSync);
    await read(outbound).expect(200, { anchors: [ANCHOR] });
    await report(outbound).expect(403);
    await read().expect(403);
    expect(await store.users.agentStores.list(UID)).toHaveLength(1);
  });

  it.each([
    ["another move", async (_store: PlatformStateStore) => ({ migrationId: "mig-some-other-operation" })],
    ["a pending move", async (store: PlatformStateStore) => { await store.journal.operations.patch(OPERATION, { status: "pending", startedAt: null }); return {}; }],
    ["a cut-over move", async (store: PlatformStateStore) => { await store.journal.operations.patch(OPERATION, { cutoverCommittedAt: NOW - 1 }); return {}; }],
    ["no move fence on the user", async (store: PlatformStateStore) => { await store.users.records.setFence(UID, "migration", { clear: true }); return {}; }],
  ] as const)("refuses an allocation-free source's pre-quiesce read for %s", async (_reason, change) => {
    const { read, store } = await fixture(preSync);
    const body = await change(store);
    expect((await read({ ...outbound, ...body })).status).toBe(403);
  });

  it("reads an allocated source owner's full anchors, an archived project agent's included, for the running move", async () => {
    const { read, report } = await fixture({ ...preSync, allocated: true });
    const response = await read(outbound);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.anchors).toEqual([ANCHOR, ARCHIVED]);
    await report(outbound).expect(403);
  });
});
