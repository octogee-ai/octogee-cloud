import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNotHeld, assertNotHeldSync, findHeldPaths, matchUnder } from "../lib/held-files.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
}));

let root: string;
const descriptors = new Set<number>();
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "held-files-")); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const descriptor of descriptors) fs.closeSync(descriptor);
  descriptors.clear();
  fs.rmSync(root, { recursive: true, force: true });
});

function openStore(mode: "r" | "r+" = "r") {
  const file = path.join(root, "openclaw-agent.sqlite");
  fs.writeFileSync(file, "original-store");
  const fd = fs.openSync(file, mode);
  descriptors.add(fd);
  return { file, fd };
}

const linux = describe.runIf(process.platform === "linux");
linux("held destination file identity", () => {
  it.each([false, true])("allows a detached read-only inode without closing it (replacement=%s)", async (replacement) => {
    const { file, fd } = openStore();
    fs.unlinkSync(file);
    const original = fs.fstatSync(fd);
    expect(original.nlink).toBe(0);
    expect(fs.readlinkSync(`/proc/self/fd/${fd}`)).toBe(`${file} (deleted)`);
    if (replacement) {
      fs.writeFileSync(file, "replacement-store");
      const current = fs.statSync(file);
      expect([current.dev, current.ino]).not.toEqual([original.dev, original.ino]);
    }
    await expect(assertNotHeld(matchUnder(root), "/proc")).resolves.toBeUndefined();
    const bytes = Buffer.alloc(14);
    expect(fs.readSync(fd, bytes, 0, bytes.length, 0)).toBe(bytes.length);
    expect(bytes.toString()).toBe("original-store");
    expect(fs.fstatSync(fd).ino).toBe(original.ino);
    if (replacement) expect(fs.readFileSync(file, "utf8")).toBe("replacement-store");
    expect(() => assertNotHeldSync(matchUnder(root), "/proc")).toThrow("still held open");
  });

  it("blocks a read-only descriptor to the current destination inode", async () => {
    const { file } = openStore();
    await expect(findHeldPaths(matchUnder(root), "/proc")).resolves.toEqual([file]);
    await expect(assertNotHeld(matchUnder(root), "/proc")).rejects.toThrow("still held open");
  });

  it("blocks a detached writable descriptor", async () => {
    const { file } = openStore("r+");
    fs.unlinkSync(file);
    await expect(assertNotHeld(matchUnder(root), "/proc")).rejects.toThrow("still held open");
  });

  it("blocks a deleted pathname whose inode still has a linked alias", async () => {
    const { file, fd } = openStore();
    fs.linkSync(file, path.join(root, "retained.sqlite"));
    fs.unlinkSync(file);
    expect(fs.fstatSync(fd).nlink).toBe(1);
    await expect(assertNotHeld(matchUnder(root), "/proc")).rejects.toThrow("still held open");
  });

  it("blocks a detached nonregular descriptor", async () => {
    const directory = path.join(root, "agent");
    fs.mkdirSync(directory);
    descriptors.add(fs.openSync(directory, "r"));
    fs.rmdirSync(directory);
    await expect(assertNotHeld(matchUnder(root), "/proc")).rejects.toThrow("still held open");
  });

  it("blocks a detached descriptor with unknown access flags", async () => {
    const { file } = openStore();
    fs.unlinkSync(file);
    vi.spyOn(fsp, "readFile").mockResolvedValueOnce("flags: unknown\n" as never);
    await expect(assertNotHeld(matchUnder(root), "/proc")).rejects.toThrow("still held open");
  });

  it("blocks when detached descriptor identity cannot be read", async () => {
    const { file } = openStore();
    fs.unlinkSync(file);
    vi.spyOn(fsp, "stat").mockRejectedValueOnce(Object.assign(new Error("descriptor identity unavailable"), { code: "ENOENT" }));
    await expect(assertNotHeld(matchUnder(root), "/proc")).rejects.toThrow("still held open");
  });

  it.each(["EACCES", "EIO"])("blocks when current path identity fails (%s)", async (code) => {
    const { file } = openStore();
    fs.unlinkSync(file);
    const original = fsp.stat;
    vi.spyOn(fsp, "stat").mockImplementationOnce(original).mockRejectedValueOnce(Object.assign(new Error("path identity unavailable"), { code }));
    await expect(assertNotHeld(matchUnder(root), "/proc")).rejects.toThrow("still held open");
  });

  it("blocks a current path observation matching the held inode", async () => {
    const { file, fd } = openStore();
    fs.unlinkSync(file);
    const original = fsp.stat;
    vi.spyOn(fsp, "stat").mockImplementationOnce(original).mockResolvedValueOnce(fs.fstatSync(fd) as never);
    await expect(assertNotHeld(matchUnder(root), "/proc")).rejects.toThrow("still held open");
  });
});
