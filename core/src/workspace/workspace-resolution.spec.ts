import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../identity/platform-state-store.js", async () => {
  const { createDocumentFixtureStore } = await import("@octogee/core-testing/journal-store");
  return { platformStateStore: createDocumentFixtureStore(h.docs) };
});

const { resolveWorkspaceUid } = await import("./workspace-resolution.js");

describe("resolveWorkspaceUid", () => {
  beforeEach(() => {
    h.docs.clear();
  });

  it("returns the workspace owner uid when the workspace exists", async () => {
    h.docs.set("workspaces/acme", { id: "acme", ownerUid: "uid-1" });

    await expect(resolveWorkspaceUid("acme")).resolves.toBe("uid-1");
  });

  it("returns null when the workspace is absent", async () => {
    await expect(resolveWorkspaceUid("missing")).resolves.toBeNull();
  });
});
