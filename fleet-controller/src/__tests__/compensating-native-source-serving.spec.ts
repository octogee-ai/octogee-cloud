import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDocumentFixtureStore } from "@octogee/core-testing/journal-store";
import { verifyFleetRequest } from "@octogee/core/fleet-signature";
import { SIGNATURE_HEADER } from "@octogee/shared/types/fleet-controller";
import { releasePayloadHash } from "@octogee/shared/types/gateway-releases";
import { createCompensatingSourceServingVerifier } from "../lib/compensating-native-source-serving.js";
import type { CompensatingNativeReturnAuthority } from "../lib/compensating-native-return.js";

const keys = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const source = { instanceId: "32", instanceName: "vm-32", zone: "region-1", internalIp: "10.20.30.40", bootDiskId: "41", homeDiskId: "42" };
const scope: CompensatingNativeReturnAuthority = {
  source, sourceGatewayId: "isolated-source", targetGatewayId: "shared-target", sourceEpoch: 5, sourceRelease: 4, targetRelease: 2,
  operationId: "held-return", schedulerMigrationId: "held-scheduler", exclusionId: "held-target", attemptId: "attempt", auditId: "audit",
  uid: "owner-uid", slug: "owner",
};
const gatewayImage = { imageRepository: "registry.example/octogee/octogee-gateway-builder", imageTag: "a8b9c10@sha256:" + "a".repeat(64) };
const edgeImage = { imageRepository: "registry.example/octogee/gateway-edge", imageTag: "a8b9c10@sha256:" + "b".repeat(64) };
const payload = { imageRepository: "registry.example/octogee/octogee-gateway", imageTag: gatewayImage.imageTag,
  profileImages: { isolated: gatewayImage }, gatewayEdgeImage: edgeImage, openclawSourceSha: "f".repeat(40) };
const rootPath = `gateways/${scope.sourceGatewayId}`;
const assignmentPath = `${rootPath}/assignments/${scope.uid}`;
const runtimePath = `glmGateways/${scope.sourceGatewayId}`;
const ready = { ready: true, openclawUp: true, handoffReleased: true, brokerProfilesSettled: true, dashboardBridgeReady: true };

function fixture() {
  const docs = new Map<string, Record<string, unknown>>([
    [`users/${scope.uid}`, { username: scope.slug, provisioning: { openclaw: {
      gatewayId: scope.sourceGatewayId, migration: { operationId: scope.operationId, phase: "transferring", state: "moving", startedAt: 100 },
    } } }],
    [rootPath, { gatewayId: scope.sourceGatewayId, gatewayClass: "isolated", desiredStatus: "running", liveRelease: 4, desiredRelease: 4, latestRelease: 4,
      runtimeRestartFence: { kind: "compensating-native-return", gatewayId: scope.sourceGatewayId, startedAt: 200, attemptId: scope.attemptId, phase: "ingress-resumed" } }],
    [assignmentPath, { uid: scope.uid, slug: scope.slug, gatewayId: scope.sourceGatewayId, state: "quiescing", epoch: 5, source: "migrate-user",
      updatedByOperationId: scope.operationId, createdAt: 100, updatedAt: 201 }],
    [runtimePath, {
      docKind: "runtime", gatewayId: scope.sourceGatewayId, lifecycle: "serving", release: 4, runtime: "gce-vm", vm: { ...source, startedAt: 110, status: "RUNNING" },
      heartbeat: { status: "ready", mountedCustomers: [scope.slug] },
      vmImages: { instanceId: source.instanceId, observedAt: 115, containers: [
        { name: "gateway", running: true, imageReference: `${gatewayImage.imageRepository}:${gatewayImage.imageTag}`, digests: [`${gatewayImage.imageRepository}@${gatewayImage.imageTag.split("@")[1]}`] },
        { name: "gateway-edge", running: true, imageReference: `${edgeImage.imageRepository}:${edgeImage.imageTag}`, digests: [`${edgeImage.imageRepository}@${edgeImage.imageTag.split("@")[1]}`] },
      ] },
    }],
    [`${rootPath}/releases/4`, { gatewayId: scope.sourceGatewayId, release: 4, sourceRelease: null, payload,
      createdAt: 105, createdBy: "fixture", note: null, payloadHash: releasePayloadHash(payload) }],
    [`glmOperations/${scope.operationId}`, { kind: "migrate-user", status: "running", createdAt: 100, startedAt: 201, completedAt: null, attempts: 3, steps: [],
      input: { uid: scope.uid, userSlug: scope.slug, fromGatewayId: scope.sourceGatewayId, toGatewayId: scope.targetGatewayId } }],
  ]);
  const state = { gatewayId: scope.sourceGatewayId, status: "ready", version: "a8b9c10", customers: [scope.slug], migratingIn: [] as string[] };
  const responses = { ready: { ...ready }, state, edge: { service: "gateway-edge", status: "ok" } };
  const store = createDocumentFixtureStore(docs);
  const current = vi.fn(async () => {});
  const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
    expect(options?.redirect).toBe("error");
    if (String(url) === "http://10.20.30.40:3001/health") return Response.json(responses.edge);
    expect(new URL(String(url)).origin).toBe("http://10.20.30.40:3003");
    if (String(url).endsWith("/health")) return Response.json({ status: "ready" });
    if (String(url).endsWith("/surge-ready")) return Response.json(responses.ready);
    const raw = String(options?.body);
    const { requestId } = JSON.parse(raw);
    expect(verifyFleetRequest(keys.publicKey, requestId, raw, new Headers(options?.headers).get(SIGNATURE_HEADER)!)).toBe(true);
    return Response.json(responses.state);
  });
  const verify = createCompensatingSourceServingVerifier({ store, privateKey: keys.privateKey, port: 3003, edgePort: 3001, fetchImpl });
  return { docs, verify, fetchImpl, responses, current };
}

describe("original Native serving after compensating ingress resume", () => {
  it("binds signed stock Fleet readiness and both installed roles to the sole canonical owner", async () => {
    const h = fixture();
    await expect(h.verify(scope, h.current)).resolves.toBeUndefined();
    expect(h.fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("rejects gate drift, wrong owner roster and later epoch without accepting ingress", async () => {
    const gated = fixture();
    gated.responses.ready.handoffReleased = false;
    await expect(gated.verify(scope, gated.current)).rejects.toThrow(/serving witness/);
    const wrongEdge = fixture();
    wrongEdge.responses.edge.service = "wrong-service";
    await expect(wrongEdge.verify(scope, wrongEdge.current)).rejects.toThrow(/serving witness/);
    const wrong = fixture();
    wrong.responses.state.customers.push("other");
    await expect(wrong.verify(scope, wrong.current)).rejects.toThrow(/serving witness/);
    const changed = fixture();
    changed.current.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      changed.docs.get(assignmentPath)!.epoch = scope.sourceEpoch + 1;
    });
    await expect(changed.verify(scope, changed.current)).rejects.toThrow(/serving witness/);
  });
});
