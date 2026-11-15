import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-toolchain-")); roots.push(root);
  const lock = JSON.stringify({ lockfileVersion: 3 });
  const groups = JSON.stringify({ groups: [{ enabled: true, delivery: "npm", commands: ["codex", "chromium"] }] });
  await fs.writeFile(path.join(root, "package-lock.json"), lock);
  await fs.writeFile(path.join(root, "groups.json"), groups);
  await fs.mkdir(path.join(root, "node_modules", ".bin"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", ".bin", "codex"), "#!/bin/sh\nprintf 'fixture codex\\n'\n", { mode: 0o755 });
  return { root, lock, groups };
}
function prepare(root: string, lock: string, groups: string) {
  return execFileSync(process.execPath, [realpathSync(path.resolve("../gateway/isolated-toolchain/preinstall.mjs")), root], {
    env: { ...process.env, BUILDER_TOOLCHAIN_LOCK_SHA256: lock, BUILDER_TOOL_GROUPS_SHA256: groups }, encoding: "utf8", stdio: "pipe",
  });
}
it("publishes pinned image metadata and executable command links without a home install", async () => {
  const { root, lock, groups } = await fixture();
  prepare(root, digest(lock), digest(groups));
  expect(execFileSync(path.join(root, "bin", "codex"), [], { encoding: "utf8" })).toBe("fixture codex\n");
  expect(JSON.parse(await fs.readFile(path.join(root, ".toolchain-lock.json"), "utf8"))).toMatchObject({
    lockSha256: digest(lock), groupsSha256: digest(groups), bundleSha256: digest(lock + groups),
  });
  await expect(fs.stat(path.join(root, "bin", "chromium"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("rejects changed image inputs before publishing a toolchain", async () => {
  const { root, groups } = await fixture();
  expect(() => prepare(root, "a".repeat(64), digest(groups))).toThrow(/image pins/);
  await expect(fs.stat(path.join(root, ".toolchain-lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
