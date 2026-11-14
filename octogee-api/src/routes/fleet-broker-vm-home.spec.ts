import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { VM_HOME_CHECKPOINT_KEEP, VM_HOME_CHECKPOINT_MAX_BYTES, type GatewayVmHomeCheckpoint } from "@octogee/shared/types/glm";
import { gcsBlobStore } from "../lib/runtime-blob-store.js";
import { VmHomeCheckpointError, type VmHomeStore } from "../lib/vm-home-checkpoint.js";
import type { BoundTenant } from "../lib/sa-to-tenant.js";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { RecordingDocuments } from "../test-helpers/recording-documents.js";
import { createFleetBrokerRoutes } from "./fleet-broker.js";

const NOW = Date.UTC(2026, 8, 5, 10, 15, 0, 500);
const CHECKPOINT_NAME = "20260905T101500Z.tar.gz";
const SHA = "a".repeat(64);

const vmBound: BoundTenant = {
  kind: "gateway",
  gatewayId: "b-x",
  ownerUid: "uid-bob",
  saName: "octogee-computer-test",
  podName: "octogee-gw-b-x",
  podUid: "4242",
};

function gatewayDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayId: "b-x",
    createdAt: 1,
    createdBy: "test",
    updatedAt: 1,
    updatedBy: "test",
    latestRelease: 1,
    desiredRelease: 1,
    liveRelease: 1,
    desiredStatus: "running",
    configSchemaVersion: 1,
    profile: "isolated",
    gatewayClass: "isolated",
    imageProfile: "isolated",
    sizingTier: null,
    gcpProject: null,
    gatewayContainerSecurityContext: null,
    serviceAccountName: null,
    serviceAccount: null,
    builderAccess: null,
    ownerUid: "uid-bob",
    builderSlug: "bob",
    modelBrokerLimits: null,
    preemption: null,
    ...overrides,
  };
}

function glmDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { docKind: "runtime", gatewayId: "b-x", release: 1, lifecycle: "running", runtime: "gce-vm", vm: { instanceId: "4242", instanceName: "octogee-gw-b-x" }, ...overrides };
}

const current: GatewayVmHomeCheckpoint = { name: CHECKPOINT_NAME, size: 2048, sha256: SHA, instanceId: "4141", completedAt: NOW - 60_000 };

function harness(input: {
  docs?: Record<string, Record<string, unknown>>;
  bound?: BoundTenant | null;
  store?: Partial<VmHomeStore>;
  useDefaultSigner?: boolean;
} = {}) {
  const docs: Record<string, Record<string, unknown>> = {
    "users/uid-bob": { provisioning: {} },
    "gateways/b-x": gatewayDoc(),
    "glmGateways/b-x": glmDoc(),
    ...input.docs,
  };
  const documents = new RecordingDocuments(Object.fromEntries(Object.entries(docs).filter(([, row]) => row !== undefined)));
  const store: VmHomeStore = {
    commit: vi.fn(async ({ checkpoint }: { checkpoint: GatewayVmHomeCheckpoint }) => checkpoint),
    readCurrent: vi.fn(async () => null),
    prune: vi.fn(async () => 0),
    ...input.store,
  };
  const createBlobSignedUrl = vi.fn(async (signed: { gcsPath: string; action: "read" | "write"; contentType?: string; ifGenerationMatch?: number | string }) => ({
    url: `https://storage.example/${signed.gcsPath}`,
    method: signed.action === "read" ? "GET" as const : "PUT" as const,
    gcsPath: signed.gcsPath,
    expiresAt: "2026-09-05T10:25:00.000Z",
    ...(signed.ifGenerationMatch === undefined ? {} : { requiredHeaders: { "x-goog-if-generation-match": String(signed.ifGenerationMatch) } }),
  }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const bound = input.bound === undefined ? vmBound : input.bound;
    if (bound) req.boundTenant = bound;
    next();
  });
  app.use("/internal/fleet", createFleetBrokerRoutes({ store: createDocumentFixtureStore(documents), vmHomeStore: store, createBlobSignedUrl, ...(!input.useDefaultSigner && { createVmHomeSignedUrl: createBlobSignedUrl }), now: () => NOW }));
  const post = (path: string, body: Record<string, unknown>) => request(app).post(`/internal/fleet/computer-home/${path}`).send({ gatewayId: "b-x", slug: "bob", requestedAt: null, ...body });
  return { post, store, createBlobSignedUrl, documents, writes: documents.writes, app };
}

describe("vm-home checkpoint routes", () => {
  it("keeps home checkpoint signing on GCS when platform blobs use S3", async () => {
    vi.stubEnv("BLOB_STORE_BACKEND", "s3");
    const signer = vi.spyOn(gcsBlobStore, "signedUrl").mockResolvedValue({
      url: "https://storage.googleapis.com/fixture", method: "PUT", gcsPath: "fixture", expiresAt: "",
    });
    try {
      const h = harness({ useDefaultSigner: true });
      expect((await h.post("checkpoint-url", { size: 2048 })).status).toBe(200);
      expect(signer).toHaveBeenCalledWith(expect.objectContaining({
        gcsPath: expect.stringMatching(/^customers\/bob\/computer-home\/checkpoints\//u), action: "write",
      }), expect.any(Number));
      expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
    } finally {
      signer.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("keeps isolated runtime snapshots on GCS when platform blobs use S3", async () => {
    vi.stubEnv("BLOB_STORE_BACKEND", "s3");
    const signer = vi.spyOn(gcsBlobStore, "signedUrl").mockResolvedValue({
      url: "https://storage.googleapis.com/fixture", method: "PUT", gcsPath: "fixture", expiresAt: "",
    });
    try {
      const h = harness({
        bound: { ...vmBound, podName: "octogee-gateway-b-x-5bc5949d46-p946t" },
        docs: { "gateways/b-x": gatewayDoc({ allocation: {
          kind: "disposable-builder", schemaVersion: 1, leaseId: "lease-bob-3", generation: 3, claimedByUid: "uid-bob",
        } }) },
      });
      const snapshot = await request(h.app).post("/internal/fleet/builder-runtime-state/snapshot-urls").send({
        gatewayId: "b-x", revisionId: "b-x", slug: "bob", size: 4096, recoveryTiers: ["minute"],
      });
      expect(snapshot.status).toBe(200);
      expect(signer).toHaveBeenCalledWith(expect.objectContaining({
        gcsPath: "customers/bob/runtime-state/allocations/b-x-g3/checkpoint.tar.gz", action: "write",
      }), expect.any(Number));
      expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
    } finally {
      signer.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("rejects unpublished writer protocol 3 so a claimed protocol cannot enable disposal", async () => {
    const h = harness();
    const res = await h.post("commit", { name: CHECKPOINT_NAME, size: 2048, sha256: SHA, coverage: "builder-home-v2", writerProtocol: 3 });
    expect(res.status).toBe(400);
    expect(h.store.commit).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });
  it("mints a create-only upload URL for a second-stamped checkpoint object under the user's home prefix", async () => {
    const h = harness();
    const res = await h.post("checkpoint-url", { size: 2048 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: CHECKPOINT_NAME,
      upload: {
        url: `https://storage.example/customers/bob/computer-home/checkpoints/${CHECKPOINT_NAME}`,
        method: "PUT",
        gcsPath: `customers/bob/computer-home/checkpoints/${CHECKPOINT_NAME}`,
        expiresAt: "2026-09-05T10:25:00.000Z",
        requiredHeaders: { "x-goog-if-generation-match": "0" },
      },
    });
    expect(h.createBlobSignedUrl).toHaveBeenCalledWith({
      gcsPath: `customers/bob/computer-home/checkpoints/${CHECKPOINT_NAME}`,
      action: "write",
      contentType: "application/gzip",
      ifGenerationMatch: 0,
    });
  });

  it("rejects an empty, oversized, or missing checkpoint size before signing anything", async () => {
    const h = harness();
    for (const size of [0, VM_HOME_CHECKPOINT_MAX_BYTES + 1, "2048", undefined]) {
      const res = await h.post("checkpoint-url", { size });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "invalid_size" });
    }
    expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
  });

  it("commit verifies the uploaded object, marks it current, and records the checkpoint on the gateway for the fleet controller", async () => {
    const h = harness();
    const res = await h.post("commit", { name: CHECKPOINT_NAME, size: 2048, sha256: SHA });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: CHECKPOINT_NAME, size: 2048, sha256: SHA, completedAt: NOW });
    const checkpoint = { name: CHECKPOINT_NAME, size: 2048, sha256: SHA, instanceId: "4242", completedAt: NOW };
    expect(h.store.commit).toHaveBeenCalledWith({
      checkpointPath: `customers/bob/computer-home/checkpoints/${CHECKPOINT_NAME}`,
      currentPath: "customers/bob/computer-home/current.json",
      checkpoint,
    });
    expect(h.writes).toEqual([{ path: "glmGateways/b-x", data: glmDoc({ vmHome: { lastCheckpoint: checkpoint, checkpointAcknowledgedAt: null } }) }]);
  });

  it("acknowledges only the request observed before snapshot capture, including a late periodic upload", async () => {
    const h = harness({ docs: { "glmGateways/b-x": glmDoc({ vmHome: { checkpointRequestedAt: NOW - 1_000 } }) } });
    expect((await h.post("commit", { name: CHECKPOINT_NAME, size: 2048, sha256: SHA, requestedAt: null })).status).toBe(200);
    expect(h.writes.at(-1)?.data).toMatchObject({ vmHome: { checkpointAcknowledgedAt: null } });
    expect((await h.post("commit", { name: CHECKPOINT_NAME, size: 2048, sha256: SHA, requestedAt: NOW - 1_000 })).status).toBe(200);
    expect(h.writes.at(-1)?.data).toMatchObject({ vmHome: { checkpointAcknowledgedAt: NOW - 1_000 } });
    for (const requestedAt of [NOW + 1, -1, "1000", undefined]) {
      expect((await h.post("commit", { name: CHECKPOINT_NAME, size: 2048, sha256: SHA, requestedAt })).status).toBe(400);
    }
  });

  it("returns the canonical completion timestamp for an already-committed snapshot", async () => {
    const canonical = { ...current, instanceId: "4242" };
    const h = harness({ store: { commit: vi.fn(async () => canonical) } });
    const response = await h.post("commit", { name: CHECKPOINT_NAME, size: 2048, sha256: SHA });
    expect(response.status).toBe(200);
    expect(response.body.completedAt).toBe(canonical.completedAt);
    expect(h.writes[0].data).toMatchObject({ vmHome: { lastCheckpoint: canonical } });
  });

  it("commit rejects a malformed record and reports an unverifiable object as a conflict without touching the gateway", async () => {
    const h = harness({
      store: { commit: vi.fn(async () => { throw new VmHomeCheckpointError("checkpoint_not_uploaded", "missing"); }) },
    });
    expect((await h.post("commit", { name: "../current.json", size: 2048, sha256: SHA })).body).toEqual({ error: "invalid_checkpoint" });
    expect((await h.post("commit", { name: CHECKPOINT_NAME, size: 2048, sha256: "zz" })).body).toEqual({ error: "invalid_checkpoint" });
    expect((await h.post("commit", { name: CHECKPOINT_NAME, size: 0, sha256: SHA })).body).toEqual({ error: "invalid_checkpoint" });
    const missing = await h.post("commit", { name: CHECKPOINT_NAME, size: 2048, sha256: SHA });
    expect(missing.status).toBe(409);
    expect(missing.body).toEqual({ error: "checkpoint_not_uploaded" });
    expect(h.writes).toEqual([]);
  });

  it("download-url returns the current checkpoint record with a read URL, or 404 when the user has no checkpoint", async () => {
    const none = await harness().post("download-url", {});
    expect(none.status).toBe(404);
    expect(none.body).toEqual({ error: "no_checkpoint" });

    const h = harness({ store: { readCurrent: vi.fn(async () => current) } });
    const res = await h.post("download-url", {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: CHECKPOINT_NAME,
      size: 2048,
      sha256: SHA,
      completedAt: current.completedAt,
      instanceId: current.instanceId,
      download: {
        url: `https://storage.example/customers/bob/computer-home/checkpoints/${CHECKPOINT_NAME}`,
        method: "GET",
        gcsPath: `customers/bob/computer-home/checkpoints/${CHECKPOINT_NAME}`,
        expiresAt: "2026-09-05T10:25:00.000Z",
      },
    });
    expect(h.store.readCurrent).toHaveBeenCalledWith("customers/bob/computer-home/current.json");
  });

  it("prune keeps the retention window plus the current checkpoint", async () => {
    const h = harness({ store: { readCurrent: vi.fn(async () => current), prune: vi.fn(async () => 3) } });
    const res = await h.post("prune", {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 3 });
    expect(h.store.prune).toHaveBeenCalledWith({
      checkpointsPrefix: "customers/bob/computer-home/checkpoints",
      currentName: CHECKPOINT_NAME,
      keep: VM_HOME_CHECKPOINT_KEEP,
    });
  });

  it("scopes every route to the bound VM's own configured isolated gateway and slug", async () => {
    const cases: Array<[string, Parameters<typeof harness>[0]]> = [
      ["no binding", { bound: null }],
      ["platform binding", { bound: { kind: "platform", actor: "cron" } }],
      ["pod binding without an instance id", { bound: { kind: "gateway", gatewayId: "b-x", ownerUid: "uid-bob" } }],
      ["another instance's token", { bound: { ...vmBound, podUid: "9999" } }],
      ["cluster runtime", { docs: { "glmGateways/b-x": glmDoc({ runtime: "cluster" }) } }],
      ["retiring gateway", { docs: { "gateways/b-x": gatewayDoc({ retireAfter: 5 }) } }],
      ["paused gateway", { docs: { "gateways/b-x": gatewayDoc({ desiredStatus: "paused" }) } }],
      ["shared gateway", { docs: { "gateways/b-x": gatewayDoc({ gatewayClass: "shared", profile: null, imageProfile: "standard", builderSlug: null, ownerUid: null }) } }],
      ["missing gateway", { docs: { "gateways/b-x": undefined as unknown as Record<string, unknown> } }],
    ];
    for (const [label, input] of cases) {
      const h = harness(input);
      for (const [path, body] of [["checkpoint-url", { size: 1 }], ["commit", { name: CHECKPOINT_NAME, size: 1, sha256: SHA }], ["download-url", {}], ["prune", {}]] as const) {
        const res = await h.post(path, body);
        expect(res.status, `${label}: ${path}`).toBe(403);
      }
      expect(h.createBlobSignedUrl, label).not.toHaveBeenCalled();
      expect(h.store.commit, label).not.toHaveBeenCalled();
    }

    const foreignSlug = await harness().post("download-url", { slug: "alice" });
    expect(foreignSlug.status).toBe(403);
    const claimedOther = await harness().post("download-url", { gatewayId: "b-y" });
    expect(claimedOther.status).toBe(403);
    const badSlug = await harness().post("download-url", { slug: "Not A Slug" });
    expect(badSlug.status).toBe(400);
    expect(badSlug.body).toEqual({ error: "invalid_slug" });
  });

  it("lets a retired gateway's VM upload its final checkpoint only through a final-checkpoint binding", async () => {
    const retired = gatewayDoc({ desiredStatus: "retired", retirementClaim: { operationId: "op-1", version: 1 } });
    const glm = glmDoc({ vmHome: { checkpointRequestedAt: NOW - 30_000, lastCheckpoint: null } });

    const final = harness({ docs: { "gateways/b-x": retired, "glmGateways/b-x": glm }, bound: { ...vmBound, finalHomeCheckpoint: true } });
    expect((await final.post("checkpoint-url", { size: 1 })).status).toBe(200);
    const commit = await final.post("commit", { name: CHECKPOINT_NAME, size: 2048, sha256: SHA });
    expect(commit.status).toBe(200);
    expect(final.writes).toEqual([{ path: "glmGateways/b-x", data: { ...glm, vmHome: { checkpointRequestedAt: NOW - 30_000, checkpointAcknowledgedAt: null, lastCheckpoint: { name: CHECKPOINT_NAME, size: 2048, sha256: SHA, instanceId: "4242", completedAt: NOW } } } }]);
    expect((await final.post("prune", {})).status).toBe(200);

    const plain = harness({ docs: { "gateways/b-x": retired, "glmGateways/b-x": glm } });
    for (const [path, body] of [["checkpoint-url", { size: 1 }], ["commit", { name: CHECKPOINT_NAME, size: 1, sha256: SHA }], ["prune", {}]] as const) {
      expect((await plain.post(path, body)).status, path).toBe(403);
    }
    expect(plain.store.commit).not.toHaveBeenCalled();

    const foreignInstance = harness({ docs: { "gateways/b-x": retired, "glmGateways/b-x": glm }, bound: { ...vmBound, podUid: "9999", finalHomeCheckpoint: true } });
    expect((await foreignInstance.post("commit", { name: CHECKPOINT_NAME, size: 1, sha256: SHA })).status).toBe(403);
  });
});


describe("required disposable recovery checkpoint", () => {
  const saved = { ...current, generation: "9007199254740995" };
  const docs = { "glmGateways/b-x": glmDoc({ vmHome: { restoreCheckpoint: saved } }) };
  it("pins the signed read to the required immutable archive generation", async () => {
    const h = harness({ docs, store: { readCurrent: vi.fn(async () => saved) } });
    const res = await h.post("download-url", {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ...saved });
    expect(h.createBlobSignedUrl).toHaveBeenCalledWith(expect.objectContaining({ action: "read", generation: saved.generation }));
  });
  it.each([null, { ...saved, generation: "9007199254740996" }, { ...saved, instanceId: "foreign" }, { ...saved, sha256: "b".repeat(64) }])("refuses unavailable or changed recovery identity %#", async (record) => {
    const h = harness({ docs, store: { readCurrent: vi.fn(async () => record) } });
    expect((await h.post("download-url", {})).status).toBe(409);
    expect(h.createBlobSignedUrl).not.toHaveBeenCalled();
  });
  it("refuses a corrupt stored restore obligation", async () => {
    const h = harness({ docs: { "glmGateways/b-x": glmDoc({ vmHome: { restoreCheckpoint: { ...saved, generation: 123 } } }) } });
    expect((await h.post("download-url", {})).status).toBe(409);
    expect(h.store.readCurrent).not.toHaveBeenCalled();
  });
  it("updates the durable owner anchor on a canonical commit from the current bound instance", async () => {
    const next = { ...saved, instanceId: "4242", completedAt: NOW };
    const h = harness({ store: { commit: vi.fn(async () => next) } });
    expect((await h.post("commit", { name: next.name, size: next.size, sha256: next.sha256 })).status).toBe(200);
    expect(h.writes).toContainEqual({ path: "users/uid-bob", data: { provisioning: { homeCheckpoint: next } } });
  });

});
