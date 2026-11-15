#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function readNativeModules({ packageRoot, read = readFileSync }) {
  const manifest = JSON.parse(read(path.join(packageRoot, "package.json"), "utf8"));
  const names = manifest.nativeModules;
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string" && name.length > 0)) {
    throw new Error('package.json "nativeModules" must be an array of non-empty package names');
  }
  return names;
}

export function verifyNativeModules({ names, load }) {
  const failures = [];

  for (const name of names) {
    try {
      if (!load(name)) {
        failures.push({ name, message: "module resolved to nothing" });
      }
    } catch (error) {
      failures.push({ name, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return failures;
}

export function describeBindingLayout({
  packageRoot,
  name,
  platform = process.platform,
  arch = process.arch,
  exists = existsSync,
  readdir = readdirSync,
}) {
  const moduleRoot = path.join(packageRoot, "node_modules", name);
  const prebuildsRoot = path.join(moduleRoot, "prebuilds");
  const platformPrebuild = path.join(prebuildsRoot, `${platform}-${arch}`);
  const gypOutput = path.join(moduleRoot, "build", "Release");

  const parts = [];

  if (exists(platformPrebuild)) {
    parts.push(`prebuilds/${platform}-${arch} present`);
  } else {
    const shipped = exists(prebuildsRoot) ? readdir(prebuildsRoot) : [];
    parts.push(
      `prebuilds/${platform}-${arch} missing (shipped: ${shipped.length > 0 ? shipped.join(", ") : "none"})`,
    );
  }

  parts.push(exists(gypOutput) ? "build/Release present" : "build/Release missing");

  return `node_modules/${name}: ${parts.join(", ")}`;
}

function main({ packageRoot }) {
  const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
  const names = readNativeModules({ packageRoot });
  const failures = verifyNativeModules({
    names,
    load: (name) => requireFromPackage(name),
  });
  const failed = new Set(failures.map((failure) => failure.name));

  for (const name of names) {
    if (!failed.has(name)) {
      console.error(`[native-modules] ok: ${name}`);
    }
  }

  if (failures.length === 0) {
    console.error(
      `[native-modules] ${names.length} native module(s) load on ${process.platform}-${process.arch}`,
    );
    return;
  }

  for (const { name, message } of failures) {
    console.error(
      `[native-modules] FAILED to load "${name}" on ${process.platform}-${process.arch}: ${message}`,
    );
    console.error(`[native-modules]   ${describeBindingLayout({ packageRoot, name })}`);
  }
  console.error(
    '[native-modules] a native binding is missing: npm skips a dependency\'s install script unless package.json "allowScripts" names it, and node-gyp needs python3 + make + g++ in the image',
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main({ packageRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") });
}
