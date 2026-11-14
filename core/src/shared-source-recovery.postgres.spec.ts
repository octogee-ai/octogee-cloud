import { expect, it } from "vitest";
import type { DocumentData } from "firebase-admin/firestore";
import { Firestore as FirestoreClient } from "firebase-admin/firestore";
import { assertSharedSourceRecoveryPredecessor, readPostgresSourceAgentStores, readSharedSourceRecoveryAuthority, type SourceRecoveryAssignment } from "./shared-source-recovery.js";
import { buildOperationAuditIntent, operationAuditMutationFingerprint } from "./operation-audit.js";
import { MalformedRecordError } from "./platform-state/errors.js";
import type { PlatformStateTransaction } from "./platform-state/store.js";
import { createDocumentFixtureStore } from "./testing/journal-store.js";
const identity: SourceRecoveryAssignment = { uid: "owner", slug: "livefixture", agentId: "octogee-livefixture-coach", assignmentEpoch: 7,
  assignment: { uid: "owner", slug: "livefixture", gatewayId: "shared-old", source: "onboarding", state: "serving", epoch: 7,
    createdAt: 1, updatedAt: 1, updatedByOperationId: null } };
function fixture(migration: "identity" | "database" = "identity") {
  const error = "/finish-rsync-import/shared-new: 500 " + JSON.stringify({ error: "import failed", message:
    `[import:livefixture] agents.create failed for octogee-livefixture-coach (AgentDatabaseMaintenanceRequiredError: Agent ${migration} migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.)` });
  const row = { kind: "migrate-user", status: "failed", origin: "automatic", createdBy: "glm-controller-placement-policy", attempts: 1,
    startedAt: 100, completedAt: 200, rolledBack: true, error,
    input: { uid: "owner", userSlug: "livefixture", fromGatewayId: "shared-old", toGatewayId: "shared-new", source: "continuous-placement-policy" },
    schedulerHandoff: { migrationId: "mig-placement:scheduler:1:claim:100", uid: "owner", slug: "livefixture", fromGatewayId: "shared-old", toGatewayId: "shared-new" },
    steps: [...["keys-sync-state", "pre-sync-state", "wait-for-active-work", "quiesce-source", "flush-source"].map(name => ({ name, status: "done" })),
      { name: "final-sync-state", status: "failed", error }, ...["unmount-target", "resume-ingress"].map(name => ({ name: `rollback:${name}`, status: "done" }))] };
  return { ...row, attemptHistory: [{ attempt: 1, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: structuredClone(row.steps) }] };
}
function readOnly<T>(rows: Record<string, any>, body: (transaction: PlatformStateTransaction) => Promise<T>): Promise<T> {
  return createDocumentFixtureStore(rows).transaction({ label: "test.shared-source-recovery", readOnly: true }, body);
}
function rosterFixture() {
  const anchors = [identity.agentId, "octogee-livefixture-proj-launch-coach"].map((agentId, index) => ({ agentId, gatewayId: "shared-old", assignmentEpoch: 7,
    storeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, schema: `agent_${index}`, recordedAt: 1 }));
  const project: Record<string, unknown> = { ownerUid: identity.uid, agent: { enabled: true } };
  const rows: Record<string, any> = { "workspaces/livefixture/projects/launch": project };
  for (const anchor of anchors) rows[`users/owner/agentStores/${anchor.agentId}`] = anchor;
  const read = () => readOnly(rows, transaction => readPostgresSourceAgentStores(transaction, [identity]));
  return { anchors, project, rows, read };
}
it("captures every recorded owned PostgreSQL anchor including project history", async () => {
  const f = rosterFixture();
  expect(await f.read()).toEqual(f.anchors.map(({ agentId, storeId, schema }) => ({ uid: "owner", slug: "livefixture", assignmentEpoch: 7, agentId, storeId, schema })));
});
it.each(["missing-project", "foreign-owner", "epoch", "agent", "store", "schema", "duplicate-uuid"])("refuses a PostgreSQL source roster with %s", async change => {
  const f = rosterFixture();
  if (change === "missing-project") delete f.rows[`users/owner/agentStores/${f.anchors[1]!.agentId}`];
  if (change === "foreign-owner") f.anchors[0]!.gatewayId = "user-new-owner";
  if (change === "epoch") f.anchors[0]!.assignmentEpoch++;
  if (change === "agent") f.anchors[0]!.agentId = "octogee-foreign-coach";
  if (change === "store") f.anchors[0]!.storeId = "invalid";
  if (change === "schema") f.anchors[0]!.schema = "unsafe;schema";
  if (change === "duplicate-uuid") f.anchors[1]!.storeId = f.anchors[0]!.storeId;
  await expect(f.read()).rejects.toThrow();
});


function authorityFixture(migration: "identity" | "database" = "identity") {
  const anchor = { agentId: identity.agentId, gatewayId: "shared-old", assignmentEpoch: 7, storeId: "00000000-0000-4000-8000-000000000001", schema: "agent_owned", recordedAt: 1 };
  const rows: Record<string, any> = {
    "gateways/shared-old": { gatewayId: "shared-old", gatewayClass: "shared", ownerUid: null, builderSlug: null, desiredStatus: "draining", liveRelease: 1, desiredRelease: 1, latestRelease: 1 },
    "gateways/shared-old/assignments/owner": structuredClone(identity.assignment),
    "users/owner": { username: "livefixture", provisioning: { openclaw: { gatewayId: "shared-old", status: "complete" } } },
    ["users/owner/agentStores/" + identity.agentId]: anchor,
    "glmOperations/placement": fixture(migration),
  };
  const read = () => readOnly(rows, transaction => readSharedSourceRecoveryAuthority(transaction, "shared-old"));
  return { rows, read };
}
const allocationAnchor = { gatewayId: "retained-user", generation: 114, storeId: "00000000-0000-4000-8000-000000000003", schema: "agent_user_default", recordedAt: 1 };

it.each(["identity", "database"] as const)("captures the fully qualified PostgreSQL source authority without changing the %s failed operation", async migration => {
  const f = authorityFixture(migration), before = structuredClone(f.rows);
  const captured = await f.read();
  expect(captured.postgresAgentStores).toEqual([{ uid: "owner", slug: "livefixture", assignmentEpoch: 7, agentId: identity.agentId,
    storeId: "00000000-0000-4000-8000-000000000001", schema: "agent_owned" }]);
  expect(f.rows).toEqual(before);
});
it("captures each assignment as its stored record without the store revision", async () => {
  const captured = await authorityFixture().read();
  expect(captured.assignments).toEqual([{ uid: "owner", slug: "livefixture", agentId: identity.agentId, assignmentEpoch: 7, assignment: identity.assignment }]);
  expect(captured.assignments[0]!.assignment).not.toHaveProperty("revision");
});
it("captures tenant stores from a mixed registry while retaining the old user's allocation anchors", async () => {
  const f = authorityFixture("database");
  const projectId = "octogee-livefixture-proj-launch-coach";
  f.rows["workspaces/livefixture/projects/launch"] = { ownerUid: "owner", agent: { enabled: true } };
  f.rows["users/owner/agentStores/" + projectId] = { agentId: projectId, gatewayId: "shared-old", assignmentEpoch: 7,
    storeId: "00000000-0000-4000-8000-000000000002", schema: "agent_project", recordedAt: 1 };
  f.rows["users/owner/agentStores/octogee-unmatched-route"] = { agentId: "octogee-unmatched-route", gatewayId: "retained-user", generation: 114,
    storeId: "00000000-0000-4000-8000-000000000003", schema: "agent_user_default", recordedAt: 1 };
  f.rows["users/owner/agentStores/_gateway-state"] = { kind: "gateway-state", gatewayId: "retained-user", generation: 114,
    storeId: "00000000-0000-4000-8000-000000000004", schema: "state_user", recordedAt: 1 };
  const before = structuredClone(f.rows);
  const captured = await f.read();
  expect(captured.postgresAgentStores).toEqual([
    { uid: "owner", slug: "livefixture", assignmentEpoch: 7, agentId: identity.agentId, storeId: "00000000-0000-4000-8000-000000000001", schema: "agent_owned" },
    { uid: "owner", slug: "livefixture", assignmentEpoch: 7, agentId: projectId, storeId: "00000000-0000-4000-8000-000000000002", schema: "agent_project" },
  ]);
  expect(f.rows).toEqual(before);
});
it("refuses a service-like allocation record without changing it", async () => {
  const f = authorityFixture("database"), id = "octogee-unmatched-route-extra";
  f.rows["users/owner/agentStores/" + id] = { agentId: id, ...allocationAnchor };
  const before = structuredClone(f.rows);
  await expect(f.read()).rejects.toThrow("source recovery PostgreSQL anchor custody changed");
  expect(f.rows).toEqual(before);
});
it.each(["missing-agent-id", "foreign-agent-id", "tenant-agent-id"])("fails closed on an allocation record with %s without changing it", async changed => {
  const f = authorityFixture("database");
  f.rows["users/owner/agentStores/octogee-unmatched-route"] = { ...allocationAnchor,
    agentId: changed === "missing-agent-id" ? undefined : changed === "foreign-agent-id" ? "octogee-foreign-coach" : identity.agentId };
  const before = structuredClone(f.rows);
  await expect(f.read()).rejects.toBeInstanceOf(MalformedRecordError);
  expect(f.rows).toEqual(before);
});
it("fails closed on a tenant anchor that names another agent without changing it", async () => {
  const f = authorityFixture("database");
  f.rows["users/owner/agentStores/" + identity.agentId].agentId = "octogee-foreign-coach";
  const before = structuredClone(f.rows);
  await expect(f.read()).rejects.toBeInstanceOf(MalformedRecordError);
  expect(f.rows).toEqual(before);
});
it.each(["foreign-user", "gateway", "epoch", "store-id", "schema"])("retains current tenant custody validation with allocation records present: %s", async changed => {
  const f = authorityFixture("database");
  f.rows["users/owner/agentStores/octogee-unmatched-route"] = { agentId: "octogee-unmatched-route", ...allocationAnchor };
  const anchor = f.rows["users/owner/agentStores/" + identity.agentId];
  if (changed === "foreign-user") f.rows["users/owner/agentStores/octogee-foreign-coach"] = { ...anchor, agentId: "octogee-foreign-coach" };
  if (changed === "gateway") anchor.gatewayId = "foreign-user";
  if (changed === "epoch") anchor.assignmentEpoch++;
  if (changed === "store-id") anchor.storeId = "malformed";
  if (changed === "schema") anchor.schema = "unsafe;schema";
  const before = structuredClone(f.rows);
  await expect(f.read()).rejects.toThrow("source recovery PostgreSQL anchor custody changed");
  expect(f.rows).toEqual(before);
});
it("refuses PostgreSQL recovery while a running source transfer task retains custody", async () => {
  const f = authorityFixture();
  f.rows["glmMigrationTransferTasks/task"] = { status: "running", sourceGatewayId: "shared-old", targetGatewayId: "other" };
  await expect(f.read()).rejects.toThrow("transfer task is active");
});
it("allows unrelated active housekeeping and transfer tasks", async () => {
  const f = authorityFixture();
  f.rows["glmMigrationTransferTasks/task"] = { status: "running", sourceGatewayId: "unrelated", targetGatewayId: "another" };
  f.rows["glmOperations/housekeeping"] = { kind: "housekeeping", status: "running", input: {} };
  await expect(f.read()).resolves.toHaveProperty("postgresAgentStores");
});


function addPostgresSourceRoster(f: ReturnType<typeof authorityFixture>): void {
  for (const [index, slug] of ["secondfixture", "thirdfixture", "fourthfixture"].entries()) {
    const uid = `owner-${index}`, operationId = `placement-${index}`, agentId = `octogee-${slug}-coach`;
    f.rows[`gateways/shared-old/assignments/${uid}`] = { ...identity.assignment, uid, slug, epoch: index + 8 };
    f.rows[`users/${uid}`] = { username: slug, provisioning: { openclaw: { gatewayId: "shared-old", status: "complete" } } };
    f.rows[`users/${uid}/agentStores/${agentId}`] = { agentId, gatewayId: "shared-old", assignmentEpoch: index + 8,
      storeId: `00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`, schema: `agent_owner_${index}`, recordedAt: 1 };
    const row = fixture("database");
    row.error = row.error.replaceAll("livefixture", slug);
    Object.assign(row.input, { uid, userSlug: slug });
    Object.assign(row.schedulerHandoff, { uid, slug, migrationId: `mig-${operationId}:scheduler:1:claim:${row.startedAt}` });
    row.steps = row.steps.map(step => "error" in step ? { ...step, error: row.error } : step);
    row.attemptHistory = [{ attempt: 1, startedAt: row.startedAt, completedAt: row.completedAt, error: row.error, steps: structuredClone(row.steps) }];
    f.rows[`glmOperations/${operationId}`] = row;
  }
  for (const [index, project] of ["launch", "second", "third"].entries()) {
    const uid = index === 2 ? "owner-0" : identity.uid, slug = index === 2 ? "secondfixture" : identity.slug;
    const agentId = `octogee-${slug}-proj-${project}-coach`;
    f.rows[`workspaces/${slug}/projects/${project}`] = { ownerUid: uid, agent: { enabled: true } };
    f.rows[`users/${uid}/agentStores/${agentId}`] = { agentId, gatewayId: "shared-old", assignmentEpoch: index === 2 ? 8 : 7,
      storeId: `00000000-0000-4000-8000-${String(index + 5).padStart(12, "0")}`, schema: `agent_project_${index}`, recordedAt: 1 };
  }
  f.rows["users/owner/agentStores/octogee-unmatched-route"] = { agentId: "octogee-unmatched-route", ...allocationAnchor, generation: 9,
    storeId: "00000000-0000-4000-8000-000000000099" };
}
async function spentPostgresPredecessorFixture(fullRoster = false) {
  const f = authorityFixture();
  if (fullRoster) addPostgresSourceRoster(f);
  const source = await f.read();
  const images = { gateway: "registry/gateway:aaaaaaaa@sha256:" + "a".repeat(64), "gateway-edge": "registry/edge:aaaaaaaa@sha256:" + "b".repeat(64) };
  const sourceSha = "c".repeat(40), operationId = "spent-pg-repair";
  const row = { kind: "restart-gateway", status: "failed", startedAt: 300, completedAt: 600,
    error: "source repair is not ready; outcome remains fenced", input: { gatewayId: "shared-old", sourceRecovery: { ...structuredClone(source), sourceSha, images } } };
  const fence = { kind: "source-recovery", phase: "dispatched", attemptId: operationId, auditId: operationId, gatewayId: "shared-old", startedAt: 400,
    doctor: { requestId: operationId, startedAt: 500, releaseKey: "pinned-native-image" },
    target: { podUid: "source-pod", podName: "source-pod-name", sourceSha, images,
      agents: source.assignments.map(({ uid, slug, agentId, assignmentEpoch }) => ({ uid, slug, agentId, assignmentEpoch })),
      postgresAgentStores: source.postgresAgentStores },
    installedImage: { podUid: "source-pod", gatewayImageId: "docker-pullable://" + images.gateway, verifiedAt: 450 } };
  return { gatewayId: "shared-old", operationId, row, fence, source };
}
it("admits an exact spent PostgreSQL Doctor predecessor while retaining its captured anchor roster", async () => {
  const f = await spentPostgresPredecessorFixture(), before = structuredClone(f);
  expect(assertSharedSourceRecoveryPredecessor(f)).toEqual({ operationId: f.operationId, input: f.row.input,
    inputFingerprint: operationAuditMutationFingerprint(f.row.input),
    startedAt: f.row.startedAt, completedAt: f.row.completedAt, error: f.row.error, fence: f.fence });
  expect(f).toEqual(before);
});
it.each(["anchor", "schema", "epoch", "missing-roster"])("refuses a spent PostgreSQL predecessor with changed %s", async change => {
  const f = await spentPostgresPredecessorFixture();
  if (change === "anchor") f.source.postgresAgentStores![0]!.storeId = "00000000-0000-4000-8000-999999999999";
  if (change === "schema") f.source.postgresAgentStores![0]!.schema = "different_store";
  if (change === "epoch") { f.source.assignments[0]!.assignmentEpoch++; f.source.postgresAgentStores![0]!.assignmentEpoch++; }
  if (change === "missing-roster") f.source.postgresAgentStores = [];
  expect(() => assertSharedSourceRecoveryPredecessor(f)).toThrow();
});

async function completedPostgresPredecessorFixture() {
  const f = await spentPostgresPredecessorFixture(true);
  return { ...f, fence: { ...f.fence, doctor: { ...f.fence.doctor, completedAt: 550,
    verifiedAgentIds: f.source.postgresAgentStores!.map(store => store.agentId) } } };
}
it("admits an exact successful seven-tenant Doctor ACK after failed readiness without rewriting that ACK", async () => {
  const f = await completedPostgresPredecessorFixture(), before = structuredClone(f);
  expect(f.source.assignments).toHaveLength(4);
  expect(f.source.postgresAgentStores).toHaveLength(7);
  expect(f.fence.doctor.verifiedAgentIds).not.toContain("octogee-unmatched-route");
  expect(f.fence.doctor.releaseKey).not.toBe(f.row.input.sourceRecovery.sourceSha);
  expect(assertSharedSourceRecoveryPredecessor(f)).toEqual({ operationId: f.operationId, input: f.row.input,
    inputFingerprint: operationAuditMutationFingerprint(f.row.input),
    startedAt: f.row.startedAt, completedAt: f.row.completedAt, error: f.row.error, fence: f.fence });
  expect(f).toEqual(before);
});
it("keeps repeated seven-agent source recovery audit admission within Firestore document depth", async () => {
  const f = await completedPostgresPredecessorFixture();
  const client = new FirestoreClient({ projectId: "synthetic-source-recovery-depth" });
  let operationId = f.operationId, row: DocumentData = structuredClone(f.row), fence: DocumentData = structuredClone(f.fence);
  const sizes: number[] = [], depths: number[] = [];
  const depth = (value: unknown): number => value && typeof value === "object"
    ? 1 + Math.max(0, ...Object.values(value).map(depth)) : 0;
  try {
    for (let generation = 0; generation < 32; generation++) {
      const before = structuredClone({ row, fence });
      const supersede = assertSharedSourceRecoveryPredecessor({ ...f, operationId, row, fence });
      const source = row.input.sourceRecovery;
      const input = { gatewayId: f.gatewayId, sourceRecovery: { ...f.source, sourceSha: source.sourceSha,
        images: source.images, supersede } };
      const audit = buildOperationAuditIntent({ actor: "synthetic-operator", forced: false,
        what: "repair Shared source before export", why: "synthetic repeated failed readiness",
        target: { gatewayId: f.gatewayId }, preActionStatus: f.source.root, mutation: input,
        idempotencyKey: `synthetic-source-recovery-${String(generation).padStart(2, "0")}`, now: () => 1_000 + generation * 100 });
      expect(() => client.batch().create(client.doc(`operationAudits/${audit.id}`), audit.document),
        `source recovery generation ${generation}`).not.toThrow();
      const operation = { kind: "restart-gateway", status: "pending", createdBy: "synthetic-operator",
        createdAt: 1_000 + generation * 100, startedAt: null, completedAt: null, input, steps: [], gatewayId: f.gatewayId };
      expect(() => client.batch().create(client.doc(`glmOperations/recovery-${generation}`), operation)).not.toThrow();
      if (generation > 1) {
        sizes.push(JSON.stringify(audit.document).length, JSON.stringify(operation).length);
        depths.push(depth(audit.document), depth(operation));
      }
      expect({ row, fence }).toEqual(before);
      operationId = `synthetic-recovery-${String(generation).padStart(2, "0")}`;
      const startedAt = 1_000 + generation * 100;
      row = { ...row, startedAt, completedAt: startedAt + 90, input };
      fence = { ...fence, attemptId: operationId, auditId: operationId, startedAt: startedAt + 1,
        doctor: { ...fence.doctor, requestId: operationId, startedAt: startedAt + 3, completedAt: startedAt + 5 },
        installedImage: { ...fence.installedImage, verifiedAt: startedAt + 2 } };
    }
    expect(new Set(sizes.filter((_size, index) => index % 2 === 0)).size).toBe(1);
    expect(new Set(sizes.filter((_size, index) => index % 2 === 1)).size).toBe(1);
    expect(new Set(depths.filter((_depth, index) => index % 2 === 0)).size).toBe(1);
    expect(new Set(depths.filter((_depth, index) => index % 2 === 1)).size).toBe(1);
  } finally {
    await client.terminate();
  }
});
it("captures existing nested predecessor input without copying or losing its integrity", async () => {
  const f = await completedPostgresPredecessorFixture();
  const row: DocumentData = structuredClone(f.row);
  row.input.sourceRecovery.supersede = { operationId: "legacy-parent", input: { sourceRecovery: {
    supersede: { operationId: "legacy-ancestor", input: { immutableHistory: "original" } },
  } } };
  const before = structuredClone(row), captured = assertSharedSourceRecoveryPredecessor({ ...f, row });
  expect(captured.input.sourceRecovery.supersede).toBeUndefined();
  expect(captured.inputFingerprint).toBe(operationAuditMutationFingerprint(before.input));
  expect(row).toEqual(before);
  row.input.sourceRecovery.supersede.input.sourceRecovery.supersede.input.immutableHistory = "changed";
  const changed = assertSharedSourceRecoveryPredecessor({ ...f, row });
  expect(changed.input).toEqual(captured.input);
  expect(changed.inputFingerprint).not.toBe(captured.inputFingerprint);
});
const invalidCompletedDoctors: Array<[string, (doctor: DocumentData) => void]> = [
  ["failed", doctor => { doctor.error = "Doctor refused"; }],
  ["before-start", doctor => { doctor.completedAt = doctor.startedAt - 1; }],
  ["after-failure", doctor => { doctor.completedAt = 601; }],
  ["fractional-completion", doctor => { doctor.completedAt = 550.5; }],
  ["missing-completion", doctor => { delete doctor.completedAt; }],
  ["missing-roster", doctor => { delete doctor.verifiedAgentIds; }],
  ["foreign-request", doctor => { doctor.requestId = "another-recovery"; }],
  ["missing-release", doctor => { delete doctor.releaseKey; }],
  ["empty-release", doctor => { doctor.releaseKey = ""; }],
  ["whitespace-release", doctor => { doctor.releaseKey = " "; }],
  ["overlong-release", doctor => { doctor.releaseKey = "r".repeat(513); }],
  ["unknown-field", doctor => { doctor.ready = true; }],
  ["partial-roster", doctor => { doctor.verifiedAgentIds.pop(); }],
  ["empty-roster", doctor => { doctor.verifiedAgentIds = []; }],
  ["foreign-agent", doctor => { doctor.verifiedAgentIds[0] = "octogee-foreign-coach"; }],
  ["extra-agent", doctor => { doctor.verifiedAgentIds.push("octogee-other-coach"); }],
  ["fallback-agent", doctor => { doctor.verifiedAgentIds.push("octogee-unmatched-route"); }],
  ["duplicate-agent", doctor => { doctor.verifiedAgentIds[1] = doctor.verifiedAgentIds[0]; }],
  ["reordered-roster", doctor => { doctor.verifiedAgentIds.reverse(); }],
];
it.each(invalidCompletedDoctors)("refuses a completed PostgreSQL predecessor with %s Doctor proof", async (_name, change) => {
  const f = await completedPostgresPredecessorFixture();change(f.fence.doctor);
  const before = structuredClone(f);
  expect(() => assertSharedSourceRecoveryPredecessor(f)).toThrow("source recovery predecessor is unavailable");
  expect(f).toEqual(before);
});
it("refuses a default-agent-only ACK when the captured tenant roster also owns project stores", async () => {
  const f = await completedPostgresPredecessorFixture();
  f.fence.doctor.verifiedAgentIds = f.source.assignments.map(assignment => assignment.agentId);
  expect(f.fence.doctor.verifiedAgentIds).toHaveLength(4);
  expect(() => assertSharedSourceRecoveryPredecessor(f)).toThrow("source recovery predecessor is unavailable");
});
it.each(["anchor", "schema", "epoch", "input", "image", "pod", "clock", "cancelled", "running", "completed-recovery"])("retains completed Doctor predecessor %s custody guards", async change => {
  const f = await completedPostgresPredecessorFixture();
  if (change === "anchor") f.source.postgresAgentStores![0]!.storeId = "00000000-0000-4000-8000-999999999999";
  if (change === "schema") f.source.postgresAgentStores![0]!.schema = "different_schema";
  if (change === "epoch") f.source.assignments[0]!.assignmentEpoch++;
  if (change === "input") f.fence.target.sourceSha = "d".repeat(40);
  if (change === "image") f.fence.installedImage.gatewayImageId = "foreign";
  if (change === "pod") f.fence.installedImage.podUid = "another-pod";
  if (change === "clock") f.fence.installedImage.verifiedAt = 501;
  if (change === "cancelled") Object.assign(f.row, { cancellationRequestedAt: 599 });
  if (change === "running") f.row.status = "running";
  if (change === "completed-recovery") Object.assign(f.row, { sourceRuntimeRecovery: {} });
  expect(() => assertSharedSourceRecoveryPredecessor(f)).toThrow();
});

it.each(["commercial", "project-status"])("does not require a retired project's anchor in the live recovery roster: %s", async archive => {
  const f = rosterFixture();
  delete f.rows[`users/owner/agentStores/${f.anchors[1]!.agentId}`];
  Object.assign(f.project, archive === "commercial" ? { commercialLifecycle: { status: "archived" } } : { status: "archived" });
  await expect(f.read()).resolves.toHaveLength(1);
});
it('admits maintenance for the current complete roster without historical migration failures', async () => {
  const f = authorityFixture();
  delete f.rows['glmOperations/placement'];
  f.rows['gateways/shared-old/assignments/other'] = { ...identity.assignment, uid: 'other', slug: 'other', epoch: 3 };
  f.rows['users/other'] = { username: 'other', provisioning: { openclaw: { gatewayId: 'shared-old', status: 'complete' } } };
  f.rows['users/other/agentStores/octogee-other-coach'] = { agentId: 'octogee-other-coach', gatewayId: 'shared-old', assignmentEpoch: 3, storeId: '00000000-0000-4000-8000-000000000002', schema: 'agent_other', recordedAt: 1 };
  const result = await f.read();
  expect(result.postgresAgentStores?.map(store => store.agentId)).toEqual(['octogee-livefixture-coach', 'octogee-other-coach']);
});
