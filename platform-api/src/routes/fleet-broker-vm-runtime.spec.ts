import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { BoundTenant } from "../lib/sa-to-tenant.js";
import { createJournalFixtureStore, fixtureDocumentsAt, journalRowsAtPaths } from "@octogee/core/testing/journal-store";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const bundle = {
  version: "v1", gatewayId: "b-x", namespace: "octogee-test", imageRepository: "r", imageTag: "t", desktop: "omarchy", init: null,
  containers: [{ name: "gateway", image: "r:t", env: { A: "1" }, command: null, args: null, mounts: [] }],
  volumes: [], hostAliases: {}, kubernetes: { apiHost: "10.128.0.2", apiPort: "443", caCert: "c" },
  renderedAt: 1,
};

class FailingDocuments extends RecordingDocuments {
  constructor(seed: Record<string, Record<string, unknown>>, private readonly failWrites: boolean) {
    super(seed);
  }

  override set(path: string, data: Record<string, unknown>): this {
    if (this.failWrites) throw new Error("14 UNAVAILABLE");
    return super.set(path, data);
  }
}

function runtime(fields: Record<string, unknown> = {}): Record<string, any> {
  return { docKind: "runtime", gatewayId: "b-x", release: 1, lifecycle: "running", runtime: "gce-vm", ...fields };
}

function appWith(docs: Record<string, Record<string, unknown>>, bound: BoundTenant | null, writeFails = false, beforeTransaction?: () => void) {
  const documents = new FailingDocuments(docs, writeFails);
  const store = createJournalFixtureStore(journalRowsAtPaths(documents), { documents: fixtureDocumentsAt(documents), beforeTransaction });
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());
  app.use((req, _res, next) => {
    if (bound) req.boundTenant = bound;
    next();
  });
  app.use("/internal/fleet", createFleetBrokerRoutes({ store, now: () => 5_000 }));
  return { app, documents };
}

const post = (h: { app: express.Express }, body: Record<string, unknown> = {}) => request(h.app).post("/internal/fleet/vm-runtime").send(body);

describe("POST /internal/fleet/vm-runtime", () => {
  const gatewayBound: BoundTenant = { kind: "gateway", gatewayId: "b-x" };
  const vmBound: BoundTenant = { kind: "gateway", gatewayId: "b-x", podUid: "4242" };
  const RUNTIME = "glmGateways/b-x";
  const BUNDLE = "glmGateways/b-x/vm/runtime";

  it("returns the bound gateway's rendered runtime bundle and home-checkpoint signal, uncached", async () => {
    const res = await post(appWith({ [BUNDLE]: bundle }, gatewayBound));
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({ bundle, homeCheckpoint: { requestedAt: null, completedAt: null } });

    const requested = await post(appWith({
      [BUNDLE]: bundle,
      [RUNTIME]: runtime({ vmHome: { checkpointRequestedAt: 50, lastCheckpoint: { name: "20260905T101500Z.tar.gz", size: 1, sha256: "a".repeat(64), instanceId: "1", completedAt: 40 } } }),
    }, gatewayBound));
    expect(requested.body.homeCheckpoint).toEqual({ requestedAt: 50, completedAt: null });
  });

  it("keeps serving a bundle rendered before bundles named their desktop, and fails closed on an unknown desktop", async () => {
    const { desktop: _desktop, ...omarchyEra } = bundle;
    const served = await post(appWith({ [BUNDLE]: omarchyEra }, gatewayBound));
    expect(served.status).toBe(200);
    expect(served.body.bundle).toEqual(omarchyEra);
    expect((await post(appWith({ [BUNDLE]: { ...bundle, desktop: "kde" } }, gatewayBound))).status).toBe(500);
  });

  it("404s when nothing is rendered, fails closed when the bundle names another gateway, and 403s without a gateway binding", async () => {
    expect((await post(appWith({}, gatewayBound))).status).toBe(404);
    expect((await post(appWith({ [BUNDLE]: { ...bundle, gatewayId: "b-y" } }, gatewayBound))).status).toBe(500);
    expect((await post(appWith({ [BUNDLE]: bundle }, null))).status).toBe(403);
    expect((await post(appWith({ [BUNDLE]: bundle }, { kind: "platform", actor: "cron" }))).status).toBe(403);
  });

  it("binds boot-recovery capacity/readiness to the same instance/version and server time", async () => {
    const glm = runtime({ vm: { instanceId: "4242" } });
    const docs = { [BUNDLE]: bundle, [RUNTIME]: glm };
    const sample = { currentPointId: "image-one-" + "a".repeat(32), retainedPoints: 1, ready: true, bundleVersion: "v1", freeBytes: 3 * 1024 ** 3 };
    const recorded = appWith(docs, vmBound);
    expect((await post(recorded, { bootRecovery: { ...sample, instanceId: "forged", observedAt: 99999 } })).status).toBe(200);
    expect(recorded.documents.writes).toEqual([{ path: RUNTIME, data: { ...glm, vmBootRecovery: { ...sample, instanceId: "4242", observedAt: 5000 } } }]);
    for (const [podUid, bundleVersion] of [["other", "v1"], ["4242", "old"]]) {
      const other = appWith(docs, { kind: "gateway", gatewayId: "b-x", podUid });
      expect((await post(other, { bootRecovery: { ...sample, bundleVersion } })).status).toBe(200);
      expect(other.documents.writes).toEqual([]);
    }
    expect((await post(appWith(docs, vmBound), { bootRecovery: { ...sample, retainedPoints: -1 } })).status).toBe(400);
    const failed = appWith(docs, vmBound);
    expect((await post(failed, { bootRecovery: { ...sample, ready: false, bundleVersion: "unavailable" } })).status).toBe(200);
    expect(failed.documents.writes).toEqual([{ path: RUNTIME, data: { ...glm, vmBootRecovery: { ...sample, ready: false, bundleVersion: "unavailable", instanceId: "4242", observedAt: 5000 } } }]);
    expect((await post(appWith(docs, vmBound, true), { bootRecovery: sample })).status).toBe(503);
    const raced = appWith(docs, vmBound, false, () => { glm.vm.instanceId = "new"; });
    expect((await post(raced, { bootRecovery: sample })).status).toBe(200);
    expect(raced.documents.writes).toEqual([]);
  });

  it("records the bound instance's disk report on the runtime doc, ignores another instance's, and rejects a malformed one", async () => {
    const glm = runtime({ vm: { instanceId: "4242", status: "RUNNING" } });
    const disk = { sizeBytes: 42_949_672_960, freeBytes: 3_221_225_472 };

    const recorded = appWith({ [BUNDLE]: bundle, [RUNTIME]: glm }, vmBound);
    const response = await post(recorded, { disk });
    expect(response.status).toBe(200);
    expect(response.body.bundle).toEqual(bundle);
    expect(recorded.documents.writes).toEqual([{ path: RUNTIME, data: { ...glm, vmDisk: { ...disk, instanceId: "4242", observedAt: 5_000 } } }]);

    const foreign = appWith({ [BUNDLE]: bundle, [RUNTIME]: glm }, { ...vmBound, podUid: "9999" });
    expect((await post(foreign, { disk })).status).toBe(200);
    expect(foreign.documents.writes).toEqual([]);

    const malformed = await post(appWith({ [BUNDLE]: bundle, [RUNTIME]: glm }, vmBound), { disk: { sizeBytes: 10, freeBytes: 11 } });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "invalid_disk_sample" });
  });

  it("records image observations with broker time and current instance identity, excluding guest metadata", async () => {
    const containers = [
      { name: "gateway", imageReference: "registry.example/gateway:actual", digests: [`registry.example/gateway@sha256:${"a".repeat(64)}`], running: true },
      { name: "gateway-edge", imageReference: "", digests: [], running: false },
    ];
    const glm = runtime({ vm: { instanceId: "4242" } });
    const docs = { [BUNDLE]: bundle, [RUNTIME]: glm };
    const recorded = appWith(docs, vmBound);
    const response = await post(recorded, { images: { containers: containers.map(c => ({ ...c, env: "secret" })), observedAt: 999_999, instanceId: "forged" } });
    expect(response.status).toBe(200);
    expect(recorded.documents.writes).toEqual([{ path: RUNTIME, data: { ...glm, vmImages: { instanceId: "4242", observedAt: 5_000, containers } } }]);

    for (const other of [{ ...vmBound, podUid: "old" }, gatewayBound]) {
      const foreign = appWith(docs, other);
      expect((await post(foreign, { images: { containers } })).status).toBe(200);
      expect(foreign.documents.writes).toEqual([]);
    }
    const raced = appWith(docs, vmBound, false, () => { glm.vm.instanceId = "replacement"; });
    await post(raced, { images: { containers } });
    expect(raced.documents.writes).toEqual([]);
  });

  it("fails visibly when image observation persistence fails", async () => {
    const docs = { [BUNDLE]: bundle, [RUNTIME]: runtime({ vm: { instanceId: "4242" } }) };
    const containers = ["gateway", "gateway-edge"].map(name => ({ name, imageReference: "", digests: [], running: false }));
    const response = await post(appWith(docs, vmBound, true), { images: { containers } });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: "image_observation_unrecorded" });
  });

  it("rejects incomplete, duplicate, oversized and malformed image observations", async () => {
    const missing = { name: "gateway", imageReference: "", digests: [], running: false };
    const edge = { ...missing, name: "gateway-edge" };
    const docs = { [BUNDLE]: bundle, [RUNTIME]: runtime({ vm: { instanceId: "4242" } }) };
    for (const containers of [[], [missing], [missing, missing], [missing, edge, edge],
      [{ ...missing, running: true }, edge], [{ ...missing, imageReference: "x", digests: ["sha256:bad"] }, edge],
      [{ ...missing, imageReference: "x".repeat(1025) }, edge]]) {
      const h = appWith(docs, vmBound);
      const response = await post(h, { images: { containers } });
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "invalid_image_sample" });
      expect(h.documents.writes).toEqual([]);
    }
  });

  it("records the bound instance's Spot preemption notice with the API's clock, ignores another instance's, and rejects a malformed one", async () => {
    const glm = runtime({ vm: { instanceId: "4242", status: "RUNNING" } });

    const recorded = appWith({ [BUNDLE]: bundle, [RUNTIME]: glm }, vmBound);
    expect((await post(recorded, { preempted: true })).status).toBe(200);
    expect(recorded.documents.writes).toEqual([{ path: RUNTIME, data: { ...glm, vmPreemption: { instanceId: "4242", announcedAt: 5_000 } } }]);

    const foreign = appWith({ [BUNDLE]: bundle, [RUNTIME]: glm }, { ...vmBound, podUid: "9999" });
    await post(foreign, { preempted: true });
    expect(foreign.documents.writes).toEqual([]);

    const malformed = await post(appWith({ [BUNDLE]: bundle, [RUNTIME]: glm }, vmBound), { preempted: "yes" });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toEqual({ error: "invalid_preemption_notice" });

    const unrecorded = await post(appWith({ [BUNDLE]: bundle, [RUNTIME]: glm }, vmBound, true), { preempted: true });
    expect(unrecorded.status).toBe(503);
    expect(unrecorded.body).toEqual({ error: "preemption_notice_unrecorded" });
  });

  it("carries a valid recovery obligation to the agent and refuses corrupt metadata", async () => {
    const saved = { name: "20260905T101500Z.tar.gz", size: 2048, sha256: "a".repeat(64), instanceId: "previous", generation: "9007199254740995", completedAt: 1000 };
    const docs = { [BUNDLE]: bundle, [RUNTIME]: runtime({ vm: { instanceId: "4242" }, vmHome: { restoreCheckpoint: saved } }) };
    const response = await post(appWith(docs, vmBound));
    expect(response.status).toBe(200);
    expect(response.body.bundle.homeRestoreCheckpoint).toEqual(saved);
    const malformed = { ...docs, [RUNTIME]: { ...docs[RUNTIME], vmHome: { restoreCheckpoint: { ...saved, generation: 123 } } } };
    expect((await post(appWith(malformed, vmBound))).status).toBe(409);
  });

  it("does not create a runtime record for a disk or preemption report on a gateway without one", async () => {
    for (const body of [{ disk: { sizeBytes: 42_949_672_960, freeBytes: 3_221_225_472 } }, { preempted: true }]) {
      const h = appWith({ [BUNDLE]: bundle }, vmBound);
      expect((await post(h, body)).status).toBe(200);
      expect(h.documents.writes).toEqual([]);
    }
  });
});
