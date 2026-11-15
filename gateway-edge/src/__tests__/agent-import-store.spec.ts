import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentImportStore } from "../lib/agent-import-store.js";
import type { AgentImportRecord, StoredAgentImportPlan } from "@octogee/core/http-candidates/agent-transfer/agent-import-service";

const roots: string[] = [];

function tokenFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-import-broker-test-"));
  roots.push(root);
  const file = path.join(root, "token");
  fs.writeFileSync(file, "projected-ksa-token\n");
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const record = {
  id: "imp-1", uid: "uid-jack", slug: "jack", gatewayId: "gw-jack", status: "previewed",
} as AgentImportRecord;
const plan = {
  uid: "uid-jack", slug: "jack", gatewayId: "gw-jack", approvalHash: "sha256:approved",
  workspacePolicy: { preserveConvergedContextFiles: false },
} as StoredAgentImportPlan;

describe("agent import broker client", () => {
  it("delegates all platform persistence and identity operations with both caller and pod proofs", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/authorize")) {
        return Response.json({
          slug: "jack",
          gatewayId: "gw-jack",
          workspacePolicy: { preserveConvergedContextFiles: false },
        });
      }
      if (url.endsWith("/records/latest")) return Response.json(record);
      if (url.endsWith("/records/imp-1") && init?.method !== "PUT") {
        return Response.json(record);
      }
      if (url.endsWith("/plans/imp-1") && init?.method !== "PUT") {
        return Response.json(plan);
      }
      if (url.endsWith("/archives/imp-1") && init?.method !== "PUT") {
        return new Response(Buffer.from("zip"), { headers: { "content-type": "application/zip" } });
      }
      if (url.includes("/blobs/imp-1?") && init?.method === "PUT") {
        return Response.json({
          type: "blob",
          gcsPath: "customers/jack/agent-imports/imp-1/image.png",
          size: 3,
          mimeType: "image/png",
          uploadedAt: "2026-07-20T12:00:00.000Z",
        }, { status: 201 });
      }
      if (url.endsWith("/identity") && !["PATCH", "PUT"].includes(init?.method ?? "GET")) {
        return Response.json({ name: "Octo", persona: null, emoji: null });
      }
      if (url.endsWith("/github/sources")) return Response.json({ repos: [], truncated: false });
      if (url.endsWith("/github/token")) return Response.json({ token: "github-oauth" });
      if (url.endsWith("/github/repos/jack/moof/size")) return Response.json({ sizeKiB: 12 });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const store = createAgentImportStore({
      baseUrl: "http://octogee-api.octogee.svc.cluster.local",
      authorization: "Bearer firebase-token",
      gatewayId: "gw-jack",
      tokenPath: tokenFile(),
      fetchImpl,
    });

    await store.putRecord(record);
    await expect(store.authorize("preview")).resolves.toEqual({
      slug: "jack",
      gatewayId: "gw-jack",
      workspacePolicy: { preserveConvergedContextFiles: false },
    });
    await expect(store.getRecord("imp-1")).resolves.toEqual(record);
    await expect(store.getLatestRecord()).resolves.toEqual(record);
    await store.putPlan("imp-1", plan);
    await expect(store.getPlan("imp-1")).resolves.toEqual(plan);
    await store.putArchive("imp-1", Buffer.from("zip"));
    await expect(store.getArchive("imp-1")).resolves.toEqual(Buffer.from("zip"));
    await store.deleteStaging("imp-1");
    await store.deleteImportBlobs("imp-1");
    await store.abandonRecord({ ...record, status: "abandoned" });
    await expect(store.storeBlob("imp-1", "image.png", Buffer.from("png"), "image/png"))
      .resolves.toMatchObject({ size: 3, mimeType: "image/png" });
    await expect(store.readIdentity()).resolves.toEqual({ name: "Octo", persona: null, emoji: null });
    await store.syncIdentity({ name: "Moof" });
    await store.replaceIdentity({ name: "Octo", persona: null, emoji: null });
    await expect(store.listGithubSources()).resolves.toEqual({ repos: [], truncated: false });
    await expect(store.readGithubToken()).resolves.toBe("github-oauth");
    await expect(store.readGithubRepoSize("jack", "moof")).resolves.toBe(12);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://octogee-api.octogee.svc.cluster.local/internal/agent-imports/authorize",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ gatewayId: "gw-jack", intent: "preview" }),
      }),
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/records/imp-1/abandon"),
      expect.objectContaining({ method: "POST" }),
    );

    expect(fetchImpl).toHaveBeenCalled();
    for (const [, init] of vi.mocked(fetchImpl).mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer firebase-token");
      expect(headers.get("x-k8s-sa-token")).toBe("projected-ksa-token");
    }
  });

  it("fails closed without an authenticated caller or projected pod token", async () => {
    expect(() => createAgentImportStore({
      baseUrl: "http://octogee-api",
      authorization: "",
      gatewayId: "gw-jack",
      tokenPath: "/missing",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    })).toThrow("Firebase authorization");

    const store = createAgentImportStore({
      baseUrl: "http://octogee-api",
      authorization: "Bearer firebase-token",
      gatewayId: "gw-jack",
      tokenPath: "/missing",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(store.getRecord("imp-1")).rejects.toThrow("projected service-account token unavailable");
  });
});
