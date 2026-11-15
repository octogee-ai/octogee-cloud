#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  extensionDirectories,
  readExtensionPackage,
  runtimeDependencies,
} from "./extension-manifest.mjs";

const extensionsRoot = path.resolve(process.argv[2] ?? "/octogee/extensions");
const esbuild = path.resolve(
  process.argv[3] ?? "/octogee/scripts/node_modules/.bin/esbuild",
);
const npm = process.argv[4] ?? "npm";

const BUILD_ONLY_MANIFEST_FIELDS = ["dependencies", "devDependencies", "overrides", "scripts"];
const BUILD_ONLY_ENTRIES = new Set(["__tests__", "node_modules", "package-lock.json", "tsconfig.json"]);

function run(name, command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${name} ${path.basename(command)} failed with status ${result.status}`);
  }
}

function installBundleInputs(dir) {
  const name = path.basename(dir);
  const dependencies = runtimeDependencies(dir);
  if (dependencies.length === 0) return;
  if (!existsSync(path.join(dir, "package-lock.json"))) {
    throw new Error(
      `${name} declares dependencies (${dependencies.join(", ")}) but has no package-lock.json`,
    );
  }
  console.error(`[extension-build] bundle inputs: ${name} (${dependencies.join(", ")})`);
  run(name, npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], dir);
}

function bundle(dir) {
  const name = path.basename(dir);
  const entry = path.join(dir, "index.ts");
  if (!existsSync(entry)) throw new Error(`${name} is missing index.ts`);
  run(name, esbuild, [
    entry,
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node24",
    "--minify-syntax",
    '--define:process.env.WS_NO_BUFFER_UTIL="1"',
    '--define:process.env.WS_NO_UTF_8_VALIDATE="1"',
    `--alias:@octogee/core=${path.resolve(path.dirname(esbuild), "../@octogee/core/dist")}`,
    `--alias:@octogee/shared=${path.resolve(path.dirname(esbuild), "../@octogee/shared/dist")}`,
    '--banner:js=import { createRequire as createExtensionRequire } from "node:module"; const require = createExtensionRequire(import.meta.url);',
    "--external:openclaw",
    "--external:openclaw/*",
    `--outfile=${path.join(dir, "index.js")}`,
  ]);
}

function stripBuildInputs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (BUILD_ONLY_ENTRIES.has(entry.name)) {
      rmSync(target, { recursive: true, force: true });
      continue;
    }
    if (entry.isDirectory()) {
      stripBuildInputs(target);
      continue;
    }
    if (/\.(?:cts|mts|ts|tsx)$/u.test(entry.name)) rmSync(target);
  }
}

function writeShippedManifest(dir) {
  const manifest = readExtensionPackage(dir);
  for (const field of BUILD_ONLY_MANIFEST_FIELDS) delete manifest[field];
  writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

const directories = extensionDirectories(extensionsRoot);
if (directories.length === 0) throw new Error(`no Octogee extensions found in ${extensionsRoot}`);

for (const dir of directories) {
  if (readExtensionPackage(dir).type !== "module") {
    throw new Error(`${path.basename(dir)} must declare package.json type=module`);
  }
  installBundleInputs(dir);
  bundle(dir);
}

for (const dir of directories) {
  stripBuildInputs(dir);
  writeShippedManifest(dir);
  const bytes = readFileSync(path.join(dir, "index.js")).length;
  console.error(`[extension-build] ${path.basename(dir)}: index.js ${bytes} bytes, self-contained`);
}
