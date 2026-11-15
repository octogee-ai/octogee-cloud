import { expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ removeLegacy: vi.fn(async () => { throw new Error("storage permission denied"); }), write: vi.fn(async () => ({ content: { sha: "new" } })) }));
vi.mock("./manifest.js", () => ({ getManifestForQuota: vi.fn(), removeFromManifest: h.removeLegacy }));
vi.mock("../git-host/gitea-client.js", () => ({ giteaApiAsUserAllowNotFound: async () => ({ sha: "old", encoding: "base64", content: Buffer.from(JSON.stringify({ "asset.bin": { type: "blob", gcsPath: `customers/alice/projects/demo/.objects/${"a".repeat(64)}`, sha256: "a".repeat(64), size: 3, mimeType: "application/octet-stream", uploadedAt: "2026-10-08" } })).toString("base64") }) }));
vi.mock("./route-helpers.js", () => ({ targetGiteaApi: h.write }));
import { removeUploadedWorkspaceBlob } from "./project-blob-edit.js";
it("versions a project asset deletion without cloud-write authority or erasing prior versions", async () => {
  await expect(removeUploadedWorkspaceBlob({ slug: "alice", projectSlug: "demo", provider: "gitea", org: "alice", repoName: "demo", gcsPrefix: "customers/alice/projects/demo", sudoUser: "ws-alice" }, "asset.bin")).resolves.toBeUndefined();
  expect(JSON.parse(Buffer.from((h.write.mock.calls[0] as unknown as [unknown, unknown, unknown, { content: string }])[3].content, "base64").toString())).toEqual({});
  expect(h.removeLegacy).not.toHaveBeenCalled();
});
