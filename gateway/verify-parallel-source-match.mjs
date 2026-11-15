import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const [vendoredDir, hostDir, listFile] = process.argv.slice(2);
if (!vendoredDir || !hostDir || !listFile) {
  throw new Error("usage: verify-parallel-source-match <vendored-package-dir> <openclaw-package-dir> <list-report>");
}

const hostRoot = realpathSync(hostDir);
const expectedRoot = path.join(hostRoot, "dist", "extensions", "parallel");
const installedRoot = realpathSync(expectedRoot);
if (installedRoot !== expectedRoot) {
  throw new Error("Parallel is not physically contained in the running OpenClaw package");
}
const raw = JSON.parse(readFileSync(listFile, "utf8"));
const plugin = raw.plugins?.find((entry) => entry.id === "parallel");
if (!plugin) throw new Error("Parallel missing from fresh-state plugin discovery");
if (plugin.id !== "parallel" || plugin.origin !== "bundled") {
  throw new Error(`expected bundled Parallel, received ${plugin.origin}`);
}
if (typeof plugin.rootDir !== "string" || realpathSync(plugin.rootDir) !== installedRoot ||
    typeof plugin.source !== "string" || !realpathSync(plugin.source).startsWith(installedRoot + path.sep)) {
  throw new Error("Parallel discovery resolved outside the expected bundled package");
}
const hostPackage = JSON.parse(readFileSync(path.join(hostRoot, "package.json"), "utf8"));
const sourcePackage = JSON.parse(readFileSync(path.join(vendoredDir, "package.json"), "utf8"));
if (hostPackage.name !== "openclaw" || sourcePackage.name !== "@openclaw/parallel-plugin" ||
    sourcePackage.version !== hostPackage.version) {
  throw new Error("Parallel companion identity/version does not match the OpenClaw package");
}
const installedPackage = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
if (installedPackage.openclaw?.build?.bundledDist !== true) {
  throw new Error("Parallel bundled distribution ownership is missing");
}
const expectedPackage = structuredClone(sourcePackage);
expectedPackage.openclaw ??= {};
expectedPackage.openclaw.build = { ...expectedPackage.openclaw.build, bundledDist: true };
if (!isDeepStrictEqual(installedPackage, expectedPackage)) {
  throw new Error("Parallel source match: package.json: content differs outside bundled distribution ownership");
}

function runtimeDigests(packageDir) {
  const digests = new Map();
  const add = (relative) => {
    const absolute = path.join(packageDir, relative);
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`Parallel runtime file is not regular: ${relative}`);
      digests.set(relative, createHash("sha256").update(readFileSync(fd)).digest("hex"));
    } finally {
      closeSync(fd);
    }
  };
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(packageDir, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else add(child);
    }
  };
  walk("dist");
  if (![...digests.keys()].some((file) => /\.[cm]?js$/u.test(file))) {
    throw new Error("Parallel package has no dist modules");
  }
  add("openclaw.plugin.json");
  return digests;
}

const manifest = JSON.parse(readFileSync(path.join(installedRoot, "openclaw.plugin.json"), "utf8"));
if (manifest.id !== "parallel" || !manifest.contracts?.webSearchProviders?.includes("parallel-free")) {
  throw new Error("Parallel keyless search provider contract is missing");
}

const vendored = runtimeDigests(vendoredDir);
const installed = runtimeDigests(installedRoot);
const mismatches = [];
for (const [file, digest] of vendored) {
  if (!installed.has(file)) mismatches.push(`${file}: missing from the installed package`);
  else if (installed.get(file) !== digest) mismatches.push(`${file}: content differs`);
}
for (const file of installed.keys()) {
  if (!vendored.has(file)) mismatches.push(`${file}: missing from the vendored package`);
}
if (mismatches.length > 0) {
  const details = mismatches.map((line) => "  " + line).join("\n");
  console.error(`Parallel source match: FAIL\n${details}`);
  process.exit(1);
}
console.log(`Parallel source match: PASS (${vendored.size + 1} source-matched files; origin=bundled; bundledDist=true)`);
