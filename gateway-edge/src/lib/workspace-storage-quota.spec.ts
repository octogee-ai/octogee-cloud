import { afterEach, describe, expect, it } from "vitest";
import {
  installWorkspaceStorageAccounting,
  NO_WORKSPACE_STORAGE_ACCOUNTING,
  workspaceStorageAccounting,
  type WorkspaceStorageAccounting,
} from "./workspace-storage-quota.js";

const reservation = { slug: "mira", path: "files/a.bin", id: "r1", previousSize: 0, newSize: 3 };

afterEach(() => installWorkspaceStorageAccounting(NO_WORKSPACE_STORAGE_ACCOUNTING));

describe("workspace storage accounting without a product store", () => {
  it("refuses to reserve against a limit it cannot account for", async () => {
    await expect(workspaceStorageAccounting().reserve({
      slug: "mira", path: "files/a.bin", newSize: 3, manifestBytes: 0, manifestPathBytes: 0, limitBytes: 10,
    })).rejects.toThrow("no storage accounting is installed");
  });

  it("refuses to finalize or roll back a reservation it never made", async () => {
    await expect(workspaceStorageAccounting().finalize(reservation)).rejects.toThrow("no storage accounting");
    await expect(workspaceStorageAccounting().rollback(reservation)).rejects.toThrow("no storage accounting");
  });

  it("releases removed bytes as a no-op so unlimited workspaces can delete blobs", async () => {
    await expect(workspaceStorageAccounting().release({
      slug: "mira", path: "files/a.bin", removedBytes: 3,
    })).resolves.toBeUndefined();
  });
});

it("serves the installed accounting store", () => {
  const accounting: WorkspaceStorageAccounting = { ...NO_WORKSPACE_STORAGE_ACCOUNTING };
  installWorkspaceStorageAccounting(accounting);
  expect(workspaceStorageAccounting()).toBe(accounting);
});
