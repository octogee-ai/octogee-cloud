import { describe, expect, it } from "vitest";
import { readForceMigrationPlan, readForceMigrationSource } from "../ops/fleet-force-migration.js";
import { parseFleetArgs, resolveFleetMigrationForce } from "../ops/fleet.js";
import { forceMigrationAssignment, forceMigrationHarness as harness, forceMigrationTarget as target } from "./fleet-force-migration.test-support.js";

describe("Fleet force migration request", () => {
  it("denies an authoritative Shared source even when its gateway ID looks like a user", async () => {
    const h = harness();
    h.docs.get("gateways/builder-a")!.gatewayClass = "shared";
    await expect(readForceMigrationPlan(h.store, target)).rejects.toThrow("Shared");
    expect(h.writes).toEqual([]);
  });

  it("uses the authoritative class rather than the gateway name", async () => {
    const h = harness();
    h.docs.set("gateways/shared-named-user", { ...h.docs.get("gateways/builder-a")!, gatewayId: "shared-named-user" });
    await expect(readForceMigrationSource(h.store, { ...target, fromGatewayId: "shared-named-user" })).resolves.toBeUndefined();
    expect(h.writes).toEqual([]);
  });

  it.each([
    ["unknown class", { gatewayClass: undefined }, "isolated gateway"],
    ["another user owner", { ownerUid: "u2" }, "ownership changed"],
    ["another user slug", { builderSlug: "bob" }, "ownership changed"],
    ["GCE VM", { runtime: "gce-vm" }, "GCE VM transport is not available"],
  ])("refuses %s before mutation", async (_name, changes, error) => {
    const h = harness();
    Object.assign(h.docs.get("gateways/builder-a")!, changes);
    await expect(readForceMigrationPlan(h.store, target)).rejects.toThrow(error);
    expect(h.writes).toEqual([]);
  });

  it("identifies the existing blocked drain without changing its history or custody", async () => {
    const h = harness();
    const before = structuredClone(h.op());
    const result = await readForceMigrationPlan(h.store, target);
    expect(result).toMatchObject({ operationId: "move-1", sourceEpoch: 75 });
    expect(h.op()).toEqual(before);
    expect([...h.docs.values()].filter((doc) => doc.kind === "migrate-user")).toHaveLength(1);
    expect(h.writes).toEqual([]);
  });

  it("plans without writes and permits unrelated pending migrations", async () => {
    const h = harness();
    h.docs.set("glmOperations/queued", { kind: "migrate-user", status: "pending", input: { uid: "u2", fromGatewayId: "builder-a", toGatewayId: "shared-b" } });
    expect(await readForceMigrationPlan(h.store, target)).toMatchObject({ sourceEpoch: 75, attempts: 3 });
    expect(h.writes).toEqual([]);
  });

  it("recognizes the normal graceful drain waiting state without rewriting its steps", async () => {
    const h = harness();
    Object.assign(h.op(), { waitingOn: "builder-idle", attempts: 0, attemptHistory: [], steps: [{ name: "quiesce-source", status: "skipped" }] });
    expect(await readForceMigrationPlan(h.store, target)).toMatchObject({ sourceEpoch: 75, attempts: 0 });
  });

  it("permits observation under only its exact runtime fence and retains user custody checks", async () => {
    const h = harness();
    const request = { auditId: "audit-force", uid: "u1", sourceGatewayId: "builder-a", targetGatewayId: "shared-b", sourceEpoch: 75 };
    const fence = { auditId: "audit-force", gatewayId: "builder-a", attemptId: "attempt-1", phase: "dispatched" };
    h.op().forceDrainRequest = request;
    h.docs.get("gateways/builder-a")!.runtimeRestartFence = fence;
    expect(await readForceMigrationPlan(h.store, target, { request, fence })).toMatchObject({ sourceEpoch: 75 });
    expect(h.writes).toEqual([]);
    h.docs.set("users/u2", { provisioning: { openclaw: { gatewayId: "builder-a", restoreFence: {} } } });
    await expect(readForceMigrationPlan(h.store, target, { request, fence })).rejects.toThrow("custody fences");
  });

  it.each(["fence", "request", "epoch"])("rejects changed %s during restart observation", async (changed) => {
    const h = harness();
    const request = { auditId: "audit-force", uid: "u1", sourceGatewayId: "builder-a", targetGatewayId: "shared-b", sourceEpoch: 75 };
    const fence = { auditId: "audit-force", gatewayId: "builder-a", attemptId: "attempt-1", phase: "dispatched" };
    h.op().forceDrainRequest = { ...request };
    h.docs.get("gateways/builder-a")!.runtimeRestartFence = { ...fence };
    if (changed === "fence") h.docs.get("gateways/builder-a")!.runtimeRestartFence.attemptId = "other";
    if (changed === "request") h.op().forceDrainRequest.auditId = "other";
    if (changed === "epoch") h.docs.get("gateways/builder-a/assignments/u1")!.epoch = 76;
    await expect(readForceMigrationPlan(h.store, target, { request, fence })).rejects.toThrow("restart authority changed");
    expect(h.writes).toEqual([]);
  });

  it.each([
    ["running operation", (h: ReturnType<typeof harness>) => { h.op().status = "running"; h.op().startedAt = 500; }],
    ["terminal operation", (h: ReturnType<typeof harness>) => { h.op().status = "failed"; }],
    ["claimed pending operation", (h: ReturnType<typeof harness>) => { h.op().startedAt = 500; }],
    ["different uid", (h: ReturnType<typeof harness>) => { h.op().input.uid = "u2"; }],
    ["different source", (h: ReturnType<typeof harness>) => { h.op().input.fromGatewayId = "shared-c"; }],
    ["different target", (h: ReturnType<typeof harness>) => { h.op().input.toGatewayId = "shared-c"; }],
    ["unknown operation", (h: ReturnType<typeof harness>) => { h.docs.delete("glmOperations/move-1"); }],
    ["unrelated failure", (h: ReturnType<typeof harness>) => { h.op().attemptHistory[0].steps[1].name = "flush-source"; }],
    ["unsettled target cleanup", (h: ReturnType<typeof harness>) => { h.op().attemptHistory[0].steps.pop(); }],
    ["stale attempt evidence", (h: ReturnType<typeof harness>) => { h.op().attemptHistory[0].attempt = 2; }],
    ["changed source placement", (h: ReturnType<typeof harness>) => { h.docs.get("users/u1")!.provisioning.openclaw.gatewayId = "shared-c"; }],
    ["different migration owner", (h: ReturnType<typeof harness>) => { h.docs.get("users/u1")!.provisioning.openclaw.migration.operationId = "other"; }],
    ["changed source assignment", (h: ReturnType<typeof harness>) => { h.docs.get("gateways/builder-a/assignments/u1")!.uid = "u2"; }],
    ["missing epoch", (h: ReturnType<typeof harness>) => { delete h.docs.get("gateways/builder-a/assignments/u1")!.epoch; }],
    ["target assignment", (h: ReturnType<typeof harness>) => { h.docs.set("gateways/shared-b/assignments/u1", forceMigrationAssignment("shared-b", "u1", "alice")); }],
    ["cutover", (h: ReturnType<typeof harness>) => { h.op().cutoverCommittedAt = 500; }],
    ["accepted restore", (h: ReturnType<typeof harness>) => { h.op().restoreAttempt = { phase: "dispatched" }; }],
    ["accepted transfer", (h: ReturnType<typeof harness>) => { h.op().sourceTransferExecution = { status: "dispatched" }; }],
    ["cancellation", (h: ReturnType<typeof harness>) => { h.op().cancellationRequestedAt = 500; }],
    ["advanced V2 custody", (h: ReturnType<typeof harness>) => { h.op().userMigrationV2 = { phase: "sourceQuiesced" }; }],
    ["user restore fence", (h: ReturnType<typeof harness>) => { h.docs.get("users/u1")!.provisioning.openclaw.restoreFence = {}; }],
    ["user transfer fence", (h: ReturnType<typeof harness>) => { h.docs.get("users/u1")!.provisioning.openclaw.sourceTransferFence = {}; }],
    ["source restart fence", (h: ReturnType<typeof harness>) => { h.docs.get("gateways/builder-a")!.runtimeRestartFence = {}; }],
    ["target restart fence", (h: ReturnType<typeof harness>) => { h.docs.get("gateways/shared-b")!.runtimeRestartFence = {}; }],
    ["retirement", (h: ReturnType<typeof harness>) => { h.docs.get("gateways/builder-a")!.retirementClaim = {}; }],
    ["release drift", (h: ReturnType<typeof harness>) => { h.docs.get("gateways/builder-a")!.desiredRelease = 2; }],
    ["other running migration", (h: ReturnType<typeof harness>) => { h.docs.set("glmOperations/other", { kind: "migrate-user", status: "running", input: { uid: "u2", fromGatewayId: "builder-a", toGatewayId: "shared-b" } }); }],
    ["other tenant restore custody", (h: ReturnType<typeof harness>) => { h.docs.set("users/u2", { provisioning: { openclaw: { gatewayId: "builder-a", restoreFence: {} } } }); }],
    ["retained transfer into source", (h: ReturnType<typeof harness>) => { h.docs.set("users/u2", { provisioning: { openclaw: { gatewayId: "shared-c", sourceTransferFence: { targetGatewayId: "builder-a" } } } }); }],
    ["previous force request", (h: ReturnType<typeof harness>) => { h.op().forceDrainRequest = { auditId: "accepted" }; }],
  ])("rejects %s without creating or changing any journal entry", async (_name, mutate) => {
    const h = harness();
    mutate(h);
    await expect(readForceMigrationPlan(h.store, target)).rejects.toThrow();
    expect(h.writes).toEqual([]);
  });

  it("requires an explicit operation and force flag together", () => {
    const argv = ["--env=test", "migrate-customer", "alice", "--to=shared-b"];
    expect(resolveFleetMigrationForce(parseFleetArgs(argv))).toBeUndefined();
    expect(resolveFleetMigrationForce(parseFleetArgs([...argv, "--force", "--operation=move-1"]))).toBe("move-1");
    for (const flags of [["--force"], ["--operation=move-1"], ["--force=true", "--operation=move-1"],
      ["--force", "--operation"], ["--force", "--operation="], ["--force", "--operation=a/b"],
      ["--force", "--operation=move-1", "--source-transfer=retained-pod"], ["--force", "--operation=move-1", "--unknown"]]) {
      expect(() => resolveFleetMigrationForce(parseFleetArgs([...argv, ...flags]))).toThrow();
    }
  });
});
