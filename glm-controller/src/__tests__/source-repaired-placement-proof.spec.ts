import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import { expect, it } from "vitest";
import { repairedPlacementProofMatches, repairedPostgresSourceConverged } from "../placement-policy-reconciler.js";

function fixture() {
  const request = { uid: "owner", builderSlug: "livefixture", fromGatewayId: "shared-old", toGatewayId: "shared-new", operationId: "placement", source: "continuous-placement-policy" as const };
  const assignment = { uid: request.uid, slug: request.builderSlug, agentId: "octogee-livefixture-coach", assignmentEpoch: 7,
    assignment: { uid: request.uid, slug: request.builderSlug, gatewayId: request.fromGatewayId, state: "serving", epoch: 7 } };
  const error = "/finish-rsync-import/shared-new: 500 " + JSON.stringify({ error: "import failed", message:
    "[import:livefixture] agents.create failed for octogee-livefixture-coach (AgentDatabaseMaintenanceRequiredError: Agent identity migration requires stopped-writer maintenance; stop active agents and run openclaw doctor --fix.)" });
  const original: any = { kind: "migrate-user", status: "failed", origin: "automatic", createdBy: "glm-controller-placement-policy", attempts: 1,
    startedAt: 100, completedAt: 200, rolledBack: true, error,
    input: { uid: request.uid, userSlug: request.builderSlug, fromGatewayId: request.fromGatewayId, toGatewayId: request.toGatewayId, source: request.source },
    schedulerHandoff: { migrationId: "mig-placement:scheduler:1:claim:100", uid: request.uid, slug: request.builderSlug, fromGatewayId: request.fromGatewayId, toGatewayId: request.toGatewayId },
    steps: [...["keys-sync-state", "pre-sync-state", "wait-for-active-work", "quiesce-source", "flush-source"].map(name => ({ name, status: "done" })),
      { name: "final-sync-state", status: "failed", error }, ...["unmount-target", "resume-ingress"].map(name => ({ name: `rollback:${name}`, status: "done" }))] };
  original.attemptHistory = [{ attempt: 1, startedAt: 100, completedAt: 200, error, steps: structuredClone(original.steps) }];
  const images = { gateway: "registry/gateway:aaaaaaaa@sha256:" + "a".repeat(64), "gateway-edge": "registry/edge:aaaaaaaa@sha256:" + "b".repeat(64) };
  const stores = [assignment.agentId, "octogee-livefixture-proj-launch-coach"].map((agentId, index) => ({ uid: request.uid, slug: request.builderSlug, assignmentEpoch: 7,
    agentId, storeId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, schema: `agent_${index}` }));
  const repair: any = { id: "repair", kind: "restart-gateway", status: "succeeded", startedAt: 250, input: { gatewayId: request.fromGatewayId,
    sourceRecovery: { sourceSha: "c".repeat(40), images, assignments: [assignment], postgresAgentStores: stores } },
    sourceRuntimeRecovery: { gatewayId: request.fromGatewayId, sourceSha: "c".repeat(40), images, podUid: "source-pod", completedAt: 400,
      doctor: { requestId: "repair", releaseKey: "installed-image-build", startedAt: 310, completedAt: 350, verifiedAgentIds: stores.map(store => store.agentId) },
      installedImage: { podUid: "source-pod", gatewayImageId: "docker-pullable://" + images.gateway, verifiedAt: 300 },
      managementHealth: { attemptId: "repair", bootId: "fresh-boot", health: true } } };
  const data = { ...original };
  return { request, original, data, repair };
}
it("accepts only the complete captured PostgreSQL repair proof for placement rearm", () => {
  const f = fixture(); expect(repairedPlacementProofMatches(f.data, f.repair, f.request)).toBe(true);
});
it.each(["cutover", "rollback", "store-owner", "store-epoch", "duplicate-uuid", "missing-coach", "doctor-project", "doctor-owner", "doctor-time", "release-key", "image", "pod", "health", "source-image", "cancelled", "old-repair"])("refuses PostgreSQL placement rearm with %s", change => {
  const f: any = fixture(), source = f.repair.input.sourceRecovery, completed = f.repair.sourceRuntimeRecovery;
  if (change === "cutover") f.data.cutoverCommittedAt = 180;
  if (change === "rollback") f.data.rolledBack = false;
  if (change === "store-owner") source.postgresAgentStores[1].uid = "foreign";
  if (change === "store-epoch") source.postgresAgentStores[1].assignmentEpoch = 8;
  if (change === "duplicate-uuid") source.postgresAgentStores[1].storeId = source.postgresAgentStores[0].storeId;
  if (change === "missing-coach") source.postgresAgentStores.shift();
  if (change === "doctor-project") completed.doctor.verifiedAgentIds.pop();
  if (change === "doctor-owner") completed.doctor.requestId = "foreign";
  if (change === "doctor-time") completed.doctor.completedAt = 500;
  if (change === "release-key") completed.doctor.releaseKey = "";
  if (change === "image") completed.installedImage.gatewayImageId = "other@sha256:" + "f".repeat(64);
  if (change === "pod") completed.installedImage.podUid = "other";
  if (change === "health") completed.managementHealth.health = false;
  if (change === "source-image") completed.images = { ...completed.images, gateway: "other" };
  if (change === "cancelled") f.repair.cancellationRequestedAt = 400;
  if (change === "old-repair") f.repair.startedAt = 199;
  expect(repairedPlacementProofMatches(f.data, f.repair, f.request)).toBe(false);
});
it("accepts a completed repair after a rollback regardless of error text or attempt count", () => {
  const f = fixture();
  f.data.error = "a different native maintenance error";
  f.data.attempts = 2;
  f.data.attemptHistory = [];
  expect(repairedPlacementProofMatches(f.data, f.repair, f.request)).toBe(true);
});


function convergedFixture() {
  const f = fixture();
  const payload = { imageRepository: "registry/gateway", imageTag: "aaaaaaaa@sha256:" + "a".repeat(64) };
  f.repair.input.sourceRecovery.payload = payload;
  f.repair.sourceRuntimeRecovery.release = { release: 2, operationId: "rollout-repair" };
  const source: any = { gatewayId: f.request.fromGatewayId, gatewayClass: "shared", ownerUid: null, builderSlug: null, desiredStatus: "draining", latestRelease: 2, desiredRelease: 2, liveRelease: 2 };
  const runtime: any = { docKind: "runtime", gatewayId: f.request.fromGatewayId, release: 2, lifecycle: "serving",
    heartbeat: { status: "ready", lastHeartbeatAt: 450 }, helm: { imageRepository: payload.imageRepository, imageTag: payload.imageTag } };
  const release: any = { gatewayId: f.request.fromGatewayId, release: 2, payload, payloadHash: releasePayloadHash(payload) };
  return { ...f, source, runtime, release };
}
it("allows PostgreSQL placement rearm only after the adopted source release actually converges", () => {
  const f = convergedFixture();
  expect(repairedPostgresSourceConverged({ source: f.source, runtime: f.runtime, release: f.release, repair: f.repair, request: f.request, now: 500 })).toBe(true);
});
it.each(["desired-only", "old-runtime", "stale-heartbeat", "future-heartbeat", "unready", "old-image", "bad-hash", "different-payload", "fenced", "retired", "owner", "release-owner", "wrong-release"])("blocks pending PostgreSQL source convergence with %s without changing proof/history", change => {
  const f = convergedFixture();
  if (change === "desired-only") f.source.liveRelease = 1;
  if (change === "old-runtime") f.runtime.release = 1;
  if (change === "stale-heartbeat") f.runtime.heartbeat.lastHeartbeatAt = -1000000;
  if (change === "future-heartbeat") f.runtime.heartbeat.lastHeartbeatAt = 600;
  if (change === "unready") f.runtime.heartbeat.status = "booting";
  if (change === "old-image") f.runtime.helm.imageTag = "old@sha256:" + "f".repeat(64);
  if (change === "bad-hash") f.release.payloadHash = "wrong";
  if (change === "different-payload") f.repair.input.sourceRecovery.payload = { ...f.release.payload, imageTag: "different" };
  if (change === "fenced") f.source.runtimeRestartFence = {};
  if (change === "retired") f.source.desiredStatus = "retired";
  if (change === "owner") f.source.ownerUid = "foreign";
  if (change === "release-owner") f.release.gatewayId = "foreign";
  if (change === "wrong-release") f.release.release = 1;
  const before = structuredClone({ data: f.data, repair: f.repair });
  expect(repairedPostgresSourceConverged({ source: f.source, runtime: f.runtime, release: f.release, repair: f.repair, request: f.request, now: 500 })).toBe(false);
  expect({ data: f.data, repair: f.repair }).toEqual(before);
});
it("recognizes later source convergence without consuming the recorded repair proof", () => {
  const f = convergedFixture(); f.source.liveRelease = 1;
  expect(repairedPostgresSourceConverged({ source: f.source, runtime: f.runtime, release: f.release, repair: f.repair, request: f.request, now: 500 })).toBe(false);
  f.source.liveRelease = 2;
  expect(repairedPostgresSourceConverged({ source: f.source, runtime: f.runtime, release: f.release, repair: f.repair, request: f.request, now: 500 })).toBe(true);
});
