import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { readInstalledOpenClawBuild } from "../lib/openclaw-installed-build.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function installedBinary(buildInfo: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-installed-build-")); roots.push(root);
  const pkg = path.join(root, "lib/node_modules/openclaw"), binary = path.join(root, "bin/openclaw");
  await fs.mkdir(path.join(pkg, "dist"), { recursive: true });
  await fs.mkdir(path.dirname(binary));
  await fs.writeFile(path.join(pkg, "openclaw.mjs"), "", { mode: 0o755 });
  await fs.writeFile(path.join(pkg, "dist/build-info.json"), JSON.stringify(buildInfo));
  await fs.symlink("../lib/node_modules/openclaw/openclaw.mjs", binary);
  return binary;
}

it("reads the source commit of the package the openclaw binary links to", async () => {
  const binary = await installedBinary({ version: "2026.10.9", commit: "e10db5d5c8eef6f69cddfa6eb351cb6e7cfc453f" });

  await expect(readInstalledOpenClawBuild(binary)).resolves.toBe("e10db5d5c8eef6f69cddfa6eb351cb6e7cfc453f");
});

it("refuses an installed package without a source commit", async () => {
  const binary = await installedBinary({ version: "2026.10.9" });

  await expect(readInstalledOpenClawBuild(binary)).rejects.toThrow("has no source commit");
});

it("refuses a missing openclaw binary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-installed-build-")); roots.push(root);

  await expect(readInstalledOpenClawBuild(path.join(root, "openclaw"))).rejects.toThrow("ENOENT");
});
