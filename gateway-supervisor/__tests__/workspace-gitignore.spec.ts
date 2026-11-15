import { describe, expect, it } from "vitest";

import { workspaceGitignore } from "../lib/git.js";

describe("workspaceGitignore", () => {
  it("excludes project clones wholesale — project repos have their own commit path", () => {
    const content = workspaceGitignore();
    expect(content).toMatch(/^projects\/$/m);
    expect(content).not.toContain("projects/*/src");
  });

  it("keeps the provisioner-managed system files out of the workspace repo", () => {
    const content = workspaceGitignore();
    for (const line of ["PROJECTS.md", ".system/", ".openclaw/", ".ssh/", ".blobs/", "node_modules/"]) {
      expect(content).toContain(line);
    }
  });

  // openclaw owns this file and 2026.7.2 treats it as unmigrated legacy state:
  // its presence makes every agent turn throw "Legacy workspace setup state
  // requires migration". `.openclaw/` covers the current state directory, but
  // the older root-level filename was never excluded, so it was auto-committed
  // into workspace repos — and from there every mount's clone restores it,
  // outliving pod rolls, releases, and openclaw's own migration.
  it("excludes openclaw's workspace state file so a clone cannot restore it", () => {
    expect(workspaceGitignore()).toMatch(/^openclaw-workspace-state\.json$/m);
  });
});
