import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const [vendoredDir, hostDir, inspectFile] = process.argv.slice(2);
if (!vendoredDir || !hostDir || !inspectFile) {
  throw new Error("usage: verify-codex-source-match <vendored-package-dir> <openclaw-package-dir> <inspect-report>");
}

const hostRoot = realpathSync(hostDir);
const expectedRoot = path.join(hostRoot, "dist", "extensions", "codex");
const installedRoot = realpathSync(expectedRoot);
if (installedRoot !== expectedRoot) {
  throw new Error("Codex is not physically contained in the running OpenClaw package");
}
const raw = JSON.parse(readFileSync(inspectFile, "utf8"));
const plugin = raw.plugin ?? raw;
if (plugin.id !== "codex" || plugin.origin !== "bundled" ||
    plugin.trust?.reason !== "bundled" || plugin.trust.origin !== "bundled") {
  throw new Error(`expected bundled Codex, received ${JSON.stringify(plugin.trust)}`);
}
if (typeof plugin.rootDir !== "string" || realpathSync(plugin.rootDir) !== installedRoot ||
    typeof plugin.source !== "string" || !realpathSync(plugin.source).startsWith(installedRoot + path.sep)) {
  throw new Error("Codex discovery resolved outside the expected bundled package");
}
const hostPackage = JSON.parse(readFileSync(path.join(hostRoot, "package.json"), "utf8"));
const sourcePackage = JSON.parse(readFileSync(path.join(vendoredDir, "package.json"), "utf8"));
if (hostPackage.name !== "openclaw" || sourcePackage.name !== "@openclaw/codex" ||
    sourcePackage.version !== hostPackage.version) {
  throw new Error("Codex companion identity/version does not match the OpenClaw package");
}

function runtimeDigests(packageDir) {
  const digests = new Map();
  const add = (relative) => {
    const absolute = path.join(packageDir, relative);
    const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`Codex runtime file is not regular: ${relative}`);
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
    throw new Error("Codex package has no dist modules");
  }
  add("package.json");
  add("openclaw.plugin.json");
  return digests;
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
  console.error(`Codex source match: FAIL\n${details}`);
  process.exit(1);
}
console.log(`Codex source match: PASS (${vendored.size} runtime files identical; origin=bundled)`);
