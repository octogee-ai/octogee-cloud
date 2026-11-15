import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// Mock the config module before importing git.ts (which imports it at load
// time and would otherwise read env vars / hit the real filesystem).
import { vi } from "vitest";
vi.mock("../lib/config.js", () => ({
  log: () => {},
  dlog: () => {},
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_SSH_HOST: "gitea.test",
  OPENCLAW_DIR: "/tmp/octogee-fixture",
  CUSTOMERS_DIR: "/tmp/octogee-fixture/users-doesnt-exist",
  CUSTOMER_KEYS_DIR: "/tmp/octogee-fixture/keys",
  AGENTS_DIR: "/tmp/octogee-fixture/agents",
}));

const {
  errMessage,
  execErrStderr,
  listOnDiskUserSlugs,
  userSshKeyPath,
  adoptProjectClone,
} = await import("../lib/git.js");

describe("adoptProjectClone", () => {
  it("attaches the canonical Git checkout to an existing local prototype without losing either tree", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-clone-adopt-"));
    const cloneDir = path.join(root, "clone");
    const dest = path.join(root, "launchroom");
    fs.mkdirSync(path.join(cloneDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(cloneDir, "README.md"), "canonical\n");
    fs.writeFileSync(path.join(cloneDir, "docs", "brief.md"), "brief\n");
    execFileSync("git", ["init", "-b", "main", cloneDir]);
    execFileSync("git", ["config", "user.email", "test@octogee.test"], { cwd: cloneDir });
    execFileSync("git", ["config", "user.name", "Octogee Test"], { cwd: cloneDir });
    execFileSync("git", ["add", "-A"], { cwd: cloneDir });
    execFileSync("git", ["commit", "-m", "canonical"], { cwd: cloneDir });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, "README.md"), "local prototype\n");
    fs.writeFileSync(path.join(dest, "index.html"), "<h1>Launch Room</h1>\n");

    try {
      adoptProjectClone(cloneDir, dest);

      expect(fs.readFileSync(path.join(dest, "README.md"), "utf8")).toBe("local prototype\n");
      expect(fs.readFileSync(path.join(dest, "index.html"), "utf8")).toContain("Launch Room");
      expect(fs.readFileSync(path.join(dest, "docs", "brief.md"), "utf8")).toBe("brief\n");
      expect(fs.existsSync(path.join(dest, ".git"))).toBe(true);
      expect(fs.existsSync(cloneDir)).toBe(false);
      expect(execFileSync("git", ["status", "--short"], { cwd: dest, encoding: "utf8" }))
        .toBe(" M README.md\n?? index.html\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an existing destination symlink without writing outside the project", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-clone-adopt-symlink-"));
    const cloneDir = path.join(root, "clone");
    const dest = path.join(root, "launchroom");
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(cloneDir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(cloneDir, ".git"));
    fs.writeFileSync(path.join(cloneDir, "docs", "brief.md"), "canonical brief\n");
    fs.mkdirSync(dest);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dest, "docs"), "dir");

    try {
      expect(() => adoptProjectClone(cloneDir, dest)).toThrow(/symbolic link/u);
      expect(fs.existsSync(path.join(outside, "brief.md"))).toBe(false);
      expect(fs.existsSync(path.join(dest, ".git"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("errMessage", () => {
  it("returns .message for Error instances", () => {
    expect(errMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values without throwing", () => {
    expect(errMessage("plain string")).toBe("plain string");
    expect(errMessage(42)).toBe("42");
    expect(errMessage(null)).toBe("null");
    expect(errMessage(undefined)).toBe("undefined");
    expect(errMessage({ code: "ENOENT" })).toBe("[object Object]");
  });

  it("handles thrown values that look error-ish but aren't Error", () => {
    expect(errMessage({ message: "oops" })).toBe("[object Object]");
  });
});

describe("execErrStderr", () => {
  it("returns trimmed stderr when err has a .stderr with .toString()", () => {
    const e = { stderr: Buffer.from("  build failed\n") };
    expect(execErrStderr(e)).toBe("build failed");
  });

  it("returns empty string when err has no stderr", () => {
    expect(execErrStderr(new Error("plain"))).toBe("");
    expect(execErrStderr({})).toBe("");
    expect(execErrStderr(null)).toBe("");
    expect(execErrStderr(undefined)).toBe("");
    expect(execErrStderr("string err")).toBe("");
  });

  it("returns empty string when err.stderr is a string (no .toString function form)", () => {
    // Plain string stderr lacks the typeof-function check we guard on
    // (string has toString but it's a method, not a stderr.toString
    // bound to that particular value). Confirms we don't accidentally
    // accept a non-Buffer/non-object stderr shape.
    expect(execErrStderr({ stderr: "raw" })).toBe("raw");
  });
});

describe("userSshKeyPath", () => {
  it("composes the per-slug key path under CUSTOMER_KEYS_DIR", () => {
    expect(userSshKeyPath("acme")).toBe(
      "/tmp/octogee-fixture/keys/acme/id_ed25519",
    );
  });
});

describe("listOnDiskUserSlugs", () => {
  it("returns [] when CUSTOMERS_DIR doesn't exist (no throw)", () => {
    // Mocked CUSTOMERS_DIR points at a path that doesn't exist;
    // the function must short-circuit cleanly so syncAllWorkspaces
    // is a no-op on fresh gateway boots before any provisioning.
    expect(listOnDiskUserSlugs()).toEqual([]);
  });
});
