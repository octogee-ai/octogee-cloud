import { describe, it, expect } from "vitest";
import {
  parseReconcileArgs,
  rewriteRepoUrl,
} from "../ops/reconcile-gitea-org.js";

describe("parseReconcileArgs", () => {
  it("parses a dry-run invocation (apply defaults false)", () => {
    expect(parseReconcileArgs(["--env=test", "--slug=tester90"])).toEqual({
      env: "test",
      slug: "tester90",
      apply: false,
    });
  });

  it("--apply flips apply true", () => {
    expect(
      parseReconcileArgs(["--env=prod", "--slug=ceckert", "--apply"]).apply,
    ).toBe(true);
  });

  it("rejects bad --env / --slug / unknown arg", () => {
    expect(() => parseReconcileArgs(["--env=stage", "--slug=x"])).toThrow(/--env/);
    expect(() => parseReconcileArgs(["--env=test", "--slug=Up/er"])).toThrow(/--slug/);
    expect(() => parseReconcileArgs(["--env=test"])).toThrow(/--slug/);
    expect(() =>
      parseReconcileArgs(["--env=test", "--slug=x", "--force"]),
    ).toThrow(/Unknown arg/);
  });
});

describe("rewriteRepoUrl", () => {
  it("swaps only the owner/repo segment, preserving scheme/host/auth/.git", () => {
    expect(
      rewriteRepoUrl(
        "http://octogee-admin:tok@git/octogee/tester90-workspace.git",
        "octogee",
        "tester90-workspace",
        "tester90",
        "workspace",
      ),
    ).toBe("http://octogee-admin:tok@git/tester90/workspace.git");
  });

  it("rewrites the scp-form SSH URL (the ONLY shape initWorkspaceRepo writes)", () => {
    expect(
      rewriteRepoUrl(
        "git@gitea:octogee/tester90-workspace.git",
        "octogee",
        "tester90-workspace",
        "tester90",
        "workspace",
      ),
    ).toBe("git@gitea:tester90/workspace.git");
  });

  it("is a no-op (lossless) when the old segment is absent — already new / unknown", () => {
    const already = "http://git/tester90/workspace.git";
    expect(
      rewriteRepoUrl(already, "octogee", "tester90-workspace", "tester90", "workspace"),
    ).toBe(already);
  });

  it("replaces the last occurrence (handles a host that echoes the path)", () => {
    expect(
      rewriteRepoUrl(
        "https://octogee/tester90-blog@h/octogee/tester90-blog.git",
        "octogee",
        "tester90-blog",
        "tester90",
        "blog",
      ),
    ).toBe("https://octogee/tester90-blog@h/tester90/blog.git");
  });
});
