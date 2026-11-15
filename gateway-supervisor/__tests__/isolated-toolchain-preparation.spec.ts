import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { waitForPreparedIsolatedToolchain } from "../lib/isolated-toolchain-preparation.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
it("waits until the current pin is ready even when a parked image left ready status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prepared-tools-")); roots.push(root);
  await fs.mkdir(path.join(root, "active"));
  await fs.writeFile(path.join(root, "status.json"), JSON.stringify({ schemaVersion: 1, status: "ready", updatedAt: new Date().toISOString() }));
  await fs.writeFile(path.join(root, "active/.toolchain-lock.json"), JSON.stringify({ lockSha256: "old", groupsSha256: "groups" }));
  let clock = 0;
  await waitForPreparedIsolatedToolchain({ root, lockSha256: "current", groupsSha256: "groups", now: () => clock, wait: async ms => {
    clock += ms;
    await fs.writeFile(path.join(root, "active/.toolchain-lock.json"), JSON.stringify({ lockSha256: "current", groupsSha256: "groups" }));
  } });
  expect(clock).toBe(1_000);
});
it("fails preparation before the source pause when tools cannot become ready", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "prepared-tools-")); roots.push(root);
  let clock = 0;
  await expect(waitForPreparedIsolatedToolchain({ root, lockSha256: "current", groupsSha256: "groups", timeoutMs: 1_000, now: () => clock, wait: async ms => { clock += ms; } })).rejects.toThrow("pinned toolchain");
});
