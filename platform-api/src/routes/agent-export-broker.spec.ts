import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { MalformedRecordError } from "@octogee/core/platform-state";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { authorizeAgentExport, registerAgentExportBrokerRoutes } from "./agent-export-broker.js";
import type { OwnerContext } from "./agent-import-broker.js";
import { FeaturePolicy } from "../lib/feature-policy.js";
import { agentExportApproval, type AgentExportRecord } from "../../../gateway-edge/src/lib/agent-export-service.js";
function fixture() {
  const owner: OwnerContext = { uid: "u1", slug: "alice", gatewayId: "shared-a", isAdmin: false, workspacePolicy: { preserveConvergedContextFiles: true } };
  const docs = new Map<string, any>([
    ["users/u1", { provisioning: { openclaw: { gatewayId: "shared-a", slug: "alice", status: "complete" } } }],
    ["workspaces/alice", { id: "ws-alice", ownerUid: "u1" }],
    ["gateways/shared-a", { gatewayId: "shared-a", desiredRelease: 1, latestRelease: 1, desiredStatus: "running" }],
    ["glmGateways/shared-a", { docKind: "runtime", gatewayId: "shared-a", release: 1, lifecycle: "serving" }],
    ["gateways/shared-a/assignments/u1", { uid: "u1", source: "onboarding", state: "serving", epoch: 4, slug: "alice", gatewayId: "shared-a" }],
    ["workspaces/alice/projects/demo", { ownerUid: "u1", provisioningState: "active" }],
  ]);
  return { owner, docs, store: createDocumentFixtureStore(docs) };
}
describe("authored export custody", () => {
  it("keeps the journal completion tied to the saved publishing record and its destination", async () => {
    const { owner, store } = fixture();
    const source = await authorizeAgentExport(store, owner, "octogee-alice-coach");
    const record: AgentExportRecord = {
      kind: "authored-agent-export", id: "export-demo", uid: owner.uid, slug: owner.slug, gatewayId: owner.gatewayId,
      source, destination: { owner: "alice", repo: "demo", branch: "main", head: "a".repeat(40), tree: "b".repeat(40) },
      status: "previewed", changes: [], sourceDigest: "source", assetIdentity: "assets", approvalHash: "",
      createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z",
    };
    record.approvalHash = agentExportApproval(record);
    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerAgentExportBrokerRoutes(router, {
      store, featurePolicy: new FeaturePolicy({ evaluate: async () => ({ isEnabled: () => true }) }),
      readIdentity: async () => ({ name: null, persona: null, emoji: null }),
      blobs: () => { throw new Error("unexpected blob access"); },
    }, () => owner);
    app.use(router);
    app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.sendStatus(error.status ?? 500);
    });
    const client = request(app);
    const path = `/exports/records/${record.id}`;
    const expectedCommit = "c".repeat(40);
    const completion = { ...record, status: "complete", expectedCommit, commitUrl: "https://example.invalid/other" };
    await client.put(path).send(record).expect(204);
    await client.put(path).send(completion).expect(409);
    await client.put(path).send({ ...record, status: "publishing", expectedCommit }).expect(204);
    await client.put(path).send(completion).expect(204);
    await client.get(path).expect(200, {
      ...completion, commitUrl: `https://github.com/alice/demo/commit/${expectedCommit}`,
    });
  });

  it("admits an owned serving shared gateway agent and project without requiring dedicated Native surfaces", async () => {
    const f = fixture();
    expect(await authorizeAgentExport(f.store, f.owner, "octogee-alice-coach")).toMatchObject({ project: null, epoch: 4 });
    expect(await authorizeAgentExport(f.store, f.owner, "octogee-alice-proj-demo-coach")).toMatchObject({ project: "demo" });
  });
  it.each(["quiescing", "missing", "retired", "restart", "transfer", "restore", "foreign", "archived", "owner", "pending-migration", "suspended", "deleting", "inactive-owner", "paused"])("refuses %s source custody", async scenario => {
    const f = fixture(); let agent = "octogee-alice-proj-demo-coach";
    if (scenario === "quiescing") f.docs.get("gateways/shared-a/assignments/u1").state = "quiescing";
    if (scenario === "missing") f.docs.delete("gateways/shared-a/assignments/u1");
    if (scenario === "retired") f.docs.get("gateways/shared-a").retirementClaim = false;
    if (scenario === "restart") f.docs.get("gateways/shared-a").runtimeRestartFence = {};
    if (scenario === "transfer") f.docs.get("users/u1").provisioning.openclaw.sourceTransferFence = {};
    if (scenario === "restore") f.docs.get("users/u1").provisioning.openclaw.restoreFence = {};
    if (scenario === "foreign") agent = "octogee-other-coach";
    if (scenario === "archived") f.docs.get("workspaces/alice/projects/demo").commercialLifecycle = { status: "archived" };
    if (scenario === "owner") f.docs.get("workspaces/alice/projects/demo").ownerUid = "u2";
    if (scenario === "pending-migration") f.docs.get("users/u1").provisioning.openclaw.migration = { operationId: "moving" };
    if (scenario === "suspended") f.docs.get("users/u1").accountLifecycle = { status: "suspended" };
    if (scenario === "deleting") f.docs.get("users/u1").accountLifecycle = { status: "deletion_scheduled" };
    if (scenario === "inactive-owner") f.docs.get("workspaces/alice").ownerActive = false;
    if (scenario === "paused") f.docs.get("gateways/shared-a").desiredStatus = "paused";
    await expect(authorizeAgentExport(f.store, f.owner, agent)).rejects.toThrow();
  });
  it("fails closed on a source assignment that is not a complete record", async () => {
    const f = fixture();
    delete f.docs.get("gateways/shared-a/assignments/u1").source;
    await expect(authorizeAgentExport(f.store, f.owner, "octogee-alice-coach")).rejects.toBeInstanceOf(MalformedRecordError);
  });
});
