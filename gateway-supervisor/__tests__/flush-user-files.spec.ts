import { afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { flushUserFiles } from "../lib/user-file-state.js";

const barrier = vi.hoisted(() => vi.fn<(file: string, args: string[]) => void>());
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile(file: string, args: string[], callback: (error: Error | null) => void) {
    try { barrier(file, args); callback(null); } catch (error) { callback(error as Error); }
  },
}));

const stat = vi.hoisted(() => vi.fn<typeof import("node:fs/promises")["lstat"]>());
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  stat.mockImplementation(actual.lstat);
  return { ...actual, lstat: stat };
});
const roots: string[] = [];
afterEach(async () => {
  barrier.mockReset();
  stat.mockClear();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

it.each([false, true])("uses one filesystem barrier per device (split mount: %s)", async separateKeys => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "user-file-state-"));
  roots.push(root);
  const workspace = path.join(root, "customers/alice");
  const gitRoot = path.join(root, "git-metadata/alice");
  const keys = path.join(root, "customer-keys/alice");
  for (const directory of [workspace, gitRoot, keys]) await fs.mkdir(directory, { recursive: true });
  const real = await vi.importActual<typeof fs>("node:fs/promises");
  stat.mockImplementation(async (file, options) => {
    const result = await real.lstat(file, options);
    return separateKeys && file === keys ? Object.assign(result, { dev: typeof result.dev === "bigint" ? result.dev + 1n : result.dev + 1 }) : result;
  });

  try {
    await flushUserFiles("alice", { root });
    expect(barrier.mock.calls).toEqual([
      ["/usr/bin/sync", ["-f", workspace]],
      ...(separateKeys ? [["/usr/bin/sync", ["-f", keys]]] : []),
    ]);
  } finally {
    stat.mockImplementation(real.lstat);
  }
});

it("fails explicitly when a required filesystem barrier fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "user-file-state-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "customers/alice"), { recursive: true });
  barrier.mockImplementation(() => { throw new Error("filesystem sync failed"); });
  await expect(flushUserFiles("alice", { root })).rejects.toThrow("filesystem sync failed");
});

it("validates all present flush roots before acknowledging durability", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "user-file-state-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "customers/alice"), { recursive: true });
  await fs.mkdir(path.join(root, "customer-keys"), { recursive: true });
  await fs.symlink(path.join(root, "customers/alice"), path.join(root, "customer-keys/alice"));
  await expect(flushUserFiles("alice", { root })).rejects.toThrow("User state is not a directory");
  expect(barrier).not.toHaveBeenCalled();
});


it("propagates stat failures on a secondary flush root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "user-file-state-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "customers/alice"), { recursive: true });
  const real = await vi.importActual<typeof fs>("node:fs/promises");
  const denied = Object.assign(new Error("cannot read Git metadata"), { code: "EACCES" });
  stat.mockImplementation(async (file, options) => {
    if (file === path.join(root, "git-metadata/alice")) throw denied;
    return real.lstat(file, options);
  });
  try {
    await expect(flushUserFiles("alice", { root })).rejects.toBe(denied);
    expect(barrier).not.toHaveBeenCalled();
  } finally {
    stat.mockImplementation(real.lstat);
  }
});
