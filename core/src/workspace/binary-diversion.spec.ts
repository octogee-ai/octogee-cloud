import { lstat, mkdtemp, readFile, rm, symlink, truncate, writeFile, mkdir, open, utimes } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

import { gitStatus } from "./workspace-git.js";
import { storeWorkspaceBlob } from "./workspace-blob.js";
import {
  divertWorktreeBinaries,
  isDivertablePath,
  looksBinary,
  MAX_DIVERTED_BLOB_BYTES,
  type DivertBinariesDeps,
} from "./binary-diversion.js";
import type { WorkspaceGitStatusEntry } from "./workspace-git.js";
import { logger } from "../http/logging.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "octogee-divert-"));
  dirs.push(parent);
  const dir = path.join(parent, "project");
  await mkdir(dir);
  await mkdir(path.join(dir, ".git"));
  return dir;
}

const target = { slug: "aug29", projectSlug: null, gcsPrefix: "customers/aug29" };

function deps(
  entries: WorkspaceGitStatusEntry[],
  store: Mock<(...args: never[]) => Promise<unknown>> = vi.fn(async () => ({ gcsPath: "g", size: 1 })),
): DivertBinariesDeps {
  return {
    gitStatus: vi.fn(async () => ({ ok: true as const, entries })),
    storeWorkspaceBlob: store as unknown as DivertBinariesDeps["storeWorkspaceBlob"],
  };
}

describe("looksBinary", () => {
  it("treats a NUL byte as binary and plain text as text", () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x00, 0x4e]))).toBe(true);
    expect(looksBinary(Buffer.from("# notes\nhello\n"))).toBe(false);
  });

  it("ignores a NUL that appears beyond the sniff window, as git does", () => {
    const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00])]);
    expect(looksBinary(late)).toBe(false);
  });
});

describe("isDivertablePath", () => {
  it("leaves the stores and git metadata alone", () => {
    expect(isDivertablePath(".blobs/avatar.png")).toBe(false);
    expect(isDivertablePath(".files/manifest.json")).toBe(false);
    expect(isDivertablePath(".git/config")).toBe(false);
  });

  it("refuses traversal and absolute paths", () => {
    expect(isDivertablePath("../escape.png")).toBe(false);
    expect(isDivertablePath("a/../../escape.png")).toBe(false);
    expect(isDivertablePath("/etc/passwd")).toBe(false);
  });

  it("accepts ordinary workspace paths", () => {
    expect(isDivertablePath("notes/diagram.png")).toBe(true);
  });
});

describe("divertWorktreeBinaries", () => {
  const linuxTest = it.skipIf(process.platform !== "linux");

  linuxTest("does not reread unchanged retained binaries, but saves timestamp-preserving edits and deletions", async () => {
    const dir = await workspace();
    const binary = path.join(dir, "asset.png");
    await writeFile(binary, Buffer.from([0, 1]));
    const probe = await open(binary, "r");
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const read = prototype.readFile;
    let payloadReads = 0;
    vi.spyOn(prototype, "readFile").mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (args.length === 0) payloadReads++;
      return read.apply(this, args);
    });
    const store = vi.fn(async (_target, _name, body: Buffer) => {
      const sha256 = createHash("sha256").update(body).digest("hex");
      return { gcsPath: `${target.gcsPrefix}/.objects/${sha256}`, sha256, size: body.length };
    });
    const d = deps([{ path: "asset.png", change: "untracked" }], store);
    await divertWorktreeBinaries(dir, target, d, { retainLocalFiles: true });
    vi.mocked(d.gitStatus).mockResolvedValue({ ok: true, entries: [] });
    for (let save = 0; save < 2; save++) {
      expect((await divertWorktreeBinaries(dir, target, d, { retainLocalFiles: true })).diverted)
        .toEqual([{ path: "asset.png", size: 2 }]);
    }
    expect(payloadReads).toBe(1);
    const before = await lstat(binary);
    await writeFile(binary, Buffer.from([0, 2]));
    await utimes(binary, before.atime, before.mtime);
    await divertWorktreeBinaries(dir, target, d, { retainLocalFiles: true });
    expect(payloadReads).toBe(2);
    expect(store).toHaveBeenCalledTimes(2);
    await rm(binary);
    await divertWorktreeBinaries(dir, target, d, { retainLocalFiles: true });
    expect(JSON.parse(await readFile(path.join(dir, ".files/manifest.json"), "utf8"))).toEqual({});
  });
  linuxTest("saves edits to materialized assets even when Git ignores their paths, and versions conversion to text", async () => {
    const dir = await workspace();
    const binary = path.join(dir, "asset.png");
    const store = vi.fn(async (_target, _name, body: Buffer) => {
      const sha256 = createHash("sha256").update(body).digest("hex");
      return { gcsPath: `${target.gcsPrefix}/.objects/${sha256}`, sha256, size: body.length };
    });
    const d = deps([{ path: "asset.png", change: "untracked" }], store);
    await writeFile(binary, Buffer.from([0, 1]));
    await divertWorktreeBinaries(dir, target, d, { retainLocalFiles: true });
    vi.mocked(d.gitStatus).mockResolvedValue({ ok: true, entries: [] });
    await writeFile(binary, Buffer.from([0, 2]));
    expect((await divertWorktreeBinaries(dir, target, d, { retainLocalFiles: true })).diverted).toEqual([{ path: "asset.png", size: 2 }]);
    expect(store).toHaveBeenCalledTimes(2);
    await writeFile(binary, "now text");
    await divertWorktreeBinaries(dir, target, d, { retainLocalFiles: true });
    expect(JSON.parse(await readFile(path.join(dir, ".files/manifest.json"), "utf8"))["asset.png"].sha256).toBe(createHash("sha256").update("now text").digest("hex"));
    expect(store).toHaveBeenCalledTimes(3);
  });
  linuxTest("keeps active project assets in place during autosave and reports changed files as unsaved", async () => {
    const dir = await workspace();
    const binary = path.join(dir, "asset.png");
    const bytes = Buffer.from([0, 1, 2, 3]);
    await writeFile(binary, bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const store = vi.fn(async () => ({ gcsPath: `${target.gcsPrefix}/.objects/${sha256}`, sha256, size: 4 }));
    const d = deps([{ path: "asset.png", change: "untracked" }], store);
    expect((await divertWorktreeBinaries(dir, target, d, { retainLocalFiles: true })).diverted).toEqual([{ path: "asset.png", size: 4 }]);
    expect(await readFile(binary)).toEqual(bytes);
    expect(JSON.parse(await readFile(path.join(dir, ".files/manifest.json"), "utf8"))["asset.png"].sha256).toBe(sha256);
    await divertWorktreeBinaries(dir, target, d, { retainLocalFiles: true });
    expect(store).toHaveBeenCalledTimes(1);
    await writeFile(binary, Buffer.from([0, 9, 8, 7]));
    store.mockImplementation(async () => { await writeFile(binary, Buffer.from([0, 4, 5])); return { gcsPath: "g", sha256, size: 4 }; });
    expect((await divertWorktreeBinaries(dir, target, d, { retainLocalFiles: true })).failedPaths).toEqual(["asset.png"]);
    expect(await readFile(binary)).toEqual(Buffer.from([0, 4, 5]));
  });
  linuxTest("uploads a binary and removes it so the commit never sees it", async () => {
    const dir = await workspace();
    await mkdir(path.join(dir, "notes"), { recursive: true });
    const binary = path.join(dir, "notes/diagram.png");
    await writeFile(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));

    const store = vi.fn(async () => ({ gcsPath: "g", size: 6 }));
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "notes/diagram.png", change: "untracked" }], store),
    );

    expect(result.diverted).toEqual([{ path: "notes/diagram.png", size: 6 }]);
    expect(result.failures).toEqual([]);
    expect(existsSync(binary)).toBe(false);
    expect(store).toHaveBeenCalledWith(target, "notes/diagram.png", expect.any(Buffer), "image/png");
  });

  it("leaves text files for git", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "IDENTITY.md"), "- Name: Zippy\n");

    const store = vi.fn(async (..._args: unknown[]) => ({ gcsPath: "g", size: 1 }));
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "IDENTITY.md", change: "modified" }], store),
    );

    expect(result.diverted).toEqual([]);
    expect(store).not.toHaveBeenCalled();
    expect(existsSync(path.join(dir, "IDENTITY.md"))).toBe(true);
  });

  it("never re-diverts what already lives in the blob store", async () => {
    const dir = await workspace();
    await mkdir(path.join(dir, ".blobs"), { recursive: true });
    await writeFile(path.join(dir, ".blobs/avatar.png"), Buffer.from([0x00, 0x01]));

    const store = vi.fn(async () => ({ gcsPath: "g", size: 2 }));
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: ".blobs/avatar.png", change: "untracked" }], store),
    );

    expect(store).not.toHaveBeenCalled();
    expect(result.diverted).toEqual([]);
    expect(existsSync(path.join(dir, ".blobs/avatar.png"))).toBe(true);
  });

  it("skips deletions rather than trying to read them", async () => {
    const dir = await workspace();
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "gone.png", change: "deleted" }]),
    );
    expect(result).toEqual({ diverted: [], failures: [], failedPaths: [] });
  });

  linuxTest("reports an upload failure instead of deleting the file", async () => {
    const dir = await workspace();
    const binary = path.join(dir, "logo.png");
    await writeFile(binary, Buffer.from([0x00, 0x01]));

    const store = vi.fn(async () => {
      throw new Error("quota exceeded");
    });
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "logo.png", change: "untracked" }], store),
    );

    expect(result.diverted).toEqual([]);
    expect(result.failures[0]).toContain("quota exceeded");
    expect(existsSync(binary)).toBe(true);
  });

  it("surfaces a git status failure rather than silently committing binaries", async () => {
    const dir = await workspace();
    const result = await divertWorktreeBinaries(dir, target, {
      gitStatus: vi.fn(async () => ({
        ok: false as const,
        error: { code: "GIT_FAILED" as const, cwd: dir, status: 1, stderr: "boom" },
      })),
      storeWorkspaceBlob: vi.fn() as unknown as DivertBinariesDeps["storeWorkspaceBlob"],
    });
    expect(result.failures).toEqual(["git status failed: GIT_FAILED"]);
  });

  it("logs each path it could not save and why", async () => {
    const dir = await workspace();
    await symlink("/etc", path.join(dir, "linked"));
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "linked/hosts", change: "untracked" }]),
    );

    expect(result.failedPaths).toEqual(["linked/hosts"]);
    expect(error).toHaveBeenCalledWith("workspace binary diversion failed", {
      cwd: dir,
      failures: result.failures,
    });
    expect(result.failures[0]).toMatch(/^linked\/hosts: .+/);
  });

  linuxTest("rejects an oversize blob without reading it into memory", async () => {
    const dir = await workspace();
    const big = path.join(dir, "huge.bin");
    await writeFile(big, Buffer.from([0x00]));
    await truncate(big, MAX_DIVERTED_BLOB_BYTES + 1);

    const store = vi.fn(async () => ({ gcsPath: "g", size: 0 }));
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "huge.bin", change: "untracked" }], store),
    );

    expect(store).not.toHaveBeenCalled();
    expect(result.failures[0]).toContain("exceeds the blob limit");
    expect(existsSync(big)).toBe(true);
  });

  linuxTest("refuses a symlink instead of reading and publishing whatever it points at", async () => {
    const dir = await workspace();
    const outside = path.join(dir, "..", `octogee-outside-${process.pid}.bin`);
    await writeFile(outside, Buffer.from([0x00, 0x01, 0x02]));
    dirs.push(outside);
    await symlink(outside, path.join(dir, "innocent.bin"));

    const store = vi.fn(async () => ({ gcsPath: "g", size: 3 }));
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "innocent.bin", change: "untracked" }], store),
    );

    expect(store).not.toHaveBeenCalled();
    expect(result.diverted).toEqual([]);
    expect(result.failures[0]).toContain("symlink");
    expect(existsSync(outside)).toBe(true);
  });

  linuxTest("never reads an outside secret through a symlinked workspace directory", async () => {
    const dir = await workspace();
    const outside = await workspace();
    const secret = Buffer.from([0x00, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74]);
    await writeFile(path.join(outside, "secret.bin"), secret);
    await symlink(outside, path.join(dir, "assets"), "dir");

    const store = vi.fn(async () => ({ gcsPath: "g", size: secret.length }));
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "assets/secret.bin", change: "untracked" }], store),
    );

    expect(store).not.toHaveBeenCalled();
    expect(result.diverted).toEqual([]);
    expect(result.failures[0]).toContain("symlink");
    expect(await readFile(path.join(outside, "secret.bin"))).toEqual(secret);
  });

  linuxTest("does not remove a path replaced while the staged binary uploads", async () => {
    const dir = await workspace();
    const binary = path.join(dir, "logo.bin");
    const original = Buffer.from([0x00, 0x01, 0x02]);
    const outside = path.join(dir, "..", `octogee-outside-${process.pid}.bin`);
    await writeFile(binary, original);
    await writeFile(outside, Buffer.from([0x00, 0x03]));
    dirs.push(outside);

    const store = vi.fn(async (..._args: unknown[]) => {
      await symlink(outside, binary);
      return { gcsPath: "g", size: 3 };
    });
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "logo.bin", change: "untracked" }], store),
    );

    expect(store.mock.calls[0]?.[2]).toEqual(original);
    expect(result.diverted).toEqual([{ path: "logo.bin", size: original.length }]);
    expect(result.failures).toEqual([]);
    expect((await lstat(binary)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside)).toEqual(Buffer.from([0x00, 0x03]));
  });

  linuxTest("leaves a regular file replacement created during upload", async () => {
    const dir = await workspace();
    const binary = path.join(dir, "logo.bin");
    const original = Buffer.from([0x00, 0x01, 0x02]);
    const replacement = Buffer.from([0x00, 0x09, 0x08, 0x07]);
    await writeFile(binary, original);

    const store = vi.fn(async (..._args: unknown[]) => {
      await writeFile(binary, replacement);
      return { gcsPath: "g", size: original.length };
    });
    const result = await divertWorktreeBinaries(
      dir,
      target,
      deps([{ path: "logo.bin", change: "untracked" }], store),
    );

    expect(store.mock.calls[0]?.[2]).toEqual(original);
    expect(result.diverted).toEqual([{ path: "logo.bin", size: original.length }]);
    expect(result.failures).toEqual([]);
    expect(await readFile(binary)).toEqual(replacement);
  });

  linuxTest("finds a binary inside a brand-new directory, which git collapses by default", async () => {
    const dir = await workspace();
    execFileSync("git", ["init", "-b", "main", dir]);
    execFileSync("git", ["-C", dir, "config", "user.email", "t@t.t"]);
    execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
    await writeFile(path.join(dir, "README.md"), "hi\n");
    execFileSync("git", ["-C", dir, "add", "."]);
    execFileSync("git", ["-C", dir, "commit", "-m", "initial"]);

    await mkdir(path.join(dir, "images"), { recursive: true });
    await writeFile(path.join(dir, "images/logo.png"), Buffer.from([0x89, 0x50, 0x00]));

    const store = vi.fn(async () => ({ gcsPath: "g", size: 3 }));
    const result = await divertWorktreeBinaries(dir, target, {
      gitStatus,
      storeWorkspaceBlob: store as unknown as typeof storeWorkspaceBlob,
    });

    expect(result.diverted.map((d) => d.path)).toEqual(["images/logo.png"]);
    expect(existsSync(path.join(dir, "images/logo.png"))).toBe(false);
  });

  linuxTest("reads the file it uploads", async () => {
    const dir = await workspace();
    const bytes = Buffer.from([0x00, 0x11, 0x22]);
    await writeFile(path.join(dir, "a.bin"), bytes);
    const store = vi.fn(async (..._args: unknown[]) => ({ gcsPath: "g", size: 3 }));
    await divertWorktreeBinaries(dir, target, deps([{ path: "a.bin", change: "added" }], store));
    const uploaded = store.mock.calls[0][2] as unknown as Buffer;
    expect(Buffer.compare(uploaded, bytes)).toBe(0);
    await expect(readFile(path.join(dir, "a.bin")).catch(() => "gone")).resolves.toBe("gone");
  });
});
