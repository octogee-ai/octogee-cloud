#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceArgument = process.argv[2] ?? process.env.OPENCLAW_SOURCE_DIR;
const expectedCommit = process.argv[3] ?? process.env.OPENCLAW_SOURCE_SHA;
if (!sourceArgument || !/^[a-f0-9]{40}$/u.test(expectedCommit ?? "")) {
  throw new Error("Usage: verify-activity-plugin-contract.mjs <clean-openclaw-source> <full-source-sha>");
}
const source = realpathSync(sourceArgument);
const git = (...args) => execFileSync("/usr/bin/git", ["-C", source, ...args], { encoding: "utf8" }).trim();
if (git("rev-parse", "HEAD") !== expectedCommit) throw new Error("OpenClaw source does not match the requested commit");
if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("OpenClaw source must be clean for the Activity SDK contract check");
const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
if (manifest.name !== "openclaw" || !manifest.exports?.["./plugin-sdk/core"]) {
  throw new Error("OpenClaw source does not export the native plugin SDK");
}
const compiler = realpathSync(path.join(source, "node_modules/typescript/lib/tsc.js"));
if (!compiler.startsWith(`${source}${path.sep}`)) throw new Error("The TypeScript compiler must belong to the selected OpenClaw checkout");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "gateway/extensions/platform/octogee-activity-tools");
const nativeConfig = JSON.parse(readFileSync(path.join(source, "tsconfig.json"), "utf8"));
const paths = Object.fromEntries(Object.entries(nativeConfig.compilerOptions.paths).map(([key, values]) => [key, values.map(value => path.resolve(source, value))]));
paths["@octogee/core/*"] = [path.join(repoRoot, "core/dist/*.d.ts")];
paths["@octogee/shared/*"] = [path.join(repoRoot, "shared/dist/*.d.ts")];
const vitestRoot = path.join(repoRoot, "tests/node_modules/vitest");
const vitest = JSON.parse(readFileSync(path.join(vitestRoot, "package.json"), "utf8"));
if (typeof vitest.types !== "string") throw new Error("The test dependency must declare its Vitest types");
paths.vitest = [path.resolve(vitestRoot, vitest.types)];
const temp = mkdtempSync(path.join(os.tmpdir(), "octogee-activity-sdk-"));
try {
  const config = path.join(temp, "tsconfig.json");
  writeFileSync(config, JSON.stringify({
    extends: path.join(source, "tsconfig.json"),
    compilerOptions: {
      paths, types: ["node"], typeRoots: [path.join(source, "node_modules/@types")],
      rootDir: path.parse(source).root, noEmit: true, declaration: false, incremental: false,
    },
    files: ["index.ts", "__tests__/final-reply-notifications.spec.ts", "__tests__/final-reply-registration.spec.ts"].map(file => path.join(pluginRoot, file)),
    include: [path.join(source, "src/types/*.d.ts")], exclude: [],
  }));
  const checked = spawnSync(process.execPath, [compiler, "--noEmit", "--pretty", "false", "-p", config], { cwd: source, stdio: "inherit" });
  if (checked.error) throw checked.error;
  if (checked.status !== 0) throw new Error(`Native Activity SDK contract failed (${checked.status ?? checked.signal})`);
  if (git("rev-parse", "HEAD") !== expectedCommit || git("status", "--porcelain", "--untracked-files=normal")) {
    throw new Error("OpenClaw source changed during the Activity SDK contract check");
  }
  console.error(`[activity-sdk] native source contract passed: ${expectedCommit}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
