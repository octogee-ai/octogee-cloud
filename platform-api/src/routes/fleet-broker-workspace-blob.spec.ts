import express from "express";
import request from "supertest";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../gateway-edge/src/lib/platform-state.js", async (importOriginal) => {
  const { createDocumentFixtureStore } = await import("@octogee/core/testing/journal-store");
  return {
    ...(await importOriginal<typeof import("../../../gateway-edge/src/lib/platform-state.js")>()),
    platformStateStore: createDocumentFixtureStore(new Map()),
  };
});
import { SIDECAR_BROKER_ROUTES } from "../app.js";
import { createGatewayCredentialAuth } from "../middleware/gateway-credential-auth.js";
import { createTenantEnforcementMiddleware } from "../middleware/tenant-enforcement.js";
import { SIDECAR_BROKER_TOKEN_AUDIENCE, SIDECAR_BROKER_TOKEN_HEADER } from "@octogee/core/internal-fetch";
import { storeWorkspaceBlob, WorkspaceStorageQuotaError } from "../../../gateway-edge/src/lib/workspace-blob.js";
import { divertWorktreeBinaries } from "../../../gateway-edge/src/lib/binary-diversion.js";
import { createDocumentFixtureStore } from "@octogee/core/testing/journal-store";
import { createFleetBrokerRoutes } from "./fleet-broker.js";
import { MAX_UPLOAD_BYTES } from "../../../gateway-edge/src/routes/workspace/upload.js";

class ReadOnlyDocuments extends Map<string, Record<string, unknown>> {
  constructor(private readonly docs: Record<string, Record<string, unknown>>) {
    super();
  }

  override get(path: string): Record<string, unknown> | undefined {
    return this.docs[path];
  }

  override set(): this {
    throw Error("readonly authority");
  }

  override entries(): MapIterator<[string, Record<string, unknown>]> {
    return new Map(Object.entries(this.docs)).entries();
  }
}

const JWT = `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
const target = { slug: "alice", projectSlug: null, gcsPrefix: "customers/alice" };
const contents = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
const filePath = "notes/file.bin";

function harness() {
  const docs: Record<string, Record<string, unknown>> = {
    "users/uid-alice": { username: "alice", provisioning: { openclaw: { gatewayId: "shared-alice", status: "complete" } } },
    "workspaces/alice": { id: "ws-alice", ownerUid: "uid-alice", ownerActive: true },
    "gateways/shared-alice/assignments/uid-alice": { uid: "uid-alice", slug: "alice", gatewayId: "shared-alice", source: "onboarding", state: "serving", epoch: 0 },
  };
  const store = vi.fn(async (_target: unknown, name: string, bytes: Buffer) => ({ gcsPath: `customers/alice/${name}`, size: bytes.length }));
  const app = express(); app.disable("x-powered-by"); app.use(express.json());
  app.use((req, _res, next) => { req.boundTenant = { kind: "gateway", gatewayId: "shared-alice", saName: "octogee-gw-shared-alice", podUid: "pod-alice", podName: "pod-alice" }; next(); });
  app.use(createTenantEnforcementMiddleware({ readFlowGateway: async () => null, store: createDocumentFixtureStore(new ReadOnlyDocuments(docs)), onDenied: async () => {} }));
  const auth = createGatewayCredentialAuth({ tokenHeader: SIDECAR_BROKER_TOKEN_HEADER, audience: SIDECAR_BROKER_TOKEN_AUDIENCE, namespace: "octogee-test",
    reviewer: async () => ({ authenticated: true, saName: "octogee-gw-shared-alice", namespace: "octogee-test", audiences: [SIDECAR_BROKER_TOKEN_AUDIENCE], podUid: "pod-alice", podName: "pod-alice" }),
    mapIdentity: async () => ({ kind: "gateway", gatewayId: "shared-alice" }) });
  app.use((req, res, next) => SIDECAR_BROKER_ROUTES.has(req.path) ? auth(req, res, next) : next());
  app.use("/internal/fleet", createFleetBrokerRoutes({ store: createDocumentFixtureStore(new ReadOnlyDocuments(docs)), workspaceBlobStore: store }));
  return { app, docs, store };
}

async function withGateway(run: (h: ReturnType<typeof harness>) => Promise<void>) {
  const h = harness(), directory = await mkdtemp(path.join(tmpdir(), "workspace-blob-broker-"));
  const token = path.join(directory, "synthetic-token"); await writeFile(token, JWT, { mode: 0o600 });
  const server = h.app.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("local fixture did not bind");
  vi.stubEnv("FLEET_BROKER_URL", `http://127.0.0.1:${address.port}`); vi.stubEnv("GATEWAY_CLASS", "shared"); vi.stubEnv("GATEWAY_ID", "shared-alice");
  vi.stubEnv("OCTOGEE_SIDECAR_BROKER_TOKEN_PATH", token); vi.stubEnv("OCTOGEE_API_SA_TOKEN_PATH", path.join(directory, "no-broad-token"));
  try { await run(h); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(directory, { recursive: true, force: true }); }
}
const upload = (h: ReturnType<typeof harness>) => request(h.app).post("/internal/fleet/blob/workspace/upload").set(SIDECAR_BROKER_TOKEN_HEADER, JWT).field("slug", "alice").field("path", filePath);
afterEach(() => { vi.unstubAllEnvs(); });

describe("gateway workspace binary central owner", () => {
  it.each(["serving", "quiescing"])("real gateway store reaches the registered central owner for canonical %s custody", async state => {
    await withGateway(async h => {
      h.docs["gateways/shared-alice/assignments/uid-alice"].state = state;
      await expect(storeWorkspaceBlob(target, filePath, contents, "application/octet-stream", { maxStorageBytes: 999_999 }))
        .resolves.toEqual({ gcsPath: "customers/alice/notes/file.bin", size: 8 });
      expect(h.store).toHaveBeenCalledWith({ ...target, provider: "gitea", org: "alice", repoName: "workspace" }, filePath, contents, "application/octet-stream");
      expect(h.store.mock.calls[0]).toHaveLength(4);
    });
  });

  it("propagates the central quota refusal through the actual gateway client without an upload acknowledgement", async () => {
    await withGateway(async h => {
      h.store.mockRejectedValueOnce(new WorkspaceStorageQuotaError(10, 11));
      await expect(storeWorkspaceBlob(target, filePath, contents, "application/octet-stream")).rejects.toMatchObject({ code: "FREE_STORAGE_LIMIT", limitBytes: 10, projectedBytes: 11 });
    });
  });
  it.each(["path", "size"])("rejects a mismatched object %s acknowledgement", async changed => {
    await withGateway(async h => {
      h.store.mockResolvedValueOnce({ gcsPath: changed === "path" ? "customers/foreign/notes/file.bin" : "customers/alice/notes/file.bin", size: changed === "size" ? 9 : 8 });
      await expect(storeWorkspaceBlob(target, filePath, contents)).rejects.toThrow("acknowledgement mismatch");
    });
  });
  it("propagates a central storage failure without falling back to gateway cloud access", async () => {
    await withGateway(async h => {
      h.store.mockRejectedValueOnce(new Error("synthetic storage refused"));
      await expect(storeWorkspaceBlob(target, filePath, contents)).rejects.toThrow("HTTP 503");
      expect(h.store).toHaveBeenCalledOnce();
    });
  });

  it.skipIf(process.platform !== "linux")("real diversion restores staged original bytes when the central upload owner refuses", async () => {
    await withGateway(async h => {
      const root = await mkdtemp(path.join(tmpdir(), "workspace-diversion-broker-")), workspace = path.join(root, "alice");
      const { mkdir } = await import("node:fs/promises"); await mkdir(path.join(workspace, "notes"), { recursive: true }); await writeFile(path.join(workspace, filePath), contents);
      h.store.mockRejectedValueOnce(new WorkspaceStorageQuotaError(10, 11));
      try {
        const result = await divertWorktreeBinaries(workspace, target, { gitStatus: async () => ({ ok: true, entries: [{ path: filePath, change: "untracked" }] }), storeWorkspaceBlob });
        expect(result.diverted).toEqual([]); expect(result.failedPaths).toEqual([filePath]); expect(result.failures[0]).toContain("storage limit exceeded");
        expect(await readFile(path.join(workspace, filePath))).toEqual(contents);
        expect(await readdir(root)).toEqual(["alice"]); expect(h.store).toHaveBeenCalledOnce();
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  });

  it.each(["project", "gcsPrefix", "maxStorageBytes", "ownerUid", "gatewayId"])("rejects the %s override rather than delegating it", async field => {
    const h = harness(); const response = await upload(h).field(field, "foreign").attach("file", contents, { filename: "blob", contentType: "application/octet-stream" });
    expect(response.status).toBe(400); expect(h.store).not.toHaveBeenCalled();
  });
  it.each([-1, 0, 1])("preserves the public parser's100MiB cutoff (offset bytes: %s)", async excess => {
    const h = harness(), bytes = Buffer.alloc(MAX_UPLOAD_BYTES + excess);
    const response = await upload(h).attach("file", bytes, { filename: "blob", contentType: "application/octet-stream" });
    expect(response.status).toBe(excess < 0 ? 200 : 413);
    if (excess < 0) expect(h.store.mock.calls[0][2].length).toBe(MAX_UPLOAD_BYTES - 1); else expect(h.store).not.toHaveBeenCalled();
  });
  it("rejects duplicate identity fields and extra files", async () => {
    const h = harness();
    expect((await upload(h).field("slug", "foreign").attach("file", contents, "blob")).status).toBe(400);
    expect((await upload(h).attach("file", contents, "blob").attach("file2", contents, "second")).status).toBe(400);
    expect(h.store).not.toHaveBeenCalled();
  });
  it.each(["../foreign.bin", ".git/config", "notes/.private.bin", "projects/app/file.bin"])("rejects unsafe/reserved path %s", async name => {
    const h = harness(); const response = await request(h.app).post("/internal/fleet/blob/workspace/upload").set(SIDECAR_BROKER_TOKEN_HEADER, JWT).field("slug", "alice").field("path", name).attach("file", contents, "blob");
    expect(response.status).toBe(400); expect(h.store).not.toHaveBeenCalled();
  });
  it.each(["runtime-state/allocations/shared-alice-g1/checkpoint.tar.gz", "notes/runtime-state/checkpoint.bin", "notes/__proto__/file.bin", "notes/constructor/file.bin", "notes/prototype/file.bin"])("rejects manifest-reserved path before central storage: %s", async name => {
    const h = harness(); const response = await request(h.app).post("/internal/fleet/blob/workspace/upload").set(SIDECAR_BROKER_TOKEN_HEADER, JWT).field("slug", "alice").field("path", name).attach("file", contents, "blob");
    expect(response.status).toBe(400); expect(h.store).not.toHaveBeenCalled();
  });
  it("rejects a reserved checkpoint path in the real client before requesting any broker authority", async () => {
    await withGateway(async h => {
      const fetch = vi.spyOn(globalThis, "fetch");
      try {
        await expect(storeWorkspaceBlob(target, "runtime-state/allocations/shared-alice-g1/checkpoint.tar.gz", contents)).rejects.toThrow("invalid workspace blob scope");
        expect(fetch).not.toHaveBeenCalled(); expect(h.store).not.toHaveBeenCalled();
      } finally { fetch.mockRestore(); }
    });
  });
  it("requires the existing pod-bound sidecar credential", async () => {
    const h = harness(); const response = await request(h.app).post("/internal/fleet/blob/workspace/upload").field("slug", "alice").field("path", filePath).attach("file", contents, "blob");
    expect(response.status).toBe(403); expect(h.store).not.toHaveBeenCalled();
  });
  it("rejects a foreign parsed slug", async () => {
    const h = harness(); const response = await request(h.app).post("/internal/fleet/blob/workspace/upload").set(SIDECAR_BROKER_TOKEN_HEADER, JWT).field("slug", "foreign").field("path", filePath).attach("file", contents, "blob");
    expect(response.status).toBe(403); expect(h.store).not.toHaveBeenCalled();
  });
  it.each(["migrating", "mirror", "workspace-owner", "restore"])("refuses noncanonical %s custody before central writes", async mode => {
    const h = harness();
    if (mode === "migrating") h.docs["gateways/shared-alice/assignments/uid-alice"].state = "migrating";
    if (mode === "workspace-owner") h.docs["workspaces/alice"].ownerUid = "foreign";
    const user = h.docs["users/uid-alice"] as { provisioning: { openclaw: Record<string, unknown> } };
    if (mode === "mirror") user.provisioning.openclaw.gatewayId = "other";
    if (mode === "restore") user.provisioning.openclaw.restoreFence = {};
    const response = await upload(h).attach("file", contents, "blob"); expect(response.status).toBe(403); expect(h.store).not.toHaveBeenCalled();
  });
  it.each([["state", "preparing"], ["epoch", -1]])("fails closed on a malformed assignment %s before central writes", async (field, value) => {
    const h = harness();
    h.docs["gateways/shared-alice/assignments/uid-alice"][field] = value;
    const response = await upload(h).attach("file", contents, "blob"); expect(response.status).toBe(500); expect(h.store).not.toHaveBeenCalled();
  });
});
