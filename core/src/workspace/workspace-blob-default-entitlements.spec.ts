import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BlobStore } from "./blob-store.js";
import type { FileTarget } from "./fileTarget.js";

const h = vi.hoisted(() => ({ updateManifest: vi.fn(), getManifestForQuota: vi.fn() }));

vi.mock("../identity/platform-state-store.js", async () => {
  const { createDocumentFixtureStore } = await import("../testing/journal-store.js");
  return {
    platformStateStore: createDocumentFixtureStore(new Map<string, Record<string, unknown>>([
      ["workspaces/alice", { id: "alice", ownerUid: "uid-alice" }],
      ["users/uid-alice", { username: "alice", email: "alice@example.test", createdAt: 1 }],
    ])),
  };
});
vi.mock("./manifest.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./manifest.js")>(),
  updateManifest: h.updateManifest,
  getManifestForQuota: h.getManifestForQuota,
}));

const { installDefaultUserEntitlements } = await import("@octogee/shared/types/user-entitlements");
const { storeWorkspaceBlob } = await import("./workspace-blob.js");
const { installWorkspaceStorageAccounting, NO_WORKSPACE_STORAGE_ACCOUNTING, workspaceStorageAccounting } =
  await import("@octogee/shared/types/workspace-storage-quota");

const workspace: FileTarget = {
  slug: "alice",
  projectSlug: null,
  provider: "gitea",
  org: "octogee-alice",
  repoName: "alice-workspace",
  gcsPrefix: "customers/alice/workspace",
  sudoUser: "ws-alice",
};

beforeEach(() => {
  installDefaultUserEntitlements();
  installWorkspaceStorageAccounting(NO_WORKSPACE_STORAGE_ACCOUNTING);
  h.updateManifest.mockResolvedValue(undefined);
  h.getManifestForQuota.mockResolvedValue({});
});
afterEach(() => installWorkspaceStorageAccounting(NO_WORKSPACE_STORAGE_ACCOUNTING));

it("stores a workspace blob without storage accounting when the default entitlements set no storage limit", async () => {
  const save = vi.fn(async () => undefined);
  const blobStore = { save } as unknown as BlobStore;
  const reserve = vi.spyOn(workspaceStorageAccounting(), "reserve");

  await expect(storeWorkspaceBlob(workspace, "files/report.pdf", Buffer.from("pdf"), undefined, { blobStore }))
    .resolves.toEqual({ gcsPath: "customers/alice/workspace/files/report.pdf", size: 3 });

  expect(reserve).not.toHaveBeenCalled();
  expect(save).toHaveBeenCalledWith("customers/alice/workspace/files/report.pdf", Buffer.from("pdf"), expect.anything());
});
