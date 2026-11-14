import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { buildOperationAuditIntent } from "@octogee/core/operation-audit";
import { createJournalFixtureStore, fixtureDocumentsAt, journalRowsAtPaths } from "@octogee/core/testing/journal-store";
import type { RestartDriverDeps } from "@octogee/core/gateway-restart-probe";
import { releasePayloadHash } from "../../shared/types/gateway-releases.js";
import { isOperationAuditRecord } from "../../shared/types/glm.js";
import { generateIdentity } from "@octogee/shared/types/device-identity";
import { nativeHealth, nativeProbeSource, resolveForcedGatewayRestart } from "../ops/fleet-resolve-forced-restart.js";

function harness() {
  const payload = {
    imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway",
    imageTag: `${"a".repeat(40)}@sha256:${"a".repeat(64)}`,
    profileImages: { builder: { imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/octogee-gateway-builder", imageTag: `${"a".repeat(40)}@sha256:${"b".repeat(64)}` } },
    gatewayEdgeImage: { imageRepository: "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge", imageTag: `${"a".repeat(40)}@sha256:${"c".repeat(64)}` },
  };
  const fence = { attemptId: "attempt-1", auditId: "audit-restart", gatewayId: "canary", kind: "process", phase: "dispatched", startedAt: 100,
    target: { podName: "octogee-gateway-canary-old", podUid: "old-uid" } };
  const root = {
    gatewayId: "canary", createdAt: 1, createdBy: "test", updatedAt: 1, updatedBy: "test", latestRelease: 1, desiredRelease: 1, liveRelease: 1,
    desiredStatus: "running", configSchemaVersion: 1, profile: "isolated", gatewayClass: "isolated", imageProfile: "isolated", sizingTier: null,
    gcpProject: null, gatewayContainerSecurityContext: null, serviceAccountName: null, serviceAccount: null, builderAccess: null,
    ownerUid: "canary-owner", builderSlug: "canary", modelBrokerLimits: null, preemption: null, runtimeRestartFence: fence,
  };
  function audit(forced: boolean) {
    const intent = buildOperationAuditIntent({ actor: forced ? "operator" : "cowboy", forced, what: "restart", why: "test", idempotencyKey: forced ? "force-1" : "attempt-1",
      target: forced ? { gatewayId: "canary", ...fence.target } : { gatewayId: "canary" }, preActionStatus: {},
      mutation: forced ? { kind: "restart-gateway", gatewayId: "canary", mode: "force-pod-delete" } : { kind: "process", attemptId: "attempt-1" }, now: () => forced ? 250 : 50 });
    return { ...intent.document, status: forced ? "completed" : "failed", lifecycleStage: forced ? "action-completed" : "action-failed",
      outcome: forced ? "completed" : "failed", actionClaimId: "claim-1", actionStartedAt: forced ? 260 : 75, actionRecoveryCount: 0,
      completedAt: forced ? 300 : 200, ...(!forced ? { error: "process restart outcome unresolved" } : {}) };
  }
  const docs = new Map<string, Record<string, any>>([
    ["gateways/canary", root], ["glmOperations/audit-restart", audit(false)], ["glmOperations/audit-force", audit(true)],
    ["gateways/canary/releases/1", { gatewayId: "canary", release: 1, payload, payloadHash: releasePayloadHash(payload) }],
    ["users/canary-owner", { provisioning: { openclaw: { gatewayId: "canary" } } }],
  ]);
  const writes: Array<{ path: string; data: Record<string, any> }> = [];
  const documents = fixtureDocumentsAt(docs);
  const store = createJournalFixtureStore(journalRowsAtPaths(docs), {
    documents: { ...documents, set: (path, data) => { writes.push({ path, data }); documents.set(path, data); } },
  });
  const images = [payload.profileImages.builder, payload.gatewayEdgeImage].map(image => `${image.imageRepository}:${image.imageTag}`);
  const containers = ["gateway", "gateway-edge"].map((name, index) => ({ name, image: images[index] }));
  const pod: any = { metadata: { name: "octogee-gateway-canary-new", uid: "new-uid", creationTimestamp: new Date(350).toISOString(),
    labels: { "gateway-instance": "canary" }, ownerReferences: [{ uid: "rs-uid", controller: true }] }, spec: { containers: structuredClone(containers) },
    status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: containers.map(row => ({ name: row.name, ready: true, state: { running: {} }, imageID: `docker-pullable://image@${row.image.split("@")[1]}` })) } };
  const deployment: any = { metadata: { name: "octogee-gateway-canary", uid: "deployment-uid", generation: 2 }, spec: { replicas: 1, template: { spec: { containers: structuredClone(containers) } } }, status: { readyReplicas: 1, observedGeneration: 2 } };
  const replicaSets: any = { items: [{ metadata: { uid: "rs-uid", ownerReferences: [{ uid: "deployment-uid", controller: true }] } }] };
  let old: any, extraPod = false, health: any = { bootId: "new-boot", health: true }, nativeFailure = false;
  let beforeProbe: (() => void) | undefined;
  const runKubectl = vi.fn((args: string[], stdin?: string) => {
    const command = args.slice(4);
    if (command[0] === "exec") { beforeProbe?.(); return { status: nativeFailure ? 1 : 0, stdout: JSON.stringify(health), stderr: nativeFailure ? "native health failed" : "" }; }
    let value;
    if (command[1] === "pod") value = old;
    else if (command[1] === "pods") value = { items: extraPod ? [pod, pod] : [pod] };
    else if (command[1] === "deployment") value = deployment;
    else if (command[1] === "replicasets") value = replicaSets;
    else throw new Error(`unexpected Kubernetes command ${args.join(" ")} ${stdin ?? ""}`);
    return { status: 0, stdout: value ? JSON.stringify(value) : "", stderr: "" };
  });
  const input = { store, gatewayId: "canary", forceAuditId: "audit-force", kubeContext: "test-context", namespace: "shared-test", runKubectl, apply: true, idempotencyKey: "resolve-1" };
  return { docs, writes, root, fence, pod, deployment, replicaSets, input, runKubectl,
    beforeProbe: (hook: typeof beforeProbe) => { beforeProbe = hook; },
    setOld: (value: any) => { old = value; }, setExtraPod: () => { extraPod = true; }, setHealth: (value: any) => { health = value; }, failNative: () => { nativeFailure = true; } };
}

describe("forced restart fence resolution", () => {
  it("journals only the exact held fence resolution and preserves both original audits", async () => {
    const h = harness(), before = structuredClone(h.docs);
    const result = await resolveForcedGatewayRestart(h.input);
    expect(result).toMatchObject({ forceAuditId: "audit-force", restartAttemptId: "attempt-1", replacementPodUid: "new-uid" });
    expect(h.docs.get("gateways/canary")).toEqual(Object.fromEntries(Object.entries(before.get("gateways/canary")!).filter(([key]) => key !== "runtimeRestartFence")));
    expect(h.docs.get("glmOperations/audit-restart")).toEqual(before.get("glmOperations/audit-restart"));
    expect(h.docs.get("glmOperations/audit-force")).toEqual(before.get("glmOperations/audit-force"));
    const added = [...h.docs].filter(([path]) => !before.has(path));
    expect(added).toHaveLength(1);
    expect(isOperationAuditRecord(added[0][1])).toBe(true);
    expect(added[0][1]).toMatchObject({ actor: "operator", forced: true, status: "completed", mutation: { kind: "resolve-forced-restart" }, preActionStatus: { native: { bootId: "new-boot", health: true } } });
    expect(h.writes.filter(write => write.path === "gateways/canary")).toHaveLength(1);
    expect(h.runKubectl.mock.calls.every(([args]) => ["get", "exec"].includes(args[4]))).toBe(true);
  });

  it("observes a dry run without any journal or gateway writes", async () => {
    const h = harness();
    expect(await resolveForcedGatewayRestart({ ...h.input, apply: false })).toMatchObject({ applied: false, replacement: { podUid: "new-uid" } });
    expect(h.writes).toEqual([]);
  });

  const rejectionCases: Array<[string, (h: ReturnType<typeof harness>) => void]> = [
    ["Shared gateway", h => { h.root.gatewayClass = "shared"; }],
    ["retirement claim", h => { Object.assign(h.root, { retirementClaim: { operationId: "retire-1" } }); }],
    ["unconverged release", h => { h.root.desiredRelease = 2; }],
    ["different fence kind", h => { h.fence.kind = "deployment"; }],
    ["undispatched fence", h => { h.fence.phase = "reserved"; }],
    ["different old pod UID", h => { h.docs.get("glmOperations/audit-force")!.target.podUid = "foreign-uid"; }],
    ["incomplete force audit", h => { h.docs.get("glmOperations/audit-force")!.status = "in-progress"; }],
    ["nonoperator force audit", h => { h.docs.get("glmOperations/audit-force")!.actor = "cowboy"; }],
    ["force before restart failed", h => { h.docs.get("glmOperations/audit-force")!.actionStartedAt = 150; }],
    ["different restart attempt", h => { h.docs.get("glmOperations/audit-restart")!.mutation.attemptId = "foreign-attempt"; }],
    ["release hash mismatch", h => { h.docs.get("gateways/canary/releases/1")!.payloadHash = "bad"; }],
    ["old pod present", h => { h.setOld({ metadata: { uid: "old-uid" } }); }],
    ["multiple replacements", h => { h.setExtraPod(); }],
    ["same pod UID", h => { h.pod.metadata.uid = "old-uid"; }],
    ["unowned pod", h => { h.pod.metadata.ownerReferences[0].uid = "foreign-rs"; }],
    ["unowned ReplicaSet", h => { h.replicaSets.items[0].metadata.ownerReferences[0].uid = "foreign-deployment"; }],
    ["old replacement", h => { h.pod.metadata.creationTimestamp = new Date(200).toISOString(); }],
    ["unready pod", h => { h.pod.status.conditions[0].status = "False"; }],
    ["deleting pod", h => { h.pod.metadata.deletionTimestamp = new Date().toISOString(); }],
    ["missing generation", h => { delete h.deployment.status.observedGeneration; }],
    ["unobserved deployment", h => { h.deployment.status.observedGeneration = 1; }],
    ["different pod image", h => { h.pod.spec.containers[0].image = "foreign-image"; }],
    ["different deployment image", h => { h.deployment.spec.template.spec.containers[1].image = "foreign-image"; }],
    ["different live digest", h => { h.pod.status.containerStatuses[0].imageID = "foreign-digest"; }],
    ["native probe fails", h => { h.failNative(); }],
    ["native health is false", h => { h.setHealth({ bootId: "new-boot", health: false }); }],
    ["native identity missing", h => { h.setHealth({ health: true }); }],
    ["owner transfer fence", h => { h.docs.get("users/canary-owner")!.provisioning.openclaw.sourceTransferFence = {}; }],
    ["foreign source custody", h => { h.docs.set("users/other", { provisioning: { openclaw: { sourceTransferFence: { sourceGatewayId: "canary" } } } }); }],
    ["foreign target custody", h => { h.docs.set("users/other", { provisioning: { openclaw: { sourceTransferFence: { targetGatewayId: "canary" } } } }); }],
    ["pending migration", h => { h.docs.set("glmOperations/move", { status: "pending", input: { fromGatewayId: "canary" } }); }],
    ["owner migration", h => { h.docs.set("glmOperations/move", { status: "running", input: { uid: "canary-owner" } }); }],
    ["migration custody", h => { h.docs.set("glmOperations/move", { status: "running", userMigrationV2: { sourceGatewayId: "canary" } }); }],
    ["transfer task", h => { h.docs.set("glmMigrationTransferTasks/move", { status: "running", sourceGatewayId: "canary" }); }],
  ];
  it.each(rejectionCases)("preserves the fence when %s", async (_name, change) => {
    const h = harness(); change(h);
    const before = structuredClone(h.docs);
    await expect(resolveForcedGatewayRestart(h.input)).rejects.toThrow();
    expect(h.docs).toEqual(before);
    expect(h.writes).toEqual([]);
  });

  it.each(["fence", "root", "force audit", "release", "custody", "replacement"])("rejects %s changes after health proof and journals failure", async kind => {
    const h = harness();
    h.beforeProbe(() => {
      if (kind === "fence") h.fence.attemptId = "new-attempt";
      if (kind === "root") h.root.updatedAt = 999;
      if (kind === "force audit") h.docs.get("glmOperations/audit-force")!.why = "changed";
      if (kind === "release") h.docs.get("gateways/canary/releases/1")!.payloadHash = "changed";
      if (kind === "custody") h.docs.set("glmOperations/move", { status: "running", input: { gatewayId: "canary" } });
      if (kind === "replacement") h.pod.metadata.uid = "another-uid";
    });
    await expect(resolveForcedGatewayRestart(h.input)).rejects.toThrow();
    expect(h.docs.get("gateways/canary")!.runtimeRestartFence).toBeDefined();
    expect(h.writes.filter(write => write.path.startsWith("gateways/"))).toEqual([]);
    expect([...h.docs].find(([path]) => path.startsWith("glmOperations/audit-") && !["glmOperations/audit-restart", "glmOperations/audit-force"].includes(path))?.[1]).toMatchObject({ status: "failed", outcome: "failed" });
  });
});

describe("replacement native health", () => {
  function deps() {
    const connection = { bootId: "new-boot", alive: vi.fn(() => true), request: vi.fn(async () => ({})), close: vi.fn() };
    return { connection, deps: { connect: async () => connection, ready: async () => true, now: Date.now, wait: async () => {} } satisfies RestartDriverDeps };
  }
  it("uses only native health and closes its authenticated connection", async () => {
    const h = deps();
    await expect(nativeHealth(h.deps)).resolves.toEqual({ bootId: "new-boot", health: true });
    expect(h.connection.request).toHaveBeenCalledExactlyOnceWith("health", {});
    expect(h.connection.close).toHaveBeenCalledOnce();
  });
  it.each(["unready", "unhealthy", "disconnected", "missing identity"])("rejects %s and closes its connection", async kind => {
    const h = deps();
    if (kind === "unready") h.deps.ready = async () => false;
    if (kind === "unhealthy") h.connection.request.mockRejectedValue(new Error("unhealthy"));
    if (kind === "disconnected") h.connection.alive.mockReturnValue(false);
    if (kind === "missing identity") h.connection.bootId = "";
    await expect(nativeHealth(h.deps)).rejects.toThrow();
    expect(h.connection.close).toHaveBeenCalledOnce();
  });
  it("runs its standalone probe over authenticated native wire without restarting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "restart-resolution-"));
    const paths: string[] = [], methods: string[] = [];
    const server = createServer((request, response) => { paths.push(request.url!); response.writeHead(200); response.end("{}"); });
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", socket => {
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "nonce" } }));
      socket.on("message", data => {
        const request = JSON.parse(String(data)); methods.push(request.method);
        if (request.method === "connect") {
          expect(request.params.auth.token).toBe("private-test-token");
          expect(request.params.device.nonce).toBe("nonce");
        }
        socket.send(JSON.stringify({ type: "res", id: request.id, ok: true, payload: request.method === "connect" ? { server: { bootId: "wire-boot" } } : { ok: true } }));
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing native test address");
      const config = join(directory, "config.json"), identity = join(directory, "identity.json");
      await writeFile(config, JSON.stringify({ gateway: { port: address.port, auth: { token: "private-test-token" } } }));
      await writeFile(identity, JSON.stringify(generateIdentity()));
      const child = spawn(process.execPath, ["--input-type=commonjs", "-", fileURLToPath(new URL("../package.json", import.meta.url))], { env: { ...process.env, OPENCLAW_CONFIG_PATH: config, OCTOGEE_PROVISIONER_IDENTITY_PATH: identity,
        OPENCLAW_CONTROL_IDENTITY: "shared", OPENCLAW_GATEWAY_TOKEN: "" }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
      const completed = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
      child.stdin.end(nativeProbeSource());
      expect(await completed, stderr).toBe(0);
      expect(JSON.parse(stdout)).toEqual({ bootId: "wire-boot", health: true });
      expect(methods).toEqual(["connect", "health"]);
      expect(paths.sort()).toEqual(["/healthz", "/readyz"]);
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
