import { describe, expect, it, vi } from "vitest";

import { isBrokeredWritablePath } from "@octogee/core/workspace/route-helpers";
import {
  syncSavedGiteaCheckout,
  validatedSaveRequest,
} from "../routes/workspace/save.js";

describe("workspace save helpers", () => {
  it("validates text save requests while preserving empty string content", () => {
    expect(validatedSaveRequest({ path: "notes/empty.md", content: "" })).toEqual({
      ok: true,
      path: "notes/empty.md",
      content: "",
    });
  });

  it("rejects missing fields, unsafe paths, non-text files, and oversized content", () => {
    expect(validatedSaveRequest(undefined)).toEqual({
      ok: false,
      status: 400,
      error: "Missing path",
    });
    expect(validatedSaveRequest({ content: "x" })).toEqual({
      ok: false,
      status: 400,
      error: "Missing path",
    });
    expect(validatedSaveRequest({ path: "notes/x.md" })).toEqual({
      ok: false,
      status: 400,
      error: "Missing content",
    });
    expect(validatedSaveRequest({ path: "../x.md", content: "x" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(validatedSaveRequest({ path: "notes/pic.png", content: "x" })).toEqual({
      ok: false,
      status: 400,
      error: "Only text files can be saved",
      code: "NOT_TEXT",
    });
    expect(validatedSaveRequest({ path: "notes/huge.md", content: "x".repeat(1024 * 1024 + 1) })).toEqual({
      ok: false,
      status: 413,
      error: "Content too large",
      code: "TOO_LARGE",
    });
  });

  it("accepts the Canvas dashboard document as the only writable hidden path", () => {
    expect(validatedSaveRequest({ path: ".octogee/canvas.json", content: "{}" })).toEqual({
      ok: true,
      path: ".octogee/canvas.json",
      content: "{}",
    });
    expect(isBrokeredWritablePath(".octogee/canvas.json", "README.md")).toBe(true);
    expect(isBrokeredWritablePath(".octogee/other.json", "README.md")).toBe(false);
  });

  it("converges the project checkout selected by a successful Canvas Gitea save", async () => {
    const syncCleanWorkspaceToRemote = vi.fn(async () => ({
      ok: true as const,
      result: { state: "fast-forwarded" as const },
    }));
    const resolveProjectDir = vi.fn(async () => "/customers/alice/projects/lantern");

    await expect(
      syncSavedGiteaCheckout(
        {
          slug: "alice",
          projectSlug: "lantern",
          provider: "gitea",
          org: "alice",
          repoName: "lantern",
          gcsPrefix: "customers/alice/projects/lantern",
        },
        {
          usersRoot: "/customers",
          resolveUserDir: vi.fn(async () => null),
          resolveProjectDir,
          syncCleanWorkspaceToRemote,
        },
      ),
    ).resolves.toBe("fast-forwarded");
    expect(resolveProjectDir).toHaveBeenCalledWith("/customers", "alice", "lantern");
    expect(syncCleanWorkspaceToRemote).toHaveBeenCalledWith(
      "/customers/alice/projects/lantern",
    );
  });
});
