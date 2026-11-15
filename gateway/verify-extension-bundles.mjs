#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { extensionDirectories, runtimeDependencies } from "./extension-manifest.mjs";

const extensionsRoot = path.resolve(process.argv[2] ?? "/octogee/extensions");

const PLUGIN_SDK_PREFIX = "openclaw/plugin-sdk/";
const SPECIFIERS = [
  /\bfrom\s*["']([^"'\s]+)["']\s*;/gu,
  /\bimport\s*["']([^"'\s]+)["']\s*;/gu,
  /\b(?:import|require|__require)\s*\(\s*["']([^"'\s]+)["']\s*\)/gu,
];
const NAMED_SDK_IMPORT = /\bimport \{([^}]*)\} from "(openclaw\/plugin-sdk\/[^"]+)";/gu;
const DEFAULT_SDK_IMPORT = /\bimport ([A-Za-z_$][\w$]*)(?:, \{[^}]*\})? from "(openclaw\/plugin-sdk\/[^"]+)";/gu;

export function importSpecifiers(source) {
  const specifiers = new Set();
  for (const pattern of SPECIFIERS) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers].sort();
}

export function foreignSpecifiers(source) {
  return importSpecifiers(source).filter(
    (specifier) => !isBuiltin(specifier) && !specifier.startsWith(PLUGIN_SDK_PREFIX),
  );
}

export function pluginSdkImports(source) {
  const imports = new Map();
  const names = (specifier) => {
    if (!imports.has(specifier)) imports.set(specifier, { named: new Set(), default: false });
    return imports.get(specifier);
  };
  for (const match of source.matchAll(NAMED_SDK_IMPORT)) {
    for (const binding of match[1].split(",")) {
      const exported = binding.trim().replace(/\s+/gu, " ").split(" as ")[0];
      if (exported.length > 0) names(match[2]).named.add(exported);
    }
  }
  for (const match of source.matchAll(DEFAULT_SDK_IMPORT)) names(match[2]).default = true;
  return imports;
}

function writePluginSdkStub(root, imports) {
  const packageRoot = path.join(root, "node_modules", "openclaw");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      type: "module",
      exports: { "./plugin-sdk/*": "./plugin-sdk/*.mjs" },
    }),
  );
  for (const [specifier, bindings] of imports) {
    const file = path.join(packageRoot, `${specifier.slice("openclaw/".length)}.mjs`);
    mkdirSync(path.dirname(file), { recursive: true });
    const lines = ["const passthrough = (...args) => args[0];"];
    for (const name of bindings.named) lines.push(`export const ${name} = passthrough;`);
    if (bindings.default) lines.push("export default passthrough;");
    writeFileSync(file, `${lines.join("\n")}\n`);
  }
}

function loadBundle(dir, openclawRoot) {
  const root = mkdtempSync(path.join(os.tmpdir(), `${path.basename(dir)}-load-`));
  try {
    const source = readFileSync(path.join(dir, "index.js"), "utf8");
    if (openclawRoot) {
      mkdirSync(path.join(root, "node_modules"));
      symlinkSync(path.resolve(openclawRoot), path.join(root, "node_modules", "openclaw"), "dir");
    } else {
      writePluginSdkStub(root, pluginSdkImports(source));
    }
    const entry = path.join(root, "index.mjs");
    copyFileSync(path.join(dir, "index.js"), entry);
    const probe =
      `const plugin = await import(${JSON.stringify(pathToFileURL(entry).href)});\n` +
      `if (typeof plugin.default !== "object" || plugin.default === null) {\n` +
      `  throw new Error("bundle entry has no default plugin export");\n}\n`;
    const loaded = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      cwd: root,
      encoding: "utf8",
    });
    if (loaded.error) throw loaded.error;
    if (loaded.status === 0) return null;
    const lines = loaded.stderr.split("\n").map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => /^\w*Error\b/u.test(line)) ?? lines.at(-1) ?? "no diagnostic on stderr";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function verifyExtensionBundle(dir, openclawRoot) {
  const problems = [];
  if (!existsSync(path.join(dir, "index.js"))) problems.push("index.js is missing");
  if (existsSync(path.join(dir, "node_modules"))) problems.push("node_modules is still present");
  if (existsSync(path.join(dir, "package-lock.json"))) problems.push("package-lock.json is still present");
  const dependencies = runtimeDependencies(dir);
  if (dependencies.length > 0) {
    problems.push(`package.json still declares dependencies (${dependencies.join(", ")})`);
  }
  if (problems.length > 0) return problems;
  const foreign = foreignSpecifiers(readFileSync(path.join(dir, "index.js"), "utf8"));
  if (foreign.length > 0) problems.push(`index.js imports outside the bundle: ${foreign.join(", ")}`);
  const loadFailure = loadBundle(dir, openclawRoot);
  if (loadFailure) problems.push(`index.js failed to load: ${loadFailure}`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const directories = extensionDirectories(extensionsRoot);
  if (directories.length === 0) throw new Error(`no Octogee extensions found in ${extensionsRoot}`);

  let failed = false;
  for (const dir of directories) {
    const name = path.basename(dir);
    const problems = verifyExtensionBundle(dir, process.argv[3]);
    if (problems.length === 0) {
      console.error(`[extension-bundles] ok: ${name}`);
      continue;
    }
    failed = true;
    for (const problem of problems) console.error(`[extension-bundles] FAILED ${name}: ${problem}`);
  }
  if (failed) {
    console.error(
      "[extension-bundles] every extension must ship as one self-contained index.js whose only imports are node builtins and openclaw/plugin-sdk/*",
    );
    process.exit(1);
  }
  console.error(`[extension-bundles] ${directories.length} extension(s) are self-contained bundles`);
}
